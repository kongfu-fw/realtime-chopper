import { writable, get } from 'svelte/store'
import type { LogEntry, LogLevel, Stage } from '../types'

/**
 * Ring-buffer log store.
 *
 * Everything the user might need to diagnose a failure funnels through here:
 * model loading, VAD oddities, provider fallbacks, TTS gaps, storage quota.
 * The drawer (requirement 18) renders `entries`, and every copy button in the app
 * goes through `formatEntry` / `latestLogsText` so the text is the same wherever
 * it was copied from.
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
 * lines before a crash are still there afterwards.
 *
 * One key per tab (`rc.log.tail.v2.<tab>`), not one key for the whole origin: with
 * a single key, two tabs a user keeps open write over each other, so the tab that
 * crashes and reloads finds its own evidence already replaced by whatever the
 * *other* tab logged last — and on their next reloads both take turns inheriting
 * each other's lines.
 *
 * A tail by itself cannot say whether the page that wrote it is still around, so
 * every running page also holds a claim on its tab (`rc.log.live.v2.<tab>`),
 * refreshed every few seconds and given up on `pagehide`. A tail is adopted when
 * its tab is not claimed by a live page, which covers both ways a page disappears:
 * a polite exit releases the claim, and a kill — iOS out-of-memory, the case this
 * feature exists for — leaves a claim that simply stops being refreshed. The tab id
 * lives in `sessionStorage`, which a reload keeps and a browser restart does not,
 * and an iOS kill takes the whole browser with it; identity therefore can never be
 * the only test, or the crash whose evidence matters most would be the one that
 * cannot be recognized.
 *
 * The freshness window stays: a tail is adopted only when it is at most two
 * minutes old, because a crash reloads the page immediately and a tab opened
 * tomorrow must not inherit yesterday's log.
 */
const SLOT_PREFIX = 'rc.log.tail.v2.'
const CLAIM_PREFIX = 'rc.log.live.v2.'
/** The one-key-for-everything design this replaced; dropped on the first load. */
const LEGACY_KEY = 'rc.log.tail.v1'
const TAB_KEY = 'rc.log.tab.v1'
const PERSIST_MAX = 300
/** How old a saved tail may be and still count as "this page just died". */
const FRESH_MS = 120_000
/** How often a running page says it is still there. */
const BEAT_MS = 4_000
/**
 * Silence for this long means the page behind a claim is gone.
 *
 * The two mistakes this number trades off are not equally bad. Too long, and a
 * browser that was killed and reopened (an iOS out-of-memory kill takes the whole
 * browser with it) gives up the tail it was killed for — that is the case this
 * feature exists for. Too short, and a page that is merely hidden and idle (the
 * browser throttles hidden timers) has its lines adopted by a sibling tab, which
 * costs a few lines of somebody else's history. So: short, a few beats.
 */
const ALIVE_MS = 12_000
/** Old enough that whatever left a claim behind is a browser session that is over. */
const CLAIM_GC_MS = 10 * 60 * 1000

interface Claim {
  /** Which page load holds the tab — two pages sharing a tab id is a duplicated tab. */
  page: string
  at: number
}

/** One tab's saved tail, as it sits in storage. */
interface Tail {
  savedAt: number
  page: string
  entries: LogEntry[]
}

/** Says which page *this* load is, which is what tells a stale claim from a live one. */
const pageId = randomId()

/** Identifies this tab across reloads. Survives a reload; not a browser restart. */
let tabId = readTabId() || randomId()
storeTabId(tabId)

const claimsAtLoad = readClaims()

/**
 * A duplicated tab inherits the session storage of the tab it copied, tab id and
 * all, so both pages would write one slot — the interleaving this design exists to
 * prevent. What gives the copy away is a claim on this tab written *while this page
 * was already running*: the page it copied is alive and refreshing it. A claim left
 * behind by a page that died can never carry a later timestamp, which matters
 * because that page's tail is exactly what this page came back to read.
 *
 * This catches a tab duplicated before this page ran; the heartbeat catches one
 * duplicated after.
 */
