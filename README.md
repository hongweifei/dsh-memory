# dsh-memory

按 **Qoder Agent SDK 的记忆契约**为 DeepSeek Harness 实现的持久记忆插件：后台 pass 决定什么值得记、
把它写进记忆文件；每一步再把记忆按 token 预算装进上下文，并且只发「变了的」那部分。

| | |
|---|---|
| 版本 | `0.1.0`（**冻结**：做对齐本身不发布新版本，改动累积） |
| 包名 | `@dsh-external/dsh-memory` |
| 依据 | 真实 SDK（`@qoder-ai/qoder-agent-sdk@1.0.50`）**＋**本机 `qodercli` bundle 解码，不是文档推测 |
| 测试 | **513 项全绿**（`npm test`，18 个套件）：unit 121 / integration 187（9 个主题套件）/ client 63 / memory-model 46 / update 27 / journal 20 / architecture 18 / memory-agent 18 / discovery 9（+1 skipped）/ resolveMeta 4 |
| 依赖 | 仅 `@deepseek-ai/schemastery`（真正的 `Config` schema，**不在公共 npm 上**）与 `picomatch`（排除规则；Qoder 自己也是这个库） |
| 文档 | [代码结构与开发](docs/architecture.md)（模块放哪、怎么加东西、测试怎么跑）· [Qoder 记忆模型](docs/qoder-memory-model.md)（解出的原件）· [记忆层归属](docs/memory-layers.md)（哪些层归 harness）· [CHANGELOG](CHANGELOG.md)（开发流水与每条修复的反证） |

![设置面板](docs/images/panel-zh.png)

> 截图由 `npm run preview` + `npm run shots` 从**真实的 `lib/client.js`** 渲染（`tools/preview.mjs`），
> 另外还有英文与暗色两张：`docs/images/panel-en.png`、`docs/images/panel-zh-dark.png`。

---

## 1. 它是什么

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

在 Harness 会话里用 `plugin_manager` 安装，`target` 指到本仓库：

```
action: install_bundle
target: <本仓库路径>
```

装好后需要**一次 `dsh web` 重启**（host 半在进程启动时加载），之后**刷新页面**即可看到面板
（client 半每次加载都会重新取）。之后改代码：host 半仍需重启，client 半只需刷新。

`cordis.patch.yml` 里那行 `insert` 已按包名挂载本插件；**可调项写在你自己 profile 的
`cordis.patch.yml` 里**（`id: memory` 覆盖），不要改插件自带的 patch——升级会被覆盖。

### 2.1 依赖与重装

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

## 3. 快速上手

1. 按 §2 装好并重启，`Settings → Memory` 能看到面板。
2. 注入上限**默认 5000 token**，不用配；想改（包括改成完全不设上限）先把**模式**切成 `custom`
   （面板第一行就能改，见 §4.2）。
3. 正常聊几轮，然后 `/memory` 看最近一次生成/消费；不确定记忆有没有进上下文，按面板的「预览」。
4. 让 agent 主动记东西：主模型有 `memory` 工具（`action: write|edit|...`），见 §8.2。

## 4. 配置参考

### 4.1 完整示例

写在**profile 的** `cordis.patch.yml`：

```yaml
- id: memory
  name: '@dsh-external/dsh-memory'
  config:
    enabled: true
    mode: native              # native | custom
    userScope: true           # $DSH_HOME/memory/
    projectScope: true        # $DSH_HOME/projects/<projectKey>/memory/  （不在仓库里）
    writePolicy: memory-root  # 写入时声明哪个沙箱根：memory-root＝自声明记忆目录，session＝去问当前会话
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
      enabled: true           # 自动记录的总开关（Qoder 的 auto_memory_policy.enabled；这里默认开）
      maxOutputTokens: 0      # 0＝不给回复设上限，用适配器/模型自己的默认值（见 §4.2）
      pauseAfterFailures: 3   # 连续失败几次就暂停本会话的生成（Qoder 的 hFl=3）；0＝永不暂停
      journal:                # Qoder 的日刊（action:"add", target:"daily"）；默认关
        enabled: false
        scope: project        # 日刊写到哪个作用域：project | user
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
        minHours: 24          # 每根作用域距上次巩固满多少小时才考虑
        minSessions: 5        # 该作用域自上次巩固以来至少新增多少个会话（0＝关掉这道闸门）
        scanThrottleMinutes: 10  # 数会话这一步的节流窗口（0＝每次 turn 结束都数）
      # onResult: !!js '(r) => console.log("memory", r.status)'
    consumption:
      enabled: true
      # maxTokens: 5000         # 可选。不写＝默认 5000 token；写了必须是正整数，或 'unlimited'（不设上限）
      overflow: truncate       # truncate（截断到放得下）| fail_query（放不下就报错）
      failureMode: best_effort # best_effort（单个文件读失败也继续）| fail_query（报错）
      # files:                 # custom 模式下替代自动发现
      #   - { id: conventions, path: D:/knowledge/CONVENTIONS.md, required: true }
      # onResult: !!js '(r) => console.log("memory", r.status)'
    update:                   # 自更新（Qoder 没有这个面，是本插件独有的运维开关，见 §4.4）
      mode: check             # off | check | auto
      dir: ''                 # 空＝插件自己的包根（本检出的根）
      remote: origin
      branch: ''              # 空＝当前 HEAD 所在分支
      timeoutMs: 10000        # 单条 git 命令的超时
```

