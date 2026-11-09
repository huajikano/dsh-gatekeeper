/**
 * Refusal guard: keeps refusal replies out of the session context.
 *
 * Every streaming model call passes through the `llm/stream` waterfall. This
 * plugin wraps the conversation stream, watches the assistant text as it
 * arrives, and — when the reply is a refusal rather than work — holds it before
 * the agent loop commits it.
 *
 * Two outcomes, chosen by `onDetect`:
 *
 *   - `block`: drop the content and substitute a short marker, as before.
 *   - `ask`: keep the reply buffered and surface it for the user to release or
 *     discard. A release replays the original chunks, so the reply enters the
 *     session exactly as the model sent it and the turn simply continues.
 *
 * The user decides through the plugin's own routes rather than the shared
 * approval service: that service resolves to `rejected` without asking whenever
 * the session's approval policy is `never`, which is the default here, so a
 * refusal prompt built on it would never appear.
 *
 * Detection is deliberately conservative; see `refusal.js` for the rule.
 *
 * @module dsh-gatekeeper
 */

import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { compilePatterns } from './refusal.js'
import { installWireGuard } from './wire.js'
import { guardStream } from './stream.js'

/** Plugin name the loader row addresses; the Client module id matches it. */
export const name = 'gatekeeper'

/** This plugin reads no service unconditionally; the Fetch carrier is optional. */
export const inject = []

/** Route path this plugin's Client half talks to. */
export const STATE_PATH = '/api/dsh-gatekeeper/state'

/** Route that resolves one pending reply. */
export const DECIDE_PATH = '/api/dsh-gatekeeper/decide'

/** Route that writes one configuration change. */
export const CONFIG_PATH = '/api/dsh-gatekeeper/config'

/** Field defaults; a profile patch overrides them per row. */
const DEFAULTS = {
  enabled: true,
  dryRun: false,
  scanReasoning: true,
  scanToolArgs: false,
  onDetect: 'block',
  askTimeoutMs: 120000,
  scanChars: 600,
  minChars: 8,
  openerWindowChars: 120,
  replacementText: '',
  patterns: [],
  blocklist: [],
  sessions: [],
  sessionsExclude: [],
  purposes: [],
  blockToolCalls: false,
  auditPath: '',

  // Where the guard sits. `stream` is the llm/stream waterfall: structured
  // chunks, session and purpose available, clean replacement. `wire` hooks
  // globalThis.fetch: earlier in the pipe, sees the outgoing request too, but
  // knows nothing about sessions and must synthesise a stream terminator.
  // `both` runs the wire guard and keeps the stream guard as the backstop.
  interceptAt: 'stream',

  /** URL fragments that mark an LLM endpoint. Empty disables wire mode. */
  wireUrlPatterns: [
    '/chat/completions',
    '/v1/messages',
    '/v1/responses',
    '/completions',
  ],
  /** Inspect the outgoing request body (the prompt) at the wire. */
  wireScanRequests: false,
  /** Refuse to send a request whose body matches. Requires wireScanRequests. */
  wireBlockRequests: false,
  /** Inspect the streamed response body at the wire. */
  wireScanResponses: true,
  /** Cancel the upstream connection once a refusal is detected. */
  wireAbortUpstream: true,
  /**
   * What replaces the aborted stream. The default is an OpenAI-compatible SSE
   * terminator, which the adapter reads as "finished with no content". Set an
   * empty string to close the body with nothing at all.
   */
  wireTerminator: '',
  /**
   * Reply length after which an unblocked wire reply is released.
   *
   * The wire guard keeps judging while it buffers, because text can arrive in a
   * tool call long after the opening prose. Releasing early would make that
   * text invisible to the guard and already forwarded to the adapter. Raise this
   * to look further, at the cost of a longer wait before anything streams.
   */
  wireReleaseChars: 4000,
  /**
   * Request-body fragments that mark a call as DSH's own auxiliary work.
   *
   * The stream guard tells these apart by the `purpose` field. At the wire there
   * is no such field, so the body is the only signal: each fragment below opens
   * a system prompt DSH writes for itself — a compaction summary, a session
   * title, or an authorization review. Corrupting any of them is the exact
   * regression the stream guard already fixed, so a matching request passes
   * through untouched.
   */
  wireSkipBodyPatterns: [
    'You are now acting as a compaction engine for this AI coding assistant',
    'Create a concise title for an AI coding-assistant session',
    'REVIEW_POLICY',
  ],
}

/** Keys a profile patch may set. */
const CONFIG_KEYS = new Set(Object.keys(DEFAULTS))

