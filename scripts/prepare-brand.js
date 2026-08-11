#!/usr/bin/env node
/**
 * Turns the supplied brand artwork into the assets the app and installers need.
 *
 *   node scripts/prepare-brand.js <icon.png> <logo.png>
 *
 * The source files are flat RGB with a light studio background. This:
 *   - crops the icon to its rounded tile and cuts genuinely transparent
 *     corners, so installers do not show a grey square behind the icon;
 *   - trims the logo's surrounding margin so it can be laid out tightly.
 *
 * Defaults to the copies kept in brand/, so it can be re-run at any time.
 */
const fs = require('fs')
const path = require('path')
const { decodePng, encodePng, resize, encodeIco } = require('./png')

const ROOT = path.resolve(__dirname, '..')
const BRAND_DIR = path.join(ROOT, 'brand')

const iconSource = process.argv[2] || path.join(BRAND_DIR, 'icon-source.png')
const logoSource = process.argv[3] || path.join(BRAND_DIR, 'logo-source.png')

const px = (img, x, y) => {
  const p = (y * img.width + x) * 4
  return [img.data[p], img.data[p + 1], img.data[p + 2], img.data[p + 3]]
}

const distance = (a, b) =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])

/** Bounding box of everything that is not the background colour. */
function contentBounds(img, background, tolerance = 30) {
  let minX = img.width
  let minY = img.height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (distance(px(img, x, y), background) > tolerance) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }

  if (maxX < 0) throw new Error('image appears to be a single flat colour')
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

function crop(img, box) {
  const out = Buffer.alloc(box.width * box.height * 4)
  for (let y = 0; y < box.height; y++) {
    const from = ((box.y + y) * img.width + box.x) * 4
    img.data.copy(out, y * box.width * 4, from, from + box.width * 4)
  }
  return { width: box.width, height: box.height, data: out }
}

/**
 * Derives alpha from how far each pixel is from the old background colour.
 *
 * This follows the artwork's real silhouette — including whatever corner radius
 * the designer used — instead of guessing the geometry and leaving a pale arc
 * wherever the guess disagrees. Safe here because nothing inside the tile is
 * anywhere near the near-white studio background.
 */
const ALPHA_FLOOR = 40 // at or below: background
const ALPHA_CEIL = 140 // at or above: solid artwork

function keyOutBackground(img, background, fillColor) {
  const out = Buffer.alloc(img.data.length)
  img.data.copy(out)

  for (let i = 0, p = 0; i < img.width * img.height; i++, p += 4) {
    const d = distance([out[p], out[p + 1], out[p + 2]], background)
    const alpha = Math.min(1, Math.max(0, (d - ALPHA_FLOOR) / (ALPHA_CEIL - ALPHA_FLOOR)))

    if (alpha <= 0) {
      out[p + 3] = 0
      continue
    }

    // Partially transparent pixels still carry blended background, which reads
    // as a pale halo once composited. Repaint them with the tile colour.
    if (alpha < 0.98) {
      out[p] = fillColor[0]
      out[p + 1] = fillColor[1]
      out[p + 2] = fillColor[2]
    }
    out[p + 3] = Math.round(alpha * 255)
  }

  return { width: img.width, height: img.height, data: out }
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
}

function writeImage(file, img) {
  ensureDir(file)
  fs.writeFileSync(file, encodePng(img))
  console.log(`  ${path.relative(ROOT, file)} — ${img.width}x${img.height}`)
}

// ---------------------------------------------------------------- icon

console.log('Icon:')
const iconRaw = decodePng(fs.readFileSync(iconSource))
const iconBg = px(iconRaw, 0, 0)
const rawBox = contentBounds(iconRaw, iconBg)

/**
 * Squared around the centre: the source is a square tile, and any difference
 * between the measured width and height is drop shadow, which must not be
 * stretched away when the icon is resized to 1024.
 */
const side = Math.min(rawBox.width, rawBox.height)
const iconBox = {
  x: rawBox.x + Math.round((rawBox.width - side) / 2),
  y: rawBox.y + Math.round((rawBox.height - side) / 2),
  width: side,
  height: side,
}

const iconCropped = crop(iconRaw, iconBox)

// Sample well inside the tile for its fill colour.
const fill = px(iconCropped, Math.floor(iconCropped.width / 2), Math.floor(iconCropped.height * 0.06))

console.log(
  `  cropped ${iconRaw.width}x${iconRaw.height} -> ${rawBox.width}x${rawBox.height} -> squared ${side}x${side}`
)
console.log(`  tile fill rgb(${fill.slice(0, 3).join(',')})`)

const masked = keyOutBackground(iconCropped, iconBg, fill)
// 1024 is the size electron-builder wants for deriving .ico/.icns cleanly.
const icon1024 = masked.width === 1024 ? masked : resize(masked, 1024, 1024)

writeImage(path.join(ROOT, 'build', 'icon.png'), icon1024)
writeImage(path.join(ROOT, 'src', 'assets', 'icon.png'), resize(masked, 256, 256))

// Every size Windows asks for, so the taskbar and Explorer stay crisp.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const icoPath = path.join(ROOT, 'build', 'icon.ico')
fs.writeFileSync(icoPath, encodeIco(ICO_SIZES.map((s) => resize(masked, s, s))))
console.log(`  ${path.relative(ROOT, icoPath)} — ${ICO_SIZES.join(', ')}`)

// ---------------------------------------------------------------- logo

console.log('Logo:')
const logoRaw = decodePng(fs.readFileSync(logoSource))
const logoBg = px(logoRaw, 0, 0)
const logoBox = contentBounds(logoRaw, logoBg, 24)

// A little breathing room so the wordmark is not flush against the edge.
const pad = Math.round(logoBox.height * 0.12)
const padded = {
  x: Math.max(0, logoBox.x - pad),
  y: Math.max(0, logoBox.y - pad),
  width: Math.min(logoRaw.width, logoBox.width + pad * 2),
  height: Math.min(logoRaw.height, logoBox.height + pad * 2),
}
padded.width = Math.min(padded.width, logoRaw.width - padded.x)
padded.height = Math.min(padded.height, logoRaw.height - padded.y)

const logoCropped = crop(logoRaw, padded)
console.log(`  cropped ${logoRaw.width}x${logoRaw.height} -> ${logoCropped.width}x${logoCropped.height}`)

const targetWidth = 960
const logoOut =
  logoCropped.width > targetWidth
    ? resize(logoCropped, targetWidth, Math.round((logoCropped.height / logoCropped.width) * targetWidth))
    : logoCropped

writeImage(path.join(ROOT, 'src', 'assets', 'logo.png'), logoOut)

console.log('\nDone. Re-run after replacing anything in brand/.')
