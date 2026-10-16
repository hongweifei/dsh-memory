# Changelog

每一条记录都对应一个**发布版本**；逐轮开发过程不写在这里（那是提交与对话的事）。
格式沿用 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)。

**版本冻结在 `0.1.0`。** 做对齐本身不会发布新版本：改动累积，直到用户明确要求升级。
`test/discovery.test.mjs` 断言这个冻结值，误改会让测试红。升级是一次刻意的四处同步——
本文件、`package.json`、`README.md` 与那条断言。

早先用过的「1.0.0」「1.1.0」以及过渡期 `0.2.0`–`0.4.0`，都是对未完成工作的**过早标号**；
它们被折叠进下面这一个 `0.1.0`，而不是留成一段虚构的发布史。

> **路径口径**：本文件记录的是它写下那一刻的树。2026-10-16 的「项目结构重组」把
> `test/preview.mjs`、`test/shots.mjs`、`test/png-probe.mjs`、`test/inspect-*.mjs`、
> `test/dump-qodercli-strings.mjs`、`test/composer.mjs` 移到 `tools/`，
> `test/harness-env.mjs` 移到 `test/support/`，截图移到 `docs/images/`，
> `test/integration.test.mjs` 拆成 `test/integration-*.test.mjs`；在那之前的条目里出现的旧路径
> **没有逐个改写**（那会篡改历史），以当前树为准。测试总数同理：本篇写下的数字是当时的，
> 当前以 `npm test` 打印的为准。

---

## [0.1.0] — 第一个完成版本

把 **Qoder Agent SDK 的记忆契约**移植到 DeepSeek Harness。依据是**真实 SDK 包**
（`@qoder-ai/qoder-agent-sdk@1.0.50`）**加**本机 `qodercli` bundle 的解码，不是文档推测；
每一条契约行为都尽量引用解出的原文或代码。

### 新增

**补齐 Qoder 的另外两道巩固闸门：会话数与扫描节流（2026-10-16）**

- 起因：Qoder 的 AutoDream 有**三道**闸门，本插件此前只移植了一道（`minHours`）。解码
  `qodercli` bundle 得到原文默认值 `Akn={enabled:!1,minHours:24,minSessions:5,scanThrottleMinutes:10}`，
  以及 `tryRunDream` 里**有先后顺序**的判定：先按 `hoursSince>=minHours` 滤根 → 再查扫描节流
  （`[AutoDream] scan throttle; last scan was …s ago`）→ 才去扫会话工件 → 再把
  `t.length<minSessions` 的根报 `[AutoDream] skip <scope> root; … need <n>` 丢掉 → 抢
  `<root>/.consolidate-lock` → 才真的跑。用户裁定「补齐 Qoder 的两道闸门」。
- 新增两个配置键（**默认值照抄 Qoder**）：`generation.dream.minSessions: 5`、
  `generation.dream.scanThrottleMinutes: 10`；`0` 关掉任意一道（与 `pauseAfterFailures: 0` 同一套拼写）。
  `enabled` 仍**默认 false**——它多花一次模型调用，是否开启是用户的刻意选择，这与 Qoder 把 AutoDream
  压在 rollout 旗标后面是同一个理由。
- **会话数不从 Qoder 的工件目录数**（这是与 Qoder 唯一的语义偏离，且是有意的）：Qoder 数的是它自己
  `session-artifact` 目录里 mtime 晚于该根上次巩固的 `.jsonl`；本插件改用 Harness 自己的两个服务——
  `ctx.get('sessions').list()`（活会话）与 `ctx.get('sessionPersistence').list()`（已落盘），各取
  `.header`、**按 id 去重**（活的那份赢）、按 `projectKey(header.cwd)` 只数本项目的、**排除问的那次会话**、
  比 `header.createdAt > since`。理由是（a）本插件的 `fs` 接缝**拿不到 mtime**——本地 `fs.stat` 只回
  `{version,type,size}`，而 `version` 是 `dev:ino:size:mtimeNs:ctimeNs` 拼出的不透明串；（b）布局是
  另一个子系统的私有实现；（c）`dsh-workspace` 自己索引项目会话用的就是这条缝。
  代价写在 README §10.5：计数口径是**创建时间**，所以"被续接命中的老会话"不算新会话。
- **两个服务都不在时门是不可满足**：不巩固，并把"数不出来"的原因报出去——不是当作"数够了"。
- 扫描节流是**每调度器实例的内存状态**（Qoder 的 `lastSessionScanAt` 同样是 per-process）：只有在真去扫
  会话那一步才推进；`0` 表示每次 `turn/end` 都数。它**不落盘**，进程重启后第一次照常扫。
- 按体积预算拆模块：`lib/pipeline/dream.js` 569 → 397 行，三道闸门搬进新的
  `lib/pipeline/dream-gate.js`（193 行：`dreamLastRun` / `dreamDueRoots` / `dreamDue` / `dreamScanDue` /
  `dreamSessionRecord` / `dreamSessionKey` / `countDreamSessions` / `listDreamSessions`），它只吃调用方给的时钟、
  上次运行时间与会话 header，所以能不起模型、不碰文件系统地测；`dream.js` 只留机制（锁、状态文件、真正的 pass）。
  `test/architecture.test.mjs` 的 `LAYERS` 把 `pipeline/dream-gate.js` 登记进 L6。

验证：`npm test` 18 个套件 / **513 项全绿**（`test/memory-model.test.mjs` 41 → 46、
`test/integration-dream.test.mjs` 8 → 12）。新增的用例覆盖：判决表与节流窗口（含"窗口末尾那一毫秒"、
`0` 关闸）、按 id 合并两个注册表（重复 id 只算一次、活的 header 赢）、数当前项目的新会话且不数问的那次、
`createdAt` 恰好等于上次巩固时**不算**新会话、损坏的上次运行时间当作从未跑过、以及四条真跑 pass 的
集成用例（会话数不够不巩固；节流窗口内的第二回合不重扫；没有会话注册表时不巩固并报告；默认值确实是 5）。
`test/support/integration-harness.mjs` 补了会话注册表替身（`provideSessions`）。

负面对照：`dream-gate-mutants.mjs` 在**新拷贝**上逐条注入（`node_modules` 用 junction），
1 条基线 + 9 个变体：基线 46 条用例全过、退出 0；9 个变体全部退出码非零、且死在预期的那条用例上
（脚本自己核对栈帧所在用例与"第 N 条 ok"的序号，两者一致）：
① 数进问的那次会话 ⇒ 「the session gate counts new sessions of one project, never the asker」红；
② 取消项目过滤 ⇒ 同一条红；③ `>` 改成 `>=`（把边界算成新会话）⇒ 同一条红；④ 损坏时间当新鲜 ⇒
「a corrupt timestamp is treated as never run」红；⑤ 节流窗口末尾改晚一毫秒 ⇒
「the session scan is throttled only inside its window」红；⑥ 去掉会话数比较 ⇒
「a project that has produced fewer sessions than the gate needs does not consolidate」红；
⑦ 跳过扫描节流 ⇒ 「the session scan runs once per throttle window」红；⑧ 注册表缺席时当作满足 ⇒
「no session registry at all means no consolidation, and it is reported」红；⑨ 默认 `minSessions` 改成 0 ⇒
同⑥那条红。其中一次注入暴露出**对照表自己写错了名字**：取消项目过滤其实由
「…counts new sessions of one project, never the asker」那条用例钉住（它的 fixture 里就有别的项目的会话），
而「the project of the asking session is what the gate filters on」只测键的推导、根本不会红——已更正。
同理，套件里的用例序号此前靠一条 `^test` 锚定的正则数，漏掉了一条缩进在 `if` 里的声明
（`test/memory-model.test.mjs:144`），已改成逐行取第一个单引号串。
文档同步：README §4.1 配置示例与 §10.5（新增"巩固的会话数从哪来"）、§9 契约表的 AutoDream 行、
`docs/architecture.md`（模块数 40 → 41、分层表、体积现状与拆模块记录、生成数据流里的三道闸门、套件数）。

**自更新：启动检查 + 手动应用 + `auto` 开关（2026-10-16）**

- 起因：本插件在 profile 里是**软链安装**（`@dsh-external/dsh-memory: link:<本仓库路径>`），所以"升级插件"就是让这个检出
  快进——没有任何包管理器负责它。新增 `update.*` 配置与 `lib/core/update.js`，只做**快进**，
  绝不合并没有的提交。
- 默认 `check` 而不是 `auto`：`auto` 会**动你磁盘上的文件**。`off` 时一次 git 都不跑，
  面板里那一行也不显示；`check` 把判决说出来，要不要应用由你点。
- 判决词表：`up-to-date` / `behind` / `ahead` / `diverged` / `unavailable`（不是仓库、没有 git、超时）。
  只有 `behind` 才可能应用。
- 四种局面**拒绝而不是想办法成功**：工作树脏（`refused`，**且不拉**）、本地分叉（只 `--ff-only`）、
  detached HEAD（分支**不猜**，报 `unavailable`）、认证不上。
- git **非交互**地跑：`execFile` 不开 shell，环境里 `GIT_TERMINAL_PROMPT=0` / `GIT_ASKPASS=''` /
  `GCM_INTERACTIVE=never`，单条命令超时 `UPDATE_TIMEOUT_MS = 10_000`——私有仓库认证不上就报状态，
  不会弹窗、不会卡住启动。
- 一个动词表、一份文字，三个面共用（`lib/host/update-surface.js`）：`POST /api/memory/update`
  （收 `{action:'check'|'apply'}`，别的输入 400；`ok` 只在真拉成功时为 true）、
  `/memory-update [status|check|apply]`、`/memory` 与面板状态块**末尾那一行**（`mode: off` 时整行不显示）。
- 拉成功后的**留存状态**是 `up-to-date` + `justUpdated: true`，不是 `behind: 1`：留着落后计数会让
  `/status` 要求一次刚刚做完的更新；而"宿主半要下次 `dsh web` 启动才生效"这个事实仍得有人说出来
  （harness 的 `plugin_manager` 只有 `install_bundle` / `list_plugins` / `list_bundles`，**没有运行时重载**）。
  client 半刷新页面即可。
