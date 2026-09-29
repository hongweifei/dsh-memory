# Qoder 原生记忆的真实模型（从 qodercli 逆向确认）

来源：安装的 `@qoder-ai/qodercli` 包里的 `bundle/qodercli.js`（约 33 MB；用
`npm root -g` 找到它，或设 `QODERCLI_BUNDLE` 直接指到文件）。字符串用 `_$d(base64)`
＝ base64 异或 key `h74YFijkSnty` 混淆；解码脚本见 `test/inspect-qodercli.mjs`
（以及生成候选串清单的 `test/dump-qodercli-strings.mjs`）。

**为什么必须看 CLI**：npm 包 `@qoder-ai/qoder-agent-sdk` 只做选项校验，路径/文件格式/提示词
全在 CLI 里。SDK 的 `MemoryRoot.path` 注释就写着「Directory path on the machine running
qodercli」——native 模式下这些默认值由运行时掌握。

## 关键认知：auto-memory 只是其中一层

`MemoryContextManager` 的字段就是记忆层的清单：

```js
this.globalMemory            = t.global   || ""
this.pluginMemory            = t.plugin   || ""
this.localMemory             = t.local    || ""
this.projectMemory           = this.config.isTrustedFolder() && t.project || ""   // 信任门!
this.jitMemory               = ""        // 按 path glob 即时发现
this.autoMemoryIndexContent  = fgn(this.autoMemoryIndexFileStates)   // ← 本插件实现的是这一层
this.autoMemoryIndexFileStates = await D7A(k0(config))
this.ruleFileStates          = await mwn([...n.global, ...n.project], r)
this.staticMemoryFileStates  = await Ewn([...this.loadedPaths], r)
this.modelDecisionRuleIndexContent
this.pendingExternalImports / filesWithExternalImports   // 记忆文件里的 @ 导入
this.failedFiles
```

**本插件 = `autoMemoryIndexContent` 那一层（user/project 两个根、MEMORY.md 索引 + 内容文件）。
Qoder 还有 global / plugin / local / jit 四层，以及 rule files、static memory、model-decision rules。**

### AGENTS.md 层（不是 auto-memory）

发现逻辑（`vFn`）从 cwd 向上走到 **boundary marker** 为止，逐层找:

```js
r = new Set(["AGENTS.override.md", "AGENTS.md", ...fallbackFilenames])
// 还有 .local 变体: b9e() 把 AGENTS.md → AGENTS.local.md
i = await Bwe(cwd, boundaryMarkers) ?? cwd      // 向上走的终点
allowed: isTrustedFolder() && (!scope || scope.includes("project"))   // 信任门
```

设置项（`category: "Context"`）:

| 键 | 类型 | 默认 |
|---|---|---|
| `memoryBoundaryMarkers` | array | `[".git"]` |
| `discoveryMaxDirs` | number | `200` |
| `loadMemoryFromIncludeDirectories` | bool | `false` |
| `agentsMdExcludes` | array | — |
| `importFormat` / `contextFileName` | — | — |

另有 AGENTS.md 体积策略:`refreshAgentsMdSize` / `publishAgentsMdSize` / `isAgentsMdSizeEnabled`。

### 消费是一条发现管线，不是一个文件列表

`Del(A)` 的签名说明了它要什么:

```js
KNi(workingDir, includeDirectories, fileService, isTrustedFolder,
    getAllQoderMdFilenames(), importFormat, fileFilteringOptions,
    discoveryMaxDirs, memoryBoundaryMarkers, void 0, agentsMdExcludes)
  → { memoryContent, fileCount, filePaths, largeFiles, failedFiles }
Ue.emit("memory-changed", { sessionId, fileCount, largeFiles, failedFiles })
```

即:**信任门 + 排除规则 + 体积策略 + `@` 导入 + 向上逐层发现 + `memory-changed` 事件**。
本插件的消费只是「列根里的 `.md`，按预算裁剪」，没有这些。

### 记忆 Agent 的工具族

```js
vFl(A) = A === "memory"
  ? new Set(["memory", "memory_search", "memory_get"])
  : ...  // skill review 用 skill_suggest
```

即 Qoder 的记忆工具有 **`memory` / `memory_search` / `memory_get` 三个**（含全文搜索）。
本插件是 `memory_list` / `memory_read` / `memory_write`——功能近似，但没有搜索，名字也不同。

### 其他开关