`shouldGenerate` 与 `onResult` 用 YAML 的 `!!js` 表达式传入（Loader 会求值成真正的函数）。

### 4.2 语义要点

**`native` 与 `custom`**（照 SDK 的规则）：`native` 下运行时决定记什么、存哪里、何时加载，
且**拒绝** `generation.*` / `consumption.*` 的覆盖（只放行两个 `onResult` 回调和作用域开关）；
`custom` 只覆盖你显式给出的部分。**`mode` 的默认值是 `native`，不写就等于 `native`。**

> 被拒绝的配置**不是"没生效"，而是插件根本不激活**——`validateMemoryConfig` 在 `apply()` 里跑，
> Loader 重新加载时抛错，于是记忆在所有会话里消失。所以：面板在 `native` 下**照实显示这些值但不给控件**，
> 写入路由**先剪枝再写**（切到 `native` 时把不被接受的项移除，并把剪掉的键列在回复的 `dropped` 里）。

**两个"预算"不要混**：`consumption.maxTokens` 是**注入**预算——每一步最多允许多少 token 的
**记忆文本**进入上下文；`render` 执行"宽处略、细处截"：整份放得下就全注入，放不下就**先整文件丢弃**
（按加载顺序），只剩一个时才对它做截断。**模型自己的输出**上限是另一个旋钮
（`generation.maxOutputTokens`），两者互不相干。

**注入上限默认 5000 token**：`consumption.maxTokens` 是**可选**的，**不写就是默认的 5000 token**——
记忆永远有界，不会一路长到把对话挤出去。要改就写**正整数**：schema 是 `natural().min(1)`、SDK 也要求
正整数，所以 `0` 在配置层就被拒绝，到不了渲染层；**要完全不注入就设 `consumption.enabled: false`**。
那个下限是**一个共享常量**（`CONSUMPTION_MIN_TOKENS`）：schema、`/api/memory/budget` 路由、面板输入框的
`min` 都读它。默认的 5000 也是**一个共享常量**（`CONSUMPTION_DEFAULT_TOKENS`）。

**「不设上限」是显式的，写法是字符串 `'unlimited'`**：`maxTokens: unlimited` 表示不设上限；不写这个键
表示**用默认值**，两件事不再共用一种拼写。为什么不用 `null`：Loader 回写条目配置时走的是
`Config.simplify`，而 schemastery 的 `simplify` 会**丢掉对象里的 `null` 值**——`null` 会在下一次回写时
从 profile 里消失，部署就悄悄退回默认上限了。字符串能原样存活，也和任何 token 数不会混淆。
面板里它是数字框**旁边的一个勾选框**（不是清空输入框），命令行是 `/memory-budget unlimited`；
`/memory-budget default` 删掉这个键、回到默认值。

> 这与 Qoder 的默认**不同**，是有意的：Qoder 的加载器是 `maxTokens ?? Number.POSITIVE_INFINITY`
> （不写＝不设上限），它的设置表里也没有"记忆注入预算"这一项。本插件**给了记忆一个有界的默认**，
> 因为注入的上下文是要和对话抢位置的——不设上限意味着记忆文件一多就会把对话挤掉。
> 与 Qoder 的偏离只在这一条：**默认值有界**；上限的**语义**（超了先整文件丢弃、再对最后一个截断）
> 与 Qoder 一致。

**`maxOutputTokens` 默认 0**：本插件第一版抄了 Qoder `summarizer-*` 任务类型的 `2e3`，那是给摘要的，
而 pass 是**用工具调用写文件**的——文件正文就在工具参数里，固定小上限会让推理模型在吐出工具调用之前
就撞上上限。撞上且那一轮没有可用的工具调用时，pass 会失败并**在原因里说清**；若工具调用已经完整，
那些写入照常落地再结束循环。

**写入没有预算**：Qoder 的 SDK 与 qodercli **都没有**「每轮写几个文件」或「单文件多少字节」这类字段，
所以本插件也没有——早期版本有过 `maxWrites` / `maxWriteBytes`（默认 `0`＝不设上限），现已**整块删掉**：
模型一轮想写几个就写几个，写不出上限也就没有"预算撞线/延后"这套报告。`generation.maxOutputTokens`
与它无关（那是**模型输出**的旋钮，见上）。

**`writePolicy` 与文件沙箱**：记忆按契约放在 `$DSH_HOME` 下，也就是**永远在会话工作区之外**。
harness 的沙箱后端按策略给"变更"上围栏（`read-only` 全部拒绝、`workspace-write` 只允许落在工作区内、
`danger-full-access` 不设围栏），而**读不受限**。所以本插件默认 `writePolicy: memory-root`：
**记忆与它自己的存储（信任库、巩固锁与状态）在写入时声明自己的目录作为沙箱根**，写仍被插件自己的
路径校验限在作用域内，但在 `workspace-write` 会话下照常可用。设成 `session` 则**真的去问当前会话**：
受限模式下记忆变成**只读**，面板与 `/memory` 会明说。细节与那行面板提示怎么读见 §10.1。

### 4.3 环境变量覆写

Qoder 用「品牌前缀 + 名字」拼环境变量，布尔词汇是 `1/true/yes/on` 与 `0/false/no/off`
（去空格、忽略大小写），其他值当**未设置**。本插件沿用同一套词汇，前缀换 `DSH_`：

