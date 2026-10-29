# 代码结构与开发

这份文档写给**要改这个插件的人**：模块放在哪、层与层之间为什么这样切、加一个能力要动哪几处、
以及测试与验证怎么跑。产品行为与配置参考在 [`../README.md`](../README.md) 与
[`qoder-memory-model.md`](qoder-memory-model.md)。

`test/architecture.test.mjs` 是**这份文档的机器可执行版本**：下面的目录表、分层表、体积预算都
在那里被断言。文档与守卫不一致时，以守卫为准——它才是每次 `npm test` 真正跑的那份。

---

## 1. 一个包，两个半

```
lib/index.js     host 半的入口（wiring）：把下面各层的模块接到 harness 的 ctx 上
lib/client.js    浏览器半：设置面板 + 对话页的记忆按钮（一个自包含产物）
```

- **host 半**是 ESM，按 `lib/` 下的目录分层（下一节）。
- **client 半不是 ESM**：harness 的浏览器模块加载器**每个包只加载一个产物**，所以
  `lib/client.js` 必须是文件形式的一个 bundle（`window.__ModuleLoader__.load(...)` 工厂 +
  注入的 `require`）。它**不能 import host 模块**，只能走同源的 `/api/memory/*` 路由；
  两份语言词典与从 UI primitives 抄来的样式表作为内联数据放在这个文件里。
  这两块内联数据在体积预算里单独计量（见 §4）。

`package.json` 里 `main` / `exports['.']` 指 `lib/index.js`，`exports['./client']` 指
`lib/client.js`；`test/discovery.test.mjs` 对这两条**字面断言**。client 的 zh/en 词典**不读**
`locale/*.json`——那两个文件是给插件管理器卡片用的，只有 `test/discovery.test.mjs` 读它们。

## 2. `lib/` 的目录

| 目录 | 模块数 | 职责 |
|---|---|---|
| `lib/core/` | 5 | 谁都能用的原语：`constants` `tokens` `fs` `paths` `update`（自更新的 git 管道） |
| `lib/config/` | 5 | 配置词汇与它的写入路径：`config-rules` `scopes` `env` `config` `config-write` |
| `lib/memory/` | 13 | 记忆领域：`memory-file` `memory-edit` `journal` `render` `memory-pass` `memory-prompt` `memory-search` `imports` `excludes` `jit` `transcript` `failure-pause` `commands-report` |
| `lib/session/` | 3 | 谁在作用域内：`trust` `memory-switch` `project-scopes` |
| `lib/pipeline/` | 7 | 两个半的编排：`memory-agent` `consumption-plan` `consumption` `generation` `dream` `dream-gate` `turn-trigger` |
| `lib/host/` | 8 | harness 看到的面：`service` `tools` `routes` `commands` `consumption-seam` `config-route` `http` `update-surface` |

合计 41 个 host 模块 + `index.js`（接线）+ `client.js`（浏览器产物）= `lib/` 下 43 个 `.js`。

目录名是**职责**，不是层号：`core/` 里同时躺着 L0 的 `constants` 和 L2 的 `paths`。真正的层
是下面那张表，守卫按**完整路径**判层。

## 3. 分层与不变量

层号越小越底层，**只许向下 import**（守卫会逐条比对）：

| 层 | 模块 |
|---|---|
| L0 | `core/constants` |
| L1 | `config/config-rules` `config/scopes` `config/env` |
| L2 | `config/config` `core/tokens` `core/fs` `core/paths` `core/update` `memory/memory-file` `memory/memory-edit` `memory/journal` |
| L3 | `config/config-write` |
| L4 | `memory/render` `memory/memory-pass` `memory/memory-prompt` `memory/memory-search` `memory/imports` `memory/excludes` `session/trust` `memory/jit` `memory/transcript` `memory/failure-pause` `session/memory-switch` `session/project-scopes` `memory/commands-report` |
| L5 | `host/http` `host/update-surface` |
| L6 | `pipeline/memory-agent` `pipeline/consumption-plan` `pipeline/dream-gate` |
| L7 | `pipeline/consumption` `pipeline/generation` `pipeline/dream` |
| L8 | `pipeline/turn-trigger` |
| L9 | `host/service` `host/tools` `host/routes` `host/commands` `host/consumption-seam` `host/config-route` |
| L10 | `index.js` |