/**
 * Purposes DSH uses for its own auxiliary model calls.
 *
 * Every one of them reaches `llm/stream` through the same funnel as the
 * conversation — `LlmRuntime.streamWithRegistration` is the single entry point
 * — so a guard that matched on text alone would corrupt them:
 *
 *   - `compaction` summarizes history; a substituted summary loses context,
 *   - `session-title` derives the session name; a substitution becomes the name,
 *   - `auto-review` parses a strict `{"risk","decision"}` reply; a substitution
 *     throws inside its parser, which fails closed and denies the tool call.
 *
 * None of them writes conversation text, so none of them is this plugin's job.
 */
export const INTERNAL_PURPOSES = Object.freeze(['compaction', 'session-title', 'auto-review'])

/**
 * Where the guard can sit.
 *
 * - `stream`: the `llm/stream` waterfall. Structured chunks, session and
 *   purpose available, clean replacement. The default.
 * - `wire`: `globalThis.fetch`, before TLS encryption. Earlier than the adapter
 *   and able to inspect the outgoing request, but blind to sessions and forced
 *   to synthesise a stream terminator.
 * - `both`: the wire guard runs, and the stream guard stays installed as the
 *   backstop for anything the wire guard could not see.
 */
export const INTERCEPT_MODES = Object.freeze(['stream', 'wire', 'both'])

/**
 * Validate and detach one config object.
 *
 * @param {Record<string, unknown>} [raw] - the row's `config` block.
 * @returns {object} resolved configuration with compiled patterns.
 * @throws {Error} when a key is unknown or a value has the wrong shape.
 */
export function resolveConfig(raw = {}) {
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`gatekeeper: unknown config key ${JSON.stringify(key)} (allowed: ${[...CONFIG_KEYS].join(', ')})`)
    }
  }

  const config = { ...DEFAULTS, ...raw }

  for (const flag of [
    'enabled',
    'dryRun',
    'scanReasoning',
    'scanToolArgs',
    'blockToolCalls',
    'wireScanRequests',
    'wireBlockRequests',
    'wireScanResponses',
    'wireAbortUpstream',
  ]) {
    if (typeof config[flag] !== 'boolean') {
      throw new Error(`gatekeeper: ${flag} must be a boolean`)
    }
  }

  if (config.onDetect !== 'ask' && config.onDetect !== 'block') {
    throw new Error('gatekeeper: onDetect must be "ask" or "block"')
  }

  if (!INTERCEPT_MODES.includes(config.interceptAt)) {
    throw new Error(`gatekeeper: interceptAt must be one of ${INTERCEPT_MODES.map((mode) => `"${mode}"`).join(', ')}`)
  }

  if (!Array.isArray(config.wireUrlPatterns) || config.wireUrlPatterns.some((entry) => typeof entry !== 'string')) {
    throw new Error('gatekeeper: wireUrlPatterns must be an array of strings')
  }
  if (typeof config.wireTerminator !== 'string') {
    throw new Error('gatekeeper: wireTerminator must be a string')
  }

  for (const [field, minimum] of [
    ['askTimeoutMs', 1],
    ['wireReleaseChars', 1],
    ['scanChars', 1],
    ['minChars', 0],
    ['openerWindowChars', 0],
  ]) {
    const value = config[field]
    if (!Number.isInteger(value) || value < minimum) {
      throw new Error(`gatekeeper: ${field} must be an integer >= ${minimum}`)
    }
  }

  if (typeof config.replacementText !== 'string') {
    throw new Error('gatekeeper: replacementText must be a string')
  }
  if (typeof config.auditPath !== 'string') {
    throw new Error('gatekeeper: auditPath must be a string')
  }

  for (const field of ['patterns', 'blocklist', 'sessions', 'sessionsExclude', 'purposes', 'wireSkipBodyPatterns']) {
    if (!Array.isArray(config[field]) || config[field].some((entry) => typeof entry !== 'string')) {
      throw new Error(`gatekeeper: ${field} must be an array of strings`)
    }
  }

  return Object.freeze({
    ...config,
    patterns: Object.freeze([...config.patterns]),
    blocklist: Object.freeze([...config.blocklist]),
    sessions: Object.freeze([...config.sessions]),
    sessionsExclude: Object.freeze([...config.sessionsExclude]),
    purposes: Object.freeze([...config.purposes]),
    wireUrlPatterns: Object.freeze([...config.wireUrlPatterns]),
    wireSkipBodyPatterns: Object.freeze([...config.wireSkipBodyPatterns]),
    customPatterns: Object.freeze(compilePatterns(config.patterns)),
    // Lowercased once so the hot path is a plain substring test.
    blockWords: Object.freeze(config.blocklist.map((word) => word.trim().toLowerCase()).filter((word) => word.length > 0)),
  })
}

