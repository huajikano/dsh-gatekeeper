window.__ModuleLoader__.load({
  id: 'dsh-refusal-guard',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // A fixed overlay must leave the docked composer, so it portals when the
    // module table offers react-dom and renders inline when it does not.
    let createPortal = null
    try {
      const reactDom = require('react-dom')
      if (reactDom !== null && typeof reactDom.createPortal === 'function') createPortal = reactDom.createPortal
    } catch {
      createPortal = null
    }

    const NS = 'refusal-guard'
    const STATE_PATH = '/api/dsh-refusal-guard/state'
    const DECIDE_PATH = '/api/dsh-refusal-guard/decide'
    const CONFIG_PATH = '/api/dsh-refusal-guard/config'

    /** Fallback copy; the locale service overrides it when available. */
    const ZH = {
      title: '拒绝拦截',
      nav: '拒绝拦截',
      lead: '在模型的拒绝性回复进入会话之前把它拦下来。',
      enabled: '启用拦截',
      enabledHint: '关闭后所有回复原样进入会话。',
      interceptAt: '拦截位置',
      interceptAtStream: 'llm/stream（解析后的回复，默认）',
      interceptAtWire: 'TLS 之前（HTTP 出站，最上游）',
      interceptAtBoth: '两层都开',
      interceptAtHint: 'TLS 之前：钩住 globalThis.fetch，在加密前看到请求与响应，能看到出站请求体，但拿不到会话信息，且被拦的流要用协议终止帧收尾。llm/stream：结构化 chunk、知道会话，替换干净。',
      wireSection: 'TLS 层选项',
      wireScanResponses: '检查响应流',
      wireScanResponsesHint: '边收边判，命中即中止上游连接。',
      wireScanRequests: '检查出站请求',
      wireScanRequestsHint: '在请求发出前扫描提示词内容。',
      wireBlockRequests: '命中就拒发（否则只记录）',
      wireAbortUpstream: '命中后断开上游',
      wireAbortUpstreamHint: '省掉剩余 token，但流会以终止帧收尾。',
      wireUrlPatterns: 'LLM 端点匹配',
      wireUrlPatternsHint: '每行一个片段，URL 含任一片段才处理。留空等于关闭 TLS 层。',
      wireTerminator: '终止帧',
      wireTerminatorHint: '中止响应后补的帧；OpenAI 兼容流用 data: [DONE]。留空则直接关闭。',
      onDetect: '命中后',
      onDetectAsk: '先问我（暂存回复，等我放行或丢弃）',
      onDetectBlock: '直接丢弃（换成一句标记）',
      onDetectHint: '选“先问我”时，回复会暂停在待审区，等你决定后原样放行或丢弃。',
      dryRun: '演练模式',
      dryRunHint: '只记录不拦截，用来先观察判定是否准确。',
      scanReasoning: '同时检查思考内容',
      scanReasoningHint: '思考里引用的拒绝句也算命中（含引号内的句子）。关掉就只看最终回复。',
      blocklist: '自定义拦截词库',
      blocklistHint: '一行一个，纯文本匹配（不区分大小写），命中任一行就拦截。用来补内置规则抓不到的说法。',
      blocklistPlaceholder: '例如：\n帮不了\n无法配合\nnot able to help',
      blocklistCount: '当前 {count} 条',
      blocklistSeed: '填入推荐词库',
      blocklistClear: '清空',
      callsSeen: '本插件已检查 {calls} 次模型调用',
      callsHint: '如果模型明明回了拒绝话术但这个数字没涨，说明插件当时没被加载。',
      scanChars: '检测长度',
      scanCharsHint: '检查回复的前多少个字符。',
      askTimeoutMs: '等待超时（毫秒）',
      askTimeoutHint: '超时无人处理就按丢弃处理。',
      replacement: '替换文本',
      replacementHint: '丢弃后写进会话的那一句。',
      blockToolCalls: '连带工具调用一起拦',
      blockToolCallsHint: '默认放行带工具调用的回复——它在干活，不是在拒绝。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存（插件会重启生效）',
      saveFailed: '保存失败',
      invalidNumber: '检测长度和等待超时必须是整数（检测长度 ≥ 1，等待超时 ≥ 1）',
      loading: '正在读取配置…',
      loadingFailed: '读不到配置：插件路由没有响应。检查插件是否启用，或点上面的「重试」。',
      pending: '待审回复',
      pendingEmpty: '没有待审的回复。',
      recent: '最近记录',
      recentEmpty: '还没有拦截记录。',
      outcomeBlocked: '已拦截',
      outcomeReleased: '已放行',
      outcomeDry: '演练命中',
      release: '放行',
      block: '丢弃',
      chars: '字符',
      counters: '累计：拦截 {blocked} · 放行 {released} · 待审 {asked}',
      bannerLead: '有 {count} 条回复被拦下，等待你决定',
      bannerOpen: '去处理',
      bannerHint: '点这里查看具体内容',
      reviewTitle: '审核被拦截的回复',
      reviewHint: '放行后原文会进入会话，这一轮继续；丢弃则什么都不写。',
      close: '关闭',
      error: '读取状态失败',
      reload: '重试',
    }

    const EN = {
      title: 'Refusal guard',
      nav: 'Refusal guard',
      lead: 'Stops a refusal reply before it enters the session context.',
      enabled: 'Guard replies',
      enabledHint: 'When off, every reply enters the session unchanged.',
      interceptAt: 'Intercept at',
      interceptAtStream: 'llm/stream — parsed reply (default)',
      interceptAtWire: 'Before TLS — outbound HTTP (earliest)',
      interceptAtBoth: 'Both layers',
      interceptAtHint: 'Before TLS hooks globalThis.fetch, seeing the request and response before encryption. It can inspect the outgoing body, but knows nothing about sessions and must close a blocked stream with a protocol terminator. llm/stream sees structured chunks with the session attached and replaces cleanly.',
      wireSection: 'TLS-layer options',
      wireScanResponses: 'Inspect the response stream',
      wireScanResponsesHint: 'Decide while streaming; a match cancels the upstream connection.',
      wireScanRequests: 'Inspect the outgoing request',
      wireScanRequestsHint: 'Scan the prompt before it is sent.',
      wireBlockRequests: 'Refuse to send on a match (otherwise record only)',
      wireAbortUpstream: 'Cancel the upstream connection on a match',
      wireAbortUpstreamHint: 'Saves the remaining tokens; the stream closes with the terminator frame.',
      wireUrlPatterns: 'LLM endpoint matching',
      wireUrlPatternsHint: 'One fragment per line; a URL is inspected only when it contains one. Empty disables the TLS layer.',
      wireTerminator: 'Terminator frame',
      wireTerminatorHint: 'Appended after a cancelled response; OpenAI-compatible streams use data: [DONE]. Empty closes the body directly.',
      onDetect: 'On a match',
      onDetectAsk: 'Ask me first (hold the reply until I release or discard it)',
      onDetectBlock: 'Discard it (replace with a marker)',
      onDetectHint: 'With “ask me first”, the reply pauses in the pending list until you decide.',
      dryRun: 'Dry run',
      dryRunHint: 'Record detections without blocking, to check the rule first.',
      scanReasoning: 'Also inspect reasoning',
      scanReasoningHint: 'A refusal quoted inside the thinking counts too. Off means only the final reply is checked.',
      blocklist: 'Custom blocklist',
      blocklistHint: 'One entry per line, plain case-insensitive text. Any hit blocks. Use it for phrasings the built-in rules miss.',
      blocklistPlaceholder: 'for example:\nnot able to help\ncannot assist with',
      blocklistCount: '{count} entries',
      blocklistSeed: 'Fill in a starter list',
      blocklistClear: 'Clear',
      callsSeen: 'This plugin has inspected {calls} model calls',
      callsHint: 'If a refusal went through while this number did not move, the plugin was not loaded at that moment.',
      scanChars: 'Scan length',
      scanCharsHint: 'How many leading characters of a reply to inspect.',
      askTimeoutMs: 'Decision timeout (ms)',
      askTimeoutHint: 'Unattended replies are discarded after this.',
      replacement: 'Replacement text',
      replacementHint: 'What the session sees instead of a discarded reply.',
      blockToolCalls: 'Also block replies that call tools',
      blockToolCallsHint: 'By default a tool-calling reply is doing work, not refusing.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved — the plugin restarts to apply it',
      saveFailed: 'Save failed',
      invalidNumber: 'The numeric fields must be whole numbers (scan length >= 1, timeout >= 1)',
      loading: 'Loading configuration…',
      loadingFailed: 'Cannot read the configuration: the plugin routes did not answer. Check that the plugin is enabled, or press Retry above.',
      pending: 'Pending replies',
      pendingEmpty: 'Nothing is waiting.',
      recent: 'Recent records',
      recentEmpty: 'No detections yet.',
      outcomeBlocked: 'blocked',
      outcomeReleased: 'released',
      outcomeDry: 'dry-run hit',
      release: 'Release',
      block: 'Discard',
      chars: 'chars',
      counters: 'Total: {blocked} blocked · {released} released · {asked} asked',
      bannerLead: '{count} reply held for your decision',
      bannerOpen: 'Review',
      bannerHint: 'Click to see the content',
      reviewTitle: 'Review the held reply',
      reviewHint: 'Releasing puts the original text into the session and the turn continues; discarding writes nothing.',
      close: 'Close',
      error: 'Could not read the guard state',
      reload: 'Retry',
    }

    /** Fill `{name}` placeholders. */
    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (whole, key) => (key in values ? String(values[key]) : whole))
    }

    /** Read the guard state from this package's Host half. */
    async function readState() {
      const response = await fetch(new URL(STATE_PATH, window.location.origin), { credentials: 'include' })
      if (!response.ok) throw new Error('HTTP ' + String(response.status))
      return await response.json()
    }

    /** POST one JSON body to a route of this package's Host half. */
    async function postJson(path, body) {
      const response = await fetch(new URL(path, window.location.origin), {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const value = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(value && value.error ? value.error : 'HTTP ' + String(response.status))
      return value
    }

    /**
     * Poll the guard state while a component is mounted.
     *
     * @param intervalMs - poll period.
     * @returns the latest state, the last error, and a manual refresh.
     */
    function useGuardState(intervalMs) {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [nonce, setNonce] = React.useState(0)

      React.useEffect(() => {
        let live = true
        const ask = async () => {
          try {
            const next = await readState()
            if (!live) return
            setState(next)
            setError(null)
          } catch (failure) {
            if (live) setError(failure instanceof Error ? failure.message : String(failure))
          }
        }
        ask()
        const timer = window.setInterval(ask, intervalMs)
        return () => {
          live = false
          window.clearInterval(timer)
        }
      }, [intervalMs, nonce])

      return { state, error, refresh: () => setNonce((value) => value + 1) }
    }

    /** Readable timestamp for one pending entry. */
    function clockOf(createdAt) {
      try {
        return new Date(createdAt).toLocaleTimeString()
      } catch {
        return ''
      }
    }

    /**
     * One button that keeps the host look while staying self-contained.
     *
     * Every color carries a literal fallback. A theme variable that resolves to
     * nothing in this slot context used to make the primary button transparent
     * on transparent — present in the DOM, invisible on screen.
     */
    function Button(props) {
      const base = {
        font: 'inherit',
        fontSize: 12,
        lineHeight: '20px',
        padding: '0 10px',
        height: 28,
        borderRadius: 6,
        cursor: props.disabled ? 'default' : 'pointer',
        opacity: props.disabled ? 0.5 : 1,
        border: '1px solid var(--dsw-alias-border-l2, #c9ced6)',
        background: props.primary
          ? 'var(--dsw-alias-brand-primary, #2b6cb0)'
          : 'var(--dsw-alias-bg-layer-1, #ffffff)',
        color: props.primary ? '#ffffff' : 'var(--dsw-alias-label-primary, #1a1d21)',
        whiteSpace: 'nowrap',
      }
      return h('button', {
        type: 'button',
        disabled: props.disabled,
        onClick: props.onClick,
        style: { ...base, ...(props.style || {}) },
        title: props.title,
      }, props.children)
    }

    /** A labelled control row. */
    function Row(props) {
      return h('div', { style: { display: 'grid', gap: 4, padding: '10px 0', borderTop: '1px solid var(--dsw-alias-border-l1)' } },
        h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, props.label),
        props.hint ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, props.hint) : null,
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 } }, props.children),
      )
    }

    /** The checkbox used by the boolean settings. */
    function Toggle(props) {
      return h('label', { style: { display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' } },
        h('input', {
          type: 'checkbox',
          checked: props.checked,
          onChange: (event) => props.onChange(event.target.checked),
          style: { accentColor: 'var(--dsw-alias-brand-primary)' },
        }),
        props.children,
      )
    }

    /** The numeric and text inputs. */
    function textStyle() {
      return {
        font: 'inherit',
        fontSize: 13,
        padding: '0 8px',
        height: 28,
        minWidth: 120,
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
      }
    }

    /** Fields edited as text and parsed once, on save, with their minimum. */
    const NUMERIC_FIELDS = { scanChars: 1, minChars: 0, askTimeoutMs: 1 }

    /**
     * Build stamp shown in the page header.
     *
     * It exists so a stale browser bundle is visible at a glance: if the number
     * on screen is not the one in this file, the page is running old code and no
     * amount of Host-side fixing can change what is rendered.
     */
    const BUILD = 'b7-save-always'

    /** A starter word list for the phrasings the built-in rules do not cover. */
    const SEED_BLOCKLIST = [
      '帮不了',
      '帮不上',
      '无法配合',
      '不能配合',
      '恕难从命',
      'not able to help',
      'unable to comply',
      'cannot assist with',
      'not something i can help',
    ]

    /**
     * One held reply with the two decisions that settle it.
     */
    function PendingItem(props) {
      const [localBusy, setLocalBusy] = React.useState(false)
      const t = props.t
      const item = props.item
      const busy = props.busy === true || localBusy
      // The review panel drives the decision; the settings page lets the item
      // decide for itself. One component serves both.
      const decide = async (action) => {
        if (typeof props.onDecide === 'function') {
          await props.onDecide(action)
          return
        }
        setLocalBusy(true)
        try {
          await postJson(DECIDE_PATH, { id: item.id, action })
          props.onSettled()
        } catch (failure) {
          props.onError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setLocalBusy(false)
        }
      }
      return h('div', {
        style: {
          display: 'grid',
          gap: 6,
          padding: 10,
          borderRadius: 8,
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-2)',
        },
      },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
          h('span', { style: { color: 'var(--dsw-alias-state-warn-primary)' } }, item.reason || 'refusal'),
          h('span', {}, String(item.chars) + ' ' + t('chars')),
          h('span', {}, clockOf(item.createdAt)),
          item.sessionId ? h('span', { style: { opacity: 0.7 } }, String(item.sessionId).slice(0, 8)) : null,
        ),
        h('div', {
          style: {
            fontSize: 13,
            color: 'var(--dsw-alias-label-primary)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 320,
            overflow: 'auto',
          },
        }, item.body || item.head || ''),
        h('div', { style: { display: 'flex', gap: 8 } },
          h(Button, { onClick: () => decide('release'), disabled: busy, primary: true }, t('release')),
          h(Button, { onClick: () => decide('block'), disabled: busy }, t('block')),
        ),
      )
    }

    /**
     * The settings page.
     */
    function SettingsPage(props) {
      const t = props.t
      const { state, error, refresh } = useGuardState(1500)
      const [draft, setDraft] = React.useState(null)
      const [status, setStatus] = React.useState('')

      const config = state && state.config ? state.config : null
      React.useEffect(() => {
        if (config !== null && draft === null) setDraft(config)
      }, [config, draft])

      const current = draft || config
      const patch = (field) => (value) => setDraft({ ...(draft || config || {}), [field]: value })

      /**
       * Turn the draft into the body the Host accepts.
       *
       * Number fields are edited as strings so keystrokes are never coerced
       * mid-typing — converting on every keystroke made the field rewrite
       * itself while being edited. They are parsed once, here.
       *
       * @returns {object | null} the payload, or null when a field is invalid.
       */
      const payloadOf = (source) => {
        const body = { ...source }
        for (const [field, minimum] of Object.entries(NUMERIC_FIELDS)) {
          const raw = body[field]
          if (raw === undefined) continue
          const parsed = Number.parseInt(String(raw).trim(), 10)
          if (!Number.isInteger(parsed) || parsed < minimum) return null
          body[field] = parsed
        }
        return body
      }

      const save = async () => {
        if (current == null) return
        const body = payloadOf(current)
        if (body === null) {
          setStatus('failed:' + t('invalidNumber'))
          return
        }
        setStatus('saving')
        try {
          await postJson(CONFIG_PATH, body)
          setStatus('saved')
          // The plugin restarts with the saved values; drop the stale draft so
          // the next poll shows what actually took effect.
          setDraft(null)
        } catch (failure) {
          setStatus('failed:' + (failure instanceof Error ? failure.message : String(failure)))
        }
      }

      const pending = state && Array.isArray(state.pending) ? state.pending : []
      const recent = state && Array.isArray(state.recent) ? state.recent : []
      const counters = (state && state.counters) || { blocked: 0, released: 0, asked: 0 }

      return h('div', { style: { display: 'grid', gap: 4, maxWidth: 720 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10 } },
          h('h2', { style: { margin: 0, fontSize: 18, color: 'var(--dsw-alias-label-primary)' } }, t('title')),
          h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, BUILD),
        ),
        h('p', { style: { margin: '2px 0 10px', fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, t('lead')),

        // The one number that separates "the rule missed it" from "the plugin
        // was not running", which are indistinguishable from the conversation.
        state !== null
          ? h('div', {
            style: {
              fontSize: 12,
              color: 'var(--dsw-alias-label-secondary)',
              padding: '6px 10px',
              marginBottom: 6,
              borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-layer-2)',
            },
            title: t('callsHint'),
          }, fill(t('callsSeen'), { calls: (state.counters && state.counters.calls) || 0 }))
          : null,

        error ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', paddingBottom: 8 } },
          t('error') + ': ' + error + ' ',
          h(Button, { onClick: refresh, style: { height: 22 } }, t('reload')),
        ) : null,

        // The button stays on screen even when the state cannot be read: a
        // vanished save button is indistinguishable from a broken panel.
        current == null ? h('div', { style: { display: 'grid', gap: 10, paddingTop: 6 } },
          h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } },
            error === null ? t('loading') : t('loadingFailed')),
          h('div', {},
            h(Button, { disabled: true }, t('save')),
          ),
        ) : h('div', {},
          h(Row, { label: t('enabled'), hint: t('enabledHint') },
            h(Toggle, { checked: current.enabled !== false, onChange: patch('enabled') }, current.enabled !== false ? 'on' : 'off'),
          ),
          h(Row, { label: t('interceptAt'), hint: t('interceptAtHint') },
            h('select', {
              value: current.interceptAt === 'wire' ? 'wire' : current.interceptAt === 'both' ? 'both' : 'stream',
              onChange: (event) => patch('interceptAt')(event.target.value),
              style: { ...textStyle(), minWidth: 360 },
            },
              h('option', { value: 'stream' }, t('interceptAtStream')),
              h('option', { value: 'wire' }, t('interceptAtWire')),
              h('option', { value: 'both' }, t('interceptAtBoth')),
            ),
          ),
          // The TLS-layer block only has meaning when that layer is on.
          (current.interceptAt === 'wire' || current.interceptAt === 'both')
            ? h('div', {
              style: {
                display: 'grid',
                gap: 0,
                padding: '4px 12px 2px',
                margin: '6px 0',
                borderRadius: 8,
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'var(--dsw-alias-bg-layer-2)',
              },
            },
              h('div', { style: { fontSize: 12, fontWeight: 600, padding: '8px 0 2px', color: 'var(--dsw-alias-label-primary)' } }, t('wireSection')),
              h(Row, { label: t('wireScanResponses'), hint: t('wireScanResponsesHint') },
                h(Toggle, { checked: current.wireScanResponses !== false, onChange: patch('wireScanResponses') }, current.wireScanResponses !== false ? 'on' : 'off'),
              ),
              h(Row, { label: t('wireScanRequests'), hint: t('wireScanRequestsHint') },
                h(Toggle, { checked: current.wireScanRequests === true, onChange: patch('wireScanRequests') }, current.wireScanRequests === true ? 'on' : 'off'),
              ),
              h(Row, { label: t('wireBlockRequests') },
                h(Toggle, { checked: current.wireBlockRequests === true, onChange: patch('wireBlockRequests') }, current.wireBlockRequests === true ? 'on' : 'off'),
              ),
              h(Row, { label: t('wireAbortUpstream'), hint: t('wireAbortUpstreamHint') },
                h(Toggle, { checked: current.wireAbortUpstream !== false, onChange: patch('wireAbortUpstream') }, current.wireAbortUpstream !== false ? 'on' : 'off'),
              ),
              h(Row, { label: t('wireUrlPatterns'), hint: t('wireUrlPatternsHint') },
                h('textarea', {
                  value: (current.wireUrlPatterns || []).join('\n'),
                  onChange: (event) => patch('wireUrlPatterns')(event.target.value.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)),
                  spellCheck: false,
                  style: { ...textStyle(), height: 88, minWidth: 420, padding: '6px 8px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', resize: 'vertical', lineHeight: '18px' },
                }),
              ),
              h(Row, { label: t('wireTerminator'), hint: t('wireTerminatorHint') },
                h('input', {
                  type: 'text',
                  value: String(current.wireTerminator ?? ''),
                  onChange: (event) => patch('wireTerminator')(event.target.value),
                  style: { ...textStyle(), flex: 1, minWidth: 320, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
                }),
              ),
            )
            : null,
          h(Row, { label: t('onDetect'), hint: t('onDetectHint') },
            h('select', {
              value: current.onDetect === 'block' ? 'block' : 'ask',
              onChange: (event) => patch('onDetect')(event.target.value),
              style: { ...textStyle(), minWidth: 320 },
            },
              h('option', { value: 'ask' }, t('onDetectAsk')),
              h('option', { value: 'block' }, t('onDetectBlock')),
            ),
          ),
          h(Row, { label: t('dryRun'), hint: t('dryRunHint') },
            h(Toggle, { checked: current.dryRun === true, onChange: patch('dryRun') }, current.dryRun === true ? 'on' : 'off'),
          ),
          h(Row, { label: t('scanReasoning'), hint: t('scanReasoningHint') },
            h(Toggle, { checked: current.scanReasoning !== false, onChange: patch('scanReasoning') }, current.scanReasoning !== false ? 'on' : 'off'),
          ),
          h(Row, { label: t('scanChars'), hint: t('scanCharsHint') },
            h('input', {
              type: 'number',
              min: 1,
              value: String(current.scanChars ?? 600),
              // Kept as text while editing; parsed on save.
              onChange: (event) => patch('scanChars')(event.target.value),
              style: textStyle(),
            }),
          ),
          h(Row, { label: t('askTimeoutMs'), hint: t('askTimeoutHint') },
            h('input', {
              type: 'number',
              min: 1,
              step: 1000,
              value: String(current.askTimeoutMs ?? 120000),
              onChange: (event) => patch('askTimeoutMs')(event.target.value),
              style: textStyle(),
            }),
          ),
          h(Row, { label: t('replacement'), hint: t('replacementHint') },
            h('input', {
              type: 'text',
              value: String(current.replacementText ?? ''),
              onChange: (event) => patch('replacementText')(event.target.value),
              style: { ...textStyle(), flex: 1, minWidth: 320 },
            }),
          ),
          h(Row, { label: t('blockToolCalls'), hint: t('blockToolCallsHint') },
            h(Toggle, { checked: current.blockToolCalls === true, onChange: patch('blockToolCalls') }, current.blockToolCalls === true ? 'on' : 'off'),
          ),
          h(Row, {
            label: t('blocklist'),
            hint: t('blocklistHint') + ' · ' + fill(t('blocklistCount'), { count: (current.blocklist || []).length }),
          },
            h('textarea', {
              value: (current.blocklist || []).join('\n'),
              placeholder: t('blocklistPlaceholder'),
              onChange: (event) => patch('blocklist')(event.target.value.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)),
              spellCheck: false,
              style: {
                ...textStyle(),
                height: 132,
                minWidth: 420,
                padding: '6px 8px',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                resize: 'vertical',
                lineHeight: '18px',
              },
            }),
          ),
          h('div', { style: { display: 'flex', gap: 8, padding: '0 0 6px' } },
            h(Button, {
              onClick: () => {
                const existing = new Set((current.blocklist || []).map((word) => word.toLowerCase()))
                const merged = [...(current.blocklist || [])]
                for (const word of SEED_BLOCKLIST) if (!existing.has(word.toLowerCase())) merged.push(word)
                patch('blocklist')(merged)
              },
            }, t('blocklistSeed')),
            h(Button, { onClick: () => patch('blocklist')([]) }, t('blocklistClear')),
          ),
          h('div', {
            style: {
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              flexWrap: 'wrap',
              margin: '14px 0 4px',
              padding: '12px 14px',
              borderRadius: 8,
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-layer-2)',
            },
          },
            h(Button, {
              onClick: save,
              disabled: status === 'saving',
              primary: true,
              style: { height: 32, padding: '0 20px', fontSize: 13, fontWeight: 600 },
            }, status === 'saving' ? t('saving') : t('save')),
            status === 'saved' ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-success-primary)' } }, t('saved')) : null,
            status.startsWith('failed:') ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, t('saveFailed') + ': ' + status.slice(7)) : null,
            h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginLeft: 'auto' } }, BUILD),
          ),
        ),

        h('h3', { style: { margin: '18px 0 6px', fontSize: 15, color: 'var(--dsw-alias-label-primary)' } }, t('pending')),
        h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', paddingBottom: 8 } },
          fill(t('counters'), counters),
        ),
        pending.length === 0
          ? h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', padding: '10px 0' } }, t('pendingEmpty'))
          : h('div', { style: { display: 'grid', gap: 8 } }, pending.map((item) =>
            h(PendingItem, {
              key: item.id,
              item,
              t,
              // Once the reply is settled the panel has nothing left to show,
              // so it closes and returns the user to the conversation.
              onSettled: () => {
                refresh()
                if (typeof props.close === 'function') props.close()
              },
              onError: (message) => setStatus('failed:' + message),
            }))),

        h('h3', { style: { margin: '18px 0 6px', fontSize: 15, color: 'var(--dsw-alias-label-primary)' } }, t('recent')),
        recent.length === 0
          ? h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', padding: '10px 0' } }, t('recentEmpty'))
          : h('div', { style: { display: 'grid', gap: 6 } }, recent.map((entry, index) =>
            h('div', {
              key: String(entry.at) + '-' + String(index),
              style: {
                display: 'grid',
                gap: 4,
                padding: '8px 10px',
                borderRadius: 8,
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'var(--dsw-alias-bg-layer-2)',
              },
            },
              h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
                h('span', {
                  style: {
                    color: entry.dryRun
                      ? 'var(--dsw-alias-state-warn-primary)'
                      : entry.released
                        ? 'var(--dsw-alias-state-success-primary)'
                        : 'var(--dsw-alias-state-error-primary)',
                  },
                }, entry.dryRun ? t('outcomeDry') : entry.released ? t('outcomeReleased') : t('outcomeBlocked')),
                h('span', {}, entry.reason || ''),
                h('span', {}, String(entry.chars ?? 0) + ' ' + t('chars')),
                h('span', {}, clockOf(entry.at)),
                entry.sessionId ? h('span', { style: { opacity: 0.7 } }, String(entry.sessionId).slice(0, 8)) : null,
              ),
              h('div', {
                style: {
                  fontSize: 12,
                  color: 'var(--dsw-alias-label-primary)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  opacity: 0.85,
                },
              }, entry.head || ''),
            ))),
      )
    }

    /**
     * A fixed overlay that leaves the docked composer.
     *
     * The dock slot warns that the composer contains fixed children, so the card
     * portals to the document body whenever the module table offers react-dom.
     * Without it the card still renders, inline, rather than failing.
     */
    function Overlay(props) {
      const [mounted, setMounted] = React.useState(false)
      React.useEffect(() => {
        setMounted(true)
        const onKey = (event) => {
          if (event.key === 'Escape') props.onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [props.onClose])

      const backdrop = {
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'rgba(0, 0, 0, 0.45)',
      }
      const card = {
        display: 'grid',
        gap: 10,
        width: 'min(720px, 100%)',
        maxHeight: '80vh',
        overflow: 'auto',
        padding: 16,
        borderRadius: 12,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-overlay)',
        boxShadow: '0 12px 40px rgba(0, 0, 0, 0.35)',
      }
      const node = h('div', {
        style: backdrop,
        role: 'dialog',
        'aria-modal': 'true',
        onClick: (event) => {
          if (event.target === event.currentTarget) props.onClose()
        },
      }, h('div', { style: card }, props.children))

      if (createPortal !== null && mounted) return createPortal(node, document.body)
      return node
    }

    /**
     * The review panel: full content of every reply this session is waiting on.
     */
    function ReviewPanel(props) {
      const t = props.t
      const { state, refresh } = useGuardState(1500)
      const [busyId, setBusyId] = React.useState(null)
      const all = state && Array.isArray(state.pending) ? state.pending : []
      const pending = typeof props.sessionId === 'string'
        ? all.filter((item) => item.sessionId === props.sessionId)
        : all

      // Nothing left to decide: leave the way the user asked for.
      React.useEffect(() => {
        if (state !== null && pending.length === 0) props.onClose()
      }, [state, pending.length, props.onClose])

      const decide = async (id, action) => {
        setBusyId(id)
        try {
          await postJson(DECIDE_PATH, { id, action })
          await refresh()
        } catch (failure) {
          props.onError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusyId(null)
        }
      }

      return h(Overlay, { onClose: props.onClose },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
          h('h2', { style: { margin: 0, fontSize: 16, color: 'var(--dsw-alias-label-primary)' } }, t('reviewTitle')),
          h(Button, { onClick: props.onClose, style: { marginLeft: 'auto' } }, t('close')),
        ),
        h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('reviewHint')),
        pending.length === 0
          ? h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', padding: '12px 0' } }, t('pendingEmpty'))
          : pending.map((item) => h(PendingItem, {
            key: item.id,
            item,
            t,
            busy: busyId === item.id,
            onDecide: (action) => decide(item.id, action),
            onError: props.onError,
          })),
      )
    }

    /**
     * The banner under the composer: click it to open the review panel.
     */
    function PendingBanner(props) {
      const t = props.t
      const { state } = useGuardState(2000)
      const [open, setOpen] = React.useState(false)
      const [error, setError] = React.useState(null)
      const all = state && Array.isArray(state.pending) ? state.pending : []
      // The dock is session-scoped: show only the replies this session is waiting on.
      const sessionId = props.sessionId
      const pending = typeof sessionId === 'string' ? all.filter((item) => item.sessionId === sessionId) : all
      const close = React.useCallback(() => setOpen(false), [])

      if (pending.length === 0 && !open) return null

      return h('div', {},
        h('div', {
          role: 'button',
          tabIndex: 0,
          onClick: () => setOpen(true),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') setOpen(true)
          },
          style: {
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            flexWrap: 'wrap',
            margin: '8px 0',
            padding: '8px 12px',
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-state-warn-primary)',
            background: 'var(--dsw-alias-bg-layer-2)',
            fontSize: 12,
            color: 'var(--dsw-alias-label-primary)',
            cursor: 'pointer',
          },
        },
          h('span', { style: { color: 'var(--dsw-alias-state-warn-primary)' } },
            fill(t('bannerLead'), { count: pending.length })),
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, t('bannerHint')),
          h('span', { style: { marginLeft: 'auto', color: 'var(--dsw-alias-brand-primary)' } }, t('bannerOpen') + ' →'),
        ),
        open ? h(ReviewPanel, {
          t,
          sessionId,
          onClose: close,
          onError: (message) => setError(message),
        }) : null,
        error !== null
          ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, error)
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        let t = (key) => ZH[key] || EN[key] || key
        try {
          const locale = ctx.get('locale')
          if (locale) {
            ctx.effect(() => locale.register(NS, { zh: ZH, en: EN }), 'refusal-guard: dictionaries')
            t = locale.bind(NS)
          }
        } catch {
          /* keep the built-in copy */
        }

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'refusal-guard',
          order: 36,
          label: () => t('nav'),
          inject: () => ({ t }),
        }, SettingsPage))

        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'refusal-guard-pending',
          order: 50,
          inject: () => ({ t }),
        }, PendingBanner))
      },
    }
  },
})
