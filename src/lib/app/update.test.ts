import assert from 'node:assert/strict'
import test from 'node:test'
import { appVersionFromHtml, createUpdateChecker, decideUpdate, type UpdateStep } from './update.ts'

/**
 * Catching up with a deployment, without a browser.
 *
 * The behaviour worth testing is the *decision*, because every branch of it is a
 * judgement about somebody's session: the same version is not news, a page that
 * cannot be read is not a failure, a recording is not to be interrupted, and a
 * reload that did not move the version must not be repeated forever. Each of
 * those is a way this could go wrong on a phone — and the ones that go wrong
 * loudly (a reload loop) are the ones a user experiences as "the app flickers and
 * loses my sentence".
 *
 * Node resolves ESM specifiers literally, hence the `.ts` extension above.
 */

/** The one line of markup the decision reads, in the shape the build injects it. */
function page(version: string | null): string {
  const meta =
    version === null ? '' : `<meta name="app-version" content="${version}">`
  return `<!doctype html><html><head>${meta}<title>app</title></head><body></body></html>`
}

interface Harness {
  check: () => Promise<UpdateStep>
  events: string[]
  reloads: () => number
  remembered: () => string | null
  setVersion: (version: string | null) => void
  setUnreachable: (yes: boolean) => void
  setSafe: (safe: boolean) => void
}

function harness(current = '20260929'): Harness {
  let html = page(current)
  let unreachable = false
  let safe = true
  let remembered: string | null = null
  let reloads = 0
  const events: string[] = []
  const checker = createUpdateChecker({
    current,
    async fetchIndex() {
      if (unreachable) throw new Error('offline')
      return html
    },
    canReload: () => safe,
    reload: () => {
      reloads += 1
      events.push('reload')
    },
    beforeReload: (version) => events.push(`before:${version}`),
    announce: (version) => events.push(`announce:${version}`),
    reloadedVersion: () => remembered,
    rememberReload: (version) => {
      remembered = version
    },
  })
  return {
    check: () => checker.check(),
    events,
    reloads: () => reloads,
    remembered: () => remembered,
    setVersion: (version) => {
      html = page(version)
    },
    setUnreachable: (yes) => {
      unreachable = yes
    },
    setSafe: (next) => {
      safe = next
    },
  }
}

test('the version the build stamps into index.html is read back out', () => {
  assert.equal(appVersionFromHtml(page('20260929')), '20260929')
  // The injector writes `name` before `content`, but a reader that only works for
  // one attribute order is a reader that breaks when the build is rearranged.
  assert.equal(
    appVersionFromHtml('<head><meta content="20260929.2" name="app-version"></head>'),
    '20260929.2',
  )
  assert.equal(appVersionFromHtml("<head><meta name='app-version' content='20260929'></head>"), '20260929')
  // A page with no version is *unknown*, not a different version: every 404 page
  // and every error page is built like this, and none of them is an update.
  assert.equal(appVersionFromHtml(page(null)), null)
  // Same reason, for a meta whose content was left empty.
  assert.equal(appVersionFromHtml('<meta name="app-version" content="">'), null)
  // A `content` that belongs to some other meta must not be mistaken for ours.
  assert.equal(appVersionFromHtml('<meta name="viewport" content="width=device-width">'), null)
})

test('decideUpdate only reloads for a version the server actually has', () => {
  const base = { current: '20260929', safe: true, alreadyReloaded: null }
  assert.equal(decideUpdate({ ...base, remote: null }), 'none')
  assert.equal(decideUpdate({ ...base, remote: '20260929' }), 'none')
  assert.equal(decideUpdate({ ...base, remote: '20260929.2' }), 'reload')
  assert.equal(decideUpdate({ ...base, remote: '20260929.2', safe: false }), 'defer')
  // The version this page already reloaded for: doing it again is a loop, and a
  // loop is worse than a stale tab.
  assert.equal(decideUpdate({ ...base, remote: '20260929.2', alreadyReloaded: '20260929.2' }), 'none')
})

test('a page that matches the server is left alone', async () => {
  const app = harness()
  assert.equal(await app.check(), 'none')
  assert.deepEqual(app.events, [])
  assert.equal(app.reloads(), 0)
})

test('a server that does not answer, or answers without a version, is quiet', async () => {
  const app = harness()
  app.setUnreachable(true)
  assert.equal(await app.check(), 'none')
  app.setUnreachable(false)
  app.setVersion(null)
  assert.equal(await app.check(), 'none')
  // Neither case is a version to remember: the check has to stay able to run
  // again after the network comes back, which is the normal state on a phone.
  assert.deepEqual(app.events, [])
  assert.equal(app.remembered(), null)
})

test('a newer server version reloads once nothing would be lost', async () => {
  const app = harness()
  app.setVersion('20260929.2')
  assert.equal(await app.check(), 'reload')
  // The line is written *before* the reload: afterwards there is no page left to
  // write it from, and a reload with no line explaining it is how a user learns
  // to distrust the app.
  assert.deepEqual(app.events, ['before:20260929.2', 'reload'])
  assert.equal(app.remembered(), '20260929.2')
})

test('a session in progress postpones the reload, and is told so exactly once', async () => {
  const app = harness()
  app.setVersion('20260929.2')
  app.setSafe(false)
  assert.equal(await app.check(), 'defer')
  assert.deepEqual(app.events, ['announce:20260929.2'])
  assert.equal(app.reloads(), 0)
  // Checking again every few minutes must not repeat the sentence: a status bar
  // that says the same thing forever reads as a stuck app.
  assert.equal(await app.check(), 'defer')
  assert.deepEqual(app.events, ['announce:20260929.2'])
  // Once the page is safe, the next look — a foreground, or the next tick —
  // carries it out.
  app.setSafe(true)
  assert.equal(await app.check(), 'reload')
  assert.deepEqual(app.events, ['announce:20260929.2', 'before:20260929.2', 'reload'])
})

test('a reload that did not move the version is not repeated', async () => {
  const app = harness()
  app.setVersion('20260929.2')
  assert.equal(await app.check(), 'reload')
  assert.equal(app.reloads(), 1)
  // Whatever the server keeps serving — a proxy mid-deploy, a stale edge — the
  // page that comes back for the same version must not reload again. This is the
  // loop guard, and `remembered` is what carries it across the reload.
  assert.equal(await app.check(), 'none')
  assert.equal(app.reloads(), 1)
})
