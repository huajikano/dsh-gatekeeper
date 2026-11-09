/**
 * Wire-level guard: intercepts the outbound HTTP request before TLS encryption.
 *
 * A plugin inside the Host process cannot decrypt TLS it does not own — but it
 * does not need to. The Host *is* the client, so plaintext exists one step
 * before encryption, at `globalThis.fetch`. Hooking it puts this guard upstream
 * of every byte on the wire: earlier than SSE parsing, earlier than the adapter,
 * earlier than `llm/stream`.
 *
 * That is the only place the outgoing request body can also be seen, which is
 * what makes request-side blocking possible at all.
 *
 * Why `globalThis.fetch` works here: the OpenAI SDK binds `fetch` when a client
 * is constructed (`options.fetch ?? getDefaultFetch()`), and the pi-ai adapter
 * constructs a client per stream call — so replacing the global before the next
 * call is picked up. A client that outlived the swap would keep the old
 * function; this guard is installed at activation, before any call runs.
 *
 * @module dsh-refusal-guard/wire
 */

import { detect, detectQuoted, normalize } from './refusal.js'

/**
 * Judge one raw protocol frame.
 *
 * At this layer the reply is not plain prose: it arrives as SSE frames carrying
 * JSON, so a refusal sits inside a string value —
 * `data: {"choices":[{"delta":{"content":"抱歉，我无法…"}}]}`. The ordinary rule
 * anchors at the start of the text and would never match there, so the quoted
 * rule runs as well and finds the sentence where it actually is.
 *
 * @param {string} text - raw bytes decoded as text.
 * @param {object} config - resolved configuration.
 * @returns {object} the verdict.
 */
function judge(text, config) {
  const direct = detect(text, config)
  if (direct.blocked) return direct
  return detectQuoted(text, config)
}

/**
 * How much of the decoded response the guard keeps for scanning.
 *
 * The whole reply is not needed: a refusal is decided by its opening, and a
 * long stream would otherwise grow without bound in memory.
 */
const SCAN_WINDOW = 20000

/**
 * Build the opening of one OpenAI-compatible SSE chunk.
 *
 * Terminating with `data: [DONE]` lets the adapter close the turn cleanly: it
 * sees a normal completion with no content, which is exactly the shape the
 * stream-level guard produces for a suppressed reply.
 *
 * @returns {string} the terminator frame.
 */
function openAiTerminator() {
  return 'data: [DONE]\n\n'
}

/**
 * Read the URL a `fetch` call targets.
 *
 * @param {unknown} input - the first argument to `fetch`.
 * @returns {string} the URL, or an empty string when it cannot be read.
 */
function urlOf(input) {
  if (typeof input === 'string') return input
  if (input !== null && typeof input === 'object') {
    if (typeof input.url === 'string') return input.url
  }
  return ''
}

/**
 * Whether one URL is an LLM endpoint this guard should inspect.
 *
 * Matching is substring-based on purpose: providers differ wildly in path
 * shape, and a guard that only knew `openai` would miss every proxy route.
 *
 * @param {readonly string[]} patterns - configured fragments.
 * @param {string} url - the outgoing URL.
 * @returns {boolean} whether to inspect this request.
 */
function isLlmUrl(patterns, url) {
  if (patterns.length === 0) return false
  const lower = url.toLowerCase()
  return patterns.some((pattern) => lower.includes(pattern.toLowerCase()))
}

/**
 * Skip endpoints whose responses are not a chat completion stream.
 *
 * @param {Response} response - the response to inspect.
 * @returns {boolean} whether the body is a stream this guard understands.
 */
function isEventStream(response) {
  const type = response.headers.get('content-type') ?? ''
  return type.includes('text/event-stream')
}

/**
 * Replace `globalThis.fetch` with a guarding wrapper.
 *
 * @param {object} config - resolved plugin configuration.
 * @param {(record: object) => void} onVerdict - called once per decision.
 * @returns {() => void} the disposer that restores the original function.
 */
