window.__ModuleLoader__.load({
  id: 'dsh-gatekeeper',
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

    const NS = 'gatekeeper'
    const STATE_PATH = '/api/dsh-gatekeeper/state'
    const DECIDE_PATH = '/api/dsh-gatekeeper/decide'
    const CONFIG_PATH = '/api/dsh-gatekeeper/config'
    const PREVIEW_PATH = '/api/dsh-gatekeeper/preview'

    /** Fallback copy; the locale service overrides it when available. */
    const ZH = {
      minCharsLabel: '最短检测长度',
      wireReleaseLabel: '网络模式放行长度',
      tabSettings: "设置",
      tabReview: "待审核",
      tabHistory: "最近记录",
      basicTitle: "拦截方式",
      basicHint: "选择内容在何处检查，以及命中后的处理方式。",
      scopeTitle: "检测范围",
      scopeHint: "扩大检测范围可能增加误拦。工具参数中也可能包含测试样本。",
      advancedTitle: "高级参数",
      advancedHint: "检测窗口、等待时间与网络选项",
      wordsTitle: "自定义词库",
      wordsHint: "一行一条，按纯文本匹配。修改后点击保存。",
      dirty: "有未保存的修改",
      clean: "配置已同步",
      undo: "撤销修改",
      statusEnabled: "已启用",
      statusDisabled: "已停用",
      statusDry: "演练中",
      checkedLabel: "已检查",
      pendingLabel: "当前待审",
      blockedLabel: "拦截记录",
      diskLabel: "磁盘命中",
      diskTitle: "磁盘保护",
      diskHint: "工具调用里的整盘删除、格式化、清空回收站、下载即执行，在这里被拦住。它和上面的回复拦裁是两套独立开关。",
      diskGuardEnabledLabel: "启用磁盘保护",
      diskGuardEnabledHint: "关掉后只管模型回复，不再检查工具调用。",
      diskCritical: "致命命令",
      diskCriticalHint: "删盘符根或用户目录、格式化/分区、清空回收站、远程下载并执行、直写裸设备。",
      diskRisky: "大批量删除",
      diskRiskyHint: "递归强删非构建目录、镜像同步、清理未跟踪文件。默认只记录：日常清理项目也会落进这一档。",
      diskActionBlock: "直接拒绝",
      diskActionAsk: "先问我（挂起调用）",
      diskActionWarn: "放行并记录",
      diskActionOff: "不处理",
      diskTools: "受检工具",
      diskToolsHint: "一行一个工具名。只有这些工具的参数会被当作命令读取。",
      diskAllowDirs: "允许删除的目录名",
      diskAllowDirsHint: "一行一个名字。目标落在这些目录里的递归删除算正常清理，不报告。",
      diskRules: "停用的规则",
      diskRulesHint: "一行一个规则名（记录里会显示），用来单独关掉误报多的那条。",
      outcomeWarn: "已放行并记录",
      diskAskHint: "「先问我」会把这次工具调用挂起到待审区，等你放行或丢弃；超时按拒绝处理。",
      diskNote: "只能检查工具调用的参数，看不到已经跑起来的脚本内部在做什么。",
      historyHint: "仅保留本次运行的最近记录；重新加载插件后会清空。",
      reviewEmptyHint: "选择“先问我”后，命中的回复会在这里等待处理。",
      historyEmptyHint: "命中事件出现后，可在这里查看处理结果。",
      fieldInvalid: "请填写有效的整数，且不小于字段标注的最小值。",
      modeStream: "结构化流",
      modeWire: "网络响应",
      modeBoth: "双层拦截",
      modePreview: "实时预览",
      modeStreamHint: "在内容进入 DSH 前检查开头，保留原有模式。",
      modeWireHint: "检查适配器之前的 HTTP 响应；协议兼容性与延迟需单独评估。",
      modeBothHint: "同时启用网络和结构化流拦截。",
      modePreviewHint: "即时显示临时预览；完整输出检查通过后正式提交。",
      scanTools: "检查工具参数",
      scanToolsHint: "写文件、发送消息的参数也参与检查，可能命中引用样本。",
      fastLabel: "快速放行",
      fastHint: "无信号时提前放行；后文出现的拒绝可能漏掉。",
      fastProbe: "快速检查长度",
      disabledPreviewFields: "实时预览会检查完整输出，不使用开头窗口或快速放行。",
      reviewReason: "命中原因",
      reviewContent: "待审核原文",
      historyContent: "查看记录摘要",
      noContent: "此记录未保留原文。",
      releaseHint: "允许原始内容进入会话",
      discardHint: "丢弃本次回复",
      wireSafeHint: "此模式是 HTTP/fetch 层处理，不是系统级 TLS 解密。",
      restartHint: "保存会重载插件。请先处理正在审核的回复。",
      title: '闸总',
      nav: '闸总',
      lead: '在模型的拒绝性回复进入会话之前把它拦下来。',
      enabled: '启用拦截',
      enabledHint: '关闭后所有回复原样进入会话。',
      interceptAt: '拦截位置',
      interceptAtStream: 'llm/stream（解析后的回复，默认）',
      interceptAtWire: 'TLS 之前（HTTP 出站，最上游）',
      interceptAtBoth: '两层都开',
      interceptAtPreview: '实时预览，审核后提交',
      previewHint: '预览是临时界面，不是持久聊天，可能短暂显示拒绝内容。插件不额外请求模型；完整检查通过或你放行后才提交，工具执行仍等待提交。',
      previewBlocked: '已丢弃 · 原文未提交',
      previewFailed: '生成失败 · 原文未提交',
      previewReceiving: '临时预览 · 尚未提交',
      previewReview: '等待你审核 · 尚未提交',
      previewChecking: '检查中 · 尚未提交',
      previewCommitting: '正在提交',
      previewTruncated: '预览仅显示末尾内容；检查与回放仍保留完整内容。',
      previewThinking: '思考预览（临时）',
      previewTools: '待提交工具：',
      previewDisconnected: '预览连接中断，正在重连；不会自动放行。',
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
      wireTerminatorHint: '自定义协议终止帧。留空使用内置收尾；仅 [DONE] 可能导致适配器报错。',
      onDetect: '命中后',
      onDetectAsk: '先问我（暂存回复，等我放行或丢弃）',
      onDetectBlock: '自动丢弃',
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
      replacementHint: '留空时不写标记。网络模式空替换可能触发提供方的空响应检查。',
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
      diskRun: '确认执行',
      diskDeny: '拒绝执行',
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
      minCharsLabel: 'Minimum scan length',
      wireReleaseLabel: 'Network release length',
      tabSettings: "Settings",
      tabReview: "Review",
      tabHistory: "Recent records",
      basicTitle: "Interception",
      basicHint: "Choose where to inspect content and what happens on a match.",
      scopeTitle: "Detection scope",
      scopeHint: "Wider inspection may match quoted examples in reasoning or tool arguments.",
      advancedTitle: "Advanced settings",
      advancedHint: "Scan windows, decision timeout and network options",
      wordsTitle: "Custom blocklist",
      wordsHint: "One plain-text phrase per line. Save to apply your changes.",
      dirty: "Unsaved changes",
      clean: "Configuration synced",
      undo: "Revert changes",
      statusEnabled: "Enabled",
      statusDisabled: "Disabled",
      statusDry: "Dry run",
      checkedLabel: "Inspected",
      pendingLabel: "Awaiting review",
      blockedLabel: "Match records",
      historyHint: "Recent records are kept for this activation and reset when the plugin reloads.",
      reviewEmptyHint: "Select “Ask me first” to hold matching replies here for review.",
      historyEmptyHint: "When a match occurs, its outcome appears here.",
      fieldInvalid: "Enter a whole number at or above the stated minimum.",
      modeStream: "Structured stream",
      modeWire: "Network response",
      modeBoth: "Both layers",
      modePreview: "Live preview",
      modeStreamHint: "Inspect the opening before it reaches DSH. Keeps the existing behavior.",
      modeWireHint: "Inspect HTTP before the adapter; protocol support and latency vary.",
      modeBothHint: "Enable both network and structured stream interception.",
      modePreviewHint: "Show a transient preview immediately, then submit after the full check.",
      scanTools: "Inspect tool arguments",
      scanToolsHint: "File writes and messages may contain quoted test examples.",
      fastLabel: "Early release",
      fastHint: "Release early when no signal is seen; a later refusal can be missed.",
      fastProbe: "Early scan length",
      disabledPreviewFields: "Live preview checks the complete output; opening windows and early release do not apply.",
      reviewReason: "Match reason",
      reviewContent: "Original content for review",
      historyContent: "View record summary",
      noContent: "Original content was not retained for this record.",
      releaseHint: "Admit the original content to the conversation",
      discardHint: "Discard this reply",
      wireSafeHint: "This is HTTP/fetch processing, not system-wide TLS decryption.",
      restartHint: "Saving reloads the plugin. Settle pending reviews first.",
      title: 'Gatekeeper',
      nav: 'Gatekeeper',
      lead: 'Stops a refusal reply before it enters the session context.',
      enabled: 'Guard replies',
      enabledHint: 'When off, every reply enters the session unchanged.',
      interceptAt: 'Intercept at',
      interceptAtStream: 'llm/stream — parsed reply (default)',
      interceptAtWire: 'Before TLS — outbound HTTP (earliest)',
      interceptAtBoth: 'Both layers',
      interceptAtPreview: 'Live preview, commit after review',
      previewHint: 'Preview is transient UI, not durable chat, and can briefly show refusal content. No extra model request is made. Content is submitted only after the full check or your release; tools still wait for submission.',
      previewBlocked: 'Discarded · original not submitted',
      previewFailed: 'Generation failed · original not submitted',
      previewReceiving: 'Live preview · not submitted',
      previewReview: 'Awaiting review · not submitted',
      previewChecking: 'Checking · not submitted',
      previewCommitting: 'Submitting',
      previewTruncated: 'Only the preview tail is shown; full content is retained for checking and replay.',
      previewThinking: 'Transient reasoning preview',
      previewTools: 'Pending tools: ',
      previewDisconnected: 'Preview disconnected; reconnecting without approving anything.',
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
      wireTerminatorHint: 'Custom protocol terminator. Empty uses built-in finalization; [DONE] alone may cause adapter errors.',
      onDetect: 'On a match',
      onDetectAsk: 'Ask me first (hold the reply until I release or discard it)',
      onDetectBlock: 'Discard automatically',
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
      replacementHint: 'Empty writes no marker. Network mode may reject an empty replacement as an empty response.',
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
      diskLabel: 'Disk hits',
      diskTitle: 'Disk protection',
      diskHint: 'Tool calls that would delete a drive, format a volume, empty the Recycle Bin, or run a downloaded script are stopped here. This is a separate switch from reply interception above.',
      diskGuardEnabledLabel: 'Enable disk protection',
      diskGuardEnabledHint: 'Off means only model replies are checked; tool calls are left alone.',
      diskCritical: 'Destructive commands',
      diskCriticalHint: 'Deleting a drive root or a user profile, formatting or partitioning, emptying the Recycle Bin, running a downloaded script, writing to a raw device.',
      diskRisky: 'Bulk deletes',
      diskRiskyHint: 'Recursive force deletes outside build directories, mirror syncs, cleaning untracked files. Records only by default: ordinary project cleanup lands here too.',
      diskActionBlock: 'Deny',
      diskActionAsk: 'Ask me first (holds the call)',
      diskActionWarn: 'Allow and record',
      diskActionOff: 'Ignore',
      diskTools: 'Watched tools',
      diskToolsHint: 'One tool name per line. Only these tools have their arguments read as a command.',
      diskAllowDirs: 'Directories that may be deleted',
      diskAllowDirsHint: 'One name per line. A recursive delete that only names these counts as build cleanup and is not reported.',
      diskRules: 'Disabled rules',
      diskRulesHint: 'One rule id per line (the id appears in each record), to switch off a single rule that misfires.',
      outcomeWarn: 'allowed and recorded',
      diskAskHint: 'Ask me first holds the tool call in the review tab until you release or discard it. A timeout denies it.',
      diskNote: 'This reads the arguments of a tool call. It cannot see what a script that is already running does.',
      outcomeBlocked: 'blocked',
      outcomeReleased: 'released',
      outcomeDry: 'dry-run hit',
      release: 'Release',
      block: 'Discard',
      diskRun: 'Run it anyway',
      diskDeny: 'Deny it',
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

    /** Session-private ephemeral SSE; disconnect never grants admission. */
    function PreviewDock(props) {
      const [items, setItems] = React.useState([])
      const [disconnected, setDisconnected] = React.useState(false)
      const sessionId = props.sessionId
      React.useEffect(() => {
        if (typeof sessionId !== 'string' || !sessionId) return
        let live = true
        let source = null
        const disconnect = () => {
          if (source) {
            source.onmessage = null
            source.onerror = null
            source.close()
            source = null
          }
        }
        const connect = () => {
          if (!live || source || document.visibilityState === 'hidden') return
          const url = new URL(PREVIEW_PATH, window.location.origin)
          url.searchParams.set('sessionId', sessionId)
          try {
            const active = new EventSource(url.toString(), { withCredentials: true })
            source = active
            active.onmessage = event => {
              if (!live || source !== active) return
              try {
                const snapshot = JSON.parse(event.data)
                if (!Array.isArray(snapshot.items)) throw new Error('invalid preview snapshot')
                // Protect both session isolation and blocked/failed redaction at
                // the view boundary, even if a stale server sends raw fields.
                const statuses = ['receiving', 'checking', 'review', 'committing', 'blocked', 'failed']
                setItems(snapshot.items.filter(item => item && item.sessionId === sessionId && typeof item.id === 'string' && statuses.includes(item.status)).map(item => {
                  const hidden = item.status === 'blocked' || item.status === 'failed'
                  return {
                    id: item.id, status: item.status,
                    text: !hidden && typeof item.text === 'string' ? item.text : '',
                    reasoning: !hidden && typeof item.reasoning === 'string' ? item.reasoning : '',
                    toolNames: !hidden && Array.isArray(item.toolNames) ? item.toolNames.filter(name => typeof name === 'string') : [],
                    truncated: !hidden && item.truncated === true,
                  }
                }))
                setDisconnected(false)
              } catch {
                setItems([])
                setDisconnected(true)
              }
            }
            active.onerror = () => {
              if (!live || source !== active) return
              setItems([])
              setDisconnected(true)
              // EventSource reconnects itself and receives a fresh snapshot.
              // A disconnect never sends a decision or changes admission.
            }
          } catch {
            setItems([])
            setDisconnected(true)
          }
        }
        const visibility = () => {
          setItems([])
          if (document.visibilityState === 'hidden') {
            disconnect()
            setDisconnected(false)
          } else connect()
        }
        setItems([])
        setDisconnected(false)
        document.addEventListener('visibilitychange', visibility)
        connect()
        return () => {
          live = false
          disconnect()
          document.removeEventListener('visibilitychange', visibility)
        }
      }, [sessionId])
      const t = props.t
      if (items.length === 0 && !disconnected) return null
      return h('div', { style: { display: 'grid', gap: 8 } },
        disconnected ? h('span', { role: 'status', style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('previewDisconnected')) : null,
        ...items.map(item => h('section', {
          key: item.id,
          'aria-label': t('previewReceiving'),
          style: { padding: 12, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' },
        },
          h('div', { style: { fontSize: 12, marginBottom: 6, color: 'var(--dsw-alias-label-secondary)' } },
            t(item.status === 'blocked' ? 'previewBlocked' : item.status === 'failed' ? 'previewFailed' : item.status === 'review' ? 'previewReview' : item.status === 'checking' ? 'previewChecking' : item.status === 'committing' ? 'previewCommitting' : 'previewReceiving')),
          h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '40vh', overflow: 'auto', fontSize: 13 } }, item.text || ''),
          item.reasoning ? h('details', {}, h('summary', {}, t('previewThinking')),
            h('pre', { style: { whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto' } }, item.reasoning)) : null,
          item.toolNames?.length ? h('div', { style: { fontSize: 12 } }, t('previewTools') + item.toolNames.join(', ')) : null,
          item.truncated ? h('small', {}, t('previewTruncated')) : null,
        )),
      )
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
        border: '1px solid var(--dsw-alias-border-l2)',
        background: props.primary
          ? 'var(--dsw-alias-bg-layer-2)'
          : 'var(--dsw-alias-bg-layer-1)',
        color: props.primary ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-primary)',
        whiteSpace: 'nowrap',
      }
      return h('button', {
        type: 'button',
        disabled: props.disabled,
        onClick: props.onClick,
        style: { ...base, ...(props.style || {}) },
        title: props.title,
        className: 'gk-button',
      }, props.children)
    }

    /** Each field owns its label so keyboard and assistive use match pointer use. */
    function Row(props) {
      return h('label', { className: 'gk-field' },
        h('span', { className: 'gk-field-title' }, props.label),
        props.hint ? h('span', { className: 'gk-muted gk-hint' }, props.hint) : null,
        h('span', { className: 'gk-control' }, props.children),
      )
    }
    function Toggle(props) {
      return h('span', { className: 'gk-toggle' },
        h('input', { type: 'checkbox', role: 'switch', checked: props.checked,
          'aria-checked': props.checked, 'aria-label': props.label,
          onChange: event => props.onChange(event.target.checked),
          style: { accentColor: 'var(--dsw-alias-brand-primary)' } }),
        h('span', { 'aria-hidden': true }, props.children),
      )
    }
    function textStyle() {
      return { font: 'inherit', fontSize: 13, padding: '7px 10px', width: '100%', minWidth: 0,
        boxSizing: 'border-box', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' }
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
    const UI_CSS = "\n.gk-page{width:100%;max-width:800px;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;box-sizing:border-box}\n.gk-page *{box-sizing:border-box}.gk-page [hidden]{display:none!important}\n.gk-page h2{margin:0;font-size:22px;font-weight:650;letter-spacing:-.4px}.gk-page h3{margin:0;font-size:14px}.gk-page h4{font-size:13px}\n.gk-page p{margin:5px 0}.gk-page-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:4px 0 16px}\n.gk-muted{color:var(--dsw-alias-label-secondary)}.gk-hint{font-size:12px;line-height:1.6}\n.gk-badge{display:inline-flex;align-items:center;padding:3px 9px;gap:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:11px;white-space:nowrap;background:var(--dsw-alias-bg-layer-2)}\n.gk-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:12px}.gk-metrics>div{display:grid;gap:3px;padding:12px 14px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:10px}.gk-metrics strong{font-size:21px;font-weight:600}.gk-metrics span{font-size:11px}\n.gk-savebar{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;margin-bottom:14px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:10px}\n.gk-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.gk-tabs{display:flex;gap:6px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:16px}\n.gk-tabs button{appearance:none;font:inherit;cursor:pointer;background:transparent;color:var(--dsw-alias-label-secondary);padding:10px 12px;border:0;border-bottom:2px solid transparent}.gk-tabs button[aria-selected=true]{color:var(--dsw-alias-brand-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}\n.gk-stack{display:grid;gap:12px}.gk-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:16px;min-width:0}.gk-section-heading{padding-bottom:8px}.gk-section-heading p{font-size:12px;color:var(--dsw-alias-label-secondary)}\n.gk-field{display:grid;gap:5px;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l1);min-width:0}.gk-field-title{font-weight:500}.gk-control{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}.gk-control input,.gk-control select,.gk-control textarea{max-width:100%}.gk-toggle{display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:12px}.gk-toggle input{width:16px;height:16px;margin:0}\n.gk-page summary{cursor:pointer;list-style-position:inside;outline-offset:4px}.gk-page details>summary>.gk-muted{display:block;font-size:11px;margin-top:4px}.gk-record summary{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.gk-record time{margin-left:auto;font-size:11px}\n.gk-button:focus-visible,.gk-page input:focus-visible,.gk-page select:focus-visible,.gk-page textarea:focus-visible,.gk-tabs button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.gk-button:not(:disabled):hover{filter:brightness(.97)}\n.gk-note{border-left:2px solid var(--dsw-alias-brand-primary);padding:8px 10px;background:var(--dsw-alias-bg-layer-2);font-size:12px;color:var(--dsw-alias-label-secondary)}\n.gk-empty{padding:32px 18px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;text-align:center;color:var(--dsw-alias-label-secondary)}.gk-empty p{font-size:12px;margin-top:8px}.gk-error{display:flex;align-items:center;gap:10px;margin:10px 0;color:var(--dsw-alias-state-error-primary);font-size:12px;overflow-wrap:anywhere}.gk-original{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font:inherit;line-height:1.7;max-height:360px;overflow:auto;margin:10px 0}.gk-footer{font-size:10px;text-align:right;padding-top:14px}\n@media(max-width:540px){.gk-page-heading{gap:8px}.gk-page h2{font-size:20px}.gk-savebar{flex-wrap:wrap}.gk-savebar>.gk-actions{margin-left:auto}.gk-card{padding:12px}.gk-metrics{gap:5px}.gk-metrics>div{padding:9px}.gk-tabs button{padding:10px 8px}.gk-record time{margin-left:0}}\n"

    const BUILD = 'v0.4.0'

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
            maxHeight: '42vh',
            overflow: 'auto',
            lineHeight: 1.75,
            padding: 12,
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-base)',
          },
        }, item.body || item.head || ''),
        h('div', { style: { display: 'flex', gap: 8 } },
          h(Button, { onClick: () => decide('release'), disabled: busy, primary: true, title: t('releaseHint'), style: { height: 34, padding: '0 16px' } }, t(item.kind === 'disk' ? 'diskRun' : 'release')),
          h(Button, { onClick: () => decide('block'), disabled: busy, title: t('discardHint'), style: { height: 34, padding: '0 16px' } }, t(item.kind === 'disk' ? 'diskDeny' : 'block')),
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
      const [tab, setTab] = React.useState('settings')
      const config = state?.config || null
      const current = draft || config
      const list = value => Array.isArray(value) ? value : String(value || '').split('\n').map(line => line.trim()).filter(Boolean)
      const patch = key => value => {
        setDraft(prev => ({ ...(prev || config || {}), [key]: value }))
        setStatus('')
      }
      const payloadOf = input => {
        const body = { ...input }
        for (const [field, minimum] of Object.entries({ ...NUMERIC_FIELDS, fastProbeChars: 8, wireReleaseChars: 1 })) {
          if (body[field] === undefined) continue
          const raw = String(body[field]).trim()
          if (!/^\d+$/.test(raw)) return null
          const number = Number(raw)
          if (!Number.isSafeInteger(number) || number < minimum) return null
          body[field] = number
        }
        for (const key of ['blocklist','wireUrlPatterns','diskGuardTools','diskGuardAllowDirs','diskGuardDisabledRules']) if (body[key] !== undefined) body[key] = list(body[key])
        return body
      }
      const canonical = object => JSON.stringify(Object.keys(object).sort().map(key => [key, object[key]]))
      const normalized = current && payloadOf(current)
      const dirty = !!draft && (!normalized || !config || canonical(normalized) !== canonical(config))
      const save = async () => {
        if (!current || status === 'saving') return
        const body = payloadOf(current)
        if (!body) { setStatus('failed:' + t('fieldInvalid')); return }
        setStatus('saving')
        try {
          await postJson(CONFIG_PATH, body)
          // Retain the edited body until the server's next snapshot confirms it.
          setDraft(body)
          setStatus('saved')
          refresh()
        } catch (failure) { setStatus('failed:' + (failure instanceof Error ? failure.message : String(failure))) }
      }
      React.useEffect(() => {
        if (draft && config && canonical(draft) === canonical(config)) setDraft(null)
      }, [config, draft])
      const pending = state?.pending || []
      const recent = state?.recent || []
      const counters = state?.counters || {}
      const mode = current?.interceptAt || 'stream'
      const modeLabel = { stream:'modeStream',wire:'modeWire',both:'modeBoth',preview:'modePreview' }
      const modeHint = { stream:'modeStreamHint',wire:'modeWireHint',both:'modeBothHint',preview:'modePreviewHint' }
      const toggle = (field,label,hint) => h(Row, { label:t(label), hint:hint && t(hint) },
        h(Toggle, { checked:current[field] === true, label:t(label), onChange:patch(field) }, t(current[field] ? 'statusEnabled' : 'statusDisabled')))
      // A list field is edited as one-per-line text and only split on save, so a
      // half-typed entry never becomes an array entry of its own.
      const area = (field,rows=4) => h('textarea', {
        rows, spellCheck:false,
        value:Array.isArray(current[field]) ? current[field].join('\n') : String(current[field] ?? ''),
        onChange:event=>patch(field)(event.target.value),
        style:{ ...textStyle(), resize:'vertical', fontFamily:'monospace' },
      })
      const action = field => h('select', {
        value:current[field] || 'off', onChange:event=>patch(field)(event.target.value), style:textStyle(),
      }, ...['block','ask','warn','off'].map(key=>h('option',{key,value:key},t('diskAction'+key.charAt(0).toUpperCase()+key.slice(1)))))
      const number = (field,label,min=1) => h(Row, { label:t(label), hint: min + '+' },
        h('input',{ type:'number', min, step:1, value:String(current[field] ?? ''), onChange:event=>patch(field)(event.target.value), style:textStyle() }))
      const card = (title,hint,...children) => h('section',{className:'gk-card'},
        h('div',{className:'gk-section-heading'},h('h3',{},t(title)),hint && h('p',{className:'gk-muted'},t(hint))),...children)
      return h('div',{className:'gk-page'},
        h('style',{},UI_CSS),
        h('div',{className:'gk-page-heading'},
          h('div',{},h('h2',{},t('title')),h('p',{className:'gk-muted'},t('lead'))),
          h('span',{className:'gk-badge'},!current ? t('loading') : t(!current.enabled ? 'statusDisabled' : current.dryRun ? 'statusDry' : 'statusEnabled'))),
        h('div',{className:'gk-metrics'},...[
          [t('checkedLabel'),counters.calls || 0],[t('pendingLabel'),pending.length],[t('blockedLabel'),recent.length],[t('diskLabel'),counters.diskHits || 0],
        ].map(([label,value])=>h('div',{key:label},h('strong',{},value),h('span',{className:'gk-muted'},label)))),
        h('div',{className:'gk-savebar'},
          h('span',{className:'gk-muted',role:'status','aria-live':'polite'},status === 'saved' ? t('saved') : dirty ? t('dirty') : t('clean')),
          h('div',{className:'gk-actions'},
            h(Button,{disabled:!dirty || status==='saving',onClick:()=>{setDraft(null);setStatus('')}},t('undo')),
            h(Button,{primary:true,disabled:!current || !dirty || status==='saving',onClick:save},t(status==='saving'?'saving':'save')))),
        status.startsWith('failed:') && h('div',{className:'gk-error',role:'alert'},t('saveFailed')+': '+status.slice(7)),
        error && h('div',{className:'gk-error',role:'alert'},t('error')+': '+error,h(Button,{onClick:refresh},t('reload'))),
        h('div',{className:'gk-tabs',role:'tablist','aria-label':t('title')},...[
          ['settings',t('tabSettings')],['review',t('tabReview')+' ('+pending.length+')'],['history',t('tabHistory')],
        ].map(([key,label])=>h('button',{key,id:'gk-tab-'+key,type:'button',role:'tab','aria-selected':tab===key,'aria-controls':'gk-panel-'+key,
          tabIndex:tab===key?0:-1,onClick:()=>setTab(key),onKeyDown:event=>{
            const keys=['settings','review','history']; let index=keys.indexOf(key)
            if(event.key==='ArrowRight') index=(index+1)%3; else if(event.key==='ArrowLeft') index=(index+2)%3; else return
            event.preventDefault();setTab(keys[index]);event.currentTarget.parentElement.children[index].focus()
          }},label))),
        h('div',{id:'gk-panel-settings',role:'tabpanel','aria-labelledby':'gk-tab-settings',hidden:tab!=='settings'},
          !current ? h('div',{className:'gk-empty'},t(error?'loadingFailed':'loading')) : h('div',{className:'gk-stack'},
            card('basicTitle','basicHint',
              toggle('enabled','enabled','enabledHint'),
              h(Row,{label:t('interceptAt'),hint:t(modeHint[mode] || 'modeStreamHint')},h('select',{value:mode,onChange:event=>patch('interceptAt')(event.target.value),style:textStyle()},
                ...['stream','preview','wire','both'].map(key=>h('option',{key,value:key},t(modeLabel[key]))))),
              mode==='preview' && h('p',{className:'gk-note'},t('previewHint')),
              h(Row,{label:t('onDetect')},h('select',{value:current.onDetect,onChange:event=>patch('onDetect')(event.target.value),style:textStyle()},
                h('option',{value:'block'},t('onDetectBlock')),h('option',{value:'ask'},t('onDetectAsk')))),
              current.onDetect==='ask' && number('askTimeoutMs','askTimeoutMs'),
              toggle('dryRun','dryRun','dryRunHint')),
            card('scopeTitle','scopeHint',toggle('scanReasoning','scanReasoning','scanReasoningHint'),toggle('scanToolArgs','scanTools','scanToolsHint')),
            card('diskTitle','diskHint',
              toggle('diskGuardEnabled','diskGuardEnabledLabel','diskGuardEnabledHint'),
              current.diskGuardEnabled && h('div',{},
                h(Row,{label:t('diskCritical'),hint:t('diskCriticalHint')},action('diskGuardCritical')),
                h(Row,{label:t('diskRisky'),hint:t('diskRiskyHint')},action('diskGuardRisky')),
                (current.diskGuardCritical==='ask' || current.diskGuardRisky==='ask') && h('p',{className:'gk-note'},t('diskAskHint')),
                h(Row,{label:t('diskTools'),hint:t('diskToolsHint')},area('diskGuardTools',3)),
                h(Row,{label:t('diskAllowDirs'),hint:t('diskAllowDirsHint')},area('diskGuardAllowDirs',7)),
                h('details',{className:'gk-subdetails'},h('summary',{},t('diskRules')),
                  h('p',{className:'gk-muted'},t('diskRulesHint')),area('diskGuardDisabledRules',3)),
                h('p',{className:'gk-note'},t('diskNote')))),
            card('wordsTitle','wordsHint',
              h(Row,{label:fill(t('blocklistCount'),{count:list(current.blocklist).length})},h('textarea',{value:Array.isArray(current.blocklist)?current.blocklist.join('\n'):current.blocklist || '',
                onChange:event=>patch('blocklist')(event.target.value),placeholder:t('blocklistPlaceholder'),spellCheck:false,rows:6,style:{...textStyle(),resize:'vertical',fontFamily:'monospace'}})),
              h('div',{className:'gk-actions'},h(Button,{onClick:()=>patch('blocklist')([...new Set([...list(current.blocklist),...SEED_BLOCKLIST])])},t('blocklistSeed')),
                h(Button,{onClick:()=>patch('blocklist')([]),disabled:list(current.blocklist).length===0},t('blocklistClear')))),
            h('details',{className:'gk-card'},h('summary',{},t('advancedTitle'),h('span',{className:'gk-muted'},t('advancedHint'))),
              mode==='preview' ? h('p',{className:'gk-note'},t('disabledPreviewFields')) : h('div',{className:'gk-stack'},
                number('scanChars','scanChars'),number('minChars','minCharsLabel',0),toggle('blockToolCalls','blockToolCalls','blockToolCallsHint'),
                (mode==='stream'||mode==='both') && h('div',{},toggle('fastPath','fastLabel','fastHint'),current.fastPath && number('fastProbeChars','fastProbe')),
                h(Row,{label:t('replacement'),hint:t('replacementHint')},h('input',{value:current.replacementText||'',onChange:event=>patch('replacementText')(event.target.value),style:textStyle()}))),
              (mode==='wire'||mode==='both') && h('section',{},h('h4',{},t('wireSection')),h('p',{className:'gk-note'},t('wireSafeHint')),
                toggle('wireScanResponses','wireScanResponses','wireScanResponsesHint'),toggle('wireScanRequests','wireScanRequests','wireScanRequestsHint'),
                current.wireScanRequests && toggle('wireBlockRequests','wireBlockRequests'),toggle('wireAbortUpstream','wireAbortUpstream','wireAbortUpstreamHint'),
                number('wireReleaseChars','wireReleaseLabel'),
                h(Row,{label:t('wireUrlPatterns'),hint:t('wireUrlPatternsHint')},h('textarea',{rows:4,value:Array.isArray(current.wireUrlPatterns)?current.wireUrlPatterns.join('\n'):current.wireUrlPatterns||'',onChange:event=>patch('wireUrlPatterns')(event.target.value),style:{...textStyle(),resize:'vertical'}})),
                h(Row,{label:t('wireTerminator')},h('textarea',{rows:3,value:current.wireTerminator||'',onChange:event=>patch('wireTerminator')(event.target.value),style:{...textStyle(),resize:'vertical'}})))),
            h('p',{className:'gk-muted gk-hint'},t('restartHint')))),
        h('section',{id:'gk-panel-review',role:'tabpanel','aria-labelledby':'gk-tab-review',hidden:tab!=='review',className:'gk-stack'},
          pending.length ? pending.map(item=>h(PendingItem,{key:item.id,item,t,onSettled:()=>{refresh();props.close?.()},onError:message=>setStatus('failed:'+message)}))
          : h('div',{className:'gk-empty'},h('strong',{},t('pendingEmpty')),h('p',{},t('reviewEmptyHint')))),
        h('section',{id:'gk-panel-history',role:'tabpanel','aria-labelledby':'gk-tab-history',hidden:tab!=='history',className:'gk-stack'},
          h('p',{className:'gk-muted gk-hint'},t('historyHint')),
          !recent.length ? h('div',{className:'gk-empty'},h('strong',{},t('recentEmpty')),h('p',{},t('historyEmptyHint'))) : recent.map((entry,index)=>h('details',{key:String(entry.at)+'-'+index,className:'gk-card gk-record'},
            h('summary',{},h('span',{className:'gk-badge'},t(entry.kind==='disk'?(entry.action==='warn'&&entry.released?'outcomeWarn':entry.released?'outcomeReleased':'outcomeBlocked'):(entry.dryRun?'outcomeDry':entry.released?'outcomeReleased':'outcomeBlocked'))),h('span',{},entry.reason || ''),h('time',{className:'gk-muted'},clockOf(entry.at))),
            h('p',{className:'gk-muted gk-hint'},entry.kind==='disk' ? String(entry.tool || '')+' · '+String(entry.tier || '') : String(entry.chars || 0)+' '+t('chars')),
            h('pre',{className:'gk-original'},entry.head || t('noContent'))))),
        h('div',{className:'gk-footer gk-muted'},'dsh-gatekeeper · '+BUILD))
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
      const cardRef = React.useRef(null)
      React.useEffect(() => { setMounted(true) }, [])
      React.useEffect(() => {
        const previous = document.activeElement
        const card = cardRef.current
        card?.focus()
        const onKey = event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onClose(); return }
          if (event.key !== 'Tab' || !card) return
          const controls = [...card.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')]
          if (!controls.length) { event.preventDefault(); card.focus(); return }
          const first = controls[0], last = controls[controls.length - 1]
          if (event.shiftKey && (document.activeElement === first || document.activeElement === card)) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && (document.activeElement === last || document.activeElement === card)) { event.preventDefault(); first.focus() }
        }
        card?.addEventListener('keydown', onKey)
        return () => {
          card?.removeEventListener('keydown', onKey)
          if (previous?.isConnected && typeof previous.focus === 'function') previous.focus()
        }
      }, [mounted, props.onClose])

      const backdrop = {
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 12,
        background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 30%, transparent)',
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
        boxShadow: '0 12px 40px var(--dsw-alias-border-l2)',
      }
      const node = h('div', {
        style: backdrop,
        onClick: (event) => {
          if (event.target === event.currentTarget) props.onClose()
        },
      }, h('div', { style: card, className: 'gk-page', ref: cardRef, tabIndex: -1, role: 'dialog', 'aria-modal': true, 'aria-label': props.label }, h('style', {}, UI_CSS), props.children))

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
      const [failureMessage, setFailureMessage] = React.useState('')
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
        setFailureMessage('')
        try {
          await postJson(DECIDE_PATH, { id, action })
          refresh()
          props.onClose()
        } catch (failure) {
          const message = failure instanceof Error ? failure.message : String(failure)
          setFailureMessage(message)
          props.onError(message)
        } finally {
          setBusyId(null)
        }
      }

      return h(Overlay, { onClose: props.onClose, label: t('reviewTitle') },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
          h('h2', { style: { margin: 0, fontSize: 16, color: 'var(--dsw-alias-label-primary)' } }, t('reviewTitle')),
          h(Button, { onClick: props.onClose, style: { marginLeft: 'auto' } }, t('close')),
        ),
        h('div', { className: 'gk-note' }, t('reviewHint')),
        failureMessage && h('div', { className: 'gk-error', role: 'alert' }, failureMessage),
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

      const preview = state?.config?.interceptAt === 'preview' ? h(PreviewDock, props) : null
      if (pending.length === 0 && !open) return preview

      return h('div', {},
        preview,
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
            ctx.effect(() => locale.register(NS, { zh: ZH, en: EN }), 'gatekeeper: dictionaries')
            t = locale.bind(NS)
          }
        } catch {
          /* keep the built-in copy */
        }

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'gatekeeper',
          order: 36,
          label: () => t('nav'),
          inject: () => ({ t }),
        }, SettingsPage))

        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'gatekeeper-pending',
          order: 50,
          inject: () => ({ t }),
        }, PendingBanner))
      },
    }
  },
})
