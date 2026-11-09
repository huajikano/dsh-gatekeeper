import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, resolveConfig, inject, name, INTERNAL_PURPOSES, STATE_PATH, DECIDE_PATH, CONFIG_PATH } from '../lib/index.js'

/**
 * A context stub carrying the waterfall listener and the optional services.
 *
 * @param {object[]} log - receives logger calls.
 * @param {{ connection?: object }} [services] - services `ctx.get` may return.
 * @returns {{ ctx: object, listener: () => Function | null }} the stub and a reader.
 */
function fakeContext(log, services = {}) {
  let listener = null
  const ctx = {
    logger: {
      info: (message) => log.push({ level: 'info', message }),
      warn: (message) => log.push({ level: 'warn', message }),
    },
    get(serviceName) {
      return services[serviceName]
    },
    inject(deps, callback) {
      if (deps.some((dep) => services[dep] === undefined)) return
      callback({
        connection: services.connection,
        effect: (effect) => effect(),
      })
    },
    effect(callback) {
      return callback()
    },
    on(event, handler) {
      assert.equal(event, 'llm/stream')
      listener = handler
      return () => {
        listener = null
      }
    },
  }
  return { ctx, listener: () => listener }
}

/** A provider-like stream of text deltas. */
function streamOf(chunks) {
  return (async function* feed() {
    for (const chunk of chunks) yield chunk
  })()
}

/** Collect a stream into an array. */
async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

/** The text a chunk list would render. */
function textOf(chunks) {
  return chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
}

const REFUSAL_CHUNKS = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '抱歉，我不能协助完成这个请求。' },
  { type: 'text-delta', index: 0, text: '这涉及绕过软件的保护机制。' },
]

/** A Fetch carrier stub that keeps the registered routes addressable. */
function fakeConnection() {
  const routes = new Map()
  return {
    routes,
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
  }
}

/** Poll the state route until at least `count` replies are waiting. */
async function waitForPending(routes, count = 1) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const response = await routes.get(STATE_PATH).fetch(new Request('http://host/state'))
    const state = await response.json()
    if (state.pending.length >= count) return state
    await new Promise((resolveNow) => setTimeout(resolveNow, 5))
  }
  throw new Error('no pending reply appeared')
}

/** POST one decision to the decide route. */
function decide(routes, body) {
  return routes.get(DECIDE_PATH).fetch(new Request('http://host/decide', {
    method: 'POST',
    body: JSON.stringify(body),
  }))
}

test('registers one llm/stream waterfall listener', () => {
  const log = []
  const { ctx, listener } = fakeContext(log)
  apply(ctx, {})
  assert.equal(typeof listener(), 'function')
  assert.ok(log.some((entry) => entry.message.includes('gatekeeper: active')))
})

test('disabled config registers nothing', () => {
  const log = []
  const { ctx, listener } = fakeContext(log)
  apply(ctx, { enabled: false })
  assert.equal(listener(), null)
})

test('block mode short-circuits a refusal', async () => {
  const log = []
  const { ctx, listener } = fakeContext(log)
  apply(ctx, { onDetect: 'block', replacementText: 'BLOCKED' })

  const guarded = listener()({ sessionId: 's1', provider: 'p', model: 'm' }, () => streamOf(REFUSAL_CHUNKS))
  const out = await collect(guarded)

  assert.equal(textOf(out), 'BLOCKED')
  assert.equal(out.at(-1).type, 'finish')
  assert.ok(log.some((entry) => entry.level === 'warn' && entry.message.includes('blocked')))
})

test('the waterfall passes a normal reply through', async () => {
  const log = []
  const { ctx, listener } = fakeContext(log)
  apply(ctx, {})
  const chunks = [
    { type: 'text-delta', index: 0, text: '补丁点位于 0x401050，改两个字节即可。' },
  ]
  const out = await collect(listener()({ sessionId: 's1' }, () => streamOf(chunks)))
  assert.deepEqual(out, chunks)
})