三个位置是刻意的、不是随手放的：

- **`config/config-write` 排在 schema 之上**：它必须在**落盘之前**回答"插件会不会接受这份配置"，
  所以要问 `apply()` 问的同一个问题——真的 `Config` schema 加真的 `validateMemoryConfig`。
  手搓一份近似值，正是当年漏掉 `mode` 默认值（不写就是 `native`）的原因。
- **`config-rules` / `scopes` / `env` 是叶子（L1）**：loader 路径、写入路径、路由、面板、环境覆写读的是同一份规则，
  不存在"第二份规则慢慢和第一份漂开"。
- **`host/http` 与 `host/update-surface` 在 L5，比 `host/service` 低四层**：`http` 是"读 JSON body / 回
  JSON 响应"这类与领域无关的胶水，`update-surface` 是自更新的**动词解析与那行文字**——两者都只依赖
  `core/update` 的返回值形状，不依赖 service，所以路由、命令、面板三条调用点共用它们，而不是各写一份。
- **`pipeline/turn-trigger` 在 `generation` 之上（L8）**：它**组合**生成调度器，自己持有 `turn/end` 订阅与
  回合计数——正是这一点让 `index.js` 保持"接线"而不是变成一个事件处理器。
- **`pipeline/dream-gate` 与 `consumption-plan` 同层（L6）**：两者都是"把下一步会不会发生"抽成纯函数——
  `dream-gate` 的三道闸门（小时数、扫描节流、会话数）只吃调用方给的时钟、上次运行时间与会话 header，
  所以能不起模型、不碰文件系统地测；`dream.js`（L7）只留机制：锁、状态文件、真正的 pass。这也把
  `dream.js` 从 569 行压回 397 行，让它待在 500 行预算内。

其余被守卫强制的不变量：

- **无环**，且 `index.js` 是**唯一的聚合者**：只有它可以 import `host/` 里的 presentation 模块；
- **只有 `index.js` 可以 re-export**：别的模块不得把符号转出去，对外面只有一份；
- **client 半自包含**：`lib/client.js` 不得 import/require 任何相对路径；
- **client 的路由字面量必须与 `host/routes.js` 的 `ROUTE_PATHS` 完全一致**（浏览器拿不到 host 模块，
  否则改名只在浏览器里炸）；
- **每个模块都要有 `@module` 文档注释**；每个模块**都要在分层表里登记**，分层表也不许出现
  不存在的模块（缺登记的文件过去会与 `undefined` 比较，而 `undefined < n` 恒为 false，等于放行）。

## 4. 体积预算

| 文件 | 预算 | 当前 |
|---|---|---|
| 每个 host 模块 | 逻辑 ≤ 500 行 | 最大 `host/routes.js` 489 |
| `index.js` | ≤ 300 行（接线） | 273 |
| `lib/client.js` | 逻辑 ≤ 870 行、内联数据 ≤ 260 行 | 逻辑 818、内联数据 226 |

host 的 500 行**有牙齿**：`routes.js` 撞线时拆出了 `config-route.js`、`http.js`，`commands.js` 撞线时
拆出了 `update-surface.js`，`index.js` 撞线时把每回合的订阅搬去 `pipeline/turn-trigger.js`，`dream.js`
撞线时把三道闸门搬去 `pipeline/dream-gate.js`（569 → 397 行）。
client 的那条线是**防漂移**，不是"要加功能先删点东西"：它的上限设在当前形状之上，理由与裁定过程
在 [`../CHANGELOG.md`](../CHANGELOG.md) 的「体积预算」一节。

