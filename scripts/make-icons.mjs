#!/usr/bin/env node
/**
 * Render every app icon into the square bitmaps the browsers ask for.
 *
 *   node scripts/make-icons.mjs           # write static/*.png|svg + static/icons/, then report
 *   node scripts/make-icons.mjs --check   # report only, write nothing
 *
 * The list of icons, where their artwork lives and where the output goes all
 * come from `src/lib/brand/logo.ts` — this script only decides *how* they are
 * drawn. Node 24 strips the TypeScript types on import, and `sharp` (already in
 * the tree, used by nothing at runtime) does the rasterising.
 *
 * Why bitmaps at all: Android's install prompt wants a square PNG, and iOS
 * `apple-touch-icon` has never supported SVG — without it an iPhone screenshots
 * the page for the home-screen icon. Two of the four sizes are for platforms
 * that crop the icon themselves (iOS always, Android when the icon is declared
 * `maskable`), so those two are bled to the edges and sized to survive the crop.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import sharp from 'sharp'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const check = process.argv.includes('--check')

const { APP_ICONS, DEFAULT_APP_ICON, ICON_BITMAPS, iconAsset, markSvg } = await import(
  pathToFileURL(path.join(root, 'src/lib/brand/logo.ts')).href
)

/** A launcher may crop a maskable icon to a circle 80 % of the square: radius 205 of 512. */
const SAFE = 205 / 512

/** How much of a plain, never-cropped bitmap the artwork may fill. */
const ROOMY = 0.88

/** Corner radius of the plain bitmaps, in 512ths (the shell's own radius). */
const RADIUS = 116

const BITMAP_SIZE = { 180: 180, 192: 192, 512: 512, 'maskable-512': 512 }

/** The two sizes whose background bleeds to the edge, because the platform masks them. */
const CROPPED = new Set(['180', 'maskable-512'])

