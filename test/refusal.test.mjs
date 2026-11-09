import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detect, detectQuoted, normalize, compilePatterns } from '../lib/refusal.js'
import { guardStream } from '../lib/stream.js'
import { resolveConfig } from '../lib/index.js'

/** Real refusals as models actually phrase them. */
const REFUSALS = [
  '抱歉，我不能协助完成这个请求。这涉及绕过软件的保护机制。',
  '很抱歉，我无法提供这类帮助。',
  '对不起，我不能帮你做这个。',
  '我无法协助进行逆向工程或破解软件。',
  "I'm sorry, but I can't help with that.",
  "I can't help with cracking commercial software.",
  'I am unable to assist with this request.',
  'As an AI, I cannot provide instructions for that.',
  'Sorry, but this is against my guidelines.',
  '很遗憾，这超出了我的能力范围。',
  '我不能提供破解方法，因为这违反了我的使用准则。',
  '里面是游戏外挂脚手架（ESP、自瞄、内存 hook、反作弊规避清单），我不会接着填那些偏移量。',
  '我不会接着填那些偏移量。',
  '我不会继续做这个功能了。',
  "I won't continue with that.",
]

/** Normal engineering replies that merely contain the same words. */
const LEGITIMATE = [
  '这个函数不能返回空指针，否则会崩溃。建议加判空。',
  'cannot convert `char*` to `int` — 这里缺少显式转换。',
  '编译器报错 "cannot find module"，先检查 tsconfig 的 paths。',
  '抱歉刚才那个方案有问题，我改成用 mmap 重写。',
  'I cannot reproduce the crash locally; here is the stack trace.',
  'The build fails because the linker cannot resolve `pthread`.',
  '抱歉，我上一条写错了，正确的偏移是 0x1A2B。',
  '这段代码不能编译，因为缺少 #include <vector>。',
  '我不会继续用这个库了，换成 X。',
  '我不会改这个接口，保持兼容。',
  '',
  '完成。已定位到校验函数在 0x401000，补丁点在 0x401050。',
]

test('normalize strips markdown and lowercases', () => {
  assert.equal(normalize("**I'm** Sorry,\n  but"), "i'm sorry, but")
  assert.equal(normalize('  - `cannot`  '), 'cannot')
})

test('detects real refusals', () => {
  for (const text of REFUSALS) {
    const verdict = detect(text)
    assert.equal(verdict.blocked, true, `should block: ${text}`)
  }
})

test('does not block legitimate engineering replies', () => {
  for (const text of LEGITIMATE) {
    const verdict = detect(text)
    assert.equal(verdict.blocked, false, `should pass: ${text} -> ${verdict.reason}`)
  }
})

test('a bare "cannot" is not a refusal', () => {
  assert.equal(detect('cannot convert char* to int').blocked, false)
})

test('two denials block even without an opener', () => {
  assert.equal(detect('我无法协助这个请求，也不能提供相关内容。').blocked, true)
})

test('a first-person intent refusal blocks on its own', () => {
  const verdict = detect('我不会接着填那些偏移量。')
  assert.equal(verdict.blocked, true)
  assert.equal(verdict.reason, 'intent')
})

test('an ordinary "I will not use this library" is not a refusal', () => {
  assert.equal(detect('我不会继续用这个库了，换成 X。').blocked, false)
})

test('a quoted refusal introduced as an example is discussion, not a refusal', () => {
  const config = resolveConfig({})
  // Carried: the reply is about to say it.
  assert.equal(detectQuoted('用户让我回复「抱歉，我无法协助完成这个请求。」这是拒绝句。', config).blocked, true)
  // Discussed: it appears as a sample.
  assert.equal(detectQuoted('例如「抱歉，我无法协助完成这个请求。」这句话应该被拦。', config).blocked, false)
  assert.equal(detectQuoted('测试样本："抱歉，我不能协助完成这个请求。"', config).blocked, false)
  assert.equal(detectQuoted('for example "抱歉，我无法协助完成这个请求。" is a sample', config).blocked, false)
})


