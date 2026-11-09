/**
 * Read a DSH session log, which appends one zstd frame per flush.
 *
 * Node's zstd decoder stops at the first frame, so the raw bytes are split on
 * the zstd magic number and each frame is decoded on its own.
 *
 * Usage: node tools/read-session.mjs <session.v4.jsonl.zstd> [--full] [--type <eventType>]
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: node tools/read-session.mjs <session.v4.jsonl.zstd> [--full] [--type <eventType>]')
  process.exit(2)
}
const full = process.argv.includes('--full')
const typeFlag = process.argv.indexOf('--type')
const onlyType = typeFlag > 0 ? process.argv[typeFlag + 1] : null

const raw = readFileSync(file)

// Split the archive into frames at every magic number.
const starts = []
for (let i = 0; i + 4 <= raw.length; i += 1) {
  if (raw[i] === MAGIC[0] && raw[i + 1] === MAGIC[1] && raw[i + 2] === MAGIC[2] && raw[i + 3] === MAGIC[3]) {
    starts.push(i)
  }
}

let text = ''
for (let index = 0; index < starts.length; index += 1) {
  const from = starts[index]
  const to = index + 1 < starts.length ? starts[index + 1] : raw.length
  try {
    text += zstdDecompressSync(raw.subarray(from, to)).toString('utf8')
  } catch {
    // A false magic match inside a frame is skipped; the real frames still yield.
  }
}

const lines = text.split('\n').filter((line) => line.trim().length > 0)
const events = []
for (const line of lines) {
  try {
    events.push(JSON.parse(line))
  } catch {
    // A partially flushed line is not an event.
  }
}

const counts = {}
for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1

if (process.argv.includes('--summary')) {
  console.log(`frames=${starts.length} events=${events.length}`)
  console.log(JSON.stringify(counts, null, 2))
  process.exit(0)
}

/** Pull the text blocks out of one message payload. */
function messageText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content.map((block) => (block.type === 'text' ? block.text : '')).filter(Boolean).join('\n')
}

for (const event of events) {
  if (onlyType !== null && event.type !== onlyType) continue
  if (onlyType === null && event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue

  const body = messageText(event.data?.message)
  const label = `seq=${event.seq ?? '?'} ${event.type}`
  if (body.length === 0) {
    console.log(`${label} <no text> content=${JSON.stringify(event.data?.message?.content ?? null)}`)
    continue
  }
  console.log(`${label} chars=${body.length}`)
  console.log(full ? body : `${body.slice(0, 500)}${body.length > 500 ? '…' : ''}`)
  console.log('---')
}
