# dsh-memory

按 **Qoder Agent SDK 的记忆契约**为 DeepSeek Harness 实现的持久记忆插件：一个后台 pass 决定什么值得记并将其写进记忆文件，一个有预算的 pass 把记忆装进 Agent 上下文。

| | |
|---|---|
| 版本 | `0.1.0` |
| 包名 | `@dsh-external/dsh-memory` |
| 依据 | 真实 SDK（`@qoder-ai/qoder-agent-sdk@1.0.50`）**＋**安装的 `qodercli` bundle 解码，不是文档推测 |
| 测试 | **332 项全绿**（`node test/*.test.mjs`）：unit 95 / integration 112 / model 41 / client 37 / architecture 14 / agent 19 / package-shape 10 / resolveMeta 4 |
| 依赖 | 仅 `@deepseek-ai/schemastery`（提供真正的 `Config` schema）与 `picomatch`（排除规则；Qoder 自己也是这个库） |
| 设计文档 | [`docs/qoder-memory-model.md`](docs/qoder-memory-model.md)（解出的记忆模型）、[`docs/memory-layers.md`](docs/memory-layers.md)（哪些层归 harness、哪些归本插件） |

---

## 1. 它做什么

与 Qoder 一样，记忆分成**两个可独立配置的半**：

```
生成（generation）  一轮结束后（或开启后：回合进行中）跑一个后台 pass，
                    由模型决定记什么，通过工具写进记忆文件。
消费（consumption） 每一步都重新投影记忆并装进上下文，共享一个 token 预算，
                    且只把「变了的」发出去。
```

- **作用域两个**：`user`（跨项目）与 `project`（每个项目一份）。
- **两侧都在同一个配置根下**：`$DSH_HOME/memory` 与 `$DSH_HOME/projects/<projectKey>/memory`。
  **不会往项目目录里写任何记忆文件**，仓库永远干净。
- **索引 + 内容文件**：`MEMORY.md` 是索引（目录，不是正文），其余 `*.md` 是内容文件。
- **状态词表照抄 Qoder**：整体生成 `saved | partial | no_change | skipped | failed`；
  消费 `success | partial | failed`；每文件 `loaded | missing | failed | truncated | jit_skipped`。

## 2. 安装

```powershell
# 在 Harness 会话里用 plugin_manager 安装，target 指到本仓库的绝对路径：
# action: install_bundle, target: <本仓库路径>
```

装好后需要**一次 `dsh web` 重启**（host 半在进程启动时加载），之后**刷新页面**即可看到面板
（client 半每次加载都会重新取）。之后改代码：host 半仍需重启，client 半只需刷新。

### 依赖与重装

```powershell
npm install            # react / react-dom / react-test-renderer 只给 client 测试用
```

`@deepseek-ai/schemastery` **不在公共 npm 上**（它随 harness 发布），`npm install` 会留下一个指向
早已不存在的 `.pnpm` 树的坏软链。若报 `Cannot find package '@deepseek-ai/schemastery'`，
就从**已安装的 harness** 里按同版本拷一份——harness 的位置由 `npm root -g` 得到，写死路径没有意义：

```powershell
$harness = Join-Path (npm root -g) '@deepseek-ai\dsh\node_modules'
New-Item -ItemType Directory -Force 'node_modules\@deepseek-ai' | Out-Null
foreach ($pkg in 'schemastery', 'cosmokit') {
  Copy-Item "$harness\@deepseek-ai\$pkg" 'node_modules\@deepseek-ai\' -Recurse -Force
}
New-Item -ItemType Directory -Force 'node_modules\@standard-schema' | Out-Null
Copy-Item "$harness\@standard-schema\spec" 'node_modules\@standard-schema\' -Recurse -Force
```

锁文件是 `package-lock.json`。这些包**不进仓库**（见 `.gitignore`）：源码可克隆，
但完整运行需要上面这一步。

## 3. 配置

在 **profile 的** `cordis.patch.yml` 覆盖（不要改插件自带的 patch，升级会被覆盖）：

```yaml
- id: memory
  name: '@dsh-external/dsh-memory'
  config:
    enabled: true
    mode: native              # native | custom
    userScope: true           # $DSH_HOME/memory/
    projectScope: true        # $DSH_HOME/projects/<projectKey>/memory/  （不在仓库里）
    writePolicy: memory-root  # 记忆写入声明的沙箱根；memory-root＝自声明记忆目录，session＝去问当前会话
    projectRootMarkers: []    # 空＝会话 cwd 就是项目（harness 的分组方式）；['.git']＝整个仓库一份记忆
    excludes: []              # gitignore 风格 glob（picomatch），只对项目作用域生效
    #   - '**/*.draft.md'
    imports:                  # 记忆文件里的 @ 引用展开（Qoder 的 ImportProcessor）
      enabled: true
      format: tree            # tree | flat
      maxDepth: 5
      allowExternal: false    # 放行越出允许目录的导入
      approvedProjects: []    # 按项目目录放行：['D:/code/checkout']
    trust:
      enabled: false          # Qoder 的 security.folderTrust.enabled；关＝所有目录都受信任
      folders: []             # 显式信任的目录（绝对路径，或相对会话 cwd）
    generation:
      maxOutputTokens: 0      # 0＝不给回复设上限，用适配器/模型自己的默认值（见下方说明）
      pauseAfterFailures: 3   # 连续失败几次就暂停本会话的生成（Qoder 的 hFl=3）；0＝永不暂停
      maxWrites: 4            # 单轮最多写几个文件（索引也算一个）；超出＝延到下一轮，不是失败；0＝不设上限
      maxWriteBytes: 16384    # 单文件字节上限（写时提示里会写明这个数）；0＝不设上限
      provider: ''            # 留空则用会话自身模型路由
      model: ''
      prompt: ''              # 附加记录策略
      roots: []               # custom 模式下的自定义根
      #   - { id: team, path: D:/knowledge/team, access: read }
      turnComplete:
        enabled: true
        minPromptChars: 40    # 内置闸门：短于此长度不生成
        timeoutMs: 10000
        onGateError: skip     # skip | report_failed
        # shouldGenerate: !!js 'async (input, { signal }) => ({ run: input.prompt.length > 40 })'
      incremental:
        everyTurns: 1         # Qoder 的 extractionEveryNTurns：每 N 轮跑一次生成
        midTurn: false        # true 时长回合中途也生成（Qoder 的实验开关 auto_memory_incremental_generation）
      dream:
        enabled: false        # 巩固 pass（Qoder 的 AutoDream），默认关：它多花一次模型调用
        minHours: 24
      # onResult: !!js '(r) => console.log("memory", r.status)'
    consumption:
      enabled: true
      maxTokens: 2000          # 记忆注入上限（token），必须是正整数；要一个字都不注入就 enabled: false
      overflow: truncate       # truncate（截断到放得下）| fail_query（放不下就报错）
      failureMode: best_effort # best_effort（单个文件读失败也继续）| fail_query（报错）
      # files:                 # custom 模式下替代自动发现
      #   - { id: conventions, path: D:/knowledge/CONVENTIONS.md, required: true }
      # onResult: !!js '(r) => console.log("memory", r.status)'
```

