# 007 质量工程

> 这份文档的执行对象是 agent。它给出的是**可执行的约束**，不是期望。
> 每一条都标注了降级层级（见 [降级链](#一降级链在-violet-上的投影)）、检查手段、以及失败时应该说什么。

## 公理

**质量不是靠事后审查，是靠环境默认产生。**

检验标准只有一条：

> 任何一条约束，如果 agent 违反它的时候**没有强制机制**，那它不是约束，是期待。

Violet 的六条硬边界（[001 架构](001-architecture.md#六条硬边界)）里，五条能降级成机制，一条不能。**那条要诚实地标明。**

---

## 一、降级链在 Violet 上的投影

| Violet 的约束 | 层级 | 手段 | 是否可信 |
| --- | --- | --- | --- |
| ① 只有 triggers 表能调 agent | **消灭** | `Ticket` 用 branded type，构造器只在 `Engine` 内部可见；`Executor.start()` 只接受 `Ticket` | 可信 |
| ② agent 只写 outbox | **部分消灭** | 类型上只能走 socket；**但有 Bash 权限就能绕过** | **不可信**，靠审计兜底 |
| ③ worker 只有一个 | **消灭** | 排他锁 + 竞争测试 | 可信 |
| ④ 只有 Engine 写五张表 | **消灭** | `packages/store` 的写函数不从包入口导出 | 可信 |
| ⑤ core 零依赖零 IO | **消灭** | `dependencies: {}` + `verify-deps` | 可信 |
| ⑥ engine 不认识执行器 | **消灭** | `verify-deps` 的依赖方向规则 | 可信 |

② 是整套系统里唯一一条判断题。它挡不住恶意，只挡误解。**真正的防线是 outbox 留痕 + 月度对比**，这一点必须写在 006 决策记录里，不能假装它被机制保护了。

---

## 二、Layer 0：环境默认

在建任何门之前，先让错误写法无法通过编译。成本最低，收益最大。

### 2.1 `tsconfig.base.json`

```jsonc
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "verbatimModuleSyntax": true,
    "moduleResolution": "bundler",
    "module": "esnext",
    "target": "es2023",
    "isolatedModules": true
  }
}
```

`noUncheckedIndexedAccess` 是这里最值钱的一条：它把"数组越界返回 undefined，但我当成有值"这一类 bug 变成编译错误。

### 2.2 `packages/core/package.json`

```json
{
  "name": "@violet/core",
  "type": "module",
  "dependencies": {},
  "devDependencies": {}
}
```

**`dependencies` 必须是空对象。** 不是"暂时没有"，是"永远不许有"。这条由 `verify-deps` 断言。

### 2.3 禁用清单

| 禁令 | 理由 | 强制手段 |
| --- | --- | --- |
| `any` | 让类型系统失效 | oxlint `no-explicit-any` = error |
| `as unknown` | 绕过类型检查的快捷方式 | `verify-types`（自定义 AST 检查） |
| `as` 断言（除字面量收窄） | 同上 | `verify-types` 白名单：只允许 `as const` |
| `!` 非空断言 | 把 undefined 变成运行时崩溃 | oxlint `no-non-null-assertion` = error |
| `@ts-ignore` | 关掉检查 | oxlint = error，`@ts-expect-error` 必须带原因 |
| 顶层 `await` | 模块求值变异步，拖累所有 importer | `verify-types` |
| `console.log` | 生产环境不可控 | oxlint = error，改用注入的 logger |
| 默认导出 | 重命名时 IDE 改不到 | oxlint `no-default-export` |

### 2.4 目录即边界

```
packages/core/          ← 零 IO，零外部 import
packages/store/         ← 只 import core
packages/sources/       ← 只 import core（不 import apps/）
packages/executor/      ← 只 import core
packages/memory/        ← 只 import core
packages/delivery/      ← 只 import core
apps/agent/             ← 唯一的组装根，可以 import 所有人
```

违反由 `verify-deps` 报错，错误信息直接说"哪个文件 import 了哪一层，为什么不行"。

---

## 三、门（gates）

**初始只建 8 个。** 每个都必须带 `.spec.ts`（门自己也要被测试），且必须防空语料。

统一约定：

- 放在 `scripts/verify-*.ts`，用 `tsx` 运行
- 导出一个纯函数 `find*(...)` 便于测试，`main` 只在直接调用时执行
- 退出码：0 通过，1 失败
- 失败信息格式：**先说要做什么，再列违规位置**

### G1 · `verify-deps` 依赖方向

**防什么：** `core` 里偷偷 import 了 `node:fs`，或者 `executor` 反向 import 了 `engine`。

```ts
// scripts/verify-deps.ts 核心逻辑（伪代码，执行者补全）
const RULES = [
  { from: 'packages/core', forbid: /^node:|^\.\.\/|@violet\//, allow: [] },
  { from: 'packages/store',   allow: ['@violet/core'] },
  { from: 'packages/sources', allow: ['@violet/core'] },
  { from: 'packages/executor',allow: ['@violet/core'] },
  { from: 'packages/memory',  allow: ['@violet/core'] },
  { from: 'packages/delivery',allow: ['@violet/core'] },
  { from: 'apps/agent',       allow: ['*'] },
]
```

**额外断言（空语料防护）：** 必须扫到至少 7 个包目录，否则报错退出。一个什么都没扫到的依赖检查比没有更危险。

**失败信息示例：**

```
verify-deps: packages/core 不得有外部依赖。
  packages/core/src/engine.ts:4  import { readFile } from 'node:fs'
  → core 必须纯内存可测。需要 IO 的地方，把动作定义成端口，由 apps/agent 注入实现。
```

### G2 · `verify-types` 类型禁令

自定义 AST 检查（用 `typescript` 包，不引 ESLint）：

| 检查 | 失败信息要点 |
| --- | --- |
| `AsExpression` 且 type 不是字面量 | "请用类型守卫或解析函数，不要断言" |
| `as unknown as X` 双重断言 | 单独报，因为这是最恶劣的形式 |
| 顶层 `AwaitExpression` | "把异步初始化放进显式的 `start()`" |
| `NonNullExpression` | 由 oxlint 管，这里不重复 |

### G3 · `verify-file-size` 文件行数上限

上限 **400 行**（不含空行和注释）。

Violet 只有 6 个包。超过 400 行的文件几乎一定是在承担多个职责。

**这是棘轮的基础设施**：现在基线是 0 个超限文件，未来只允许新增，不允许"先把基线拉高再说"。

实测数据（从仓库根目录运行）：`node scripts/verify-file-size.ts --list`。

### G4 · `verify-schema-doc` 文档即数据 · 表结构

**把 [001 架构](001-architecture.md) 里的 `sql` 代码块当数据源**，与 `packages/store/schema.sql` 逐字比较（忽略空白）。

```ts
// 伪代码
const docSql = extractFirstSqlBlock('docs/001-architecture.md')
const realSql = readFileSync('packages/store/schema.sql', 'utf8')
assert(normalize(docSql) === normalize(realSql))
```

**为什么值得：** 表结构是整套系统里最容易漂移的东西。改文档不改 migration 会立刻红，反过来也红。

**失败信息：**

```
verify-schema-doc: docs/001-architecture.md 的 sql 块与 packages/store/schema.sql 不一致。
  差异位置：第 12 行
  文档:   threads(id, channel, address, policy_version, created_at)
  实际:   threads(id, channel, address, policy_version, created_at, updated_at)
  → 两边必须同时改。文档是设计的唯一描述，不是事后补的说明。
```

### G5 · `verify-registry-doc` 文档即数据 · 能力表

[004 执行器](004-executors.md) 里的 `EXECUTORS` 代码块，与 `packages/core/src/registry.ts` 的实际常量深比较。

比较的是**运行时值**，不是文本。文档块被 `eval` 成对象后与 import 的值做 `isDeepStrictEqual`。

**这是"文档喂给测试"最直接的形式**，也是 team-chat 那个 `include_str!` 的 TS 版。

### G6 · `verify-test-names` 契约名对应

断言这些测试名**存在**：

| 测试名 | 对应文档 |
| --- | --- |
| `R1 事件去重` | [002 运行与恢复](002-runtime.md#r1--事件去重靠幂等键) |
| `R2 消息先落库再发送` | 同上 |
| `R3 承认窗口` | 同上 |
| `R4 崩溃续作而非重放` | 同上 |
| `M0-1 kill -9 不丢不重` | [005 路线图](005-roadmap.md#验收五条全部不用真模型) |
| `M0-2 定时器重复触发` | 同上 |
| `M0-3 消息重复投递` | 同上 |
| `M0-4 提问后进程空闲` | 同上 |
| `M0-5 无内容日零消息` | 同上 |

**空语料防护：** 必须找到至少 9 个匹配的 `test(` 或 `it(`，否则报错。

**为什么值得：** 它让"文档里承诺的验收"和"实际跑的测试"绑死。删测试会红。

### G7 · `verify-concrete-terms` 禁含糊词

docs/ 和 README 里禁止出现下列不可执行的词（清单定义在 `scripts/concrete-terms.ts`）：

<!-- concrete-terms-ignore-start -->
`合理`、`适当`、`尽量`、`视情况`、`基本上`、`大概`、`某种程度上`、`properly`、`appropriately`、`as needed`
<!-- concrete-terms-ignore-end -->

**理由**：这三类词一出现，那句话就已经变成不可检验的散文。

**自身豁免**：禁用词表定义在 `scripts/concrete-terms.ts` 的常量里，并由该文件导出给 spec 使用；文档中列举禁用词的位置必须包在 `<!-- concrete-terms-ignore-start -->` / `<!-- concrete-terms-ignore-end -->` 之间。**没有其他豁免机制**——包括本段在内，只有列举禁令的地方可以用。

**失败信息：**

```
verify-concrete-terms: 文档里出现了不可执行的词。
  docs/003-authorization.md:47  <!-- concrete-terms-ignore-start -->"适当延长超时"<!-- concrete-terms-ignore-end -->
  → 改成确切的值或确切的条件。例如"超过 30 秒未响应则放弃"。
```

### G8 · `verify-doc-budgets` 文档预算

**按非空白字符数计，不按 `wc -w`。** 中文句子没有空格，`wc -w` 会把一整句算成一个词，这套预算就失去了意义。

计数方式：读文件 → 正则 `/\s/g` 全替换为空 → 取 `.length`。

`scripts/doc-budgets.manifest.json`：

```json
{
  "README.md": 900,
  "docs/000-positioning.md": 1900,
  "docs/001-architecture.md": 5000,
  "docs/002-runtime.md": 3100,
  "docs/003-authorization.md": 2500,
  "docs/004-executors.md": 4100,
  "docs/005-roadmap.md": 1450,
  "docs/006-decisions.md": 2250,
  "docs/007-quality.md": 13300,
  "docs/AGENTS.md": 1700
}
```

初始值取**当前非空白字符数 + 20%**（已实测填入），之后只降不升。

规则：

- 超预算就红
- **提高预算需要在 PR 里写理由**，不能顺手改
- 文件不存在也红（防止重命名后忘记更新）
- manifest 里没有的 `docs/*.md` 也红——新文档必须登记，否则不受检查覆盖

---

## 四、棘轮

Violet 是绿地，所以大部分棘轮**基线为 0**。

| 项 | 基线 | 怎么守 |
| --- | --- | --- |
| `as unknown` | **0**，直接禁 | `verify-types` 白名单为空 |
| 文件 > 400 行 | **0** | `verify-file-size` 限额即基线 |
| 文档超预算 | 见 manifest | 提高要理由 |
| 依赖方向违规 | **0** | `verify-deps` 无例外 |

**唯一需要基线文件的是文件行数**，因为将来可能出现确实需要超过 400 行的文件（比如一个手写的协议解析器）。届时：

```json
// scripts/file-size.baseline.json
{
  "packages/executor/src/acp/parse.ts": 520
}
```

规则：**只能在这份文件里减少数字，不能增加。没有"--add-exception"命令。**

### 4.1 防"悄悄放宽门"

`verify-lint-config`：把 oxlint 配置的规则集算成 sha256 + 条数，写死在测试里。

```
当前指纹：a3f9...c21  ·  规则数 34
```

删规则、降 severity、改 options 都会让指纹变。**改指纹本身必须是一个显式的 commit**，reviewer 一眼能看到。

### 4.2 空语料防护（所有门必做）

每个门在扫描前必须断言"我扫到了预期范围的东西"。deepseek-harness 的做法值得照抄：

```ts
if (!files.includes('README.md') || !files.some(f => f.startsWith('packages/'))) {
  throw new Error('verify-X: tracked-file discovery omitted a required repository area')
}
```

**一个因为什么都没扫到而通过的检查，比没有检查更危险。**

---

## 五、验证层：崩溃恢复怎么测

这是 Violet 唯一真正的难题，也是唯一必须用**第 3 层（运行时验证）**而不是第 2 层（静态检查）的地方。

### 5.1 三个真实

| 要真实的东西 | 做法 | 禁止 |
| --- | --- | --- |
| 存储 | 真实 SQLite 文件（WAL 模式） | 内存库——WAL 语义正是被测对象 |
| 进程 | 真实子进程 + 真实 `SIGKILL` | `process.exit()` 模拟 |
| 执行器 | 假执行器，但**通过真实 socket 说话** | 直接调用 `Engine` 方法 |

### 5.2 崩溃点穷举

假执行器在每个落库点前后埋一个崩溃开关：

```ts
// 假执行器提供的故障注入点
type CrashPoint =
  | 'after-claim'        // 认领后，租约内
  | 'after-turn-start'   // turn 起来后
  | 'after-outbox-write' // 出站消息落库后，发送前
  | 'before-outbox-write'// 出站消息落库前
  | 'during-send'        // 渠道发送中（模拟 R3 窗口）
  | 'after-settle'       // 标记完成前
```

测试驱动遍历所有崩溃点 × 3 次重启，断言：

| 断言 | 含义 |
| --- | --- |
| 事件最终数 = 1 | 不重 |
| outro 消息最终数 ≤ 1 | 不重发 |
| outbox 里没有 `pending` 残留 | 不丢 |
| `uncertain` 只出现在 `during-send` | R3 窗口被诚实标记 |

### 5.3 性质测试

不用自己写生成器，用固定的场景表即可（个人项目规模不值得上 fuzz）：

| 场景 | 断言 |
| --- | --- |
| 同会话连发 3 条消息 | 只回 1 次，且内容按序拼接 |
| 定时器在同一秒触发 2 次 | 只起 1 个 run |
| 提问后立刻又收到消息 | 两个事件合并在下一次 run，不抢 session |
| 执行器启动失败 | 记录一次 `error` outbox，不无限重试 |

### 5.4 门自己也要被测

每个 `verify-*` 必须有对应的 `verify-*.spec.ts`，至少覆盖：

1. 干净语料 → 通过
2. 有一个违规 → 失败且信息含文件行号
3. **空语料 → 报错而非通过**

第 3 条是最容易漏写的。

---

## 六、CI

`.github/workflows/ci.yml`，三个 job，全部**无 secret 可跑**：

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  types:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@<sha>
      - uses: pnpm/action-setup@<sha>
      - uses: actions/setup-node@<sha>
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck          # tsc --noEmit 全包
      - run: pnpm lint               # oxlint
      - run: pnpm verify             # 所有 verify-* 串行

  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - # 同上
      - run: pnpm test               # vitest 单元 + 集成
      - run: pnpm test:crash         # 崩溃恢复套件（单列，慢）

  meta:
    runs-on: ubuntu-latest
    steps:
      - # 同上
      - run: pnpm verify:gates       # 每个门都有 spec、且 spec 覆盖空语料
```

**`pnpm verify:gates` 是元门**：断言 `scripts/verify-*.ts` 与 `scripts/verify-*.spec.ts` 一一对应。防止"加了一个门但没测它"。

CI 全部 SHA 固定（不用 `@v3` 这类浮动 tag），Dependabot 管更新。

---

## 七、执行顺序

**顺序不是优先级，是依赖。** 先做内循环，再谈自动化。

### PR 1 · 骨架与门的基础设施

1. pnpm workspace + 6 个空包（`package.json` 只有 name/type）
2. `tsconfig.base.json`（2.1 的完整配置）
3. oxlint 配置（2.3 的禁令）
4. `scripts/verify-deps.ts` + spec
5. `scripts/verify-types.ts` + spec
6. `scripts/verify-file-size.ts` + spec
7. `scripts/verify-gates.ts`（元门）+ spec
8. CI 三个 job
9. `docs/AGENTS.md`（给未来 agent 的规则：怎么加门、怎么加棘轮）

**验收：** 故意在 `core` 里 `import 'node:fs'` → CI 红；删掉 spec → 元门红。

### PR 2 · 类型、端口、假执行器、五条红测试

1. `packages/core/src/model.ts` — Trigger/Thread/Ticket/Mandate 类型，`Ticket` 用 branded type
2. `packages/core/src/ports.ts` — 六个端口接口
3. `packages/core/src/errors.ts` — 原因码
4. `packages/core/src/stage.ts` — `ticketStage`（先只写类型和 throw）
5. **`packages/core/src/testing/fake-executor.ts`** — 假执行器，带崩溃注入点
6. **`tests/crash/*.test.ts`** — 五条测试，全部**预期失败**（`Engine` 还没实现）
7. `verify-test-names` 门

**验收：** `pnpm test` 全红，但红的原因都是 `not implemented`，不是测试写错了。这一步的产物是**可验证性**，不是功能。

### PR 3 · store 与 schema

1. `packages/store/schema.sql`
2. migration 框架（`node:sqlite`，WAL）
3. 仓储实现（读 + 写），写函数不从包入口导出
4. `verify-schema-doc` 门
5. store 的集成测试（真文件）

**验收：** 文档 sql 块与 schema.sql 一致；改一边另一边红。

### PR 4 · Engine 让五条变绿

1. `Engine` 最小子集
2. lease 认领
3. 崩溃恢复
4. 批处理合并

**验收：** 五条 M0 测试全绿，`verify-test-names` 能找到它们。

### PR 5 · claude 执行器与 Telegram

1. `packages/executor/src/claude.ts`
2. 事件归一化
3. `packages/sources/src/telegram.ts`
4. `packages/delivery`
5. `apps/agent` 组装 + systemd unit

**验收：** 真的能在 Telegram 里用。这是 M0 的终点。

### PR 6 · 文档一致性补全

1. `verify-registry-doc`
2. `verify-concrete-terms`
3. `verify-doc-budgets`

**为什么放最后：** 这三个门依赖的文档内容（能力表、术语、预算）要到此时才稳定。太早建会天天改。

---

## 八、长期生长的规则

给未来执行这些事的 agent 看。**这一节比前面的门更重要**，因为门会过时，规则不会。

### 8.1 每次纠正 agent 之后

按降级链四问，**顺序不能乱**：

1. 能不能让这个错误在物理上不可能发生？（改类型、改 API、改目录边界）
2. 不能消灭，能不能变成确定性检查？（加门）
3. 检查写不出来，能不能自动发现？（运行时验证、性质测试）
4. 以上都不行，才写进 `docs/AGENTS.md`

**并且记录**：在 PR 描述里加一行 `降级：第 N 层`。这是唯一能看出"我们是在建机制还是在堆期待"的信号。

### 8.2 什么时候值得建门

阈值是**复现率**：

- 会重复出现的错误 → 建门
- 一次性的 → 直接修，别过度工程

判断方法：**"这个问题我在 review 时会不会第二次发现它？"** 会，就建门。

### 8.3 建门的成本底线

每个门必须满足：

| 要求 | 为什么 |
| --- | --- |
| 有 `.spec.ts` | 门自己错了谁知道 |
| 有空语料防护 | 什么都没扫到而通过的检查比没有更危险 |
| 失败信息指向根因 | 说不出为什么错，使用者只会绕过它 |
| 单次运行 < 2 秒 | 慢的门会被跳过 |

**四条缺一条，就宁可不建。**

### 8.4 什么时候删门

门也会腐烂。删除的条件：

- 对应的反模式在设计层面已经不可能出现（比如类被删了）
- 连续 6 个月没有触发过，且原因不是"没人写这种代码"

**删门也要在 PR 里写理由**，和加门一样。

### 8.5 文档纪律

1. 文档是**设计的唯一描述**，代码是它的实现。两者不一致时，`verify-schema-doc` / `verify-registry-doc` 会红。
2. 新增文档必须同时加进 `doc-budgets.manifest.json`，否则 `verify-doc-budgets` 不覆盖它。
3. 文档里的代码块如果描述**真实代码**，必须能被 `verify-type-equiv` 式的检查覆盖；如果只是示意，标注「示意，不参与检查」。
4. 不用含糊词。写不出确切值，说明这件事还没想清楚。

---

## 九、明确不自动化的部分

方法论最容易退化成教条的地方。Violet 有三处必须承认：

| 不自动化 | 为什么 | 替代做法 |
| --- | --- | --- |
| **记忆的布局**（哪个文件放什么） | 这是设计品味，判不了 | `docs/AGENTS.md` 写 guideline，人工审 |
| **"该不该说这句话"** | 本质是判断题 | **指标化 + 人工**：attention 账本给数字，月度看 |
| **accept mode 何时从 `observe` 切 `auto`** | 纯判断 | 账本是输入，决定是人做的 |

第三条尤其重要：**如果一个门能替你决定什么时候开 `auto`，它本身就比 agent 更危险。**

同理，`attention 账本` 本身不是门，它是让这套方法论不至于退化成"只做能测的事"的装置。**Violet 的核心价值恰恰在最难验证的地方**——什么时候醒、该不该做、说完有没有用。

---

## 十、判据

每季度回答一次。答不上来说明质量工作已经偏离：

1. 最近三次纠正 agent，有几次变成了检查？几次变成了文档里的一行？
2. 每个门都能自己测自己吗？删掉一个 spec，CI 会红吗？
3. 有没有门因为扫到 0 个而静默通过？
4. 存量是常量还是模糊感觉？
5. 有没有人悄悄放宽过门？（看 lint 指纹的 commit）
6. **它这周帮你做了什么？**（如果答案是"通过了所有检查"，那说明检查本身成了目标）
