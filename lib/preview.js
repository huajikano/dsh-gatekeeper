/** Transient preview transport and all-or-nothing admission. No session writes. */
import { randomUUID } from 'node:crypto'
import { detect, detectQuoted } from './refusal.js'

export const PREVIEW_PATH = '/api/dsh-gatekeeper/preview'

function abortError(signal) {
  const error = new Error('Gatekeeper preview cancelled')
  error.name = 'AbortError'
  error.code = 'ABORTED'
  error.cause = signal?.reason
  return error
}

/** Race even an uncooperative provider against cancellation; remove listeners. */
export async function cancellable(operation, signal) {
  if (signal?.aborted) throw abortError(signal)
  if (!signal) return operation
  let onAbort
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        onAbort = () => reject(abortError(signal))
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      }),
    ])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Bounded process-local store. Closing a subscriber never approves a reply. */
export function createPreviewStore({ maxBytes = 64 * 1024 * 1024 } = {}) {
  const items = new Map()
  const listeners = new Map()
  let bytes = 0
  let disposed = false
  let subscribers = 0
  const notify = sessionId => {
    for (const [fn, scope] of [...listeners]) {
      if (sessionId !== undefined && scope !== undefined && scope !== sessionId) continue
      try { fn() } catch {}
    }
  }
  return {
    get bytes() { return bytes },
    get disposed() { return disposed },
    acquireSubscriber() {
      if (disposed || subscribers >= 16) return null
      subscribers += 1
      let active = true
      return () => { if (active) { active = false; subscribers -= 1 } }
    },
    open(sessionId) {
      if (disposed) throw new Error('Gatekeeper preview is disposed')
      const id = randomUUID()
      items.set(id, { id, sessionId, status: 'receiving', text: '', reasoning: '', toolNames: [], revision: 0, bytes: 0 })
      notify(sessionId)
      return id
    },
    reserve(id, amount) {
      const item = items.get(id)
      if (!item || disposed) throw new Error('Gatekeeper preview is disposed')
      if (bytes + amount > maxBytes) {
        const error = new Error('Gatekeeper preview global memory limit exceeded; reply was not submitted')
        error.code = 'GATEKEEPER_PREVIEW_LIMIT'
        throw error
      }
      item.bytes += amount
      bytes += amount
    },
    update(id, patch) {
      const item = items.get(id)
      if (!item) return
      Object.assign(item, patch, { revision: item.revision + 1 })
      notify(item.sessionId)
    },
    remove(id) {
      const item = items.get(id)
      if (!item) return
      bytes -= item.bytes
      items.delete(id)
      notify(item.sessionId)
    },
    snapshot(sessionId) {
      // Return detached views, never promises, tool arguments or mutable internals.
      return { items: [...items.values()].filter(item => item.sessionId === sessionId).map(({ bytes: _, ...item }) => ({ ...item, toolNames: [...item.toolNames] })) }
    },
    subscribe(fn, sessionId) { listeners.set(fn, sessionId); return () => listeners.delete(fn) },
    dispose() {
      disposed = true
      items.clear()
      bytes = 0
      notify()
      listeners.clear()
    },
  }
}