| 变量 | 作用 |
|---|---|
| `DSH_MEMORY_HEADLESS=false` | 整体关闭记忆 |
| `DSH_MEMORY_PROJECT` / `DSH_MEMORY_USER` | 覆写两个作用域开关 |
| `DSH_MEMORY_DREAM` | 覆写巩固 pass 开关 |

**环境变量优先于配置**，且只有这四个开关能从环境进来。被环境固定的开关会在面板里注明
（按了也不会生效的开关比没有这个开关更糟）。

### 4.4 自更新（`update.*`）

这个插件是**装成指向本检出的软链**的（`link:<本仓库路径>`），所以"升级插件"就是**让这个检出快进**。
插件自己会做这件事，但**只做快进**，绝不合并没有的提交：

| `mode` | 行为 |
|---|---|
| `off` | 一次 git 都不跑（面板里那一行也不显示） |
| `check`（默认） | 启动时 `git fetch` 一次，判决结果报到面板与 `/memory`；**要不要应用由你点** |
| `auto` | 启动时检查，**只在"落后且工作树干净"时**直接 `git pull --ff-only` |

- **判决词表**（面板与 `/memory-update status` 同源）：`up-to-date` / `behind` / `ahead` / `diverged` /
  `unavailable`（不是仓库、git 不在、超时）。面板上只显示"落后几个提交"和短哈希，原始状态与原因在悬停提示里。
- **工作树脏一律拒绝**：有未提交改动时**不会拉**，返回 `refused`，面板与命令都明说原因——
  自动更新永远不该把你的本地改动卷进一次合并。
- **只 `--ff-only`**：本地有分叉（`diverged`）时拒绝而不是合并或变基。远程是 `origin`、分支默认取
  **当前 HEAD 所在分支**（detached HEAD 时报 `unavailable`，不猜）。
- **生效时机**：宿主半（`lib/`）**要下次 `dsh web` 启动才用上新代码**——harness 没有运行时重载
  （`plugin_manager` 只有 `install_bundle` / `list_plugins` / `list_bundles`）。所以拉成功后面板会多一行
  「重启后生效」；浏览器半刷新页面即可。
- **怎么用**：面板里那行有按钮（`behind` 时是「立即更新」，否则是「检查更新」）；
  命令行是 `/memory-update [status|check|apply]`；两者都打 `POST /api/memory/update`。
- **私有仓库/需要凭据**：git 以**非交互**方式跑（`GIT_TERMINAL_PROMPT=0`、`GIT_ASKPASS=''`、
  `GCM_INTERACTIVE=never`、不开 shell），认证不上就报 `unavailable`，**不会弹窗卡住启动**。
- `dir` / `remote` / `branch` 是给"检出在别处"或"上游不叫 origin"的情况留的；平时全部留空即可。
- **整段 `update` 不写也一样是 `check`**：默认值由 schema 补，启动照旧只 `fetch` 一次、不碰工作树。
  这两条路径（不写 vs 写了 `mode: check`）都有用例钉住——`update` 那五个默认值在
  `lib/config/config.js` 里只有**一个来源**（`UPDATE_DEFAULTS`），schema 只是引用它。

> 这不是 Qoder 的契约项——Qoder 的 SDK 里没有自更新。放在这里是因为**插件的安装形态就是软链**，
> 没有包管理器负责升级它；开关默认 `check` 而不是 `auto`，因为拉代码是**动你磁盘上文件**的操作。

## 5. 存储布局（`$DSH_HOME`）

```
$DSH_HOME/memory/MEMORY.md                      user 作用域索引
$DSH_HOME/memory/<topic>.md                     user 作用域内容
$DSH_HOME/memory/journal/<YYYY-MM-DD>.md        日刊（开启时；子目录，不参与注入）
$DSH_HOME/projects/<projectKey>/memory/...      project 作用域（同一套结构）
$DSH_HOME/trusted-folders.json                  目录信任判定（不是记忆，不注入）
$DSH_HOME/.consolidate-lock                     巩固锁（不是记忆；Qoder 的文件名与一小时窗口）
$DSH_HOME/dream-state.json                      巩固 pass 的每根上次运行时间（不是记忆）
$DSH_HOME/memory-off-sessions.json              会话级开关的「偏离」记录（不是记忆）
```

后三个是**关于会话/插件的状态**，不是记忆：它们在所有记忆根之外，而且是 `.json`
（根目录只收 `*.md`），所以不会被当成内容读进来。

## 6. 记忆文件与发现

### 6.1 内容文件与 front-matter

内容文件的 front-matter：`name` / `description` / `type`（`user | feedback | project | reference`）
/ 可选的 `paths`（见 §6.5）。非法或缺失的 `type` 回落到 `project`；没有 front-matter 的文件整份算正文。

### 6.2 索引

`MEMORY.md` 是**索引**：它按行指向内容文件，正文不在里面。写入时会检查"约 25KB"与"单行超过约 200 字符"
并**报告**（结果、日志与面板都会说），但**从不拒绝**——Qoder 也只在提示词里说。

### 6.3 发现管线

