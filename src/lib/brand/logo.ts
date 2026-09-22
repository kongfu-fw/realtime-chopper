/**
 * The app's name, the mark it draws for itself, and the icons it can wear.
 *
 * The **icons** are the app's faces. Three of them are artwork the project owner
 * supplied (`static/chopper-hat*.svg|jpg`, the character the app is named after);
 * the fourth is a little reindeer this app draws for itself — chunky dark
 * outline, flat colour, mustard accent, in a 64-unit box, face-on (`MARK`
 * below). All four are rendered into the same set of square bitmaps by
 * `scripts/make-icons.mjs`; see `ICON_BITMAPS` and `iconAsset` for where those
 * files go.
 *
 * The chosen icon is what the header shows (`components/Logo.svelte`), what the
 * easter egg shows, and what the browser installs.
 *
 * This module is the single source of truth for both, and it is the only thing
 * that knows the file *names*, so the renderer and the running page can never
 * disagree about where an icon lives. Everything is ASCII by construction, so
 * `btoa` can turn an SVG into a data URL.
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

/**
 * The box the ink of the drawn deer actually occupies, in the same 64-unit grid:
 * `markSvg` crops to it, so the animal fills whatever space it is given instead
 * of floating in the grid's margins.
 */
export const MARK_BOX = { x: 8, y: 0.8, w: 48, h: 58.4 }

/** The colourway the drawn deer is rendered in. (The title-bar copy uses theme colours instead.) */
export const DEER = {
  /** Icon background. */
  bg: '#FDFBF4',
  /** Outlines, pupils and nose. */
  line: '#1D2D35',
  /** Fur: head, ears, antlers. */
  fur: '#C98A4B',
  /** The light patch around the nose. */
  muzzle: '#FDFBF4',
  /** Ear cups and band. */
  accent: '#E8B23A',
  /** Inside the eyes: chosen to contrast with the fur, not the background. */
  eye: '#FDFBF4',
} as const

/** The mascot, drawn in one flat colour per part. */
function shapes(): string[] {
  const out: string[] = []
  const stroke = (c: string, w: number, extra = '') =>
    `fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${extra}`

  for (const ear of MARK.ears) {
    out.push(
      `<ellipse cx="${ear.cx}" cy="${ear.cy}" rx="${ear.rx}" ry="${ear.ry}" transform="rotate(${ear.rot} ${ear.cx} ${ear.cy})" fill="${DEER.fur}" stroke="${DEER.line}" stroke-width="2"/>`,
    )
  }
  for (const d of MARK.antler.paths) {
    out.push(`<path d="${d}" ${stroke(DEER.line, MARK.antler.width)}/>`)
  }
  out.push(`<path d="${MARK.head}" fill="${DEER.fur}" stroke="${DEER.line}" stroke-width="${MARK.headStroke}"/>`)

  // Headphones go on over the head: outline first, fill on top.
  out.push(`<path d="${MARK.phones.band}" ${stroke(DEER.line, MARK.phones.outline)}/>`)
  out.push(`<path d="${MARK.phones.band}" ${stroke(DEER.accent, MARK.phones.width)}/>`)
  for (const cup of MARK.phones.cups) {
    out.push(
      `<ellipse cx="${cup.cx}" cy="${cup.cy}" rx="${cup.rx}" ry="${cup.ry}" transform="rotate(${cup.rot} ${cup.cx} ${cup.cy})" fill="${DEER.accent}" stroke="${DEER.line}" stroke-width="${MARK.phones.cupStroke}"/>`,
    )
  }

  const m = MARK.muzzle
  out.push(
    `<ellipse cx="${m.cx}" cy="${m.cy}" rx="${m.rx}" ry="${m.ry}" fill="${DEER.muzzle}" stroke="${DEER.line}" stroke-width="${m.stroke}"/>`,
  )
  out.push(`<ellipse cx="${MARK.nose.cx}" cy="${MARK.nose.cy}" rx="${MARK.nose.rx}" ry="${MARK.nose.ry}" fill="${DEER.line}"/>`)
  for (const d of MARK.mouth.paths) {
    out.push(`<path d="${d}" ${stroke(DEER.line, MARK.mouth.width)}/>`)
  }
  for (const eye of MARK.eyes.list) {
    out.push(`<circle cx="${eye.cx}" cy="${eye.cy}" r="${MARK.eyes.sclera}" fill="${DEER.eye}" stroke="${DEER.line}" stroke-width="${MARK.eyes.stroke}"/>`)
    out.push(`<circle cx="${eye.cx}" cy="${eye.cy + MARK.eyes.pupilDy}" r="${MARK.eyes.pupil}" fill="${DEER.line}"/>`)
  }
  return out
}