- 启动检查**不 await**（慢远端不该拖住插件接线），但一定写日志：没人提的更新没人会装；失败只 warn，
  远端坏了不该让用户失去记忆功能。

验证：`npm test` 18 个套件 / **504 项全绿**；新增 `test/update.test.mjs` **27 项**——判决表、假 runner 的
九种局面（不是仓库/游离 HEAD/取回失败/落后/领先/分叉/缺远端跟踪引用/干净快进/脏树拒绝/无事可做不拉/
拉取失败/mode off 零调用），以及**真实离线 git 仓库**（bare origin + clone + 多推一个提交：
落后 → 应用 → 已最新、脏树被拒且工作树存活、面板与 `/memory-update` 的面、`mode: off` 一处 git 都不跑）。
三条负面对照注入后跑 `test/update.test.mjs`，全部真红、并已逐条还原：
① 关掉脏树拒绝（`requireClean !== false` → `=== "yes"`）⇒ 「a DIRTY tree refuses, and never pulls」红；
② 拉时去掉 `--ff-only` ⇒ 「a clean fast-forward pulls, and reports both ids」红；
③ `auto` 不等 `behind` 判决就直接应用 ⇒ 「auto mode leaves an ahead or diverged checkout alone」红在
`2\t0 must not re-check` 那条断言上（**多出的那次 `fetch`** 才是那个外层判断的作用：它省掉一次网络往返）。
基线与三个变体各自跑在**新拷贝**上（`node_modules` 用 junction），所以红不是上一轮注入的残留。
面板那一行也补了此前缺的用例（`test/client.test.mjs` +1，client 62 → 63）：三种局面——`behind` 才给
「立即更新」并投 `{action:'apply'}`、`diverged` 只给「检查更新」并投 `{action:'check'}`、`mode: off`
一个控件都不给；那一行**按文字定位**（`dshmem-field` 有 19 行，按位置取"最后一行"是这个套件踩过的坑）。
同样做了负面对照：三个变体分别跑 `test/client.test.mjs`，全部真红、并已逐条还原（`lib/client.js`
的 `git hash-object` 前后都是 `c675ac3f`）——`mode: off` 仍渲染控件 ⇒ 「checks off means no control
at all」红；非 `behind` 判决仍投 `apply` ⇒ 请求体断言红（`{action:'apply'}` vs `{action:'check'}`）；
按钮恒为「立即更新」⇒ 标签断言红（`'Update now'` vs `'Check'`）。
顺带按预算拆模块：`host/http.js`（39 行）、`host/update-surface.js`（73）、`pipeline/turn-trigger.js`（88，
`turn/end` 订阅与回合计数从 `index.js` 搬出）、`config/env.js`（93），`test/architecture.test.mjs` 的
`LAYERS` 同步登记。文档同步：README §4.1/§4.4/§8.3/§8.4/§9/§11/§12、`docs/architecture.md`
（模块数与分层表、体积现状、第三条数据流、套件数）、`docs/images/` 三张截图重出。

补充：**"不写 `update` 也会自动检查"这件事现在被钉住了**（用户确认默认口径就是 `check`）。`test/unit.test.mjs`
新增一段：`resolveMemoryConfig({})` / 经 schema 两条路径上的 `update` 都必须是
`{mode:'check', dir:'', remote:'origin', branch:'', timeoutMs:10000}`；`test/update.test.mjs` 新增
「an install with no update block at all still checks once, and never pulls」（`config: {}` ⇒ 恰好一次
`fetch`、零次 `pull`、判决照常报出）。写这条防线时先揪出一个**诱饵默认值**：`UPDATE_DEFAULTS.mode: 'check'`
当时并不生效——schema 里另写了字面量 `.default('check')`，它先填充、随后把常量整个盖掉，所以"改常量"是
静默无效的。已把 schema 的五处默认值改成引用 `UPDATE_DEFAULTS.*`，并把 `UPDATE_DEFAULTS.timeoutMs` 也
接回 `UPDATE_TIMEOUT_MS`：`UPDATE_TIMEOUT_MS → UPDATE_DEFAULTS → schema` 是一条链、一个数，没有第二处
字面量。负面对照三条，全部真红、注入后逐个文件 `git hash-object` 与注入前逐字节相同：把
`UPDATE_DEFAULTS.mode` 改成 `off` ⇒ `test/unit.test.mjs` 红；`core/update.js` 里"未配置时的兜底值"改成
`off` ⇒ `test/update.test.mjs` 红；`UPDATE_TIMEOUT_MS` 改成 `5_000` ⇒ `test/unit.test.mjs` 红（默认值
确实沿这条链走到解析结果，而不是各自写死）。

**写入预算整块删除——Qoder 没有这两个字段（2026-10-16）**

- `generation.maxWrites` / `maxWriteBytes` 是本插件自己的"防跑飞"闸门（Qoder 的 SDK 与 qodercli
  **都没有**这两个字段）。上一版先把默认改成 `0`＝不设上限，用户随后的裁定是**照 Qoder 直接删掉**：
  字段、schema、面板控件、`/api/memory/write-budget` 路由、`isBudgetEnforced`、
  四个写入点的字节检查（`memory` 工具的 `write`/`edit`、后台 pass 的 write、日刊、面板的文件路由）、
  提示词里的 `── port (the budget this deployment enforces)` 段、结果里的 `deferredFiles`、
  `/memory` 的 `deferred:` 行，**全部移除**。没有兼容层、没有迁移。
- 行为：模型一轮想写几个就写几个；工具写入不再按字节拒绝；`deferredFiles` 这个字段**本身不存在**
  （不是空数组）；提示词不再承诺一个不存在的上限。`generation.maxOutputTokens` 不受影响——
  那是**模型输出**的旋钮，不是写入预算。
- 顺带删掉一个死导出：`pipeline/dream.js` 的 `dreamPrompt`（只定义、无调用点）。
- 遗留要说清：schema 对未知键**不严格**，所以旧配置里残留的 `maxWrites` 会被原样带过、
  **没有任何读者**——这不是兼容层，是"没人读它"。要清就手改 YAML。

验证：`npm test` 17 个套件 / **476 项全绿**（479 → 476：围绕预算的用例被替换或删除）。三条负面对照
都真红、并已逐条还原：① 让 `applyPlan` 只处理前 2 条写入 ⇒ integration-generation 的六写入用例红
（点名少掉的 note-2/3）；② 把 `maxWrites: 4` 塞回 `GENERATION_DEFAULTS` ⇒ unit 的「默认里没有这个键」红；
③ 把写入预算那一行连同词典键加回面板 ⇒ client 的「面板不提供写入预算」红。
截图与文档（README §4.2/§8.4、`docs/architecture.md`、本文件）已同步。

**注入上限默认改为「不设上限」——照 Qoder 的契约，而不是自造的 2000（2026-10-16）**

- **契约是这样解出来的**（本机 `qodercli@1.1.64` 的 minified bundle）：`consumption.maxTokens` 是**可选**的，
  只在给了值时才校验（`if (void 0 !== e && (… !Number.isInteger(e) || e <= 0)) throw …`）；
  真正消费记忆的加载器写的是 `let r = A.maxTokens ?? Number.POSITIVE_INFINITY`
  ⇒ **不写就是不设限**。CLI 的设置表里也**没有**记忆注入预算这一项：带 `token` / `budget` 的数字项只有
  模型输出与 Context Management（`protectionThresholdTokens: 5e4` / `minPrunableThresholdTokens: 3e4`）。
  所以 `CONSUMPTION_DEFAULTS.maxTokens: 2000` 删掉了——那是移植时自己定的（第一个提交 `aa7b051` 就在），
  Qoder 从来没有这个默认值。
- **没有兼容层**：旧配置里显式写着的 `maxTokens` 照旧生效，没写的从此就是不设限；不做迁移、不做双读。
  一处拼写：**不设限 = 字段缺席**。`render.js` 在 `maxTokens === undefined` 时整块注入，
  丢弃/截断那套逻辑根本不进；同时删掉旧的 `maxTokens <= 0` 分支——那是"0＝不注入"这个废弃说法的残留，
  而 `0` 与过去一样被 schema 拒绝（"完全不注入"始终是 `consumption.enabled: false`）。
- **写入侧跟着改**：`POST /api/memory/budget` 收正整数或 `null`，`null` 走 `withoutConsumptionCap`
  **删掉那个键**（不是写 0，也不是 Infinity；`Infinity` 不是合法 JSON）；`/memory-budget unlimited`
  走同一个实现。面板那个数字框**留空即不设上限**，占位符与只读行都写「不设上限」，
  不再出现 `undefined` 或多出来的数字。状态载荷在没有上限时**不带这个键**，预览显示"占用 N token"。

验证：`npm test` 17 个套件 / **479 项全绿**。三条负面对照都真红、并已逐条还原：
① 把 `maxTokens: 2000` 塞回默认值 ⇒ unit 与 integration-host 立刻红（期望 `undefined`、实得 `2000`）；
② 把 `withoutConsumptionCap` 改成原样返回 ⇒ "清空上限"那条红在**键没被删掉**；
③ 面板按旧写法 `String(status.maxTokens)` 渲染 ⇒ client 测试红在 `"value":"undefined"`。
`client.js` 逻辑 828 → 838 行，防漂移上限 830 → 870——这是**加了一个真实状态**（"不设上限"），
不是面板自己膨胀，所以抬线而不是压功能。

**项目结构重组：`lib/` 分六个子系统、测试按主题拆分、README 重写（2026-10-16）**

结构和文档一起做的，因为它们是同一个问题的两半：**代码里最大的文件是测试，文档里最长的文件是自述**。

- **`lib/` 从 36 个模块平铺改为六个子系统**：`core/`（原语）`config/`（配置词汇与写入路径）
  `memory/`（记忆领域）`session/`（谁在作用域内）`pipeline/`（两个半的编排）`host/`（harness 看到的面）。
  `index.js` 与 `client.js` 留在 `lib/` 根——前者是入口，后者必须保持单文件浏览器产物，
  所以 `package.json` 的 `main` / `exports` 与四处 `join(..., 'lib', 'client.js')` 都不用动。
  搬的是物理位置，行为不动：对外导出面、`CONSUMPTION_MIN_TOKENS` / `PACKAGE_NAME` /
  `SESSION_MODES` / `MODES` / `LARGE_FILE_CHARS`、`ROUTE_PATHS` 全部**逐字节与搬前一致**（已比对）。
