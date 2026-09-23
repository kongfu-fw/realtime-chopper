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
 * A problem the user has to be told about, with the logs one click away.
 *
 * This exists because "something went wrong and I cannot see what" is worse than
 * the failure itself. The log drawer lives behind the debug switch — reasonable
 * when everything works, useless in the one case where the log is the whole point
 * — so anything that fails on its own raises this instead, and the strip it
 * renders carries a button that opens the drawer without touching the setting.
 */
export const problem = writable<{ title: string; body: string } | null>(null)
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
