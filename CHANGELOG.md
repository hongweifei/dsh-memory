# Changelog

每一条记录都对应一个**发布版本**；逐轮开发过程不写在这里（那是提交与对话的事）。
格式沿用 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)。

**版本冻结在 `0.1.0`。** 做对齐本身不会发布新版本：改动累积，直到用户明确要求升级。
`test/discovery.test.mjs` 断言这个冻结值，误改会让测试红。升级是一次刻意的四处同步——
本文件、`package.json`、`README.md` 与那条断言。

早先用过的「1.0.0」「1.1.0」以及过渡期 `0.2.0`–`0.4.0`，都是对未完成工作的**过早标号**；
它们被折叠进下面这一个 `0.1.0`，而不是留成一段虚构的发布史。

---

## [0.1.0] — 第一个完成版本

把 **Qoder Agent SDK 的记忆契约**移植到 DeepSeek Harness。依据是**真实 SDK 包**
（`@qoder-ai/qoder-agent-sdk@1.0.50`）**加**本机 `qodercli` bundle 的解码，不是文档推测；
每一条契约行为都尽量引用解出的原文或代码。

### 新增

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
- **巩固（dream）**：`generation.dream`（默认关）+ `<DSH_HOME>/.consolidate-lock`，
  Qoder 的文件名与一小时窗口；死进程/过期的锁**会被删除并替换**。
- **环境变量覆写**：`DSH_MEMORY_HEADLESS|PROJECT|USER|DREAM`，同一套布尔词汇，环境优先。
- **索引约束**：写入时检查"约 25KB"与"单行超过约 200 字符"，报告进结果、日志与面板——**不拒绝**。

**界面**

- 设置面板（中英双语，真实 `--dsw-*` 主题 token）：状态、**作用域区（`user` 加每个有记忆的项目）**、
  每文件打开/删除、信任授权按钮、活动与告警（大文件/失败/被排除/被拦导入/**jit 跳过**/**索引告警**）、
  编辑器（作用域下拉 + 文件名 + 保存/重载/等待）。
- `/memory`、`/memory-trust`、`/memory-imports`、`/memory-delete`、`/memory-refresh`、`/memory-flush`。

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
| **daily journal** | QoderWork 桌面版的工具面（`action: "add", target: "daily"`），不是 SDK 记忆契约。 |
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

**309 项测试全绿**：unit 88 / integration 103 / model 40 / client 33 / architecture 13 /
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
- 索引告警 → `applyOneWrite` 不算告警，集成红在超限索引那条；把解出的原句改写，模型测试红。
- 失败原因 → 去掉 `summarizeWrites` 的回退，agent 测试红在 "a refused write with no stated
  reason still explains the failure"；把面板的 `last.reason` 拿掉，client 测试红在
  "the reason must reach the activity row"。
- 截断轮次 → 恢复"整轮丢弃"的旧写法，agent 测试红在 "a round cut short by the output cap
  still lands its tool calls"；把默认值改回 2000，unit 测试红在
  "resolveMemoryConfig fills the plugin defaults"。
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
- `client.js` 体积预算**两项都用满**（逻辑 559/560、内联数据 220/220）：下次动面板必须先腾地方。
- 删除的沙箱代价：插件自己的 `node:fs` 调用不被 confining 后端拦截，所以只读后端是**主动拒绝**。
- `projectKey` 有损：`D:\a-b` 与 `D:\a\b` 共用一个记忆目录——harness 自己的取舍，本插件继承。