/** Authenticated same-origin SSE. Updates coalesce; slow clients never queue history. */
export function previewResponse(request, store) {
  const sessionId = new URL(request.url).searchParams.get('sessionId')
  if (!sessionId || sessionId.length > 256) return Promise.resolve(Response.json({ error: 'sessionId is required' }, { status: 400 }))
  const release = store.acquireSubscriber()
  if (!release) return Promise.resolve(Response.json({ error: 'preview subscriber limit reached' }, { status: 429 }))
  const encoder = new TextEncoder()
  let cleanup = () => {}
  const body = new ReadableStream({
    start(controller) {
      let closed = false
      let queued = null
      let unsubscribe = () => {}
      let heartbeat
      const send = () => {
        queued = null
        if (closed || controller.desiredSize <= 0) return
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(store.snapshot(sessionId))}\n\n`)) } catch { cleanup() }
      }
      const changed = () => {
        if (store.disposed) { cleanup(); return }
        if (!closed && queued === null) {
          queued = setTimeout(send, 32)
          queued.unref?.()
        }
      }
      cleanup = () => {
        if (closed) return
        closed = true
        if (queued !== null) clearTimeout(queued)
        clearInterval(heartbeat)
        unsubscribe()
        release()
        request.signal.removeEventListener('abort', cleanup)
        try { controller.close() } catch {}
      }
      unsubscribe = store.subscribe(changed, sessionId)
      request.signal.addEventListener('abort', cleanup, { once: true })
      heartbeat = setInterval(() => {
        if (closed || controller.desiredSize <= 0) return
        // Also refresh snapshots so a skipped update caused by backpressure heals.
        send()
      }, 1000)
      heartbeat.unref?.()
      if (request.signal.aborted) cleanup()
      else send()
    },
    cancel() { cleanup() },
  })
  return Promise.resolve(new Response(body, { headers: {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  } }))
}

function limitError() {
  const error = new Error('Gatekeeper preview per-reply limit exceeded; reply was not submitted')
  error.code = 'GATEKEEPER_PREVIEW_LIMIT'
  return error
}

/**
 * Retain all original chunks privately while publishing a separate ephemeral view.
 * No raw delta reaches the agent loop until the whole successful reply is admitted.
 */
export function previewStream(base, config, { store, sessionId, signal, ask, report = () => {} }) {
  return (async function* () {
    if (signal?.aborted) throw abortError(signal)
    const id = store.open(sessionId)
    let iterator
    const held = []
    const blocks = new Map()
    let size = 0
    let finish = null
    let usage = null
    let ended = false
    let text = ''
    let reasoning = ''
    // Check both streamed deltas and completed blocks. A corrected block-end
    // must not conceal rejected text still present in the retained raw stream.
    const raw = { text: '', reasoning: '', 'tool-call': '' }
    const maxViewChars = 65536
    const update = () => store.update(id, {
      text: text.slice(-maxViewChars), reasoning: reasoning.slice(-maxViewChars),
      truncated: text.length > maxViewChars || reasoning.length > maxViewChars,
      toolNames: [...blocks.values()].filter(b => b.type === 'tool-call').map(b => b.name || 'tool'),
    })
    const fold = chunk => {
      if (!('index' in chunk)) return
      const prior = blocks.get(chunk.index)
      if (chunk.type === 'block-start') {
        if (!prior) blocks.set(chunk.index, { type: chunk.blockType, text: '', arguments: '' })
      } else if (chunk.type === 'block-end') {
        blocks.set(chunk.index, { ...chunk.block, closed: true })
        text = [...blocks.values()].filter(b => b.type === 'text').map(b => b.text || '').join('\n')
        reasoning = [...blocks.values()].filter(b => b.type === 'reasoning').map(b => b.text || '').join('\n')
      } else if (!prior?.closed) {
        const type = chunk.type === 'text-delta' ? 'text' : chunk.type === 'reasoning-delta' ? 'reasoning' : 'tool-call'
        const block = prior || { type, text: '', arguments: '' }
        if (type === 'tool-call') {
          block.arguments += chunk.argumentsDelta || ''
          block.name = chunk.name || block.name
        } else {
          block.text += chunk.text || ''
          if (type === 'text') text += chunk.text || ''
          else reasoning += chunk.text || ''
        }
        blocks.set(chunk.index, block)
      }
    }
    try {
      iterator = base[Symbol.asyncIterator]()
      while (true) {
        const item = await cancellable(Promise.resolve().then(() => iterator.next()), signal)
        if (item.done) { ended = true; break }
        const chunk = structuredClone(item.value)
        if (finish) throw new Error('Gatekeeper preview received data after terminal finish')
        const amount = Buffer.byteLength(JSON.stringify(chunk), 'utf8')
        size += amount
        if (size > config.previewMaxBytes) throw limitError()
        store.reserve(id, amount)
        held.push(chunk)
        if (chunk.type === 'usage') usage = chunk
        if (chunk.type === 'finish') finish = chunk
        if (chunk.type === 'text-delta') raw.text += chunk.text
        if (chunk.type === 'reasoning-delta') raw.reasoning += chunk.text
        if (chunk.type === 'tool-call-delta') raw['tool-call'] += chunk.argumentsDelta
        fold(chunk)
        update()
      }
      if (signal?.aborted) throw abortError(signal)
      if (!finish) throw new Error('Gatekeeper preview received no terminal finish')
      // Provider failures may retry through the normal loop; never persist their prefix.
      if (finish.reason.kind === 'error' || finish.reason.kind === 'aborted') {
        store.update(id, { status: 'failed', text: '', reasoning: '', toolNames: [] })
        if (usage) yield usage
        yield { type: 'finish', reason: finish.reason }
        return
      }
      store.update(id, { status: 'checking' })
      // Check every selected block; no early-pass shortcut or shared thinking budget.
      let verdict = null
      let matchedSource = null
      for (const source of ['text', 'reasoning', 'tool-call']) {
        if (source === 'reasoning' && !config.scanReasoning) continue
        if (source === 'tool-call' && !config.scanToolArgs) continue
        const selected = [...blocks.values()].filter(b => b.type === source)
        const individual = selected.map(b => source === 'tool-call' ? b.arguments || '' : b.text || '')
        const completed = individual.join('\n')
        for (const content of new Set([raw[source], completed, ...individual])) {
          if (!content || content.length < config.minChars) continue
          const wide = { ...config, scanChars: Math.max(1, content.length) }
          const result = detect(content, wide)
          const found = result.blocked ? result : source !== 'text' ? detectQuoted(content, wide) : result
          if (found.blocked) { verdict = found; matchedSource = source; break }
        }
        if (verdict) break
      }
      const record = verdict && {
        reason: verdict.reason, source: matchedSource,
        chars: text.length, visibleChars: text.length, reasoningChars: reasoning.length,
        // Review is private plugin memory; audit/report never receives the full body.
        head: '', dryRun: config.dryRun, released: false,
      }
      let release = !verdict || config.dryRun
      if (verdict && !config.dryRun && config.onDetect === 'ask') {
        store.update(id, { status: 'review', reason: verdict.reason })
        const sections = []
        for (const source of ['text', 'reasoning', 'tool-call']) {
          // The full raw stream is what release will admit, including differences
          // the final block no longer displays. A reviewer must see those too.
          const final = [...blocks.values()].filter(b => b.type === source).map(b => source === 'tool-call' ? b.arguments || '' : b.text || '').join('\n')
          if (final) sections.push(`${source} (completed blocks):\n${final}`)
          if (raw[source] && raw[source] !== final) sections.push(`${source} (original streamed content, also admitted on release):\n${raw[source]}`)
        }
        const body = sections.join('\n\n')
        release = ask ? (await cancellable(Promise.resolve().then(() => ask({ ...record, body })), signal)) === 'release' : false
      }
      if (signal?.aborted) throw abortError(signal)
      if (verdict) report({ ...record, released: release })
      if (release) {
        store.update(id, { status: 'committing' })
        // Synchronous replay: no network or timer awaits in the commit path.
        for (const chunk of held) { if (signal?.aborted) throw abortError(signal); yield chunk }
      } else {
        store.update(id, { status: 'blocked', text: '', reasoning: '', toolNames: [] })
        // No replacement message and no original replayState/stream prefix.
        if (usage) yield usage
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    } finally {
      store.remove(id)
      held.length = 0
      blocks.clear()
      if (!ended && iterator?.return) {
        // Do not hang cancellation forever on a provider whose pending next ignores abort.
        Promise.resolve().then(() => iterator.return()).catch(() => {})
      }
    }
  })()
}