1. **排除**：picomatch 匹配**规范化 + realpath** 两种路径形态，**只对项目作用域生效**（全局不被过滤）。
2. **大文件**：超过 40 000 字符**标记但仍然加载**（Qoder 是 `{path, characterCount}` 报告，不丢弃）。
3. **失败可见**：读不了的文件进 `failedFiles`，结果绝不谎报成功。
4. **每步重投影**（`agent/pre-step`）：每一步重算整块并逐文件哈希。未变 ⇒ **静默**（不注入、
   不触发 `onResult`）；变了 ⇒ **只发哈希变动的文件**（`form: 'notice'`，带 `Removed:` 行），从不发快照。
   `blockHash` 与逐文件哈希挂在消息 `source` 上，新进程可以续接比较基准。
5. **子目录不算记忆**：文件集是**平铺**的（日刊故意落在子目录里，见 §6.6）。

### 6.4 `@` 导入

语法：`@./x.md`、`@../x.md`、`@~/x.md`、`@/abs.md`、`@x.md`（带扩展名）；
`` `@...` `` 这类**提及**不算导入；**代码围栏里的 `@` 跳过**。

展开标记：`<!-- Imported from: X -->` … `<!-- End of import from: X -->`、
`<!-- File already processed: X -->`、`<!-- Import blocked: X - outside project root -->`、
`<!-- Import failed: X - reason -->`；`flat` 格式是 `--- File: path ---` / `--- End of File: path ---`。
`maxDepth: 5`，**URL 永不跟随**。允许目录＝该文件所属记忆根 ＋ 受信任的项目目录；
授权 = 配置 ∨ 项目 ∨ **会话级一次性授权**（`/memory-imports allow`，授权后立即重新加载）。

### 6.5 按需加载（Qoder 的 `jitMemory`）

```markdown
---
type: project
paths: ["src/**/*.ts"]
---

只有写 TypeScript 时才需要知道的约定……
```

| 声明 | 行为 |
|---|---|
| 什么都不写 | `always_on`——与不开这个功能完全一样 |
| `paths: [...]`（或 `globs:`） | `glob`：只有会话**触及**匹配路径才加载 |
| `trigger: false` | `manual`：永不自动加载，但索引指针仍在、工具仍可读 |

匹配用 `picomatch`（与排除规则同库同选项），"触及"取自 `session.deriveMessages()` 且**只认像路径的
token**（散文不会误触发）。被跳过的文件报 `jit_skipped`，面板会说明原因。

### 6.6 日刊（Qoder 的 Daily Memory Journal）

Qoder 的工具面是 `memory` 工具加 `action: "add"` + `target: "daily"`。逐字解出的契约：

> **Daily Memory Journal**: After the memory review above, write a daily memory entry if this
> conversation produced information useful beyond this session.
>
> - content: Bullet-point list, max 8 bullets, each <=120 chars
> - 候选：做成了什么 / 决定了什么及为什么（含被否的方案）/ 遇到的问题及怎么解的 / 重要的文件 API 配置 / 影响方向的用户反馈
> - Quality gates: 每条自含；每条具体，尽量带名字、路径或具体值
> - EXCLUDE: 已在 `MEMORY.md` 里的、`<system-reminder>` 内容、琐碎动作、没解决的原始报错
>
> Write all daily memory items in a single tool call. If nothing qualifies, skip daily memory.

**"After the memory review above" 决定了它挂在哪**：日刊**不是**交互路径上的第四次调用，而是**后台生成
pass 内部**多写一个文件——pass 本来就在跑，所以开启日刊的代价是**一次写入**，不是一次新的模型调用。
提示词只在 `journal.enabled` 为真时才出现。**日期和路径由插件算，模型只给 bullets**（模型算日期出了名的
不靠谱）。

文件落在 `<root>/journal/<YYYY-MM-DD>.md`，**子目录是刻意的**：`listRootFiles` 只读根目录的平铺一层，
所以日刊对注入**不可见**——它是"那天发生了什么"的记录，不会随天数增长而挤占上下文。
**代价说清楚**：`memory` 工具的 `list`/`read`/`search` 同样看不到日刊；要读就直接打开那个文件。
**同一天是追加**（读 → 追加 → 写回），并带着读到的版本做 compare-and-swap，两个 pass 同时结束不会互相覆盖。
8 条 / 120 字符只是提示词措辞，**只报告、从不拒绝**。**时区用本地日期**。

## 7. 作用域与开关

记忆是每台机器一套配置，所以开关分**两级**：

| 层级 | 怎么改 | 作用 |
|---|---|---|
| **全局** | 设置页的「全局作用域」下拉，或 `/memory-scope all\|user\|project`，或配置里的 `userScope`/`projectScope` | 所有 `auto` 会话跟随的作用域 |
| **会话** | 对话页输入框里的**记忆按钮**（一次点击循环五态），或 `/memory-switch auto\|all\|user\|project\|off` | 只影响这一个会话 |

会话五态（按循环顺序）：

| 状态 | 含义 |
|---|---|
| `auto` **跟随全局** | 默认，什么都不存（所以配置改动能继续影响它） |
| `all` **用户 + 项目** | 本会话同时用两个作用域，不管全局那一层怎么设 |
| `user` **仅用户** | 只读写跨项目（用户）记忆，本项目记忆既不加载也不记录 |
| `project` **仅项目** | 只读写本项目记忆，跨项目知识既不加载也不记录 |
| `off` **关闭** | 两半一起停 |