/**
 * The deer on its own — no background, no padding — cropped to `MARK_BOX`.
 *
 * The icon renderer fits this into an icon exactly the way it fits a supplied
 * image, so the drawn icon and the supplied ones come out of the same pipeline.
 */
export function markSvg(): string {
  const { x, y, w, h } = MARK_BOX
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}">`,
    ...shapes().map((s) => `  ${s}`),
    '</svg>',
  ].join('\n')
}

/** `data:` URL for the drawn deer — used where a page needs an image and no file, e.g. a favicon. */
export function markDataUrl(): string {
  // btoa is fine here: the SVG is ASCII by construction.
  return `data:image/svg+xml;base64,${btoa(markSvg())}`
}

/** Cream, the app's own page colour: what the artwork sits on inside an icon. */
const CREAM = '#FDFBF4'

export type AppIconId = 'hat-antlers' | 'hat' | 'headphones' | 'deer'

export interface AppIcon {
  id: AppIconId
  label: string
  /** Painted behind the artwork; on the copies a launcher may crop, it bleeds to the file's edges. */
  bg: string
  /** The artwork in `static/`. Absent for the drawn deer, which comes from `MARK`. */
  file?: string
  mime?: string
  /** Cut the artwork's own frame off before fitting it (the JPEG ships a white border). */
  trim?: boolean
}

/**
 * The icons offered in settings. The first one is the default.
 *
 * `hat-antlers`, `hat` and `headphones` are artwork supplied by the project
 * owner; `deer` is the animal this app draws for itself, and it stays in the
 * list because that is the mark in the title bar.
 */
export const APP_ICONS: readonly AppIcon[] = [
  { id: 'hat-antlers', label: '乔巴的帽子', file: 'chopper-hat-full.svg', mime: 'image/svg+xml', bg: CREAM },
  { id: 'hat', label: '只有帽子', file: 'chopper-hat.svg', mime: 'image/svg+xml', bg: CREAM },
  { id: 'headphones', label: '戴耳机', file: 'chopper-hat-earphone.jpg', mime: 'image/jpeg', bg: '#FFFFFF', trim: true },
  { id: 'deer', label: '小鹿', bg: CREAM },
]

export const DEFAULT_APP_ICON: AppIconId = 'hat-antlers'

/** Stored settings are untyped JSON, so an unknown id falls back to the default. */
export function iconFor(id: string): AppIcon {
  return APP_ICONS.find((icon) => icon.id === id) ?? APP_ICONS[0]
}

/** What a page can point an `<img>`, a favicon or the easter egg at. */
export function iconPreviewUrl(id: string): string {
  const icon = iconFor(id)
  return icon.file ? `./${icon.file}` : markDataUrl()
}

/**
 * Where the rendered square bitmaps live, per icon and per size.
 *
 * The default keeps the historical root names (`icon-192.png`,
 * `apple-touch-icon.png`, …) because `index.html` and the static manifest point
 * at them before any JavaScript runs; every other icon gets its own file under
 * `icons/`. The names are computed here rather than in the renderer so the two
 * can never drift apart.
 */
const ROOT_FILES = {
  180: 'apple-touch-icon.png',
  192: 'icon-192.png',
  512: 'icon-512.png',
  'maskable-512': 'icon-maskable-512.png',
} as const

/** 180 is iOS's home-screen size; 512 doubles as the maskable one; see `scripts/make-icons.mjs`. */
export const ICON_BITMAPS = [180, 192, 512, 'maskable-512'] as const
export type IconBitmap = (typeof ICON_BITMAPS)[number]

export function iconAsset(id: string, size: IconBitmap): string {
  const icon = iconFor(id)
  return icon.id === DEFAULT_APP_ICON ? `./${ROOT_FILES[size]}` : `./icons/${icon.id}-${size}.png`
}