- **架构守卫先重写，再搬**。它原来 `readdirSync(lib/)` 只扫一层、又用只认一级 `'./x.js'` 的文本正则建图：
  模块一进子目录，源集合与依赖图会**双双变空**——无环性、分层这些检查会「空绿通过」，比报红更危险。
  现在递归收集、按相对路径解析每一条 specifier（`./` `../`、动态 `import()`、副作用 `import`、单双引号），
  解析不到即失败；加到 18 条判据，其中三条是专门为此加的：「每个模块都要有条目、条目不能指向不存在的
  模块」（缺登记的文件过去与 `undefined` 比较，而 `undefined < n` 恒 false，等于放行）、
  「`lib/` 目录集合就是声明的那几个」、「相对 specifier 数量下限」。逐条做过负面对照：
  塞一个未登记模块 ⇒ 点名它变红；塞一条 `import './missing.js'` ⇒ 解析哨兵点名它变红
  （这条**第一次是绿的**——正是它暴露了扫描器看不见副作用 import 的洞，修完才发现）。
- **测试工具搬出 `test/`**：`tools/`（面板预览、截图、PNG 探针、qodercli 解码、会话检视）、
  `test/support/`（公共助手）、`docs/images/`（截图是文档资产）。新增 `test/run.mjs` 与 `npm test`：
  递归发现、一个套件一个进程、按退出码判成败、汇总各套件自报的计数。
  原因很实在：文档里那句 `node test/*.test.mjs` **根本跑不起来**（PowerShell 不给原生命令展开通配符，
  node 收到字面量；会展开的 shell 里 node 又只认第一个入口），而 `package.json` 当时**没有 scripts**。
- **4920 行的集成测试拆成 9 个主题套件 + `test/support/integration-harness.mjs`**（替身与夹具，
  0 个 `test()`）。拆分脚本按「第 n 个 `await test(` 对应第 n 个列首 `})`」取跨度（原文 182 : 182 一一对应），
  所以不存在把某条测试切成两半的可能。判据有三层：`npm test` 全绿、**测试名多重集拆分前后完全相同
  （182 = 182）**、九条计数相加 = 182。没有任何一条测试的正文或断言被改。
- **README 重写**（938 行 → 当前版本）：原文件把三份内容混在一起——使用说明、设计理由、和「这里曾经错过、
  为什么」的历史；`## 23` 还排在 `## 22` 前面，§3 与 §4.4 已经写过 §20/§21/§22/§23 的主题。现在按读者分层：
  README 讲**怎么用**，`docs/architecture.md`（新）讲**怎么改**，历史留在本文件。
  顺手改掉三处过期事实：测试数（文档写 332，实际 **475**，而且整张表漏了 journal 那一套）、
  模块数（写 26 个，实际 35 个 host 模块 + 入口 + client）、路由表（缺 `/api/memory/file`、`/refresh`、`/flush`
  三条）。补上：示例配置里缺的 `generation.enabled`、`memory` 工具缺的 `query` 参数、`$DSH_HOME` 布局里
  缺的两个状态文件、以及面板截图。
- **顺带修掉一个真缺陷**：`lib/host/routes.js` 调了 `basename()` 却没从 `node:path` 导入。能走到的条件是
  「工作区记录存在、但 `title` 为空」——`paths.js` 明确允许 title 为空，面板文档也把这条回退
  （回退成目录名）写成功能，所以是真实的用户路径：命中时整个 `/api/memory/status` 抛 `ReferenceError`。
  集成测试补了这条此前零覆盖的分支，并验证：去掉导入 ⇒ 该套件以 `basename is not defined` 变红。
- **测试计数器不再谎报异步用例**：unit / memory-model 的 `test()` 是同步 helper，各自却有几条 async 回调——
  它们过去先打印 `ok`、再打印汇总，然后才因未处理的 rejection 崩掉，"121 项通过"是一句可能为真的假话。
  现在 ok 行与计数推迟到 promise settle，汇总前 `await Promise.all(pending)`。
  负面对照（临时注入一条必失败的 async 用例）：修前打印汇总 `121 tests passed` 且 exit 1；修后两者都不打印。

测试数 459 → **475**（架构套件 14 → 18，新增的四条里三条是上面那些哨兵）。
本轮的完整验证：`npm test` = 17 个套件 / 475 项全绿；`lib/` 搬动与集成测试拆分各自的基线比对见上；
每个新判据都有一次真红的负面对照。

**作用域区挪到面板最底**

- 用户要求「将作用域区放到下面去」。新顺序：**状态 → 注入预算 → 最近活动 → 编辑记忆文件 → 作用域**。
  理由：作用域区是唯一会**无限增长**的区块（每个有记忆的项目一行），放在控件上方会把「打开页面本来要改的
  设置」挤出第一屏；它是参考资料，不是操作对象。
- **补了一条顺序断言**：此前**没有任何测试盯区块顺序**——其余断言全是与顺序无关的，所以把它移回去
  **整个套件依然全绿**。新测试用 `projectsNote` 文案定位区块（不能用「作用域」这三个字：状态区里的
  **全局作用域**控件含这个子串，我自己的验证脚本就这么被骗过一次，报出了错误的位置），
  并反向验证过：移回旧位置即红。

**日刊：Qoder 的 Daily Memory Journal（`action: "add"` + `target: "daily"`）**

- `memory_write` 多了 `target: "daily"`：走 Qoder 的日刊工具面，写入 `<root>/journal/<YYYY-MM-DD>.md`。
  提示词逐字取自 qodercli（`max 8 bullets, each <=120 chars`、候选清单、质量门槛、EXCLUDE、
  `Write all daily memory items in a single tool call. If nothing qualifies, skip daily memory.`）。
- **它挂在后台生成 pass 内部，不是交互路径上的新调用**：Qoder 的原文是 "After the memory review above"，
  所以开启日刊的代价是**一次写入**，不是一次新的模型调用。提示词只在开关为真时才出现这段——教一个工具包会
  拒绝的调用，就是提示词在许一个插件做不到的承诺。
- **日期与路径由插件算，模型只给 bullets**：Qoder 的 `chat_id` 是运行时插值的，这里会话本来就在手上，
  而模型算日期不可靠，所以两者都不经过工具调用。
- **落在 `journal/` 子目录，是刻意的**：`listRootFiles` 只读根目录平铺一层，所以日刊对注入**不可见**——
  它是记录，不是每步都要注入的记忆，也因此**不会随天数增长而挤占上下文**（根目录的 `2026-10-15.md`
  会像普通内容文件一样被注入）。
- **同一天是追加**：一天会积累多次 pass、多个会话，所以是"读 → 追加 → 写回"，并带着读到的版本做
  compare-and-swap，两个 pass 同时结束不会互相覆盖（其中一个变 stale 被拒）。`memory_write` 是整份替换，
  日刊若建在它上面，一天只会留下最后一次 pass。
- **8 条 / 120 字符只报告、从不拒绝**：Qoder 的 bundle 里对它们只有措辞、没有拒绝路径（同索引的
  "about 25KB"）。一条 bullet 超长就让日刊停止记录，比稍微啰嗦一点糟得多。
- **计入每轮写入预算**：它本来就是一次写入；豁免它，预算在开启日刊那一刻就成了谎话。
- **时区用本地日期**，不是 `toISOString().slice(0,10)`：UTC+8 下后者早上 8 点翻页，会把一晚上的工作
  记到"明天"。要读这个文件的是人。
- 面板「生成」一行多了第三个下拉（**日刊**），与另外两个开关**同一个请求、同一个保存**；打开后会说明
  写到哪个作用域、哪个子目录。`generation.journal` 默认关（照 Qoder），`scope` 默认 `project`。
  `native` 下与其它 `generation.*` 一样只报告、不给控件。

**顺带修掉一处"截图在撒谎"**：`test/preview.mjs` 的序列化器对 `<select>` 只输出 `data-value`，而浏览器
显示的是**被 `selected` 的 option**——所以每张已提交的截图里，所有下拉都显示**第一个选项**：`custom` 的
夹具被画成 `native`，三个开关无论夹具写什么都画成"开"。面板自己早为这件事修过（`<select>` 的值不匹配任何
option 会静默显示第一个），这次给测试夹具补上同一个修复。

测试 440 → 459（新增 journal 20 项、client 60、integration 181）。12 项反证全部确认会失败：日期改回 UTC、
日刊落到根目录、停止追加、去掉 compare-and-swap、超长改成拒绝、开关关着仍教日刊、工具包忽略
`target: "daily"`、豁免写入预算、默认打开、忽略 scope、面板不再说明落点、路由忽略日刊开关。
截图已重生成并看过（生成行显示「自动记录 开 / 记忆巩固 开 / 日刊 关」，模式显示 `custom`）。

**两个策略开关（`auto_memory_policy` / `auto_dream`）可在设置面板里改**

- 面板「状态」区新增**生成**一行：**自动记录**（`generation.enabled` = Qoder 的
  `auto_memory_policy.enabled`）与**记忆巩固**（`generation.dream.enabled` = `auto_dream.enabled`）
  两个下拉 + 一个保存按钮（`POST /api/memory/generation`）。二者是一个决定的两半，共同一个保存，
  不会出现"改了一个、另一个没存"。
- **关掉「自动记录」会连带关掉它的「每轮触发」**：SDK 拒绝 `generation.enabled: false` 旁边
  `turnComplete.enabled: true`，只写前者会让这次写入**被拒**、开关看起来像坏了。路由把它一起改，
  **并回报改了哪个键**（`implied`），面板照实显示——一个悄悄改邻居的开关就是在消耗信任。反过来打开时
  恢复它，所以"开"真的意味着自动记录又跑起来。只在触发**明确为 true** 时才动它：规则只在该组合下咬，
  凭空补一个用户没写过的 `turnComplete` 是往配置里塞东西。
- **不做真值转换**：值必须是 `true`/`false` 两种拼写之一。`<select>` 可能发字符串 `"false"`，那正是最容易
  被当成 `true` 的形态；`1` / `'yes'` / `'on'` 一律 400。有反证。
