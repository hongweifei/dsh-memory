# 记忆层归属设计（P2-1）

> 这份文档回答一个问题：`MemoryContextManager` 里那些还没对齐的字段，
> **哪些该由本插件实现，哪些已经由 DeepSeek Harness 负责**。
> 结论写在最后一节；中间是证据，全部来自安装的 `qodercli` bundle 解码
> （`node test/inspect-qodercli.mjs --find …`），不是从 SDK 文档推测的。

## 1. Qoder 的字段与它们的真实来源

`MemoryContextManager`（bundle 变量 `vmA`）的字段：

```js
class MemoryContextManager {
  loadedPaths = new Set
  loadedFileIdentities = new Set
  hookFiredPaths = new Set
  globalMemory = ""      pluginMemory = ""
  projectMemory = ""     localMemory = ""
  jitMemory = ""
  autoMemoryIndexContent = ""   autoMemoryIndexFileStates = []
  ruleFileStates = []   staticMemoryFileStates = []
  modelDecisionRuleIndexContent = …
}
```

`refresh()` 的实际顺序：

```js
let n = pet(await this.discoverMemoryPaths(), [...this.config.getAgentsMdExcludes()])
let { contentsMap: r, allContents: o, importParentMap: s } = await this.loadMemoryContents(n)
this.categorizeMemoryContents(n, r)
this.ruleFileStates    = await mwn([...n.global, ...n.project], r)
this.staticMemoryFileStates = await Ewn([...this.loadedPaths], r)
this.modelDecisionRuleIndexContent = await this.loadModelDecisionRuleIndex()
await this.loadAutoMemoryIndex()
```

而 `discoverMemoryPaths()`：

```js
async discoverMemoryPaths() {
  const A = this.config.getAllowedAgentSources()
  const e = (s) => !A || A.includes(s)
  const [t, i] = await Promise.all([
    e("user")    ? cwn(this.config.getAllQoderMdFilenames()) : [],
    e("project") && this.config.isTrustedFolder()
      ? lwn(workspaceDirs.map(d => this.resolveMemoryPath(d)),
            this.config.getAllQoderMdFilenames(),
            this.config.getMemoryBoundaryMarkers())
      : { project: [], local: [] },
  ])
```

三件事由此确定：

1. **四个 `*Memory` 桶的原料是 `getAllQoderMdFilenames()`** —— 也就是 Qoder 的
   **指令文件族**（`QODER.md` 一类），不是后台自动记忆目录。它们和自动记忆
   （`autoMemory*`）是**两套东西**。
2. 四个桶全部来自 `cwn`（用户级）与 `lwn`（项目级，返回 `{ project, local }`）。
3. `categorizeMemoryContents` 里**只有 project 一个桶过信任门**：

```js
categorizeMemoryContents(paths, contentsMap) {
  const t = Bet(paths, contentsMap)
  this.globalMemory = t.global || ""
  this.pluginMemory = t.plugin || ""
  this.localMemory  = t.local  || ""
  this.projectMemory = this.config.isTrustedFolder() && t.project || ""
}
```

（`local` 桶本身不过门，但它的**发现**发生在 `isTrustedFolder()` 为真的分支里，
所以实际上同样受门约束。本插件 P0-1 的移植与此一致。）

### 1.1 `jitMemory`：按 glob 条件加载

```js
function swn(file) {                       // 从文件内容里解析 trigger
  if (i === undefined) return { trigger: "always_on" }
  if (i === false)     return { trigger: "manual" }
  const n = fet(e.paths)                   // 同一个块里的 paths 列表
  return n ? { trigger: "glob", globs: n } : { trigger: "always_on" }
}
function awn(A) { const e = swn(A); return e.trigger === "glob" ? e.globs : undefined }
function GXi(content, fallbackReason) {
  const globs = content ? awn(content) : undefined
  return globs ? { loadReason: "path_glob_match", globs } : { loadReason: fallbackReason }
}
```

即：一个指令/记忆文件可以声明 **`trigger: glob` + `paths:`**，于是它只在相关路径被
触及时加载，并带着 `loadReason: "path_glob_match"` 与 `globs` 上报。
三态是 **`always_on`（默认）/ `manual`（`trigger: false`，不自动加载）/ `glob`**。

这是**唯一一个在本插件里完全没有对应物**的层。

### 1.2 三个 `*States` 与 `modelDecisionRuleIndexContent`

它们是**记账**，不是内容：`ruleFileStates`/`staticMemoryFileStates` 记录哪些文件已经以
什么身份注入过（谁提供、什么原因、有没有读错），`modelDecisionRuleIndexContent` 是模型
决定加载的那份规则索引。作用是**避免重复注入**与给遥测/`loadedPaths` 去重。

## 2. DeepSeek Harness 已经提供了什么

`dsh-agent-instructions`（由 `dsh-base/cordis.patch.yml` 以 id `agent-instructions` 挂载）：

```js
const DEFAULT_INSTRUCTION_FILE_CANDIDATES       = ["AGENTS.md", "CLAUDE.md"]
const DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES = ["AGENTS.local.md", "CLAUDE.local.md"]
const USER_GLOBAL_FILE = "AGENTS.md"      // $DSH_HOME/AGENTS.md
```

它负责：项目级指令文件（向上找到 `projectRootMarkers`，默认 `['.git']`）、同名 `.local` 变体、
以及 `$DSH_HOME/AGENTS.md` 这一份全局文件；`maxBytes: 65536`。

