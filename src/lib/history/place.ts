/**
 * Where a recording was made, and what its note is called.
 *
 * The title of a note is composed rather than typed: when a lesson was recorded
 * and where is the part a user cannot be asked to write down every time, and it
 * is exactly the part that makes a list of notes readable a month later. So the
 * title is `日期 时间 · 定位`, and the three of them are *fields* — renaming a
 * note replaces the title and leaves the date and the place standing, which is
 * why `HistoryMeta` keeps them apart.
 *
 * ## Three ways to answer "where", in order
 *
 * 1. **The browser's position**, reverse-geocoded into a city name. The accurate
 *    answer, and the one the user asked for, but it needs a permission the user
 *    may refuse, a fix that may not arrive indoors, and a network call that may
 *    fail.
 * 2. **The last fix**, from `localStorage`, up to half an hour old. A classroom
 *    is one place for an hour, and the alternative to this is asking the
 *    satellite again for every note saved in the same building.
 * 3. **The timezone**, which needs nothing at all: `Asia/Shanghai` becomes
 *    `Shanghai`. Never right to the kilometre and never wrong about the city,
 *    which is the resolution a title needs.
 *
 * Failing all three is not a failure: a title without a place is a title with one
 * field less, and the date and time were never in doubt.
 */

import { currentLang, t } from '../i18n/index.ts'
import { info } from '../log/store'

/** Where the last fix is kept; one per device, not per note. */
const CACHE_KEY = 'rc.place.v1'
/**
 * How long a stored fix is trusted.
 *
 * Half an hour, because that is the length of the thing this is for: a lesson is
 * recorded in one room, and re-asking for a position for each of its notes would
 * spend a permission prompt and a network call on an answer already known.
 */
const FRESH_MS = 30 * 60 * 1000
/** A fix nobody can give quickly is a fix the note cannot wait for. */
const FIX_TIMEOUT_MS = 6000
/** The name lookup is the last step, and the title is being read while it runs. */
const LOOKUP_TIMEOUT_MS = 5000

export interface Place {
  /** The city name, coordinates, or `''` when nothing is known. */
  label: string
  lat?: number
  lon?: number
  /**
   * Which of the three answered. Kept for the log rather than the interface: a
   * title that says 上海 with no coordinates and one that says 上海 with them
   * look the same on screen and are not the same fact.
   */
  source: 'gps' | 'cache' | 'timezone' | 'none'
}

interface Fix {
  lat: number
  lon: number
  label: string
  at: number
}

function readCache(): Fix | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Fix
    if (typeof parsed?.lat !== 'number' || typeof parsed?.lon !== 'number') return null
    if (typeof parsed?.at !== 'number' || Date.now() - parsed.at > FRESH_MS) return null
    return parsed
  } catch {
    return null
  }
}

function writeCache(fix: Fix): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(fix))
  } catch {
    /* private mode: the fix simply is not remembered */
  }
}

/**
 * The city the device's clock is set to.
 *
 * `Asia/Shanghai` → `Shanghai`: the tail of the zone is the city, and it is
 * spelled with underscores only where a name has spaces. `UTC` and the like have
 * no tail worth showing, so a zone that is only one segment is left out
 * entirely — a note titled 「北京时间」 would be a worse lie than a note with no
 * place at all.
 */
export function placeFromTimezone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
    const parts = zone.split('/')
    if (parts.length < 2) return ''
    return parts[parts.length - 1].replace(/_/g, ' ')
  } catch {
    return ''
  }
}

/** One `getCurrentPosition`, as a promise that always settles. */
function currentFix(): Promise<{ lat: number; lon: number } | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null)
      return
    }
    let settled = false
    const done = (value: { lat: number; lon: number } | null) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    // Belt and braces: `timeout` is the position's own timeout, and it is not
    // honoured on every platform (a page that is not allowed to ask never gets a
    // callback at all).
    setTimeout(() => done(null), FIX_TIMEOUT_MS + 500)
    navigator.geolocation.getCurrentPosition(
      (position) =>
        done({ lat: position.coords.latitude, lon: position.coords.longitude }),
      () => done(null),
      { enableHighAccuracy: false, timeout: FIX_TIMEOUT_MS, maximumAge: 5 * 60 * 1000 },
    )
  })
}

/**
 * A coordinate, as a name.
 *
 * Two providers, tried in order, and neither is ours: a static app with no
 * backend has to borrow somebody's gazetteer. BigDataCloud answers without a key
 * and names the city; Nominatim (OpenStreetMap) is the fallback, and both are
 * asked in the interface language so a Chinese note is titled in Chinese. When
 * both fail the coordinates themselves are used — `31.23, 121.47` is a worse
 * title and a better answer than nothing.
 */
async function reverseLabel(lat: number, lon: number): Promise<string | null> {
  const lang = currentLang()
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=${lang}`
    const response = await fetch(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) })
    if (response.ok) {
      const data = (await response.json()) as Record<string, unknown>
      const name = pick(data.city) ?? pick(data.locality) ?? pick(data.principalSubdivision)
      if (name) return name
    }
  } catch {
    /* offline, blocked, or slow: the next provider gets its turn */
  }
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=${lat}&lon=${lon}`
    const response = await fetch(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) })
    if (response.ok) {
      const data = (await response.json()) as { address?: Record<string, unknown> }
      const address = data.address ?? {}
      const name = pick(address.city) ?? pick(address.town) ?? pick(address.county) ?? pick(address.state)
      if (name) return name
    }
  } catch {
    /* both providers are out; the coordinates below still say where */
  }
  return null
}

function pick(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** The place the last fix named, without asking for a new one. */
export function placeNow(): Place {
  const fix = readCache()
  if (fix?.label) return { label: fix.label, lat: fix.lat, lon: fix.lon, source: 'cache' }
  const zone = placeFromTimezone()
  return zone ? { label: zone, source: 'timezone' } : { label: '', source: 'none' }
}

/**
 * The place a note is being saved at, asking the browser when it has to.
 *
 * Called when a note is titled, never at startup: a permission prompt belongs at
 * the moment the user is doing the thing that needs it, and an app that asks for
 * the location on every launch is an app people refuse out of habit.
 */
export async function currentPlace(): Promise<Place> {
  const fix = await currentFix()
  if (!fix) {
    const fallback = placeNow()
    info('ui', t('记录定位：{place}', { place: fallback.label || t('未知') }), {
      [t('来源')]: fallback.source,
    })
    return fallback
  }
  const label = (await reverseLabel(fix.lat, fix.lon)) ?? `${fix.lat.toFixed(2)}, ${fix.lon.toFixed(2)}`
  writeCache({ lat: fix.lat, lon: fix.lon, label, at: Date.now() })
  info('ui', t('记录定位：{place}', { place: label }), { [t('来源')]: 'gps' })
  return { label, lat: fix.lat, lon: fix.lon, source: 'gps' }
}

/**
 * When a recording happened, in the interface language.
 *
 * Formatted now and stored as text: the title is a *name*, not a rendering of a
 * timestamp, and a note renamed by a user is already immutable text beside it. A
 * second formatting at render time would mean the list changed language under a
 * title that did not.
 */
export function whenText(at: number, lang = currentLang()): string {
  try {
    return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : lang, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(at))
  } catch {
    return new Date(at).toISOString().slice(5, 16).replace('T', ' ')
  }
}

/** `日期 时间 · 定位`, with the place left off when there is none. */
export function autoTitle(at: number, place: string, lang = currentLang()): string {
  const when = whenText(at, lang)
  return place ? `${when} · ${place}` : when
}