`shouldGenerate` 与 `onResult` 用 YAML 的 `!!js` 表达式传入（Loader 会求值成真正的函数）。

**两个"预算"不要混**：`consumption.maxTokens` 是**注入**预算——每一步最多允许多少 token 的
**记忆文本**进入上下文。它由 `render.js` 执行"宽处略、细处截"：整份放得下就全注入；
放不下就**先整文件丢弃**（按加载顺序），只剩一个时才对它做截断（最多 12 次尝试），
截断的是索引时还会加一条提示。**模型自己的输出**上限是另一个旋钮（`generation.maxOutputTokens`），
两者互不相干；面板的「注入预算」区把两半并排显示，就是为了不再把这两件事搞混。

**上限必须是正整数**：schema 是 `natural().min(1)`、SDK 也要求正整数，所以 `0` 在配置层就被拒绝，
根本到不了渲染层——尽管 `render.js` 确实处理 `maxTokens <= 0`。**要完全不注入就设
`consumption.enabled: false`**。这条以前写错过（旧的面板标签和上面那行 YAML 注释都说"0＝不注入"），
现在两边都改对了，而且那个下限是**一个共享常量**（`CONSUMPTION_MIN_TOKENS`）：schema、`/api/memory/budget`
路由、面板输入框的 `min` 都读它，所以没有任何界面会给出一个插件随后会拒绝的值。

**这个值可以在面板里直接改**（见 §21）。

**`native` 与 `custom` 的差别**照 SDK 的规则：`native` 下运行时决定记什么、存哪里、何时加载，
且**拒绝** `generation.*` / `consumption.*` 的覆盖；`custom` 只覆盖你显式给出的部分。

**与 harness 文件沙箱的关系（`writePolicy`）**：记忆按契约放在 `$DSH_HOME` 下，也就是**永远在会话
工作区之外**。harness 的沙箱后端（`dsh-fs-sandbox` + `dsh-sandbox-policy`）按**策略**给"变更"上围栏：

- `read-only` 拒绝一切写入；`workspace-write` 只允许**规范化后落在工作区内**（或平台临时目录）的目标；
  `danger-full-access` 不设围栏。
- **读不受限**（"the mutation fence does not restrict observation"）——所以记忆**一直能加载**，
  只有写入会失败，报的就是 `file access denied under workspace-write mode`。
- `writeText`/`editText` 的第 5 个参数是"本次调用的 mode + workspaceRoot"。**省略它并不等于"跟随会话"**：
  后端只做 `sandboxPolicy ?? ctx.sandboxPolicy.resolve()`，而不带会话的 `resolve()` 回的是**部署默认值**
  （本部署 `mode: workspace-write`，根是 harness 自己的工作目录）——它**不会自己去找会话**。所以"会话已经
  是**完全权限**，写记忆却仍被 `workspace-write` 拒绝"是必然的：那次调用**从没问过会话**。要问会话就得像
  harness 自己的工具那样显式传会话（`resolve(exec.agent === undefined ? {} : { session: exec.agent.session })`）。

因此本插件默认 `writePolicy: memory-root`：**记忆与它自己的存储（信任库、巩固锁与状态）在写入时
声明自己的目录作为沙箱根**，写仍被插件自己的路径校验限在作用域内，但在 `workspace-write` 会话下
照常可用。设成 `session` 则**真的去问当前会话**：受限模式下记忆变成**只读**，面板与 `/memory` 会明说
（`session` 时删除也不再走 `node:fs` 绕过围栏，而是按会话模式直接拒绝）；没有会话可问的定时任务退到
部署默认值。两者不一致时面板那一行显示两段模式——`memory-root · workspace-write · session read-only`
——两个数字分开显示，才不会把"完全权限的会话"看成"被围栏的会话"。

**关于 `maxOutputTokens`**：SDK 的 `SerializableMemoryGenerationOptions` 里**没有这个字段**
（只有 `enabled` / `roots` / `prompt` / `turnComplete`），所以它是本插件自己的旋钮，
`maxWrites` / `maxWriteBytes` 同理。三者都遵循同一个约定：**0＝不设上限**。`maxOutputTokens`
默认 0，让适配器套用模型自己的默认值——这是唯一对所有模型都成立的选择：pass 是**用工具调用写
文件**的，文件正文就在工具参数里，固定小上限会让推理模型在吐出工具调用之前就撞上上限（本插件
第一版抄了 Qoder `summarizer-*` 任务类型的 `2e3`，那适用于摘要，不适用于写作）。要控成本就显式
设一个值；上限撞上且那一轮没有可用的工具调用时，pass 会失败并**在原因里说清**
（`generation reached maxOutputTokens…`）；若撞上但工具调用已经完整，那些写入**照常落地**再结束循环。

