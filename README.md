# Violet

Local-first 的个人 AI 助手:在聊天窗口里创建多个 bot,每个 bot 有自己的名字、性格、记忆和工作区;它们用你本机已登录的 Claude Code 作为大脑;有副作用的动作先问你。

- 架构与实现依据:[architecture.md](architecture.md)
- 终版能力清单与参考实现地图:[architecture-final.md](architecture-final.md)

## v1 功能

- **多 bot**:创建 / 编辑 / 删除多个独立助手,每个 bot 独立人格、独立工作区(`~/.violet/bots/<botId>/workspace/`)、独立记忆
- **聊天**:流式回复、历史持久化(SQLite + NDJSON)、thread 列表、重启后 `--resume` 继续对话
- **记忆**:工作区里的 `CLAUDE.md`(生成) + `MEMORY.md`(助手维护),跨 thread 生效
- **审批**:ask / full 两档;ask 模式下工具调用经本地 pipe → broker → Web 审批卡,Allow / Deny,15 分钟超时自动 deny,审批全部落审计表
- **Web UI**:React 19 + Vite,侧栏管理 bot 与对话,全局待处理审批卡,单条 SSE 多路复用

## 快速开始

前置条件:Node.js ≥ 22.5(`node:sqlite` 内置),本机已安装并登录 Claude Code CLI。

```bash
npm install
npm run build        # 构建 Web UI 到 dist/web
npm start            # 启动 server(默认 http://127.0.0.1:5178)
```

开发模式(同时起 server 热重载 + Vite dev server):

```bash
npm run dev
```

打开 `http://127.0.0.1:5178` 即可使用;浏览器 token 由服务端注入首页,首次启动生成于 `~/.violet/token`。

## 配置(环境变量,均可选)

| 变量 | 默认 | 说明 |
|---|---|---|
| `VIOLET_HOME` | `~/.violet` | 数据目录(SQLite、NDJSON、bot 工作区、pidfile) |
| `VIOLET_HOST` / `VIOLET_PORT` | `127.0.0.1` / `5178` | 监听地址与端口 |
| `VIOLET_CLAUDE_CMD` | `claude` | agent CLI 命令 |
| `VIOLET_CLAUDE_ARGS` | 空 | 追加到 CLI 的参数(测试用 fake driver 也走这里) |
| `VIOLET_GLOBAL_CONCURRENCY` | `3` | 全局 CLI 并发上限;每 bot 串行 |
| `VIOLET_APPROVAL_TIMEOUT_MS` | `900000` | 审批超时(超时自动 deny) |
| `VIOLET_IDLE_MS` | `600000` | thread 进程空闲回收时间 |

## 测试与 CI

```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest:store / broker / driver / supervisor / admission / API 集成
npm run build        # vite build
```

CI(GitHub Actions)在 push/PR 上跑 typecheck → test → build,actions 按 commit SHA 固定。