- **被环境变量固定的开关会说明**：`DSH_MEMORY_HEADLESS` / `DSH_MEMORY_DREAM` 盖过配置，所以那种情况下
  开关按了也不生效。`/status` 新增 `envPinned`，面板列出来并写明原因——不能生效的开关比没有更糟。
- **默认值照 Qoder，但「自动记录」刻意相反**：Qoder 两个开关默认都是 `false`（自动记忆在那边是要显式打开的
  功能）；本插件是装来用的插件，所以 `generation.enabled` 默认 `true`，`dream.enabled` 照 Qoder 默认
  `false`（它每次多花一次模型调用）。这是刻意的差异，不是没对齐。
- `generation.*` **在 `native` 下被拒绝**，与注入上限同一条铁律，所以那个模式下面板只报告值、不给控件。

**写入预算默认改为不设上限，并可在设置面板里改**

- **`generation.maxWrites` 与 `maxWriteBytes` 的默认值改为 `0`＝不设上限**（原为 4 / 16384）。
  理由：**Qoder 的 SDK 与 qodercli 都没有这两个字段**（`SerializableMemoryGenerationOptions` 只有
  enabled/roots/prompt/turnComplete，bundle 里也搜不到），所以**没有可对齐的默认值**——预设一个 Qoder
  根本不存在的上限不是"对齐"，是自造约束。要限就自己设。
- **`0` 的语义收进一处判断**：新增 `isBudgetEnforced(limit)`（`constants.js`），**四个写入点全部读它**——
  `memory` 工具的 `write` 与 `edit`、后台 pass、面板保存路由。这一点必须集中：`0` 若被当成"上限就是
  0 字节"，**每一次写入都会被拒**，而这正是改默认值时最容易踩的坑（那四个点原本都是裸的
  `bytes > maxWriteBytes`，全部会误判）。测试盯着四处，反证去掉任一处集成立刻红。
- **面板可改**（`POST /api/memory/write-budget`，§22）：两个数字框（每轮文件数 / 单文件字节）**共用一个
  保存按钮**——它们是同一件事的两半，分两个按钮会出现"改了一个、另一个没存"的中间态。控件把 `0` 显示成
  **「不设上限」**而不是裸的 0：数字标签下面写着 `0` 读起来像是限制得最死，而它其实是最松的。
  `/status` 随 payload 下发这两个值（面板拿不到 Host 模块）。
- **`generation.*` 在 `native` 下被拒绝**，与注入上限同一条铁律，所以那个模式下面板只报告值、不给控件
  ——写进去的配置插件自己不接受，而**被拒绝的配置会让插件不激活**（§3）。校验只有一条：非负整数，
  **`0` 合法**（注入上限那边的 floor 是 `1`，因为两处的 `0` 含义完全不同）。
- 提示词只在预算真正生效时讲它：不设上限时那一段**根本不出现**，模型也就不会被教一个不存在的约束。

**`memory` 工具多了 `edit`：改一段，而不是整份重写**

- **`action: 'edit'`**（`old_string` / `new_string` / `replace_all`）。此前只有 `write`，语义是**整份替换**：
  模型想改一行，必须自己把其余每一行都完美复现——记忆文件是散文，"改一处、丢一段"就是这么来的。
  工具描述也改成**推荐用 `edit` 改已有文件**。
- **语义照搬 harness 自己的 `edit` 工具**，不自创一套：`old_string` **必须唯一**，否则拒绝并说明出现了
  几次、以及 `replace_all` 可以放行；替换是**字面量**。字面量有实际后果——`String.replace` 会把替换文本里的
  `$&` / `$1` 当模式展开，而**记忆正文里本来就有代码片段**，所以两条路径都用回调形式 / `split`+`join`
  插入原文（测试钉住 `$&` 不被展开）。空 `old_string` 被拒：它匹配每个位置，"第几处"没有意义。
- **`edit` 是一次 compare-and-swap，这是它比 `write` 强的地方**：`editGuarded` 读出正文、算出新正文、再用
  **它读到的那一版**做 `replaceIfVersion`。中途有人改了（用户、别的会话、后台 pass），**写入被拒**并说明
  "文件已变，请重读后重试"。`write` 没有这个保护——它在写之前才 stat，所以**模型读完之后**发生的改动会被
  静默覆盖。而且它**不重试**：重试等于拿一份调用者没看过的正文再匹配一次 `old_string`，可能匹配到完全另一段。
- **编辑后的正文过 `maxWriteBytes`，且在落盘之前检查**：否则"拒绝"本身已经改了文件。`edit` 同样受会话开关
  约束（静音会话不能改，只读作用域不能改），拒绝信息与 `write`/`delete` 一致。
- 新增两个模块：`memory-edit.js`（纯函数，三条歧义规则不需要文件系统就能测）与 `fs.js` 里的 `editGuarded`
  （比较并交换）。测试替身的 `writeText` 原来只检查"文件是否存在"、**从不比较版本**，所以任何丢失更新都测
  不出来——现在它真的比较版本，那条竞态测试才是真的。

**插件模式（`native` / `custom`）可以在设置面板里改**

- **`POST /api/memory/mode`**，面板「状态」区第一行是一个下拉 + 保存，选项就是两种模式。这是上一轮那
  道闸的必要补充：既然 `native` 下注入上限不可编辑，用户就得有一条不必手改 YAML 再重启的出路，而这一项就是它。
  面板里可编辑的因此从**两项变成三项**（模式、全局作用域、注入上限），三项共用同一个写入器与同一套规则。
- **切换是不对称的，而且面板说了实话**：切到 `custom` 什么都不移除；切到 `native` 时，配置里 `native` 不接受的项
  **必须先拿掉，否则写入会被拒绝**——"把策略交回给运行时"本来就意味着这件事。所以路由**先剪枝再写**
  （`pruneForNative`），并把剪掉的键**列在回复的 `dropped` 里**，面板照实显示
  （"为让 native 接受，已移除：generation.prompt, consumption.maxTokens"）。**静默丢掉别人的 prompt 是不可接受的。**
  剪枝只动 `generation`/`consumption`，两个 `onResult` 一律保留（`native` 唯一放行的覆盖），空掉的块**删除**
  而不是留一个 `{}`（`{}` 在规则里等于"没写过"，留着只是噪音）。
- **模式词表、校验与剪枝都在 `config-rules.js`**（叶子模块），路由的校验、面板的选项、状态载荷的 `modeChoices`
  读的是同一份，所以控件不可能给出插件不认识的模式。输入**大小写归一**，与作用域路由一致（有测试互钉）。
- **拒绝消息改成方向中立**：原来是"…switch the plugin to `mode: custom`"，在"正要从 custom 切走"时是自相矛盾的，
  现在是"…use `mode: custom` for those, or remove them to run in native"。
- **`!!js` 表达式不会被写坏**（已核实，并加了测试）：harness 把 `!!js` 存成**原始节点** `{ __jsExpr }`
  ——"The raw node stays in the options, so write-back keeps the form"——运行时求值用于激活，但不替换
  `entry.options.config` 里那份。所以 `ConfigEditor.edit` 开头的 `structuredClone` 不会因函数抛错，本插件的
  `merge`/剪枝也按引用拷贝节点。测试同时断言该形状**可以**被 `structuredClone`（换成真正的函数就不行，
  那会让所有用 `!!js` 的 profile 配置写入全失效）。

**全局作用域可以在设置面板里改，会话开关的提示说清了**

- **全局作用域可编辑**（`POST /api/memory/scope`）：面板状态区的「全局作用域」从只读一行变成**下拉 + 保存**，
  选项 **用户 + 项目 / 用户 / 项目**（内部值 `all / user / project`），与 `/memory-scope` 的用法一字不差。
  写入方向（`scopeFields`）与读取方向（`describeGlobalScopes`）放在**同一个模块**里，所以面板和命令不可能对
  `user` 的含义产生分歧——`/memory-scope` 也换用同一个 `scopeFields`，删掉了它那份重复实现。
- **选项文案不带"仅"、顺序只有一种**：这是全局作用域控件，`用户`/`项目` 已经说清选的是什么；`仅项目`／
  `仅用户` 是从会话模式（`跟随全局 / 仅项目 / 已关闭`）借来的写法，那里有对照才需要"仅"字。顺序由
  `GLOBAL_SCOPE_CHOICES` 一处决定，同时供下拉、路由 400 提示与 `/memory-scope` 用法提示使用。
- **`none`（两个作用域都关）只报告、不提供**：它是"完全不要记忆"的第四种说法，与 `enabled: false` 重复；
  下拉里没有它，路由也拒绝它（400）。但配置里真处于该状态时面板**照实显示**并给出退出的路径。
- **没有 `configEditor` 的组合（headless / ACP / SDK）不给保存按钮**，退化成只读一行——一个点了只会得到 501 的
  控件比只读更糟。是否可写由 host 告诉面板（`/status` 的 `configWritable`），因为 `configEditor` 是 Host 服务。
- **会话开关的提示答全三个问题**：当前是什么、**它意味着什么**、点一下变成什么。旧提示只说了下一个状态，
  于是默认的 `Auto` 和静音的 `Off` 在后果上看起来一样；现在每个状态各有一句自己的说明，`aria-label` 用整句。
- **按钮答不出话时区分三种原因**：没有会话 id（置灰并直说，不再承诺一次点不动的点击）、轮询还没回来
  （显示正在读取，不是失败）、真的失败（错误原文上按钮）。旧版把三种都报成"无法更改"，等于为一次没发生的
  请求怪罪用户。
- **历史 bug**：`/memory-scope` 用内联三元读状态，把"两个作用域都关"读成 `project`，正好说反了。
- `/api/memory/budget` 与 `/api/memory/scope` 合成一个路由模块（`config-route.js`，原 `budget-route.js`），
  共用同一段"收窄 → 拒绝 → 写入"。

**会话模式扩成五态：跟随全局 / 用户 + 项目 / 仅用户 / 仅项目 / 关闭**

- **`all`（用户 + 项目）是新增的**，因为 `auto` 是"跟随配置"：在全局被设成"仅项目"的机器上，一个会话
  **没有别的办法把用户作用域要回来**。`all` 把两个开关都打开，只影响这一个会话，全局那层不动。