`memory/consumption-plan` 单独存在也有原因：面板要能回答「下一步会注入什么」而**不真的回答它**。
决策被写成纯函数（`baselineFor` / `planInjection`），两个调用方只差一件事——真实投影**应用并记录**
结果，面板预览**只读不写**。每个会话的注入基准也放在这里（`readConsumptionState` / `writeConsumptionState`）。

## 5. 三条数据流

**生成（generation）**：`session/event turn/end` →（会话开关、间隔门、闸门、失败暂停）→
`pipeline/generation` 组装转录（`memory/transcript` 的游标）→ `pipeline/memory-agent` 跑工具循环
（`memory/memory-pass` 执行 `memory_write` / `memory_edit` / `memory_delete` 与 `target: daily` 的日刊）
→ 结果经 `memory/commands-report` 汇总，`host/service` 存下最近一次。那次 `turn/end` 订阅与回合计数
在 `pipeline/turn-trigger` 里。同一回合还要过一次**巩固**决定：`pipeline/dream` 先看开关、拿根、抢
`$DSH_HOME/.consolidate-lock`，再问 `pipeline/dream-gate` 的三道闸门——每根距上次运行的小时数、
数会话这一步的节流窗口、以及该作用域自上次巩固以来的**新会话数**（`ctx.get('sessions')` 活会话 +
`ctx.get('sessionPersistence')` 落盘会话，按 id 去重、比 `header.createdAt`；两个服务都不在时算
"数不出来"，不巩固且报告）。三个条件都过才真跑 pass，跑完把该根的时间写回 `$DSH_HOME/dream-state.json`。

**消费（consumption）**：`agent/pre-step` →（会话开关）→ `pipeline/consumption` 发现文件
（`memory/excludes` 排除、`memory/imports` 展开 `@`、`memory/jit` 判条件加载、`session/trust` 过信任门）
→ `memory/render` 在 `consumption.maxTokens` 下投影整块并逐文件哈希（该值是**默认的 5000 token**；
写 `'unlimited'` 时整块直接注入，丢弃/截断那套逻辑根本不进）→ 未变则静默、变了才发增量。
`pipeline/consumption-plan` 把"下一步会怎样"抽成纯函数，供面板预览只读复用。

**自更新（self-update）**：插件装成**指向本检出的软链**，所以"升级"就是让这个检出快进。
`index.js` 启动时（`update.mode !== 'off'`）调一次 `core/update` 的 `createUpdateService`：
`fetch` → `rev-list --left-right --count` → 判决（`up-to-date|behind|ahead|diverged`）。
`mode: auto` 且 `behind` 且**工作树干净**时才 `pull --ff-only`；脏树一律 `refused` 且**不拉**。
结果留在 service 里，`host/service` 的状态载荷带给面板与 `/memory`，面板按钮与 `/memory-update`
走同一个 `host/update-surface` + `POST /api/memory/update`。**host 半要下次 `dsh web` 启动才用上新代码**
（没有运行时重载），面板会明说这一点；client 半刷新即可。

## 6. 加东西时的清单

1. **新模块**：放进合适子系统 → 在 `test/architecture.test.mjs` 的 `LAYERS` 里登记 → 检查它
   只 import 更低层 → 写 `@module` 文档注释 → 守体积预算。
2. **新增对外导出**：只从 `index.js` 导出（守卫禁止别处 re-export）。
3. **新增路由**：改 `host/routes.js` 的 `ROUTE_PATHS` → 面板里调它（架构测试会要求两边字面量一致）。
4. **新增配置键**：改 `config/config.js` 的 schema 与默认值 → 若是 SDK 会拒绝的组合，规则写进
   `config/config-rules.js` → 面板要改的话走 `host/config-route.js` 的统一写入器（收窄 → 用真 schema
   校验 → `configEditor.edit`）。
