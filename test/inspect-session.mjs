import zlib from 'node:zlib'
import fs from 'node:fs'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Split a concatenated zstd stream into frames and decompress each. */
function decompressAllFrames(input) {
  const starts = []
  for (let i = 0; i + 4 <= input.length; i += 1) {
    if (input[i] === MAGIC[0] && input[i + 1] === MAGIC[1] && input[i + 2] === MAGIC[2] && input[i + 3] === MAGIC[3]) {
      starts.push(i)
    }
  }
  const parts = []
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]
    const end = index + 1 < starts.length ? starts[index + 1] : input.length
    try {
      parts.push(zlib.zstdDecompressSync(input.subarray(start, end)).toString('utf8'))
    } catch {
      /* trailing partial frame */
    }
  }
  return parts.join('')
}

const file = process.argv[2]
const raw = decompressAllFrames(fs.readFileSync(file))
const lines = raw.split('\n').filter((line) => line.trim().length > 0)

let found = 0
const kinds = new Map()
const types = new Map()
for (const line of lines) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    continue
  }
  types.set(event.type, (types.get(event.type) ?? 0) + 1)
  const kind = event?.data?.source?.kind
  if (typeof kind === 'string') kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
  if (kind !== 'memory') continue
  found += 1
  console.log('seq', event.seq, 'type', event.type, 'surfaceOp', JSON.stringify(event.surfaceOp))
  console.log('  identity:', String(event.data.source.identity).slice(0, 100))
  console.log('  text head:', String(event.data?.content?.[0]?.text ?? '').slice(0, 160).replace(/\n/g, ' | '))
}

console.log(`--- memory user/message events: ${found} of ${lines.length} log lines`)
console.log('source kinds:', Object.fromEntries(kinds))
console.log('event types:', Object.fromEntries(types))