- **`user`（仅用户）是新增的**，与 `project` 正好是相反的两个方向：一个要本仓库的约定，一个要跨项目的经验。
  两个状态共用一套 flag 映射，所以复制粘贴会让"仅用户"的会话读到本项目笔记——测试两侧都钉住。
- **三个作用域状态复用全局那套映射**：`scopedConfig` 直接调 `scopeFields`（面板和 `/memory-scope` 写全局时
  用的同一个函数）。"这个会话用哪些作用域"是一个问题、一个答案，写第二份映射只会让两边漂开。
- **加状态最容易漏的是存储**：那个 JSON 读/写各有一半，读的那半原来用 `mode === 'project' || mode === 'off'`
  手写过滤——新状态会被 `setMode` 写进去、读回来时丢掉，会话看起来设好了、重启后又跟随配置，日志里什么都没有。
  现在读写两半共用 `isStoredSessionMode`，并有一条测试走完整条路（设置 → 读磁盘真实字节 → 用那些字节重启 → 断言）。
- **圆点按"种类"配色**：绿＝跟随配置，蓝＝本会话被钉住（三个作用域状态共用一个蓝），琥珀＝静音。漏给一个状态
  写配色会落到中性灰、读起来像"什么都没设"，所以有测试走遍 `SESSION_MODES` 要求每条都有规则。

**两级记忆开关：全局作用域 + 会话模式**

- **全局那层**（`/memory-scope all|user|project`，等价于配置里的 `userScope`/`projectScope`）：每个
  `auto` 会话跟随的作用域。插件改自己的配置走 harness 的 **`configEditor.edit`**；没有它（headless 组合）时
  命令会**说明**当前值并指出去配置里改，而不是假装改成功了。
- **会话那层**（对话页输入框里的**记忆按钮**，一次点击循环；`/memory-switch auto|all|user|project|off`）：
  五态见上一节。
- **会话控件在对话页而不是设置页**：因为 `conversation.input.left` 这个槽位**把 `sessionId` 当标准 prop
  交给控件**，所以那个按钮知道自己在哪个会话里，一次点击写的就是它自己。设置页没有这个信息，之前只能在面板上
  **枚举所有活会话**再指名切换（那段代码已随按钮一起删掉）。
- **`off` 关掉后两半一起停**：不注入（连记忆文件都不读）、不记录（后台 pass、轮内 pass、dream 全跳过），
  已排队的注入消息一并移除，`memory` 工具的写入被拒并说明原因（**读取照旧**）。
- **`project` 不是静音的一半，是作用域收窄**：该会话照常读、照常写，只是把 `user` 作用域整个摘掉。实现上
  **只做一件事**——把会话的选择折进配置本来就有的 `userScope`/`projectScope`（`scopedConfig`），于是 roots、
  信任门、身份哈希、生成提示词看到的是**同一个画面**，没有第二套需要同步的代码路径；工具、预览、刷新、生成
  四处都过这一层，所以"仅项目"的会话**不会**经由 `memory` 工具偷偷往 user 作用域写。
- 选择存在 `<DSH_HOME>/memory-off-sessions.json`，**不是**会话日志：插件事件不在 harness 的类型表里，
  `session.append` 会丢掉 `data`、读取端随后**拒收整个日志**。存的是**偏离**（`auto` 根本不写进文件），
  所以文件丢失/损坏只会让选择被遗忘，不会让记忆到处静默——而且配置改动能继续影响没被显式钉住的会话。
  旧格式（一个 id 数组，全部表示 `off`）仍可读，升级不会把某人关掉的会话悄悄打开。
- 按会话 id 记：续接保留选择，子代理**不继承**父会话的选择。
- 路由仍然解析不出"当前会话"（HTTP 请求路径上**没有 initiator 边界**），所以
  `GET/POST /api/memory/switch` 的 `session` 是必需的，指到不存在的 id 明确拒绝（409），不偷偷回退。
- `auto` 必须能说出它跟随的是什么：按钮的 `title` 写明全局那层，面板状态区有**全局作用域**一行。四种组合
  都如实报告（`all`/`project`/`user`/`none`）。

**注入上限可以在面板里改**（`POST /api/memory/budget`、`/memory-budget`）

- 面板「注入预算」区的注入上限是**数字输入框 + 保存按钮**（不是"每敲一下就存"——那样在输入 `1500` 的过程中
  会先把 `1` 写进去），并在旁边说明当前值和"要完全不注入请关掉消费开关"。
- 面板里可编辑的配置**只有两项**（全局作用域与注入上限）：一个把插件每个旋钮都摊开的面板比一个把最常改的
  那几项做好的面板更难用。试过 29 项的全量表单，然后按用户要求删掉了。
- 路由**强制转换且不猜**：表单发字符串，整数要么是 number、要么是纯数字串；`Number('')` 是 0、`Number(true)`
  是 1、`'1e3'`／`'0x10'` 也都能被 `Number` 接受，这些正是"配置被悄悄改掉"的来源。低于下限一律 400，
  并在原因里说清怎么才算"不注入"。
- 写入走 `configEditor.edit` 且**深合并**（`edit` 收到的是用户写下的原始配置，整体替换会悄悄丢掉别的键）；
  没有 `configEditor` 的组合返回 **501**（请求没问题，是这个组合写不了），而不是 400。
- 命令 `/memory-budget` 复用同一个写入器，所以命令与面板不可能给出不同的规则。
- **修掉一句假话**：旧标签写"注入上限（0＝不注入）"。schema 是 `natural().min(1)`、SDK 也要求正整数，
  所以 `0` 在配置层就被拒绝，到不了渲染层（尽管 `render.js` 确实处理 `maxTokens <= 0`）。
  要"完全不注入"的正确做法是 `consumption.enabled: false`，标签和 README 的 YAML 注释现在都这么说。
  那个下限是**一个共享常量** `CONSUMPTION_MIN_TOKENS`：schema、路由、面板输入框的 `min` 都读它，
  所以没有任何界面会给出一个插件随后会拒绝的值。

**两个半，可独立配置**

- **生成半**：一轮结束后（或 `incremental.midTurn` 下的回合进行中）跑一个后台 pass。
  它是一个**工具驱动的 Agent**（`memory_list`/`read`/`search`/`write`/`delete`，最多 8 轮），
  开场就拿到索引全文与内容文件清单（种类 + 描述），自己决定读哪些。
- **消费半**：在 `agent/pre-step` 每步重新投影，共享 token 预算；**未变静默、变了只发增量**。
- 状态词表照抄 Qoder：生成 `saved|partial|no_change|skipped|failed`；消费 `success|partial|failed`；
  每文件 `loaded|missing|failed|truncated|jit_skipped`。

**契约面**

- **目录信任门**（`trust.enabled` + `<DSH_HOME>/trusted-folders.json` + 面板授权按钮 + `POST /api/memory/trust`）。
  未信任 ⇒ 项目根**整个消失**，而不是"加载了但不注入"。
- **`memory_search`**——唯一与 Qoder 同名的工具；`memory` / `memory_get` 在本插件叫
  `memory_list` / `memory_read`，提示词里把这次改名讲清楚。
- **发现管线**：picomatch 排除（**只作用于项目作用域**，与 Qoder 一致）、大文件在 40 000 字符处
  **报告但仍加载**、读不了的文件进 `failedFiles`。
- **`@` 导入**：Qoder 的语法、四个标记、`tree`/`flat` 两种格式、`maxDepth: 5`、URL 永不跟随；
  授权 = 配置 ∨ 项目 ∨ **会话**（`/memory-imports allow`，授权后立即重新加载）。
- **每步重投影 + 增量**：`blockHash` 与逐文件哈希挂在消息 `source` 上，所以新进程能从落盘消息
  恢复比较基准，续接时继续发增量。
- **按需加载**：front-matter `paths` ⇒ 只有会话**触及**匹配路径才进入上下文；
  `trigger: false` ⇒ 永不自动加载（`manual`）；什么都不写 ⇒ 与以前完全一样。
- **生成节奏**：一个会话同时只有一个 pass，pass 期间的回合**合并成一次**跟进；
  `incremental.everyTurns`（默认 1）间隔门，两种 bypass（操作者 `shouldGenerate`、合并后的跟进）；
  `collectTranscript(session, sinceSeq)` 转录游标只取上次之后的消息。
- **回合内生成**（`incremental.midTurn`，默认关，对应 Qoder 的实验开关）：长回合中途也能记。
- **删除记忆**：`deleteGuarded` 优先用 provider 自己的 `remove`，否则用 provider 给的
  `processPath` 去 `unlink`，`sandboxMode: 'read-only'` 的后端**直接拒绝**。
  四个入口：模型工具、`memory` 的 `action: delete`、`/memory-delete`、面板删除按钮。
**治理**

- **巩固（dream）**：`generation.dream`（默认关）+ `<DSH_HOME>/.consolidate-lock`，
  Qoder 的文件名与一小时窗口；死进程/过期的锁**会被删除并替换**。
- **连续失败暂停**：`generation.pauseAfterFailures`（默认 **3**，即 Qoder 的 `hFl = 3`，0＝永不暂停）。
  同一个坏配置会让每个回合各失败一次、各烧一次模型调用；现在连续三次 `failed` 后本会话的 pass
  只记一条 `skipped`（原因 `paused after 3 consecutive failures: …`）且**不再调用模型**，
  任何一次成功把计数清零。原实现没有恢复路径，本插件补 `/memory-resume` 作为唯一出口。
- **环境变量覆写**：`DSH_MEMORY_HEADLESS|PROJECT|USER|DREAM`，同一套布尔词汇，环境优先。
- **索引约束**：写入时检查"约 25KB"与"单行超过约 200 字符"，报告进结果、日志与面板——**不拒绝**。
- **`snapshot` 的 `sections` 携带正文**（`form: 'snapshot'` 时），不再只写文件名占位。
  Chat 视图的 `snapshot` 形态**只渲染 `sections`、不渲染 `content`**，所以空 `text` 会让模型读到的
  4000 多字符在那一行完全不可见——注入恰好在最该能核对的地方失去可审计性。Trajectory 视图不受影响
  （它渲染整段正文，不读 `sections`）。宿主自带生产者都成对写入，`time-context` 的 invariant 甚至
  断言两者必须相等。代价是落盘消息里这份文本存两份：本机 203 次真实注入实测占 171 MB 压缩日志的
  0.49%（未压缩），重复内容经 zstd 后几乎不增体积。

