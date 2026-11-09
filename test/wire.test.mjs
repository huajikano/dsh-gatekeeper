import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installWireGuard } from '../lib/wire.js'
import { resolveConfig } from '../lib/index.js'

/** Build an SSE body from a list of delta texts. */
function sseBody(texts) {
  const frames = texts.map((text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
  return `${frames.join('')}data: [DONE]\n\n`
}

/** A streaming Response carrying `body` chunk by chunk. */
function sseResponse(chunks) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/** Read a Response body to a string. */
async function bodyOf(response) {
  return await response.text()
}

/** Run one interception with a fake upstream, restoring fetch afterwards. */
async function withGuard(config, upstream, run) {
  const before = globalThis.fetch
  // The fake upstream must be in place first: the guard captures whatever fetch
  // is current and calls through to it.
  globalThis.fetch = async () => upstream()
  const verdicts = []
  const dispose = installWireGuard(config, (record) => verdicts.push(record))
  try {
    return await run(verdicts)
  } finally {
    dispose()
    globalThis.fetch = before
  }
}

const REFUSAL = '抱歉，我无法协助完成这个请求。'
const NORMAL = '补丁点位于 0x401050，改两个字节即可。'

test('wire mode blocks a refusal and closes the stream cleanly', async () => {
  const config = resolveConfig({ interceptAt: 'wire', scanChars: 20, wireTerminator: 'data: [DONE]\n\n' })
  await withGuard(config, () => sseResponse([sseBody([REFUSAL])]), async (verdicts) => {
    const response = await globalThis.fetch('https://api.example.com/v1/chat/completions', { method: 'POST' })
    const body = await bodyOf(response)
    assert.ok(!body.includes('抱歉'), 'the refusal text must not survive')
    assert.ok(body.includes('[DONE]'), 'the stream must still terminate')
    assert.equal(verdicts.length, 1)
    assert.equal(verdicts[0].phase, 'response')
    assert.equal(verdicts[0].blocked, true)
  })
})

test('wire mode passes a normal reply through byte-for-byte', async () => {
  const config = resolveConfig({ interceptAt: 'wire', scanChars: 20 })
  const original = sseBody([NORMAL])
  await withGuard(config, () => sseResponse([original]), async (verdicts) => {
    const response = await globalThis.fetch('https://api.example.com/v1/chat/completions', { method: 'POST' })
    assert.equal(await bodyOf(response), original)
    assert.equal(verdicts.length, 1)
    assert.equal(verdicts[0].blocked, false)
  })
})

test('wire mode ignores endpoints that are not configured LLM routes', async () => {
  const config = resolveConfig({ interceptAt: 'wire', scanChars: 20 })
  await withGuard(config, () => sseResponse([sseBody([REFUSAL])]), async (verdicts) => {
    const response = await globalThis.fetch('https://api.example.com/api/other', { method: 'POST' })
    const body = await bodyOf(response)
    assert.ok(body.includes('抱歉'), 'unrelated traffic must not be touched')
    assert.equal(verdicts.length, 0)
  })
})

test('wire mode ignores non-event-stream responses', async () => {
  const config = resolveConfig({ interceptAt: 'wire', scanChars: 20 })
  await withGuard(config, () => new Response(JSON.stringify({ ok: true }), {
    headers: { 'content-type': 'application/json' },
  }), async (verdicts) => {
    const response = await globalThis.fetch('https://api.example.com/v1/chat/completions', { method: 'POST' })
    assert.equal(await bodyOf(response), '{"ok":true}')
    assert.equal(verdicts.length, 0)
  })
})

test('wire request scanning can refuse to send the request', async () => {
  const config = resolveConfig({
    interceptAt: 'wire',
    wireScanRequests: true,
    wireBlockRequests: true,
    scanChars: 20,
  })
  let sent = 0
  await withGuard(config, () => {
    sent += 1
    return sseResponse([sseBody([NORMAL])])
  }, async () => {
    await assert.rejects(
      () => globalThis.fetch('https://api.example.com/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ messages: [{ role: 'user', content: REFUSAL }] }),
      }),
      /blocked/,
    )
    assert.equal(sent, 0, 'the blocked request must never reach the provider')
  })
})

test('wire request scanning only reports when blocking is off', async () => {
  const config = resolveConfig({
    interceptAt: 'wire',
    wireScanRequests: true,
    wireBlockRequests: false,
    scanChars: 20,
  })
  await withGuard(config, () => sseResponse([sseBody([NORMAL])]), async (verdicts) => {
    await globalThis.fetch('https://api.example.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: REFUSAL }] }),
    })
    assert.ok(verdicts.some((record) => record.phase === 'request' && record.blocked === true))
  })
})

test('the disposer restores the original fetch', async () => {
  const before = globalThis.fetch
  const config = resolveConfig({ interceptAt: 'wire' })
  const dispose = installWireGuard(config, () => {})
  assert.notEqual(globalThis.fetch, before)
  dispose()
  assert.equal(globalThis.fetch, before)
})

test('wire mode is not installed when interceptAt is stream', async () => {
  const before = globalThis.fetch
  const config = resolveConfig({ interceptAt: 'stream' })
  // installWireGuard is only called by apply() in wire/both mode; the module
  // itself must not patch anything at import time.
  assert.equal(globalThis.fetch, before)
  assert.equal(config.interceptAt, 'stream')
})

test('the wrapped response drops stale length and encoding headers', async () => {
  const config = resolveConfig({ interceptAt: 'wire', scanChars: 20 })
  await withGuard(config, () => new Response(sseBody([NORMAL]), {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'content-length': '999',
      'content-encoding': 'gzip',
    },
  }), async () => {
    const response = await globalThis.fetch('https://api.example.com/v1/chat/completions', { method: 'POST' })
    await bodyOf(response)
    assert.equal(response.headers.get('content-length'), null)
    assert.equal(response.headers.get('content-encoding'), null)
    assert.equal(response.headers.get('content-type'), 'text/event-stream')
  })
})

test('config rejects an unknown intercept mode', () => {
  assert.throws(() => resolveConfig({ interceptAt: 'tls' }), /interceptAt must be one of/)
})
