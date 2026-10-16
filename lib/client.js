/**
 * Client half of the dsh-memory bundle: the Settings → Memory panel.
 *
 * A plain script in the DSH client-module format (`window.__ModuleLoader__.load`), NOT an ES module:
 * the loader supplies `require` for React, so no import/export and no reaching into Host modules. Data
 * comes from the Host half's same-origin `/api/memory/*` routes, text from the plugin's `memory` locale
 * namespace, styling from `--dsw-*` tokens under `dshmem-`.
 *
 * @module @dsh-external/dsh-memory/client
 */
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-memory',
  factory(require) {
    var React = require('react')
    var h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    var NS = 'memory'

    /** English dictionary (the fallback locale). */
    var en = {
      title: 'Memory', intro: 'Persistent memory modelled on the Qoder Agent SDK: recorded after each turn, loaded under a token budget.',

      statusTitle: 'Status', plugin: 'Plugin', enabled: 'enabled', disabled: 'disabled', mode: 'Mode', generation: 'Generation',
      consumption: 'Consumption', on: 'on', off: 'off', gate: 'Gate',
      gateCustom: 'custom shouldGenerate (timeout {timeout}ms, onGateError={onGateError})', gateBuiltin: 'minPromptChars={minPromptChars}',
      pending: 'In-flight generations', dream: 'Consolidation', trust: 'Folder trust', trustOff: 'off (every folder is trusted)',
      trusted: 'trusted', untrusted: 'not trusted — project scope is skipped', trustGrant: 'Trust this folder', trustRevoke: 'Stop trusting',
      trustAllowed: 'Folder trusted: project memory is now in scope.', trustRevoked: 'Trust revoked: project memory is skipped again.',
      trustFailed: 'Could not change the trust decision.',
      // The composer control: five states, one label each, because a composer row has no room for a
      // sentence. The tooltip carries the rest — see `MemoryToggle`, which answers what is in effect,
      // what it means, and what the next click does. The "only" wording belongs HERE and not on the
      // global scope row: these five states are alternatives to each other, so "project only" says
      // something the bare word `project` does not.
      modeAuto: 'Auto', modeAll: 'User + project', modeUser: 'User only', modeProject: 'Project only', modeOff: 'Off',
      modeLabel: 'Memory in this session',
      // Several sessions are open and none was named, so the Host declined to say which one this page
      // is about. Reported as unknown rather than defaulted to "follows the global configuration".
      modeUnknown: 'not determinable (several sessions are open)',
      modeTitle: 'Now: {now} · {what} · Click for {next}',
      modeHintAuto: 'follows the global scopes: {state}',
      modeHintAll: 'both scopes for this session, whatever the global layer says',
      modeHintUser: 'cross-project (user) memory only — this project’s memory is neither loaded nor recorded',
      modeHintProject: 'project memory only — cross-project knowledge is neither loaded nor recorded',
      modeHintOff: 'nothing is injected into this session, and nothing from it is recorded',
      modeNoSession: 'This session has no id yet, so memory cannot be switched from here.',
      globalAll: 'user + project', globalProject: 'project', globalUser: 'user', globalNone: 'no scopes are on', globalScopes: 'Global scopes',
      globalScopesHint: 'What every session set to Auto loads and records. To stop memory entirely, use the plugin switch above.',
      scopesSaved: 'Global scopes saved: {state}.', scopesFailed: 'Could not save the global scopes.',
      modeFailed: 'Could not change this session’s memory.', scopesTitle: 'Scopes',
      writePolicy: 'Memory writes (memory-root = declares its own sandbox root | session = follows the session)',
      noScope: 'No scope is enabled.', projectsNote: 'Every project keeps its own memory; the active session is {cwd}',
      noFiles: 'No memory files yet.', scopeSummary: '{count} memory file(s){size}', open: 'Open', delete: 'Delete',
      deletedFile: 'Deleted {scope}:{path}.', deleteFailed: 'Could not delete the file.', writeRefused: 'Refused to write {path}: {error}',
      readOnly: 'read-only', readWrite: 'read-write',

      budgetTitle: 'Injection budget (consumption)', maxTokens: 'Injection cap (tokens)',
      // The plugin MODE. `native` has the runtime own the memory policy; `custom` uses what is
      // configured here. The hint says which one unlocks the cap, because that is the question a
      // locked-out user actually has.
      pluginModeNative: 'native (runtime decides)', pluginModeCustom: 'custom (you decide)',
      modeHint: 'Which contract this plugin runs under. “native” refuses every generation/consumption setting; “custom” accepts them. Switching to native removes the ones it refuses.',
      modeSaved: 'Mode saved: {mode}.', modeSavedDropped: 'Mode saved: {mode}. Removed so native accepts it: {keys}',
      // Qoder's own default is NO cap (`maxTokens ?? Infinity`), so the control's empty state means
      // "no limit" and not a number nobody chose. `0` is still refused: that is not a budget, and
      // "inject nothing" is a different switch — saying so is the difference between a control that
      // works and one that looks broken.
      maxTokensHint: 'How much memory may enter the context. Leave it empty for no limit (the default, as in Qoder). To inject nothing, turn consumption off — 0 is not a legal cap.',
      // The empty injection-cap box means NO limit, and says so in words: an empty control with no
      // explanation reads as unset/broken, and Qoder's own default is an absent cap.
      noLimit: 'no limit',
      // Qoder's two policy switches (`auto_memory_policy` / `auto_dream`), under this port's names.
      policyHint: 'Whether the automatic pass, consolidation, and the daily journal run. Turning the pass off also disables its per-turn trigger, which the SDK refuses to leave enabled.',
      // The daily journal (Qoder's `action: "add"`, `target: "daily"`).
      journal: 'Daily journal',
      journalWhere: 'Journal entries go to {scope}, in a {dir}/ subdirectory — a record of the day, never injected into the context.',
      scopeUser: 'the user scope', scopeProject: 'the project scope',
      // A short in-row label for the first toggle; the row's own label is `generation`, and the second
      // toggle reuses `dream` ("Consolidation" / "记忆巩固") so one term names one thing.
      generationShort: 'Automatic',
      policySaved: 'Saved.', policySavedImplied: 'Saved. Also changed to keep the configuration valid: {keys}',
      policyFailed: 'Could not save these switches.',
      policyEnvPinned: 'These are pinned by an environment variable, so changing them here would have no effect: {keys}',
      // `mode: native` refuses every consumption override, so the value is shown and the edit withheld.
      budgetLockedHint: 'Read-only in mode "native", which delegates the memory policy to the runtime. Set the plugin to `mode: custom` to change this cap.',
      capSaved: 'Injection cap saved: {tokens} tokens.', capSavedUnlimited: 'Injection cap cleared: no limit.',
      capFailed: 'Could not save the injection cap.',
      // Self-update: this plugin's own checkout against its git remote. The Host runs git; the
      // panel only shows the verdict and offers the one verb that fits it.
      update: 'Plugin update', updateCheck: 'Check', updateApply: 'Update now',
      updateApplied: 'Updated — restart `dsh web` to load the new host half (the panel then only needs a refresh).',
      updateChecked: 'Checked.', updateRejected: 'Not applied: {reason}', updateFailed: 'Update request failed.',
      updateBehind: '{count} commit(s) behind',
      updateOff: 'checks off', updateUnknown: 'not checked yet', updateUpToDate: 'up to date',
      updateAhead: 'ahead of the remote', updateDiverged: 'diverged from the remote',
      updateUnavailable: 'cannot check', updateUpdated: 'updated', updateRefused: 'not applied',
      updateStatusFailed: 'failed', updateRestartHint: 'restart dsh web',
      overflow: 'If it does not fit (truncate | fail_query)', failureMode: 'If a file fails to load (best_effort | fail_query)',
      generationCap: 'Generation output cap (0 = model default)', pauseAfter: 'Pause after N consecutive failures (0 = never)',
      previewRun: 'Preview',
      previewHint: 'What the next step actually sends. Computed by running the real pass and discarding it, so the panel never changes what it describes.',
      previewStep: 'Next step', previewSnapshot: 'Full block for a fresh session', previewUnavailable: 'No preview: {reason}',
      // The verdicts, translated: the raw codes go in the tooltip, never on the panel face.
      previewActionSilent: 'nothing (unchanged)', previewActionSnapshot: 'the full block',
      previewActionDelta: 'only what changed', previewActionNone: 'nothing (nothing to inject)',
      previewActionOther: 'an action this panel does not know',
      // Shown when the Host sent no block to measure (a muted session answers with the verdict alone).
      previewTokensOnly: '{tokens} tokens',
      // Shown when the Host had no session to speak for. The settings page is a global surface, so
      // this is the normal case there, not an error.
      previewGlobal: 'No session is open, so this is what a session starting now would receive.',
      previewTokens: '{tokens} of {max} tokens used',

      activityTitle: 'Latest activity', lastGeneration: 'Last generation', lastDream: 'Last consolidation', noneYet: 'none yet',
      turn: 'turn {turn}',

      editorTitle: 'Edit memory file', load: 'Load', save: 'Save', reload: 'Reload into session', flush: 'Flush generations',
      filenamePlaceholder: 'MEMORY.md', contentPlaceholder: 'Markdown memory notes…',

      loadedBytes: 'Loaded {bytes} bytes.', savedFile: 'Saved {scope}:{path} ({bytes} bytes).', reloaded: 'Reloaded memory into this session.',
      nothingToReload: 'Nothing to reload: {reason}', flushed: 'Flushed {count} generation(s).', loadFailed: 'Could not load the file.',
      saveFailed: 'Save failed.', refreshFailed: 'Refresh failed.', flushFailed: 'Flush failed.', unavailable: 'Memory status is unavailable.',

      // One datum, not six keys: it renders as one line, and six keys spent six
      // inline-data lines to say one sentence.
      commands: '/memory · /memory-refresh · /memory-flush · /memory-delete · /memory-trust · /memory-resume · /memory-switch',

      largeFile: 'Large {path} will impact performance ({chars} chars > {limit})', failedFile: 'Failed to load {path}: {error}',
      excludedFiles: '{count} file(s) skipped by the exclusion patterns.',
      blockedImports: '{count} external @import(s) blocked: outside the allowed roots.',
      jitSkipped: '{count} file(s) not loaded yet: no path this session touched matched {paths}', indexWarning: 'Index {path}: {message}',
    }

    /** Chinese dictionary. */
    var zh = {
      title: '记忆', intro: '参照 Qoder Agent SDK 的持久记忆：每轮结束后记录，按 token 预算加载。',

      statusTitle: '状态', plugin: '插件', enabled: '已启用', disabled: '已禁用', mode: '模式', generation: '生成', consumption: '消费', on: '开', off: '关',
      gate: '闸门', gateCustom: '自定义 shouldGenerate（超时 {timeout}ms，onGateError={onGateError}）', gateBuiltin: 'minPromptChars={minPromptChars}',
      pending: '进行中的生成', dream: '记忆巩固', trust: '目录信任', trustOff: '未启用（所有目录都受信任）', trusted: '已信任', untrusted: '未信任——跳过项目作用域', trustGrant: '信任此目录',
      trustRevoke: '取消信任', trustAllowed: '已信任该目录：项目记忆现在会被加载。', trustRevoked: '已取消信任：重新跳过项目记忆。', trustFailed: '无法更改信任状态。', modeAuto: '跟随全局',
      modeAll: '用户 + 项目', modeUser: '仅用户', modeProject: '仅项目', modeOff: '已关闭', modeLabel: '本会话的记忆',
      modeUnknown: '无法确定（当前打开了多个会话）',
      modeTitle: '当前：{now} · {what} · 点击切到{next}',
      modeHintAuto: '按全局作用域来：{state}',
      modeHintAll: '本会话同时用两个作用域，不管全局那一层怎么设',
      modeHintUser: '只读写跨项目（用户）记忆，本项目记忆既不加载也不记录',
      modeHintProject: '只读写本项目记忆，跨项目知识既不加载也不记录',
      modeHintOff: '不注入任何记忆，也不记录任何记忆',
      globalAll: '用户 + 项目', globalProject: '项目', globalUser: '用户', globalNone: '未开启任何作用域', globalScopes: '全局作用域',
      globalScopesHint: '所有「跟随全局」的会话按这个加载和记录。要彻底停止记忆，请用上面的插件开关。',
      scopesSaved: '全局作用域已保存：{state}。', scopesFailed: '无法保存全局作用域。',
      modeNoSession: '本会话还没有 id，无法从这里切换记忆。',
      modeFailed: '无法更改本会话的记忆设置。', scopesTitle: '作用域', writePolicy: '记忆写入（memory-root＝自声明沙箱根 | session＝跟随会话策略）', noScope: '未启用任何作用域。',
      projectsNote: '每个项目各自一份记忆；当前会话是 {cwd}', noFiles: '暂无记忆文件。', scopeSummary: '{count} 个记忆文件{size}', open: '打开', delete: '删除',
      deletedFile: '已删除 {scope}:{path}。', deleteFailed: '无法删除该文件。', writeRefused: '写入被拒 {path}：{error}', readOnly: '只读', readWrite: '读写',

      budgetTitle: '注入预算（消费半）', maxTokens: '注入上限（token）',
      maxTokensHint: '允许进入上下文的记忆上限。留空＝不设上限（默认，与 Qoder 相同）；要完全不注入请关掉消费开关——0 不是合法的上限。',
      noLimit: '不设上限',
      policyHint: '是否跑自动记录、记忆巩固与日刊。关掉自动记录时会连同它的「每轮触发」一起关掉——SDK 不允许两者并存。',
      journal: '日刊',
      journalWhere: '日刊写入{scope}的 {dir}/ 子目录——它是当天的记录，不会被注入上下文。',
      scopeUser: '用户作用域', scopeProject: '项目作用域',
      generationShort: '自动记录',
      policySaved: '已保存。', policySavedImplied: '已保存。为保持配置合法，同时改了：{keys}',
      policyFailed: '无法保存这两个开关。',
      policyEnvPinned: '这两项被环境变量固定，在这里改不会生效：{keys}',
      budgetLockedHint: '「native」模式下这一项是只读的：该模式把记忆策略交给运行时决定。把上面的「模式」改成 custom 就能改这里。',
      pluginModeNative: 'native（运行时决定）', pluginModeCustom: 'custom（自己配置）',
      modeHint: '插件按哪套契约运行。「native」拒绝所有生成/消费设置；「custom」接受它们。切到 native 时会移除它不接受的项。',
      modeSaved: '模式已保存：{mode}。', modeSavedDropped: '模式已保存：{mode}。为让 native 接受，已移除：{keys}',
      capSaved: '注入上限已保存：{tokens} token。', capSavedUnlimited: '已清除注入上限：不设上限。', capFailed: '无法保存注入上限。',
      update: '插件更新', updateCheck: '检查更新', updateApply: '立即更新',
      updateApplied: '已更新——重启 `dsh web` 才会加载新的 host 半（面板只需刷新页面）。',
      updateChecked: '已检查。', updateRejected: '未应用：{reason}', updateFailed: '更新请求失败。',
      updateBehind: '落后 {count} 个提交',
      updateOff: '已关闭检查', updateUnknown: '尚未检查', updateUpToDate: '已是最新',
      updateAhead: '领先远端（有本地提交）', updateDiverged: '与远端分叉',
      updateUnavailable: '无法检查', updateUpdated: '已更新', updateRefused: '未应用',
      updateStatusFailed: '失败', updateRestartHint: '重启 dsh web 生效',
      overflow: '超限处理（truncate | fail_query）', failureMode: '失败处理（best_effort | fail_query）',
      generationCap: '生成输出上限（0＝模型默认）', pauseAfter: '连续失败几次暂停（0＝永不）', previewRun: '预览',
      previewHint: '下一步实际会发出去的内容。做法是把真实消费跑一遍再丢掉结果，所以看一眼面板不会改变它描述的行为。', previewStep: '下一步', previewSnapshot: '新会话会收到的完整块',
      previewUnavailable: '无法预览：{reason}', previewTokens: '占用 {tokens}／{max} token',
      previewActionSilent: '什么都不发（未变化）', previewActionSnapshot: '整块',
      previewActionDelta: '只发变动', previewActionNone: '什么都不发（没有可注入的内容）',
      previewActionOther: '本面板不认识的动作',
      previewTokensOnly: '占用 {tokens} token',
      previewGlobal: '当前没有打开的会话，所以这是「现在新开一个会话」会收到的内容。',

      activityTitle: '最近活动', lastGeneration: '最近一次生成', lastDream: '最近一次巩固', noneYet: '暂无', turn: '第 {turn} 轮',

      editorTitle: '编辑记忆文件', load: '载入', save: '保存', reload: '重新加载进会话', flush: '等待生成完成', filenamePlaceholder: 'MEMORY.md',
      contentPlaceholder: 'Markdown 记忆内容…',

      loadedBytes: '已载入 {bytes} 字节。', savedFile: '已保存 {scope}:{path}（{bytes} 字节）。', reloaded: '已重新加载记忆到当前会话。',
      nothingToReload: '无需重新加载：{reason}', flushed: '已等待 {count} 个生成完成。', loadFailed: '无法载入该文件。', saveFailed: '保存失败。', refreshFailed: '重新加载失败。',
      flushFailed: '等待失败。', unavailable: '记忆状态不可用。',

      commands: '/memory · /memory-refresh · /memory-flush · /memory-delete · /memory-trust · /memory-resume · /memory-switch',

      largeFile: '记忆文件过大，会影响性能（{path}：{chars} 字符 > {limit}）', failedFile: '载入失败 {path}：{error}', excludedFiles: '已按排除规则跳过 {count} 个文件。',
      blockedImports: '已拦截 {count} 个外部 @import：超出了允许的目录。', jitSkipped: '有 {count} 个文件尚未加载：本会话触及的路径没有匹配 {paths}',
      indexWarning: '索引 {path}：{message}',
    }

    /** Fetch one JSON endpoint; resolves to { ok, status, data } and never throws. */
    function api(path, init) {
      return fetch(path, init)
        .then(function (response) {
          return response
            .json()
            .catch(function () {
              return null
            })
            .then(function (data) {
              return { ok: response.ok, status: response.status, data: data }
            })
        })
        .catch(function (error) {
          return { ok: false, status: 0, data: { error: String(error && error.message ? error.message : error) } }
        })
    }

    /** Re-read one endpoint on an interval, and once immediately.
     *
     * A custom hook because BOTH the panel (5s status) and the composer button (10s session mode) need
     * this, and two hand-rolled effect/interval/clear pairs is how one of them ends up with a leaked
     * timer. Returns nothing: the loader owns its own state. */
    function usePoll(load, ms, enabled) {
      React.useEffect(
        function () {
          if (enabled === false) return undefined
          load()
          var timer = setInterval(load, ms)
          return function () {
            clearInterval(timer)
          }
        },
        [load, ms, enabled],
      )
    }

    /** Stylesheet, prefixed `dshmem-`. Copied from the Harness UI primitives (Button,
     * settings-form/fields, Tag, Input in @deepseek-ai/dsh-client-ui-primitives) so this page matches
     * host controls: same radii, heights, type sizes, 0.5px strokes, hover/active fills, focus rings.
     * Only `--dsw-*` tokens, never a literal colour. */
    var CSS = [
      '.dshmem-page{color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px;line-height:1.5}.dshmem-section{padding:12px 0;border-top:0.5px solid var(--dsw-alias-border-l2)}.dshmem-section:first-child{border-top:none;padding-top:0}',
      '.dshmem-title{margin:0 0 8px;font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary)}.dshmem-intro{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
      // `keep-all` + `max-content` keep a long value from collapsing a CJK label.
      '.dshmem-field{display:flex;align-items:baseline;gap:12px;padding:8px 0}.dshmem-field+.dshmem-field{border-top:0.5px solid var(--dsw-alias-border-l2)}',
      '.dshmem-label{flex:1 1 auto;min-width:max-content;word-break:keep-all;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.dshmem-value{flex:0 1 auto;min-width:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary);text-align:right;overflow-wrap:anywhere}',
      '.dshmem-mono{font-family:var(--dsw-font-markdown-code-font-family);font-size:12px;word-break:break-all}',
      '.dshmem-list{border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);overflow:hidden;margin-top:8px}.dshmem-scope-row+.dshmem-scope-row{border-top:0.5px solid var(--dsw-alias-border-l2)}',
      '.dshmem-scope{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;list-style:none}.dshmem-scope:hover{background:var(--dsw-alias-interactive-bg-hover)}.dshmem-scope::-webkit-details-marker{display:none}',
      '.dshmem-caret{flex:none;font-size:12px;line-height:1;color:var(--dsw-alias-label-tertiary);transition:transform 0.15s}.dshmem-scope-row[open] .dshmem-caret{transform:rotate(90deg)}',
      '.dshmem-scope-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}.dshmem-scope-body{padding:0 12px 10px 30px}',
      '.dshmem-scope-head{display:flex;align-items:center;gap:6px;min-width:0}.dshmem-scope-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.dshmem-tag{display:inline-flex;align-items:center;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap}.dshmem-tag[data-tone=\'outline\']{border:0.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary)}.dshmem-tag[data-tone=\'quiet\']{color:var(--dsw-alias-label-tertiary)}',
      ".dshmem-tag[data-tone='success']{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary)}.dshmem-tag[data-tone='warning']{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary)}",
      '.dshmem-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);cursor:pointer}.dshmem-btn:disabled{cursor:not-allowed;opacity:0.4}.dshmem-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.dshmem-btn-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.dshmem-btn-outline:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}.dshmem-btn-outline{border:0.5px solid var(--dsw-alias-border-l3)}.dshmem-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}.dshmem-btn-danger{color:var(--dsw-alias-label-error);border-color:currentColor}',
      '.dshmem-input{box-sizing:border-box;height:34px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);min-width:0}.dshmem-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}.dshmem-grow{flex:1;min-width:120px}',
      // A `select` is not a button: input height, explicit background, arrow room, themed options.
      '.dshmem-select{box-sizing:border-box;height:34px;padding:0 24px 0 10px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}.dshmem-select option{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}',
      '.dshmem-textarea{box-sizing:border-box;width:100%;min-height:180px;margin-top:8px;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font-family:var(--dsw-font-markdown-code-font-family);font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary);resize:vertical}.dshmem-textarea:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      // A read-only PRE holding injected memory must WRAP. `<pre>` defaults to `white-space: pre`, so
      // a long line — and memory is prose plus file paths — ran off the right edge and was clipped
      // mid-word with no way to read it. `pre-wrap` keeps the newlines while wrapping, `break-word`
      // handles an unbroken path, and the `overflow` guards a stray long token in an older browser.
      '.dshmem-pre{white-space:pre-wrap;overflow-wrap:break-word;word-break:break-word;overflow-x:auto;max-width:100%}',
      '.dshmem-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:12px}.dshmem-trust{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:none}',
      // A file row is name + an action group: grouping keeps `space-between` from
      // splitting the action buttons onto their own line.
      '.dshmem-file{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0}.dshmem-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;word-break:normal}.dshmem-actions{display:flex;align-items:center;gap:4px;flex:none}',
      '.dshmem-note{margin:8px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}.dshmem-note-error{color:var(--dsw-alias-label-error)}.dshmem-note-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.dshmem-code{font-family:var(--dsw-font-markdown-code-font-family);font-size:12px}.dshmem-muted{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6}',
      // The composer button: compact, and its own class so nothing here can reach the panel. The
      // dot carries the state at a glance, because the label is a word inside a busy tool row.
      '.dshmem-quick{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}.dshmem-quick:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dshmem-quick:disabled{cursor:not-allowed;opacity:0.4}',
      // The tone says WHICH KIND of state at a glance: green follows the configuration, blue is
      // pinned for this session alone, amber is muted. Every state in `SESSION_MODES` must appear
      // here — one left out would fall back to neutral grey and read as "nothing is set", so
      // `test/client.test.mjs` walks the list and asserts each has a rule.
      '.dshmem-quick-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}.dshmem-quick[data-state=\'auto\'] .dshmem-quick-dot{background:var(--dsw-alias-state-success-primary)}.dshmem-quick[data-state=\'all\'] .dshmem-quick-dot,.dshmem-quick[data-state=\'user\'] .dshmem-quick-dot,.dshmem-quick[data-state=\'project\'] .dshmem-quick-dot{background:var(--dsw-alias-state-business-primary)}.dshmem-quick[data-state=\'off\'] .dshmem-quick-dot{background:var(--dsw-alias-state-warn-primary)}.dshmem-quick[data-state=\'error\'] .dshmem-quick-dot{background:var(--dsw-alias-label-error)}',
    ].join('\n')

    /** Tag tones, mirroring the primitive's `data-tone` vocabulary. */
    function Tag(props) {
      return h('span', { className: 'dshmem-tag', 'data-tone': props.tone }, props.children)
    }
    /** One label / value line: `value` is a string (mono) or a node. */
    function Row(label, value) {
      return h('div', { className: 'dshmem-field' },
        h('span', { className: 'dshmem-label' }, label),
        typeof value === 'string' ? h('span', { className: 'dshmem-value dshmem-mono' }, value) : value)
    }

    /** The trust badge: the decision, not the switch. */
    function TrustTag(trust, t) {
      if (trust === null || trust === undefined) return h(Tag, { tone: 'quiet' }, t('noneYet'))
      if (trust.enabled !== true) return h(Tag, { tone: 'quiet' }, t('trustOff'))
      const trusted = trust.trusted === true
      return h(Tag, { tone: trusted ? 'success' : 'warning' }, trusted ? t('trusted') : t('untrusted'))
    }

    /** The on/off badge every boolean status row shares. */
    function OnOff(on, t) {
      return h(Tag, { tone: on ? 'success' : 'quiet' }, on ? t('on') : t('off'))
    }

    /** One boolean as a two-state picker. A `<select>` rather than a checkbox so the current value is
     * readable without knowing which way a tick means, and so the value sent is the string the route
     * narrows — never a truthy coercion. */
    function Toggle(props) {
      var value = props.value ? 'true' : 'false'
      return h('select', {
        className: 'dshmem-select ' + props.className,
        value: value,
        disabled: props.disabled === true,
        onChange: function (event) { props.onPick(event.target.value === 'true') },
      },
        h('option', { key: 'on', value: 'true' }, props.t('on')),
        h('option', { key: 'off', value: 'false' }, props.t('off')))
    }

    /** The trust row: the decision, the folder, and — when the gate is on — its button. */
    function TrustRow(trust, t, onSet, busy) {
      var tag = TrustTag(trust, t)
      if (trust === null || trust === undefined || trust.enabled !== true) return tag
      var trusted = trust.trusted === true
      // Its own class: `.dshmem-toolbar` carries the editor's top padding.
      return h('span', { className: 'dshmem-trust' },
        tag,
        h('span', { className: 'dshmem-muted dshmem-mono' }, trust.folder || ''),
        Button({ disabled: busy, onClick: () => onSet(trusted ? 'deny' : 'allow'), children: trusted ? t('trustRevoke') : t('trustGrant') }))
    }

    /** The self-update row: where this plugin's checkout stands, and the one verb that fits.
     *
     * The Host runs git (`update.mode`), the panel never does — so this is a verdict plus a button.
     * `behind` is the only actionable state, and it is the only one that offers `Update now`. */
    function UpdateRow(update, t, busy, onUpdate) {
      var state = update === null || update === undefined ? { status: 'unknown' } : update
      var known = Object.prototype.hasOwnProperty.call(UPDATE_STATUS_KEYS, state.status)
      // The raw verdict and git's own reason are diagnostics: they ride on the tooltip, never in the
      // sentence, so a Chinese panel never prints `diverged` or an untranslated git error.
      var title = [state.status, state.reason].filter(Boolean).join(' — ')
      var bits = [state.status === 'behind' ? t('updateBehind', { count: state.behind ?? 0 }) : t(known ? UPDATE_STATUS_KEYS[state.status] : 'updateUnknown')]
      if (typeof state.current === 'string' && state.current.length > 0) bits.push(state.current)
      if (state.status === 'behind' && typeof state.latest === 'string' && state.latest.length > 0) bits.push('→ ' + state.latest)
      // An update has already happened: the checkout is current, but the RUNNING host half is not
      // until the next start. Saying that after the fact is the whole point of `justUpdated`.
      if (state.justUpdated === true) bits.push(t('updateRestartHint'))
      return h('div', { className: 'dshmem-field' },
        h('span', { className: 'dshmem-label' }, t('update')),
        h('span', { className: 'dshmem-value dshmem-mono', title: title }, bits.join(' · ')),
        state.mode === 'off' ? null : Button({
          disabled: busy,
          onClick: function () { onUpdate(state.status === 'behind' ? 'apply' : 'check') },
          children: t(state.status === 'behind' ? 'updateApply' : 'updateCheck'),
        }))
    }

    /** The load-quality warnings Qoder's own UI raises (huge, unreadable, excluded). */
    function qualityNotices(status, t) {
      const change = status.memoryChange
      if (!change) return []
      const last = status.lastGeneration
      const notices = []
      const push = (key, tone, text) => notices.push(h('div', { key: key, className: tone.length > 0 ? 'dshmem-note ' + tone : 'dshmem-note' }, text))
      const warn = 'dshmem-note-warn'
      const bad = 'dshmem-note-error'
      // One advisory line per aggregate, each only when it has something to say.
      for (const file of change.largeFiles || []) push('large-' + file.path, warn, t('largeFile', { path: file.path, chars: file.characterCount, limit: status.largeFileLimit }))
      for (const file of change.failedFiles || []) push('failed-' + file.path, bad, t('failedFile', { path: file.path, error: file.error }))
      const excluded = (change.excludedFiles || []).length
      if (excluded > 0) push('excluded', '', t('excludedFiles', { count: excluded }))
      // Qoder warns when an external `@import` was refused: a silently unexpanded reference is
      // invisible. A file held back by its own `paths` glob is present but not loaded either.
      const blocked = (change.pendingExternalImports || []).length
      if (blocked > 0) push('blocked', warn, t('blockedImports', { count: blocked }))
      const jit = change.jitSkipped || []
      if (jit.length > 0) push('jit', '', t('jitSkipped', { count: jit.length, paths: jit.map((file) => file.path).join(', ') }))
      // Advisory index limits and refused writes ride on the last generation: the warning belongs
      // where it was decided. `failed` means writes were asked for and none landed.
      for (const file of (last && last.writtenFiles) || []) for (const warning of file.warnings || []) push('index-' + file.path, warn, t('indexWarning', { path: file.path, message: warning.message }))
      for (const file of (last && last.failedFiles) || []) push('refused-' + file.path, bad, t('writeRefused', { path: file.path, error: file.error }))
      return notices
    }

    /** The injection preview: the verdict for the next step, plus the block a session with no
     * baseline receives. The verdict is the half that matters — most steps are `silent`, and a panel
     * showing only the full block would teach the opposite of the truth. */
    function PreviewCard(preview, t, busy, onRun) {
      // NOT every available payload carries a `snapshot`: a muted session answers with the verdict
      // ALONE (running the pass would describe a step that will not happen). Reading
      // `preview.snapshot.maxTokens` unguarded therefore threw — the panel broke on exactly the state
      // the preview is most useful in. Same for `step.changed`, which that payload also omits.
      var snapshot = preview !== null && preview.available === true ? preview.snapshot : undefined
      var step = preview !== null && preview.available === true ? preview.step : undefined
      // The step's OWN cost when the Host gives one, else the block's: "0 of N" beside a full block is
      // worse than the block's own number.
      var tokens = step === undefined ? 0 : (step.tokens ?? (snapshot === undefined ? 0 : snapshot.tokens))
      var maxTokens = snapshot === undefined ? undefined : snapshot.maxTokens
      var note =
        preview === null ? t('previewHint')
        : preview.available !== true ? t('previewUnavailable', { reason: preview.reason || t('noneYet') })
        : maxTokens === undefined ? t('previewTokensOnly', { tokens: tokens })
        : t('previewTokens', { tokens: tokens, max: maxTokens })
      var bar = h('div', { className: 'dshmem-toolbar' }, Button({ disabled: busy, onClick: onRun, children: t('previewRun') }), h('span', { className: 'dshmem-muted' }, note))
      if (preview === null || preview.available !== true) return bar
      var shown = step.text || (snapshot === undefined ? undefined : snapshot.text)
      var changed = Array.isArray(step.changed) ? step.changed : []
      return h('div', null, bar,
        // WHICH question this answered. The settings page is a global surface with no session in
        // scope, and the Host then previews what a session starting NOW would receive — a different
        // claim from "your next step", so it is stated rather than left to be inferred.
        preview.scope === 'global' ? h('div', { className: 'dshmem-muted' }, t('previewGlobal')) : null,
        // The action word is the Host's own vocabulary (`silent`/`snapshot`/`delta`/`none`). It is
        // TRANSLATED, not printed raw: a Chinese panel reading "snapshot" is the half-English panel
        // this project refuses, and the raw code stays as the tooltip along with the machine reason.
        h('div', { className: 'dshmem-field', title: [step.action, step.reason].filter(Boolean).join(' — ') },
          h('span', { className: 'dshmem-label' }, t('previewStep')),
          h('span', { className: 'dshmem-value dshmem-mono' }, t(PREVIEW_ACTIONS[step.action] || 'previewActionOther') + (changed.length > 0 ? ' · ' + changed.join(', ') : ''))),
        // The same `▸` the scope rows use: without it the fold is invisible.
        shown === undefined ? null : h('details', { className: 'dshmem-scope-row' }, h('summary', { className: 'dshmem-scope' }, h('span', { className: 'dshmem-caret' }, '▸'), t('previewSnapshot')), h('pre', { className: 'dshmem-textarea dshmem-mono dshmem-pre', readOnly: true }, shown)))
    }

    /** One scope row: name, size; its files fold out beneath it. */
    function ScopeCard(root, t, onOpen, onDelete) {
      var writable = root.access === 'read-write'
      var files =
        root.files.length === 0
          ? h('div', { className: 'dshmem-muted' }, t('noFiles'))
          : root.files.map(function (file) {
              return h('div', { key: file, className: 'dshmem-file' },
                h('span', { className: 'dshmem-mono dshmem-name', title: file }, file),
                h('span', { className: 'dshmem-actions' },
                  Button({ onClick: () => onOpen(root.id, file), children: t('open') }),
                  // A read-only scope must not offer a delete it would refuse.
                  writable ? Button({ tone: 'danger', onClick: () => onDelete(root.id, file), children: t('delete') }) : null))
            })
      return h('details', { key: root.id, className: 'dshmem-scope-row' },
        h('summary', { className: 'dshmem-scope' },
          h('span', { className: 'dshmem-scope-text' },
            h('span', { className: 'dshmem-scope-head' },
              // The caret belongs on the name's line, not floating between the two. The row title is
              // the workspace name; the slug stays the tooltip (what the scope is addressed by).
              h('span', { className: 'dshmem-caret', 'aria-hidden': 'true' }, '▸'),
              h('span', { className: 'dshmem-scope-name', title: root.id }, root.label === undefined ? root.id : root.label),
              h(Tag, { tone: writable ? 'outline' : 'quiet' }, writable ? t('readWrite') : t('readOnly'))),
            h('span', { className: 'dshmem-muted' },
              // The host may not send `size`: the value is left out, never dashed.
              t('scopeSummary', { count: root.files.length, size: root.size === undefined ? '' : ' · ' + root.size })))),
        h('div', { className: 'dshmem-scope-body' }, h('div', { className: 'dshmem-muted dshmem-mono' }, root.path), files))
    }

    /** A labelled section wrapper: `Section(title, child, child, …)`. Children are spread
     * as separate createElement arguments, not one array: an array child is a keyed React
     * list and would warn about missing `key`s on these static rows. */
    function Section(title) {
      var args = ['div', { className: 'dshmem-section' }, h('div', { className: 'dshmem-title' }, title)]
      for (var index = 1; index < arguments.length; index += 1) args.push(arguments[index])
      return h.apply(null, args)
    }

    /** A themed control button: `tone` is `outline` (default) or `primary`. */
    function Button(props) {
      return h('button', {
        type: 'button',
        className: 'dshmem-btn dshmem-btn-' + (props.tone === 'primary' || props.tone === 'danger' ? props.tone : 'outline'),
        disabled: props.disabled === true,
        onClick: props.onClick,
      }, props.children)
    }

    /** One editable settings row: label, control, Save, and a note. Draft + explicit Save, because a
     * control that wrote on every keystroke would persist `1` on the way to `1500`. */
    function Editor(label, control, note, button) {
      return h('div', null,
        h('div', { className: 'dshmem-field' }, h('span', { className: 'dshmem-label' }, label), control, button),
        note === null ? null : h('div', { className: 'dshmem-muted' }, note))
    }

    /** The Settings → Memory page; `t` comes from the slot's locale namespace. */
    function MemorySection(props) {
      var t = props.t
      var [status, setStatus] = React.useState(null)
      var [scope, setScope] = React.useState('project')
      var [name, setName] = React.useState('MEMORY.md')
      var [text, setText] = React.useState('')
      var [message, setMessage] = React.useState(null)
      var [busy, setBusy] = React.useState(false)
      // The preview is the one panel action that reads every memory file, so it loads on
      // demand — never on the 5s status poll, which would re-read the block forever.
      var [preview, setPreview] = React.useState(null)
      // The injection cap being edited, or `null` while it mirrors the Host: the poll must not
      // overwrite what someone is typing, and `null` is what makes "unchanged" detectable. `scopes`
      // and `pluginMode` are the other two drafts, the same way.
      var [cap, setCap] = React.useState(null)
      var [scopes, setScopes] = React.useState(null)
      var [pluginMode, setPluginMode] = React.useState(null)
      // The two Qoder policy switches (`auto_memory_policy` / `auto_dream`) as drafts, `null` while they
      // mirror the Host. They are independent toggles but ONE write: both travel in one request, so a
      // Save that is offered for one cannot leave the other behind.
      var [generation, setGeneration] = React.useState(null)
      var [dream, setDream] = React.useState(null)
      // Qoder's Daily Memory Journal, the third policy switch written by the same request.
      var [journal, setJournal] = React.useState(null)

      var load = React.useCallback(function () {
        return api('/api/memory/status').then(function (result) {
          setStatus(result.ok ? result.data : null)
          return result
        })
      }, [])

      usePoll(load, 5000)

      var openFile = React.useCallback(function (nextScope, nextName) {
        setScope(nextScope)
        setName(nextName)
        setMessage(null)
        return api('/api/memory/file?scope=' + encodeURIComponent(nextScope) + '&path=' + encodeURIComponent(nextName)).then(function (result) {
          var ok = result.ok && result.data !== null
          setText(ok ? result.data.text || '' : '')
          setMessage(ok
            ? { kind: 'ok', text: t('loadedBytes', { bytes: result.data.bytes }) }
            : { kind: 'error', text: (result.data && result.data.error) || t('loadFailed') })
        })
      }, [t])

      /** Run one panel action: busy flag, one request, one message, never a throw. `settle` lets a
       * caller that renders its own presentation (the preview) take the response instead of a
       * message line, and own success and failure alike. */
      var act = React.useCallback(
        function (path, init, ok, failed, settle) {
          setBusy(true)
          setMessage(null)
          return api(path, init)
            .then(function (result) {
              if (settle !== undefined) settle(result)
              else if (result.ok && result.data) setMessage({ kind: 'ok', text: ok(result.data) })
              else setMessage({ kind: 'error', text: (result.data && result.data.error) || t(failed) })
              return result
            })
            .then(function (result) {
              setBusy(false)
              return result
            })
        },
        [t],
      )

      /** One POST with a JSON body (`undefined` sends none), reported through `act`. Four panel
       * actions share this exact shape; spelling it out per action is how one of them drifts. */
      var post = React.useCallback(
        function (path, body, ok, failed) {
          var init = { method: 'POST' }
          if (body !== undefined) {
            init.headers = { 'content-type': 'application/json' }
            init.body = JSON.stringify(body)
          }
          return act(path, init, ok, failed)
        },
        [act],
      )

      /** Save one editable value and re-read status, so the row shows the PERSISTED value.
       *
       * Both writable values are this same shape — a POST, a message, and the draft cleared only on
       * success (a rejection has to leave the value in place to be fixed) — so they share one function
       * rather than two copies that can drift. `clear` names the setter holding the draft. */
      var saveSetting = React.useCallback(
        function (path, body, clear, ok, failed) {
          return post(path, body, ok, failed).then(function (result) {
            if (result.ok && result.data) clear(null)
            return load()
          })
        },
        [post, load],
      )

      /** Save the injection cap. An EMPTY box is the one spelling of "no limit" on the wire (`null`),
       * which the route turns into Qoder's own expression of it: the key is REMOVED. A zero would be a
       * different statement (and the schema refuses it), and `Infinity` is not valid JSON. */
      var saveCap = React.useCallback(function () {
        var next = cap === '' ? null : Number(cap)
        var ok = function (data) { return data.maxTokens === null ? t('capSavedUnlimited') : t('capSaved', { tokens: data.maxTokens }) }
        return saveSetting('/api/memory/budget', { maxTokens: next }, setCap, ok, 'capFailed')
      }, [saveSetting, cap, t])

      /** Check for, or apply, an update of this plugin's own checkout. The Host decides what the
       * verdict means (it runs git); the panel reports the verdict and the one sentence a user needs
       * after an update: the host half only changes on the next `dsh web` start. */
      var runUpdate = React.useCallback(function (action) {
        var ok = function (data) {
          var state = (data && data.update) || {}
          if (state.status === 'updated') return t('updateApplied')
          if (state.status === 'refused' || state.status === 'failed') return t('updateRejected', { reason: state.reason || t('noneYet') })
          return t('updateChecked')
        }
        return post('/api/memory/update', { action }, ok, 'updateFailed').then(function (result) { return load() })
      }, [post, load, t])

      /** The GLOBAL scope layer, through the same route module as the cap, so the two cannot come to
       * disagree about what a state means. */
      var saveScopes = React.useCallback(function () {
        var ok = function (data) { return t('scopesSaved', { state: t(GLOBAL_KEYS[data.scopes] || 'globalAll') }) }
        return saveSetting('/api/memory/scope', { scopes: scopes }, setScopes, ok, 'scopesFailed')
      }, [saveSetting, scopes, t])

      /** Switch the plugin MODE. This one cannot use `saveSetting`: switching to `native` may REMOVE
       * settings that mode refuses, and the reply names them, so the message has to report them. The
       * switch is also the escape hatch this panel exists to provide — it is how somebody locked out
       * of the injection cap (native refuses it) gets back in. */
      var saveMode = React.useCallback(function () {
        return post('/api/memory/mode', { mode: pluginMode },
          function (data) {
            var gone = data.dropped || []
            // Nothing removed is the ordinary case and needs no ceremony.
            if (gone.length === 0) return t('modeSaved', { mode: t(PLUGIN_MODE_KEYS[data.mode] || 'pluginModeNative') })
            return t('modeSavedDropped', { mode: t(PLUGIN_MODE_KEYS[data.mode] || 'pluginModeNative'), keys: gone.join(', ') })
          },
          'modeFailed').then(function (result) {
            if (result.ok && result.data) setPluginMode(null)
            return load()
          })
      }, [post, pluginMode, load, t])

      /** The two policy switches, written together through the same `saveSetting` shape. Each draft
       * falls back to the Host's value, so flipping one never silently rewrites the other. */
      var policyDirty =
        (generation !== null && generation !== Boolean(status?.generationEnabled)) ||
        (dream !== null && dream !== Boolean(status?.dreamEnabled)) ||
        (journal !== null && journal !== Boolean(status?.journalEnabled))
      var savePolicy = React.useCallback(function () {
        var body = {
          enabled: generation === null ? Boolean(status?.generationEnabled) : generation,
          dream: dream === null ? Boolean(status?.dreamEnabled) : dream,
          journal: journal === null ? Boolean(status?.journalEnabled) : journal,
        }
        return saveSetting('/api/memory/generation', body,
          function () { setGeneration(null); setDream(null); setJournal(null) },
          function (data) {
            // The route carries whatever it had to change alongside — turning the pass off also disables
            // its per-turn trigger, because the SDK refuses that combination. Saying so is the
            // difference between a switch and a switch that quietly edits a neighbour.
            var implied = data.implied || []
            return implied.length === 0 ? t('policySaved') : t('policySavedImplied', { keys: implied.join(', ') })
          }, 'policyFailed')
      }, [saveSetting, generation, dream, journal, status, t])

      var save = React.useCallback(
        function () {
          var ok = function (data) { return t('savedFile', { scope: data.scope, path: data.path, bytes: data.bytes }) }
          return post('/api/memory/file', { scope: activeScope, path: name, content: text }, ok, 'saveFailed').then(load)
        },
        [post, activeScope, name, text, load, t],
      )

      var refresh = React.useCallback(
        function () {
          var ok = function (data) { return data.injected ? t('reloaded') : t('nothingToReload', { reason: data.reason || t('noFiles') }) }
          return post('/api/memory/refresh', undefined, ok, 'refreshFailed')
        },
        [post, t],
      )

      var flush = React.useCallback(
        function () {
          return post('/api/memory/flush', undefined, function (data) { return t('flushed', { count: data.flushed }) }, 'flushFailed')
        },
        [post, t],
      )

      /** Fetch the injection preview. GET, because it must not change anything: the Host runs
       * the real consumption pass and discards the result, so asking twice equals asking once. */
      var runPreview = React.useCallback(
        function () {
          return act('/api/memory/preview', undefined, null, null, function (result) {
            setPreview(result.ok ? result.data : { available: false, reason: (result.data && result.data.error) || t('refreshFailed') })
          })
        },
        [act, t],
      )

      /** Grant or revoke trust for the folder shown — Qoder's "Trust this folder", the
       * interactive half of the trust gate. */
      var setTrust = React.useCallback(
        function (action) {
          var ok = function () { return action === 'allow' ? t('trustAllowed') : t('trustRevoked') }
          return post('/api/memory/trust', { action: action }, ok, 'trustFailed').then(load)
        },
        [post, load, t],
      )

      /** Delete one file. On the file row, not the editor: a destructive action names its target. */
      var removeFile = React.useCallback(
        function (nextScope, nextName) {
          var url = '/api/memory/file?scope=' + encodeURIComponent(nextScope) + '&path=' + encodeURIComponent(nextName)
          return act(
            url,
            { method: 'DELETE' },
            function () {
              return t('deletedFile', { scope: nextScope, path: nextName })
            },
            'deleteFailed',
          ).then(load)
        },
        [act, load, t],
      )

      if (status === null) {
        return h('div', { className: 'dshmem-page' }, h('div', { className: 'dshmem-muted' }, t('unavailable')))
      }

      var last = status.lastGeneration
      var scopeOptions = status.roots.length > 0 ? status.roots : [{ id: 'project' }]
      // A controlled select must show what it will load; fall back to one that exists.
      var activeScope = scopeOptions.some((root) => root.id === scope) ? scope : scopeOptions[0].id

      var gateText =
        status.gate.kind === 'custom'
          ? t('gateCustom', { timeout: status.gate.timeoutMs, onGateError: status.gate.onGateError })
          : t('gateBuiltin', { minPromptChars: status.gate.minPromptChars })

      // The global scope control. `none` is legitimately REPORTABLE but is not OFFERED: it is a fourth
      // spelling of "no memory at all" beside the plugin switch above. The choice list comes from the
      // HOST — the bundle cannot import the Host's vocabulary, so it may not invent an option the
      // writing route would refuse, nor offer a Save whose only answer is 501.
      var choices = status.globalScopeChoices || []
      var canScope = status.configWritable === true && choices.length > 0
      var draft = scopes === null ? status.globalScopes : scopes
      // A `<select>` whose value matches NO option silently displays the FIRST one — reporting "user +
      // project" while the configuration says "no scope at all" is the kind of panel that lies about
      // the thing it exists to explain. `none` is precisely such a value, so the current state is
      // pinned as its own option whenever the Host does not offer it.
      var listed = choices.indexOf(draft) >= 0 ? choices : [draft].concat(choices)
      var scopeNote = status.globalScopes === 'none' ? t('noScope') : canScope ? t('globalScopesHint') : t('readOnly')

      // The injection cap is writable only where the plugin would ACCEPT it. `mode: native` delegates
      // the memory policy to the runtime and refuses every `consumption.*` override, so an editable
      // box there used to write a configuration the plugin rejects — which does not merely fail to
      // apply, it stops the plugin activating entirely. The value is still reported; only the edit is
      // withheld, and the note says how to unlock it.
      var canBudget = status.configWritable === true && status.consumptionWritable === true
      // The PERSISTED cap as the box's text. No cap is the Host sending no value at all (Qoder's own
      // "absent = no limit"), and an empty box is how that state is shown and how it is written back.
      var savedCap = status.maxTokens === undefined ? '' : String(status.maxTokens)

      // The plugin MODE itself. Offered for the same reason the other two are: the mode decides which
      // fields exist at all, so without this row somebody locked out of the cap (native refuses it)
      // would have to edit YAML and restart to get back in — which is precisely the round trip this
      // panel exists to remove. The choice list comes from the Host, never invented here.
      var modeChoices = status.modeChoices || []
      var canMode = status.configWritable === true && modeChoices.length > 0
      var modeDraft = pluginMode === null ? status.mode : pluginMode

      return h(
        'div',
        { className: 'dshmem-page' },

        h('style', null, CSS),

        Section(t('title'), h('div', { className: 'dshmem-intro' }, t('intro')), h('div', { className: 'dshmem-muted dshmem-code' }, t('commands'))),

        Section(
          t('statusTitle'),
          Row(
            t('plugin'),
            h(Tag, { tone: status.enabled ? 'success' : 'quiet' }, status.enabled ? t('enabled') : t('disabled')),
          ),
          // The MODE, first among the editable rows because it decides what the others may even be.
          // `custom` is the mode that unlocks the injection cap, so the lock note below points here.
          canMode
            ? Editor(t('mode'),
                h('select', { className: 'dshmem-select dshmem-mode', value: modeDraft, disabled: busy, onChange: (event) => setPluginMode(event.target.value) },
                  modeChoices.map((id) => h('option', { key: id, value: id }, t(PLUGIN_MODE_KEYS[id] || 'pluginModeNative')))),
                t('modeHint'),
                Button({ disabled: busy || pluginMode === null || pluginMode === status.mode, onClick: saveMode, children: t('save') }))
            : Row(t('mode'), status.mode),
          Row(t('generation'), OnOff(status.generationEnabled, t)),
          Row(t('consumption'), OnOff(status.consumptionEnabled, t)),
          // The GLOBAL layer, beside the feature switches it belongs with — now EDITABLE: it is what a
          // session set to `Auto` follows, so the row that makes "Auto" legible is also where somebody
          // changes what it follows. Without a writer it degrades to the read-only value.
          canScope
            ? Editor(t('globalScopes'), h('select', { className: 'dshmem-select dshmem-global', value: draft, disabled: busy, onChange: (event) => setScopes(event.target.value) },
                listed.map((id) => h('option', { key: id, value: id }, t(GLOBAL_KEYS[id] || 'globalAll')))),
                scopeNote, Button({ disabled: busy || scopes === null || scopes === status.globalScopes, onClick: saveScopes, children: t('save') }))
            : Row(t('globalScopes'), t(GLOBAL_KEYS[status.globalScopes] || 'globalAll')),
          // And THIS session's own mode, READ-ONLY: the control lives in the composer, but a settings
          // page that showed only the global layer would leave a scoped session unexplained.
          //
          // `undefined` is a REAL answer, not a missing one: the Host reports no session when several
          // are open and none was named (it refuses to guess which one this page is about). Falling
          // back to `auto` would print "follows the global configuration" for a page that in fact
          // knows nothing — the panel claiming a fact it does not have.
          Row(t('modeLabel'), status.memoryMode === undefined ? t('modeUnknown') : t(modeKey(status.memoryMode))),
          // Qoder's two policy switches, now EDITABLE. `generation.*` is refused under `native`
          // exactly like the cap and the write budget, so all three share `canBudget` (the same
          // `custom`-mode gate) — a control offered there would persist a config the plugin rejects,
          // and a rejected config stops the plugin ACTIVATING.
          //
          // `envPinned` matters here more than anywhere else: `DSH_MEMORY_DREAM` overrides the config,
          // so the switch would silently do nothing. It is shown disabled with the reason instead,
          // because a switch that cannot take effect is worse than one that is absent.
          canBudget
            ? Editor(t('generation'),
                h('div', { className: 'dshmem-toolbar' },
                  h('span', { className: 'dshmem-muted' }, t('generationShort')),
                  Toggle({ className: 'dshmem-policy-enabled', value: generation === null ? Boolean(status.generationEnabled) : generation, onPick: setGeneration, disabled: busy, t }),
                  h('span', { className: 'dshmem-muted' }, t('dream')),
                  Toggle({ className: 'dshmem-policy-dream', value: dream === null ? Boolean(status.dreamEnabled) : dream, onPick: setDream, disabled: busy, t }),
                  h('span', { className: 'dshmem-muted' }, t('journal')),
                  Toggle({ className: 'dshmem-policy-journal', value: journal === null ? Boolean(status.journalEnabled) : journal, onPick: setJournal, disabled: busy, t })),
                t('policyHint'),
                Button({ disabled: busy || !policyDirty, onClick: savePolicy, children: t('save') }))
            : h('div', null,
                Row(t('generation'), OnOff(status.generationEnabled, t)),
                Row(t('dream'), OnOff(status.dreamEnabled, t)),
                Row(t('journal'), OnOff(status.journalEnabled, t))),
          // Where a journal lands, so "on" is not a mystery about which file to open.
          status.journalEnabled === true
            ? h('div', { className: 'dshmem-muted' }, t('journalWhere', {
                scope: status.journalScope === 'user' ? t('scopeUser') : t('scopeProject'),
                dir: status.journalDir || 'journal',
              }))
            : null,
          // An environment override wins over the config, so a switch for that field would silently do
          // nothing. Said out loud rather than left as a dead control.
          status.envPinned !== undefined && status.envPinned.length > 0
            ? h('div', { className: 'dshmem-muted' }, t('policyEnvPinned', { keys: status.envPinned.join(', ') }))
            : null,
          Row(t('gate'), gateText),
          Row(t('trust'), TrustRow(status.trust, t, setTrust, busy)),
          Row(t('pending'), String(status.pendingGenerations)),
          // Only the parts that differ: the policy, the mode memory's writes declare, and — for
          // `memory-root` under a fenced session — the session's own mode, which memory's writes
          // deliberately ignore. One number for both is how a full-access session looked fenced.
          Row(t('writePolicy'), status.writePolicy + (status.sandboxMode === undefined ? '' : ' · ' + status.sandboxMode) + (status.sessionMode === undefined || status.sessionMode === status.sandboxMode ? '' : ' · session ' + status.sessionMode)),
          // Where this plugin's own checkout stands. Last in the status block: it is about the
          // installation, not about the memory the rest of the page is describing.
          UpdateRow(status.update, t, busy, runUpdate),
        ),

        Section(
          t('budgetTitle'),
          // Draft + explicit Save, because a box that saved on every keystroke would write `1` on the
          // way to `1500`. An EMPTY box is "no limit" — the default — and the box says so with its
          // placeholder, because an empty control with no explanation reads as "unset/broken".
          // Where the plugin would refuse the write the row reports the value instead of offering the
          // edit, and says which mode unlocks it.
          canBudget
            ? Editor(t('maxTokens'),
                h('input', { type: 'number', className: 'dshmem-input dshmem-number', min: status.minTokens, disabled: busy,
                  placeholder: t('noLimit'),
                  value: cap === null ? savedCap : cap, onChange: (event) => setCap(event.target.value) }),
                t('maxTokensHint'),
                Button({ disabled: busy || cap === null || cap === savedCap, onClick: saveCap, children: t('save') }))
            : Row(t('maxTokens'), status.maxTokens === undefined ? t('noLimit') : String(status.maxTokens)),
          canBudget ? null : h('div', { className: 'dshmem-muted' }, t('budgetLockedHint')),
          Row(t('overflow'), status.overflow),
          Row(t('failureMode'), status.failureMode),
          Row(t('generationCap'), String(status.maxOutputTokens === undefined ? '—' : status.maxOutputTokens)),
          Row(t('pauseAfter'), String(status.pauseAfterFailures === undefined ? '—' : status.pauseAfterFailures)),
          // The preview sits with the budget it spends: both answer "how much of the context is memory,
          // and what does not fit?".
          PreviewCard(preview, t, busy, runPreview),
        ),

        Section(t('activityTitle'),
          Row(t('lastGeneration'), last ? last.status + ' (' + t('turn', { turn: last.turnIndex }) + ')' + (last.reason ? ' — ' + last.reason : '') : t('noneYet')),
          Row(t('lastDream'), status.lastDream ? status.lastDream.status + ' — ' + (status.lastDream.reason || t('noneYet')) : t('noneYet')),
          ...qualityNotices(status, t)),

        Section(
          t('editorTitle'),
          h('div', { className: 'dshmem-toolbar' },
            h('select', { className: 'dshmem-select dshmem-scope-select', value: activeScope, onChange: (event) => setScope(event.target.value) }, scopeOptions.map((root) => h('option', { key: root.id, value: root.id }, root.id))),
            h('input', { className: 'dshmem-input dshmem-grow', value: name, spellCheck: false, placeholder: t('filenamePlaceholder'), onChange: (event) => setName(event.target.value) }),
            Button({ onClick: () => openFile(activeScope, name), children: t('load') })),
          h('textarea', { className: 'dshmem-textarea', value: text, spellCheck: false, placeholder: t('contentPlaceholder'), onChange: (event) => setText(event.target.value) }),
          h('div', { className: 'dshmem-toolbar' },
            Button({ tone: 'primary', disabled: busy, onClick: save, children: t('save') }),
            Button({ disabled: busy, onClick: refresh, children: t('reload') }),
            Button({ disabled: busy, onClick: flush, children: t('flush') })),
          message === null ? null : h('p', { className: 'dshmem-note' + (message.kind === 'error' ? ' dshmem-note-error' : '') }, message.text),
        ),

        // LAST, on purpose. This is the one section that grows without bound — a row per project that
        // has memory — so putting it above the controls pushed the settings somebody came here to
        // change off the first screen. It is reference material: you consult it, you do not operate it.
        Section(
          t('scopesTitle'),
          // Every project keeps its own memory; the note names the folder it speaks about.
          h('div', { className: 'dshmem-muted' }, t('projectsNote', { cwd: status.projectFolder ? status.projectFolder.cwd : '' })),
          status.roots.length === 0
            ? h('div', { className: 'dshmem-muted' }, t('noScope'))
            : h('div', { className: 'dshmem-list' }, status.roots.map((root) => ScopeCard(root, t, openFile, removeFile))),
        ),
      )
    }

    /** The four global scope states, mapped to their locale keys. */
    var GLOBAL_KEYS = { all: 'globalAll', project: 'globalProject', user: 'globalUser', none: 'globalNone' }

    /** The plugin's two modes, mapped to their locale keys. Distinct from `MODE_HINT`, which is the
     * per-SESSION switch: this one is a property of the plugin, and the two vocabularies must not be
     * confused (`native`/`custom` here, `auto`/`all`/… there).
     *
     * `PREVIEW_ACTIONS` maps the Host's injection verdicts the same way, so the panel never prints a
     * raw code: it covers every value `planInjection` returns, and anything else falls back to a key
     * that admits the gap instead of echoing the bare word. */
    var PLUGIN_MODE_KEYS = { native: 'pluginModeNative', custom: 'pluginModeCustom' }
    var PREVIEW_ACTIONS = { silent: 'previewActionSilent', snapshot: 'previewActionSnapshot', delta: 'previewActionDelta', none: 'previewActionNone' }
    /** The update verdicts the Host publishes, mapped to locale keys. An unknown verdict admits the
     * gap instead of echoing a bare machine word; the raw code rides the tooltip. */
    var UPDATE_STATUS_KEYS = {
      disabled: 'updateOff', unknown: 'updateUnknown', 'up-to-date': 'updateUpToDate',
      behind: 'updateBehind', ahead: 'updateAhead', diverged: 'updateDiverged',
      updated: 'updateUpdated', refused: 'updateRefused', failed: 'updateStatusFailed',
      unavailable: 'updateUnavailable',
    }

    /** `auto` → the locale key `modeAuto`. Shared, so the panel and the composer cannot drift apart. */
    var modeKey = function (name) { return 'mode' + String(name || 'auto').charAt(0).toUpperCase() + String(name || 'auto').slice(1) }

    /** What each session mode does, as its own locale key. One key per mode rather than a ternary
     * chain, so every state can be read at once and a new one cannot be added without a sentence
     * saying what it does — `test/client.test.mjs` drives this table through all five. */
    var MODE_HINT = { auto: 'modeHintAuto', all: 'modeHintAll', user: 'modeHintUser', project: 'modeHintProject', off: 'modeHintOff' }
    /** The composer button: this session's memory state, one click to cycle it. Here rather than in
     * Settings because the decision is PER SESSION, and `conversation.input.left` is the only slot that
     * hands the client a `sessionId`.
     *
     * The button shows one short label, so the tooltip is the whole explanation and answers all three
     * questions a user has: what is in effect NOW, what it MEANS, and what the next click does. The
     * old tooltip answered only the last, leaving the default ("Auto") and the muted ("Off") states
     * mutually indistinguishable in consequence. */
    function MemoryToggle(props) {
      var t = props.t
      var sid = typeof props.sessionId === 'string' && props.sessionId.length > 0 ? props.sessionId : props.session && typeof props.session.id === 'string' ? props.session.id : ''
      var [state, setState] = React.useState(null)
      var [error, setError] = React.useState(null)
      // The cycle order while the first read is in flight. The Host publishes the real list and it is
      // what the button steps through, so this is only the shape shown for the first moment — but it
      // must still match `SESSION_MODES`, or an unimplemented state could be clicked before the poll
      // lands. `test/client.test.mjs` asserts the two agree.
      var fallback = ['auto', 'all', 'user', 'project', 'off']
      var modes = state && state.modes ? state.modes : fallback
      var mode = state ? state.mode : 'auto'
      var step = function (from) { return modes[(modes.indexOf(from) + 1) % modes.length] }

      /** Read this session's own state. A 409 (an id the Host does not know) stays ON the button
       * rather than throwing: an exception here would take the composer row down with it. */
      var load = React.useCallback(function () {
        return api('/api/memory/switch?session=' + encodeURIComponent(sid)).then(function (result) {
          if (result.ok && result.data) { setState(result.data); setError(null) } else setError((result.data && result.data.error) || t('modeFailed'))
          return result
        })
      }, [sid, t])

      usePoll(load, 10000, sid.length > 0)

      var flip = React.useCallback(function () {
        if (state === null) return Promise.resolve()
        return api('/api/memory/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: sid, mode: step(state.mode) }) }).then(function (result) {
          if (result.ok && result.data) return load()
          setError((result.data && result.data.error) || t('modeFailed'))
          return result
        })
      }, [load, sid, state, t, modes])

      var globalText = !state || state.global === undefined ? t('globalNone') : t(GLOBAL_KEYS[state.global] || 'globalAll')
      var what = t(MODE_HINT[mode] || 'modeHintAuto', { state: globalText })
      // Three reasons the button may have nothing to say, kept apart because they are three different
      // situations: a failure, a session with no id, and a poll that has not landed. Reporting all
      // three as "could not change it" would blame the user for a request that never happened.
      var title = error !== null ? error : sid.length === 0 ? t('modeNoSession') : state === null
        ? t('modeLabel') + '…' : t('modeTitle', { now: t(modeKey(mode)), what: what, next: t(modeKey(step(mode))) })
      return h(React.Fragment, null, h('style', null, CSS), h('button', {
        type: 'button',
        className: 'dshmem-quick',
        'data-state': error !== null ? 'error' : mode,
        // The accessible name is the whole sentence: a screen reader gets what a sighted user reads in
        // the tooltip, not just the one word the button shows.
        'aria-label': t('modeLabel') + ': ' + t(modeKey(mode)) + ' — ' + what,
        title: title,
        disabled: sid.length === 0,
        onClick: flip,
      }, h('span', { className: 'dshmem-quick-dot', 'aria-hidden': 'true' }), t(modeKey(mode))))
    }

    return {
      name: 'memory-ui',
      // `locale` is required: the slot layer injects the bound `t` prop.
      inject: ['slots', 'locale'],
      apply: function (ctx) {
        var t = ctx.locale.bind(NS)
        ctx.effect(function () {
          return ctx.locale.register(NS, { zh: zh, en: en })
        }, 'memory-ui: dictionaries')
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register(
            {
              name: 'settings.section',
              id: 'memory',
              order: 60,
              // Re-read on every projection, so the nav label follows the locale.
              label: function () {
                return t('title')
              },
              locale: NS,
            },
            MemorySection,
          )
        })
        ctx.slots.inject('conversation.input.left', function () {
          return ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'memory-toggle',
              // After the prompt toggle (order 40), so the shipped control keeps its place.
              order: 45,
              label: function () {
                return t('modeLabel')
              },
              locale: NS,
            },
            MemoryToggle,
          )
        })
      },
    }
  },
})
