/**
 * Stream transformer that withholds a refusal before it reaches the session log.
 *
 * `llm/stream` hands back the provider's chunk iterable. The agent loop folds
 * those chunks into the assistant message it commits, so a refusal dropped here
 * never becomes part of the conversation the model re-reads next turn.
 *
 * The transformer holds the reply until it has enough text to decide:
 *
 *   - while undecided, chunks are buffered and text is accumulated;
 *   - at `scanChars` characters (or at end of stream), the detector runs;
 *   - not a refusal: the buffer flushes and the rest streams through untouched;
 *   - a refusal in `block` mode: content is dropped and one short replacement
 *     text block is emitted, followed by a normal `stop` finish;
 *   - a refusal in `ask` mode: the whole reply is kept buffered while the
 *     caller asks the user. A release replays the original chunks unchanged —
 *     the reply then enters the session exactly as the model sent it — and a
 *     rejection falls back to the replacement.
 *
 * Token accounting is preserved: `usage` chunks are metadata, not content, so
 * they are always forwarded even when a reply is suppressed.
 *
 * @module dsh-refusal-guard/stream
 */

import { detect, detectQuoted, hasSignal, normalize } from './refusal.js'

/**
 * Build the replacement block pair for a suppressed reply.
 *
 * @param {string} text - replacement text from config.
 * @returns {Array<object>} the `block-start`, `text-delta`, and `block-end` chunks.
 */
function replacementChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
  ]
}

/**
 * Normalize one detector verdict into an audit record.
 *
 * @param {object} verdict - detector result.
 * @param {string} text - accumulated reply text.
 * @param {object} extra - fields to merge over the record.
 * @returns {object} the audit record.
 */
function recordOf(verdict, text, extra = {}) {
  return {
    reason: verdict.reason,
    match: verdict.match,
    denial: verdict.denial,
    policy: verdict.policy,
    chars: text.length,
    head: normalize(text).slice(0, 200),
    ...extra,
  }
}

/**
 * Wrap a provider stream with refusal suppression.
 *
 * @param {AsyncIterable<object>} base - the provider stream returned by `next()`.
 * @param {object} config - resolved plugin configuration.
 * @param {object} handlers - callbacks the transformer needs.
 * @param {(record: object) => void} handlers.report - called once per verdict.
 * @param {(record: object) => Promise<'release' | 'block'>} [handlers.ask] -
 *   asks the user; omitted callers fall back to blocking.
 * @param {(error: unknown) => void} [handlers.fail] - reports a guard failure.
 * @returns {AsyncIterable<object>} the guarded stream.
 */
