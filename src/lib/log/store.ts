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

export const entries = writable<LogEntry[]>([])
/** Bumped whenever an entry is added so the drawer can show an unread dot. */
export const unreadCount = writable(0)

let nextId = 1
let ringSize = 1000
let minLevel: LogLevel = 'info'

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
  markRead()
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
