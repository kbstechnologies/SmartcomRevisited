/**
 * Minimal PNG decode/encode for 8-bit images.
 *
 * Kept dependency-free on purpose: the project only needs to crop and mask a
 * couple of brand assets at build-prep time, which does not justify pulling in
 * a native image library.
 */
const zlib = require('zlib')

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/** Reverses the per-scanline filter PNG applies before compression. */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const outLine = out.subarray(y * stride, (y + 1) * stride)
    const prevLine = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null

    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? outLine[i - bpp] : 0
      const b = prevLine ? prevLine[i] : 0
      const c = prevLine && i >= bpp ? prevLine[i - bpp] : 0
      const x = line[i]

      let value
      switch (filter) {
        case 0: value = x; break
        case 1: value = x + a; break
        case 2: value = x + b; break
        case 3: value = x + ((a + b) >> 1); break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default:
          throw new Error(`Unsupported PNG filter type ${filter}`)
      }
      outLine[i] = value & 0xff
    }
  }
  return out
}

/** Decodes a PNG file into { width, height, data } with RGBA bytes. */
function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG')

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat = []
  let palette = null
  let transparency = null

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)

    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'PLTE') {
      palette = Buffer.from(data)
    } else if (type === 'tRNS') {
      transparency = Buffer.from(data)
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }

    offset += 12 + length
  }

  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`)
  if (interlace !== 0) throw new Error('interlaced PNG not supported')

  const channels = CHANNELS[colorType]
  if (!channels) throw new Error(`unsupported colour type ${colorType}`)

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const pixels = unfilter(raw, width, height, channels)

  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const s = i * channels
    if (colorType === 2) {
      rgba[p] = pixels[s]; rgba[p + 1] = pixels[s + 1]; rgba[p + 2] = pixels[s + 2]; rgba[p + 3] = 255
    } else if (colorType === 6) {
      rgba[p] = pixels[s]; rgba[p + 1] = pixels[s + 1]; rgba[p + 2] = pixels[s + 2]; rgba[p + 3] = pixels[s + 3]
    } else if (colorType === 0) {
      rgba[p] = rgba[p + 1] = rgba[p + 2] = pixels[s]; rgba[p + 3] = 255
    } else if (colorType === 4) {
      rgba[p] = rgba[p + 1] = rgba[p + 2] = pixels[s]; rgba[p + 3] = pixels[s + 1]
    } else if (colorType === 3) {
      const idx = pixels[s]
      rgba[p] = palette[idx * 3]; rgba[p + 1] = palette[idx * 3 + 1]; rgba[p + 2] = palette[idx * 3 + 2]
      rgba[p + 3] = transparency && idx < transparency.length ? transparency[idx] : 255
    }
  }

  return { width, height, data: rgba }
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** Encodes RGBA bytes as a PNG (colour type 6). */
function encodePng({ width, height, data }) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Box-filter resample. Good enough for downscaling icon artwork. */
function resize(image, targetWidth, targetHeight) {
  const out = Buffer.alloc(targetWidth * targetHeight * 4)
  const xRatio = image.width / targetWidth
  const yRatio = image.height / targetHeight

  for (let y = 0; y < targetHeight; y++) {
    const y0 = Math.floor(y * yRatio)
    const y1 = Math.min(image.height, Math.ceil((y + 1) * yRatio))
    for (let x = 0; x < targetWidth; x++) {
      const x0 = Math.floor(x * xRatio)
      const x1 = Math.min(image.width, Math.ceil((x + 1) * xRatio))

      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const s = (sy * image.width + sx) * 4
          const alpha = image.data[s + 3] / 255
          // Weight colour by alpha so transparent edges do not darken the result.
          r += image.data[s] * alpha
          g += image.data[s + 1] * alpha
          b += image.data[s + 2] * alpha
          a += image.data[s + 3]
          n++
        }
      }

      const p = (y * targetWidth + x) * 4
      const alphaAvg = a / n
      const weight = alphaAvg / 255 || 1
      out[p] = Math.round(r / n / weight)
      out[p + 1] = Math.round(g / n / weight)
      out[p + 2] = Math.round(b / n / weight)
      out[p + 3] = Math.round(alphaAvg)
    }
  }

  return { width: targetWidth, height: targetHeight, data: out }
}

/**
 * Packs several PNGs into a Windows .ico.
 *
 * electron-builder derives a single 256px entry from icon.png, which Windows
 * then downscales for the 16/32px taskbar and Explorer slots — noticeably soft.
 * Supplying every size ourselves keeps small renderings crisp. Vista and later
 * accept PNG-compressed entries at any size.
 */
function encodeIco(images) {
  const encoded = images.map((img) => encodePng(img))

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)

  const directory = Buffer.alloc(16 * images.length)
  let offset = header.length + directory.length

  images.forEach((img, i) => {
    const entry = 16 * i
    // 0 means 256 in the ICO directory.
    directory[entry] = img.width >= 256 ? 0 : img.width
    directory[entry + 1] = img.height >= 256 ? 0 : img.height
    directory[entry + 2] = 0 // palette size
    directory[entry + 3] = 0 // reserved
    directory.writeUInt16LE(1, entry + 4) // colour planes
    directory.writeUInt16LE(32, entry + 6) // bits per pixel
    directory.writeUInt32LE(encoded[i].length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += encoded[i].length
  })

  return Buffer.concat([header, directory, ...encoded])
}

module.exports = { decodePng, encodePng, resize, encodeIco }