**界面**

- 设置面板（中英双语，真实 `--dsw-*` 主题 token）：状态、**作用域区（`user` 加每个有记忆的项目）**、
  每文件打开/删除、信任授权按钮、活动与告警（大文件/失败/被排除/被拦导入/**jit 跳过**/**索引告警**）、
  编辑器（作用域下拉 + 文件名 + 保存/重载/等待）。
- **预算区把两半都摊开**：标题写明是**注入**预算（消费半），三个原值 `maxTokens` / `overflow` /
  `failureMode` 的标签直接带枚举含义（`truncate | fail_query`、`best_effort | fail_query`），
  并补上生成侧的两个旋钮（输出上限 `0 = 模型默认`、连续失败暂停阈值 `0 = 永不`）。
  原先只显示一半的 token 故事，正是"输出预算被烧光却没人发现"的土壤。
- **注入预览**（`GET /api/memory/preview` + `ctx.memory.previewMemory()`）：回答"我写的记忆到底进没进
  上下文"。给的是**下一步的判定**（`silent` 什么都不注入 / `snapshot` 全量 / `delta` 只发变动 /
  `none`）、本步 token、变动的文件，以及新会话会收到的**完整块正文**（折叠在 `<details>` 里）。
  取代了原来那行**事后**的「最近一次消费」清单——同一个问题，事前回答才解释得清"为什么没进"。
  **它绝不改变它描述的行为**：不记 `lastConsumption`、不触发 `onResult`、用一次性版本缓存、
  **只读不写**该会话的注入基准（预览若推进基准，下一步就会判定"未变"而停发，等于看一眼面板
  就把注入关掉了）。按需触发，**不挂**在 5 秒一次的 status 轮询上。为此把
  "给定基准该注入什么"抽成纯函数模块 `lib/consumption-plan.js`，真实投影与预览只差"应用与否"。
  测试 `previewMemory describes the next step without changing it` 钉住这条，并已用负控验证：
  把写基准加回去，测试立刻以 `the preview must not have consumed the snapshot` 失败。
- **作用域区是一行一个作用域的列表**：**标题是工作区名字**（`EasyGit` 而不是
  `--D-Projects-EasyGit--`；用 `workspaceRegistry` 的路径**正向**算出 slug 来配对——slug 有损、
  反推不出路径，所以只有这个方向可行；查不到工作区的项目回退成 slug，`user` 作用域本来就没有），
  悬停显示 slug；行内还有读写标签 + 「N 个记忆文件」+ 占用大小（宿主没给就**整段省略**，
  不显示 `undefined`、也不拿横线占位），文件折叠在行下（`<details>`，展开后逐文件打开/删除）。
  整行禁止换行：长项目名省略号截断，不会把按钮挤到第二行；列表与上方说明之间留 8px 间距。
  行显示**占用大小**而不是"更新于"——harness 的 `FsInfo` 只有 `version/type/size`，
  没有修改时间，编不出来。
  `subprocess` 服务 spawn `explorer.exe`（失败退 `cmd /c start`）。本机点了打不开，而这条链路在
  测试里只能验 argv/stdio 形状、验不了"窗口真的出现了"，于是按用户要求撤掉：面板不再有该按钮，
  `POST /api/memory/reveal` 与 `lib/reveal.js` 一并删除。留给将来的一条证据：**这条路在当前
  harness 上不通**，别再从面板侧绕。
- **记忆写入不再被"非会话的"沙箱默认值挡住**（用户报告的 `file access denied under workspace-write
  mode`——且当时**会话本身是完全权限**）。记忆按契约放在 `$DSH_HOME`，**永远在会话工作区之外**；harness
  的沙箱后端对一次**没有声明策略**的调用是这么解围栏的：

  ```js
  const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve();   // dsh-fs-sandbox
  ```

  **不带会话**的 `resolve()` 只回**部署默认值**（本部署 `mode: workspace-write`，根是 harness 自己的
  工作目录），它**不会自己去找会话**——所以会话被切成完全权限也救不了这次写入，而**读不受限**
  （"the mutation fence does not restrict observation"），于是记忆一直能加载、只有写失败。新增
  `writePolicy`：
  - `memory-root`（**默认**）：记忆与插件自有存储（信任库、巩固锁与状态）在写入时声明**自己的目录**
    作为沙箱根，写仍被插件自己的路径校验限在作用域内，任何会话策略下记忆都可写；
  - `session`：**真的去问那个会话**（`resolve({ session })`，与 harness 自己的工具同一条路径——
    `resolve(exec.agent === undefined ? {} : { session: exec.agent.session })`），受限模式下记忆变
    **只读**；此时**删除也不再走 `node:fs` 绕过围栏**，而是按会话模式拒绝（provider 的 `remove` 本身
    受围栏约束、`processPath` 的 unlink 不受）。没有会话可问（定时触发的巩固）就退到部署默认值。
  面板那一行是「记忆写入（memory-root＝自声明沙箱根 | session＝跟随会话策略）· 声明的模式」，当
  `memory-root` 与受限会话并存时再补一段「· session <会话模式>」——两个数字分开显示，才不会把"完全
  权限的会话"看成"被围栏的会话"；`/memory` 打同一组事实并在只读时明说原因。
- **单轮写入预算不再伪装成失败**（用户报告的 `写入被拒 status.md：at most 4 files may be written per
  pass`）。`generation.maxWrites`（当时默认 **4**；**本版已改为 0＝不设上限**，见上）是本插件自己的
  防跑飞上限——Qoder 的 SDK 与 qodercli
  **都没有这个字段**（`SerializableMemoryGenerationOptions` 只有 enabled/roots/prompt/turnComplete，
  bundle 里也搜不到 maxWrites）——但第一版**既没在提示里写明它，又把撞线记成 failed**，于是"一轮写了
  4 个、第 5 个被拦"在面板上变成 `写入被拒 <文件>：…`，一轮已经干完的 pass 看起来是坏的。现在两半都
  补齐：
  - 提示里新增 `── port (the budget this deployment enforces)`，写明每轮文件数（**索引也算一个**）
    与单文件字节数，并说明"超预算的写入不会被尝试、下一轮从索引继续"；
  - 撞线的写入记为 **deferred**（`deferredFiles`；状态仍是 `saved`，`failedFiles` 不再被污染），
    模型侧收到 `not attempted: the per-pass write budget (N) is spent — the next pass continues from
    the index`，`/memory` 用 `deferred:` 单列一行；JSON 计划那条回退路径原先用
    `slice(0, maxWrites)` **静默丢弃**多余条目，现在同样如实记为 deferred。
  `maxWrites: 0` 也改成**不设上限**，与 `maxOutputTokens` / `maxWriteBytes` 的 `0＝不设上限` 约定
  一致（在此之前 0 会让每一次写入都被拒，与 README 的说明相反）。
- `/memory`、`/memory-trust`、`/memory-imports`、`/memory-delete`、`/memory-refresh`、
  `/memory-flush`、`/memory-resume`。

### 解码得到的关键证据

这些是实现的依据，也是复核时应该看的原文：

```js
// 信任门（默认关：不启用就是全部信任）
isTrustedFolder() { return !this.folderTrust || (this.trustedFolder ?? false) }

// 间隔门算术：逐轮累加，达到 N 就跑并把计数归零
shouldRunForTurnCompleteInterval(context, first) {
  return !((!first && !context.skipExtractionIntervalGate &&
            (this.turnsSinceLastExtraction += 1, this.turnsSinceLastExtraction < mZr())) ||
           (this.turnsSinceLastExtraction = 0, 0))
}

// 增量转录游标：找不到游标就退回全量（丢历史比重复送更糟）
function MOl(messages, lastProcessedUuid) {
  if (!lastProcessedUuid) return [...messages]
  const at = messages.findIndex((m) => m.uuid === lastProcessedUuid)
  return at === -1 ? [...messages] : messages.slice(at + 1)
}

// 按需加载的三态
function swn(file) {
  if (i === undefined) return { trigger: 'always_on' }
  if (i === false)     return { trigger: 'manual' }
  const n = fet(e.paths)
  return n ? { trigger: 'glob', globs: n } : { trigger: 'always_on' }
}

// 巩固锁
dfl = '.consolidate-lock'; gfl = 36e5
z6i(pid) = { try { process.kill(pid, 0); return true } catch { return false } }
// 死 PID → unlink，日志 "reclaimed lock from exited PID … before time gate"

// 环境变量的名字与布尔词汇
Pr(name) = `${brandPrefix}${name}`        // MEMORY_HEADLESS / MEMORY_PROJECT / MEMORY_USER / DREAM
true:  1 | true | yes | on                // trim + lowercase
false: 0 | false | no  | off              // 其他值一律当"未设置"
```

删除用的那条缝出自 `fs` 服务的文档，不是绕路：
`processPath(target)` = "the canonical absolute path a subprocess in this filesystem's execution world can open"。

### 明确不做（都有证据，不是没做）

| 不做 | 理由 |
|---|---|
| **AGENTS.md 层** | Qoder 的 `globalMemory`/`pluginMemory`/`projectMemory`/`localMemory` 四个桶的原料是 `getAllQoderMdFilenames()`，即**指令文件族**；在 DSH 由 `dsh-agent-instructions` 负责（项目 `AGENTS.md`/`CLAUDE.md`、`.local` 变体、`$DSH_HOME/AGENTS.md`）。照搬会**同一份文件每次请求注入两遍**。 |
| **skills 记忆目录** | 技能是 harness 的一等子系统（`ctx.skills`）；Qoder 的 `getProjectSkillsMemoryDir()` 在整个 bundle 里**只有定义、没有调用点**。 |
| ~~**daily journal**~~ | **2026-10-15 已实现**（见上方新增条目）。原先不做的理由是"那是 QoderWork 桌面版的工具面，不是 SDK 记忆契约"；用户要求做，于是按 bundle 里逐字解出的提示词与 `action:"add" target:"daily"` 工具面实现。 |
| **旧数据迁移** | 不做任何兼容层：旧目录不读也不删，要留内容就手工复制。 |
| `usage`/`credits`/`requester: 'sdk'` | 辅助调用不回报计费。 |
| `origin: 'main_session'` | 命名差异：轮内 pass 报 `turn_complete` + `midTurn: true`。 |

