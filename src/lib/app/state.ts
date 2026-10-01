import { get, writable } from 'svelte/store'
import { Session } from '../pipeline/session'
import type { Lang } from '../types'
import { runSelfCheck, type SelfCheckReport } from '../selfcheck'
import { getSettings, isLangInstalled } from '../store/settings'
import { ttsConfigFrom } from '../tts/engine'
import { info } from '../log/store'
import { t } from '../i18n/index.ts'
import { parseHash } from './route'

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
 *
 * The starting value is read from the address (`route.ts`), which is what makes a
 * reload — or a link somebody sent — land on the screen it names instead of on the
 * app's first one. Read once, here, rather than applied by a component later: a
 * screen that is set after mounting is a screen the page has already drawn
 * something else for, and on a phone that flash is the whole of what a user sees.
 */
export type View = 'start' | 'translate' | 'settings' | 'history'

const initial = parseHash(location.hash)

export const view = writable<View>(initial.view)

/**
 * The note open on the history screen, or `null` while the list is showing.
 *
 * App state rather than a component's own variable (which is what it was), because
 * an open note is part of the address: `#/history/<id>` names one note, and a
 * refresh on that screen — or a link to it — has to be able to put the same one
 * back. The id is all that is kept here; the note itself and its audio are read by
 * `HistoryView`, which watches this store, so that the screen that *shows* a note
 * is still the only thing that knows how to read one.
 *
 * It is also what makes the note a layer of the back stack rather than a state of
 * the list: setting it is showing it, clearing it is putting it away.
 */
export const openNote = writable<string | null>(initial.note)

/**
 * The screens behind this one, newest last.
 *
 * This is what a way back *means*, and it is a trail rather than a remembered
 * field because the app has more than one door into each screen: 设置 can be
 * reached from the start page, from a transcript's drawer and from the notes
 * screen, and every one of those is a different answer to "where does back go".
 * A trail answers all of them with the same one — undo the step that was actually
 * taken — which is also the only answer that stays true when a user zigzags
 * (设置 → 历史记录 → 设置) and comes back out again.
 *
 * It replaces two writables, `viewBeforeSettings` and `viewBeforeHistory`, that
 * each screen's own open function wrote down. That version could not tell a
 * zigzag from a straight line — opening 设置 *from* 设置 overwrote the answer with
 * 设置, and 返回 then went nowhere — and every new door into a screen had to
 * remember to write it. The trail is written by the view store itself, in one
 * place, so a screen added later is remembered without anything being remembered
 * about it.
 */
const trail: View[] = []
/** A way back this long is a fidget, not a journey; the oldest steps fall off. */
const TRAIL_MAX = 12

let shown: View = get(view)
view.subscribe((next) => {
  if (next === shown) return
  // Only the two destinations are *entered*: the start page and the transcript
  // are where the app already is, and stepping out of a destination lands on one
  // of them and forgets the trail — which is what makes this a stack of screens
  // rather than a log of taps.
  if (next === 'settings' || next === 'history') {
    trail.push(shown)
    if (trail.length > TRAIL_MAX) trail.shift()
  } else {
    trail.length = 0
  }
  // Leaving 历史记录 forgets the note it had open.
  //
  // Not because the address would be wrong — it is the stack of open layers that
  // spells the address (`back.ts`), and the note's layer goes when its screen
  // goes — but because the note would otherwise be *remembered*: coming back to
  // the list later would open it again, unasked. That is the old behaviour kept
  // deliberately: the open note used to be a variable inside `HistoryView`, and a
  // screen that is left and re-entered showed the list, which is what somebody
  // tapping 历史记录 in the drawer is asking for.
  if (next !== 'history' && get(openNote)) openNote.set(null)
  shown = next
})

/**
 * The way back: the screen this one was opened from.
 *
 * Its two callers are the same question — the 返回 in the settings header and the
 * system's own back gesture (`back.ts`) — and they are answered in one place, so
 * that a button and a key can never disagree about where a user came from.
 */
export function goBack(): void {
  view.set(trail.pop() ?? 'start')
}

/** 设置: a destination like 历史记录 — entered from anywhere, left by `goBack` */
export function openSettings(): void {
  view.set('settings')
}

/**
 * Opens the notes — the list of what has been recorded and filed.
 *
 * There used to be a `closeHistory` beside it, and a `viewBeforeHistory` for that
 * function to remember, because the list carried a 返回. It does not any more, and
 * that is why the pair is gone rather than merely unused: a 返回 on the list had to
 * answer "which screen was this opened from" — the start page's card, the drawer
 * over a transcript, or the pause panel that had just filed a note — and the answer
 * a user could name ("the screen I was looking at") is the one it got wrong. The
 * list is a destination like any other, and the drawer is the way between
 * destinations; the note's own screen keeps its 返回, where the answer is never in
 * doubt.
 *
 * What the list has instead of a button is the system's own back gesture
 * (`back.ts`), which is the one control that cannot get this wrong: it does not
 * have to know where the list was opened from, it retraces the step that was
 * taken.
 */
export function openHistory(): void {
  view.set('history')
}

/**
 * The list that slides out of the left edge behind the logo.
 *
 * A store rather than component state because two things outside the drawer open
 * and close it: the logo in the title bar, and the rows inside it (each row is a
 * destination, and a drawer that stays open behind the screen it just opened is a
 * drawer the user has to close by hand every time).
 */
export const navOpen = writable(false)

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

/**
 * The one way a session is started from a button.
 *
 * Three states a session can be in when somebody presses "start", and only the
 * third of them starts anything: the module for the source language is not on the
 * device (the install dialog takes over and starts the session when it is done),
 * the headphone question has not been answered (a first run answers it through
the prompt `App.svelte` draws), or it is time to open the microphone. The order
 * matters and is the order of cost: the download is the only wait measured in
 * minutes, and the headphone question is asked while it runs.
 *
 * Written once because it used to exist twice — the footer's button and the start
 * page's — with the same three cases spelled out in each, which is how the two
 * came to answer the headphone question differently.
 */
export type BeginOutcome = 'started' | 'installing' | 'headphones' | 'cancelled'

export async function beginSession(): Promise<BeginOutcome> {
  const state = get(session.state)
  if (state === 'preparing' || state === 'stopping') {
    // Already on its way — and a press during the permission prompt is the one
    // wait a user can get out of.
    session.abortStart()
    return 'cancelled'
  }
  const settings = getSettings()
  if (!isLangInstalled(settings.sourceLang, settings.installedModels)) {
    installLang.set(settings.sourceLang)
    return 'installing'
  }
  if (!get(headphoneAck)) {
    headphonePrompt.set(true)
    return 'headphones'
  }
  await session.start()
  return 'started'
}

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
