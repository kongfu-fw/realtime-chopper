import { t } from '../i18n/index.ts'
import { info, warn } from '../log/store.ts'

/**
 * Keeping the screen awake while a recording is running.
 *
 * A phone locks its screen a minute after the last touch, and on iOS that is the
 * end of the session: the page is frozen, the audio session underneath it is torn
 * down, and the transcript stops mid-sentence with nothing in the interface to say
 * why. Nobody touches the screen during a lesson — being left alone is the whole
 * point of the app — so this is the failure a classroom hits first.
 *
 * The Screen Wake Lock API is the fix, and on iOS it means Safari 16.4 or newer.
 * Two of its properties explain the shape of this module:
 *
 * - the browser drops the lock the moment the page stops being visible, and it
 *   refuses a request from a page that already is — so the lock is re-taken on
 *   `visibilitychange`, not set once at the start;
 * - iOS refuses the request outright in Low Power Mode, and that refusal arrives
 *   as the same `NotAllowedError` a hidden page gets. Neither can be repaired from
 *   here, so both are handed to the user as the sentence that fixes them: turn Low
 *   Power Mode off, or set Auto-Lock to Never (see `wakeLockAdvice`).
 *
 * The imports below carry their `.ts` extensions so that `node --test` can load
 * this module directly; `messages.test.ts` has the same note.
 */

/** The part of `WakeLockSentinel` this module uses — a test stands in for the rest. */
export interface WakeLockSentinelLike {
  readonly released: boolean
  release(): Promise<void>
  addEventListener?(type: 'release', listener: () => void): void
}

/**
 * `navigator.wakeLock`, structurally.
 *
 * Structural rather than the DOM lib's `WakeLock`, because what is *absent* is the
 * interesting case: Safari before 16.4 and most in-app browsers (the ones a
 * KakaoTalk or WeChat link opens in) have no `navigator.wakeLock` at all, and the
 * test needs to be able to say so.
 */
export interface WakeLockApiLike {
  request(type?: 'screen'): Promise<WakeLockSentinelLike>
}