**单轮写入预算**（`maxWrites` / `maxWriteBytes`）是插件自己的**防跑飞**上限——Qoder 的 SDK 与
qodercli 都没有这个字段，所以它更要说清楚，否则就成了陷阱：第一版**既没在提示里写明，又把撞线
记成失败**，于是"一轮写了 4 个、第 5 个被拦"在面板上显示成
`写入被拒 status.md：at most 4 files may be written per pass`——一轮已经干完的 pass 看起来是坏的。
现在两半都补齐：**提示里写明预算**（含"索引也算一个"），**超出的写入记为 deferred 而不是失败**
（`deferredFiles`，状态仍是 `saved`，模型会收到"未被尝试：本轮预算已用完，下一轮从索引继续"），
`/memory` 用 `deferred:` 单列一行。所以把 `maxWrites` 设小只会让记忆分几轮写完，不会制造"失败"。

### 环境变量覆写

Qoder 用「品牌前缀 + 名字」拼环境变量（`Pr(name) => `${prefix}${name}``），布尔词汇是
`1/true/yes/on` 与 `0/false/no/off`（去空格、忽略大小写），其他值当**未设置**。本插件沿用同一套词汇，前缀换 `DSH_`：

| 变量 | 作用 |
|---|---|
| `DSH_MEMORY_HEADLESS=false` | 整体关闭记忆 |
| `DSH_MEMORY_PROJECT` / `DSH_MEMORY_USER` | 覆写两个作用域开关 |
| `DSH_MEMORY_DREAM` | 覆写巩固 pass 开关 |

**环境变量优先于配置**，且只有这四个开关能从环境进来。

## 4. 用法

### 模型侧工具（记忆 pass 内部）

`memory_list` / `memory_read` / `memory_search` / **`memory_write`** / **`memory_delete`**——
全部限定在作用域根内，最多 8 轮（`MAX_AGENT_ROUNDS`）。**只有 `memory_search` 与 Qoder 同名**；
Qoder 的 `memory` / `memory_get` 在本插件叫 `memory_list` / `memory_read`，提示词里对此有明确说明。

### 人类工具 `memory`

| 参数 | 值 |
|---|---|
| `action` | `list` \| `read` \| `search` \| `write` \| `delete` |
| `scope` | `user` \| `project`（默认 project；`search` 忽略它，搜全部作用域） |
| `path` | 作用域根内的相对 `.md` 路径（`../escape.md`、`NOTES.txt` 都被拒绝） |
| `content` | `write` 时的完整文件内容 |

### 命令

| 命令 | 作用 |
|---|---|
| `/memory` | 状态：作用域、信任判定、最近一次生成/消费、变更与告警明细 |
| `/memory-switch [auto\|project\|off\|status]` | **会话级**记忆模式（见 §20）：跟随全局 / 仅项目 / 关闭 |
| `/memory-scope [status\|all\|project\|user]` | **全局**作用域（见 §20）：每个 `auto` 会话跟随的那一层 |
| `/memory-budget [status\|<tokens>]` | **注入上限**（见 §21）：面板里也能改，两边同一个写入器 |
| `/memory-trust [allow\|deny\|list] [folder]` | 目录信任（写入 `<DSH_HOME>/trusted-folders.json`） |
| `/memory-imports [status\|allow\|deny]` | **会话级**外部导入授权（授权后立即重新加载） |
| `/memory-delete <scope>:<path>` | 删除一个记忆文件 |
| `/memory-refresh` | 重新加载记忆（外部编辑后手工拉取） |
| `/memory-resume` | 清除「连续失败暂停」（Qoder 没有恢复路径，这是本插件补的唯一出口） |
| `/memory-flush` | 等后台写入落盘 |

### 设置面板

状态行（插件/模式/生成/消费/**全局作用域**/巩固/闸门/**信任＋授权按钮**/在飞任务）· **作用域区**：
`user` 加**每个有记忆的项目**，**一行一个作用域**，标题写**工作区名字**（如 `EasyGit`，来自
`workspaceRegistry`；查不到工作区的项目回退成 `projectKey` 目录名，`user` 作用域本来就没有工作区），
鼠标悬停显示它被寻址的 slug；每行还有「N 个记忆文件」+ 占用大小（宿主没给就**整段省略**，
不显示 `undefined`、也不用横线占位），文件折叠在行下（`<details>`），展开后每个文件有**打开/删除**；
**注入预算区**（注入上限**可直接编辑**，见 §21）· **注入预览** · 活动区（最近生成/巩固 + 告警）·
编辑器（作用域下拉 + 文件名 + 保存/重载/等待）· 命令提示。中英双语，全部用真实 `--dsw-*` 主题 token。

**注入预览**（§9 补）回答的是"我的记忆到底进没进上下文"，而且给的是**下一步的判定**而不是事后清单：
点一下「预览」，Host 把真实消费跑一遍再**丢掉结果**，返回四件事——`step.action`
（`silent` 什么都不注入 / `snapshot` 全量 / `delta` 只发变动 / `none`）、原因、本步 token、
以及新会话会收到的**完整块正文**（默认折叠在 `<details>` 里）。绝大多数步是 `silent`，
所以只给"完整块"会教出相反的直觉。

**它绝不改变它描述的行为**：不记 `lastConsumption`、不触发 `consumption.onResult`、用一次性的版本
缓存、**只读不写**那个会话的注入基准。最后一条是硬要求——预览若推进了基准，下一步就会判定"未变"
而什么都不发，等于看一眼面板就把注入关掉了。`test/integration.test.mjs` 里
「previewMemory describes the next step without changing it」钉住这条，并且**已验证：把写基准加回去，
该测试立刻以 `the preview must not have consumed the snapshot` 失败**。
预览是**按需**的 `GET /api/memory/preview`，不挂在 5 秒一次的 status 轮询上（那会每 5 秒重读整个记忆块）。