### 纠正过的错误结论

- **`memoryBoundaryMarkers` 不是注入分隔符**——它是**发现的上限**；注入块由
  `<loaded_context>` / `<project_context>` 一类标签界定。早先的笔记写错了，实现按解码结果改。
- **"AGENTS.md 这一层没做"** 不是缺口而是**决定**：它归 harness，做了就是双重注入。
- **`getProjectSkillsMemoryDir()`** 看起来像"记忆里的技能目录"，实际**没有调用点**。
- **注入粒度**：早先以为是"会话开始时加载一次"，实际是**每次请求重建**——P1-4 按此重写。

### 修过的真实缺陷

每条都留了测试；括号里是当初的错法。

**注入预览的三处显示错误**（用户看了截图报的，一次修完；三处都能在提交的截图里看见或从代码读出）：

- **被静音的会话会让面板报错**。`previewMemory` 对静音会话只回**判定**、**故意不给 `snapshot`**
  （跑一遍就会描述一个不会发生的步骤），而卡片无条件读 `preview.snapshot.maxTokens` 和
  `step.changed.length` —— 渲染时抛异常，**恰好在这个预览最有用的状态下把面板弄坏**。
  集成测试覆盖了那个 payload，客户端测试覆盖了怎么读它，两边各测一半、中间那条缝没人测。
  现在两处都按"缺了就是缺了"处理，并有测试专门喂**只带 `action`/`reason`** 的静音 payload。
- **判定词直接印宿主代码**。面板上显示的是 `snapshot` / `silent` 这种英文机读码，违反本仓库
  "中文面板不许半英文"的规则。现在四种判定（`silent`/`snapshot`/`delta`/`none`）都有中文，
  原始代码和机器原因一起进 `title`；遇到不认识的判定就**明说不认识**，而不是把那个词原样印出去。
- **整块被裁掉半行**。`<pre>` 默认 `white-space: pre`，而记忆是散文加文件路径，长行直接跑出右边界、
  从词中间被切掉且无法读到。现在 `pre-wrap` + `break-word`。
- **为什么能活到被截图发现**：`test/preview.mjs` 渲染的 `<details>` 默认**折叠**，而记忆块就在里面 ——
  于是**每张提交的截图都只显示一个折叠的三角**，从来没显示过这块面板存在的意义（那段正文）。
  现在序列化器只把**含 `<pre>` 的那一个** disclosure 标 `open`（作用域行仍按静息形态折叠），
  所以证据真的展示了内容。
- **顺带修掉一处"预览少报数字"**：`planInjection` 只在 delta 路径设置 `tokens`（那里 delta 的代价
  与整块不同），于是 `snapshot` 报 **0** —— 面板一边显示"占用 0 / 10000 token"一边在下面展示整块正文，
  数字和它下方的文字自相矛盾。快照的代价就是整块，现在按整块报。

- **生成预算的默认值会把推理模型逼死**（`maxOutputTokens: 2000`）。它抄的是 Qoder
  `summarizer-*` 任务类型的 `2e3`——那是给摘要用的，而本插件的 pass 是**用工具调用写文件**的，
  正文就在工具参数里；推理模型常在吐出任何工具调用之前就耗尽 2000。而且 SDK 的
  `SerializableMemoryGenerationOptions` 里**根本没有 token 字段**，所以这不是"要对齐的契约"，
  就是本插件的选择：默认改为 **0＝不设上限**（适配器套用模型自己的默认值）。
  同时修掉当年更糟的一半：**被截断的那一轮里已经收到的完整工具调用过去会被整轮丢弃**，
  于是即使写入已经成功也报 `failed`。现在照常落地，然后结束循环（模型想到一半断了，
  再来一轮只会重复烧预算）；只有那一轮**没有可用工具调用**时才失败，原因里写明要调哪个旋钮。
- **面板只说 `failed`，不说为什么**，而且**宿主侧根本没给原因**：工具驱动的 pass 走
  `toolkit.result('')`，无论成败都带一个空 reason，被拒写入又只存在于 `failedFiles` 里。
  于是一个 "最近一次生成总是 failed" 的现象无法追查。现在两侧都补齐：
  `summarizeWrites` 在没有声明原因时用**第一条拒绝**当原因
  （`every attempt was refused: content exceeds maxWriteBytes 16384`），面板的生成行渲染
  `failed (turn 3) — …`，每个被拒写入各占一条告警，`skipped` 也照样说明
  （`prompt shorter than 40 characters`）。
- **并发生成互相覆盖索引**（每个 `turn/end` 各起一次 pass）→ 每会话串行 + 合并跟进。
- **间隔 > 1 时丢历史**（只送触发那次 pass 的那一轮）→ 转录游标。
- **面板标签被挤成一列**（`flex:1;min-width:0` 让中文标签逐字断行）→ `min-width:max-content` + `keep-all`。
- **下拉框被当按钮排版**（28px vs 输入框 34px、透明背景、没给箭头留位、选项未上主题）→ 独立 `.dshmem-select`。
- **文件行按钮被 `space-between` 拆开**（三个 flex 子元素）→ 文件名与按钮组两段式。
- **受控 `select` 的值不在选项里**（`scope` 初始 `'project'` 而项目作用域可能未启用）→ 推导 `activeScope`。
- **信任行比邻居低**（借用了编辑器的 toolbar 类，带 12px 上内边距）→ 独立 `.dshmem-trust`。
- **磁盘扫描绕过信任门**（门开着时会列出甚至允许编辑门拒绝加载的记忆）→ 门开着就完全不扫描。
- **`ReferenceError` 被 `catch` 吞掉**（`changeFields` 用了没解构的字段）→ 面板静默无输出；集成测试当场抓住。
- **删除的两处**：越 root 的删除被拒并记入 `failedFiles`；删除算一次**尝试**（两次被拒是 `failed` 而非 `no_change`）。
- **索引告警**：超限内容**仍然落盘**，只报告（与"advisory"的字面一致）。
- **`GET /api/memory/preview` 只要会话在作用域内就返回 500**：路由把**会话**传给了
  `previewMemory(agent)`，于是 `target.session` 是 `undefined`，`visibleMemoryState(undefined, …)`
  抛 `Cannot read properties of undefined (reading 'surface')`，被路由的 catch 收成 500。
  之所以长期没被发现，是因为面板的渲染夹具**喂的是写死的 payload**，从未真的调过那条路由；
  现在有一条集成测试直接调它并断言 200 + 真实快照。
- **全局作用域把四种组合说成两种**：`describeGlobalScopes` 原本只分"都有"与"仅项目"，于是
  `userScope: true, projectScope: false`（`/memory-scope user` 写出来的正是它）被报成 `all`——**把话说反了**，
  而"两个都关"也被折进 `project`。四条组合现在都如实报告，并有一条测试逐个钉住。
- **预览工具悄悄预览错了组件**：`test/preview.mjs` 取**最后一个** slot 注册，而插件在会话控件加入后有了两个；
  于是它渲染的是一个 2 元素的按钮而不是设置页（文件从 17KB 掉到 9KB）。现在**按名字**取
  `settings.section`，并有一条警告在按钮找不到时出声。
- **预览工具不输出表单控件的属性**：同一个序列化器只写 `class`／`data-*`／`disabled`，从不写 `type`、
  `checked`、`value`、`min`——于是数字输入框在截图里**不显示当前值**、也丢了 `min`。截图是本仓库的交付
  证据之一，所以它必须带上浏览器需要的东西；现在这些属性都会输出（这条修复是上一轮改预览工具时发现的，
  这一轮保留下来的）。
- **每一次成功的删除都是一次"无效输出"**：`memory` 工具声明了 `output.schema`，而 harness **拿它校验每个
  返回值**——多一个未声明的键就直接判失败：`tool "memory" returned invalid output:
  "value.files[0].deleted" is not a declared property (additionalProperties: false)`。而删除分支返回的正是
  `files: [{ …, deleted: true }]`，schema 里却没有这个字段。后果很有害：**文件真的被删掉了**，但模型收到的
  是一次失败的调用，于是它既不知道删成功了、也无法据此改写索引（而删除后不改索引正是本插件明说的坑）。
  修法是把它声明成真实（可选）属性。现在有一条测试**驱动真实的 harness 校验器**跑遍每个 action 的返回值
  （含各失败路径），所以这一类"schema 与实现不一致"的问题不会再漏过——按 action 写断言是抓不到它的，
  因为错的是 schema 本身。
- **在 `mode: native` 下保存注入上限会让插件整个不激活**（用户实测报告，本轮修）。面板不区分模式，
  在 `native` 下也给出可编辑的注入上限；而 SDK 规则在 `native` 下**拒绝** `consumption.*`，只放行两个
  `onResult` 回调和作用域开关。保存写进去的配置被插件自己拒绝，而**被拒绝的配置不是"没生效"**——
  `validateMemoryConfig` 在 `apply()` 里跑，Loader 重新加载时抛错，于是插件**根本没激活**，记忆在所有
  会话里消失，日志就是那句 `1 entry did not activate memory (…): Error: memory: mode "native" only
  accepts generation.onResult and consumption.onResult`。`mode` 的默认值**就是** `native`，所以"不写
  `mode`"的 profile 全在这个坑里。**没被测试抓到是因为所有写入类测试都用 `mode: 'custom'`**。
  修法三道闸：**写入前校验**（`judgeConfig` 把候选配置先过**真正的 schema + 真正的规则**，不过关就在
  `configEditor.edit` 的**回调里**抛错——那个回调在落盘之前跑，profile 保持原样；**必须过 schema**，
  因为只看写入的键会漏掉**默认值**，第一版修复就是栽在这里、被单元测试顶出来的）；**面板不给假控件**
  （`/status` 新增 `consumptionWritable`，`native` 下照实显示但不可编辑，并说明切到 `mode: custom`
  才能改）；**400 与 501 分开**（被插件拒绝是调用者的请求问题，组合没有写入器才是部署差异）。
  规则同时收进两个**叶子模块** `config-rules.js` / `scopes.js`，`config-write.js` 因此排到 schema
  **之上**——它必须能问 `apply()` 问的那个问题。