`isAutoMemoryEnabled` / `isAutoMemoryConsumptionEnabled` / `isAutoMemoryUserScopeEnabled` /
`isAutoMemoryProjectScopeEnabled` / `isAutoMemoryHeadlessEnvEnabled` /
`isAutoMemoryFeatureGateEnabled` / `isAutoMemoryManuallyEnabled`，
以及 headless 环境覆写 `getAutoMemoryHeadless{Dream,Project,User}EnvOverride`。

## 目录布局

```js
// 配置根：$QODER_CONFIG_DIR，否则 <homedir>/.qoder（中国版 .qoder-cn）
Dr() = env.QODER_CONFIG_DIR ?? join(homedir(), oh)

Q7A()      = join(Dr(), "memory")                                  // user 作用域
getProjectMemoryDir() = join(Dr(), "projects", <projectId>, "memory")  // project 作用域
```

**关键差异**：项目记忆**不在项目目录里**，而在全局配置目录下的 `projects/<projectId>/memory`。
即作用域是「一个全局目录 + 每项目一个目录」，两者都在同一个配置根下。

`projectId` 由项目根路径推导（`DB()`）：

```js
sanitized = projectRoot.replace(/[^a-zA-Z0-9]/g, '-')
projectId = sanitized.length <= 200 ? sanitized : `${sanitized.slice(0,200)}-${Math.abs(djb2xor(projectRoot)).toString(36)}`
// djb2xor: e=5381; for c of s: e = 33*e ^ c.charCodeAt()
```

## 每个作用域目录里的文件

```js
_y = "MEMORY.md"                                     // 索引文件名
BFc = new Set(["user","feedback","project","reference"])   // 记忆类型

// 列出内容文件（Pae / mHe）：
readdir(dir).filter(n => n.endsWith('.md') && n !== 'MEMORY.md' && !n.startsWith('.'))
```

- **`MEMORY.md` 是索引，不是内容**。原文：「an index, not a dump」，整体在 25KB 以内，
  每条一行、约 150 字符以内，格式 `- [Title](file.md) - one-line hook`。
  生成时索引内容**直接喂给记忆 Agent**（「Never Read MEMORY.md」），改索引要写完整的新索引。
- **其余 `*.md` 是内容文件**，带 front-matter：

  ```
  ---
  name: <name>
  description: <description>
  type: user|feedback|project|reference
  ---

  <content>
  ```

  解析后 `type` 不在四个值内则回落到 `project`；`name` 缺省用文件名。

## 四种记忆类型

| type | 记什么 |
|---|---|
| `user` | 用户是谁：角色、专业领域、偏好、职责、知识背景 |
| `feedback` | 用户对你工作方式的指导：纠正与已确认的做法，**要带上原因（the why）** |
| `project` | 正在进行的工作、目标、约束；代码或 git 历史里推不出来的；相对日期要转成绝对日期 |
| `reference` | 外部系统里的资源及其用途（例如 bug 记在 Linear 的哪个项目、反馈在 Slack 的哪个频道） |

跨项目通用的 `feedback`/`reference` 才放 user 作用域；只属于当前项目的放 project 作用域。

## 另有两个流程（v1 未实现）

- **Daily Memory Journal**：会话结束后追加当日条目。工具调用形如
  `action:"add", target:"daily", chat_id, content`，内容是项目符号列表，
  **最多 8 条、每条 ≤120 字符**。排除已在 `MEMORY.md`/`USER.md`/`AGENTS.md` 里的信息。
- **Dream（记忆巩固）**：`origin: 'dream'`——这正是 SDK 类型里那个我原以为不可达的来源。
  提示词开头是 `# Dream: Memory Consolidation`，分阶段（Orient → 读取 → Consolidate），
  按「距上次巩固的小时数」调度，配置项形如 `auto-memory consolidation`（`minHoursBetweenRuns`）。

## 对 v1 的结论

v1 缺的不是「两个作用域」——那两个我有了——而是：

1. 项目记忆的位置错了：我放在 `<projectRoot>/.dsh/memory`，Qoder 放在 `<configDir>/projects/<id>/memory`；
2. **索引/内容分离**：我把 `MEMORY.md` 同时当索引和唯一写入目标，没有内容文件模型；
3. **四种记忆类型**（front-matter `type`）完全缺失；
4. Daily journal；
5. Dream 巩固流程（`origin: 'dream'`）。
