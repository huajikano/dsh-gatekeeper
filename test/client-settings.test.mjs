import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

/**
 * Loads the shipped Client and exposes its settings page.
 *
 * The hook runner hands the first `useState` a prepared snapshot, which is how
 * the real page gets its state from `useGuardState`. Effects never run, so this
 * touches no browser API and no live DSH route — it only proves the tree the
 * component builds from a given state, which is where a broken field or a
 * missing label would otherwise surface at the user's first click.
 *
 * @returns {{ page: object, render: (state: object) => object }} the page and a renderer.
 */
function client() {
  let plugin
  const registrations = []
  let queue = []
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useState(value) { const out = queue.shift(); return [out ?? value, () => {}] },
    useEffect() {},
    useCallback(fn) { return fn },
  }
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: {
      __ModuleLoader__: {
        load(def) {
          plugin = def.factory((name) => {
            if (name === 'react') return React
            throw new Error(name)
          })
        },
      },
    },
  })
  plugin.apply({
    get() {},
    effect(fn) { return fn() },
    slots: {
      inject(_, fn) { fn() },
      register(options, view) { registrations.push({ options, view }); return () => {} },
    },
  })
  const page = registrations.find((entry) => entry.options.name === 'settings.section')
  return {
    page,
    /**
     * Render the page against a prepared hook queue: the state snapshot, then
     * the fetch error, exactly as `useGuardState` would hold them.
     */
    render(state, error) {
      queue = [state, error]
      return page.view({ t: (key) => key, close() {} })
    },
  }
}

/** Every element in a rendered tree. */
function nodes(node) {
  if (!node || typeof node !== 'object') return []
  return [node, ...node.children.flat(Infinity).flatMap(nodes)]
}

/** Every string a tree renders, including numbers and string props. */
function texts(node) {
  if (typeof node === 'string') return [node]
  if (typeof node === 'number') return [String(node)]
  if (!node || typeof node !== 'object') return []
  const own = Object.values(node.props || {}).filter((value) => typeof value === 'string')
  return [...own, ...(node.children || []).flat(Infinity).flatMap(texts)]
}

/** A state payload shaped like the Host's `/state` answer. */
function stateOf(config = {}, extra = {}) {
  return {
    config: {
      enabled: true,
      interceptAt: 'stream',
      onDetect: 'block',
      scanReasoning: true,
      scanToolArgs: false,
      fastPath: true,
      dryRun: false,
      blocklist: [],
      wireUrlPatterns: [],
      ...config,
    },
    pending: [],
    recent: [],
    counters: { calls: 3, diskHits: 7 },
    ...extra,
  }
}

test('the settings page renders the disk protection card', () => {
  const c = client()
  const tree = c.render(stateOf({
    diskGuardEnabled: true,
    diskGuardCritical: 'block',
    diskGuardRisky: 'warn',
    diskGuardTools: ['pwsh', 'terminal_send'],
    diskGuardAllowDirs: ['node_modules', 'dist'],
    diskGuardDisabledRules: [],
  }))

  const rendered = texts(tree)
  for (const key of ['diskTitle', 'diskHint', 'diskGuardEnabledLabel', 'diskCritical', 'diskRisky', 'diskTools', 'diskAllowDirs', 'diskRules', 'diskNote']) {
    assert.ok(rendered.includes(key), `the disk card should render ${key}`)
  }

  // Both tiers pick from the same four actions, and the two defaults must be
  // the safe pair: deny the destructive tier, record the merely large one.
  const selects = nodes(tree).filter((node) => node.type === 'select').map((node) => node.props.value)
  assert.ok(selects.includes('block'), 'the critical tier defaults to deny')
  assert.ok(selects.includes('warn'), 'the risky tier defaults to record-only')

  // The list fields are edited as text, one entry per line.
  const areas = nodes(tree).filter((node) => node.type === 'textarea').map((node) => node.props.value)
  assert.ok(areas.some((value) => value.includes('pwsh')), 'watched tools render one per line')
  assert.ok(areas.some((value) => value.includes('node_modules')), 'allowed directories render one per line')
})

test('the guard fields hide when the disk guard is off, the switch does not', () => {
  const c = client()
  const tree = c.render(stateOf({ diskGuardEnabled: false }))
  const rendered = texts(tree)
  assert.ok(rendered.includes('diskGuardEnabledHint'))
  assert.ok(!rendered.includes('diskCriticalHint'), 'a disabled guard shows no tier controls')
})

