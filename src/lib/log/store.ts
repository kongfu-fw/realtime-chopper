import { writable, get } from 'svelte/store'
import type { LogEntry, LogLevel, Stage } from '../types'

/**
 * Ring-buffer log store.
 *
 * Everything the user might need to diagnose a failure funnels through here:
 * model loading, VAD oddities, provider fallbacks, TTS gaps, storage quota.
 * The drawer (requirement 18) renders `entries` and offers per-entry copy.
 */

const RING_MIN = 100
const RING_MAX = 5000

/**
 * The tail of the log, kept in `localStorage` so it survives a reload.
 *
 * This exists because of the phone: iOS kills a web page under memory pressure
 * and reloads it, and an in-memory-only log means the crash takes its own
 * evidence with it — the user reopens the drawer and sees an empty list, or a
 * single harmless line, and there is nothing left to report.
 *
 * It started out in `sessionStorage`, which is the tidier scope, but that is
 * exactly the storage a *killed* renderer is least likely to leave behind: it
 * lives with the page that died. `localStorage` outlives the process, so the last
 * lines before a crash are still there afterwards. The two guards that keep that
 * from turning into noise: the tail is only adopted when it is at most two
 * minutes old (a crash reloads the page immediately; a new tab opened tomorrow
 * must not inherit yesterday's log), and only for the tab that wrote it — see
 * `tabId`. A tab that never got to write gives no id, and that is the crash case,
 * so it is adopted too.
 */
const RESTORE_KEY = 'rc.log.tail.v1'
const TAB_KEY = 'rc.log.tab.v1'
const PERSIST_MAX = 300
/** How old a saved tail may be and still count as "this page just died". */
const FRESH_MS = 120_000

/** Identifies this tab across reloads. Survives a reload; not a crash. */
const tabId = readTabId()

/** Entries recovered from the previous load of this tab, oldest first. */
const restored = restoreTail()

/** Continue the id sequence so the drawer's expand-state keys stay unique. */
let nextId = (restored[restored.length - 1]?.id ?? 0) + 1
let ringSize = 1000
let minLevel: LogLevel = 'info'

/** What gets written back: restored entries first, then everything new. */
let persistBuffer: LogEntry[] = restored.slice()
let persistTimer: ReturnType<typeof setTimeout> | undefined

export const entries = writable<LogEntry[]>(restored)
/**
 * Bumped whenever an entry is added so the drawer can show an unread dot.
 *
 * Restored entries count as unread on purpose: after a reload that evidence is
 * the whole point, and a dot is what tells the user it is there.
 */
export const unreadCount = writable(restored.length)

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export function configureLogging(ring: number, level: LogLevel): void {
  ringSize = Math.min(RING_MAX, Math.max(RING_MIN, Math.floor(ring)))
  minLevel = level
  const current = get(entries)
  if (current.length > ringSize) entries.set(current.slice(-ringSize))
}

function trim(list: LogEntry[]): LogEntry[] {
  return list.length > ringSize ? list.slice(list.length - ringSize) : list
}

export function log(
  level: LogLevel,
  stage: Stage,
  message: string,
  detail?: unknown,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return
  const entry: LogEntry = {
    id: nextId++,
    ts: Date.now(),
    level,
    stage,
    message: redact(message),
    detail: detail === undefined ? undefined : redact(stringifyDetail(detail)),
  }
  entries.update((list) => trim([...list, entry]))
  unreadCount.update((n) => n + 1)
  persistEntry(entry)
  // Mirror to the devtools console so a stuck session can be debugged without
  // the app's own drawer.
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  sink(`[${stage}] ${entry.message}`, detail ?? '')
}

export const debug = (stage: Stage, msg: string, detail?: unknown) => log('debug', stage, msg, detail)
export const info = (stage: Stage, msg: string, detail?: unknown) => log('info', stage, msg, detail)
export const warn = (stage: Stage, msg: string, detail?: unknown) => log('warn', stage, msg, detail)
export const error = (stage: Stage, msg: string, detail?: unknown) => log('error', stage, msg, detail)

export function markRead(): void {
  unreadCount.set(0)
}