- **`all` 单独存在**是因为 `auto` 是"跟随配置"：在全局被设成"仅项目"的机器上，一个会话没有别的办法
  把用户作用域要回来。
- **`project` 不是静音的一半，是作用域收窄**：它把会话的选择折进配置本来就有的 `userScope`/`projectScope`
  开关，于是 roots、信任门、身份哈希、生成提示词看到的是**同一个画面**。
- **`off`**：不注入（一个记忆文件都不读）、不记录、**已排队**的记忆消息会被移除、写入被拒、**读取照旧**
  （问记忆一个问题不等于让记忆影响这个会话）；`/memory-refresh` 会明说原因。
- **存的是"偏离"，不是"许可"**：`auto` 根本不写进文件，文件里只有被改成别的状态的会话。
  丢了、坏了、从来没有过 ⇒ 一切照常跟随配置——失败方向是"选择被忘了"，而不是"记忆到处都不出声"。
- **按会话 id 记**：续接保留 id ⇒ 选择跟着走；子代理有自己的 id ⇒ 不继承父会话的选择。
- **离开 `off` 不会自己重新注入**（下一步会发现块没变而保持沉默，这是对的），所以命令会直说，
  并指出 `/memory-refresh` 可以强制拉一次。
- 控件的 `title` 写明三件事：**当前是什么**、**它意味着什么**、**点一下会变成什么**；
  圆点按"种类"配色（绿＝跟随配置、蓝＝本会话被钉住、琥珀＝静音）。

## 8. 使用

### 8.1 模型侧工具（记忆 pass 内部）

`memory_list` / `memory_read` / `memory_search` / `memory_write` / `memory_delete`——全部限定在作用域根内，
最多 8 轮（`MAX_AGENT_ROUNDS`）。**只有 `memory_search` 与 Qoder 同名**；Qoder 的 `memory` / `memory_get`
在本插件叫 `memory_list` / `memory_read`，提示词里对此有明确说明。`memory_write` 有 `mode: replace | append`，
还有 `target: "daily"` 走日刊。这一套**没有 `edit`**：它是自己的闭环，`edit` 加在下面的人类工具上。

### 8.2 人类工具 `memory`

| 参数 | 值 |
|---|---|
| `action` | `list` \| `read` \| `search` \| `write` \| `edit` \| `delete` |
| `scope` | `user` \| `project`（默认 project；`search` 忽略它，搜全部作用域） |
| `query` | `search` 要查的文本（必填；**字面匹配**，不是正则） |
| `path` | 作用域根内的相对 `.md` 路径（`../escape.md`、`NOTES.txt` 都被拒绝） |
| `content` | `write` 时的完整文件内容 |
| `old_string` / `new_string` / `replace_all` | `edit`：要替换的文本 / 替换成的文本 / 是否替换全部出现 |

- **`write` 是整份替换，`edit` 是改一段**：记忆文件是散文，模型想改一行却要自己把其余每一行都完美
  复现——这就是"改一处、丢一段"的来源，所以推荐用 `edit` 改已有文件。
- **`edit` 的语义照搬 harness 自己的 `edit`**：`old_string` **必须唯一**（否则拒绝，并告诉你出现了几次、
  以及 `replace_all` 可以放行），替换是**字面量**（替换文本里的 `$&`、`$1` 不会被展开）。
- **`edit` 是一次 compare-and-swap**：读出正文、算出新正文、再用**它读到的那一版**写入；中途有人改了
  （你自己、别的会话、后台 pass），**写入被拒**并告诉你"文件已变，请重读后重试"。`write` 没有这个保护。
  **没有字节上限**：写多大由这次调用的正文决定（Qoder 没有这个字段，所以本插件也没有）。

### 8.3 命令

| 命令 | 作用 |
|---|---|
| `/memory` | 状态：作用域、信任判定、最近一次生成/消费、变更与告警明细 |
| `/memory-switch [auto\|all\|user\|project\|off\|status]` | **会话级**记忆模式（§7） |
| `/memory-scope [status\|all\|project\|user]` | **全局**作用域（§7）：每个 `auto` 会话跟随的那一层 |
| `/memory-budget [status\|<tokens>\|unlimited\|default]` | **注入上限**（§8.4）：与面板同一个写入器 |
| `/memory-trust [allow\|deny\|list] [folder]` | 目录信任（写入 `$DSH_HOME/trusted-folders.json`） |
| `/memory-imports [status\|allow\|deny]` | **会话级**外部导入授权（授权后立即重新加载） |
| `/memory-update [status\|check\|apply]` | **自更新**（§4.4）：`check` 真去 `fetch`，`apply` 只在落后且工作树干净时快进 |
| `/memory-delete <scope>:<path>` | 删除一个记忆文件 |
| `/memory-refresh` | 重新加载记忆（外部编辑后手工拉取） |
| `/memory-resume` | 清除「连续失败暂停」（Qoder 没有恢复路径，这是唯一出口） |
| `/memory-flush` | 等后台写入落盘 |

### 8.4 设置面板