test('custom patterns block unconditionally', () => {
  const config = { ...resolveConfig({ patterns: ['SECRET_MARKER'] }) }
  assert.equal(detect('anything SECRET_MARKER here', config).blocked, true)
  assert.equal(detect('nothing here', config).blocked, false)
})

test('invalid custom pattern is rejected at activation', () => {
  assert.throws(() => compilePatterns(['[unclosed']), /invalid patterns entry/)
})

test('the user word list blocks a plain substring', () => {
  const config = resolveConfig({ blocklist: ['帮不了', 'SECRET_MARKER'] })
  assert.equal(detect('这个忙我帮不了。', config).blocked, true)
  assert.equal(detect('这个忙我帮不了。', config).reason, 'blocklist')
  assert.equal(detect('anything secret_marker here', config).reason, 'blocklist')
  assert.equal(detect('这句话里什么都没有。', config).blocked, false)
})

test('an empty word-list entry never matches everything', () => {
  const config = resolveConfig({ blocklist: ['', '   '] })
  assert.equal(config.blockWords.length, 0)
  assert.equal(detect('任何内容', config).blocked, false)
})

test('the word list is case-insensitive and trimmed', () => {
  const config = resolveConfig({ blocklist: ['  I CANNOT  '] })
  assert.equal(config.blockWords[0], 'i cannot')
  assert.equal(detect('i Cannot do that', config).reason, 'blocklist')
})

test('config rejects unknown keys and bad types', () => {
  assert.throws(() => resolveConfig({ nope: 1 }), /unknown config key/)
  assert.throws(() => resolveConfig({ scanChars: 0 }), /scanChars must be an integer/)
  assert.throws(() => resolveConfig({ dryRun: 'yes' }), /dryRun must be a boolean/)
  assert.throws(() => resolveConfig({ onDetect: 'maybe' }), /onDetect must be/)
})

/** Build a provider-like chunk stream. */
function streamOf(chunks) {
  return (async function* feed() {
    for (const chunk of chunks) yield chunk
  })()
}

/** Collect a guarded stream into an array. */
async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

/** Split text into small text-delta chunks, as a provider streams them. */
function deltas(text, size = 6) {
  const chunks = [{ type: 'block-start', index: 0, blockType: 'text' }]
  for (let i = 0; i < text.length; i += size) {
    chunks.push({ type: 'text-delta', index: 0, text: text.slice(i, i + size) })
  }
  return chunks
}

/** The text a chunk list would render. */
function textOf(chunks) {
  return chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
}

test('block mode suppresses a streamed refusal and emits the replacement', async () => {
  const config = resolveConfig({ onDetect: 'block', replacementText: 'BLOCKED' })
  const seen = []
  const text = '抱歉，我不能协助完成这个请求。这涉及绕过软件的保护机制。'
  const out = await collect(guardStream(streamOf(deltas(text)), config, { report: (r) => seen.push(r) }))

  assert.equal(textOf(out), 'BLOCKED')
  assert.equal(out.at(-1).type, 'finish')
  assert.equal(out.at(-1).reason.kind, 'stop')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].released, false)
  assert.ok(!textOf(out).includes('抱歉'))
})

test('passes a normal reply through unchanged', async () => {
  const config = resolveConfig({})
  const original = deltas('这个函数不能返回空指针，否则会崩溃。建议在入口加判空。')
  const seen = []
  const out = await collect(guardStream(streamOf(original), config, { report: (r) => seen.push(r) }))

  assert.deepEqual(out, original)
  assert.equal(seen.length, 0)
})

test('usage survives suppression', async () => {
  const config = resolveConfig({ onDetect: 'block', replacementText: 'X' })
  const usage = { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
  const chunks = [...deltas('我无法协助进行逆向工程或破解软件。'), usage]
  const out = await collect(guardStream(streamOf(chunks), config, { report: () => {} }))

  assert.deepEqual(out.find((c) => c.type === 'usage'), usage)
})

test('dry run forwards everything but reports', async () => {
  const config = resolveConfig({ dryRun: true })
  const original = deltas('抱歉，我不能协助完成这个请求。')
  const seen = []
  const out = await collect(guardStream(streamOf(original), config, { report: (r) => seen.push(r) }))

  assert.deepEqual(out, original)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].dryRun, true)
})