export function installWireGuard(config, onVerdict) {
  const original = globalThis.fetch
  if (typeof original !== 'function') return () => {}

  /** The wrapper for one call. */
  const guarded = async function guardedFetch(input, init) {
    const url = urlOf(input)
    // Anything that is not a configured LLM endpoint is somebody else's
    // traffic: the plugin's own routes, the module graph, attachments.
    if (!isLlmUrl(config.wireUrlPatterns, url)) return original.call(this, input, init)

    // Request side: the prompt itself, before a single byte is encrypted.
    if (config.wireScanRequests) {
      const body = init?.body
      if (typeof body === 'string') {
        const verdict = judge(body, config)
        if (verdict.blocked) {
          onVerdict({
            phase: 'request',
            blocked: true,
            reason: verdict.reason,
            match: verdict.match,
            chars: body.length,
            head: normalize(body).slice(0, 200),
          })
          if (config.wireBlockRequests) {
            throw new TypeError(`refusal-guard: outgoing request blocked (${verdict.reason})`)
          }
        }
      }
    }

    const response = await original.call(this, input, init)
    if (!config.wireScanResponses || !isEventStream(response) || response.body === null) return response

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    /** Chunks held until the decision is settled. */
    const held = []
    /** Decoded text seen so far, for the detector. */
    let scanned = ''
    /** `null` while undecided, then `'pass' | 'block'`. */
    let decision = null

    /**
     * Decide on the accumulated text.
     *
     * Buffering until the window fills mirrors the stream-level guard: a short
     * reply is held whole and judged at end of stream, a long one is judged as
     * soon as the window is full.
     *
     * @param {boolean} force - decide even below `scanChars` (end of stream).
     * @returns {boolean} whether the decision is settled.
     */
    const settle = (force) => {
      if (!force && scanned.length < config.scanChars) return false
      const verdict = judge(scanned.slice(0, SCAN_WINDOW), config)
      decision = verdict.blocked ? 'block' : 'pass'
      onVerdict({
        phase: 'response',
        blocked: verdict.blocked,
        reason: verdict.reason,
        match: verdict.match,
        chars: scanned.length,
        head: normalize(scanned).slice(0, 200),
      })
      return true
    }

    const stream = new ReadableStream({
      async pull(controller) {
        while (true) {
          const { done, value } = await reader.read()

          if (done) {
            if (decision === null) settle(true)
            // A reply that was allowed, or never reached the window, is flushed
            // exactly as the provider sent it.
            if (decision === 'pass') for (const chunk of held) controller.enqueue(chunk)
            held.length = 0
            controller.close()
            return
          }

          if (decision === 'pass') {
            controller.enqueue(value)
            return
          }

          if (decision === 'block') continue

          held.push(value)
          scanned += decoder.decode(value, { stream: true })
          if (!settle(false)) continue

          if (decision === 'block') {
            // Stop paying for tokens the moment the refusal is settled, then
            // close the stream with a frame the adapter reads as "finished".
            held.length = 0
            if (config.wireAbortUpstream) await reader.cancel().catch(() => {})
            controller.enqueue(encoder.encode(config.wireTerminator || openAiTerminator()))
            controller.close()
            return
          }

          for (const chunk of held) controller.enqueue(chunk)
          held.length = 0
          return
        }
      },
      async cancel(reason) {
        held.length = 0
        await reader.cancel(reason).catch(() => {})
      },
    })

    // Only `body` is replaced. `content-length` and `content-encoding` describe
    // the bytes the provider sent, which are no longer the bytes the adapter
    // will read, so they are dropped rather than passed through.
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    headers.delete('content-encoding')

    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }

  globalThis.fetch = guarded

  return () => {
    // Restore only if nobody else replaced it in the meantime.
    if (globalThis.fetch === guarded) globalThis.fetch = original
  }
}
