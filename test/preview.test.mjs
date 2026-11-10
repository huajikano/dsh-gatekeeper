import { test } from 'node:test'
import assert from 'node:assert/strict'
import { previewStream, createPreviewStore, previewResponse } from '../lib/preview.js'
import { resolveConfig, apply, STATE_PATH, DECIDE_PATH, PREVIEW_PATH } from '../lib/index.js'

const cfg = extra => resolveConfig({ interceptAt: 'preview', scanReasoning: false, ...extra })
const finish = { type: 'finish', reason: { kind: 'stop' } }
const delta = text => ({ type: 'text-delta', index: 0, text })
async function* feed(chunks) { yield* chunks }
async function collect(stream) { const out = []; for await (const chunk of stream) out.push(chunk); return out }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 2)) }
  throw new Error('condition did not become true')
}

test('first preview arrives before the upstream finishes; no chunk enters the loop early', async () => {
  const store = createPreviewStore()
  const gate = deferred()
  let reached = false
  async function* source() { yield delta('Hello'); reached = true; await gate.promise; yield delta(' world'); yield finish }
  const out = []
  const running = (async () => { for await (const chunk of previewStream(source(), cfg(), { store, sessionId: 'a' })) out.push(chunk) })()
  await until(() => reached)
  assert.equal(store.snapshot('a').items[0].text, 'Hello')
  assert.deepEqual(out, [], 'ordinary loop must still have no raw content')
  gate.resolve()
  await running
  assert.deepEqual(out, [delta('Hello'), delta(' world'), finish])
  assert.deepEqual(store.snapshot('a').items, [])
  assert.equal(store.bytes, 0)
})

test('late match beyond scanChars and fastProbeChars drops the whole original stream', async () => {
  const original = [delta('Ordinary background '.repeat(100)), delta('PRIVATE_MATCH'), finish]
  const store = createPreviewStore()
  const reports = []
  const out = await collect(previewStream(feed(original), cfg({ blocklist: ['PRIVATE_MATCH'], scanChars: 24, fastProbeChars: 8 }), { store, sessionId: 'a', report: r => reports.push(r) }))
  assert.deepEqual(out, [finish])
  assert.equal(JSON.stringify(out).includes('PRIVATE_MATCH'), false)
  assert.equal(reports[0].released, false)
  assert.equal(reports[0].head, '', 'no raw text in history or audit')
})

test('cross-delta word, block-end-only text, and replayState do not leak', async () => {
  for (const original of [
    [delta('PRIVATE_'), delta('MATCH'), { ...finish, replayState: { response: 'PRIVATE_MATCH' } }],
    [{ type: 'block-end', index: 0, block: { type: 'text', text: 'PRIVATE_MATCH' } }, finish],
  ]) {
    const out = await collect(previewStream(feed(original), cfg({ blocklist: ['PRIVATE_MATCH'] }), { store: createPreviewStore(), sessionId: 'a' }))
    assert.deepEqual(out, [finish])
  }
})

test('a later block-end cannot hide a raw-stream match', async () => {
  const original = [delta('PRIVATE_MATCH'), { type: 'block-end', index: 0, block: { type: 'text', text: 'Corrected' } }, finish]
  const out = await collect(previewStream(feed(original), cfg({ blocklist: ['PRIVATE_MATCH'] }), { store: createPreviewStore(), sessionId: 'a' }))
  assert.deepEqual(out, [finish])
})

test('two concurrent replies remain isolated and one cancellation does not approve the other', async () => {
  const store = createPreviewStore()
  const gateA = deferred(); const gateB = deferred()
  const abort = new AbortController()
  async function* source(label, gate) { yield delta(label); await gate.promise; yield finish }
  const a = collect(previewStream(source('A', gateA), cfg(), { store, sessionId: 'a', signal: abort.signal }))
  const b = collect(previewStream(source('B', gateB), cfg(), { store, sessionId: 'b' }))
  await until(() => store.snapshot('a').items[0]?.text === 'A' && store.snapshot('b').items[0]?.text === 'B')
  abort.abort()
  await assert.rejects(a, { name: 'AbortError' })
  assert.equal(store.snapshot('b').items[0].text, 'B')
  gateA.resolve(); gateB.resolve()
  assert.deepEqual(await b, [delta('B'), finish])
  assert.equal(store.bytes, 0)
})