export function clearLogs(): void {
  entries.set([])
  persistBuffer = []
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = undefined
  }
  try {
    localStorage.removeItem(RESTORE_KEY)
    sessionStorage.removeItem(RESTORE_KEY)
  } catch {
    /* storage blocked — nothing was persisted either */
  }
  markRead()
}

/**
 * Writes the tail out now instead of on the debounce.
 *
 * Called on `pagehide`, because that is the last moment a page gets: after it,
 * whatever was only in memory is gone — which is exactly how the evidence of an
 * iOS reload used to disappear.
 */
export function flushLogs(): void {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = undefined
  }
  try {
    localStorage.setItem(RESTORE_KEY, JSON.stringify({ savedAt: Date.now(), tab: tabId, entries: persistBuffer }))
  } catch {
    /* private mode or quota: the log is simply not durable, not broken */
  }
}

function readTabId(): string {
  try {
    const existing = sessionStorage.getItem(TAB_KEY)
    if (existing) return existing
    const fresh = Math.random().toString(36).slice(2, 10)
    sessionStorage.setItem(TAB_KEY, fresh)
    return fresh
  } catch {
    return ''
  }
}

function persistEntry(entry: LogEntry): void {
  persistBuffer.push(entry)
  if (persistBuffer.length > PERSIST_MAX) persistBuffer = persistBuffer.slice(-PERSIST_MAX)
  // Debounced: a burst of VAD/worker lines must not become one storage write each.
  if (!persistTimer) persistTimer = setTimeout(flushLogs, 250)
}

function restoreTail(): LogEntry[] {
  try {
    const raw = localStorage.getItem(RESTORE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as { savedAt?: number; tab?: string; entries?: unknown } | null
    const entries = Array.isArray(parsed?.entries) ? parsed.entries.filter(isLogEntry) : []
    const fresh = typeof parsed?.savedAt === 'number' && Date.now() - parsed.savedAt < FRESH_MS
    // A different, still-open tab owns this tail; adopting it would interleave two
    // sessions' lines into one list.
    const ours = !parsed?.tab || !tabId || parsed.tab === tabId
    if (!fresh || !ours) {
      if (!fresh) localStorage.removeItem(RESTORE_KEY)
      return []
    }
    return entries.slice(-PERSIST_MAX)
  } catch {
    return []
  }
}

/** Rejects anything that is not a log entry, so a corrupt entry cannot reach the UI. */
function isLogEntry(value: unknown): value is LogEntry {
  const e = value as Partial<LogEntry> | null
  return (
    !!e &&
    typeof e.id === 'number' &&
    typeof e.ts === 'number' &&
    typeof e.message === 'string' &&
    typeof e.stage === 'string' &&
    typeof e.level === 'string'
  )
}

export function exportLogs(): string {
  const list = get(entries)
  const header = `# realtime-chopper logs\n# exported ${new Date().toISOString()}\n# entries ${list.length}\n`
  const body = list
    .map((e) => {
      const time = new Date(e.ts).toISOString()
      const detail = e.detail ? `\n    ${e.detail.replace(/\n/g, '\n    ')}` : ''
      return `${time} [${e.level}] [${e.stage}] ${e.message}${detail}`
    })
    .join('\n')
  return header + body + '\n'
}

function stringifyDetail(detail: unknown): string {
  if (typeof detail === 'string') return detail
  if (detail instanceof Error) return `${detail.name}: ${detail.message}`
  try {
    return JSON.stringify(detail, null, 2)
  } catch {
    return String(detail)
  }
}

// Says out loud that this page is not the same page as before. Without it a
// restored drawer looks like "logs from nowhere", and the single most common
// phone failure — the tab being reloaded — is invisible.
if (restored.length) {
  log('info', 'session', `页面重新加载过：已恢复上次的 ${restored.length} 条日志`)
}

/**
 * API keys must never reach the log drawer or an exported file: the drawer has
 * a copy button and an export button, so a leaked key would be one click from
 * leaving the device.
 */
function redact(text: string): string {
  return text
    .replace(/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, '$1…')
    .replace(/(AIza[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g, '$1…')
    .replace(/("?(?:api[_-]?key|authorization|x-api-key|apiKey)"?\s*[:=]\s*")([^"]{4})[^"]*"/gi, '$1$2…"')
}
