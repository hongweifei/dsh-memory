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
      // The composer control: one word per state (a button in the composer row has no room for a
      // sentence; the title carries what the next click does).
      modeAuto: 'Auto', modeProject: 'Project only', modeOff: 'Off', modeLabel: 'Memory in this session',
      modeNext: 'Click: {next} · Global: {state}', globalAll: 'user + project', globalProject: 'project only', globalUser: 'user only', globalNone: 'none (memory is off globally)', globalScopes: 'Global scopes',
      modeFailed: 'Could not change this session’s memory.', scopesTitle: 'Scopes',
      writePolicy: 'Memory writes (memory-root = declares its own sandbox root | session = follows the session)',
      noScope: 'No scope is enabled.', projectsNote: 'Every project keeps its own memory; the active session is {cwd}',
      noFiles: 'No memory files yet.', scopeSummary: '{count} memory file(s){size}', open: 'Open', delete: 'Delete',
      deletedFile: 'Deleted {scope}:{path}.', deleteFailed: 'Could not delete the file.', writeRefused: 'Refused to write {path}: {error}',
      readOnly: 'read-only', readWrite: 'read-write',

      budgetTitle: 'Injection budget (consumption)', maxTokens: 'Injection cap (tokens)',
      // The old label claimed "0 = inject nothing", which the configuration never allowed: the
      // schema and the SDK both require a positive integer, so 0 is rejected before it can reach the
      // renderer. Saying how to really inject nothing is the difference between a control that works
      // and one that looks broken.
      maxTokensHint: 'How much memory may enter the context. To inject nothing, turn consumption off — 0 is not a legal cap.',
      capSaved: 'Injection cap saved: {tokens} tokens.',
      capFailed: 'Could not save the injection cap.',
      overflow: 'If it does not fit (truncate | fail_query)', failureMode: 'If a file fails to load (best_effort | fail_query)',
      generationCap: 'Generation output cap (0 = model default)', pauseAfter: 'Pause after N consecutive failures (0 = never)',
      previewRun: 'Preview',
      previewHint: 'What the next step actually sends. Computed by running the real pass and discarding it, so the panel never changes what it describes.',
      previewStep: 'Next step', previewSnapshot: 'Full block for a fresh session', previewUnavailable: 'No preview: {reason}',
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
      modeProject: '仅项目', modeOff: '已关闭', modeLabel: '本会话的记忆', modeNext: '点击后：{next} · 全局：{state}', globalAll: '用户 + 项目', globalProject: '仅项目', globalUser: '仅用户', globalNone: '无（记忆已全局关闭）', globalScopes: '全局作用域',
      modeFailed: '无法更改本会话的记忆设置。', scopesTitle: '作用域', writePolicy: '记忆写入（memory-root＝自声明沙箱根 | session＝跟随会话策略）', noScope: '未启用任何作用域。',
      projectsNote: '每个项目各自一份记忆；当前会话是 {cwd}', noFiles: '暂无记忆文件。', scopeSummary: '{count} 个记忆文件{size}', open: '打开', delete: '删除',
      deletedFile: '已删除 {scope}:{path}。', deleteFailed: '无法删除该文件。', writeRefused: '写入被拒 {path}：{error}', readOnly: '只读', readWrite: '读写',

      budgetTitle: '注入预算（消费半）', maxTokens: '注入上限（token）',
      maxTokensHint: '允许进入上下文的记忆上限。要完全不注入请关掉消费开关——0 不是合法的上限。',
      capSaved: '注入上限已保存：{tokens} token。', capFailed: '无法保存注入上限。',
      overflow: '超限处理（truncate | fail_query）', failureMode: '失败处理（best_effort | fail_query）',
      generationCap: '生成输出上限（0＝模型默认）', pauseAfter: '连续失败几次暂停（0＝永不）', previewRun: '预览',
      previewHint: '下一步实际会发出去的内容。做法是把真实消费跑一遍再丢掉结果，所以看一眼面板不会改变它描述的行为。', previewStep: '下一步', previewSnapshot: '新会话会收到的完整块',
      previewUnavailable: '无法预览：{reason}', previewTokens: '占用 {tokens}／{max} token',

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
      '.dshmem-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:12px}.dshmem-trust{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:none}',
      // A file row is name + an action group: grouping keeps `space-between` from
      // splitting the action buttons onto their own line.
      '.dshmem-file{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0}.dshmem-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;word-break:normal}.dshmem-actions{display:flex;align-items:center;gap:4px;flex:none}',
      '.dshmem-note{margin:8px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}.dshmem-note-error{color:var(--dsw-alias-label-error)}.dshmem-note-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.dshmem-code{font-family:var(--dsw-font-markdown-code-font-family);font-size:12px}.dshmem-muted{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6}',
      // The composer button: compact, and its own class so nothing here can reach the panel. The
      // dot carries the state at a glance, because the label is a word inside a busy tool row.
      '.dshmem-quick{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}.dshmem-quick:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dshmem-quick:disabled{cursor:not-allowed;opacity:0.4}',
      '.dshmem-quick-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}.dshmem-quick[data-state=\'auto\'] .dshmem-quick-dot{background:var(--dsw-alias-state-success-primary)}.dshmem-quick[data-state=\'project\'] .dshmem-quick-dot{background:var(--dsw-alias-state-business-primary)}.dshmem-quick[data-state=\'off\'] .dshmem-quick-dot{background:var(--dsw-alias-state-warn-primary)}.dshmem-quick[data-state=\'error\'] .dshmem-quick-dot{background:var(--dsw-alias-label-error)}',
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
      var note = preview === null ? t('previewHint') : preview.available !== true ? t('previewUnavailable', { reason: preview.reason || t('noneYet') }) : t('previewTokens', { tokens: preview.step.tokens, max: preview.snapshot.maxTokens })
      var bar = h('div', { className: 'dshmem-toolbar' }, Button({ disabled: busy, onClick: onRun, children: t('previewRun') }), h('span', { className: 'dshmem-muted' }, note))
      if (preview === null || preview.available !== true) return bar
      var shown = preview.step.text || preview.snapshot.text
      return h('div', null, bar,
        // The action word is Qoder's own vocabulary; the Host's machine reason is English, so
        // it rides along as a tooltip — a Chinese panel must not read as half English.
        h('div', { className: 'dshmem-field', title: preview.step.reason }, h('span', { className: 'dshmem-label' }, t('previewStep')), h('span', { className: 'dshmem-value dshmem-mono' }, preview.step.action + (preview.step.changed.length > 0 ? ' · ' + preview.step.changed.join(', ') : ''))),
        // The same `▸` the scope rows use: without it the fold is invisible.
        shown === undefined ? null : h('details', { className: 'dshmem-scope-row' }, h('summary', { className: 'dshmem-scope' }, h('span', { className: 'dshmem-caret' }, '▸'), t('previewSnapshot')), h('pre', { className: 'dshmem-textarea dshmem-mono', readOnly: true }, shown)))
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
      // The injection cap being edited, or `null` while it still mirrors the Host's value. The poll
      // must not overwrite what someone is typing, and `null` is what makes "unchanged" detectable.
      var [cap, setCap] = React.useState(null)

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

      /** Save the injection cap, then re-read status so the row shows the persisted value. */
      var saveCap = React.useCallback(function () {
        var saved = function (data) { return t('capSaved', { tokens: data.maxTokens }) }
        return post('/api/memory/budget', { maxTokens: Number(cap) }, saved, 'capFailed').then(function (result) {
          // Clear the draft only on success, so a rejection leaves the value to fix in place.
          if (result.ok && result.data) setCap(null)
          return load()
        })
      }, [post, cap, load, t])

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
          Row(t('mode'), status.mode),
          Row(t('generation'), OnOff(status.generationEnabled, t)),
          Row(t('consumption'), OnOff(status.consumptionEnabled, t)),
          // The GLOBAL layer, beside the feature switches it belongs with. It is what a session set to
          // `Auto` follows, so it is the row that makes the composer's "Auto" legible.
          Row(t('globalScopes'), t(GLOBAL_KEYS[status.globalScopes] || 'globalAll')),
          // And THIS session's own mode, READ-ONLY: the control lives in the composer, but a settings
          // page that showed only the global layer would leave a scoped session unexplained.
          Row(t('modeLabel'), t(modeKey(status.memoryMode))),
          Row(t('dream'), OnOff(status.dreamEnabled, t)),
          Row(t('gate'), gateText),
          Row(t('trust'), TrustRow(status.trust, t, setTrust, busy)),
          Row(t('pending'), String(status.pendingGenerations)),
          // Only the parts that differ: the policy, the mode memory's writes declare, and — for
          // `memory-root` under a fenced session — the session's own mode, which memory's writes
          // deliberately ignore. One number for both is how a full-access session looked fenced.
          Row(t('writePolicy'), status.writePolicy + (status.sandboxMode === undefined ? '' : ' · ' + status.sandboxMode) + (status.sessionMode === undefined || status.sessionMode === status.sandboxMode ? '' : ' · session ' + status.sessionMode)),
        ),

        Section(
          t('scopesTitle'),
          // Every project keeps its own memory; the note names the folder it speaks about.
          h('div', { className: 'dshmem-muted' }, t('projectsNote', { cwd: status.projectFolder ? status.projectFolder.cwd : '' })),
          status.roots.length === 0
            ? h('div', { className: 'dshmem-muted' }, t('noScope'))
            : h('div', { className: 'dshmem-list' }, status.roots.map((root) => ScopeCard(root, t, openFile, removeFile))),
        ),

        Section(
          t('budgetTitle'),
          // The ONE editable budget: the injection cap. An input plus a save button, because a box that
          // saved on every keystroke would write `1` on the way to `1500`.
          h('div', { className: 'dshmem-field' },
            h('span', { className: 'dshmem-label' }, t('maxTokens')),
            h('input', {
              type: 'number',
              className: 'dshmem-input dshmem-number',
              min: status.minTokens,
              value: cap === null ? String(status.maxTokens) : cap,
              disabled: busy,
              onChange: function (event) { setCap(event.target.value) },
            }),
            Button({ disabled: busy || cap === null || cap === String(status.maxTokens), onClick: saveCap, children: t('save') })),
          // The old label claimed "0 = inject nothing", which the configuration never allowed: the
          // schema and the SDK both require a positive integer, so 0 is rejected before it can reach the
          // renderer. Saying how to really inject nothing is the difference between a working control
          // and one that looks broken.
          h('div', { className: 'dshmem-muted' }, t('maxTokensHint')),
          Row(t('overflow'), status.overflow),
          Row(t('failureMode'), status.failureMode),
          Row(t('generationCap'), String(status.maxOutputTokens === undefined ? '—' : status.maxOutputTokens)),
          Row(t('pauseAfter'), String(status.pauseAfterFailures === undefined ? '—' : status.pauseAfterFailures)),
          // The preview sits with the budget it spends: both answer "how much of the context is memory,
          // and what does not fit?".
          PreviewCard(preview, t, busy, runPreview),
        ),

        Section.apply(
          null,
          [
            t('activityTitle'),
            Row(t('lastGeneration'), last ? last.status + ' (' + t('turn', { turn: last.turnIndex }) + ')' + (last.reason ? ' — ' + last.reason : '') : t('noneYet')),
            Row(t('lastDream'), status.lastDream ? status.lastDream.status + ' — ' + (status.lastDream.reason || t('noneYet')) : t('noneYet')),
          ].concat(qualityNotices(status, t)),
        ),

        Section(
          t('editorTitle'),
          h('div', { className: 'dshmem-toolbar' },
            h('select', { className: 'dshmem-select', value: activeScope, onChange: (event) => setScope(event.target.value) },
              scopeOptions.map((root) => h('option', { key: root.id, value: root.id }, root.id))),
            h('input', {
              className: 'dshmem-input dshmem-grow',
              value: name,
              spellCheck: false,
              placeholder: t('filenamePlaceholder'),
              onChange: (event) => setName(event.target.value),
            }),
            Button({ onClick: () => openFile(activeScope, name), children: t('load') })),
          h('textarea', {
            className: 'dshmem-textarea',
            value: text,
            spellCheck: false,
            placeholder: t('contentPlaceholder'),
            onChange: (event) => setText(event.target.value),
          }),
          h('div', { className: 'dshmem-toolbar' },
            Button({ tone: 'primary', disabled: busy, onClick: save, children: t('save') }),
            Button({ disabled: busy, onClick: refresh, children: t('reload') }),
            Button({ disabled: busy, onClick: flush, children: t('flush') })),
          message === null ? null : h('p', { className: 'dshmem-note' + (message.kind === 'error' ? ' dshmem-note-error' : '') }, message.text),
        ),
      )
    }

    /** The four global scope states, mapped to their locale keys. */
    var GLOBAL_KEYS = { all: 'globalAll', project: 'globalProject', user: 'globalUser', none: 'globalNone' }

    /** `auto` → the locale key `modeAuto`. Shared, so the panel and the composer cannot drift apart. */
    var modeKey = function (name) { return 'mode' + String(name || 'auto').charAt(0).toUpperCase() + String(name || 'auto').slice(1) }

    /** The composer button: this session's memory state, one click to cycle it. Here rather than in
     * Settings because the decision is PER SESSION, and `conversation.input.left` is the only slot that
     * hands the client a `sessionId`; the panel is global settings, so a per-session control there had
     * to enumerate every live session and act on a named id. The title states what `auto` follows,
     * because otherwise "Auto" is a word with nothing behind it. */
    function MemoryToggle(props) {
      var t = props.t
      var sid = typeof props.sessionId === 'string' && props.sessionId.length > 0 ? props.sessionId : props.session && typeof props.session.id === 'string' ? props.session.id : ''
      var [state, setState] = React.useState(null)
      var [error, setError] = React.useState(null)
      var MODES = ['auto', 'project', 'off']
      var modes = state && state.modes ? state.modes : MODES
      var mode = state ? state.mode : 'auto'

      var load = React.useCallback(function () {
        return api('/api/memory/switch?session=' + encodeURIComponent(sid)).then(function (result) {
          // A session the Host does not know answers 409; keep that ON the button rather than
          // throwing, because an exception here would take the composer row down with it.
          if (result.ok && result.data) { setState(result.data); setError(null) } else setError((result.data && result.data.error) || t('modeFailed'))
          return result
        })
      }, [sid, t])

      usePoll(load, 10000, sid.length > 0)

      var flip = React.useCallback(function () {
        if (state === null) return Promise.resolve()
        var next = modes[(modes.indexOf(state.mode) + 1) % modes.length]
        return api('/api/memory/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: sid, mode: next }) }).then(function (result) {
          if (result.ok && result.data) return load()
          setError((result.data && result.data.error) || t('modeFailed'))
          return result
        })
      }, [load, sid, state, t, modes])

      var next = modes[(modes.indexOf(mode) + 1) % modes.length]
      var globalText = !state || state.global === undefined ? '' : t(GLOBAL_KEYS[state.global] || 'globalAll')
      // A button in the composer row has no room for a sentence, so the state is one word and the
      // title carries everything else: what the next click does, and what `auto` follows.
      var title = error !== null ? error : state === null ? t('modeFailed') : t('modeNext', { next: t(modeKey(next)), state: globalText })
      return h(React.Fragment, null, h('style', null, CSS), h('button', {
        type: 'button',
        className: 'dshmem-quick',
        'data-state': error !== null ? 'error' : mode,
        'aria-label': t('modeLabel') + ': ' + t(modeKey(mode)),
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