test('scanToolArgs also catches a refusal carried inside a tool payload', async () => {
  const refusal = '抱歉，我无法协助完成这个请求。'
  const config = resolveConfig({ onDetect: 'block', replacementText: 'X', scanToolArgs: true })
  const chunks = [
    { type: 'tool-call-delta', index: 0, id: 'c1', name: 'send_message', argumentsDelta: `{"message":"${refusal}"}` },
  ]
  const out = await collect(guardStream(streamOf(chunks), config, { report: () => {} }))
  assert.equal(textOf(out), 'X')
  assert.ok(!out.some((c) => c.type === 'tool-call-delta'))
})

test('scanToolArgs: false leaves tool payloads alone', async () => {
  const chunks = [
    { type: 'tool-call-delta', index: 0, id: 'c1', name: 'send_message', argumentsDelta: '{"message":"抱歉，我无法协助完成这个请求。"}' },
  ]
  const config = resolveConfig({ scanToolArgs: false })
  const out = await collect(guardStream(streamOf(chunks), config, { report: () => {} }))
  assert.deepEqual(out, chunks)
})

test('a reply that calls a tool is released', async () => {
  const config = resolveConfig({ scanToolArgs: false })
  const chunks = [
    { type: 'text-delta', index: 0, text: '抱歉，我不能协助。' },
    { type: 'tool-call-delta', index: 1, id: 'c1', name: 'read', argumentsDelta: '{}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' } },
  ]
  const out = await collect(guardStream(streamOf(chunks), config, { report: () => {} }))
  assert.deepEqual(out, chunks)
})

test('blockToolCalls suppresses even tool-calling replies', async () => {
  const config = resolveConfig({ blockToolCalls: true, onDetect: 'block', replacementText: 'X' })
  const chunks = [
    { type: 'text-delta', index: 0, text: '抱歉，我不能协助完成这个请求。' },
    { type: 'tool-call-delta', index: 1, id: 'c1', name: 'read', argumentsDelta: '{}' },
  ]
  const out = await collect(guardStream(streamOf(chunks), config, { report: () => {} }))
  assert.ok(!out.some((c) => c.type === 'tool-call-delta'))
})

test('short replies below minChars are never blocked', async () => {
  const config = resolveConfig({ minChars: 100 })
  const original = deltas('抱歉，我不能协助。')
  const out = await collect(guardStream(streamOf(original), config, { report: () => {} }))
  assert.deepEqual(out, original)
})

test('ask mode releases the original reply untouched', async () => {
  const config = resolveConfig({ onDetect: 'ask' })
  const original = deltas('抱歉，我不能协助完成这个请求。这涉及绕过软件的保护机制。')
  const asked = []
  const reported = []
  const out = await collect(guardStream(streamOf(original), config, {
    report: (record) => reported.push(record),
    ask: async (record) => {
      asked.push(record)
      return 'release'
    },
  }))

  assert.deepEqual(out, original)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].pending, true)
  assert.ok(asked[0].head.includes('抱歉'))
  assert.equal(reported.length, 1)
  assert.equal(reported[0].released, true)
})

test('ask mode falls back to the replacement on a discard', async () => {
  const config = resolveConfig({ onDetect: 'ask', replacementText: 'DISCARDED' })
  const asked = []
  const out = await collect(guardStream(streamOf(deltas('抱歉，我不能协助完成这个请求。')), config, {
    report: () => {},
    ask: async (record) => {
      asked.push(record)
      return 'block'
    },
  }))

  assert.equal(asked.length, 1)
  assert.equal(textOf(out), 'DISCARDED')
  assert.equal(out.at(-1).type, 'finish')
})

test('ask mode without an answerer blocks rather than hanging', async () => {
  const config = resolveConfig({ onDetect: 'ask', replacementText: 'X' })
  const out = await collect(guardStream(streamOf(deltas('抱歉，我不能协助完成这个请求。')), config, { report: () => {} }))
  assert.equal(textOf(out), 'X')
})

