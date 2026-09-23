/**
 * Forensics for the one failure that leaves nothing behind.
 *
 * When a phone runs out of memory, WebKit does not throw, log or reject — it
 * kills the page and reloads it. The user sees the screen flash and, on the
 * phone, that is the *entire* error report: no message, no code, and the log
 * drawer comes back empty because the evidence died with the process.
 *
 * So the evidence is written down *before* the dangerous thing happens, in
 * `localStorage` (which outlives the renderer) rather than in memory: "I am about
 * to start the recognition engine for module X". A boot that finishes — with
 * success or with a real error we can show — clears that note. A boot that dies
 * leaves it there, and the next load reads it as a crash report.
 *
 * The note records *how* the engine was started, not only which one: a report
 * from an iPhone showed the page dying 2.7 seconds after asking for WebGPU, twice
 * in a row, and a crash that happens under the GPU says nothing about whether the
 * CPU could run the same model. So the count is kept per module *and* accelerator
 * (`zh@wasm`, `en@webgpu`), which turns the useful conclusion — "WebGPU on this
 * phone is fatal, use the CPU" — into something the app can act on by itself.
 *
 * Two consecutive crashes under the *same* accelerator stop being a thing to
 * retry: the caller refuses that combination with a sentence a person can act on,
 * instead of looping through the same three-second flash. The count is keyed by
 * the boot revision as well, so improving this path (or changing the model) starts
 * from zero — a device must not stay banned because of an older build of the code.
 */

/** Bumped whenever the engine-start path changes enough to invalidate a ban. */
const REVISION = 'fs-mount-2'
const ATTEMPT_KEY = `rc.asr.attempt.${REVISION}.v1`
const RECORD_KEY = `rc.asr.crashes.${REVISION}.v1`
/**
 * An attempt older than this is not treated as a crash.
 *
 * A module load can legitimately take minutes (240 MB over a slow network), so
 * the window is generous; past it, the likeliest story is that the user simply
 * closed the tab, which is not a crash and must not count against the device.
 */
const ATTEMPT_MAX_AGE_MS = 5 * 60 * 1000

export interface AsrCrashReport {
  module: string
  /**
   * The accelerator the crash happened under (`webgpu` / `wasm`).
   *
   * This is the difference between "this device cannot run the module" and "this
   * device's WebGPU cannot be used" — and the second one has a fix (use the CPU)
   * while the first one does not. Without it recorded, the only honest reading of
   * a silent crash is the hopeless one.
   */
  accelerator: string
  /** How many times in a row this module *and* accelerator have killed the page. */
  count: number
}

/** A crash only counts against the combination it happened under. */
function slot(module: string, accelerator: string): string {
  return `${module}@${accelerator}`
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode or quota: forensics are best-effort, never load-bearing */
  }
}

function drop(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

/** Says "the engine is about to start like this" — survives a kill. */
export function markAsrAttempt(module: string, accelerator: string): void {
  write(ATTEMPT_KEY, { module, accelerator, at: Date.now() })
}

/** The boot reached a state we can explain: there is nothing to report. */
export function clearAsrAttempt(): void {
  drop(ATTEMPT_KEY)
}

/**
 * Called once per page load, before anything else touches the engine.
 *
 * Returns a report when the previous load of this page died while starting the
 * given module, and `null` for every other kind of load — including the very
 * common one where the user closed the tab mid-download.
 */
export function takeAsrCrashReport(): AsrCrashReport | null {
  const attempt = read<{ module?: string; accelerator?: string; at?: number }>(ATTEMPT_KEY)
  if (!attempt?.module) return null
  drop(ATTEMPT_KEY)
  if (typeof attempt.at !== 'number' || Date.now() - attempt.at > ATTEMPT_MAX_AGE_MS) return null
  const accelerator = attempt.accelerator ?? 'unknown'
  const key = slot(attempt.module, accelerator)
  const counts = read<Record<string, number>>(RECORD_KEY) ?? {}
  const count = (counts[key] ?? 0) + 1
  counts[key] = count
  write(RECORD_KEY, counts)
  return { module: attempt.module, accelerator, count }
}

/** How many times this module has killed the page under this accelerator. */
export function asrCrashCount(module: string, accelerator: string): number {
  const counts = read<Record<string, number>>(RECORD_KEY)
  return counts?.[slot(module, accelerator)] ?? 0
}

/**
 * Forgets the count for a combination.
 *
 * Used when a *successful* load happens anyway (the device recovered, or the
 * pressure was external), because a stale ban would lock a working device out of
 * a module it can run perfectly well.
 */
export function forgetAsrCrashes(module: string, accelerator: string): void {
  const counts = read<Record<string, number>>(RECORD_KEY)
  const key = slot(module, accelerator)
  if (!counts || !(key in counts)) return
  delete counts[key]
  write(RECORD_KEY, counts)
}