/** What this module needs from `document`. */
export interface PageVisibilityLike {
  readonly visibilityState: string
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

/**
 * Why the screen may still go dark.
 *
 * - `unsupported` — there is no API to call (Safari before 16.4, in-app browsers);
 * - `refused` — the system said no: Low Power Mode, or the page was hidden;
 * - `failed` — the request itself broke; nothing in the interface can fix it;
 * - `lost` — the lock *was* held and the browser took it back while the page was
 *   visible, which in practice means Low Power Mode was just switched on.
 */
export type WakeLockIssue = 'unsupported' | 'refused' | 'failed' | 'lost'

/**
 * What to tell the user.
 *
 * Every branch names the setting to change, because a screen lock is only ever
 * actionable in the system's own settings app: nothing this code can do makes iOS
 * hand the screen back. A message that says only "屏幕常亮失败" is a dead end.
 */
export function wakeLockAdvice(issue: WakeLockIssue): string {
  switch (issue) {
    case 'unsupported':
      return t('这个浏览器不支持屏幕常亮（Safari 要 16.4 或更新）：录音时请在「设置 → 显示与亮度 → 自动锁定」里选「永不」')
    case 'refused':
      return t('系统拒绝了屏幕常亮（低电量模式开着，或者页面当时不在前台）：把低电量模式关掉，或把「自动锁定」设成「永不」')
    case 'lost':
      return t('屏幕常亮被系统收回了（多半是低电量模式刚打开）：屏幕可能还会自动熄灭')
    case 'failed':
      return t('屏幕常亮没能开启；录音时请在「设置 → 显示与亮度 → 自动锁定」里选「永不」')
  }
}

export interface ScreenWakeKeeper {
  /** True while the screen is actually being held awake right now. */
  readonly held: boolean
  /**
   * Take the lock, and keep taking it back for as long as the page returns.
   *
   * Safe to call again at any time: the visibility listener installed here is what
   * does the re-taking, and a call for a lock already held is a no-op.
   */
  acquire(): Promise<void>
  /** Give the lock back and stop watching the page. */
  release(): Promise<void>
}

export interface ScreenWakeOptions {
  /**
   * Called once per failed attempt, with a sentence for the user.
   *
   * Only failures: a lock that is held is logged and otherwise silent, because
   * there is nothing to do about it.
   */
  onIssue?: (issue: WakeLockIssue) => void
}

export interface ScreenWakeDeps extends ScreenWakeOptions {
  api: WakeLockApiLike | null
  page: PageVisibilityLike | null
}

/**
 * The keeper, with its two collaborators handed in.
 *
 * Split from `keepScreenAwake` so that the whole of the behaviour — the re-take
 * on the way back, the difference between a revocation we care about and one we
 * asked for — can be tested without a browser.
 */
export function createScreenWakeLock(deps: ScreenWakeDeps): ScreenWakeKeeper {
  let sentinel: WakeLockSentinelLike | null = null
  let wanted = false
  let watching = false
  let pending: Promise<void> | null = null

  /**
   * The sentinel that is actually still good.
   *
   * `released` is consulted as well as the release event: the event is the
   * browser's promise to tell us, and a sentinel that says it is released while
   * still occupying the field would block every later request.
   */
  function current(): WakeLockSentinelLike | null {
    if (sentinel && sentinel.released) sentinel = null
    return sentinel
  }

  function setWatching(next: boolean): void {
    if (!deps.page || watching === next) return
    watching = next
    if (next) deps.page.addEventListener('visibilitychange', onVisibility)
    else deps.page.removeEventListener('visibilitychange', onVisibility)
  }

  function onVisibility(): void {
    // Only the way back matters: on the way out the browser has already taken the
    // lock, and asking for one is refused anyway.
    if (deps.page?.visibilityState === 'visible') void grab()
  }

  function onRelease(which: WakeLockSentinelLike): void {
    if (sentinel === which) sentinel = null
    // A lock given up because the page was hidden is the browser doing what it
    // said it would, not a fault — only a revocation in plain sight is reported.
    if (wanted && deps.page?.visibilityState === 'visible') {
      failed('lost')
    }
  }

  /** A lock is now held. One log line per grant, so a log shows how often the phone woke up. */
  function granted(taken: WakeLockSentinelLike): void {
    sentinel = taken
    // iOS revokes the lock without asking — Low Power Mode, or the screen locking
    // for its own reasons. The event is the only way that is noticed at all.
    taken.addEventListener?.('release', () => onRelease(taken))
    info('session', t('屏幕常亮已开启：录音期间屏幕不会自动熄灭'))
  }

  function failed(issue: WakeLockIssue): void {
    warn('session', t('屏幕常亮没能生效'), { [t('怎么办')]: wakeLockAdvice(issue) })
    deps.onIssue?.(issue)
  }

  async function take(): Promise<void> {
    if (!wanted || current()) return
    const api = deps.api
    if (!api) {
      failed('unsupported')
      return
    }
    // A hidden page is not asked at all: the request would be refused, and the
    // lock would be taken back the moment the page hid anyway.
    if (deps.page && deps.page.visibilityState !== 'visible') return
    try {
      const taken = await api.request('screen')
      // The session stopped while the browser was answering. Holding a lock for a
      // recording that is over would keep a pocketed phone's screen on, which is
      // exactly the wrong favour.
      if (!wanted) {
        await taken.release().catch(() => undefined)
        return
      }
      granted(taken)
    } catch (err) {
      failed(refusal(err))
    }
  }

  /**
   * Takes the lock if it is not held, folding overlapping calls into one request.
   *
   * A `visibilitychange` and an explicit `acquire()` can land in the same tick,
   * and two requests would leave one sentinel unreferenced — a lock with nothing
   * left that can give it back.
   */
  function grab(): Promise<void> {
    pending ??= take().finally(() => {
      pending = null
    })
    return pending
  }

  return {
    get held() {
      return current() !== null
    },
    async acquire() {
      wanted = true
      setWatching(true)
      await grab()
    },
    async release() {
      wanted = false
      setWatching(false)
      const held = current()
      sentinel = null
      // A request still in flight resolves into a lock nobody wants, and `take`
      // gives it straight back.
      await held?.release().catch(() => undefined)
    },
  }
}

/** Which advice a rejected request deserves. */
function refusal(err: unknown): WakeLockIssue {
  const name = err instanceof Error ? err.name : ''
  if (name === 'NotSupportedError') return 'unsupported'
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'refused'
  return 'failed'
}

/** The app's keeper: the browser's own wake lock, and the browser's own `document`. */
export function keepScreenAwake(options: ScreenWakeOptions = {}): ScreenWakeKeeper {
  const nav = typeof navigator === 'undefined' ? null : (navigator as { wakeLock?: WakeLockApiLike })
  const api = nav?.wakeLock && typeof nav.wakeLock.request === 'function' ? nav.wakeLock : null
  return createScreenWakeLock({
    api,
    page: typeof document === 'undefined' ? null : document,
    onIssue: options.onIssue,
  })
}