/**
 * Decide whether one model call belongs to this guard.
 *
 * Only the conversation stream is guarded. The agent loop builds its request
 * without a `purpose` field (`markAgentLoopRequest`), while every DSH auxiliary
 * call names one; that difference is the whole rule. An unknown purpose is
 * treated as auxiliary and left alone, so a future internal caller cannot be
 * corrupted by this plugin.
 *
 * @param {object} config - resolved configuration.
 * @param {{ sessionId?: string, purpose?: string }} options - the call's options.
 * @returns {boolean} whether the stream must be wrapped.
 */
function shouldGuard(config, options) {
  const sessionId = options?.sessionId
  // A muted session is never guarded, whatever else the config says.
  if (typeof sessionId === 'string' && config.sessionsExclude.includes(sessionId)) return false
  if (config.sessions.length > 0) {
    if (typeof sessionId !== 'string' || !config.sessions.includes(sessionId)) return false
  }
  const purpose = options?.purpose
  if (typeof purpose === 'string' && purpose.length > 0) {
    return config.purposes.includes(purpose)
  }
  return true
}

/**
 * Replies waiting for a decision, plus the counters the panel reports.
 *
 * An entry exists only while its stream is held open. Resolving removes it, so
 * a stale `GET /state` can never offer a button that no longer does anything.
 *
 * @returns {object} the store.
 */
export function createPendingStore() {
  /** @type {Map<string, object>} */
  const items = new Map()
  const counters = { blocked: 0, released: 0, asked: 0, calls: 0, errors: 0 }
  /** Most recent verdicts, newest first; survives resolution so the panel can show history. */
  const recent = []
  const RECENT_LIMIT = 50

  return {
    counters,
    recent,
    /**
     * Remember one settled verdict for the panel's history.
     *
     * @param {object} record - audit fields plus `at`.
     */
    remember(record) {
      recent.unshift(record)
      if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT
    },
    /**
     * Register one held reply.
     *
     * @param {object} record - audit fields for the panel.
     * @returns {{ id: string, promise: Promise<'release' | 'block'> }} the handle.
     */
    add(record) {
      const id = randomUUID()
      let settle
      const promise = new Promise((resolveNow) => {
        settle = resolveNow
      })
      items.set(id, { id, ...record, createdAt: Date.now(), settle })
      counters.asked += 1
      return { id, promise }
    },
    /**
     * Answer one held reply.
     *
     * @param {string} id - pending id.
     * @param {'release' | 'block'} action - the user's choice.
     * @returns {boolean} whether an entry was waiting.
     */
    resolve(id, action) {
      const item = items.get(id)
      if (item === undefined) return false
      items.delete(id)
      item.settle(action)
      return true
    },
    /** Forget one entry without resolving it. */
    drop(id) {
      items.delete(id)
    },
    /** The pending list, without the resolver. */
    list() {
      return [...items.values()].map(({ settle: _settle, ...rest }) => rest)
    },
  }
}

/**
 * Record one detection to the log and, when configured, the audit file.
 *
 * @param {object} ctx - plugin context.
 * @param {object} config - resolved configuration.
 * @param {object} options - the intercepted call's options.
 * @param {object} record - detector verdict plus stream statistics.
 */
