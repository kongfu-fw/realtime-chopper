/**
 * The app's name and its mark.
 *
 * The mark is an original little reindeer **wearing headphones** — the deer it is
 * named after is somebody else's character design, so what is drawn here is our
 * own animal in this app's visual language (chunky dark outline, flat colour,
 * mustard accent), and headphones because the app is about listening. The name
 * has something to sit next to.
 *
 * The geometry lives here exactly once and is used by everything that must not
 * drift apart: the title-bar mark (`Logo.svelte`), the favicon, the web app
 * manifest, and the PNGs written by `scripts/make-icons.mjs`. `static/icon.svg`
 * is the `mustard` variant written out by hand so the page has an icon before any
 * JavaScript runs.
 *
 * All coordinates are in a 64-unit box, face-on.
 */

export const APP_NAME = '乔巴'
export const APP_DESC = '实时语音翻译：本地识别 + 多来源翻译 + 浏览器朗读'

const mirror = (x: number) => 64 - x

/** Antlers are stroked rather than filled: two thin branches per side still read at 22 px. */
const ANTLER_PATHS = [
  // Left: a beam sweeping up and out, then one prong rising from its middle.
  'M23 24.5 C23 18 19.5 11.5 12 9',
  'M20.6 16.8 C19.4 12.6 18.6 8.6 18.4 4.6',
]

/** The headphone band, drawn in two strokes (outline under fill) so it reads as an object on the head. */
const BAND = 'M15 33.5 C15 21 22 15.5 32 15.5 C42 15.5 49 21 49 33.5'

export const MARK = {
  box: 64,
  /**
   * The mark's visual centre, and the farthest point from it in box units (an
   * antler tip). `iconSvg` divides by this to keep the whole mascot inside the
   * circle a launcher mask may crop to — `scripts/make-icons.mjs` measures the
   * rendered result and says whether the estimate held.
   */
  centre: { x: 32, y: 30 },
  extent: 32,

  antler: {
    width: 4.8,
    paths: [
      ...ANTLER_PATHS,
      ...ANTLER_PATHS.map((d) =>
        d.replace(/(-?\d+(?:\.\d+)?)\s(-?\d+(?:\.\d+)?)/g, (_m, x: string, y: string) => `${mirror(Number(x))} ${y}`),
      ),
    ],
  },

  /** Both ears peek out above the ear cups, which is what makes it a deer and not a bear. */
  ears: [
    { cx: 17.5, cy: 25.5, rx: 4.6, ry: 7.4, rot: -38 },
    { cx: mirror(17.5), cy: 25.5, rx: 4.6, ry: 7.4, rot: 38 },
  ],

  /** Wide cheeks, a slightly narrower crown: a chubby face rather than an oval. */
  head: 'M32 20.5 C40.5 20.5 46 23.5 48.5 28.5 C51.5 34 52.5 40 51 45.5 C48.8 53.6 41.5 57.5 32 57.5 C22.5 57.5 15.2 53.6 13 45.5 C11.5 40 12.5 34 15.5 28.5 C18 23.5 23.5 20.5 32 20.5 Z',
  headStroke: 2.4,

  muzzle: { cx: 32, cy: 48.4, rx: 9.6, ry: 6.2, stroke: 1.6 },
  nose: { cx: 32, cy: 45.2, rx: 3.5, ry: 2.6 },
  mouth: {
    width: 1.5,
    paths: ['M32 47.8 C32 49.8 30.4 51 28.8 50.3', 'M32 47.8 C32 49.8 33.6 51 35.2 50.3'],
  },
  eyes: {
    /**
     * Big, and with a thin outline: the pale ring is the part that makes it read
     * as an eye rather than a dot, so nothing may eat into it.
     */
    sclera: 5.9,
    pupil: 2.9,
    /** Pupils sit a hair low, which is what makes a face look friendly. */
    pupilDy: 0.4,
    stroke: 1.3,
    list: [
      { cx: 25, cy: 36 },
      { cx: 39, cy: 36 },
    ],
  },

  phones: {
    band: BAND,
    outline: 8.4,
    width: 4.6,
    cups: [
      { cx: 15.8, cy: 38.5, rx: 4.9, ry: 7.6, rot: -6 },
      { cx: mirror(15.8), cy: 38.5, rx: 4.9, ry: 7.6, rot: 6 },
    ],
    cupStroke: 1.9,
  },
} as const

