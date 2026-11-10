import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Minimal hook runner exercises the actual shipped Client, with no browser or
// live DSH calls. Deliberately not a second preview UI implementation.
function client() {
  let plugin
  const registrations = []
  let initialState = null
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useState(value) { const out = initialState; initialState = null; return [out ?? value, () => {}] },
    useEffect() {}, useCallback(fn) { return fn },
  }
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(def) { plugin = def.factory(name => { if (name === 'react') return React; throw new Error(name) }) } } },
  })
  plugin.apply({ get() {}, effect(fn) { return fn() }, slots: {
    inject(_, fn) { fn() }, register(options, view) { registrations.push({ options, view }); return () => {} },
  } })
  return { registrations, render(view, props, state) { initialState = state; return view(props) } }
}
function nodes(node) {
  if (!node || typeof node !== 'object') return []
  return [node, ...node.children.flat(Infinity).flatMap(nodes)]
}

test('Client offers preview as a separate mode and keeps the existing modes', () => {
  const c = client()
  const page = c.registrations.find(r => r.options.name === 'settings.section')
  const tree = c.render(page.view, { t: key => key }, { config: { enabled: true, interceptAt: 'preview' }, pending: [], recent: [], counters: {} })
  const values = nodes(tree).filter(n => n.type === 'option').map(n => n.props.value)
  for (const value of ['stream', 'wire', 'both', 'preview']) assert.ok(values.includes(value))
})

test('non-preview mode does not mount a live preview component', () => {
  const c = client()
  const dock = c.registrations.find(r => r.options.name === 'conversation.input.dock')
  assert.equal(c.render(dock.view, { t: key => key, sessionId: 'a' }, { config: { interceptAt: 'stream' }, pending: [] }), null)
  const preview = c.render(dock.view, { t: key => key, sessionId: 'a' }, { config: { interceptAt: 'preview' }, pending: [] })
  assert.equal(typeof preview.type, 'function')
  assert.equal(preview.props.sessionId, 'a')
})