两个做不到的地方，如实标注：harness 的 `FsInfo` 只有 `version/type/size`、**没有修改时间**，
所以显示的是**占用大小**而不是"更新于某时"；harness 也**没有"在文件管理器里打开"的能力**
（曾实现过 `POST /api/memory/reveal` + `subprocess` 打开器，在本机点不开，已按用户要求撤掉）。

## 5. 与 Qoder 的契约映射

| Qoder | 本插件 |
|---|---|
| 生成半 / 消费半 | 同构，两个可独立开关的配置块 |
| 作用域 `user` / `project` | `$DSH_HOME/memory` / `$DSH_HOME/projects/<projectKey>/memory` |
| `MEMORY.md` 索引 + 内容文件（`type` 四类） | 同构；非法 `type` 回落 `project` |
| `isTrustedFolder()` | `trust.enabled` + `trust.folders` + `<DSH_HOME>/trusted-folders.json` |
| 排除规则（picomatch） | 同库同选项，**只作用于项目作用域**（与 Qoder 一致，全局不被过滤） |
| 大文件策略（`4e4` 字符） | 报告但**仍然加载**（与 Qoder 一致），面板与 `/memory` 都提示 |
| `@` 导入（`ImportProcessor`） | 同语法/标记/`tree`·`flat`/`maxDepth: 5`；授权=配置 ∨ 项目 ∨ **会话** |
| 每次请求重建记忆块 | `agent/pre-step` 每步重投影 + 哈希；**未变则静默探测，变了才发增量** |
| `extractionEveryNTurns` 间隔门 | `generation.incremental.everyTurns`（含两种 bypass，见 §12） |
| `MOl` 增量转录游标 | `collectTranscript(session, sinceSeq)`（游标只在 pass 真跑过后推进） |
| `path_glob_match`（just-in-time） | front-matter `paths` ⇒ 只有当会话触及匹配路径才加载 |
| `AutoDream`（时间闸门 + 锁） | `generation.dream` + `<DSH_HOME>/.consolidate-lock`（Qoder 的文件名与一小时窗口） |
| 删除记忆 | 模型工具 / `memory` 工具 / `/memory-delete` / 面板删除按钮（见 §13） |
| `MEMORY_HEADLESS` 等环境变量 | `DSH_MEMORY_*`，同一套布尔词汇，环境优先 |

## 6. 记忆的真实结构

```
$DSH_HOME/memory/MEMORY.md                      user 作用域索引
$DSH_HOME/memory/<topic>.md                     user 作用域内容
$DSH_HOME/projects/<projectKey>/memory/...      project 作用域（同一套结构）
<DSH_HOME>/trusted-folders.json                 信任判定（不是记忆，不会被注入）
<DSH_HOME>/.consolidate-lock                    巩固锁（不是记忆）
```

内容文件的 front-matter：`name` / `description` / `type`（`user | feedback | project | reference`）。
目录过滤：`.md`、排除索引本身、排除 `.` 开头。**子目录不算记忆**（平铺文件集，有测试钉住）。

## 7. 项目工作区身份：按 Harness，不按 Qoder

DSH 用三种不同方式定义"项目"，本插件只借用其中一种：

| 概念 | 归属 | 本插件怎么用 |
|---|---|---|
| Workspace 记录（uuid + canonical path，`ctx.workspaceRegistry`） | harness | 读它拿真实路径与标题（`resolveWorkspace`），没有就退回规范化路径 |
| `projectKey` 目录名（`--D-code-demo--` 形如 `projectKey('D:\code\demo')`） | harness 的 session-persistence | **就是**项目记忆目录名，和 sessions 分组一致 |
| `.git` marker 向上查找 | `dsh-agent-instructions` | 只在 `projectRootMarkers` 显式配置时用于划分记忆根 |

`projectKey` 是**有损**的：`-` 与路径分隔符不可区分（`D:\a-b` 与 `D:\a\b` 同名），
非 ASCII 或空格会变成 `~XXXX` 转义（所以**无法从目录名反推路径**），251 字符处截断且不加 hash。
**本插件照抄这种有损**，好处是与 harness 自己的 `sessions/` 目录一一对应，用户能对着文件系统读。
测试用**正向**方向钉住它：读每个 session 头部记录的 `cwd`，重新算出目录名，必须与 harness 建的目录同名。

## 8. 目录信任门

Qoder 的判定逐字解出：`isTrustedFolder(){return !this.folderTrust || (this.trustedFolder ?? false)}`——
**默认关（全部信任）**，打开后只有信任的目录能贡献项目记忆。本插件：

- **只在消费/写入路径用同一个门**（`resolveEffectiveRoots`），未信任 ⇒ 项目根**整个消失**，
  而不是"加载了但不注入"。
- 面板的信任判定与授权按钮作用于**活动会话所在目录**（`ctx.get('agents')?.currentInitiator?.()`），
  不是宿主进程 cwd——否则你会对着 harness home 授权。
- 变化立即生效：记忆每步重投影，所以下一个请求就看到新决定（Qoder 的 `setTrustedFolder` 也是立即刷新）。

## 9. 消费发现管线

不是"列 `.md` + 裁剪"。解出的加载器签名是
`KNi(cwd, includeDirectories, fileService, isTrustedFolder, filenames, importFormat, fileFilteringOptions, discoveryMaxDirs, boundaryMarkers, scope, agentsMdExcludes)`，
返回 `{ memoryContent, fileCount, filePaths, largeFiles, failedFiles }` 并发出 `memory-changed`。已实现三件事：

1. **排除**：picomatch 匹配**规范化 + realpath** 两种路径形态，只对项目作用域生效。
2. **大文件**：超过 40 000 字符**标记但仍然加载**（Qoder 是 `{path, characterCount}` 报告，不丢弃）。
3. **失败可见**：读不了的文件进 `failedFiles`，结果绝不谎报成功。

