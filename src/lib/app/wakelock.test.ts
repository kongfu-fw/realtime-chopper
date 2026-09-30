import assert from 'node:assert/strict'
import test from 'node:test'
import { setUiLang } from '../i18n/index.ts'
import {
  createScreenWakeLock,
  wakeLockAdvice,
  type WakeLockApiLike,
  type WakeLockIssue,
  type WakeLockSentinelLike,
} from './wakelock.ts'

/**
 * The screen lock, without a browser.
 *
 * What is worth testing here is not "does `request()` get called" but the two
 * behaviours a phone depends on and a person cannot see: the lock is asked for
 * again every time the page comes back, and a lock the browser *took away* is
 * reported while one given up because the page was hidden is not. Both are the
 * difference between a session that survives a minute of nobody touching the
 * screen and one that quietly stops.
 *
 * Node resolves ESM specifiers literally, hence the `.ts` extension above.
 */

/** A sentinel a browser could have handed out, with a way to simulate a revocation. */
class FakeSentinel implements WakeLockSentinelLike {
  released = false
  private listeners = new Set<() => void>()

  addEventListener(_type: 'release', listener: () => void): void {
    this.listeners.add(listener)
  }

  async release(): Promise<void> {
    this.released = true
    this.revoke()
  }

  /** The browser dropping the lock on its own — Low Power Mode, or the screen itself. */
  revoke(): void {
    this.released = true
    for (const listener of [...this.listeners]) listener()
  }
}

function fakeApi(behaviour: 'grant' | 'refuse' | 'break' = 'grant'): {
  api: WakeLockApiLike
  sentinels: FakeSentinel[]
  requests: () => number
} {
  const sentinels: FakeSentinel[] = []
  return {
    sentinels,
    requests: () => sentinels.length,
    api: {
      async request() {
        if (behaviour === 'refuse') {
          const err = new Error('not allowed')
          err.name = 'NotAllowedError'
          throw err
        }
        if (behaviour === 'break') throw new Error('boom')
        const sentinel = new FakeSentinel()
        sentinels.push(sentinel)
        return sentinel
      },
    },
  }
}

interface FakePage {
  readonly visibilityState: string
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
  hide(): Promise<void>
  show(): Promise<void>
}

function fakePage(state: 'visible' | 'hidden' = 'visible'): FakePage {
  const listeners = new Set<() => void>()
  let current: string = state
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }
  return {
    // A getter, not a copied value: the keeper is told about the change through
    // the event, and reads the state afterwards — exactly as a browser does.
    get visibilityState() {
      return current
    },
    addEventListener(_type, listener) {
      listeners.add(listener)
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener)
    },
    async hide() {
      current = 'hidden'
      notify()
      await tick()
    },
    async show() {
      current = 'visible'
      notify()
      await tick()
    },
  }
}

/**
 * Lets the keeper's own promise chain finish.
 *
 * The visibility handler must not be awaited by the browser — it is `void grab()`
 * inside — so the test has to wait for the microtasks rather than for the event.
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function collector(): { issues: WakeLockIssue[]; onIssue: (issue: WakeLockIssue) => void } {
  const issues: WakeLockIssue[] = []
  return { issues, onIssue: (issue) => void issues.push(issue) }
}

test('a visible page takes the lock once, and hands it back on release', async () => {
  const page = fakePage()
  const { api, sentinels, requests } = fakeApi()
  const { issues, onIssue } = collector()
  const keeper = createScreenWakeLock({ api, page, onIssue })

  await keeper.acquire()
  assert.equal(requests(), 1)
  assert.equal(keeper.held, true)
  assert.deepEqual(issues, [], 'a lock that is held is not something to warn about')

  // Asking again while it is held must not spend another sentinel: the visible
  // page fires `visibilitychange` for reasons of its own (a tab switch back and
  // forth, a resize), and every extra sentinel would be a lock nobody can give back.
  await keeper.acquire()
  assert.equal(requests(), 1)

  await keeper.release()
  assert.equal(keeper.held, false)
  assert.equal(sentinels[0].released, true)
})

test('a hidden page is not asked, and the lock is taken the moment it comes back', async () => {
  const page = fakePage('hidden')
  const { api, requests } = fakeApi()
  const keeper = createScreenWakeLock({ api, page })

  await keeper.acquire()
  assert.equal(requests(), 0, 'a request from a hidden page is refused by the browser')
  assert.equal(keeper.held, false)

  await page.show()
  assert.equal(requests(), 1)
  assert.equal(keeper.held, true)
})

test('a lock the browser takes away is reported; one lost to hiding is not', async () => {
  const page = fakePage()
  const { api, sentinels, requests } = fakeApi()
  const { issues, onIssue } = collector()
  const keeper = createScreenWakeLock({ api, page, onIssue })

  await keeper.acquire()
  await page.hide()
  sentinels[0].revoke()
  assert.deepEqual(issues, [], 'the browser dropping the lock on hide is the documented behaviour')

  await page.show()
  assert.equal(requests(), 2, 'coming back has to ask again — the old lock is gone')
  assert.equal(keeper.held, true)
  assert.deepEqual(issues, [])

  // The same revocation in plain sight is the one the user has to hear about: it
  // means Low Power Mode was switched on, which nothing here can undo.
  sentinels[1].revoke()
  assert.deepEqual(issues, ['lost'])
  assert.equal(keeper.held, false)

  await keeper.acquire()
  assert.equal(requests(), 3)
  assert.equal(keeper.held, true)
})

test('stopping releases the lock and stops watching the page', async () => {
  const page = fakePage('hidden')
  const { api, requests } = fakeApi()
  const keeper = createScreenWakeLock({ api, page })

  await keeper.acquire()
  await keeper.release()
  await page.show()
  assert.equal(requests(), 0, 'a finished session must not keep a pocketed phone awake')
})

test('no API and a refusal both arrive as advice the user can act on', async () => {
  const bare = collector()
  await createScreenWakeLock({ api: null, page: fakePage(), onIssue: bare.onIssue }).acquire()
  assert.deepEqual(bare.issues, ['unsupported'])

  const refused = collector()
  const { api } = fakeApi('refuse')
  await createScreenWakeLock({ api, page: fakePage(), onIssue: refused.onIssue }).acquire()
  assert.deepEqual(refused.issues, ['refused'])

  const broken = collector()
  const { api: brokenApi } = fakeApi('break')
  await createScreenWakeLock({ api: brokenApi, page: fakePage(), onIssue: broken.onIssue }).acquire()
  assert.deepEqual(broken.issues, ['failed'])
})

test('every reason has its own sentence, and names what to change', () => {
  // Node's `navigator.language` is `en-US`, so the app's `auto` setting would
  // translate these before the assertions could read them. The Chinese source text
  // is the one this project is written in, and the one the assertions quote.
  setUiLang('zh')
  const issues: WakeLockIssue[] = ['unsupported', 'refused', 'failed', 'lost']
  const advice = issues.map((issue) => wakeLockAdvice(issue))
  assert.equal(new Set(advice).size, issues.length, 'two reasons share a sentence')
  for (const text of advice) assert.ok(text.length > 0)

  // The one branch with a version number in it: Safari's own support for this API
  // starts at 16.4, and a user on 16.3 needs to be told it is the browser.
  assert.match(wakeLockAdvice('unsupported'), /16\.4/)
  // The refusal and the revocation are both usually Low Power Mode, and both
  // sentences have to say so — it is the only thing the user can switch off.
  assert.match(wakeLockAdvice('refused'), /低电量模式/)
  assert.match(wakeLockAdvice('lost'), /低电量模式/)
})
