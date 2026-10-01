import { get, writable } from 'svelte/store'
import { Session } from '../pipeline/session'
import type { Lang } from '../types'
import { runSelfCheck, type SelfCheckReport } from '../selfcheck'
import { getSettings } from '../store/settings'
import { ttsConfigFrom } from '../tts/engine'
import { info } from '../log/store'
import { t } from '../i18n/index.ts'

/**
 * One session per page. Everything that outlives a component lives here rather
 * than in component state, because the session owns worker threads and the
 * microphone: re-creating it on a view switch would tear down a running
 * recording.
 */
export const session = new Session()

/**
 * Which screen the app is on.
 *
 * `start` is the page a cold launch opens on: the logo, where a session's loading
 * is reported, and one button. It is a view rather than a modal or an overlay
 * because everything else — the footer's buttons, the transcript, the timer in the
 * header — is about a *session*, and on the start page there is not one yet.
 */
export type View = 'start' | 'translate' | 'settings'

export const view = writable<View>('start')

/**
 * Where 设置 was opened from, so 返回 goes back there rather than guessing.
 *
 * Opened from the start page, "back" has to mean the start page: it is the only
 * place the loading state and the one button that starts a session exist, and
 * sending a user to an empty transcript instead would look like the app had lost
 * the thing they were about to press.
 */
export const viewBeforeSettings = writable<View>('translate')

export function openSettings(): void {
  // Read first, write second: an `update` whose callback sets a second store is a
  // side effect inside an expression, and Svelte is free to run it more than once.
  viewBeforeSettings.set(get(view))
  view.set('settings')
}

export function closeSettings(): void {
  view.set(get(viewBeforeSettings))
}

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

export async function copyText(text: string, label = t('已复制')): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    showToast(label)
  } catch {
    // Clipboard access needs a secure context and permission; fall back to a
    // selectable prompt rather than failing silently.
    window.prompt(t('复制下面这段内容：'), text)
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
      tts: ttsConfigFrom(settings),
      burst,
    })
    selfCheckReport.set(report)
    info('selfcheck', t('自检完成'), { [t('项数')]: report.results.length })
    for (const result of report.results) {
      const text = `${result.label}${t('：')}${result.detail}`
      if (result.ok === true) info('selfcheck', text)
      else if (result.ok === 'warn') info('selfcheck', t('注意 · {text}', { text }))
      else
        // Failures are also logged so they survive the drawer being closed.
        info('selfcheck', t('失败 · {text}', { text }))
    }
  } finally {
    selfCheckRunning.set(false)
  }
}