const siblingClaim = claimsAtLoad.get(tabId)
const copiedFromLiveTab = !!siblingClaim && siblingClaim.page !== pageId && siblingClaim.at > pageStartedAt()
if (copiedFromLiveTab) {
  tabId = randomId()
  storeTabId(tabId)
}

collectStorage(Date.now())

/** Entries recovered from the previous load of this page, oldest first. */
const tail = restoreTail()
const restored = tail.entries

/** The tab a restored tail came from, or '' when it was this one. */
const restoredFromTab = tail.fromTab

/** Continue the id sequence so the drawer's expand-state keys stay unique. */
let nextId = (restored[restored.length - 1]?.id ?? 0) + 1
let ringSize = 1000
let minLevel: LogLevel = 'info'

/** What gets written back: restored entries first, then everything new. */
let persistBuffer: LogEntry[] = restored.slice()
let persistTimer: ReturnType<typeof setTimeout> | undefined

export const entries = writable<LogEntry[]>(restored)
/**
 * How many entries were recovered from the previous load of this page.
 *
 * Exposed because the crash note promises to point at where the page died, and
 * only this number says whether such a line exists. A tail can still be missing
 * without anything being wrong — the page was killed before its first write
 * reached storage, or it died long enough ago that the tail aged out — and a note
 * pointing at a line that is not there sends the user looking for evidence in the
 * wrong place.
 */
export const restoredCount = restored.length

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
    localStorage.removeItem(slotKey())
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
  // Logging is proof of life: a page busy enough to be writing a tail is a page
  // whose claim must not lapse just because its timers got throttled in the
  // background.
  writeClaim()
  try {
    const tail: Tail = { savedAt: Date.now(), page: pageId, entries: persistBuffer }
    localStorage.setItem(slotKey(), JSON.stringify(tail))
  } catch {
    /* private mode or quota: the log is simply not durable, not broken */
  }
}

/**
 * Gives up this tab's claim.
 *
 * `pagehide` is the last moment a page gets, and the difference it makes is how
 * long the *next* load has to wait: with the claim gone, a tab that closed is
 * immediately known to be gone, instead of looking like a kill until `ALIVE_MS`
 * of silence has passed.
 */
export function releaseLogClaim(): void {
  try {
    localStorage.removeItem(CLAIM_PREFIX + tabId)
  } catch {
    /* storage blocked: there was no claim to give up */
  }
}

function readTabId(): string {
  try {
    return sessionStorage.getItem(TAB_KEY) ?? ''
  } catch {
    return ''
  }
}

function storeTabId(id: string): void {
  try {
    sessionStorage.setItem(TAB_KEY, id)
  } catch {
    /* storage blocked: the id will not survive a reload, which costs one restore */
  }
}

function slotKey(): string {
  return SLOT_PREFIX + tabId
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * When this page's navigation started.
 *
 * The clock the duplicated-tab check needs: a claim written after this moment was
 * written by a page that is alive *while this one is*, and a page that died before
 * this one started cannot produce one.
 */
function pageStartedAt(): number {
  try {
    return performance.timeOrigin ?? Date.now()
  } catch {
    return Date.now()
  }
}

function storageKeys(): string[] {
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key) keys.push(key)
  }
  return keys
}

