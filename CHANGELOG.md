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

**两级记忆开关：全局作用域 + 会话模式**

- **全局那层**（`/memory-scope all|project|user`，等价于配置里的 `userScope`/`projectScope`）：每个
  `auto` 会话跟随的作用域。插件改自己的配置走 harness 的 **`configEditor.edit`**；没有它（headless 组合）时
  命令会**说明**当前值并指出去配置里改，而不是假装改成功了。
- **会话那层**（对话页输入框里的**记忆按钮**，一次点击循环三态；`/memory-switch auto|project|off`）：
  `auto` 跟随全局（默认，什么都不存）· `project` **仅项目**（不加载也不写入跨项目知识）· `off` **关闭**。
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
  pass`）。`generation.maxWrites`（默认 **4**）是本插件自己的防跑飞上限——Qoder 的 SDK 与 qodercli
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
- **每一次成功的删除都是一次"无效输出"**：`memory` 工具声明了 `output.schema`，而 harness **拿它校验每个
  返回值**——多一个未声明的键就直接判失败：`tool "memory" returned invalid output:
  "value.files[0].deleted" is not a declared property (additionalProperties: false)`。而删除分支返回的正是
  `files: [{ …, deleted: true }]`，schema 里却没有这个字段。后果很有害：**文件真的被删掉了**，但模型收到的
  是一次失败的调用，于是它既不知道删成功了、也无法据此改写索引（而删除后不改索引正是本插件明说的坑）。
  修法是把它声明成真实（可选）属性。现在有一条测试**驱动真实的 harness 校验器**跑遍每个 action 的返回值
  （含各失败路径），所以这一类"schema 与实现不一致"的问题不会再漏过——按 action 写断言是抓不到它的，
  因为错的是 schema 本身。
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
- `client.js` 体积预算**两项都用满**：注入预览就是在"不抬上限"的前提下挤进去的——取代了那行事后
  消费清单、压掉 `qualityNotices` 里重复的 `note`+`push`、把命令列表并进标题行、正文折叠。
  下次动面板仍必须先腾地方（当前 560/560、220/220）。
- 删除的沙箱代价：插件自己的 `node:fs` 调用不被 confining 后端拦截，所以只读后端是**主动拒绝**。
- `projectKey` 有损：`D:\a-b` 与 `D:\a\b` 共用一个记忆目录——harness 自己的取舍，本插件继承。