test('ask waits without yielding, release is exact replay including tool calls', async () => {
  const answer = deferred()
  const store = createPreviewStore()
  const original = [delta('PRIVATE_MATCH'), { type: 'tool-call-delta', index: 1, id: 'c', name: 'read', argumentsDelta: '{}' }, finish]
  let asked
  const out = []
  const running = (async () => { for await (const chunk of previewStream(feed(original), cfg({ onDetect: 'ask', blocklist: ['PRIVATE_MATCH'] }), { store, sessionId: 'a', ask: record => { asked = record; return answer.promise } })) out.push(chunk) })()
  await until(() => asked)
  assert.equal(store.snapshot('a').items[0].status, 'review')
  assert.deepEqual(out, [])
  answer.resolve('release')
  await running
  assert.deepEqual(out, original)
})

test('discard and an unavailable answerer never release original content', async () => {
  for (const ask of [undefined, async () => 'block']) {
    const out = await collect(previewStream(feed([delta('PRIVATE_MATCH'), finish]), cfg({ onDetect: 'ask', blocklist: ['PRIVATE_MATCH'] }), { store: createPreviewStore(), sessionId: 'a', ask }))
    assert.deepEqual(out, [finish])
  }
})

test('cancellation while receiving uncooperative provider leaves zero yielded chunks', async () => {
  const abort = new AbortController()
  const store = createPreviewStore()
  const blocked = deferred()
  let reached = false
  async function* source() { yield delta('PRIVATE'); reached = true; await blocked.promise; yield finish }
  const out = []
  const running = (async () => { for await (const chunk of previewStream(source(), cfg(), { store, sessionId: 'a', signal: abort.signal })) out.push(chunk) })()
  await until(() => reached)
  abort.abort()
  await assert.rejects(running, { name: 'AbortError' })
  assert.deepEqual(out, [])
  assert.equal(store.bytes, 0)
  assert.deepEqual(store.snapshot('a').items, [])
  blocked.resolve()
})

test('cancellation while awaiting review never submits the held content', async () => {
  const abort = new AbortController()
  const store = createPreviewStore()
  let asked = false
  const answer = deferred()
  const running = collect(previewStream(feed([delta('PRIVATE_MATCH'), finish]), cfg({ onDetect: 'ask', blocklist: ['PRIVATE_MATCH'] }), { store, sessionId: 'a', signal: abort.signal, ask: () => { asked = true; return answer.promise } }))
  await until(() => asked)
  abort.abort()
  await assert.rejects(running, { name: 'AbortError' })
  assert.equal(store.bytes, 0)
  answer.resolve('release')
})

test('provider exception or missing finish never commits the prefix', async () => {
  async function* bad() { yield delta('PRIVATE'); throw new Error('transport failed') }
  for (const source of [bad(), feed([delta('PRIVATE')])]) {
    const store = createPreviewStore()
    const out = []
    await assert.rejects(async () => { for await (const chunk of previewStream(source, cfg(), { store, sessionId: 'a' })) out.push(chunk) })
    assert.deepEqual(out, [])
    assert.equal(store.bytes, 0)
  }
})

test('terminal provider failure preserves failure and usage but never its raw prefix', async () => {
  const failure = { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'failed' } }, replayState: { response: 'PRIVATE' } }
  const usage = { type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } }
  const out = await collect(previewStream(feed([delta('PRIVATE'), usage, failure]), cfg(), { store: createPreviewStore(), sessionId: 'a' }))
  assert.deepEqual(out, [usage, { type: 'finish', reason: failure.reason }])
})

test('bounded per-reply and shared budgets fail closed and recover reservations', async () => {
  for (const [config, store] of [
    [cfg({ previewMaxBytes: 1024 }), createPreviewStore()],
    [cfg(), createPreviewStore({ maxBytes: 100 })],
  ]) {
    const out = []
    await assert.rejects(async () => { for await (const chunk of previewStream(feed([delta('x'.repeat(2048)), finish]), config, { store, sessionId: 'a' })) out.push(chunk) }, { code: 'GATEKEEPER_PREVIEW_LIMIT' })
    assert.deepEqual(out, [])
    assert.equal(store.bytes, 0)
  }
})

