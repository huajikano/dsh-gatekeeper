/**
 * Guard for tool calls that could destroy a disk.
 *
 * This is the second half of the plugin, and it answers a different question
 * than the refusal guard: not "is this reply a refusal" but "is this command
 * about to delete more than it can ever get back".
 *
 * The trigger was a real incident. A coding agent on Windows ran a downloaded
 * PowerShell script, which walked a drive and deleted 405,225 files across
 * 35,411 directories in about two minutes, then emptied the Recycle Bin. On a
 * single NVMe SSD with TRIM enabled the blocks were gone before anyone could
 * react: 57 of 60 sampled sectors read back as zeros, there were no volume
 * shadow copies, and no recovery tool could help. Prevention is the only
 * remedy that exists for that class of mistake.
 *
 * So the rules here are shaped by what actually destroys data:
 *
 *   - deleting a drive root, filesystem root, or user profile,
 *   - formatting, repartitioning, or wiping a volume (including `cipher /w`),
 *   - purging the Recycle Bin,
 *   - fetching a remote script and executing it in one step — the incident's
 *     entry point, and unreviewable by definition,
 *   - writing straight to a raw device,
 *   - a recursive force delete of something that is neither a build directory
 *     nor a temporary path.
 *
 * Everything is pure: no cordis, no filesystem, no globals. `classifyText` is
 * unit-tested directly, so the rules can be tuned without restarting Harness.
 *
 * A deliberate limitation, documented in the README: this sees the tool call,
 * not the process. A script that is already running, or a command assembled at
 * runtime by a program the agent started, is outside what a pre-execute hook
 * can inspect. It catches the `iex (irm …)` that starts such a chain, not the
 * chain itself.
 *
 * @module dsh-gatekeeper/disk-guard
 */

/**
 * What may happen to a matching call.
 *
 * `off` never matches. `warn` lets the call through and records it, which is
 * the honest default for calls that are usually legitimate. `ask` routes the
 * call to the user, and on a session whose approval policy is `never` that
 * resolves to a denial — Harness cannot ask, so it fails closed. `block`
 * denies without asking.
 */
export const DISK_GUARD_ACTIONS = Object.freeze(['off', 'warn', 'ask', 'block'])

/** Which tier a rule belongs to; each tier has its own configured action. */
export const DISK_GUARD_TIERS = Object.freeze(['critical', 'risky'])

/**
 * Directories whose contents are meant to be thrown away.
 *
 * A recursive force delete that names only these is ordinary housekeeping, so
 * it is not reported at all. The list is deliberately narrow: `out`, `bin`, and
 * `obj` are omitted because in plenty of projects they hold the only copy of
 * something.
 */
export const DEFAULT_ALLOW_DIRS = Object.freeze([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.cache',
  '.parcel-cache',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.gradle',
  '.vs',
  'obj',
  'dist',
  'build',
  'target',
  'coverage',
  '.nyc_output',
  'tmp',
  'temp',
  'logs',
])

/**
 * Tool arguments that carry a shell command.
 *
 * A tool is only inspected when it is named in `diskGuardTools`, so an unknown
 * tool with a `text` argument cannot be misread as a shell. Within an inspected
 * tool these fields are read in order; the rest of the arguments are only
 * consulted when none of them is present.
 */
const COMMAND_FIELDS = Object.freeze(['command', 'cmd', 'script', 'shell', 'text', 'code', 'input'])

/** Argument fields that hold prose about the command, never the command. */
const PROSE_FIELDS = new Set([
  'description',
  'justification',
  'reason',
  'title',
  'name',
  'label',
  'summary',
  'comment',
])

/** Verbs that remove data. `delete`/`remove` on their own are too common. */
const DELETE_VERB = /\b(?:remove-item|remove-item2|ri|rm|rmdir|rd|del|erase|unlink)\b|\bshutil\.rmtree\b|\bremovedirs?\b|\brm(?:dir)?sync\b/

/** Flags that turn a delete into a subtree delete. */
const RECURSIVE_FLAG = /(?:^|\s)(?:-recurse\b|-r\b|-rf\b|-fr\b|--recursive\b|\/s\b)/

