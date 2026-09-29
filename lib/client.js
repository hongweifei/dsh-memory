/**
 * Client half of the dsh-memory bundle: the Settings → Memory panel.
 *
 * Written in the DSH client-module format — a plain script calling
 * `window.__ModuleLoader__.load({ id, factory })`, where the factory returns a Cordis
 * plugin. It is NOT an ES module (the browser loader supplies `require` for the shared
 * React instance), so no `import`/`export`, and it never reaches into the Host modules.
 *
 * Data arrives from the Host half's same-origin `/api/memory/*` routes over the shared
 * connection channel, which applies the trust fence and authentication before any
 * handler runs; text goes through this plugin's own `memory` locale namespace (zh/en),
 * declared on the slot so the layer injects a bound `t` and re-renders on a language
 * switch — no user-visible string is hardcoded.
 *
 * Styling copies the Harness UI primitives' own rules under this plugin's `dshmem-`
 * prefix and references only real `--dsw-*` tokens, so the page follows the host theme
 * in light and dark; a test asserts every token name exists in the shipped primitives.
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
      title: 'Memory',
      intro: 'Persistent memory modelled on the Qoder Agent SDK: recorded after each turn, loaded under a token budget.',

      statusTitle: 'Status',
      plugin: 'Plugin',
      enabled: 'enabled',
      disabled: 'disabled',
      mode: 'Mode',
      generation: 'Generation',
      consumption: 'Consumption',
      on: 'on',
      off: 'off',
      gate: 'Gate',
      gateCustom: 'custom shouldGenerate (timeout {timeout}ms, onGateError={onGateError})',
      gateBuiltin: 'minPromptChars={minPromptChars}',
      pending: 'In-flight generations',
      dream: 'Consolidation',
      trust: 'Folder trust',
      trustOff: 'off (every folder is trusted)',
      trusted: 'trusted',
      untrusted: 'not trusted — project scope is skipped',
      trustGrant: 'Trust this folder',
      trustRevoke: 'Stop trusting',
      trustAllowed: 'Folder trusted: project memory is now in scope.',
      trustRevoked: 'Trust revoked: project memory is skipped again.',
      trustFailed: 'Could not change the trust decision.',

      scopesTitle: 'Scopes',
      noScope: 'No scope is enabled.',
      projectsNote: 'Every project keeps its own memory; the active session is {cwd}',
      noFiles: 'No memory files yet.',
      open: 'Open',
      delete: 'Delete',
      deletedFile: 'Deleted {scope}:{path}.',
      deleteFailed: 'Could not delete the file.',
      writeRefused: 'Refused to write {path}: {error}',
      readOnly: 'read-only',
      readWrite: 'read-write',

      budgetTitle: 'Injection budget (consumption)',
      maxTokens: 'Injection cap (0 = inject nothing)',
      overflow: 'If it does not fit (truncate | fail_query)',
      failureMode: 'If a file fails to load (best_effort | fail_query)',
      generationCap: 'Generation output cap (0 = model default)',
      pauseAfter: 'Pause after N consecutive failures (0 = never)',

      activityTitle: 'Latest activity',
      lastGeneration: 'Last generation',
      lastConsumption: 'Last consumption',
      lastDream: 'Last consolidation',
      noneYet: 'none yet',
      noFilesConsidered: 'no files',
      turn: 'turn {turn}',

      editorTitle: 'Edit memory file',
      load: 'Load',
      save: 'Save',
      reload: 'Reload into session',
      flush: 'Flush generations',
      filenamePlaceholder: 'MEMORY.md',
      contentPlaceholder: 'Markdown memory notes…',

      loadedBytes: 'Loaded {bytes} bytes.',
      savedFile: 'Saved {scope}:{path} ({bytes} bytes).',
      reloaded: 'Reloaded memory into this session.',
      nothingToReload: 'Nothing to reload: {reason}',
      flushed: 'Flushed {count} generation(s).',
      loadFailed: 'Could not load the file.',
      saveFailed: 'Save failed.',
      refreshFailed: 'Refresh failed.',
      flushFailed: 'Flush failed.',
      unavailable: 'Memory status is unavailable.',

      commandsTitle: 'Commands',
      commandConfig: '/memory',
      commandRefresh: '/memory-refresh',
      commandFlush: '/memory-flush',
      commandDelete: '/memory-delete',
      commandTrust: '/memory-trust',
      commandResume: '/memory-resume',

      largeFile: 'Large {path} will impact performance ({chars} chars > {limit})',
      failedFile: 'Failed to load {path}: {error}',
      excludedFiles: '{count} file(s) skipped by the exclusion patterns.',
      blockedImports: '{count} external @import(s) blocked: outside the allowed roots.',
      jitSkipped: '{count} file(s) not loaded yet: no path this session touched matched {paths}',
      indexWarning: 'Index {path}: {message}',
    }

    /** Chinese dictionary. */
    var zh = {
      title: '记忆',
      intro: '参照 Qoder Agent SDK 的持久记忆：每轮结束后记录，按 token 预算加载。',

      statusTitle: '状态',
      plugin: '插件',
      enabled: '已启用',
      disabled: '已禁用',
      mode: '模式',
      generation: '生成',
      consumption: '消费',
      on: '开',
      off: '关',
      gate: '闸门',
      gateCustom: '自定义 shouldGenerate（超时 {timeout}ms，onGateError={onGateError}）',
      gateBuiltin: 'minPromptChars={minPromptChars}',
      pending: '进行中的生成',
      dream: '记忆巩固',
      trust: '目录信任',
      trustOff: '未启用（所有目录都受信任）',
      trusted: '已信任',
      untrusted: '未信任——跳过项目作用域',
      trustGrant: '信任此目录',
      trustRevoke: '取消信任',
      trustAllowed: '已信任该目录：项目记忆现在会被加载。',
      trustRevoked: '已取消信任：重新跳过项目记忆。',
      trustFailed: '无法更改信任状态。',

      scopesTitle: '作用域',
      noScope: '未启用任何作用域。',
      projectsNote: '每个项目各自一份记忆；当前会话是 {cwd}',
      noFiles: '暂无记忆文件。',
      open: '打开',
      delete: '删除',
      deletedFile: '已删除 {scope}:{path}。',
      deleteFailed: '无法删除该文件。',
      writeRefused: '写入被拒 {path}：{error}',
      readOnly: '只读',
      readWrite: '读写',

      budgetTitle: '注入预算（消费半）',
      maxTokens: '注入上限（0＝不注入）',
      overflow: '超限处理（truncate | fail_query）',
      failureMode: '失败处理（best_effort | fail_query）',
      generationCap: '生成输出上限（0＝模型默认）',
      pauseAfter: '连续失败几次暂停（0＝永不）',

      activityTitle: '最近活动',
      lastGeneration: '最近一次生成',
      lastConsumption: '最近一次消费',
      lastDream: '最近一次巩固',
      noneYet: '暂无',
      noFilesConsidered: '无文件',
      turn: '第 {turn} 轮',

      editorTitle: '编辑记忆文件',
      load: '载入',
      save: '保存',
      reload: '重新加载进会话',
      flush: '等待生成完成',
      filenamePlaceholder: 'MEMORY.md',
      contentPlaceholder: 'Markdown 记忆内容…',

      loadedBytes: '已载入 {bytes} 字节。',
      savedFile: '已保存 {scope}:{path}（{bytes} 字节）。',
      reloaded: '已重新加载记忆到当前会话。',
      nothingToReload: '无需重新加载：{reason}',
      flushed: '已等待 {count} 个生成完成。',
      loadFailed: '无法载入该文件。',
      saveFailed: '保存失败。',
      refreshFailed: '重新加载失败。',
      flushFailed: '等待失败。',
      unavailable: '记忆状态不可用。',

      commandsTitle: '命令',
      commandConfig: '/memory',
      commandRefresh: '/memory-refresh',
      commandFlush: '/memory-flush',
      commandDelete: '/memory-delete',
      commandTrust: '/memory-trust',
      commandResume: '/memory-resume',

      largeFile: '记忆文件过大，会影响性能（{path}：{chars} 字符 > {limit}）',
      failedFile: '载入失败 {path}：{error}',
      excludedFiles: '已按排除规则跳过 {count} 个文件。',
      blockedImports: '已拦截 {count} 个外部 @import：超出了允许的目录。',
      jitSkipped: '有 {count} 个文件尚未加载：本会话触及的路径没有匹配 {paths}',
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

    /**
     * Stylesheet, prefixed `dshmem-`.
     *
     * Copied from the Harness UI primitives (`Button.module.css`,
     * `settings-form/fields.module.css`, `settings-form/SettingsForm.module.css`,
     * `Tag.module.css`, `Input.module.css` in @deepseek-ai/dsh-client-ui-primitives)
     * so this page matches host controls — same radii, heights, type sizes,
     * 0.5px strokes, hover/active fills and focus rings.
     *
     * Only `--dsw-*` tokens from the shipped stylesheets appear here: no literal
     * colour, so the page follows the host theme in light and dark alike. The
     * class prefix keeps these rules from colliding with host classes.
     */
    var CSS = [
      '.dshmem-page{color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px;line-height:1.5}',
      '.dshmem-section{padding:12px 0;border-top:0.5px solid var(--dsw-alias-border-l2)}.dshmem-section:first-child{border-top:none;padding-top:0}',
      '.dshmem-title{margin:0 0 8px;font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary)}.dshmem-intro{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
      '.dshmem-field{display:flex;align-items:baseline;gap:12px;padding:8px 0}.dshmem-field+.dshmem-field{border-top:0.5px solid var(--dsw-alias-border-l2)}',
      // The label must not be squeezable: with `flex:1;min-width:0` a long value
      // (the consumption list, a scope path, a failure reason) shrank the label to
      // nothing, and CJK text — which has no spaces to break at — collapsed into one
      // character per line. `min-width:max-content` keeps it whole and lets the value
      // wrap instead; `keep-all` makes the column impossible even if it ever shrinks.
      '.dshmem-label{flex:1 1 auto;min-width:max-content;word-break:keep-all;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      // A failure reason is arbitrary provider text: it must wrap inside the row
      // rather than run off the panel.
      '.dshmem-value{flex:0 1 auto;min-width:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary);text-align:right;overflow-wrap:anywhere}',
      '.dshmem-mono{font-family:var(--dsw-font-markdown-code-font-family);font-size:12px;word-break:break-all}.dshmem-card{border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);padding:4px 12px;margin-bottom:8px}',
      '.dshmem-tag{display:inline-flex;align-items:center;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap}.dshmem-tag[data-tone=\'outline\']{border:0.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary)}.dshmem-tag[data-tone=\'quiet\']{color:var(--dsw-alias-label-tertiary)}',
      ".dshmem-tag[data-tone='success']{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary)}.dshmem-tag[data-tone='warning']{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary)}",
      '.dshmem-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);cursor:pointer}.dshmem-btn:disabled{cursor:not-allowed;opacity:0.4}.dshmem-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.dshmem-btn-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.dshmem-btn-outline:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}',
      '.dshmem-btn-outline{border:0.5px solid var(--dsw-alias-border-l3)}.dshmem-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}.dshmem-btn-danger{color:var(--dsw-alias-label-error);border-color:currentColor}',
      '.dshmem-input{box-sizing:border-box;height:34px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);min-width:0}.dshmem-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      // A `select` is not a button: it needs the input's height, an explicit
      // background, room for the native arrow, and themed options (the popup is
      // OS-drawn and inherits nothing from this stylesheet).
      '.dshmem-select{box-sizing:border-box;height:34px;padding:0 24px 0 10px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}.dshmem-select option{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}',
      '.dshmem-grow{flex:1;min-width:120px}',
      '.dshmem-textarea{box-sizing:border-box;width:100%;min-height:180px;margin-top:8px;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font-family:var(--dsw-font-markdown-code-font-family);font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary);resize:vertical}.dshmem-textarea:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      '.dshmem-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:12px}',
      // A control group living inside a label/value row: no padding, and never
      // stretched, so the row keeps its height and the controls stay right.
      '.dshmem-trust{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:none}',
      '.dshmem-file{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0}',
      // A file row is name + an action group. Grouping matters: with three
      // flex children, `space-between` spreads the buttons apart instead of
      // keeping them a pair.
      '.dshmem-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;word-break:normal}',
      '.dshmem-actions{display:flex;align-items:center;gap:4px;flex:none}',
      '.dshmem-note{margin:8px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
      '.dshmem-note-error{color:var(--dsw-alias-label-error)}.dshmem-note-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.dshmem-code{font-family:var(--dsw-font-markdown-code-font-family);font-size:12px}',
      '.dshmem-muted{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6}',
    ].join('\n')

    /** Tag tones, mirroring the primitive's `data-tone` vocabulary. */
    function Tag(props) {
      return h('span', { className: 'dshmem-tag', 'data-tone': props.tone }, props.children)
    }
    /**
     * One label / value line, mirroring a settings-form field row.
     *
     * @param label - already-localized label text.
     * @param value - a string (rendered as a mono value) or a node (e.g. a Tag).
     */
    function Row(label, value) {
      return h(
        'div',
        { className: 'dshmem-field' },
        h('span', { className: 'dshmem-label' }, label),
        typeof value === 'string' ? h('span', { className: 'dshmem-value dshmem-mono' }, value) : value,
      )
    }

    /**
     * The folder-trust badge: the decision, not just the switch — when the gate
     * is on and this folder is untrusted, that IS why a project scope is absent.
     */
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

    /**
     * The folder-trust row: the decision, the folder, and — when the gate is on —
     * the button that grants or revokes it (Qoder's own prompt, in the panel).
     */
    function TrustRow(trust, t, onSet, busy) {
      var tag = TrustTag(trust, t)
      if (trust === null || trust === undefined || trust.enabled !== true) return tag
      var action = trust.trusted === true ? 'deny' : 'allow'
      var label = trust.trusted === true ? t('trustRevoke') : t('trustGrant')
      return h(
        'span',
        // Its own class, not `.dshmem-toolbar`: that one is the editor's and
        // carries top padding, which would push this row below its neighbours.
        { className: 'dshmem-trust' },
        tag,
        h('span', { className: 'dshmem-muted dshmem-mono' }, trust.folder || ''),
        Button({ disabled: busy, onClick: () => onSet(action), children: label }),
      )
    }

    /**
     * The load-quality warnings Qoder's own UI raises.
     *
     * A memory file that is enormous, unreadable, or removed by an exclusion
     * pattern changes what the model actually sees, so the panel states it
     * instead of leaving an operator with a silently short memory block.
     */
    function qualityNotices(status, t) {
      const change = status.memoryChange
      if (!change) return []
      const limit = status.largeFileLimit
      const note = (key, tone, text) =>
        h('div', { key: key, className: tone.length > 0 ? 'dshmem-note ' + tone : 'dshmem-note' }, text)
      const notices = (change.largeFiles || []).map((file) =>
        note(
          'large-' + file.path,
          'dshmem-note-warn',
          t('largeFile', { path: file.path, chars: file.characterCount, limit: limit }),
        ),
      )
      for (const file of change.failedFiles || []) {
        notices.push(note('failed-' + file.path, 'dshmem-note-error', t('failedFile', { path: file.path, error: file.error })))
      }
      const excluded = (change.excludedFiles || []).length
      if (excluded > 0) notices.push(note('excluded', '', t('excludedFiles', { count: excluded })))
      // Qoder warns when an external `@import` was refused, because a silently
      // unexpanded reference is invisible to the reader.
      const blocked = (change.pendingExternalImports || []).length
      if (blocked > 0) notices.push(note('blocked', 'dshmem-note-warn', t('blockedImports', { count: blocked })))
      // A file held back by its own `paths` glob is present but not loaded; say so,
      // or "my memory is missing" has no visible answer.
      const jit = change.jitSkipped || []
      if (jit.length > 0) {
        notices.push(
          note('jit', '', t('jitSkipped', { count: jit.length, paths: jit.map((file) => file.path).join(', ') })),
        )
      }
      // Index limits are advisory, and the warning is only useful where the
      // decision was made, so it rides on the generation result.
      const written = (status.lastGeneration && status.lastGeneration.writtenFiles) || []
      for (const file of written) {
        for (const warning of file.warnings || []) {
          notices.push(
            note('index-' + file.path, 'dshmem-note-warn', t('indexWarning', { path: file.path, message: warning.message })),
          )
        }
      }
      // A pass that asked for writes and landed none is `failed`, and a refused write
      // is the only place the reason exists: without this the panel says "failed" and
      // nothing says which write was refused or why.
      const refused = (status.lastGeneration && status.lastGeneration.failedFiles) || []
      for (const file of refused) {
        notices.push(
          note('refused-' + file.path, 'dshmem-note-error', t('writeRefused', { path: file.path, error: file.error })),
        )
      }
      return notices
    }

    /** Every project keeps its own memory; the note names the active session. */
    function projectNote(folder, t) {
      return h('div', { className: 'dshmem-muted' }, t('projectsNote', { cwd: folder ? folder.cwd : '' }))
    }

    /**
     * One scope card: its access, its root path, and a button per memory file.
     *
     * Extracted from the render body so the page reads as sections, and so the
     * per-file button wiring has one home.
     */
    function ScopeCard(root, t, onOpen, onDelete) {
      var writable = root.access === 'read-write'
      var access = h(
        'span',
        { className: 'dshmem-label' },
        root.id,
        ' ',
        h(Tag, { tone: writable ? 'outline' : 'quiet' }, writable ? t('readWrite') : t('readOnly')),
      )
      var files =
        root.files.length === 0
          ? h('div', { className: 'dshmem-muted' }, t('noFiles'))
          : root.files.map(function (file) {
              var open = () => onOpen(root.id, file)
              var remove = () => onDelete(root.id, file)
              return h(
                'div',
                { key: file, className: 'dshmem-file' },
                h('span', { className: 'dshmem-mono dshmem-name', title: file }, file),
                h(
                  'span',
                  { className: 'dshmem-actions' },
                  Button({ onClick: open, children: t('open') }),
                  // A read-only scope must not offer a delete it would refuse.
                  writable ? Button({ tone: 'danger', onClick: remove, children: t('delete') }) : null,
                ),
              )
            })
      return h(
        'div',
        { key: root.id, className: 'dshmem-card' },
        h('div', { className: 'dshmem-field' }, access, h('span', { className: 'dshmem-value dshmem-mono' }, root.path)),
        files,
      )
    }

    /** A labelled section wrapper: `Section(title, child, child, …)`.
     *
     * The children are spread as separate createElement arguments rather than
     * passed as one array — an array child is a keyed React list, which would
     * warn about missing `key` props on these static rows.
     */
    function Section(title) {
      var args = ['div', { className: 'dshmem-section' }, h('div', { className: 'dshmem-title' }, title)]
      for (var index = 1; index < arguments.length; index += 1) args.push(arguments[index])
      return h.apply(null, args)
    }

    /** A themed control button: `tone` is `outline` (default) or `primary`. */
    function Button(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dshmem-btn dshmem-btn-' + (props.tone === 'primary' || props.tone === 'danger' ? props.tone : 'outline'),
          disabled: props.disabled === true,
          onClick: props.onClick,
        },
        props.children,
      )
    }

    /**
     * The Settings → Memory page.
     *
     * `t` is injected by the slot layer from the declared `locale` namespace, so
     * every string below follows the active language and re-renders on a switch.
     */
    function MemorySection(props) {
      var t = props.t
      var [status, setStatus] = React.useState(null)
      var [scope, setScope] = React.useState('project')
      var [name, setName] = React.useState('MEMORY.md')
      var [text, setText] = React.useState('')
      var [message, setMessage] = React.useState(null)
      var [busy, setBusy] = React.useState(false)

      var load = React.useCallback(function () {
        return api('/api/memory/status').then(function (result) {
          if (result.ok) setStatus(result.data)
          else setStatus(null)
          return result
        })
      }, [])

      React.useEffect(
        function () {
          load()
          var timer = setInterval(load, 5000)
          return function () {
            clearInterval(timer)
          }
        },
        [load],
      )

      var openFile = React.useCallback(function (nextScope, nextName) {
        setScope(nextScope)
        setName(nextName)
        setMessage(null)
        return api(
          '/api/memory/file?scope=' + encodeURIComponent(nextScope) + '&path=' + encodeURIComponent(nextName),
        ).then(function (result) {
          if (result.ok && result.data) {
            setText(result.data.text || '')
            setMessage({ kind: 'ok', text: t('loadedBytes', { bytes: result.data.bytes }) })
          } else {
            setText('')
            setMessage({ kind: 'error', text: (result.data && result.data.error) || t('loadFailed') })
          }
        })
      }, [t])

      /**
       * Run one panel action: busy flag, one request, one message, never a throw.
       * Every button here has that shape, so it lives in one place.
       */
      var act = React.useCallback(
        function (path, init, ok, failed) {
          setBusy(true)
          setMessage(null)
          return api(path, init)
            .then(function (result) {
              if (result.ok && result.data) setMessage({ kind: 'ok', text: ok(result.data) })
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

      var save = React.useCallback(
        function () {
          var body = JSON.stringify({ scope: activeScope, path: name, content: text })
          var init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: body }
          var ok = function (data) {
            return t('savedFile', { scope: data.scope, path: data.path, bytes: data.bytes })
          }
          return act('/api/memory/file', init, ok, 'saveFailed').then(load)
        },
        [act, activeScope, name, text, load, t],
      )

      var refresh = React.useCallback(
        function () {
          var ok = function (data) {
            return data.injected ? t('reloaded') : t('nothingToReload', { reason: data.reason || t('noFiles') })
          }
          return act('/api/memory/refresh', { method: 'POST' }, ok, 'refreshFailed')
        },
        [act, t],
      )

      var flush = React.useCallback(
        function () {
          var ok = function (data) {
            return t('flushed', { count: data.flushed })
          }
          return act('/api/memory/flush', { method: 'POST' }, ok, 'flushFailed')
        },
        [act, t],
      )

      /**
       * Grant or revoke trust for the folder the panel is showing — Qoder's
       * "Trust this folder", which is the interactive half of the trust gate.
       */
      var setTrust = React.useCallback(
        function (action) {
          var init = {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: action }),
          }
          var ok = function () {
            return action === 'allow' ? t('trustAllowed') : t('trustRevoked')
          }
          return act('/api/memory/trust', init, ok, 'trustFailed').then(load)
        },
        [act, load, t],
      )

      /** Delete one file. On the file row, not the editor: a destructive action
       * should name its target. */
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
      var lastRead = status.lastConsumption
      var scopeOptions = status.roots.length > 0 ? status.roots : [{ id: 'project' }]
      // A controlled select must show what it will load; fall back to one that exists.
      var activeScope = scopeOptions.some((root) => root.id === scope) ? scope : scopeOptions[0].id

      var gateText =
        status.gate.kind === 'custom'
          ? t('gateCustom', { timeout: status.gate.timeoutMs, onGateError: status.gate.onGateError })
          : t('gateBuiltin', { minPromptChars: status.gate.minPromptChars })
      // `id (status)`, not `id=status`: this row is prose, and the parentheses
      // read as one value instead of an assignment chain.
      var consumptionText = lastRead
        ? lastRead.status +
          ' — ' +
          (lastRead.files.length === 0
            ? t('noFilesConsidered')
            : lastRead.files
                .map(function (file) {
                  return file.id + ' (' + file.status + ')'
                })
                .join(', '))
        : t('noneYet')

      return h(
        'div',
        { className: 'dshmem-page' },

        h('style', null, CSS),

        Section(t('title'), h('div', { className: 'dshmem-intro' }, t('intro'))),

        Section(
          t('statusTitle'),
          Row(
            t('plugin'),
            h(Tag, { tone: status.enabled ? 'success' : 'quiet' }, status.enabled ? t('enabled') : t('disabled')),
          ),
          Row(t('mode'), status.mode),
          Row(t('generation'), OnOff(status.generationEnabled, t)),
          Row(t('consumption'), OnOff(status.consumptionEnabled, t)),
          Row(t('dream'), OnOff(status.dreamEnabled, t)),
          Row(t('gate'), gateText),
          Row(t('trust'), TrustRow(status.trust, t, setTrust, busy)),
          Row(t('pending'), String(status.pendingGenerations)),
        ),

        Section(
          t('scopesTitle'),
          projectNote(status.projectFolder, t),
          status.roots.length === 0
            ? h('div', { className: 'dshmem-muted' }, t('noScope'))
            : status.roots.map(function (root) {
                return ScopeCard(root, t, openFile, removeFile)
              }),
        ),

        Section(
          t('budgetTitle'),
          Row(t('maxTokens'), String(status.maxTokens)),
          Row(t('overflow'), status.overflow),
          Row(t('failureMode'), status.failureMode),
          Row(t('generationCap'), String(status.maxOutputTokens === undefined ? '—' : status.maxOutputTokens)),
          Row(t('pauseAfter'), String(status.pauseAfterFailures === undefined ? '—' : status.pauseAfterFailures)),
        ),

        Section.apply(
          null,
          [
            t('activityTitle'),
            Row(t('lastGeneration'), last ? last.status + ' (' + t('turn', { turn: last.turnIndex }) + ')' + (last.reason ? ' — ' + last.reason : '') : t('noneYet')),
            Row(t('lastConsumption'), consumptionText),
            Row(
              t('lastDream'),
              status.lastDream
                ? status.lastDream.status + ' — ' + (status.lastDream.reason || t('noneYet'))
                : t('noneYet'),
            ),
          ].concat(qualityNotices(status, t)),
        ),

        Section(
          t('editorTitle'),
          h(
            'div',
            { className: 'dshmem-toolbar' },
            h(
              'select',
              { className: 'dshmem-select', value: activeScope, onChange: (event) => setScope(event.target.value) },
              scopeOptions.map(function (root) {
                return h('option', { key: root.id, value: root.id }, root.id)
              }),
            ),
            h('input', {
              className: 'dshmem-input dshmem-grow',
              value: name,
              spellCheck: false,
              placeholder: t('filenamePlaceholder'),
              onChange: (event) => setName(event.target.value),
            }),
            Button({ onClick: () => openFile(activeScope, name), children: t('load') }),
          ),
          h('textarea', {
            className: 'dshmem-textarea',
            value: text,
            spellCheck: false,
            placeholder: t('contentPlaceholder'),
            onChange: (event) => setText(event.target.value),
          }),
          h(
            'div',
            { className: 'dshmem-toolbar' },
            Button({ tone: 'primary', disabled: busy, onClick: save, children: t('save') }),
            Button({ disabled: busy, onClick: refresh, children: t('reload') }),
            Button({ disabled: busy, onClick: flush, children: t('flush') }),
          ),
          message === null
            ? null
            : h('p', { className: 'dshmem-note' + (message.kind === 'error' ? ' dshmem-note-error' : '') }, message.text),
        ),

        Section(
          t('commandsTitle'),
          // One line: what each command does lives in the README, and the panel
          // budget has no room for three hint sentences.
          h(
            'div',
            { className: 'dshmem-muted dshmem-code' },
            [t('commandConfig'), t('commandRefresh'), t('commandFlush'), t('commandDelete'), t('commandTrust'), t('commandResume')].join(' · '),
          ),
        ),
      )
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
      },
    }
  },
})