export type AppIconId = 'mustard' | 'paper' | 'ink' | 'blue' | 'forest' | 'amber'

export interface IconVariant {
  id: AppIconId
  label: string
  /** Icon background. */
  bg: string
  /** Outlines, pupils and nose. */
  line: string
  /** Fur: head, ears, antlers. */
  fur: string
  /** The light patch around the nose. */
  muzzle: string
  /** Ear cups and band. */
  accent: string
  /**
   * Inside the eyes. Picked per colourway to contrast with the *fur*, not the
   * background: a cream deer needs dark eyes whatever the page behind it is.
   */
  eye: string
}

/** The icon colourways offered in settings. */
export const ICON_VARIANTS: readonly IconVariant[] = [
  // First is the default: the brown deer is the one that unmistakably reads as a
  // deer, because its fur is neither the outline nor the background colour.
  { id: 'paper', label: '原色小鹿', bg: '#FDFBF4', line: '#1D2D35', fur: '#C98A4B', muzzle: '#FDFBF4', accent: '#E8B23A', eye: '#FDFBF4' },
  { id: 'mustard', label: '芥末黄', bg: '#E8B23A', line: '#1D2D35', fur: '#1D2D35', muzzle: '#E8B23A', accent: '#FDFBF4', eye: '#FDFBF4' },
  { id: 'ink', label: '墨蓝', bg: '#1D2D35', line: '#1D2D35', fur: '#FDFBF4', muzzle: '#FDFBF4', accent: '#E8B23A', eye: '#E8B23A' },
  { id: 'blue', label: '海蓝', bg: '#2A5DB0', line: '#1D2D35', fur: '#FDFBF4', muzzle: '#FDFBF4', accent: '#E8B23A', eye: '#E8B23A' },
  { id: 'forest', label: '松绿', bg: '#2F7A55', line: '#1D2D35', fur: '#FDFBF4', muzzle: '#FDFBF4', accent: '#E8B23A', eye: '#E8B23A' },
  { id: 'amber', label: '琥珀鹿', bg: '#FDFBF4', line: '#1D2D35', fur: '#E8B23A', muzzle: '#FDFBF4', accent: '#1D2D35', eye: '#FDFBF4' },
]

export const DEFAULT_APP_ICON: AppIconId = 'paper'

/** Stored settings are untyped JSON, so an unknown id falls back to the default. */
export function iconVariant(id: string): IconVariant {
  return ICON_VARIANTS.find((v) => v.id === id) ?? ICON_VARIANTS[0]
}

/**
 * How much of the canvas the mark may use.
 *
 * `205` is the radius of the 80 % circle a **maskable** icon is allowed to be
 * cropped to, so anything at or under it survives every launcher mask; the
 * plain PNGs can breathe a little more because nothing will ever crop them.
 */
const SAFE_RADIUS = 205
const ROOMY_RADIUS = 215

