import { writable } from 'svelte/store'
import { Session } from '../pipeline/session'
import type { Lang } from '../types'
import { runSelfCheck, type SelfCheckReport } from '../selfcheck'
import { getSettings } from '../store/settings'
import { info } from '../log/store'

/**
 * One session per page. Everything that outlives a component lives here rather
 * than in component state, because the session owns worker threads and the
 * microphone: re-creating it on a view switch would tear down a running
 * recording.
 */
export const session = new Session()

export type View = 'translate' | 'settings'
export const view = writable<View>('translate')
export const logOpen = writable(false)
/**
 * The headline shown at the top of the log drawer when something needs saying.
 *
 * There used to be a second surface for this: a red box rendered next to the
 * title bar whenever the engine failed on its own. Two places to look is one too
 * many — the box and the drawer showed the same failure, and on a phone the box
 * is what the user saw *instead* of the log, with no way to reach the lines
 * underneath it. So the sentence moved inside the drawer, which is also the only
 * place the evidence it refers to actually lives.
 *
 * `retry` marks the one failure whose fix is already in place — a GPU that was
 * banned while loading, where the very next attempt runs on the CPU and works —
 * so the drawer can offer the retry instead of making the user find the button.
 *
 * It stays up until it is dismissed or a recording starts, not until the drawer
 * is closed: the drawer is transient, the explanation is not, and a user who
 * closes the log to read the app has not thereby understood what happened.
 */
export const logNotice = writable<{ title: string; body: string; retry?: boolean } | null>(null)
export const installLang = writable<Lang | null>(null)
export const selfCheckReport = writable<SelfCheckReport | null>(null)
export const selfCheckRunning = writable(false)
export const toast = writable<string | null>(null)

/**
 * Headphone confirmation (requirement 13).
 *
 * There is no reliable headphone detection API in a browser: `enumerateDevices`
 * only exposes labels after permission is granted and does not report the output
 * route. So the plan's "require headphones" is implemented as a one-time
 * acknowledgement plus a visible reminder, never as a hard block.
 */
export const headphoneAck = writable(localStorage.getItem('rc.headphoneAck') === '1')
export const headphonePrompt = writable(false)

export function acknowledgeHeadphones(): void {
  headphoneAck.set(true)
  try {
    localStorage.setItem('rc.headphoneAck', '1')
  } catch {
    /* private mode — the reminder just reappears next launch */
  }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined

export function showToast(message: string): void {
  toast.set(message)
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.set(null), 2200)
}

export async function copyText(text: string, label = '已复制'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    showToast(label)
  } catch {
    // Clipboard access needs a secure context and permission; fall back to a
    // selectable prompt rather than failing silently.
    window.prompt('复制下面这段内容：', text)
  }
}

export async function runDiagnostics(burst: boolean): Promise<void> {
  const settings = getSettings()
  selfCheckRunning.set(true)
  try {
    const report = await runSelfCheck({
      provider: settings.mtProvider,
      sl: settings.sourceLang,
      tl: settings.targetLang,
      googleApiKey: settings.googleApiKey,
      llm: {
        format: settings.llmFormat,
        baseUrl: settings.llmBaseUrl,
        model: settings.llmModel,
        apiKey: settings.llmApiKey,
      },
      burst,
    })
    selfCheckReport.set(report)
    info('selfcheck', '自检完成', { checks: report.results.length })
    for (const result of report.results) {
      const text = `${result.label}：${result.detail}`
      if (result.ok === true) info('selfcheck', text)
      else if (result.ok === 'warn') info('selfcheck', `注意 · ${text}`)
      else
        // Failures are also logged so they survive the drawer being closed.
        info('selfcheck', `失败 · ${text}`)
    }
  } finally {
    selfCheckRunning.set(false)
  }
}