test('block mode never asks', async () => {
  const config = resolveConfig({ onDetect: 'block', replacementText: 'X' })
  let asked = 0
  const out = await collect(guardStream(streamOf(deltas('抱歉，我不能协助完成这个请求。')), config, {
    report: () => {},
    ask: async () => {
      asked += 1
      return 'release'
    },
  }))
  assert.equal(asked, 0)
  assert.equal(textOf(out), 'X')
})

test('an empty replacement writes nothing into the reply', async () => {
  const config = resolveConfig({ onDetect: 'block', replacementText: '' })
  const out = await collect(guardStream(streamOf(deltas('抱歉，我不能协助完成这个请求。')), config, { report: () => {} }))

  assert.equal(textOf(out), '')
  assert.equal(out.some((c) => c.type === 'block-start' || c.type === 'block-end'), false)
  assert.equal(out.at(-1).type, 'finish')
  assert.equal(out.at(-1).reason.kind, 'stop')
})

test('long reasoning does not spend the visible text budget', async () => {
  // Regression: one shared `scanChars` window let a long thinking block decide
  // the reply early, so the refusal after it was never examined.
  const config = resolveConfig({ onDetect: 'block', replacementText: 'X', scanReasoning: true })
  const chunks = []
  const thinking = 'Let me think about how to respond to this request. '.repeat(20) // ~1000 chars
  for (let i = 0; i < thinking.length; i += 20) {
    chunks.push({ type: 'reasoning-delta', index: 0, text: thinking.slice(i, i + 20) })
  }
  const answer = '这个忙我帮不了。写外挂会破坏其他玩家的公平体验，也违反游戏服务条款，所以我不会协助开发这类工具。'
  for (let i = 0; i < answer.length; i += 10) {
    chunks.push({ type: 'text-delta', index: 1, text: answer.slice(i, i + 10) })
  }
  const out = await collect(guardStream(streamOf(chunks), config, { report: () => {} }))
  assert.equal(textOf(out), 'X')
})

test('a refusal that only appears in reasoning is caught too', async () => {
  const config = resolveConfig({ onDetect: 'block', replacementText: 'X' })
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '用户让我回复「抱歉，我无法协助完成这个请求。」这是拒绝句。' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '用户让我回复「抱歉，我无法协助完成这个请求。」这是拒绝句。' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '好的。' },
  ]
  const out = await collect(guardStream(streamOf(chunks), config, { report: () => {} }))

  assert.equal(textOf(out), 'X')
  assert.equal(out.some((c) => c.type === 'reasoning-delta'), false)
})

test('scanReasoning: false leaves reasoning out of the decision', async () => {
  const config = resolveConfig({ onDetect: 'block', scanReasoning: false, replacementText: 'X' })
  const chunks = [
    { type: 'reasoning-delta', index: 0, text: 'ユーザーは「抱歉，我无法协助完成这个请求。」と言ってほしい。' },
    { type: 'text-delta', index: 1, text: '完成了。' },
  ]
  const out = await collect(guardStream(streamOf(chunks), config, { report: () => {} }))

  assert.deepEqual(out, chunks)
})

test('releasing a reasoning refusal replays the reasoning', async () => {
  const config = resolveConfig({ onDetect: 'ask' })
  const chunks = [
    { type: 'reasoning-delta', index: 0, text: '抱歉，我无法协助完成这个请求。' },
    { type: 'text-delta', index: 1, text: '好的。' },
  ]
  const out = await collect(guardStream(streamOf(chunks), config, {
    report: () => {},
    ask: async () => 'release',
  }))

  assert.deepEqual(out, chunks)
})

test('a released reply keeps its tool calls', async () => {
  const config = resolveConfig({ onDetect: 'ask', blockToolCalls: true })
  const original = [
    { type: 'text-delta', index: 0, text: '抱歉，我不能协助完成这个请求。' },
    { type: 'tool-call-delta', index: 1, id: 'c1', name: 'read', argumentsDelta: '{}' },
  ]
  const out = await collect(guardStream(streamOf(original), config, {
    report: () => {},
    ask: async () => 'release',
  }))
  assert.deepEqual(out, original)
})