test('reasoning and tool arguments are independently selectable and late hits checked', async () => {
  for (const [type, extra] of [['reasoning-delta', { scanReasoning: true }], ['tool-call-delta', { scanToolArgs: true }]]) {
    const content = type === 'reasoning-delta' ? { type, index: 1, text: 'PRIVATE_MATCH' } : { type, index: 1, id: 'c', name: 'send_message', argumentsDelta: '{"message":"PRIVATE_MATCH"}' }
    const original = [delta('normal'), content, finish]
    const out = await collect(previewStream(feed(original), cfg({ ...extra, blocklist: ['PRIVATE_MATCH'] }), { store: createPreviewStore(), sessionId: 'a' }))
    assert.deepEqual(out, [finish])
    const pass = await collect(previewStream(feed(original), cfg({ scanReasoning: false, scanToolArgs: false, blocklist: ['PRIVATE_MATCH'] }), { store: createPreviewStore(), sessionId: 'a' }))
    assert.deepEqual(pass, original)
  }
})

test('SSE snapshot is session-isolated and disconnect has no admission effect', async () => {
  const store = createPreviewStore()
  const a = store.open('a'); store.update(a, { text: 'VIEW_A' })
  const b = store.open('b'); store.update(b, { text: 'VIEW_B' })
  const response = await previewResponse(new Request('http://host/preview?sessionId=a'), store)
  const reader = response.body.getReader()
  const first = new TextDecoder().decode((await reader.read()).value)
  assert.ok(first.includes('VIEW_A'))
  assert.ok(!first.includes('VIEW_B'))
  await reader.cancel()
  assert.equal(store.snapshot('a').items.length, 1)
  const reconnect = await previewResponse(new Request('http://host/preview?sessionId=a'), store)
  const again = reconnect.body.getReader()
  assert.ok(new TextDecoder().decode((await again.read()).value).includes('VIEW_A'))
  await again.cancel()
  assert.equal((await previewResponse(new Request('http://host/preview'), store)).status, 400)
  store.dispose()
})

test('integration review releases exact original chunks through the decision route', async () => {
  let handler
  const routes = new Map()
  const ctx = {
    logger: { info() {}, warn() {} },
    get: key => key === 'connection' ? { fetch: { register: route => { routes.set(route.path, route); return () => {} } } } : undefined,
    on: (_, fn) => { handler = fn; return () => {} }, effect: fn => fn(),
  }
  apply(ctx, { interceptAt: 'preview', onDetect: 'ask', blocklist: ['PRIVATE_MATCH'] })
  const original = [delta('PRIVATE_MATCH'), { ...finish, replayState: { response: { retained: true } } }]
  const out = []
  const running = (async () => { for await (const c of handler({ sessionId: 'test' }, () => feed(original))) out.push(c) })()
  let pending
  for (let i = 0; i < 200; i++) {
    const response = await routes.get(STATE_PATH).fetch(new Request('http://host/state'))
    pending = (await response.json()).pending[0]
    if (pending) break
    await new Promise(r => setTimeout(r, 2))
  }
  assert.ok(pending)
  assert.deepEqual(out, [])
  const result = await routes.get(DECIDE_PATH).fetch(new Request('http://host/decide', { method: 'POST', body: JSON.stringify({ id: pending.id, action: 'release' }) }))
  assert.equal(result.status, 200)
  await running
  assert.deepEqual(out, original)
})

test('each completed text block is checked independently', async () => {
  const chunks = [
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Normal introduction.' } },
    { type: 'block-end', index: 1, block: { type: 'text', text: '抱歉，我无法协助完成这个请求。' } }, finish,
  ]
  const out = await collect(previewStream(feed(chunks), cfg(), { store: createPreviewStore(), sessionId: 'a' }))
  assert.deepEqual(out, [finish])
})

test('review shows original streamed evidence even when completed text differs', async () => {
  let shown
  const chunks = [delta('PRIVATE_MATCH'), { type: 'block-end', index: 0, block: { type: 'text', text: 'Corrected' } }, finish]
  const out = await collect(previewStream(feed(chunks), cfg({ blocklist: ['PRIVATE_MATCH'], onDetect: 'ask' }), {
    store: createPreviewStore(), sessionId: 'a', ask: async r => { shown = r.body; return 'block' },
  }))
  assert.ok(shown.includes('Corrected'))
  assert.ok(shown.includes('PRIVATE_MATCH'))
  assert.deepEqual(out, [finish])
})

