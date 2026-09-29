/**
 * Minimal PNG pixel probe: reports the colour at a few sample points.
 *
 * Eyeballing two similar screenshots is unreliable and an image viewer may
 * normalise, so read the pixels directly. Handles the non-interlaced 8-bit
 * RGB/RGBA truecolour PNGs Chrome/Edge emit.
 *
 * Run: node test/png-probe.mjs <file.png> [...]
 */
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

/** Read one PNG's header, concatenated IDAT data, and inflated scanlines. */
function decode(path) {
  const buffer = readFileSync(path)
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path}: not a PNG`)
  let offset = 8
  let width = 0
  let height = 0
  let depth = 0
  let colorType = 0
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8]
      colorType = data[9]
      if (depth !== 8) throw new Error(`${path}: only 8-bit depth supported, got ${depth}`)
      if (data[12] !== 0) throw new Error(`${path}: interlaced PNG not supported`)
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0
  if (channels === 0) throw new Error(`${path}: unsupported colour type ${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    const prior = y === 0 ? Buffer.alloc(stride) : pixels.subarray((y - 1) * stride, y * stride)
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[x - channels] : 0
      const b = prior[x]
      const c = x >= channels ? prior[x - channels] : 0
      const value = line[x]
      let result
      switch (filter) {
        case 0: result = value; break
        case 1: result = value + a; break
        case 2: result = value + b; break
        case 3: result = value + ((a + b) >> 1); break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          result = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default: throw new Error(`${path}: unknown filter ${filter}`)
      }
      out[x] = result & 0xff
    }
  }
  return { width, height, channels, pixels }
}

/** The RGB hex at one point. */
function at(image, x, y) {
  const index = (y * image.width + x) * image.channels
  const [r, g, b] = [image.pixels[index], image.pixels[index + 1], image.pixels[index + 2]]
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

for (const path of process.argv.slice(2)) {
  const image = decode(path)
  // Bottom-left is inside the page background; the rest sample the panel.
  const points = [
    ['bottom-left', 4, image.height - 8],
    ['mid-right', image.width - 8, Math.floor(image.height * 0.5)],
    ['top-left', 4, 4],
  ]
  const samples = points.map(([name, x, y]) => `${name}=${at(image, x, y)}`).join('  ')
  console.log(`${path}\n  ${image.width}x${image.height}  ${samples}`)
}
