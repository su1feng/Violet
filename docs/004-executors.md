# 004 执行器

Violet 不自己实现 agent loop。它把"跑一轮"这件事交给本机已登录的 agent CLI。

## 接口

```ts
export interface Executor {
  readonly id: ExecutorId;
  probe(): Promise<Health>;
  runTurn(req: TurnRequest): Turn;
}

export interface TurnRequest {
  session: SessionRef | null;   // null = 新会话
  workspace: string;
  prompt: string;               // 已渲染的事件批次
  systemPrompt: string;         // 记忆索引 + 行为准则
  policy: RunPolicy;            // 沙箱档、模型、思考强度、预算
  toolMount: McpMount;          // socket 路径 + 注入方式
  signal: AbortSignal;
}

export interface Turn {
  events: AsyncIterable<NormalizedEvent>;
  session: Promise<SessionRef>; // 拿到会话 id 就回传，落库
  cancel(): Promise<void>;
}
```

只有两个方法。其余能力由 `capabilities` 声明，上层的降级逻辑据此决定，不靠猜。

## 一轮一个子进程

这是本设计最重要的取舍，代价必须说清。

**收益：**

常驻 agent 的全部难点是崩溃恢复。如果会话活在进程内存里，`kill -9` 就把它带走了——而你要恢复的恰好是它。一轮一个进程，进程死了什么都没丢，会话由 CLI 自己持久化在磁盘上。

**代价：**

1. 每轮重读上下文，冷启动 1–2 秒。个人场景每小时几次 run，可以忽略。
2. 放弃 prompt cache 预热（省那笔钱需要长驻会话）。
3. **拿不到 `steer`**——一轮一进程没有"运行中"可投入的通道。接口留着，实现放到后面。真要做时，单个适配器会从 200 行涨到 1000 行以上，这笔账要提前知道。
4. 一轮内的后台工作（子 agent、长任务）活不过这一轮。所以一个 turn 必须在 turn 里结束，调度因此简单。

## 三个 CLI 的实测接入面

以下来自对 claude 2.1.321、codex-cli 0.166.0、pi 1.5.2 的实际调用，不是推测：

| 能力 | claude | codex | pi |
| --- | --- | --- | --- |
| 单轮输出 | `-p --output-format stream-json` | `exec --json` | `--mode json` |
| 会话续作 | `--session-id` / `--resume` | `exec resume <id>` | `--session-id` / `--resume` |
| 长连接 | 无 | `app-server`（实验性） | `--mode rpc` 双向 JSONL |
| 工具注入 | `--mcp-config` | `codex mcp` | `pi mcp` |
| 沙箱 | `--permission-mode` | `-s read-only\|workspace-write\|danger-full-access` | `--tools` 白名单 |
| 思考强度 | 模型参数 | 模型参数 | `--thinking off…max` |
| 结构化输出 | `--json-schema` | `--output-schema` | 无 |
| 成本上报 | stream-json 含 usage | `--json` 含 usage | JSON 事件含 usage |

差异很大，所以**统一的东西不能是命令行参数，必须是 agent 能调用的工具**——那一层是 MCP，三家都支持。

## 工具面：五个 MCP 工具

所有执行器用完全相同的工具集。这是"换执行器行为不变"的唯一保证。

| 工具 | 作用 | 硬约束 |
| --- | --- | --- |
| `send_message(body, reason, expected_value)` | 写 outbox | `reason` 必填枚举 |
| `ask_person(question, options[])` | 提问并结束本轮 | 不是挂起 |
| `memory_search` / `memory_read` / `memory_write` | 记忆 | 索引常驻，正文按需 |
| `schedule(kind, due\|cron, prompt)` | 建定时器 | once / recurring |
| `report_progress(status, note)` | 更新 run 状态 | 四态 |

MCP 服务通过 **unix socket** 连主进程，不直接开数据库。这样即使执行器有 Bash 权限，也改不了账本——这是这条链上唯一值得做的隔离。

每次 run 用环境变量注入上下文：`VIOLET_RUN_ID`、`VIOLET_THREAD_ID`、`VIOLET_MEMORY_DIR`、`VIOLET_SOCKET`。

## 能力表

一张表，六列。不要放在适配器上——`engine` 层要知道"这个执行器支不支持恢复会话"，但不能为了知道这件事去 import 整个执行器实现。

```ts
export const EXECUTORS = {
  claude: { resume: 'strict', approval: ['ask', 'auto-edits', 'full'],
            effort: ['low', 'medium', 'high', 'max'], cost: true, structured: true },
  codex:  { resume: 'strict', approval: ['ask', 'full'],
            effort: ['low', 'medium', 'high'], cost: true, structured: true },
  pi:     { resume: 'strict', approval: ['ask'],
            effort: ['off', 'low', 'medium', 'high', 'max'], cost: true, structured: false },
} as const;
```

`resume: 'strict'` 的语义：**要么精确恢复原生会话，要么失败，绝不给空白会话。**

`approval` 不是布尔值。每个 CLI 的沙箱语义都不一样，硬套一个布尔会把上层逼着自己实现沙箱。这里是"这个 CLI 支持哪些档位"，由适配器映射到它自己的参数。

## 事件归一化

三家 JSON 结构完全不同，归一成一套，`engine` 只认这个：

```ts
type NormalizedEvent =
  | { kind: 'started'; session: SessionRef }
  | { kind: 'text'; delta: string }
  | { kind: 'tool'; name: string; input: unknown; phase: 'call' | 'result' }
  | { kind: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number }
  | { kind: 'ended'; reason: 'complete' | 'aborted' | 'error' | 'limit'; error?: string };
```

## probe 不是锦上添花

启动时探活：装了没、登录了没、版本够不够。

在常驻场景下，这三种失败都会在半夜静默发生：codex 没登录、claude 订阅过期、pi 没配 API key。探活失败就通过 outbox 告诉你一次（`reason: error`），然后该执行器降级为不可用，**不反复重试**。

## 接入顺序

1. **claude** — 先用它跑通整条链路
2. **codex** — 第二个适配器是接口的第一次真实检验，一定会暴露设计漏洞
3. **pi** — 第三个，应该只需要写适配器
4. **ACP 通用兜底** — 之后所有说 ACP 的 CLI 零代码接入

`deepseek-harness` 也走第 4 条路：`dsh --profile acp` 起一个 JSON-RPC over stdio 的服务，提供创建/恢复会话、选模型、挂 MCP、提交与取消工作、接收语义更新——逐条对应上面的 `TurnRequest` 和 `Turn`。**它不是底座，是第四个执行器。**

## 不做的

- 不管登录态：你自己在终端登录好，Violet 读你现有的 home
- 不隔离引擎 home：一个引擎一个登录态，不做多账号
- 不做进程内 SDK 嵌入：会让"多执行器"分裂成两种范式
