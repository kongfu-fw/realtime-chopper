/**
 * What this device has learned about hardware acceleration.
 *
 * WebGPU is new on Apple's platforms (Safari 26 is the first release that ships
 * it at all) and its failure modes there are not uniform: some builds expose
 * `navigator.gpu` but never finish creating a device — which is a *hang*, not a
 * throw, so a try/catch never sees it — and some create a device and then lose it
 * once real work starts. Either one costs the user tens of seconds before the app
 * falls back, so the verdict is remembered per device and the next load goes
 * straight to CPU.
 *
 * Deliberately per *device* and not global: a failure on one machine must not
 * stop another machine from using its GPU. A failure also expires, because
 * browsers and drivers get fixed.
 *
 * This module also owns the one answer to "is this Apple's mobile WebKit?",
 * because that single fact decides whether the GPU is attempted at all, and it is
 * quoted in bug reports and in the self-check. Two copies of a user-agent test is
 * how an app ends up telling two different stories about the same phone.
 */

const KEY = 'rc.gpu.verdict.v1'

/** A failed verdict is trusted for this long, then the GPU gets another chance. */
const FAILURE_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface GpuVerdict {
  ok: boolean
  reason: string
  at: number
}

export function readGpuVerdict(): GpuVerdict | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<GpuVerdict>
    if (typeof parsed?.ok !== 'boolean') return null
    return { ok: parsed.ok, reason: String(parsed.reason ?? ''), at: Number(parsed.at ?? 0) }
  } catch {
    /* blocked storage: no memory is a valid state, not an error */
    return null
  }
}

function write(verdict: GpuVerdict): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(verdict))
  } catch {
    /* private mode: the verdict simply is not remembered */
  }
}

export function rememberGpuFailure(reason: string): void {
  write({ ok: false, reason, at: Date.now() })
}

export function rememberGpuSuccess(): void {
  write({ ok: true, reason: '显卡加速可用', at: Date.now() })
}

export function webgpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}

/**
 * Apple's mobile WebKit: iPhone, iPad, and the iPadOS build that reports itself
 * as a Mac.
 *
 * Touch points are what give that last one away: an iPadOS build that says
 * `Macintosh` in its user agent while reporting more than one touch point is not a
 * Mac, which is why the check is not a plain user-agent match.
 */
export function isAppleMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  if (/iPhone|iPad|iPod/.test(ua)) return true
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1
}

/**
 * Platforms whose WebGPU does not fail *politely*, and so must not be tried by
 * default.
 *
 * A hang can be survived with a timeout and a fallback. This cannot: a report
 * from an iPhone 14 Pro (iOS 18.7, Safari 26.6) showed the page being killed 2.7
 * seconds after the English module started, twice, with no exception, no log and
 * no warning — the renderer was gone before anything could be caught. The same
 * module on the CPU is not in doubt; only the GPU path is. So on Apple's mobile
 * WebKit the default is CPU, and "use the GPU anyway" stays available in settings
 * as an explicit choice (see `planDevice`, which honours it as an instruction
 * rather than a hint).
 */
function webgpuRiskyReason(): string | null {
  if (!isAppleMobile()) return null
  return 'iPhone / iPad 上开显卡加速会把整个页面带崩（实测：一启用就整页闪一下重开）'
}

/**
 * Why we should not attempt WebGPU this time, or `null` to go ahead and try.
 *
 * Only failures are actionable here: a recorded success just means the last load
 * worked, and the next one is still a fresh attempt (a GPU can be taken away).
 */
export function gpuBlockReason(): string | null {
  const risky = webgpuRiskyReason()
  if (risky) return risky
  const verdict = readGpuVerdict()
  if (!verdict || verdict.ok) return null
  if (Date.now() - verdict.at > FAILURE_TTL_MS) return null
  return `这台设备上次显卡加速失败过：${verdict.reason || '原因未记录'}`
}

/**
 * Whether a failure is about the *device* rather than about the network.
 *
 * A download that dies halfway says nothing about the GPU, and branding WebGPU as
 * broken because the train went into a tunnel would quietly downgrade the user to
 * CPU forever.
 */
export function looksLikeDeviceFailure(message: string): boolean {
  return !/fetch|network|load failed|offline|connection|download|401|403|404|unauthor|forbidden/i.test(
    message,
  )
}