export function guardStream(base, config, handlers) {
  return (async function* guard() {
    /** Chunks held until the decision is settled. */
    const buffered = []
    /** Visible assistant text. */
    let visible = ''
    /** Reasoning text. */
    let reasoning = ''
    /** Tool-call arguments, which is how a reply can carry text without saying it. */
    let toolArgs = ''
    /** `null` while undecided, then `'pass' | 'ask' | 'block'`. */
    let decision = null
    /** The detector verdict when the reply is a refusal. */
    let verdict = null
    /** Whether the reply calls a tool. */
    let toolCall = false
    /** Whether content chunks must be dropped rather than forwarded. */
    let suppressed = false

    /**
     * Run the detector on the accumulated text.
     *
     * The visible reply and the reasoning are scanned with **separate** budgets.
     * Sharing one budget was the bug that let a long "thinking" block consume
     * the whole window, so the refusal sentence after it was never examined: a
     * high-reasoning-effort model spends thousands of characters thinking before
     * it says anything.
     *
     * A reply that calls a tool is doing work, not refusing, so it is released
     * immediately unless `blockToolCalls` is on.
     *
     * @param {boolean} force - decide even below `scanChars` (end of stream).
     * @returns {boolean} whether the decision is now settled.
     */
    const settle = (force) => {
      // A tool-calling reply is doing work, not refusing — unless its arguments
      // are scanned, in which case the payload must be inspected before release.
      if (toolCall && !config.blockToolCalls && !config.scanToolArgs) {
        decision = 'pass'
        return true
      }

      // Fast path: once a reply has said enough to show it carries no refusal
      // vocabulary, keep buffering buys nothing. A normal technical answer never
      // contains any of those tokens, so it is released after a few dozen
      // characters instead of waiting out the whole scan window.
      if (config.fastPath && !force && visible.length >= config.fastProbeChars && visible.length < config.scanChars) {
        try {
          if (!hasSignal(visible, config) && !(config.scanReasoning && hasSignal(reasoning, config))) {
            handlers.trace?.({ fastPath: true, visibleLen: visible.length })
            decision = 'pass'
            return true
          }
        } catch (error) {
          // A gate bug must not delay the reply; fall through to the full check.
          handlers.fail?.(error)
        }
      }

      if (!force && visible.length < config.scanChars) return false
      try {
        const found = decideNow()
        handlers.trace?.({
          visibleLen: visible.length,
          reasoningLen: reasoning.length,
          toolArgsLen: toolArgs.length,
          blocked: found !== null,
          reason: found === null ? null : found.reason,
        })
        if (found !== null) {
          verdict = found
          decision = config.dryRun ? 'pass' : config.onDetect === 'ask' ? 'ask' : 'block'
          return true
        }
      } catch (error) {
        // A detector bug must never eat the user's reply: fail open, recorded.
        handlers.fail?.(error)
      }
      decision = 'pass'
      return true
    }

    /**
     * Choose a verdict from the visible reply first, then from the reasoning.
     *
     * @returns {object | null} the verdict, or null when this is not a refusal.
     */
    const decideNow = () => {
      if (visible.length >= config.minChars) {
        const direct = detect(visible, config)
        if (direct.blocked) return direct
      }
      if (!config.scanReasoning || reasoning.length === 0) {
        return decideToolArgs()
      }
      const window = reasoning.slice(0, Math.max(config.scanChars * 8, 20000))
      // A refusal quoted inside the thinking still carries it.
      const quoted = detectQuoted(window, config)
      if (quoted.blocked) return quoted
      // A reply that is thinking only — no visible text at all — is judged on
      // the thinking itself, so a refusal never escapes by never being spoken.
      if (visible.length < config.minChars && window.length >= config.minChars) {
        const direct = detect(window, config)
        if (direct.blocked) return direct
      }
      return decideToolArgs()
    }

    /**
     * Judge the tool-call arguments.
     *
     * A reply can carry its text inside a tool payload — a message sent to a
     * peer, a string written to a file — and never say it out loud. That is how
     * one refusal reached the session while the visible reply stayed clean.
     *
     * @returns {object | null} the verdict, or null.
     */
    const decideToolArgs = () => {
      if (!config.scanToolArgs || toolArgs.length < config.minChars) return null
      const direct = detect(toolArgs, config)
      if (direct.blocked) return direct
      // Arguments are JSON, so the payload text sits inside quotes.
      const quoted = detectQuoted(toolArgs, config)
      return quoted.blocked ? quoted : null
    }

    /** Release held chunks, keeping content only when the reply survived. */
    const drain = function* drainBuffer() {
      for (const chunk of buffered) {
        if (suppressed && chunk.type !== 'usage') continue
        yield chunk
      }
      buffered.length = 0
    }

    for await (const chunk of base) {
      if (decision === 'pass') {
        yield chunk
        continue
      }

      buffered.push(chunk)
      if (chunk.type === 'text-delta') visible += chunk.text
      else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
      else if (chunk.type === 'tool-call-delta') {
        toolCall = true
        toolArgs += chunk.argumentsDelta
      }

      if (decision === null) settle(false)
      // Only a surviving reply releases the buffer; a verdict keeps it held.
      if (decision === 'pass') yield* drain()
    }

    if (decision === null) settle(true)
    if (decision === 'pass') yield* drain()

    if (verdict === null) return

    if (config.dryRun) {
      handlers.report(recordOf(verdict, visible.length > 0 ? visible : reasoning, { dryRun: true, released: true, visibleChars: visible.length, reasoningChars: reasoning.length }))
      return
    }

    if (decision === 'ask' && handlers.ask !== undefined) {
      // The reviewer must see what would enter the session, so the held record
      // carries the whole reply, not the truncated preview the history keeps.
      let outcome = 'block'
      try {
        outcome = await handlers.ask(recordOf(verdict, visible.length > 0 ? visible : reasoning, {
          pending: true,
          body: visible.length > 0 ? visible : reasoning,
          visibleChars: visible.length,
          reasoningChars: reasoning.length,
        }))
      } catch (error) {
        // Asking failed; the reply is what the user gets rather than silence.
        handlers.fail?.(error)
        yield* drain()
        return
      }
      if (outcome === 'release') {
        yield* drain()
        handlers.report(recordOf(verdict, visible.length > 0 ? visible : reasoning, { dryRun: false, released: true, visibleChars: visible.length, reasoningChars: reasoning.length }))
        return
      }
    }

    // Suppress: keep usage, drop content, and answer with the marker.
    suppressed = true
    yield* drain()
    // An empty replacement writes nothing into the conversation at all.
    if (config.replacementText.length > 0) yield* replacementChunks(config.replacementText)
    yield { type: 'finish', reason: { kind: 'stop' } }
    handlers.report(recordOf(verdict, visible.length > 0 ? visible : reasoning, { dryRun: false, released: false, visibleChars: visible.length, reasoningChars: reasoning.length }))
  })()
}