test('session allow-list narrows the guard', async () => {
  const log = []
  const { ctx, listener } = fakeContext(log)
  apply(ctx, { sessions: ['s1'], onDetect: 'block', replacementText: 'X' })

  const guarded = await collect(listener()({ sessionId: 's2' }, () => streamOf(REFUSAL_CHUNKS)))
  assert.ok(textOf(guarded).includes('抱歉'))

  const blocked = await collect(listener()({ sessionId: 's1' }, () => streamOf(REFUSAL_CHUNKS)))
  assert.equal(textOf(blocked), 'X')
})

test('purposes opt extra callers in, and everything else stays untouched', async () => {
  const log = []
  const { ctx, listener } = fakeContext(log)
  apply(ctx, { purposes: ['compaction'], onDetect: 'block', replacementText: 'X' })

  const compaction = await collect(listener()({ purpose: 'compaction' }, () => streamOf(REFUSAL_CHUNKS)))
  assert.equal(textOf(compaction), 'X')

  for (const purpose of ['chat', 'session-title', 'auto-review', 'something-new']) {
    const out = await collect(listener()({ purpose }, () => streamOf(REFUSAL_CHUNKS)))
    assert.ok(textOf(out).includes('抱歉'), `${purpose} must pass through untouched`)
  }
})

test('the conversation request is the one without a purpose', async () => {
  const log = []
  const { ctx, listener } = fakeContext(log)
  apply(ctx, { onDetect: 'block', replacementText: 'X' })

  // The agent loop builds its request with no `purpose`; that is the conversation.
  const conversation = await collect(listener()({ sessionId: 's1' }, () => streamOf(REFUSAL_CHUNKS)))
  assert.equal(textOf(conversation), 'X')
})

test('every DSH auxiliary purpose is left untouched by default', async () => {
  const log = []
  const { ctx, listener } = fakeContext(log)
  apply(ctx, { onDetect: 'block', replacementText: 'X' })

  for (const purpose of ['compaction', 'session-title', 'auto-review', 'something-new']) {
    const out = await collect(listener()({ purpose }, () => streamOf(REFUSAL_CHUNKS)))
    assert.ok(textOf(out).includes('抱歉'), `${purpose} must pass through untouched`)
  }
  assert.equal(log.filter((entry) => entry.level === 'warn').length, 0)
})

test('ask mode holds the reply until the route releases it', async () => {
  const log = []
  const { routes, connection } = fakeConnection()
  const { ctx, listener } = fakeContext(log, { connection })
  apply(ctx, { onDetect: 'ask', replacementText: 'BLOCKED' })

  const collecting = collect(listener()({ sessionId: 's1', provider: 'p', model: 'm' }, () => streamOf(REFUSAL_CHUNKS)))

  const state = await waitForPending(routes)
  const [pending] = state.pending
  assert.equal(pending.sessionId, 's1')
  assert.ok(pending.head.includes('抱歉'))
  // The reviewer needs what would actually enter the session, not just a preview.
  assert.ok(pending.body.includes('这涉及绕过软件的保护机制。'))
  assert.equal(pending.body, '抱歉，我不能协助完成这个请求。这涉及绕过软件的保护机制。')

  assert.equal((await decide(routes, { id: pending.id, action: 'release' })).status, 200)
  assert.deepEqual(await collecting, REFUSAL_CHUNKS)
})

test('ask mode discards through the route', async () => {
  const log = []
  const { routes, connection } = fakeConnection()
  const { ctx, listener } = fakeContext(log, { connection })
  apply(ctx, { onDetect: 'ask', replacementText: 'BLOCKED' })

  const collecting = collect(listener()({ sessionId: 's1' }, () => streamOf(REFUSAL_CHUNKS)))

  const state = await waitForPending(routes)
  const [pending] = state.pending
  await decide(routes, { id: pending.id, action: 'block' })

  assert.equal(textOf(await collecting), 'BLOCKED')
})

test('a muted session passes through untouched', async () => {
  const log = []
  const { ctx, listener } = fakeContext(log)
  apply(ctx, { onDetect: 'block', replacementText: 'X', sessionsExclude: ['s-muted'] })

  const muted = await collect(listener()({ sessionId: 's-muted' }, () => streamOf(REFUSAL_CHUNKS)))
  assert.ok(textOf(muted).includes('抱歉'))

  const guarded = await collect(listener()({ sessionId: 's-other' }, () => streamOf(REFUSAL_CHUNKS)))
  assert.equal(textOf(guarded), 'X')
})

