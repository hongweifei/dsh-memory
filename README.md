# dsh-memory

按 **Qoder Agent SDK 的记忆契约**为 DeepSeek Harness 实现的持久记忆插件：一个后台 pass 决定什么值得记并将其写进记忆文件，一个有预算的 pass 把记忆装进 Agent 上下文。

| | |
|---|---|
| 版本 | `0.1.0` |
| 包名 | `@dsh-external/dsh-memory` |
| 依据 | 真实 SDK（`@qoder-ai/qoder-agent-sdk@1.0.50`）**＋**安装的 `qodercli` bundle 解码，不是文档推测 |
| 测试 | **316 项全绿**（`node test/*.test.mjs`）：unit 92 / integration 105 / model 40 / client 34 / architecture 13 / agent 18 / package-shape 10 / resolveMeta 4 |
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
      maxWrites: 4            # 单轮最多写几个文件
      maxWriteBytes: 16384    # 单文件字节上限
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
      maxTokens: 2000
      overflow: truncate       # truncate | fail_query
      failureMode: best_effort # best_effort | fail_query
      # files:                 # custom 模式下替代自动发现
      #   - { id: conventions, path: D:/knowledge/CONVENTIONS.md, required: true }
      # onResult: !!js '(r) => console.log("memory", r.status)'
```

`shouldGenerate` 与 `onResult` 用 YAML 的 `!!js` 表达式传入（Loader 会求值成真正的函数）。

**`native` 与 `custom` 的差别**照 SDK 的规则：`native` 下运行时决定记什么、存哪里、何时加载，
且**拒绝** `generation.*` / `consumption.*` 的覆盖；`custom` 只覆盖你显式给出的部分。

**关于 `maxOutputTokens`**：SDK 的 `SerializableMemoryGenerationOptions` 里**没有这个字段**
（只有 `enabled` / `roots` / `prompt` / `turnComplete`），所以它是本插件自己的旋钮，
`maxWrites` / `maxWriteBytes` 同理。默认 **0＝不设上限**，让适配器套用模型自己的默认值——
这是唯一对所有模型都成立的选择：pass 是**用工具调用写文件**的，文件正文就在工具参数里，
固定小上限会让推理模型在吐出工具调用之前就撞上上限（本插件第一版抄了 Qoder `summarizer-*`
任务类型的 `2e3`，那适用于摘要，不适用于写作）。要控成本就显式设一个值；上限撞上且那一轮
没有可用的工具调用时，pass 会失败并**在原因里说清**（`generation reached maxOutputTokens…`）；
若撞上但工具调用已经完整，那些写入**照常落地**再结束循环。

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
| `/memory-trust [allow\|deny\|list] [folder]` | 目录信任（写入 `<DSH_HOME>/trusted-folders.json`） |
| `/memory-imports [status\|allow\|deny]` | **会话级**外部导入授权（授权后立即重新加载） |
| `/memory-delete <scope>:<path>` | 删除一个记忆文件 |
| `/memory-refresh` | 重新加载记忆（外部编辑后手工拉取） |
| `/memory-resume` | 清除「连续失败暂停」（Qoder 没有恢复路径，这是本插件补的唯一出口） |
| `/memory-flush` | 等后台写入落盘 |

### 设置面板

状态行（插件/模式/生成/消费/巩固/闸门/**信任＋授权按钮**/在飞任务）· **作用域区**：
`user` 加**每个有记忆的项目**（用 `projectKey` 名字寻址，活动会话的项目排第一），每个文件有
**打开/删除**按钮 · 预算行 · 活动区（最近生成/消费/巩固 + 告警）· 编辑器（作用域下拉 + 文件名 + 保存/重载/等待）·
命令提示。中英双语，全部用真实 `--dsw-*` 主题 token。

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

一个包，两个半：host `lib/*.js`（25 个模块）＋ `lib/client.js`（设置面板，浏览器产物只能一个文件）。

```
0 constants
1 config · tokens · fs · paths · memory-file
2 render · memory-pass · memory-prompt · memory-search · imports · excludes · trust · jit · transcript
3 memory-agent
4 consumption · generation · dream
5 service · tools · routes · commands
6 index
```

只许向下、无环，且**只有 `index.js`** 可以引用 presentation 层——`test/architecture.test.mjs` 强制。
体积：host 模块逻辑 ≤500 行；`client.js` ≤560 逻辑 **且** ≤220 行内联数据（两份词典 + 样式表）；
`index.js` ≤300。**当前 `client.js` 两项都用满（559/560、220/220）**，下次动面板必须先腾地方，不抬上限。

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
所以纯克隆的仓库仍能跑其余全部检查，只是总数比上面的 316 少几条。

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
- **面板预算已满**（§15）：再加东西得先腾地方。
- **删除的沙箱代价**（§13）：只读后端是主动拒绝，而不是被后端强制拦截。
- **`projectKey` 有损**（§7）：`D:\a-b` 与 `D:\a\b` 共用一个记忆目录——这是 harness 自己的取舍，本插件继承它。