test('the ask hint appears only when a tier holds calls', () => {
  const c = client()
  const quiet = texts(c.render(stateOf({ diskGuardEnabled: true, diskGuardCritical: 'block', diskGuardRisky: 'warn' })))
  assert.ok(!quiet.includes('diskAskHint'))
  const asking = texts(c.render(stateOf({ diskGuardEnabled: true, diskGuardCritical: 'block', diskGuardRisky: 'ask' })))
  assert.ok(asking.includes('diskAskHint'))
})

test('a disk hit renders in the history with the disk wording', () => {
  const c = client()
  const tree = c.render(stateOf({}, {
    recent: [{
      at: Date.now(),
      kind: 'disk',
      tool: 'pwsh',
      tier: 'risky',
      action: 'warn',
      released: true,
      rule: 'recursive-force-delete',
      reason: 'disk · recursive-force-delete',
      chars: 16,
      head: 'rm -rf D:/Games',
    }],
  }))
  const rendered = texts(tree)
  assert.ok(rendered.includes('outcomeWarn'), 'a recorded hit is not labelled as blocked')
  assert.ok(rendered.includes('pwsh · risky'), 'the record names the tool and tier')
  assert.ok(rendered.includes('rm -rf D:/Games'), 'the record keeps the command')
  assert.ok(rendered.includes('diskLabel'), 'the metrics row counts disk hits')
  assert.ok(rendered.includes('7'), 'the disk hit counter is shown')
})

test('every label the Client asks for is in the dictionary', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const used = new Set(
    [...source.matchAll(/\bt\(\s*['"]([A-Za-z0-9_]+)['"]\s*\)/g)].map((match) => match[1]),
  )
  assert.ok(used.size > 60, `expected the Client to use many labels, found ${used.size}`)

  // Table keys sit at six-space indentation inside each dictionary.
  const dictionary = (name) => {
    const start = source.indexOf(`const ${name} = {`)
    assert.notEqual(start, -1, `${name} dictionary not found`)
    const block = source.slice(start, source.indexOf('\n    }', start))
    return new Set([...block.matchAll(/^\s{6}([A-Za-z0-9_]+):/gm)].map((match) => match[1]))
  }
  const zh = dictionary('ZH')
  const en = dictionary('EN')

  assert.deepEqual([...used].filter((key) => !zh.has(key)), [], 'no label may fall back to its key')
  assert.deepEqual([...en].filter((key) => !zh.has(key)), [], 'the English table may only add keys the fallback knows')

  // Keys reached through a computed name, which the scan above cannot see.
  for (const key of [
    'diskActionBlock', 'diskActionAsk', 'diskActionWarn', 'diskActionOff',
    'diskRun', 'diskDeny', 'diskLabel', 'outcomeWarn',
    'modeStream', 'modeWire', 'modeBoth', 'modePreview',
    'outcomeBlocked', 'outcomeReleased', 'outcomeDry',
  ]) {
    assert.ok(zh.has(key), `missing dictionary entry ${key}`)
  }
})

test('a plugin row that is disabled reports itself as not running', () => {
  // The plugin manager disables the loader row, not `config.enabled`. The card
  // must not keep claiming "enabled" from a stale snapshot after its routes go
  // away — that is what made the manager and this page disagree.
  const c = client()
  const tree = c.render(stateOf({ diskGuardEnabled: true }), 'HTTP 404')
  const rendered = texts(tree)
  assert.ok(rendered.includes('offlineHint'), 'and it must explain where the row switch lives')
  const badge = nodes(tree).find((node) => node.props && node.props.className === 'gk-badge')
  assert.equal(badge.children[0], 'statusOffline', 'the badge must not keep the stale verdict')
  const save = nodes(tree).find((node) => node.props && node.props.primary === true)
  assert.equal(save.props.disabled, true, 'saving is impossible while the routes are gone')
})

test('a held tool call offers run and deny, not release and discard', () => {
  const c = client()
  const tree = c.render(stateOf({}, {
    pending: [{
      id: 'p1',
      kind: 'disk',
      reason: 'disk · recursive-force-delete',
      chars: 16,
      createdAt: Date.now(),
      head: 'rm -rf D:/Games',
      tier: 'risky',
    }],
  }))
  // The pending row is a component, so it is invoked here with its own props.
  const row = nodes(tree).find((node) => node.props && node.props.item && node.props.item.kind === 'disk')
  assert.ok(row, 'the pending command should render a review row')
  const rendered = texts(row.type(row.props))
  assert.ok(rendered.includes('diskRun'))
  assert.ok(rendered.includes('diskDeny'))
  assert.ok(!rendered.includes('release'))
  assert.ok(!rendered.includes('block'))
  assert.ok(rendered.includes('rm -rf D:/Games'))
})