面板从上到下的区块顺序：状态行（插件/**模式（可编辑）**/生成/消费/**全局作用域（可编辑）**/巩固/
闸门/**信任＋授权按钮**/在飞任务/**自更新判决＋按钮**）→ **注入预算区**（注入上限**可编辑**；注入预览）→
活动区（最近生成/巩固 + 告警）→ 编辑器（作用域下拉 + 文件名 + 保存/重载/等待）→ **作用域区** → 命令提示。

**自更新那一行是状态块的末尾**（它说的是这份安装，不是这一页在描述的记忆；`update.mode: off` 时整行不显示）：
落后时按钮是「立即更新」，否则是「检查更新」；`behind` 只显示落后几个提交与短哈希，原始状态/拒绝原因进悬停提示；
刚拉成功会多一行「重启 `dsh web` 后生效」（§4.4）。

**面板里能改的六项**：**模式**（`native`/`custom`）、**全局作用域**、**注入上限**，以及**三个策略开关**
（自动记录 + 记忆巩固 + 日刊）——前两项各算一项，开关是三张控件、一个保存。
它们共用同一个写入器与同一套规则（`host/config-route.js`：收窄 → 用真 schema 校验 → `configEditor.edit`）。
除模式与全局作用域外，其余各项都是 `generation.*` / `consumption.*`，**在 `native` 下会被拒绝**，
所以面板在那里对它们只报告值、不给控件。**注入上限是一个数字框加一个「不设上限」勾选框**：
数字框写正整数，勾选框写 `unlimited`（与配置里同一个拼写）。空着的数字框不是"不设上限"——
部署有**默认上限 5000**，勾选框才是那个显式的选择。
（写入那一侧已经没有对应的控件了：`maxWrites` / `maxWriteBytes` 已整块删除，见 §4.2。）

**作用域区放在最底是有意的**：它是唯一会**无限增长**的区块（每个有记忆的项目一行），放在控件上方会把
「打开这个页面本来要改的设置」挤出第一屏。每行写**工作区名字**（查不到就回退成 `projectKey` 目录名），
悬停显示被寻址的 slug，另有「N 个记忆文件」+ 占用大小，文件折叠在 `<details>` 里（可打开/删除）。
中英双语，全部用真实 `--dsw-*` 主题 token。

**注入预览**回答的是"我的记忆到底进没进上下文"，给的是**下一步的判定**而不是事后清单：点一下「预览」，
Host 把真实消费跑一遍再**丢掉结果**，返回 `step.action`（`silent` 什么都不注入 / `snapshot` 全量 /
`delta` 只发变动 / `none`）、原因、本步 token，以及新会话会收到的**完整块正文**。判定词会翻译成中文，
原始代码只进 tooltip。**它绝不改变它描述的行为**：不记 `lastConsumption`、不触发 `onResult`、
只读不写那个会话的注入基准（预览若推进了基准，下一步就会判定"未变"而什么都不发）。

**"为哪个会话预览"按确定性递减的顺序解析**：`?session=<id>` → 进程内的 initiator →
**唯一的顶层活会话** → 都没有时回答**全局配置**下的内容并**明说**这是哪个问题。
浏览器请求永远没有 initiator（`withInitiator` 在生产里只有一个调用点），所以第三条正是让面板能说出
用户正在聊的那个会话。**多于一个候选时不猜**（为错误的会话编一个答案比报告全局更糟），
**点名但已死的会话是 409**。**读可以这样解析，写不行**：`/api/memory/switch` 的 `session` 必需。

**面板不给"插件会拒绝的控件"**，也不给"按了只会得到 501"的控件（没有 `configEditor` 的组合退化成只读一行）。
两件如实标注的限制：harness 的 `FsInfo` 只有 `version/type/size`、**没有修改时间**，所以显示的是占用大小；
harness 也**没有"在文件管理器里打开"的能力**（曾实现过，按用户要求撤掉）。

**Host 路由**（`/api/memory/*`，13 条，客户端字面量必须与之完全一致）：

| 路由 | 用途 |
|---|---|
| `status` | 面板与 `/memory` 的状态载荷 |
| `file` | 读/写/删单个记忆文件 |
| `preview` | 注入预览（只读） |
| `refresh` / `flush` | 重新加载 / 等落盘 |
| `trust` | 目录信任的授予与撤销 |
| `switch` | 会话级模式（读要会话，写要会话） |
| `update` | 自更新（§4.4）：`{action:'check'\|'apply'}`，别的输入是 400 |
| `budget` / `generation` / `scope` / `mode` | 面板可写项（`budget` 收正整数或 `'unlimited'`，`'unlimited'`＝不设上限） |

## 9. 与 Qoder 的契约映射

| Qoder | 本插件 |
|---|---|
| 生成半 / 消费半 | 同构，两个可独立开关的配置块 |
| 作用域 `user` / `project` | `$DSH_HOME/memory` / `$DSH_HOME/projects/<projectKey>/memory` |
| `MEMORY.md` 索引 + 内容文件（`type` 四类） | 同构；非法 `type` 回落 `project` |
| `isTrustedFolder()` | `trust.enabled` + `trust.folders` + `$DSH_HOME/trusted-folders.json` |
| 排除规则（picomatch） | 同库同选项，**只作用于项目作用域** |
| 大文件策略（`4e4` 字符） | 报告但**仍然加载**（与 Qoder 一致） |
| `@` 导入（`ImportProcessor`） | 同语法/标记/`tree`·`flat`/`maxDepth: 5`；授权=配置 ∨ 项目 ∨ **会话** |
| 每次请求重建记忆块 | `agent/pre-step` 每步重投影 + 哈希；**未变则静默探测，变了才发增量** |
| `extractionEveryNTurns` 间隔门 | `generation.incremental.everyTurns`（含两种 bypass） |
| 注入预算（`maxTokens ?? Infinity`：**默认不设上限**） | **默认 5000 token**（`consumption.maxTokens`）；「不设上限」是显式的 `'unlimited'`——见 §4.2 的偏离说明 |
| `MOl` 增量转录游标 | `collectTranscript(session, sinceSeq)`（游标只在 pass 真跑过后推进） |
| `path_glob_match`（just-in-time） | front-matter `paths` ⇒ 只有会话触及匹配路径才加载 |
| `AutoDream`（时间闸门 + 会话数闸门 + 扫描节流 + 锁） | `generation.dream`（`minHours` / `minSessions` / `scanThrottleMinutes`）+ `$DSH_HOME/.consolidate-lock`（Qoder 的文件名与一小时窗口）；会话数取自 `ctx.get('sessions')` + `sessionPersistence.list()`，不读 Qoder 的 `.jsonl` 工件目录（§10.3） |
| `memory` / `memory_get` 工具名 | 本插件叫 `memory_list` / `memory_read`；`memory_search` 同名 |
| Daily Memory Journal | `action:"add"` + `target:"daily"`（§6.6） |
| `MEMORY_HEADLESS` 等环境变量 | `DSH_MEMORY_*`，同一套布尔词汇，环境优先 |
| 删除记忆 | 模型工具 / `memory` 工具 / `/memory-delete` / 面板删除按钮 |
| ——（Qoder 没有自更新） | `update.*` + `/memory-update` + `POST /api/memory/update`：检出是软链装的，没有包管理器管升级（§4.4） |

## 10. 与 Harness 的集成约束

### 10.1 沙箱与 `writePolicy`

harness 的沙箱按**策略**给变更上围栏：`read-only` 拒绝一切写入；`workspace-write` 只允许**规范化后落在
工作区内**（或平台临时目录）的目标；`danger-full-access` 不设围栏。**读不受限**——记忆一直能加载，
只有写入会失败，报的就是 `file access denied under workspace-write mode`。

`writeText`/`editText` 的第 5 个参数是"本次调用的 mode + workspaceRoot"。**省略它并不等于"跟随会话"**：
后端只做 `sandboxPolicy ?? ctx.sandboxPolicy.resolve()`，而不带会话的 `resolve()` 回的是**部署默认值**。
所以本插件默认 `writePolicy: memory-root`（自声明记忆目录为沙箱根），需要时设成 `session` 去问会话。
面板那一行把两个模式分开显示：`memory-root · workspace-write · session read-only`——
两个数字分开显示，才不会把"完全权限的会话"看成"被围栏的会话"。

**删除**：harness 的 `fs` 服务**没有 delete**，但它提供了 `processPath(target)`
（"the canonical absolute path a subprocess in this filesystem's execution world can open"）。
`deleteGuarded` 的顺序是：`resolve`+`stat` 并校验 `expectedVersion`（**只删调用方看过的那个版本**）→
provider 自己有 `remove` 就用它 → 否则用 provider 给的 `processPath` 去 `unlink` →
声明 `read-only` 的后端**直接拒绝**。允许范围与写入**完全同一套**。如实说明的代价：插件自己发起的
`node:fs` 调用不经过某个 confining 后端的拦截，所以只读后端是**主动拒绝**而不是被强制。

### 10.2 项目身份：按 Harness，不按 Qoder

| 概念 | 归属 | 本插件怎么用 |
|---|---|---|
| Workspace 记录（uuid + canonical path，`ctx.workspaceRegistry`） | harness | 读它拿真实路径与标题；没有就退回规范化路径 |
| `projectKey` 目录名（形如 `--D-code-demo--`） | harness 的 session-persistence | **就是**项目记忆目录名，和 sessions 分组一致 |
| `.git` marker 向上查找 | `dsh-agent-instructions` | 只在 `projectRootMarkers` 显式配置时用于划分记忆根 |

`projectKey` 是**有损**的：`-` 与路径分隔符不可区分（`D:\a-b` 与 `D:\a\b` 同名），非 ASCII 或空格会变成
`~XXXX` 转义（**无法从目录名反推路径**），251 字符处截断且不加 hash。**本插件照抄这种有损**，
好处是与 harness 自己的 `sessions/` 目录一一对应。

### 10.3 不做 AGENTS.md 层

Qoder 的 `globalMemory`/`projectMemory`/`localMemory`/`pluginMemory` 四个桶的原料是
`getAllQoderMdFilenames()`，即**指令文件族**；在 DSH 那由 `dsh-agent-instructions` 负责
（项目级 `AGENTS.md`/`CLAUDE.md`、`.local` 变体、`$DSH_HOME/AGENTS.md`）。照搬会**同一份文件每次请求
注入两遍**。分工是清楚的：**指令文件（"你要怎么做事"）→ harness；自动记忆（"你之前学到什么"）→ 本插件**。
技能目录同理：`dsh-skill*` 是 harness 的一等子系统，Qoder 里唯一与记忆目录相关的访问器**只有定义、
没有调用点**，实现它属于发明功能。证据见 [docs/memory-layers.md](docs/memory-layers.md)。

### 10.4 与 harness 版本的兼容

**已核对：桌面版 harness `0.2.0-rc.2`**（以及 profile 解析到的 `0.1.7-rc.2`）。核对方式是**问正在运行的
宿主本身**，而不是只看自己写的替身：`fs`（含 `processPath`）、`llm.stream` 的入参与 `StreamChunk`、
`FinishReasonMap`、`ToolSchema` / `ToolResultMessage`、`session/event` 的 `turn/end` 与
`Session.header/requestHeader/snapshotEvents/deriveMessages`、`tokenMeter.estimateMessage`、
客户端 `Slots.listSubTree('settings.section')`、以及面板用到的 **20 个 `--dsw-*` token 全在**运行版的
bundle 里（有测试对着它跑）。

**升级后怎么重新核对**：跑 `npm test`（token 检查会打印它用的 oracle），再用宿主 Inspect 查一遍上面几个
服务；`Settings → Memory` 面板本身也是活体证据。

**一个真实的坑**：桌面版把 harness 打包进**一个 `app.asar`**，而 profile 的 Node 解析可能仍指向**更旧的
npm 安装**——"测试全绿"可能验的是旧版本。`test/support/harness-env.mjs` 因此优先找**正在运行**的那份
（可用 `DSH_HARNESS_BUNDLE` 显式指定），找不到就跳过并说明。

### 10.5 巩固的"会话数"从哪来

Qoder 的 `minSessions` 数的是它自己会话工件目录里、**修改时间晚于该作用域上次巩固**的 `.jsonl`。本插件
**不读那个目录**，而是用 Harness 自己的两个服务：`ctx.get('sessions').list()`（活会话）+ `ctx.get('sessionPersistence').list()`
（已落盘会话），各取 `.header`、按 id 去重。理由是这样做才是 Harness 自己的写法（`dsh-workspace` 就是这么
索引项目会话的），而且插件的 `fs` 接缝**根本拿不到 mtime**——本地的 `fs.stat` 只回 `{ version, type, size }`，
`version` 是从 `dev:ino:size:mtimeNs:ctimeNs` 拼出的不透明串。代价是语义换成 **`header.createdAt`** 而不是
工件 mtime：**被续接命中的老会话不会因为"刚动过"而计入**，只有真正新建的会话才算数。两个服务都不在时
**门当作"数不出来"**（不巩固并在告警里说明），不是当作"数够了"。

## 11. 已知限制

- **两处提示词片段解不出**（`qodercli` 的字符串表里没有，例如索引行数上限 `⟨lines⟩`），
  就地声明而不是编造；模型测试逐句断言原文，并断言这两处标注还在。
- **索引约束只报告不阻止**（约 25KB / 单行约 200 字符），日刊的 8 条 ≤120 字符同理。
- **面板可编辑的只有这几件**（§8.4：模式、全局作用域、注入上限、三个策略开关）：把插件的每个旋钮
  都摊开的面板比做好最常改的那几项更难用；其余配置直接改插件配置或用命令。
- **删除的沙箱代价**（§10.1）：只读后端是主动拒绝，而不是被后端强制拦截。
- **`projectKey` 有损**（§10.2）：`D:\a-b` 与 `D:\a\b` 共用一个记忆目录——这是 harness 自己的取舍，本插件继承它。
- **harness 没有文件修改时间、也没有"在文件管理器里打开"**，所以面板只能显示占用大小。
- **日刊对 `list`/`read`/`search` 不可见**（§6.6）：刻意的取舍，不是遗漏。
- **自更新只做快进**（§4.4）：工作树脏、本地分叉、detached HEAD、认证不上都**拒绝**而不是想办法成功；
  拉下来的宿主代码**要下次 `dsh web` 启动才生效**（harness 没有运行时重载），面板会明说这一点。

## 12. 开发

- **目录结构与分层、体积预算、加东西的清单、测试怎么跑**：[docs/architecture.md](docs/architecture.md)。
- 一句话版本：host 半按 `lib/{core,config,memory,session,pipeline,host}` 分六个子系统，
  `index.js` 只做接线，`client.js` 是单文件浏览器产物；层只能向下 import，`test/architecture.test.mjs` 强制。
- 常用命令：

```powershell
npm test                 # 全部 513 项（一个套件一个进程）
npm run test:unit        # 只跑路径含 unit 的套件
npm run test:integration # 只跑 integration-* 套件
npm run preview          # 渲染面板预览到 tools/preview.html
npm run shots            # 重出 docs/images/ 下三张截图
```

- `tools/` 下的证据工具：`inspect-qodercli.mjs --strings <filter>` / `--find <regex>` 解码 `qodercli`
  bundle（XOR key `h74YFijkSnty`；**代码标识符没有混淆**，所以 `--find` 能直接定位类名/函数名）、
  `inspect-session.mjs`、`dump-qodercli-strings.mjs`、`png-probe.mjs`、`composer.mjs`。
- **改完必跑全套**；每条修复在 [CHANGELOG](CHANGELOG.md) 里都记着它的**反证**
  （把修复去掉，哪条测试会红）。纯结构调整的判据是"真跑一次 + 基线一致"。

## 13. 许可

MIT。版本号由维护者决定：**第一个完成的版本才是 1.0**，当前 `0.1.0` 是冻结值
（`test/discovery.test.mjs` 断言它，误改会让测试红）。