/** The mascot, drawn in one flat colour per part. */
function shapes(v: Pick<IconVariant, 'line' | 'fur' | 'muzzle' | 'accent' | 'eye'>): string[] {
  const out: string[] = []
  const stroke = (c: string, w: number, extra = '') =>
    `fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${extra}`

  for (const ear of MARK.ears) {
    out.push(
      `<ellipse cx="${ear.cx}" cy="${ear.cy}" rx="${ear.rx}" ry="${ear.ry}" transform="rotate(${ear.rot} ${ear.cx} ${ear.cy})" fill="${v.fur}" stroke="${v.line}" stroke-width="2"/>`,
    )
  }
  for (const d of MARK.antler.paths) {
    out.push(`<path d="${d}" ${stroke(v.line, MARK.antler.width)}/>`)
  }
  out.push(`<path d="${MARK.head}" fill="${v.fur}" stroke="${v.line}" stroke-width="${MARK.headStroke}"/>`)

  // Headphones go on over the head: outline first, fill on top.
  out.push(`<path d="${MARK.phones.band}" ${stroke(v.line, MARK.phones.outline)}/>`)
  out.push(`<path d="${MARK.phones.band}" ${stroke(v.accent, MARK.phones.width)}/>`)
  for (const cup of MARK.phones.cups) {
    out.push(
      `<ellipse cx="${cup.cx}" cy="${cup.cy}" rx="${cup.rx}" ry="${cup.ry}" transform="rotate(${cup.rot} ${cup.cx} ${cup.cy})" fill="${v.accent}" stroke="${v.line}" stroke-width="${MARK.phones.cupStroke}"/>`,
    )
  }

  const m = MARK.muzzle
  out.push(
    `<ellipse cx="${m.cx}" cy="${m.cy}" rx="${m.rx}" ry="${m.ry}" fill="${v.muzzle}" stroke="${v.line}" stroke-width="${m.stroke}"/>`,
  )
  out.push(`<ellipse cx="${MARK.nose.cx}" cy="${MARK.nose.cy}" rx="${MARK.nose.rx}" ry="${MARK.nose.ry}" fill="${v.line}"/>`)
  for (const d of MARK.mouth.paths) {
    out.push(`<path d="${d}" ${stroke(v.line, MARK.mouth.width)}/>`)
  }
  for (const eye of MARK.eyes.list) {
    out.push(`<circle cx="${eye.cx}" cy="${eye.cy}" r="${MARK.eyes.sclera}" fill="${v.eye}" stroke="${v.line}" stroke-width="${MARK.eyes.stroke}"/>`)
    out.push(`<circle cx="${eye.cx}" cy="${eye.cy + MARK.eyes.pupilDy}" r="${MARK.eyes.pupil}" fill="${v.line}"/>`)
  }
  return out
}

export interface IconOptions {
  /**
   * Radius of the safe circle the mark must fit inside, in 512ths. Lower it to
   * shrink the mascot on the canvas.
   */
  fit?: number
  /** Full-bleed square background, for platforms that apply their own mask (iOS, Android maskable). */
  bleed?: boolean
  /** Corner radius of the background when not bleeding. */
  radius?: number
}

/**
 * The icon, as SVG source.
 *
 * The default `fit` is the maskable-safe one, so a single file can be declared
 * as both `any` and `maskable` without the antlers being clipped on Android.
 */
export function iconSvg(id: string, opts: IconOptions = {}): string {
  const v = iconVariant(id)
  const { fit = SAFE_RADIUS, bleed = false, radius = 116 } = opts
  const scale = fit / MARK.extent
  const bg = bleed
    ? `<rect width="512" height="512" fill="${v.bg}"/>`
    : `<rect width="512" height="512" rx="${radius}" fill="${v.bg}"/>`
  const body = shapes(v).map((s) => `    ${s}`)
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">',
    `  ${bg}`,
    `  <g transform="translate(256 256) scale(${scale.toFixed(3)}) translate(${-MARK.centre.x} ${-MARK.centre.y})">`,
    ...body,
    '  </g>',
    '</svg>',
  ].join('\n')
}

/** `data:` URL for an icon — used for the favicon, the manifest and previews. */
export function iconDataUrl(id: string, opts: IconOptions = {}): string {
  const svg = iconSvg(id, opts)
  // btoa is fine here: the SVG is ASCII by construction.
  return `data:image/svg+xml;base64,${btoa(svg)}`
}

export { ROOMY_RADIUS, SAFE_RADIUS }