- **设置面板的「预览」每次都报"无法预览：no session is in scope"**（用户实测报告，本轮修）。
  `previewMemory` 要求一个会话，而**设置页是全局界面**：`settings.section` 是 root 作用域、**不传
  `sessionId`**，且**任何 HTTP 请求都没有 initiator 边界**（`withInitiator` 在生产里只有一个调用点：
  agent loop 的 driver）——所以 `currentInitiator()` 在路由里**永远**是 `undefined`，那个按钮因此
  **每次**都失败。修法：把"为哪个会话"抽成一处 **`resolveScopeAgent`**（`memory-switch.js`），
  `/preview` 和 `/status` 共用，按确定性递减解析：`?session=<id>`（点名）→ 进程内 initiator
  （命令/工具有）→ **唯一的顶层活会话**（用 `roots()` 而非 `list()`——`list()` 含**子代理**，一个子代理
  会被误当成"唯一会话"，于是预览去描述那个没人看的子会话）→ 都没有时回答**全局配置**并**明说**
  （`scope: 'global'`，面板显示一句说明）。会话多于一个时**不猜**（枚举活会话挑一个的代码在本仓库
  历史里出现过，已删）；点名但已死的会话**409**，不静默回退。会话无关的路径同时容忍无会话：
  `visibleMemoryState(undefined)` 返回 `undefined`（即"没有基准"→ 全量快照），`runConsumption`
  改用 `agent?.session?.…`。
  **宽松解析只用于读**：写入仍走严格的 `resolveLiveAgent`，`/api/memory/switch` 的 `session` 依然必需、
  指到不存在的 id 依然 409——读错只是显示不准，写错会改掉别人的记忆设置。
- **同一个根因还让面板撒过一个谎，并且写错过一个目录**（一并修）。三处症状、一个原因（都走
  `currentInitiator()`，而它在浏览器请求里永远是 `undefined`）：`/status` 的 `memoryMode` 永远是
  `undefined`，面板渲染成"跟随全局"——**等于告诉一个已被静音的会话它正跟随配置**；`projectFolder` 回落到
  host 自己的 cwd（通常是 harness home，**不是**用户的项目）；于是**信任按钮的默认目录也是那个错路径**，
  "信任此目录"会**信任 harness home 而不是项目**——这是**写错目标**，不是显示问题。
  现在三者共用 `resolveScopeAgent`（`activeSession` 也改成走它）；真解析不出来时面板显示
  **"无法确定（当前打开了多个会话）"**，而不是回落到"跟随全局"。
- **这缺陷能活到现在，是因为测试替身 `switchFixture` 调了 `setInitiator(agent)`，喂了生产永远没有的
  东西**——和上面 `native` 那个缺陷同一类错误。现在有测试**专门不带 initiator** 走 `/preview`、`/status`
  与 `/api/memory/trust` 三条路由，另有"只有一个子代理时不许当成打开的会话""多于一个会话时不许猜"
  "点名死会话要 409"。
- **另外**：`test/integration.test.mjs` 顶部有两处早先损坏的破折号（U+FFFD 替换字符，`HEAD` 里就有），
  已修好；仓库本来就有"任何文件不得带 CP936 损坏"的检查，但替换字符不在它认的那种形态里。

### 兼容性（核对过 harness `0.2.0-rc.2`）

- **核对方式是问正在运行的宿主**，不是只信测试替身：宿主 Inspect 的
  `Service.listService('fs' | 'llm')`、`Event.listEvents('session/event')`、
  客户端 `Slots.listSubTree('settings.section')`。结论见 README §19——`fs.processPath`（删除靠它）、
  `GenerateOptions`（我们发的 `RequestUserInput` 合法，且没有发那个闭合的 `purpose`）、
  `FinishReasonMap`、`ToolSchema` / `ToolResultMessage`、`turn/end` 与 `Session` 读法、
  `tokenMeter.estimateMessage` 全部未变；面板占用者 `memory-ui/memory` 在新客户端里 `active: true`。
- **修掉一个会让升级被漏掉的测试盲区**：桌面版把 harness 打包成 `app.asar`，而 profile 的 Node 解析
  可能仍指向更旧的 npm 安装（本机 `0.1.7-rc.2` 对 `0.2.0-rc.2`），于是"全绿"验的是旧版本。
  现在 `test/harness-env.mjs` 优先定位**正在运行**的那份（`DSH_HARNESS_BUNDLE` 可显式指定），
  并新增一条测试：面板用到的每个 `--dsw-*` token 都必须在**运行版 bundle** 里存在，且打印它用的 oracle。

### 可移植性（仓库里不出现"某台机器"）

源码、文档、示例与测试都**不含写死的绝对路径**：

- harness 与插件的位置由 harness 自己导出的 `DSH_HOME` / `DSH_PROFILE_DIR` 发现
  （`test/harness-env.mjs`），依赖安装的检查在找不到安装时**自行跳过**并打印原因，
  而不是在只有一台机器存在的路径上失败——纯克隆的仓库照样能跑其余全部检查。
- 安装配方用 `npm root -g` 定位 harness，示例统一用占位路径（`<本仓库路径>`、`D:/code/...`）。
- `test/inspect-qodercli.mjs` / `dump-qodercli-strings.mjs` 通过 `QODERCLI_BUNDLE` 或全局 npm 根找
  `qodercli`，输出写到脚本旁边的 `docs/`。
- 一条架构测试**反过来守着这件事**：整个检出里出现具体的主目录（`C:\Users\<真名>`、`/home/<真名>`）
  就失败，占位符与 `/home/u` 这类夹具名放行。
- 项目身份的对照也从"写死四个目录名"改成**正向的活体核对**：读每个 session 头部记录的 `cwd`
  重新算目录名，必须与 harness 建的目录同名——顺带证明了 slug 只能正向推、不能反推。

### 验证

**332 项测试全绿**：unit 95 / integration 112 / model 41 / client 37 / architecture 14 /
agent 18 / package-shape 10 / resolveMeta 4。跑法见 README §16；其中依赖"本机装了 harness"
或"本机有会话存储"的少数检查会自行跳过，总数会因此少几条。

每一项修复都**验证过"回退会红"**（去掉修复，指出失败的测试）：

- 信任门 → `resolveEffectiveRoots` 去掉门后，信任测试在"只有 user 作用域存活"处失败。
- `memory_search` → `findHits` 永不命中，unit / agent / integration 三套同时红。
- 项目身份 → 读 `$DSH_HOME/sessions` 里每个 session 头部记录的 `cwd`，重新算出目录名，
  必须与 harness 建的目录同名（含只能转义的 `~5DE5` 那类），偏离 harness 分组即红。
- 发现管线 → `isExcluded` 恒 `false`、`classifyLargeFiles` 恒 `[]`，两半各自红。
- `@` 导入 → 关掉展开红在集成，`parseImports` 返回空再红在单测。
- 增量注入 → 去掉"与上次比较"，集成红在"a delta must not declare itself a snapshot"。
- 读盘快进 → 禁用缓存命中，unit 红在"an unchanged version must not be re-read"。
- 转录游标 → 换回 `collectTurn(session, turn)`，集成红在"first turn prompt must reach the model"。
- **一次自伤，记下来当教训**：用 `Get-Content`/`Set-Content` 编辑了 `test/integration.test.mjs`
  （文件里有 `—` 与中文），CP936 往返把文件**编坏**了——乱码、`—` 全丢、还多了 BOM。
  已从 git 恢复并重做那几处改动。新增一条架构测试补上这个盲区：
  **仓库里任何文本文件出现 CP936 乱码标记或 BOM 就失败**（标记用码点构造，测试自己不含这些字符）。
- 索引告警 → `applyOneWrite` 不算告警，集成红在超限索引那条；把解出的原句改写，模型测试红。
- 失败原因 → 去掉 `summarizeWrites` 的回退，agent 测试红在 "a refused write with no stated
  reason still explains the failure"；把面板的 `last.reason` 拿掉，client 测试红在
  "the reason must reach the activity row"。
- 截断轮次 → 恢复"整轮丢弃"的旧写法，agent 测试红在 "a round cut short by the output cap
  still lands its tool calls"；把默认值改回 2000，unit 测试红在
  "resolveMemoryConfig fills the plugin defaults"。
- 失败暂停 → 去掉 `pass` 里的暂停闸门，集成红在 "generation pauses after three consecutive
  failures and stops calling the model"（模型调用数会变成 4 而不是 3）；让成功不清零计数，
  集成红在 "a success clears the failure count before it can arm the pause"。
- 按需加载 → `jitDecision` 恒加载，unit 红在触发决策、集成红在"a glob-triggered file must not load before a match"。
- 回合内生成 → 去掉 `index.js` 里的调用点，集成红在"an open turn with new messages generates"。
- 标签挤压 → 恢复旧 CSS，client 红在"the label must not be shrinkable below its text"。
- 文件行分组 → client 断言每行恰好一个 `.dshmem-actions` 且只装按钮。
- 环境变量与锁 → 让 `applyEnvironmentOverrides` 原样返回、`dreamLockHeld` 恒 `false`，
  unit / model / integration 同时红。
- 删除 → 去掉 provider 分支红在集成与 agent；去掉 `unlink` 红在单测（用真实临时文件，不用 mock）。

### 已知限制

- 两处提示词片段解不出（运行时插值的行数上限 `⟨lines⟩`、缺了开头从句的
  "…under about 25KB"），**就地声明**而不是编造。
- 索引约束**只报告不阻止**（原实现也只在提示词里说）。
- `client.js` 的体积检查是**防漂移**而非必须凑合的额度。它先前卡在 560/560，注入预览与注入上限
  都是在"不抬上限"的前提下挤进去的（取代事后消费清单、压掉 `qualityNotices` 里重复的 `note`+`push`、
  命令列表并进标题行、正文折叠）。加全局作用域开关时用户裁定**不为一行数自我设限**，上限因此调到
  当前形状之上（逻辑 604/640、内联数据 152/220）。Host 的 500 行限制不变，仍有牙齿。
- 删除的沙箱代价：插件自己的 `node:fs` 调用不被 confining 后端拦截，所以只读后端是**主动拒绝**。
- `projectKey` 有损：`D:\a-b` 与 `D:\a\b` 共用一个记忆目录——harness 自己的取舍，本插件继承。
