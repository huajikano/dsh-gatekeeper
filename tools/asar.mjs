/**
 * Minimal ASAR reader: parse the header, list entries, extract one file, or grep.
 *
 * Layout of this archive (verified by hex dump):
 *   0   UInt32LE = 4                  marker
 *   4   UInt32LE = headerPickleSize   (data begins at 8 + this)
 *   8   UInt32LE = headerPickleSize - 4
 *   12  UInt32LE = jsonLength
 *   16  jsonLength bytes             (JSON directory tree)
 */
import { openSync, readSync, closeSync } from 'node:fs'

const ASAR = 'D:\\DeepSeek\\resources\\app.asar'

const fd = openSync(ASAR, 'r')

/** Read exactly `size` bytes at `position`. */
function readAt(size, position) {
  const buffer = Buffer.alloc(size)
  readSync(fd, buffer, 0, size, position)
  return buffer
}

const head = readAt(16, 0)
const headerPickleSize = head.readUInt32LE(4)
const jsonLength = head.readUInt32LE(12)
const tree = JSON.parse(readAt(jsonLength, 16).toString('utf8'))
const baseOffset = 8 + headerPickleSize

/** Walk the directory tree, yielding `[path, node]` for every file. */
function* walk(node, prefix = '') {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      yield* walk(child, `${prefix}/${name}`)
    }
  } else if (node.offset !== undefined) {
    yield [prefix, node]
  }
}

/** Read one file's bytes by its path inside the archive. */
function extract(path) {
  const parts = path.replace(/^\//, '').split('/')
  let node = tree
  for (const part of parts) {
    if (!node.files || !node.files[part]) throw new Error(`not found: ${path}`)
    node = node.files[part]
  }
  if (node.offset === undefined) throw new Error(`not a file: ${path}`)
  const size = Number(node.size)
  return readAt(size, baseOffset + Number(node.offset))
}

const [command, ...rest] = process.argv.slice(2)

try {
  if (command === 'list') {
    const needle = (rest[0] ?? '').toLowerCase()
    for (const [path, node] of walk(tree)) {
      if (needle === '' || path.toLowerCase().includes(needle)) console.log(path, node.size)
    }
  } else if (command === 'get') {
    process.stdout.write(extract(rest[0]))
  } else if (command === 'grep') {
    const re = new RegExp(rest[0], 'i')
    const filter = (rest[1] ?? '').toLowerCase()
    const extFilter = /\.(js|mjs|cjs|ts|json|md|yml)$/
    for (const [path] of walk(tree)) {
      if (filter !== '' && !path.toLowerCase().includes(filter)) continue
      if (!extFilter.test(path)) continue
      let text
      try {
        text = extract(path).toString('utf8')
      } catch {
        continue
      }
      text.split('\n').forEach((line, index) => {
        if (re.test(line)) console.log(`${path}:${index + 1}: ${line.trim().slice(0, 260)}`)
      })
    }
  } else {
    console.error('usage: asar.mjs list [substring] | get <path> | grep <regex> [pathFilter]')
    process.exitCode = 2
  }
} finally {
  closeSync(fd)
}
