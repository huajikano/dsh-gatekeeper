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
 * Pull the reply text out of raw SSE frames.
 *
 * A frame carries roughly forty characters of JSON for every few characters of
 * reply — `data: {"choices":[{"delta":{"content":"x"}}]}`. Judging the raw
 * bytes therefore compares the detector's window against framing overhead
 * instead of against the reply, which is why a short token late in a stream
 * survives a window that looked big enough.
 *
 * Extracting the text makes the wire window mean the same thing as the stream
 * window, and lets the same rules and word lists apply at both layers.
 *
 * @param {string} raw - decoded bytes, possibly a partial frame.
 * @returns {string} the reply text found in complete frames.
 */
function extractText(raw) {
  let text = ''
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload.length === 0 || payload === '[DONE]') continue
    try {
      const frame = JSON.parse(payload)
      // OpenAI chat completions.
      const delta = frame?.choices?.[0]?.delta
      if (delta !== undefined) {
        if (typeof delta.content === 'string') text += delta.content
        if (typeof delta.reasoning_content === 'string') text += delta.reasoning_content
        if (typeof delta.reasoning === 'string') text += delta.reasoning
        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
            if (typeof call?.function?.arguments === 'string') text += call.function.arguments
          }
        }
        continue
      }
      // Anthropic messages and OpenAI responses-style events.
      if (typeof frame?.delta?.text === 'string') text += frame.delta.text
      else if (typeof frame?.delta?.thinking === 'string') text += frame.delta.thinking
      else if (typeof frame?.text === 'string') text += frame.text
      else if (typeof frame?.choices?.[0]?.text === 'string') text += frame.choices[0].text
    } catch {
      // An incomplete frame at a chunk boundary; its text arrives next round.
    }
  }
  return text
}

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
  // `detect` truncates to `scanChars`, which is tuned for a reply that starts
  // with its refusal. At the wire the match can sit anywhere — inside a tool
  // call, at the end of a long reasoning block — so the whole reply is judged.
  const wide = { ...config, scanChars: SCAN_WINDOW }
  const direct = detect(text, wide)
  if (direct.blocked) return direct
  return detectQuoted(text, wide)
}

/**
 * How much of the decoded response the guard keeps for scanning.
 *
 * The whole reply is not needed: a refusal is decided by its opening, and a
 * long stream would otherwise grow without bound in memory.
 */
const SCAN_WINDOW = 20000

/**
 * Growth in reply text between two judgements.
 *
 * The detector runs the whole rule set, so re-checking on every chunk would be
 * quadratic in reply length. Text arrives a sentence at a time, so a few
 * hundred characters is a fine granularity.
 */
const JUDGE_STEP = 200

/**
 * The frames that end a suppressed stream.
 *
 * `data: [DONE]` alone is not enough: the OpenAI client raises
 * "Stream ended without finish_reason". A finish chunk alone is not enough
 * either — pi-ai rejects a `stop` with no content as `EMPTY_RESPONSE`, retries
 * five times, and fails the turn. So the terminator carries the replacement
 * text as one content delta, which the adapter accepts as a normal reply.
 *
 * An empty replacement therefore cannot produce a clean finish at this layer;
 * the turn ends as `EMPTY_RESPONSE` instead. The stream guard has no such
 * limitation because it substitutes at a later stage.
 *
 * @param {string} text - replacement text; may be empty.
 * @returns {string} the terminator frames.
 */
function openAiTerminator(text) {
  const delta = text.length > 0 ? { content: text } : {}
  const chunk = {
    id: 'refusal-guard',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'refusal-guard',
    choices: [{ index: 0, delta, finish_reason: 'stop' }],
  }
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`
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
 * Whether one request is DSH's own auxiliary work rather than the conversation.
 *
 * @param {readonly string[]} patterns - system-prompt fragments that identify it.
 * @param {string} body - the outgoing request body.
 * @returns {boolean} whether to leave the request and its response alone.
 */
function isAuxiliaryRequest(patterns, body) {
  return patterns.some((pattern) => pattern.length > 0 && body.includes(pattern))
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

    // The wire has no `purpose` field, so DSH's own auxiliary calls are
    // recognised by the system prompt they carry. Rewriting a compaction
    // summary, a session title or an authorization review would be a
    // regression; those requests are handed straight through.
    const requestBody = typeof init?.body === 'string' ? init.body : null
    if (requestBody !== null && isAuxiliaryRequest(config.wireSkipBodyPatterns, requestBody)) {
      return original.call(this, input, init)
    }

    // Request side: the prompt itself, before a single byte is encrypted.
    if (config.wireScanRequests && requestBody !== null) {
      const verdict = judge(requestBody, config)
      if (verdict.blocked) {
        onVerdict({
          phase: 'request',
          blocked: true,
          reason: verdict.reason,
          match: verdict.match,
          chars: requestBody.length,
          head: normalize(requestBody).slice(0, 200),
        })
        if (config.wireBlockRequests) {
          throw new TypeError(`refusal-guard: outgoing request blocked (${verdict.reason})`)
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
    /** Decoded bytes seen so far, kept only to feed the extractor. */
    let scanned = ''
    /** Reply text extracted from the frames, which is what the detector reads. */
    let reply = ''
    /** `null` while undecided, then `'pass' | 'block'`. */
    let decision = null
    /** Reply length at the last judgement, to throttle re-checks. */
    let lastJudged = 0

    /**
     * Decide on the reply text seen so far.
     *
     * Unlike the stream guard, this keeps looking: the reply is re-judged as it
     * grows and only released once it passes `wireReleaseChars` or ends. A
     * first-window decision is not enough here — a tool call carrying the text
     * can arrive well after the opening prose, and once a chunk is forwarded it
     * can never be recalled.
     *
     * @param {boolean} force - settle even below `wireReleaseChars`.
     * @returns {boolean} whether the decision is settled.
     */
    const settle = (force) => {
      const verdict = judge(reply.slice(0, SCAN_WINDOW), config)
      if (verdict.blocked) {
        decision = 'block'
        onVerdict({
          phase: 'response',
          blocked: true,
          reason: verdict.reason,
          match: verdict.match,
          chars: reply.length,
          head: normalize(reply).slice(0, 200),
        })
        return true
      }
      if (!force && reply.length < config.wireReleaseChars) return false
      decision = 'pass'
      onVerdict({
        phase: 'response',
        blocked: false,
        reason: null,
        match: null,
        chars: reply.length,
        head: normalize(reply).slice(0, 200),
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
            else controller.enqueue(encoder.encode(config.wireTerminator || openAiTerminator(config.replacementText)))
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
          reply = extractText(scanned)
          // Re-judge as the reply grows, but not on every chunk: the detector
          // runs the whole rule set, and a check per few hundred characters is
          // plenty for text that only ever arrives a sentence at a time.
          if (reply.length - lastJudged >= JUDGE_STEP) {
            lastJudged = reply.length
            if (!settle(false)) continue
          } else {
            continue
          }

          if (decision === 'block') {
            // Stop paying for tokens the moment the refusal is settled, then
            // close the stream with a frame the adapter reads as "finished".
            held.length = 0
            if (config.wireAbortUpstream) await reader.cancel().catch(() => {})
            controller.enqueue(encoder.encode(config.wireTerminator || openAiTerminator(config.replacementText)))
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