function report(ctx, config, options, record) {
  const entry = {
    at: new Date().toISOString(),
    sessionId: options?.sessionId ?? null,
    provider: options?.provider ?? null,
    model: options?.model ?? null,
    ...record,
  }
  const verb = record.dryRun ? 'would block' : record.released ? 'released' : 'blocked'
  ctx.logger?.warn(
    `gatekeeper: ${verb} ${record.reason} reply (${record.chars} chars, session ${entry.sessionId ?? 'unknown'})`,
  )

  if (config.auditPath.length === 0) return
  try {
    appendFileSync(config.auditPath, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch (error) {
    ctx.logger?.warn(`gatekeeper: audit write failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Ask the user whether one held reply may enter the session.
 *
 * The wait ends on the user's choice, on `askTimeoutMs`, or when the model call
 * is cancelled — the last two both block, so an unattended Harness never leaks
 * a refusal.
 *
 * @param {object} pending - the pending store.
 * @param {object} config - resolved configuration.
 * @param {AbortSignal | undefined} signal - the model call's cancellation.
 * @param {object} record - audit fields for the panel.
 * @returns {Promise<'release' | 'block'>} the outcome.
 */
async function askUser(pending, config, signal, record) {
  if (signal?.aborted) return 'block'
  const held = pending.add(record)
  let timer
  const deadline = new Promise((resolveNow) => {
    timer = setTimeout(() => resolveNow('block'), config.askTimeoutMs)
    timer.unref?.()
  })
  const cancelled = new Promise((resolveNow) => {
    signal?.addEventListener('abort', () => resolveNow('block'), { once: true })
  })
  try {
    return await Promise.race([held.promise, deadline, cancelled])
  } finally {
    clearTimeout(timer)
    pending.drop(held.id)
  }
}

/** Build the JSON answer shared by every route. */
function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

/**
 * Report configuration and the replies currently waiting for a decision.
 *
 * @param {object} config - resolved configuration.
 * @param {object} pending - the pending store.
 * @returns {Response} the state.
 */
function handleState(config, pending) {
  return json({
    // Only real configuration goes in `config`: the panel posts this object
    // straight back on save, and a stray runtime counter here would make that
    // post fail validation.
    config: {
      enabled: config.enabled,
      interceptAt: config.interceptAt,
      dryRun: config.dryRun,
      scanReasoning: config.scanReasoning,
      scanToolArgs: config.scanToolArgs,
      onDetect: config.onDetect,
      askTimeoutMs: config.askTimeoutMs,
      scanChars: config.scanChars,
      minChars: config.minChars,
      replacementText: config.replacementText,
      blockToolCalls: config.blockToolCalls,
      patterns: config.patterns,
      blocklist: config.blocklist,
      sessions: config.sessions,
      sessionsExclude: config.sessionsExclude,
      wireUrlPatterns: config.wireUrlPatterns,
      wireScanRequests: config.wireScanRequests,
      wireBlockRequests: config.wireBlockRequests,
      wireScanResponses: config.wireScanResponses,
      wireAbortUpstream: config.wireAbortUpstream,
      wireTerminator: config.wireTerminator,
      wireReleaseChars: config.wireReleaseChars,
      wireSkipBodyPatterns: config.wireSkipBodyPatterns,
      auditPath: config.auditPath,
    },
    pending: pending.list(),
    recent: pending.recent,
    counters: pending.counters,
  })
}

/**
 * Resolve one held reply.
 *
 * @param {object} pending - the pending store.
 * @param {Request} request - the POST body `{ id, action }`.
 * @returns {Promise<Response>} the outcome.
 */
async function handleDecide(pending, request) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'expected a JSON body' }, 400)
  }
  const id = body?.id
  const action = body?.action
  if (typeof id !== 'string' || (action !== 'release' && action !== 'block')) {
    return json({ error: 'expected { id: string, action: "release" | "block" }' }, 400)
  }
  if (!pending.resolve(id, action)) return json({ error: 'no pending reply with that id' }, 404)
  if (action === 'release') pending.counters.released += 1
  else pending.counters.blocked += 1
  return json({ ok: true })
}

/**
 * Persist one configuration change through the profile's config editor.
 *
 * The merged candidate is validated before the editor writes, so a rejected
 * value leaves the row untouched instead of restarting the plugin with a bad
 * config.
 *
 * @param {object} ctx - plugin context.
 * @param {Request} request - the POST body, a partial config.
 * @returns {Promise<Response>} the outcome.
 */
async function handleConfig(ctx, request) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'expected a JSON body' }, 400)
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'expected a partial config object' }, 400)
  }

  // The panel posts the whole config back, so anything that is not a setting —
  // a runtime counter, a future field — is dropped here instead of failing the
  // save. A save must never be lost to a payload detail the user cannot see.
  const patch = {}
  for (const [key, value] of Object.entries(body)) {
    if (CONFIG_KEYS.has(key)) patch[key] = value
  }
  if (Object.keys(patch).length === 0) {
    return json({ error: 'no known config keys in the request body' }, 400)
  }

  const entry = ctx.fiber?.entry
  const editor = ctx.get('configEditor')
  if (entry === undefined || editor === undefined) {
    return json({
      error: 'this profile cannot persist configuration (no config editor for the plugin row); edit cordis.patch.yml directly',
    }, 503)
  }

  try {
    await editor.edit(entry, (current) => {
      const next = { ...current, ...patch }
      resolveConfig(next)
      return next
    })
    return json({ ok: true })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
}

/**
 * Wrap the conversation stream with refusal suppression.
 *
 * `llm/stream` is the single funnel every model call passes through, including
 * DSH's own auxiliary calls. `shouldGuard` narrows this plugin to the
 * conversation, so compaction, session titles, and auto-review keep their
 * streams intact.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {Record<string, unknown>} [config] - the loader row's config.
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) {
    ctx.logger?.info('gatekeeper: disabled by config')
    return
  }

  const pending = createPendingStore()
  const useStream = resolved.interceptAt === 'stream' || resolved.interceptAt === 'both'
  const useWire = resolved.interceptAt === 'wire' || resolved.interceptAt === 'both'

  // Wire mode sits upstream of everything: it replaces globalThis.fetch for the
  // life of this activation and puts the original back on unload.
  if (useWire) {
    ctx.effect(() => installWireGuard(resolved, (record) => {
      pending.remember({ at: Date.now(), sessionId: null, provider: null, model: null, ...record })
      ctx.logger?.warn(`gatekeeper: wire ${record.blocked ? 'blocked' : 'passed'} a ${record.phase} (${String(record.reason)})`)
    }), 'gatekeeper: wire guard')
  }

  if (useStream) ctx.on('llm/stream', (options, next) => {

    const base = next()
    if (!shouldGuard(resolved, options)) return base
    const where = {
      sessionId: options?.sessionId ?? null,
      provider: options?.provider ?? null,
      model: options?.model ?? null,
    }
    // Counted before the wrap so a guard that never runs is still visible as a
    // call the plugin did not see, rather than as silence.
    pending.counters.calls += 1
    return guardStream(base, resolved, {

      report: (record) => {

        pending.remember({
          at: Date.now(),
          sessionId: where.sessionId,
          provider: where.provider,
          model: where.model,
          ...record,
        })
        report(ctx, resolved, options, record)
      },
      ask: (record) => askUser(pending, resolved, options?.signal, { ...where, ...record }),
      fail: (error) => {
        pending.counters.errors += 1

        pending.remember({
          at: Date.now(),
          sessionId: where.sessionId,
          provider: where.provider,
          model: where.model,
          reason: 'guard-error',
          error: error instanceof Error ? error.message : String(error),
        })
        ctx.logger?.warn(`gatekeeper: guard failed and the reply passed through: ${error instanceof Error ? error.message : String(error)}`)
      },
    })
  })

  // The Fetch carrier may already be mounted when this plugin activates, or it
  // may appear later; both paths are covered so the panel always has routes.
  //
  // @returns {Function[]} disposers for every route registered here.
  const registerRoutes = (host, scope) => {
    const own = []
    own.push(scope.effect(() => host.fetch.register({
      path: STATE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => Promise.resolve(handleState(resolved, pending)),
    }), 'gatekeeper: state route'))

    own.push(scope.effect(() => host.fetch.register({
      path: DECIDE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleDecide(pending, request),
    }), 'gatekeeper: decide route'))

    own.push(scope.effect(() => host.fetch.register({
      path: CONFIG_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleConfig(ctx, request),
    }), 'gatekeeper: config route'))

    return own.filter((dispose) => typeof dispose === 'function')
  }

  // The Fetch carrier may mount after this plugin activates, and its own
  // injection hook does not fire reliably here. Poll for it instead: until the
  // routes exist the panel has no state to render, which looks exactly like a
  // broken settings page.
  let routesDisposed = []
  let connected = false

  const connect = () => {
    if (connected) return
    const host = ctx.get('connection')
    if (host === undefined || host.fetch === undefined) return
    routesDisposed = registerRoutes(host, ctx)
    connected = true
  }

  connect()
  if (!connected) {
    ctx.effect(() => {
      let timer = null
      let attempts = 0
      const attempt = () => {
        connect()
        if (connected) return
        attempts += 1
        // Five minutes of retries covers a slow boot without polling forever.
        if (attempts > 600) return
        timer = setTimeout(attempt, 500)
        timer.unref?.()
      }
      attempt()
      return () => {
        if (timer !== null) clearTimeout(timer)
        for (const dispose of routesDisposed) dispose()
      }
    }, 'gatekeeper: route retry')
  }

  ctx.logger?.info(
    `gatekeeper: active (onDetect=${resolved.onDetect}, scanChars=${resolved.scanChars}, dryRun=${resolved.dryRun}, custom patterns=${resolved.customPatterns.length}, extra purposes=[${resolved.purposes.join(', ')}])`,
  )
}