5. **新增面板可写项**：值必须能在 `native` 下被拒（那就只报告、不给控件），且**控件不能提供插件
   随后会拒绝的值**——被拒绝的配置不是"没生效"，而是**插件不激活**。
6. **改客户端**：`lib/client.js` 是单文件产物，没有构建步骤；改完跑 `npm test`、必要时
   `npm run preview` / `npm run shots` 重出截图。

## 7. 测试

```powershell
npm test                # 全部：node test/run.mjs
npm run test:unit       # 只跑路径含 unit 的套件
npm run test:integration
```

- **一个套件一个进程**。这不是风格问题：`DSH_HOME`、`DSH_MEMORY_DREAM`、被 patch 的
  `console.error` 都是进程级全局，合并跑会互相污染；runner 也不解析套件内部，只按**退出码**判成败。
- `test/run.mjs` **递归**发现 `test/**/*.test.mjs`（18 个套件 / 513 项），逐个子进程执行，
  汇总各套件自己打印的计数；任一非零即失败。
- `node test/*.test.mjs` 这类写法**跑不起来**（PowerShell 不给原生命令展开通配符；会展开的 shell 里
  node 只认第一个入口）。文档里凡是批量命令，先真跑一遍再写进去。
- 套件失败没有 `process.exit` 契约：靠未捕获异常 / 未处理的 rejection 退 1。所以同步计数器
  的套件**必须**把 async 回调 await 掉（`pending` + 汇总前 `Promise.all`），否则会先打印
  `ok` 与汇总、再崩——打印出来的"全绿"是一句假话。
- **集成套件是照 Windows 文件系统写的**（`C:\home\.dsh`、`C:\proj`），这是本插件的部署环境。在 POSIX
  上 `path.join` 给出的是另一种拼写，夹具里的文件因此读不到，`integration-*` 与 `discovery` 会**在
  早先的断言上就停住**——这是环境限制，不是缺陷。改到那些套件里的东西时，"套件和改动前一样红"
  **不能**当作验证：那些断言根本没跑到。因此凡是跨文件系统要成立的行为，都另有一个到处都能跑的
  套件（`test/budget.test.mjs` 就是为注入预算准备的），或者把相关断言提取出来单独跑。

```
test/
  run.mjs                  runner
  *.test.mjs               套件：architecture / unit / client / discovery / resolve-meta /
                           journal / memory-agent / memory-model / update / budget /
                           integration-*（10 个主题）
  support/                 公共助手：harness-env（定位 harness 与安装）、integration-harness（替身与夹具）
tools/                     开发工具：preview / shots / png-probe / inspect-qodercli /
                           inspect-session / dump-qodercli-strings / composer
docs/images/               面板截图（由 tools/shots.mjs 生成，是文档资产）
```

`test/support/harness-env.mjs` 用 `DSH_HOME` / `DSH_PROFILE_DIR` 定位**正在运行**的 harness 与安装，
不写死任何路径；找不到时那几条依赖安装的检查报 `skipped` 而不是失败——克隆下来也能跑其余检查。

## 8. 验证纪律

这个仓库的判据按下面四条维护，改代码时同样适用：

1. **改完必跑全套**，没跑过不说绿。
2. **每条修复都要有能杀掉它的负面对照**：把缺陷注入回去，要求判据真的红。搬运/重排类改动
   先问"守卫靠什么枚举文件、靠什么解析关系、输入变形后是报错还是**静默变空**"——会静默变空的守卫，
   必须在改动**之前**重写。
3. **纯结构改动的判据是"真跑一次 + 基线一致"**：`lib/` 那次搬家比对的是对外导出面、常量与
   `ROUTE_PATHS` 逐字节相同；集成测试那一次拆的是**测试名多重集**完全相同。
4. **文档里的命令是"说法"不是"事实"**：`node test/*.test.mjs` 曾在 README 里躺了很久而根本跑不通。

历史与每次修复的反证记录在 [`../CHANGELOG.md`](../CHANGELOG.md)（那是**开发流水**，不是版本发布史）。
