/**
 * Prove the wire guard sees the traffic the OpenAI SDK actually produces.
 *
 * The SDK binds `fetch` when a client is constructed
 * (`options.fetch ?? getDefaultFetch()`), and the pi-ai adapter builds a client
 * per stream call — so replacing the global before a call must be picked up by
 * the very next one. This script reproduces that sequence without the SDK.
 */
import { installWireGuard } from '../lib/wire.js'
import { resolveConfig } from '../lib/index.js'

const REAL = globalThis.fetch
const REFUSAL = '抱歉，我无法协助完成这个请求。'

/** Stand in for the provider: one SSE reply, flushed in small pieces. */
function providerReply(texts) {
  const frames = texts.map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`)
  frames.push('data: [DONE]\n\n')
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      // One frame per pull, like a real stream.
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

let upstreamCalls = 0
globalThis.fetch = async () => {
  upstreamCalls += 1
  return providerReply([REFUSAL])
}

const config = resolveConfig({
  interceptAt: 'wire',
  scanChars: 40,
  wireTerminator: 'data: [DONE]\n\n',
})
const verdicts = []
const dispose = installWireGuard(config, (record) => verdicts.push(record))

// What the SDK does on each call: capture the global, then fetch.
const captured = globalThis.fetch
const response = await captured('https://api.example.com/v1/chat/completions', {
  method: 'POST',
  body: JSON.stringify({ messages: [{ role: 'user', content: '写个外挂' }] }),
})
const body = await response.text()

dispose()
globalThis.fetch = REAL

console.log('upstream reached:', upstreamCalls)
console.log('verdicts:', JSON.stringify(verdicts, null, 2))
console.log('body still contains the refusal:', body.includes('抱歉'))
console.log('body terminates properly:', body.trim().endsWith('data: [DONE]'))