function parse<T>(raw: string | null): T | null {
  try {
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

/** Every tab a page currently claims to be using. */
function readClaims(): Map<string, Claim> {
  const claims = new Map<string, Claim>()
  try {
    for (const key of storageKeys()) {
      if (!key.startsWith(CLAIM_PREFIX)) continue
      const claim = parse<Claim>(localStorage.getItem(key))
      if (!claim || typeof claim.at !== 'number' || typeof claim.page !== 'string') continue
      claims.set(key.slice(CLAIM_PREFIX.length), claim)
    }
  } catch {
    /* storage blocked: nothing is claimed, and nothing can be read */
  }
  return claims
}

function claimIsAlive(claim: Claim | undefined): boolean {
  return !!claim && Date.now() - claim.at < ALIVE_MS
}

function writeClaim(): void {
  try {
    const claim: Claim = { page: pageId, at: Date.now() }
    localStorage.setItem(CLAIM_PREFIX + tabId, JSON.stringify(claim))
  } catch {
    /* storage blocked: a claim nobody can write is also one nobody can read */
  }
}

/**
 * Keeps this tab's claim fresh, and notices when another page is wearing this tab
 * id.
 *
 * The load-time check catches a tab duplicated before this page ran; this catches
 * one duplicated later — say the user duplicates the tab an hour into a session,
 * at which point both pages would be writing the same slot. What this sees is
 * whoever wrote the claim *last*, which is the whole point: this page claimed the
 * tab at the previous beat, so a claim carrying another page was written in
 * between by a page that is alive right now. Reading back in the same tick as
 * writing would only ever find this page's own claim. The page that notices is the
 * one that moves, and it moves only once — a page that kept renaming itself would
 * never be able to adopt what it wrote.
 */
let renamed = false
function heartbeat(): void {
  const holder = readClaims().get(tabId)
  if (!renamed && holder && holder.page !== pageId) {
    renamed = true
    tabId = randomId()
    storeTabId(tabId)
  }
  writeClaim()
}

/**
 * Drops what the log can no longer need: the single-key slot this replaced, tails
 * old enough that no reload can be their crash, and claims left behind by a
 * browser session that is over.
 *
 * Age alone decides, on purpose — a cap by count would have to pick a tab to throw
 * away, while a slot too old to adopt is a slot nobody can ever read.
 */
function collectStorage(now: number): void {
  const doomed: string[] = []
  try {
    for (const key of storageKeys()) {
      if (key === LEGACY_KEY) {
        doomed.push(key)
      } else if (key.startsWith(SLOT_PREFIX)) {
        const tail = parse<Tail>(localStorage.getItem(key))
        if (typeof tail?.savedAt !== 'number' || now - tail.savedAt >= FRESH_MS) doomed.push(key)
      } else if (key.startsWith(CLAIM_PREFIX)) {
        const claim = parse<Claim>(localStorage.getItem(key))
        if (typeof claim?.at !== 'number' || now - claim.at > CLAIM_GC_MS) doomed.push(key)
      }
    }
    for (const key of doomed) localStorage.removeItem(key)
  } catch {
    /* storage blocked: nothing to restore, nothing to clean */
  }
}

function persistEntry(entry: LogEntry): void {
  persistBuffer.push(entry)
  if (persistBuffer.length > PERSIST_MAX) persistBuffer = persistBuffer.slice(-PERSIST_MAX)
  // Debounced: a burst of VAD/worker lines must not become one storage write each.
  if (!persistTimer) persistTimer = setTimeout(flushLogs, 250)
}

/**
 * The tail this page should start from, and which tab it belonged to.
 *
 * Ours comes first and needs no liveness test: a page that died in this very tab
 * is the crash this whole feature exists for. Anything else belongs to a tab that
 * is not this one, and only a gone tab's tail is safe to adopt — a live tab keeps
 * writing to its slot, and its lines turning up in the middle of this page's list
 * is exactly what the per-tab slots were introduced to stop.
 */
function restoreTail(): { entries: LogEntry[]; fromTab: string } {
  const slots = readSlots()
  const mine = slots.find((slot) => slot.tab === tabId)
  if (mine) return { entries: mine.entries, fromTab: '' }
  const orphan = slots.find((slot) => !claimIsAlive(claimsAtLoad.get(slot.tab)))
  return orphan ? { entries: orphan.entries, fromTab: orphan.tab } : { entries: [], fromTab: '' }
}

/** Every tab's saved tail, newest first. */
function readSlots(): { tab: string; entries: LogEntry[]; savedAt: number }[] {
  const slots: { tab: string; entries: LogEntry[]; savedAt: number }[] = []
  try {
    for (const key of storageKeys()) {
      if (!key.startsWith(SLOT_PREFIX)) continue
      const tail = parse<Tail>(localStorage.getItem(key))
      if (typeof tail?.savedAt !== 'number') continue
      const entries = Array.isArray(tail.entries) ? tail.entries.filter(isLogEntry) : []
      slots.push({ tab: key.slice(SLOT_PREFIX.length), entries, savedAt: tail.savedAt })
    }
  } catch {
    /* storage blocked: nothing to restore */
  }
  return slots.sort((a, b) => b.savedAt - a.savedAt)
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

/**
 * How many entries one tap of "copy" carries.
 *
 * Fixed on purpose. The tail is what shows *where* something died — a phone that
 * kills the page leaves nothing else behind — and twenty lines hold the failure
 * plus the handful of steps that led to it, which is exactly the length somebody
 * will actually read in a chat message. Copying the whole ring is what the export
 * button is for; pasting 2000 lines is how a bug report stops being read.
 */
export const COPY_TAIL = 20

/**
 * One entry as text, in the single format every copy button in the app uses.
 *
 * Written once because there used to be four of these — the drawer's per-entry
 * copy, the export file, the crash report and the install dialog — and they
 * disagreed about timestamps, about whether the level was shown, and about how a
 * detail block was indented. Text pasted out of two different buttons should not
 * need re-reading to compare.
 */
export function formatEntry(entry: LogEntry): string {
  const detail = entry.detail ? `\n    ${entry.detail.replace(/\n/g, '\n    ')}` : ''
  return `${formatStamp(entry.ts)} [${entry.level}] [${entry.stage}] ${entry.message}${detail}`
}

/**
 * `YYYY-MM-DD HH:MM:SS` in local time.
 *
 * The date is on every line because a pasted log is read out of context — in a
 * chat, in an issue — and a bare `14:03:22` says nothing about *which day* the
 * page died. That question comes up exactly when it is hardest to answer: a phone
 * that was killed and reopened later, or a report sent the next morning.
 *
 * Local time, not UTC, everywhere: the person reading it was holding the device,
 * the browser's own clock is what the entry came from, and a header in one
 * timezone above lines in another is how a report gets misread by hours.
 */
export function formatStamp(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

export function formatEntries(list: readonly LogEntry[]): string {
  return list.map(formatEntry).join('\n')
}

/**
 * The three lines both copy and export start with.
 *
 * Shared so the two read the same way, and so that a log pasted without the lines
 * it came from still says which build wrote it and when it was taken.
 */
function logHeader(action: string, count: number): string {
  return `# realtime-chopper logs\n# ${action} ${formatStamp(Date.now())}\n# entries ${count}\n`
}

/**
 * The text behind the app's one "copy the logs" affordance.
 *
 * Reads the ring rather than the drawer's filtered view on purpose: a filter is
 * how the user looks at the log, not what a bug report should contain — copying
 * "errors only" would drop the info line that says which accelerator was in use.
 */
export function latestLogsText(count: number = COPY_TAIL): string {
  const list = get(entries).slice(-Math.max(1, count))
  return `${logHeader('copied', list.length)}${formatEntries(list)}`
}

export function exportLogs(): string {
  const list = get(entries)
  return `${logHeader('exported', list.length)}${formatEntries(list)}\n`
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
  log(
    'info',
    'session',
    restoredFromTab
      ? `页面重新加载过：已恢复上一个标签页留下的 ${restored.length} 条日志（那个标签页已经不在了）`
      : `页面重新加载过：已恢复上次的 ${restored.length} 条日志`,
  )
}

// Say "this tab is in use" for as long as it is. A page that dies leaves its claim
// to age out; a page that exits politely takes it with it (see `releaseLogClaim`),
// which is what lets the next load in this tab adopt the tail at once instead of
// waiting out the heartbeat.
if (typeof window !== 'undefined') {
  writeClaim()
  const beat = setInterval(heartbeat, BEAT_MS)
  // A dev server re-executes this module in the same page, and the old instance's
  // timer would keep running — two heartbeats claiming one tab look exactly like
  // two live tabs, down to the claim being handed to a fresh id.
  import.meta.hot?.dispose(() => {
    clearInterval(beat)
    releaseLogClaim()
  })
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