/** A drive root, with or without a wildcard: `C:\`, `d:/`, `c:\*`, `c:/*.*`. */
const DRIVE_ROOT = /(?:^|[\s"'`(=,[])([a-z]:\/(?:\*[^\s"'`;|&)>]*)?)(?=$|[\s"'`;|&),\]])/

/** The filesystem root on POSIX: `/`, `/*`, `/.`. */
const UNIX_ROOT = /(?:^|[\s"'`(=,[])(\/(?:\*[^\s"'`;|&)>]*|\.)?)(?=$|[\s"'`;|&),\]])/

/** Home and system roots by variable name, which no path check can resolve. */
const ENV_ROOT = /(?:^|[\s"'`(=,[])((?:~|\$home|\$\{home\}|%userprofile%|\$env:userprofile|\$env:home|\$env:systemdrive|\$env:homedrive|%systemdrive%|%homedrive%|\$env:appdata|%appdata%)(?:\/\*[^\s"'`;|&)>]*)?)(?=$|[\s"'`;|&),\]])/

/** The current directory, or everything in it. */
const CWD_TARGET = /(?:^|[\s"'`(=,])(\.|\*|\.\/|\*\.\*|\.\*|\.\/\*)(?=$|[\s"'`;|&),\]])/

/**
 * One rule is one way to lose a disk. `test` receives the prepared forms of the
 * command and returns the matched text on a hit.
 */
const RULES = [
  {
    id: 'drive-root-delete',
    tier: 'critical',
    why: 'deletes a whole drive or filesystem root',
    test: (c) => withRootTarget(c, firstMatch(c, [DRIVE_ROOT, UNIX_ROOT, ENV_ROOT])),
  },
  {
    id: 'system-tree-delete',
    tier: 'critical',
    why: 'deletes a user profile or a Windows system tree',
    test: (c) => {
      if (!DELETE_VERB.test(c.flat)) return null
      return firstMatch(c, [
        // The profile root itself, on any drive: `D:\Users\me`, `C:\Users\*`.
        /(?:^|[\s"'`(=,])([a-z]:\/users(?:\/(?:[^\/\s"'`;|&)]+|\*))?)(?=$|[\s"'`;|&),\]])/,
        // System trees, but not a file inside them.
        /(?:^|[\s"'`(=,])([a-z]:\/(?:windows|program files(?: \(x86\))?|programdata)(?:\/(?:\*|[^\/\s"'`;|&)]+))?)(?=$|[\s"'`;|&),\]])/,
      ])
    },
  },
  {
    id: 'format-volume',
    tier: 'critical',
    why: 'formats, partitions, or wipes a volume',
    test: (c) => {
      // A script written first and passed to `diskpart /s` carries its commands
      // in an earlier clause, so the two words are matched independently.
      if (/\bdiskpart\b/.test(c.posix) && /\bclean\b/.test(c.flat)) return 'diskpart clean'
      return firstMatch(c, [
        /\bformat-volume\b/,
        /\bclear-volume\b/,
        /\bget-volume\b[^\n]*\|\s*format-volume\b/,
        /\bformat(?:-volume)?\s+(?:[a-z]:|\/dev\/|\/fs:|\/q\b|\/p:)/,
        /\bclear-disk\b/,
        /\binitialize-disk\b/,
        /\bget-disk\b[^\n]*\|\s*clear-disk/,
        /\bmkfs(?:\.[a-z0-9]+)?\b/,
        /\bmke2fs\b/,
        /\bwipefs\b/,
        /\bnewfs(?:_[a-z0-9]+)?\b/,
        /\bsgdisk\b[^\n]*\b(?:zap|clear)\b/,
        /\bdiskpart\b[^\n]*\bclean\b/,
        /\b(?:gpt|fdisk)\b[^\n]*\b(?:-o|--clear|-z)\b/,
      ])
    },
  },
  {
    id: 'partition-tool',
    tier: 'risky',
    why: 'runs a partition editor whose script the guard cannot read',
    test: (c) => firstMatch(c, [/\bdiskpart\b/]),
  },
  {
    id: 'free-space-wipe',
    tier: 'critical',
    why: 'overwrites deleted data and free space',
    test: (c) => firstMatch(c, [
      /\bcipher\b[^\n]*\/w\b/,
      /\bsdelete\b/,
      /\bwipe\s+-[a-z]*[fF]/,
      /\bshred\b[^\n]*(?:\/dev\/|[a-z]:\\)/,
    ]),
  },
  {
    id: 'recycle-bin-purge',
    tier: 'critical',
    why: 'empties the Recycle Bin, removing the last copy',
    test: (c) => firstMatch(c, [
      /\bclear-recyclebin\b/,
      /\$recycle\.bin\b/,
      /\brecycler\b[^\n]*(?:remove-item|\bri\b|\brm\b|\bdel\b)/,
    ]),
  },
  {
    id: 'remote-exec',
    tier: 'critical',
    why: 'runs a downloaded script without showing it to anyone',
    test: (c) => {
      const download = /\b(?:irm|iwr|invoke-restmethod|invoke-webrequest|curl|wget|downloadstring|downloadfile|start-bitstransfer|net\.webclient|net\.httpclient)\b/
      // Every way PowerShell can turn a string into running code.
      const evaluate = /\b(?:iex|invoke-expression)\b|\[scriptblock\]::create|invoke-command\b[^\n]*-scriptblock/
      const piped = /\|\s*(?:iex|invoke-expression|powershell|pwsh|sh|bash|zsh|python3?|node)\b/
      const hasDownload = download.test(c.posix)
      // `iex (irm …)` and `iwr … | iex` are the same shape: fetch, then run.
      if (evaluate.test(c.flat) && hasDownload) return 'evaluate over a download'
      if (hasDownload && piped.test(c.posix)) return 'download piped into an interpreter'
      // These two have no honest non-malicious use.
      if (/\bcertutil\b[^\n]*-urlcache\b/.test(c.flat)) return 'certutil -urlcache'
      if (/\bbitsadmin\b[^\n]*\/transfer\b/.test(c.flat)) return 'bitsadmin /transfer'
      return null
    },
  },
  {
    id: 'download-then-execute',
    tier: 'risky',
    why: 'downloads a program and then runs it',
    test: (c) => {
      const download = /\b(?:irm|iwr|invoke-restmethod|invoke-webrequest|curl|wget|start-bitstransfer|downloadfile)\b/
      if (!download.test(c.posix)) return null
      // A downloaded binary or script invoked from disk, in either clause order.
      return firstMatch(c, [
        /(?:^|[\s"'`(;&,|])(?:\.\/|\.\\|&|\bstart\b|\bcall\b)\s*[^\s"'`;|&]*\.(?:exe|ps1|bat|cmd|vbs|scr|msi|jar)\b/,
      ])
    },
  },
  {
    id: 'shell-delete-without-recycle',
    tier: 'risky',
    why: 'deletes through the shell API, bypassing the Recycle Bin',
    test: (c) => firstMatch(c, [/\binvokeverb\s*\(\s*['"]delete/]),
  },
  {
    id: 'raw-device-write',
    tier: 'critical',
    why: 'writes to a raw disk device',
    test: (c) => firstMatch(c, [
      /\bdd\b[^\n]*\bof=\/dev\//,
      /\bdd\b[^\n]*\bof=\\\\\.\\physicaldrive/,
      />\s*\/dev\/(?:sd|nvme|hd|disk|mmcblk)/,
      /\\\\\.\\physicaldrive\d/,
    ]),
  },
  {
    id: 'recursive-force-delete',
    tier: 'risky',
    why: 'recursively force-deletes directories',
    test: (c) => {
      if (!DELETE_VERB.test(c.flat) || !RECURSIVE_FLAG.test(c.posix)) return null
      return firstMatch(c, [/\b(?:remove-item|ri|rm|rmdir|rd|del|erase|unlink)\b/])
    },
  },
  {
    id: 'cwd-wildcard-delete',
    tier: 'risky',
    why: 'deletes everything in the current directory',
    test: (c) => {
      if (!DELETE_VERB.test(c.flat)) return null
      const hit = firstMatch(c, [CWD_TARGET])
      if (hit === null) return null
      return hit
    },
  },
  {
    id: 'mirror-delete',
    tier: 'risky',
    why: 'mirrors a directory, deleting anything absent from the source',
    test: (c) => firstMatch(c, [
      /\brobocopy\b[^\n]*\/mir\b/,
      /\brsync\b[^\n]*--delete\b/,
      /\bunison\b[^\n]*-force\b/,
    ]),
  },
  {
    id: 'ownership-reset',
    tier: 'risky',
    why: 'takes ownership of a tree so it can be deleted',
    test: (c) => firstMatch(c, [
      /\btakeown\b[^\n]*\/r\b/,
      /\bicacls\b[^\n]*\/reset\b/,
      /\bchmod\b[^\n]*-r\b[^\n]*777\s+\/\s*$/,
    ]),
  },
  {
    id: 'git-clean',
    tier: 'risky',
    why: 'deletes untracked and ignored files',
    test: (c) => firstMatch(c, [/\bgit\b[^\n]*\bclean\b[^\n]*\s-[a-z]*[fF][a-z]*d?[a-z]*\b/]),
  },
  {
    id: 'encoded-command',
    tier: 'risky',
    why: 'runs an obfuscated command nobody can read',
    test: (c) => firstMatch(c, [/\b(?:powershell|pwsh)\b[^\n]*\s-(?:e|ec|enc|encodedcommand)\b/]),
  },
]

/**
 * Normalize one command string into the forms the rules match against.
 *
 * Matching runs on a lowercased, whitespace-collapsed copy, plus a copy with
 * backslashes turned into forward slashes so one path rule covers Windows and
 * POSIX. The original text is kept for the quoted snippet in the report.
 *
 * @param {string} text - the command text.
 * @returns {{raw: string, flat: string, posix: string}} the prepared forms.
 */
function prepare(text) {
  const raw = typeof text === 'string' ? text : ''
  const lower = raw.replace(/\r\n?/g, '\n').toLowerCase()
  const flat = lower.replace(/[ \t\f\v]+/g, ' ').trim()
  return { raw, flat, posix: flat.replace(/\\/g, '/') }
}

/**
 * First regex match across a candidate list.
 *
 * @param {{flat: string, posix: string}} c - prepared command.
 * @param {RegExp[]} patterns - patterns to try in order.
 * @returns {string | null} the matched text.
 */
function firstMatch(c, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(c.posix) ?? pattern.exec(c.flat)
    if (match !== null) return match[0].trim()
  }
  return null
}

/**
 * Pair a root path with a delete verb on the same command.
 *
 * A bare `C:\` in a listing command is not a problem; a `C:\` next to a delete
 * verb is. Both halves are required so `Get-ChildItem C:\` stays quiet.
 *
 * @param {{flat: string}} c - prepared command.
 * @param {string | null} root - the matched root token.
 * @returns {string | null} the evidence, when both halves are present.
 */
function withRootTarget(c, root) {
  if (root === null || root.length === 0) return null
  if (!DELETE_VERB.test(c.flat) && !/\b(?:del|rd|format)\b/.test(c.flat)) return null
  return root
}

/**
 * Decide whether one path is a throwaway build or temporary directory.
 *
 * @param {string} target - a token from the command, already lowercased.
 * @param {ReadonlySet<string>} allowDirs - configured directory names.
 * @returns {boolean} whether the target is allowed to disappear.
 */
export function isAllowlisted(target, allowDirs) {
  const cleaned = target
    .replace(/^["'`(]+/, '')
    .replace(/["'`),;]+$/, '')
    .replace(/\/+$/, '')
  if (cleaned.length === 0) return false
  // Temporary roots, however they are spelled, are always fair game.
  if (/(?:^|\/)(?:tmp|temp)(?:\/|$)/.test(cleaned)) return true
  if (/(?:\$env:temp|%temp%|\$env:tmp|%tmp%)/.test(cleaned)) return true
  // `./dist/*` names `dist`; the wildcard is a segment of its own.
  const named = cleaned.replace(/\/\*+.*$/, '').replace(/[*?]+$/, '')
  if (named.length === 0) return false
  const last = named.slice(named.lastIndexOf('/') + 1)
  return allowDirs.has(last)
}

/**
 * The clause of a command that performs the delete.
 *
 * A command is a chain: `rm -rf build && npm test` deletes `build` and then does
 * something unrelated. Only the clause carrying the delete verb names targets,
 * otherwise every word of the trailing command would have to be allowlisted
 * before a legitimate cleanup could pass.
 *
 * @param {string} posix - prepared command.
 * @returns {string} the clauses that mention a delete verb.
 */
function deleteClauses(posix) {
  const clauses = posix.split(/;\s*|\n|\s*(?:&&|\|\||\|)\s*/)
  const matching = clauses.filter((clause) => DELETE_VERB.test(clause))
  return matching.length > 0 ? matching.join(' ') : posix
}

/** The verb itself is not a target, and neither are the words around it. */
const NON_TARGET_WORDS = new Set([
  'remove-item', 'remove-item2', 'ri', 'rm', 'rmdir', 'rd', 'del', 'erase', 'unlink',
  'shutil.rmtree', 'removedirs', 'removedir', 'rmsync', 'rmdirsync',
  'and', 'or', 'not', 'if', 'then', 'else', 'do', 'echo', 'sudo', 'true', 'false',
])

/**
 * Tokens that could be the thing being deleted.
 *
 * `del /f /s /q node_modules` must yield `node_modules` and not `/f`, and a bare
 * relative name like `build` has no separator to recognize it by, so flags and
 * the verb itself are excluded by name instead.
 *
 * @param {string} posix - prepared command.
 * @param {ReadonlySet<string>} allowDirs - configured directory names.
 * @returns {string[]} candidate targets.
 */
export function targetsOf(posix, allowDirs) {
  const flag = /^(?:\/[a-z]{1,3}|-{1,2}[a-z][a-z0-9-]{0,20})$/
  const out = []
  for (const token of deleteClauses(posix).split(/[\s"'`;|&(),<>]+/)) {
    const t = token.trim()
    if (t.length === 0) continue
    if (flag.test(t) && !isAllowlisted(t, allowDirs)) continue
    if (NON_TARGET_WORDS.has(t)) continue
    out.push(t)
  }
  return out
}

/**
 * Classify one command string.
 *
 * @param {string} text - the command text to inspect.
 * @param {Record<string, unknown>} [options] - resolved config.
 * @param {boolean} [options.diskGuardWholeTree] - treat a subtree delete as
 *   allowed only when every named path is allowlisted. Always true in practice;
 *   exposed so the test suite can pin the behaviour.
 * @returns {null | { tier: 'critical' | 'risky', rule: string, why: string,
 *   matched: string, targets: string[] }} the verdict.
 */
export function classifyText(text, options = {}) {
  if (typeof text !== 'string' || text.trim().length === 0) return null
  const allowDirs = new Set(
    (Array.isArray(options.diskGuardAllowDirs) ? options.diskGuardAllowDirs : DEFAULT_ALLOW_DIRS)
      .map((entry) => String(entry).trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  )
  const disabled = new Set(
    (Array.isArray(options.diskGuardDisabledRules) ? options.diskGuardDisabledRules : [])
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0),
  )
  const c = prepare(text)
  const targets = targetsOf(c.posix, allowDirs)

  for (const rule of RULES) {
    if (disabled.has(rule.id)) continue
    let matched
    try {
      matched = rule.test(c)
    } catch {
      // A rule that throws must never take the call down with it.
      continue
    }
    if (!matched) continue

    // A recursive force delete is housekeeping when every path it names is a
    // build or temporary directory. Nothing about it can destroy something the
    // user would miss, so it is not reported at all.
    if (rule.tier === 'risky' && rule.id !== 'cwd-wildcard-delete') {
      const named = targets.filter((target) => !/^[a-z]:\/?$/.test(target) && target !== '/')
      if (named.length > 0 && named.every((target) => isAllowlisted(target, allowDirs))) continue
    }

    return {
      tier: rule.tier,
      rule: rule.id,
      why: rule.why,
      matched: String(matched).slice(0, 160),
      targets: targets.slice(0, 8),
    }
  }
  return null
}

/**
 * Pull the command string out of one tool call's arguments.
 *
 * Specific command fields win, so a `pwsh` call's `justification` prose can
 * never be mistaken for the command. Only when no such field exists are the
 * remaining strings joined, and prose fields are still skipped.
 *
 * @param {unknown} args - the parsed tool arguments.
 * @returns {string} the text to classify, empty when there is none.
 */
export function commandTextOf(args) {
  if (typeof args === 'string') return args
  if (args === null || typeof args !== 'object') return ''
  const record = /** @type {Record<string, unknown>} */ (args)
  const parts = []
  for (const field of COMMAND_FIELDS) {
    const value = record[field]
    if (typeof value === 'string' && value.trim().length > 0) parts.push(value)
  }
  if (parts.length > 0) return parts.join('\n')
  return collectStrings(record, 0).join('\n')
}

/**
 * Join every non-prose string in an object, a few levels deep.
 *
 * @param {Record<string, unknown>} value - the object to walk.
 * @param {number} depth - current recursion depth.
 * @returns {string[]} the strings found.
 */
function collectStrings(value, depth) {
  if (depth > 3) return []
  const out = []
  for (const [key, child] of Object.entries(value)) {
    if (PROSE_FIELDS.has(key.toLowerCase())) continue
    if (typeof child === 'string') {
      if (child.trim().length > 0) out.push(child)
    } else if (Array.isArray(child)) {
      for (const entry of child) {
        if (typeof entry === 'string' && entry.trim().length > 0) out.push(entry)
      }
    } else if (child !== null && typeof child === 'object') {
      out.push(...collectStrings(/** @type {Record<string, unknown>} */ (child), depth + 1))
    }
  }
  return out
}

/**
 * Classify one pending tool call against the configured guards.
 *
 * @param {{ name?: string, arguments?: unknown }} exec - the pending call.
 * @param {object} config - resolved plugin configuration.
 * @returns {null | { action: 'warn' | 'ask' | 'block', tier: string, rule: string,
 *   why: string, matched: string, targets: string[], reason: string }} the verdict.
 */
export function classifyToolCall(exec, config) {
  if (!config?.diskGuardEnabled) return null
  const name = typeof exec?.name === 'string' ? exec.name : ''
  const tools = Array.isArray(config.diskGuardTools) ? config.diskGuardTools : []
  if (!tools.includes(name)) return null

  const text = commandTextOf(exec?.arguments)
  if (text.length === 0) return null

  const hit = classifyText(text, config)
  if (hit === null) return null

  const action = hit.tier === 'critical' ? config.diskGuardCritical : config.diskGuardRisky
  if (action === 'off' || action === undefined) return null
  if (!DISK_GUARD_ACTIONS.includes(action)) return null

  return { ...hit, action, reason: buildReason(name, hit) }
}

/**
 * Build the message the agent (and the panel) sees.
 *
 * The text has to do two jobs: say what matched, and say what to do instead.
 * An agent that is only told "denied" retries the same command; an agent told
 * which rule fired and what the safe alternative is can finish its work.
 *
 * @param {string} tool - the tool name.
 * @param {object} hit - the classification.
 * @returns {string} the reason.
 */
function buildReason(tool, hit) {
  const who = hit.why
  const evidence = hit.matched.length > 0 ? `; matched: ${hit.matched}` : ''
  const rule = `rule ${hit.rule}${evidence}`
  if (hit.tier === 'critical') {
    return [
      `gatekeeper: blocked ${tool} — this command ${who} (${rule}).`,
      'The guard is on because a command like it already destroyed a drive once,',
      'and deletion of this shape is not recoverable: on an SSD with TRIM the',
      'blocks are gone before anything can be restored.',
      'Delete the specific files you need to remove, or ask the user to run this',
      'themselves. Do not retry the same command with different quoting.',
    ].join(' ')
  }
  return [
    `gatekeeper: ${tool} needs confirmation — this command ${who} (${rule}).`,
    'Confirm with the user before running a destructive command of this size.',
  ].join(' ')
}