**每步重投影**（`agent/pre-step`）：每一步重算整个块并逐文件哈希。
- **未变 ⇒ 静默**：不注入、`onResult` 不触发（否则每步都会惊动调用方）。
- **变了 ⇒ 增量**：只发哈希变动的文件（`form: 'notice'`，带 `Removed:` 行），**从不发快照**。
- **续接可用**：`blockHash` 与逐文件哈希挂在消息 `source` 上，新进程从落盘消息恢复比较基准。

**`sections` 里放的是模型读到的正文，不是占位符**（`form: 'snapshot'` 时）。这不是可选的美化：
Trajectory 视图不读 `sections`（它渲染 `inputDetail`，也就是整段正文），但 **Chat 视图的
`snapshot` 形态只渲染 `sections`、完全不渲染 `content`**——`text` 若是空串，那一行在 Chat 里就只剩
「此快照取代先前快照」加一串文件名，**模型读到 4000 多字符、读者看到 0**，注入恰好在最该能核对的地方
失去可审计性。宿主自己的生产者都成对写入（`time-context` 的 invariant 甚至断言 `section.text` 必须
等于模型读到的字节），本插件原先只写空串是错的。

代价是这份文本在落盘消息里存两份（`content` 给模型、`sections` 给渲染）。按本机真实日志实测：203 次
snapshot 注入、内容合计 88 万字符，占 171 MB 压缩日志的 **0.49%**（未压缩），且重复内容 zstd 之后
几乎不增加体积；单次上限仍受同一个 `consumption.maxTokens` 约束。

## 10. `@` 导入

语法（逐字）：`@./x.md`、`@../x.md`、`@~/x.md`、`@/abs.md`、`@x.md`（带扩展名）；
`` `@...` `` 这类**提及**不算导入；**代码围栏里的 `@` 跳过**（`/(`+)([\s\S]*?)\1/g`）。
展开标记逐字：`<!-- Imported from: X -->` … `<!-- End of import from: X -->`、
`<!-- File already processed: X -->`、`<!-- Import blocked: X - outside project root -->`、
`<!-- Import failed: X - reason -->`；`flat` 格式是 `--- File: path ---` / `--- End of File: path ---`。
`maxDepth: 5`，**URL 永不跟随**。允许目录＝该文件所属记忆根 ＋ 受信任的项目目录（Qoder 用 `[projectRoot]`，此处更严）。

## 11. 按需加载（Qoder 的 `jitMemory`）

内容文件可以在 front-matter 声明 glob，于是**只在相关时才进入上下文**：

```markdown
---
type: project
paths: ["src/**/*.ts"]
---