const outPath = (file) => path.join(root, 'static', file.replace(/^\.\//, ''))

/** The artwork alone, as PNG pixels, with any frame of its own cut off. */
async function artPng(icon) {
  const src = icon.file ? path.join(root, 'static', icon.file) : Buffer.from(markSvg())
  let img = sharp(src).ensureAlpha()
  // 10, not 0: the supplied JPEG has its frame compressed, so a pixel-perfect
  // match finds nothing and the artwork stays small inside the icon.
  if (icon.trim) img = sharp(await img.trim({ threshold: 10 }).png().toBuffer()).ensureAlpha()
  return img.png().toBuffer()
}

/** The artwork scaled to fit inside an `inner`-wide box, centred on the icon's background. */
async function bitmap(icon, size, inner, rounded) {
  const bg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<rect width="${size}" height="${size}"${rounded ? ` rx="${Math.round((size * RADIUS) / 512)}"` : ''} fill="${icon.bg}"/>` +
      '</svg>',
  )
  const art = await sharp(await artPng(icon))
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
  return sharp(bg).composite([{ input: art, gravity: 'center' }]).png({ compressionLevel: 9 }).toBuffer()
}

/**
 * Where the ink of an icon ends up, and how much of it strays outside the shape
 * that will actually be shown.
 *
 * "Ink" is anything that differs from the icon's own background: transparent
 * pixels are skipped (they are the rounded corners, not the artwork), and so is
 * artwork whose colour happens to match the background, because that is exactly
 * what the eye sees too.
 *
 * `radius` is the corner radius of the shown shape, in pixels. It is 0 for the
 * copies a platform masks itself — there the whole square is the shape — and the
 * shell's own radius for the plain bitmaps, whose corners are simply not there.
 */
async function inkStats(png, bg, radius) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const [br, bgc, bb] = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16))
  const half = info.width / 2
  const flat = Math.max(0, half - radius)
  const inside = (dx, dy) =>
    Math.abs(dx) <= flat || Math.abs(dy) <= flat || Math.hypot(Math.abs(dx) - flat, Math.abs(dy) - flat) <= radius
  let reach = 0
  let outside = 0
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const o = (y * info.width + x) * info.channels
      if (data[o + 3] < 200) continue
      if (Math.hypot(data[o] - br, data[o + 1] - bgc, data[o + 2] - bb) <= 30) continue
      const dx = x + 0.5 - half
      const dy = y + 0.5 - half
      reach = Math.max(reach, Math.hypot(dx, dy))
      if (!inside(dx, dy)) outside++
    }
  }
  return { reach, outside }
}

/**
 * The biggest the artwork may be and still survive a circular crop.
 *
 * Measured rather than computed from the artwork's bounding box: what matters is
 * where the *ink* ends up, and for a wide subject like a hat the two differ by
 * enough to matter (a box-corner rule would shrink it for corners that are empty).
 */
async function fitToCircle(icon, size) {
  const limit = size * SAFE
  let inner = Math.round(size * ROOMY)
  for (let attempt = 0; attempt < 6; attempt++) {
    const png = await bitmap(icon, size, inner, false)
    const { reach } = await inkStats(png, icon.bg, 0)
    if (reach <= limit) return { png, inner, reach, limit, outside: 0 }
    inner = Math.max(16, Math.floor((inner * limit) / reach))
  }
  const png = await bitmap(icon, size, inner, false)
  return { png, inner, limit, ...(await inkStats(png, icon.bg, 0)) }
}

/** A bitmap nothing will crop: the artwork may fill most of it, with the shell's rounded corners. */
async function plainBitmap(icon, size) {
  const inner = Math.round(size * ROOMY)
  const png = await bitmap(icon, size, inner, true)
  return { png, inner, limit: size / 2, ...(await inkStats(png, icon.bg, (size * RADIUS) / 512)) }
}

/**
 * The default icon as one scalable file, for `index.html` and the static
 * manifest: a rounded background with the supplied SVG nested inside it, fitted
 * the same way the bitmaps are. The artwork is inlined because an SVG file
 * cannot reference the contents of another one.
 */
async function compositeSvg(icon, size = 512, radius = RADIUS, inner = Math.round(size * ROOMY)) {
  const source = await readFile(path.join(root, 'static', icon.file), 'utf8')
  const viewBox = source.match(/viewBox="([^"]+)"/)?.[1]
  if (!viewBox) throw new Error(`${icon.file}: no viewBox to nest`)
  const content = source
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .trim()
  const offset = (size - inner) / 2
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">',
    `  <rect width="${size}" height="${size}" rx="${radius}" fill="${icon.bg}"/>`,
    `  <svg x="${offset}" y="${offset}" width="${inner}" height="${inner}" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet">`,
    ...content.split('\n').map((line) => `    ${line}`),
    '  </svg>',
    '</svg>',
  ].join('\n')
}

const ascii = (data, info) => {
  const ramp = ' .:-=+*#%@'
  const lines = []
  for (let y = 0; y < info.height; y++) {
    let line = ''
    for (let x = 0; x < info.width; x++) {
      const l = data[y * info.width + x]
      line += ramp[Math.min(ramp.length - 1, Math.floor(((255 - l) / 256) * ramp.length))]
    }
    lines.push(line)
  }
  return lines.join('\n')
}

const report = []
const kb = (n) => `${(n / 1024).toFixed(1)} KB`.padStart(8)

for (const icon of APP_ICONS) {
  report.push(`${icon.id}${icon.id === DEFAULT_APP_ICON ? '  (default)' : ''}   ${icon.file ?? '“小鹿”，由 logo.ts 的几何渲染'}`)
  for (const key of ICON_BITMAPS) {
    const size = BITMAP_SIZE[key]
    const cropped = CROPPED.has(String(key))
    const { png, inner, reach, limit, outside } = cropped
      ? await fitToCircle(icon, size)
      : await plainBitmap(icon, size)

    // iOS and the maskable copy get the whole square; the plain ones keep the
    // shell's rounded corners and let the platform sit them on their own shape.
    const fit = cropped
      ? `${reach <= limit ? '✅' : '❌'} 在裁切圆 ${Math.round(limit)} 内`
      : `${outside === 0 ? '✅' : `❌ 越界 ${outside} px`} 在圆角内`
    report.push(
      `  ${iconAsset(icon.id, key).replace('./', '').padEnd(30)}${kb(png.length)}  ${size}×${size}  图形 ${String(inner).padStart(3)} px  最远点 ${String(Math.round(reach)).padStart(3)}  ${fit}`,
    )
    if (!check) {
      await mkdir(path.dirname(outPath(iconAsset(icon.id, key))), { recursive: true })
      await writeFile(outPath(iconAsset(icon.id, key)), png)
    }
    if (key === 192) {
      const { data, info } = await sharp(png)
        .flatten({ background: icon.bg })
        .resize(40, 40, { fit: 'fill' })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true })
      report.push(
        ascii(data, info)
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n'),
      )
    }
  }
}

// The scalable copy of the default: the page shows this before any JavaScript
// runs, and it is what the static manifest offers for `any` size. Checked by
// rendering it and comparing where the ink lands against the 512 bitmap.
const dflt = APP_ICONS.find((icon) => icon.id === DEFAULT_APP_ICON)
if (dflt.file?.endsWith('.svg')) {
  const svg = `<!--
  乔巴 — 应用图标（默认那一款）。由 scripts/make-icons.mjs 渲染，请勿手改：
  改 src/lib/brand/logo.ts 里的图标列表与 static/ 里的原图。

  这是任何 JavaScript 跑起来之前页面就有的图标，也是静态 manifest
  里 any 尺寸那一项。
-->
${await compositeSvg(dflt)}
`
  const png512 = await bitmap(dflt, 512, Math.round(512 * ROOMY), true)
  const svgReach = (await inkStats(await sharp(Buffer.from(svg)).png().toBuffer(), dflt.bg, 0)).reach
  const pngReach = (await inkStats(png512, dflt.bg, 0)).reach
  const agrees = Math.abs(svgReach - pngReach) <= 2
  report.push(
    `\nicon.svg（默认图标的矢量版）${kb(Buffer.byteLength(svg))}  512×512  最远点 ${Math.round(svgReach)} / 同尺寸 PNG ${Math.round(pngReach)}  ${agrees ? '✅ 与 PNG 一致' : '❌ 与 PNG 不一致'}`,
  )
  if (!check) await writeFile(outPath('icon.svg'), svg)
}

console.log(report.join('\n'))
if (check) console.log('\n(--check: 未写入任何文件)')
