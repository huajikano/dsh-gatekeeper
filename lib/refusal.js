/**
 * Refusal detection for streamed assistant text.
 *
 * Pure functions only: no cordis, no filesystem, no globals. Everything here is
 * unit-tested in `test/refusal.test.mjs`, so the decision rule can be tuned
 * without restarting the Harness.
 *
 * The rule is deliberately conservative. A coding agent's normal reply contains
 * plenty of the same words a refusal uses ("cannot", "无法", "抱歉") — for
 * example when it explains a compile error. So a single weak phrase never
 * blocks. Blocking needs a refusal *shape*:
 *
 *   - a refusal opener near the start of the reply, plus a capability denial,
 *   - or two independent capability denials,
 *   - or a refusal opener plus policy framing.
 *
 * @module dsh-refusal-guard/refusal
 */

/** Refusal openers. These only count inside the first `openerWindowChars`. */
const OPENERS = [
  /^(很|非常|十分|真的)?抱歉[，,。!！:：\s]/,
  /^对不起[，,。!！\s]/,
  /^我(很|非常|真的)?(抱歉|遗憾)[，,]/,
  /^很遗憾[，,]/,
  /^我(不能|无法|没办法|不可以|不会|拒绝)(协助|帮助|提供|完成|回答|参与|支持|执行|满足|处理|做)/,
  /^我(恐怕|怕)(不能|无法|没办法)/,
  /^作为(一个|一名)?\s*(ai|人工智能|语言模型|ai助手|智能助手)/,
  /^(i'm|i am|im)\s+(sorry|afraid)/,
  /^sorry[，,]?\s/,
  /^unfortunately[，,]?\s/,
  /^i\s+(can\s?not|can'?t|could\s?not|couldn'?t|won'?t|will not|must decline|have to decline)/,
  /^i\s+(am|'m)\s+(unable|not able)/,
  /^as an ai/,
  /^i\s+(must|have to)\s+(decline|refuse)/,
]

/** Capability denials: the model states it will not do the work. */
const DENIALS = [
  /不能(帮|协助|帮助|提供|完成|回答|参与|支持|执行|满足|处理|做|给)/,
  /无法(帮|协助|帮助|提供|完成|回答|参与|支持|执行|满足|处理|给)/,
  /不会(帮|协助|帮助|提供|完成|执行)/,
  /(拒绝|恕不|不便|不予)(提供|协助|回答|支持|帮)/,
  /(超出|超过)(了)?(我的)?(能力|权限|职责)范围/,
  /can'?t\s+(help|assist|provide|do|complete|support|engage)/,
  /cannot\s+(help|assist|provide|complete|support)/,
  /(unable|not able)\s+to\s+(help|assist|provide|comply)/,
  /(won'?t|will not|must decline|have to decline|refuse to)\s+(help|assist|provide)/,
  /not something i\s+(can|will|am able to)/,
  /i'?m not\s+(able|allowed|permitted)\s+to/,
]

/** Policy framing: the model cites a rule rather than an inability. */
const POLICIES = [
  /(违反|违背|不符合)(了)?(我的|相关|使用|内容|安全)?(政策|准则|规定|原则|条款|道德|伦理|规范)/,
  /(使用条款|服务条款|内容政策|安全政策|社区准则)/,
  /against my\s+(guidelines|policy|principles|programming|terms)/,
  /(violates?|breaches?|breaching)\s+(my|the|our)?\s*(policy|guidelines|terms)/,
]

/**
 * First-person intent refusals: the model states it will not carry on.
 *
 * A single match blocks, because the shape is specific — a negation bound to a
 * continuation marker and a task verb ("我不会接着填…", "I won't continue…").
 * The verb list is deliberately narrow: "我不会继续用这个库" is an ordinary
 * technical statement, so a plain verb like 用/选/改 never matches.
 */
const INTENT_REFUSALS = [
  /(不会|不打算|不愿意|无意|拒绝)(再|继续|接着)(做|填|写|帮|提供|协助|处理|执行|参与|推进|跟进|回答|碰|动)/,
  /(我不会|我不打算|我不愿意)(帮|协助|提供)(这个|此|该|这类|这种)/,
  /(恕不|不便|不予)(继续|再|接着)/,
  /i\s+(won'?t|will not|refuse to|am not going to)\s+(continue|proceed|help|assist|provide)/,
  /i\s+(won'?t|will not|refuse to)\s+(do|fill|write|provide)\s+(this|that|these|those)/,
]

/**
 * Markers that introduce a quotation rather than perform one.
 *
 * A reply that is *discussing* refusals — a test fixture, a documentation
 * sample, an explanation of this plugin — writes them inside quotes with one of
 * these in front. That is someone talking about a refusal, not making one, so
 * the quoted-refusal rule steps aside.
 */
const EXAMPLE_MARKERS = /(例如|比如|示例|样例|譬如|引用|测试|样本|用例|for example|e\.g\.|sample|example|fixture|test case|quote)/i

/** How far before a quote the marker may sit and still count as its lead-in. */
const EXAMPLE_MARKER_WINDOW = 40

/**
 * Fold a reply into the form the patterns expect.
 *
 * Markdown emphasis, smart quotes, and whitespace runs differ between providers
 * but carry no meaning for this decision, so they are removed. The result is
 * lowercased; every pattern above is written for lowercase input.
 *
 * @param {unknown} text - raw assistant text.
 * @returns {string} normalized text.
 */
export function normalize(text) {
  return String(text ?? '')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[*_`~#]+/g, '')
    .replace(/^[\s\-*>]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Count non-overlapping matches of one pattern.
 *
 * @param {RegExp} re - source pattern, with or without the `g` flag.
 * @param {string} text - text to scan.
 * @returns {number} match count, capped at 8.
 */
function countMatches(re, text) {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`
  const scan = new RegExp(re.source, flags)
  let count = 0
  let match
  while ((match = scan.exec(text)) !== null) {
    count += 1
    if (match.index === scan.lastIndex) scan.lastIndex += 1
    if (count >= 8) break
  }
  return count
}

/**
 * Find the earliest match among several patterns.
 *
 * @param {readonly RegExp[]} patterns - patterns to try.
 * @param {string} text - text to scan.
 * @returns {{ index: number, match: string, source: string } | null} earliest match.
 */
function earliest(patterns, text) {
  let best = null
  for (const re of patterns) {
    const found = new RegExp(re.source, re.flags.replace('g', '')).exec(text)
    if (found === null) continue
    if (best === null || found.index < best.index) {
      best = { index: found.index, match: found[0], source: re.source }
    }
  }
  return best
}

/**
 * Decide whether one assistant reply is a refusal.
 *
 * Built-in rules read the normalized text; user-supplied patterns read the raw
 * lowercased text, so a pattern that names an identifier such as `SECRET_MARKER`
 * still matches after `normalize` strips the underscore.
 *
 * @param {string} text - raw assistant text (all deltas concatenated).
 * @param {object} [options] - detection tuning.
 * @param {number} [options.scanChars] - how much of the reply to inspect.
 * @param {number} [options.openerWindowChars] - how close to the start an opener must be.
 * @param {readonly RegExp[]} [options.customPatterns] - hard patterns; any match blocks.
 * @returns {{ blocked: boolean, reason: string | null, match: string | null, denial: number, policy: number }} verdict.
 */
export function detect(text, options = {}) {
  const scanChars = options.scanChars ?? 600
  const openerWindowChars = options.openerWindowChars ?? 120
  const raw = String(text ?? '').slice(0, scanChars).toLowerCase()
  const head = normalize(text).slice(0, scanChars)

  if (head.length === 0 && raw.length === 0) {
    return { blocked: false, reason: null, match: null, denial: 0, policy: 0 }
  }

  for (const re of options.customPatterns ?? []) {
    const flags = re.flags.replace('g', '')
    const found = new RegExp(re.source, flags).exec(raw) ?? new RegExp(re.source, flags).exec(head)
    if (found !== null) {
      return { blocked: true, reason: 'custom', match: found[0], denial: 0, policy: 0 }
    }
  }

  // The user's own word list: plain substrings, matched case-insensitively
  // against both the raw and the normalized text. This is the escape hatch for
  // phrasings the built-in rules do not know, so an empty entry is skipped
  // rather than matching everything.
  for (const word of options.blockWords ?? []) {
    if (word.length === 0) continue
    if (raw.includes(word) || head.includes(word)) {
      return { blocked: true, reason: 'blocklist', match: word, denial: 0, policy: 0 }
    }
  }

  const opener = earliest(OPENERS, head)
  const openerNearStart = opener !== null && opener.index <= openerWindowChars
  const denial = DENIALS.reduce((total, re) => total + countMatches(re, head), 0)
  const policy = POLICIES.reduce((total, re) => total + countMatches(re, head), 0)
  const intent = earliest(INTENT_REFUSALS, head)

  // A first-person "I will not carry on with this" is specific enough alone.
  if (intent !== null) {
    return { blocked: true, reason: 'intent', match: intent.match, denial, policy }
  }
  if (openerNearStart && denial >= 1) {
    return { blocked: true, reason: 'opener+denial', match: opener.match, denial, policy }
  }
  if (denial >= 2) {
    return { blocked: true, reason: 'denial', match: null, denial, policy }
  }
  if (openerNearStart && policy >= 1) {
    return { blocked: true, reason: 'opener+policy', match: opener.match, denial, policy }
  }
  if (policy >= 1 && denial >= 1) {
    return { blocked: true, reason: 'policy+denial', match: null, denial, policy }
  }
  return { blocked: false, reason: null, match: null, denial, policy }
}

/**
 * Quote pairs a reply uses when it repeats a sentence rather than saying it.
 *
 * Reasoning often quotes the exact wording it is considering — including the
 * refusal it has been told to produce — so a refusal that appears *inside* one
 * of these is a refusal the reply is carrying, even though the surrounding
 * sentence is ordinary.
 */
const QUOTE_PAIRS = [
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
  ['《', '》'],
  ['"', '"'],
]

/**
 * Detect a refusal quoted inside a longer text.
 *
 * Each quoted span is re-run through the ordinary rules, which are anchored at
 * the start of the span — exactly the position a refusal occupies when a model
 * repeats one.
 *
 * @param {string} text - text to search, typically a reply's reasoning.
 * @param {object} [options] - detection tuning, as for {@link detect}.
 * @returns {{ blocked: boolean, reason: string | null, match: string | null, denial: number, policy: number }} verdict.
 */
export function detectQuoted(text, options = {}) {
  const head = normalize(text)
  for (const [open, close] of QUOTE_PAIRS) {
    let from = 0
    // A pathological reply cannot make this quadratic: each span moves `from`
    // past its closing marker, and the scan stops at the end of the text.
    while (from < head.length) {
      const start = head.indexOf(open, from)
      if (start < 0) break
      const end = head.indexOf(close, start + open.length)
      if (end < 0) break
      // A quote introduced as an example is being discussed, not performed.
      const leadIn = head.slice(Math.max(0, start - EXAMPLE_MARKER_WINDOW), start)
      if (EXAMPLE_MARKERS.test(leadIn)) {
        from = end + close.length
        continue
      }
      const inner = head.slice(start + open.length, end).trim()
      if (inner.length >= 4) {
        const verdict = detect(inner, options)
        if (verdict.blocked) {
          return { ...verdict, reason: `quoted:${verdict.reason}`, match: verdict.match ?? inner.slice(0, 40) }
        }
      }
      from = end + close.length
    }
  }
  return { blocked: false, reason: null, match: null, denial: 0, policy: 0 }
}

/**
 * Compile user-supplied pattern sources once, at activation.
 *
 * @param {readonly string[]} sources - regular-expression sources from config.
 * @returns {RegExp[]} compiled patterns.
 * @throws {Error} when one source is not a valid regular expression.
 */
export function compilePatterns(sources) {
  return sources.map((source) => {
    try {
      return new RegExp(source, 'i')
    } catch (error) {
      throw new Error(`refusal-guard: invalid patterns entry ${JSON.stringify(source)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}