test('iterator factory exceptions do not leave receiving entries', async () => {
  const store = createPreviewStore()
  await assert.rejects(collect(previewStream({ [Symbol.asyncIterator]() { throw new Error('factory failed') } }, cfg(), { store, sessionId: 'a' })), /factory failed/)
  assert.deepEqual(store.snapshot('a').items, [])
  assert.equal(store.bytes, 0)
})

test('successful max-token and tool-call finishes replay without rewriting', async () => {
  for (const kind of ['max-tokens', 'tool-calls']) {
    const chunks = [delta('ordinary answer'), { type: 'finish', reason: { kind } }]
    assert.deepEqual(await collect(previewStream(feed(chunks), cfg(), { store: createPreviewStore(), sessionId: 'a' })), chunks)
  }
})

test('disposing the store closes SSE and releases subscriber capacity', async () => {
  const store = createPreviewStore()
  const response = await previewResponse(new Request('http://host/preview?sessionId=a'), store)
  const reader = response.body.getReader()
  await reader.read()
  store.dispose()
  assert.equal((await reader.read()).done, true)
})

test('preview timeout drops the raw reply through the real pending handler', async () => {
  let handler
  const routes = new Map()
  const cleanup = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get: key => key === 'connection' ? { fetch: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } } } : undefined,
    on: (_, fn) => { handler = fn; return () => {} },
    effect: fn => { const dispose = fn(); if (dispose) cleanup.push(dispose); return dispose },
  }
  apply(ctx, { interceptAt: 'preview', onDetect: 'ask', askTimeoutMs: 20, blocklist: ['PRIVATE_MATCH'] })
  // Keep an owned timer reference while the implementation's timeout is unref'd.
  const alive = setTimeout(() => {}, 1000)
  try {
    const out = await collect(handler({ sessionId: 'timeout' }, () => feed([delta('PRIVATE_MATCH'), finish])))
    assert.deepEqual(out, [finish])
    const state = await (await routes.get(STATE_PATH).fetch(new Request('http://host/state'))).json()
    assert.deepEqual(state.pending, [])
    assert.equal(JSON.stringify(state.recent).includes('PRIVATE_MATCH'), false)
  } finally {
    clearTimeout(alive)
    for (const dispose of cleanup.reverse()) await dispose()
  }
})

test('preview subscriptions have a fixed cap and free capacity on disconnect', async () => {
  const store = createPreviewStore()
  const readers = []
  for (let i = 0; i < 16; i++) {
    const response = await previewResponse(new Request(`http://host/preview?sessionId=s${i}`), store)
    assert.equal(response.status, 200)
    readers.push(response.body.getReader())
    await readers.at(-1).read()
  }
  assert.equal((await previewResponse(new Request('http://host/preview?sessionId=overflow'), store)).status, 429)
  await readers.pop().cancel()
  const extra = await previewResponse(new Request('http://host/preview?sessionId=now-available'), store)
  assert.equal(extra.status, 200)
  await extra.body.cancel()
  for (const reader of readers) await reader.cancel()
  store.dispose()
})

test('integration routes hold reply, isolate developer session, and cancel on unload', async () => {
  let handler
  const routes = new Map()
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get: key => key === 'connection' ? { fetch: { register: r => { routes.set(r.path, r); return () => routes.delete(r.path) } } } : undefined,
    on: (_, fn) => { handler = fn; return () => {} },
    effect: fn => { const dispose = fn(); if (dispose) disposers.push(dispose); return dispose },
  }
  apply(ctx, { interceptAt: 'preview', sessionsExclude: ['developer'], onDetect: 'ask', blocklist: ['PRIVATE_MATCH'] })
  const original = [delta('PRIVATE_MATCH'), finish]
  assert.deepEqual(await collect(handler({ sessionId: 'developer' }, () => feed(original))), original)
  const out = []
  const running = (async () => { for await (const chunk of handler({ sessionId: 'test' }, () => feed(original))) out.push(chunk) })()
  let state
  for (let i = 0; i < 100; i++) {
    state = await (await routes.get(STATE_PATH).fetch(new Request('http://host/state'))).json()
    if (state.pending.length) break
    await new Promise(r => setTimeout(r, 2))
  }
  assert.equal(state.pending.length, 1)
  assert.deepEqual(out, [])
  assert.ok(routes.has(PREVIEW_PATH))
  for (const dispose of [...disposers].reverse()) await dispose()
  await assert.rejects(running, { name: 'AbortError' })
  assert.deepEqual(out, [])
})