## 3. 逐层对照

| Qoder 层 | Qoder 的来源 | DSH 对应物 | 归属 |
|---|---|---|---|
| `globalMemory` | `cwn(getAllQoderMdFilenames())`（用户级指令文件） | `$DSH_HOME/AGENTS.md` + `USER_GLOBAL_FILE` | **harness** |
| `projectMemory` | `lwn(...)` 的项目桶（受信任门） | 项目 `AGENTS.md` / `CLAUDE.md` | **harness** |
| `localMemory` | `lwn(...)` 的 local 桶（`*.local.*`） | `AGENTS.local.md` / `CLAUDE.local.md` | **harness** |
| `pluginMemory` | 插件贡献的指令文件 | 各插件自己注入的指令 | **harness / 各插件** |
| `autoMemory*` | 后台自动记忆目录 + 索引 | 本插件的 `user` / `project` 作用域 | **本插件（已完成）** |
| `jitMemory` | `trigger: glob` + `paths`，`loadReason: "path_glob_match"` | **无** | **本插件（待实现）** |
| `ruleFileStates` / `staticMemoryFileStates` | 已注入文件的记账 | 本插件的 `visibleMemoryState` / 每次请求重投影 + 哈希去重 | **本插件（等价能力已有）** |
| `modelDecisionRuleIndexContent` | 模型决定加载的规则索引 | `memory_search` 工具（模型自己按需检索） | **本插件（以工具替代）** |

### 为什么不能照搬那四个桶

照搬会**双重注入**：`AGENTS.md` 已经由 `agent-instructions` 作为指令进入上下文，
本插件若再把它当作"记忆"注入一次，同一个文件的内容会在一次请求里出现两遍——
既浪费预算，又让模型看到两条互相独立的"同一份指令"。

这正是 P1-1 的结论（`AGENTS.md` 层**重新定性为不该在这里实现**），
而这一轮的证据把原因说明白了：**Qoder 的 `globalMemory`/`projectMemory`/`localMemory`/
`pluginMemory` 就是指令文件族**，不是在自动记忆目录里。两者的分工是：

- **指令文件（"你要怎么做事"）** → harness 的 `agent-instructions`
- **自动记忆（"你之前学到什么"）** → 本插件的 `user`/`project` 作用域

## 5. 技能目录（P2-4）：同样不做

qodercli 里有两个同名相似的访问器，但用途完全不同：

```js
getProjectSkillsDir()      { return join(this.getConfigDir(), "skills") }   // <项目>/skills：技能安装目录
getProjectMemoryTempDir()  { return join(globalConfigDir, "projects", e, "memory") }
getProjectSkillsMemoryDir(){ return join(this.getProjectMemoryTempDir(), "skills") }
```

- 前者**有调用点**：`installSkill` 把技能装进 `workspace` / `user` 作用域（`getUserSkillsDir()`），
  带 symlink 安全校验与覆盖处理——属于**技能安装子系统**。
- 后者（唯一与记忆目录相关的那一个）在整个 bundle 里**只有定义、没有调用点**。

DSH 侧技能是 harness 的一等子系统（`dsh-skill`、`dsh-skill-filesystem`、`dsh-tool-skill`、
`dsh-client-ui-skill`、`dsh-skill-badge`、`dsh-skill-office`），`dsh-skill-filesystem` 注册
`ctx.skills` provider，从 project / custom / `~/.agents` / bundled 发现技能——根目录与记忆目录无关。

**结论**：不做。照搬会与 harness 重复；而唯一涉及记忆目录的访问器从未被调用，
实现它属于发明功能而不是对齐。

**顺带钉住**：记忆根目录下的**子目录**（例如有人真的建了 `memory/skills/`）不会泄漏进上下文——
文件集是平铺的，面板列出的也是同一份平铺集合。有测试。

## 6. 结论与后续

1. **四个指令桶：明确不做**（P2-1a 已定案）。理由与证据见上；README 里已有对应说明。
2. **`jitMemory`：要做**（P2-1b，**已实现**：`lib/jit.js`）。
   它没有 DSH 对应物，且与"指令文件"无关——它是**自动记忆文件的条件加载**：
   文件在 front-matter 里声明 glob，只有会话触及匹配路径时才进入上下文。
   - 语义取自 `swn`：无声明 = `always_on`（当前行为）；`trigger: false` = `manual`（不自动加载，
     只能被工具读到）；`paths: [...]` = `glob`。
   - 加载原因沿用 `path_glob_match` 的措辞，写进遥测/日志。
   - "被触及的路径"从 `session.deriveMessages()`（模型看到的投影对话）里取，只认像路径的 token。
3. **记账层：等价能力已有**（`visibleMemoryState` 的按身份去重 + 每步重投影哈希比对），
   不另建一套 `*FileStates`。
4. **`modelDecisionRuleIndexContent`：以 `memory_search` 替代**——模型自己按需检索，
   而不是替它预先决定加载哪份规则索引。

### 明确没有回答的问题

- `trigger: manual` 的文件在 Qoder 里是否完全不进上下文（还是进索引但不进正文）——
  解码到的只有 `{ trigger: "manual" }` 这个返回值本身，没有它的消费路径。
  本插件按**最小含义**实现（不自动加载），并在 README 写明。
- `pluginMemory` 在 DSH 里是否需要插件间协商（当前判断是各插件自负其责）。