只有写 TypeScript 时才需要知道的约定……
```

| 声明 | 行为 |
|---|---|
| 什么都不写 | `always_on`——**与以前完全一样** |
| `paths: [...]`（或 `globs:`） | `glob`：只有会话**触及**匹配路径才加载 |
| `trigger: false` | `manual`：永不自动加载，但索引指针仍在、工具仍可读 |

匹配用 `picomatch`（与排除规则同库同选项），"触及"取自 `session.deriveMessages()` 且**只认像路径的 token**
（散文不会误触发）。被跳过的文件报 `jit_skipped`，面板会说明原因。

## 12. 生成：串行、间隔、回合内、游标、失败暂停

- **串行**：一个会话同时只有一个 pass；pass 期间完成的回合**合并成一次**跟进
  （不是并发跑，也不是每轮各跑一次）。这是修过的真实缺陷：并发 pass 会互相覆盖索引。
- **间隔**：`generation.incremental.everyTurns`（默认 1），逐轮累加、跑过归零。
  两种 bypass 取自原实现：操作者提供了 `shouldGenerate`；以及**合并后的那次跟进**。
- **回合内**：`midTurn: true` 时在 `agent/pre-step` 再加一个触发点——**长回合中途也能记**。
  没有新消息的步骤什么都不做，所以它是廉价的。
- **转录游标**：`collectTranscript(session, sinceSeq)` 只取上次之后的消息，**只有 pass 真跑了才推进**；
  游标找不到就退回全量（丢历史比重复送更糟）。间隔 > 1 时它保证被跳过的几轮不丢。
- **连续失败暂停**（Qoder 的 `hFl = 3`）：原实现按 sink 累计连续失败，到阈值 `paused = true`，
  之后 `onTurnComplete` 只记一行 `"skipped because service is paused"` 就返回、**不再发起模型调用**；
  任何一次成功的提取把计数归零。本插件照此实现：只把 `failed` 算作失败（`skipped`/`no_change`/`partial`
  都算成功并清零），到 `generation.pauseAfterFailures`（默认 3；0＝永不暂停）后本会话的 pass
  直接记一条 `skipped`，原因写明暂停及其成因（`paused after 3 consecutive failures: …`），
  面板与 `/memory` 都显示。**唯一补充**：原实现没有恢复路径（`paused` 一置就持续到进程结束），
  而 DSH 会话活得更久，所以补了 `/memory-resume` 这一个显式出口。

## 13. 删除记忆

harness 的 `fs` 服务**确实没有 delete**（`FileSystem` 抽象类只有 `resolve`/`stat`/`readText`/`listDir`/
`writeText`/`editText`/`watch`）。但它提供了做对删除所需的那条缝——`processPath(target)`，
文档原话是 "the canonical absolute path a subprocess in this filesystem's execution world can open"。
`deleteGuarded` 按这个顺序：

1. `resolve` + `stat` 走 provider，并校验 `expectedVersion`——**只删调用方看过的那个版本**；
2. provider 自己有 `remove` 就用它（此时什么都绕不过）；
3. 否则用 provider 自己给的 `processPath` 去 `unlink`——**不是绕过 provider，而是问它要路径**；
4. 声明 `sandboxMode === 'read-only'` 的后端**直接拒绝**，不偷偷违反。

允许范围与写入**完全同一套**：已知 root、`read-write`、根内相对 `.md`；拒绝会记入 `failedFiles`。
**四个入口**：模型工具 `memory_delete`、人类工具 `action: "delete"`、`/memory-delete <scope>:<path>`、
面板每个文件行的删除按钮（只读作用域不显示）。

**如实说明的代价**：插件自己发起的 `node:fs` 调用**不经过**某个 confining 后端的拦截（插件不在那个拦截里运行），
所以只读后端是**主动拒绝**而不是被强制。

## 14. 提示词：Qoder 的原文与标注

`lib/memory-prompt.js` 是唯一来源，逐段标注来源：

- `── qodercli verbatim` = 解出的原句；
- `── port` = 解不出的片段（有的从句子中间开始）或本插件补的连接语。

**解不出就标出来，绝不为了让句子通顺而自己填**。两处确认解不出并就地声明：
索引行数上限（`⟨lines⟩`——它是**运行时插值的 JS 常量**，字符串表里没有）与
"…under about 25KB" 那句缺失的开头从句。模型测试逐句断言原文**并且**断言这两处标注还在，改写会失败。

## 15. 结构、分层与体积预算

一个包，两个半：host `lib/*.js`（26 个模块）＋ `lib/client.js`（设置面板，浏览器产物只能一个文件）。

```
0 constants
1 config · tokens · fs · paths · memory-file
2 render · memory-pass · memory-prompt · memory-search · imports · excludes · trust · jit · transcript · failure-pause
3 memory-agent · consumption-plan
4 consumption · generation · dream
5 service · tools · routes · commands
6 index
```

只许向下、无环，且**只有 `index.js`** 可以引用 presentation 层——`test/architecture.test.mjs` 强制。
体积：host 模块逻辑 ≤500 行；`client.js` ≤560 逻辑 **且** ≤220 行内联数据（两份词典 + 样式表）；
`index.js` ≤300。**当前 `client.js` 逻辑 560/560（正好用满）、内联数据 122/220**，所以下次动面板
**必须先腾地方，不抬上限**——注入上限这个可编辑控件就是这样加进来的：它把 `ScopeCard`、编辑器工具条等
几处 `h(...)` 的换行排版压紧（结构不变、行为不变），**没有动上限一个字**。
更早的注入预览也是同样做法：它取代了「最近一次消费」那行事后清单，压缩了 `qualityNotices` 里重复的
`note`+`push`，把命令列表从独立一节并进标题行，正文用 `<details>` 折叠。

`consumption-plan.js` 单独存在是有原因的：面板要能回答「下一步会注入什么」而**不真的回答它**。
决策被写成纯函数（`baselineFor` / `planInjection`），两个调用方只差一件事——真实投影**应用并记录**
结果，面板预览**只读不写**。每个会话的注入基准也放在这里（`readConsumptionState` / `writeConsumptionState`），
读写分开就是那道闸：只有真实投影会写。

## 16. 测试与验证

```powershell
node test/unit.test.mjs          # 纯函数
node test/integration.test.mjs    # 用 fs/llm/listeners 替身跑整条链路
node test/memory-model.test.mjs   # 逐句断言提示词原文 + 真实的 projectKey 对照
node test/memory-agent.test.mjs   # 工具循环
node test/client.test.mjs         # 面板（React 渲染 + 样式表断言）
node test/architecture.test.mjs   # 分层、体积、路由字面量一致
node test/discovery.test.mjs      # 版本冻结、包形状
node test/resolve-meta.test.mjs   # meta 与 locale 一致
node test/harness-env.mjs         # 不是测试：定位 harness 与安装位置的公共助手
```

**环境相关的东西一律自动发现，不写死路径。** harness 会把 `DSH_HOME` / `DSH_PROFILE_DIR`
导进每个会话，`test/harness-env.mjs` 用它定位已安装的 harness 与本插件；找不到时，
那几条**依赖安装或会话存储**的检查会自己报 `--  (skipped: …)` 而不是失败（也不假装通过），
所以纯克隆的仓库仍能跑其余全部检查，只是总数比上面的 317 少几条。

方法上的三条硬规矩：

1. **改完必跑全套**，没有跑过不说绿。
2. **证明回退会红**：把修复去掉，指出哪条测试失败（CHANGELOG 的 §验证 列了每一项）。
3. **样式类 bug 用样式断言**：这类问题行为测试看不见，所以直接断言 CSS 并检查渲染出的 DOM。

辅助工具：`test/preview.mjs` 渲染面板预览（`PREVIEW_THEME` / `PREVIEW_LOCALE` 分别钉主题与语言），
`test/shots.mjs` 截图（截完会删掉 `preview.html`），
`test/inspect-qodercli.mjs --strings <filter>` / `--find <regex>` 解码 `qodercli` bundle
（XOR key `h74YFijkSnty`；**代码标识符没有混淆**，所以 `--find` 能直接定位类名/函数名）。

## 17. 明确不做（含理由）

| 不做 | 理由 |
|---|---|
| **AGENTS.md 层** | Qoder 的 `globalMemory`/`projectMemory`/`localMemory`/`pluginMemory` 四个桶的原料是 `getAllQoderMdFilenames()`，即**指令文件族**；在 DSH 那由 `dsh-agent-instructions` 负责。照搬会**同一份文件每次请求注入两遍**。 |
| **skills 记忆目录** | 技能是 harness 的一等子系统（`ctx.skills`）；Qoder 的 `getProjectSkillsMemoryDir()` 在整个 bundle 里**只有定义、没有调用点**，没有行为可对齐。 |
| **daily journal** | QoderWork 桌面版的工具面（`action: "add", target: "daily"`），不是 SDK 记忆契约。 |
| **旧数据迁移** | 明确决定：不做任何兼容层。改身份前的旧目录既不读也不删；要留内容就**手工复制**过去（一次性操作，不是插件逻辑）。 |
| `usage` / `credits` / `requester: 'sdk'` | 辅助调用不回报计费。 |
| `origin: 'main_session'` | 命名差异：轮内 pass 报 `turn_complete` + `midTurn: true`。 |

## 18. 已知限制

- **两处提示词片段解不出**（见 §14），已就地声明而不是编造。
- **索引约束只报告不阻止**：写入时检查"约 25KB"与"单行超过约 200 字符"会写进结果、日志与面板，但**不拒绝**——原实现也只在提示词里说。
- **面板逻辑行已用满**（§15）：`client.js` 逻辑 560/560，再加东西得先腾地方——**不抬上限**。
- **只有注入上限能在面板里改**（§21）：其余配置直接改插件配置或用命令；这是刻意的取舍。
- **删除的沙箱代价**（§13）：只读后端是主动拒绝，而不是被后端强制拦截。
- **`projectKey` 有损**（§7）：`D:\a-b` 与 `D:\a\b` 共用一个记忆目录——这是 harness 自己的取舍，本插件继承它。

## 19. 与 harness 版本的兼容

**已核对：桌面版 harness `0.2.0-rc.2`**（以及 profile 解析到的 `0.1.7-rc.2`）。核对方式是**问正在运行的
宿主本身**，而不是只看自己写的替身：

| 依赖 | 怎么核对的 | 结论 |
|---|---|---|
| `fs`（含 `processPath`，删除靠它） | 宿主 Inspect 的 `Service.listService('fs')` | 方法齐全，签名未变 |
| `llm.stream` 的入参 | `Service.listService('llm')` 的 `GenerateOptions` | 我们发的是合法的 `RequestUserInput`（`{role:'user',content:[…]}`）、`maxTokens?` 可省、**没有**发那个闭合联合 `purpose` |
| 流式分片 | `StreamChunk` 联合 | 新分片（`usage`、`reasoning-delta`）被我们静默忽略，不会抛 |
| 结束原因 | `FinishReasonMap` | 与我们的处理一一对应（stop / tool-calls / max-tokens / aborted / error） |
| 工具调用回填 | `ToolSchema` / `ToolResultMessage` | 我们的 `parameters`、`source.kind:'tool'`、`toolCallId`、`isError` 全部吻合 |
| 会话与触发点 | `Event.listEvents('session/event')` 的 `SessionEventMap` | `turn/end`（`{turn, reason}`）与 `Session.header/requestHeader/snapshotEvents/deriveMessages` 未变；`EpochHeader.config` 仍是我们在 `resolveRoute` 里读的形状 |
| 计量 | `tokenMeter.estimateMessage` | 仍在（我们本就带本地启发式兜底） |
| 面板挂载 | 客户端 `Slots.listSubTree('settings.section')` | 占用者 `{ registrant: 'memory-ui', id: 'memory', order: 60, active: true }` |
| 主题 token | 面板用到的 **20 个 `--dsw-*` 全在**运行版的 bundle 里（有测试对着它跑） | 无失效 token |

**升级后怎么重新核对**：跑 `node test/*.test.mjs`（那条 token 检查会打印它用的 oracle），
再问一次上面几个 Inspect 查询即可——`Settings → Memory` 面板本身也是活体证据。

**一个真实的坑**：桌面版把 harness 打包进**一个 `app.asar`**，而 profile 的 Node 解析可能仍指向
**更旧的 npm 安装**（本机就是 `0.1.7-rc.2` 对 `0.2.0-rc.2`）。于是"测试全绿"可能验的是旧版本——
这正是升级能被漏掉的方式。`test/harness-env.mjs` 因此优先找**正在运行**的那份
（可用 `DSH_HARNESS_BUNDLE` 显式指定），找不到就跳过并说明。

## 20. 两级开关：全局作用域与会话模式

**为什么要有全局那层**：记忆是每台机器一套配置。有些会话不该被记忆影响——一次性的试验、排障、或一段不想
留下痕迹的对话；也有些会话只想要**本仓库**的约定，不想要别的项目攒下来的经验。所以是**两级**：

| 层级 | 怎么改 | 作用 |
|---|---|---|
| **全局** | `/memory-scope all\|project\|user`，或插件配置里的 `userScope`/`projectScope` | 所有 `auto` 会话跟随的作用域 |
| **会话** | 对话页输入框里的**记忆按钮**（一次点击循环三态），或 `/memory-switch auto\|project\|off` | 只影响这一个会话 |

会话三态：`auto` **跟随全局**（默认，什么都不存）· `project` **仅项目**（不加载也不写入跨项目知识）·
`off` **关闭**（两半一起停）。

**为什么会话控件在对话页而不是设置页**：因为它是**按会话**的，而设置页是全局的。关键事实是
`conversation.input.left` 这个槽位**把 `sessionId` 当标准 prop 交给控件**——所以那个按钮知道自己在哪个会话里，
一次点击写的就是它自己。设置页没有这个信息，之前只能在面板上**枚举所有活会话**再指名切换（那段代码已随
按钮一起删掉）。

**路由仍然拿不到"当前会话"**：HTTP 请求路径上**没有任何地方建立 initiator 边界**
（`withInitiator` 全仓库只有 agent loop 的 `kick()` 用），所以 `GET/POST /api/memory/switch` 的
`session` 字段是必需的，指到不存在的 id **明确拒绝**（409），而不是悄悄回退到"碰巧在跑的那个会话"。
`/memory-switch` 命令能省略会话，因为它有 initiator。

**`off` 关掉后该会话**：
- **不注入**任何记忆（`agent/pre-step` 在跑消费之前就问开关，所以**一个记忆文件都不会读**）；
- **不记录**（`turn/end` 的后台 pass、轮内 pass、以及 dream 全部跳过）；
- **已排队**的记忆消息会被**移除**——切换前注入的那条如果留着，就是躺在读者自己队列里的一句谎话；
- **写入被拒**（`memory` 工具的 `write`/`delete` 报出原因），但**读取照旧**：问记忆一个问题，不等于让记忆影响这个会话；
- **`/memory-refresh` 明说原因**，而不是伪装成"没有东西可注入"——这两种情况的解法不同，只有一种是 bug。

**`project` 不是静音的一半，是作用域收窄**：该会话照常读、照常写，只是把 `user` 作用域整个摘掉。实现上它**只
做一件事**——把会话的选择折进配置本来就有的 `userScope`/`projectScope` 开关（`scopedConfig`），于是 roots、
信任门、身份哈希、生成提示词看到的是**同一个画面**，没有第二套需要同步的代码路径。工具、预览、刷新、生成
四处都过这一层，所以"仅项目"的会话**不会**经由 `memory` 工具偷偷往 user 作用域写。

**开关存在哪，是被 harness 逼出来的选择**：

| 载体 | 能不能用 | 原因 |
|---|---|---|
| 会话日志（`session.append`） | **不能** | 插件事件不在 harness 自己的类型表里，落盘时 `data` 会被丢掉，读取端随后**拒收整个日志**（`session event "…" at seq N has an invalid event envelope`），直接卡住会话重开。逃生舱是信封上的 `ignorable` 标记，而**只有 harness 自己**会设它。 |
| `<DSH_HOME>/memory-off-sessions.json` | **用它** | 和 `trusted-folders.json`、`dream-state.json` 同一类东西：**关于会话的插件状态**，不是记忆，永不注入。它在所有记忆根之外，而且是 `.json`（根目录只收 `*.md`），所以也不会被当成内容读进来。 |
| 只放内存 | 不够 | 重启后选择就丢了；而"选择被遗忘"必须好过"记忆在没人知道的情况下到处都不出声"。 |

**存的是"偏离"，不是"许可"**：`auto` **根本不写进文件**，文件里只有被改成 `project`/`off` 的会话。丢了、坏了、
从来没有过 ⇒ 一切照常跟随配置。失败方向因此是"选择被忘了"，而不是"记忆到处都不出声且没人看得出为什么"。
这也让**配置改动能继续影响**那些没被显式钉住的会话。

**按会话 id 记，所以**：续接（resume）保留 id ⇒ 选择跟着走；子代理有**自己的** id ⇒ 不会继承父会话的选择
（继承了就等于让一次委派静悄悄地不留记忆）。

**旧格式能读**：v1 是一个 id 数组（全部表示 `off`）。三行兼容代码，换来的是**升级不会把某人关掉的会话悄悄打开**。

**`auto` 必须能说出它跟随的是什么**：所以按钮的 `title` 会写明全局那层（"全局：用户 + 项目"），面板的状态区
也有一行**全局作用域**。四种组合都如实报告（`all`/`project`/`user`/`none`）——把 `userScope: true,
projectScope: false` 说成 `all` 就是把话说反了（这条有测试钉住）。

**离开 `off` 不会自己重新注入**：下一步会发现块没变而保持沉默——这是对的，但看起来像什么都没发生，
所以命令会直说，并指出 `/memory-refresh` 可以强制拉一次。

**顺带修掉的一个真 bug**：`GET /api/memory/preview` 把**会话**传给了 `previewMemory(agent)`，于是
`target.session` 是 `undefined`、`visibleMemoryState(undefined, …)` 抛
`Cannot read properties of undefined (reading 'surface')`，被路由的 catch 收成 **HTTP 500**——只要会话在
作用域内，面板的"注入预览"就是坏的。之所以一直没被发现，是因为面板的渲染夹具**喂的是写死的 payload**，
从来没有真的走过那条路由（现在有一条集成测试真的调它）。

**全局那层怎么写的**：插件改自己的配置走 harness 的 **`configEditor.edit`**（校验、落盘、按正常 Loader 路径
reconcile）。没有它（headless 组合）时 `/memory-scope` 会**说明**当前值并指出去配置里改，而不是假装改成功了。

## 21. 在面板里改注入上限（`POST /api/memory/budget`、`/memory-budget`）

**这是唯一一项可在面板里改的配置**，因为它是最常需要调的那一个：上下文紧张就调小，记忆总被截断就调大。
面板的「注入预算」区里它是一个数字输入框 + 保存按钮（不是"每敲一下就存"——那样在输入 `1500` 的过程中
会先把 `1` 写进去），旁边写着当前值和这条提示：

> 允许进入上下文的记忆上限。要完全不注入请关掉消费开关——0 不是合法的上限。

**为什么不能用 0 表示"不注入"**：schema 是 `natural().min(1)`、SDK 也要求正整数，`0` 在配置层就被拒绝，
到不了渲染层。所以"完全不注入"的正确表达是 `consumption.enabled: false`，提示就照这么说。
那个下限是**一个共享常量** `CONSUMPTION_MIN_TOKENS`：schema、路由、面板输入框的 `min` 都读它
（面板拿不到 Host 模块，所以这个值随 `/status` 的 `minTokens` 下发），因此没有任何界面会给出一个插件
随后会拒绝的值。

**路由只做三件事**，每一件都有测试：

1. **强制转换**：表单发的是字符串，所以整数要么是 number、要么是纯数字串。**不猜**——`Number('')` 是 0、
   `Number(true)` 是 1、`'1e3'` 和 `'0x10'` 也都能被 `Number` 接受，这些正是"配置被悄悄改掉"的来源。
2. **查下限**：低于 `CONSUMPTION_MIN_TOKENS` 一律 400，并在原因里说清怎么才算"不注入"。
3. **写入**：走 `config-write.js` 的 `writeConfig`，即 harness 的 `configEditor.edit`，并且**深合并**——
   `edit` 收到的是用户写下的原始配置，整体替换会悄悄丢掉面板不管的每一项。没有 `configEditor` 的组合
   （headless / ACP / SDK）返回 **501**：请求没问题、值也合法，是**这个组合写不了配置**。

**为什么不做成一整页可编辑设置**：试过，29 项，然后删掉了——一个把插件每个旋钮都摊开的面板，比一个
把最常改的那一项做好的面板更难用。要改别的仍然可以直接改插件配置或问 `/memory`。

**`/memory-budget` 命令**做同样的事（`/memory-budget 1500`、`/memory-budget status`），并且复用同一个
写入器，所以命令和面板不可能给出不同的规则。