test('the state payload carries no key the save would reject', async () => {
  const log = []
  const { routes, connection } = fakeConnection()
  const { ctx } = fakeContext(log, { connection })
  apply(ctx, {})

  const state = await (await routes.get(STATE_PATH).fetch(new Request('http://host/state'))).json()
  // Every key under `config` must be one resolveConfig accepts, because the
  // panel posts that object straight back on save.
  assert.doesNotThrow(() => resolveConfig(state.config))
  assert.equal('calls' in state.config, false)
  assert.equal(state.counters.calls, 0)
})

test('the config route saves a patch and ignores unknown keys', async () => {
  const log = []
  const { routes, connection } = fakeConnection()
  const saved = []
  const editor = {
    async edit(entry, change) {
      const next = change({ scanChars: 600 })
      saved.push(next)
    },
  }
  const { ctx } = fakeContext(log, { connection, configEditor: editor })
  Object.assign(ctx, { fiber: { entry: { id: 'gatekeeper' } } })
  apply(ctx, {})

  const response = await routes.get(CONFIG_PATH).fetch(new Request('http://host/config', {
    method: 'POST',
    body: JSON.stringify({ scanChars: 240, calls: 99, nonsense: true }),
  }))
  assert.equal(response.status, 200)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].scanChars, 240)
  // A stray runtime field must not reach the persisted row.
  assert.equal('calls' in saved[0], false)
})

test('the config route refuses a body with no known keys', async () => {
  const log = []
  const { routes, connection } = fakeConnection()
  const { ctx } = fakeContext(log, { connection, configEditor: { async edit() {} } })
  Object.assign(ctx, { fiber: { entry: { id: 'gatekeeper' } } })
  apply(ctx, {})

  const response = await routes.get(CONFIG_PATH).fetch(new Request('http://host/config', {
    method: 'POST',
    body: JSON.stringify({ calls: 1 }),
  }))
  assert.equal(response.status, 400)
})

test('routes appear even when the carrier mounts after activation', async () => {
  const log = []
  const services = {}
  const { ctx } = fakeContext(log, services)
  apply(ctx, {})

  // Nothing is mounted yet, so there is no state to read.
  assert.equal(services.connection, undefined)

  const { routes, connection } = fakeConnection()
  services.connection = connection
  await new Promise((resolveNow) => setTimeout(resolveNow, 650))

  assert.ok(routes.has(STATE_PATH), 'state route should register once the carrier appears')
  const state = await (await routes.get(STATE_PATH).fetch(new Request('http://host/state'))).json()
  assert.equal(typeof state.config.scanChars, 'number')
})

test('the decide route rejects an unknown id and a bad action', async () => {
  const log = []
  const { routes, connection } = fakeConnection()
  const { ctx } = fakeContext(log, { connection })
  apply(ctx, {})

  assert.equal((await decide(routes, { id: 'nope', action: 'release' })).status, 404)
  assert.equal((await decide(routes, { id: 'nope', action: 'maybe' })).status, 400)
})

test('an untouched pending reply times out into a block', async () => {
  const log = []
  const { routes, connection } = fakeConnection()
  const { ctx, listener } = fakeContext(log, { connection })
  apply(ctx, { onDetect: 'ask', askTimeoutMs: 40, replacementText: 'TIMEOUT' })

  const out = await collect(listener()({ sessionId: 's1' }, () => streamOf(REFUSAL_CHUNKS)))
  assert.equal(textOf(out), 'TIMEOUT')
})

test('INTERNAL_PURPOSES names the three DSH auxiliary callers', () => {
  assert.deepEqual([...INTERNAL_PURPOSES], ['compaction', 'session-title', 'auto-review'])
})

test('module exports the loader contract', () => {
  assert.equal(name, 'gatekeeper')
  assert.deepEqual(inject, [])
  assert.equal(typeof resolveConfig({}).scanChars, 'number')
})
