/**
 * Catching up with a deployment in a page that is already open.
 *
 * The service worker is network-first and hands the newest shell to every
 * navigation, so opening the app from the Home Screen icon is normally enough to
 * be on the current build. What no navigation can fix is a page that is *already
 * running*: iOS keeps a suspended web app for days, and a resumed page keeps
 * executing the JavaScript it was born with — for as long as the phone leaves it
 * alive, on the other side of every deployment.
 *
 * That is not a theoretical failure. A page older than 20260929 has no screen
 * wake lock in it at all, so the report it produces is "the screen still locks",
 * which reads exactly like a broken wake lock and is impossible to tell apart
 * from one by reading code. Every check from the outside — the deployed
 * `index.html`, the asset hashes, the service worker — says the app is current,
 * and the phone says otherwise, and both are right.
 *
 * So the page checks itself against the server that served it: fetch its own
 * `index.html`, read the `<meta name="app-version">` that `vite.config.ts` stamps
 * into every build, and compare. When the two disagree the page reloads — but
 * only when nothing on screen would be lost, because the alternative is a reload
 * that interrupts a lesson to install a bug fix. See `decideUpdate` for the whole
 * rule; the app side of it is wired in `App.svelte`, which also decides how often
 * to look.
 *
 * Why `index.html` rather than a version file of its own: the meta is already
 * there for exactly this question (the settings screen reads the same constant),
 * it is served `no-cache` by the deployment, and it cannot go stale in a way the
 * loaded page could not detect — the number in it is the build the server is
 * serving, which is the only thing worth comparing against.
 */

/**
 * How often an open page looks, and how close together two looks may be.
 *
 * The interval is the fallback for a page that never leaves the foreground; the
 * gap exists because `visibilitychange` can fire in bursts, and each look is a
 * request for the whole shell. Five minutes is chosen against the thing it
 * protects: a page that is worked in all lesson shows a new version within five
 * minutes of the deploy, and on a classroom phone the foreground check is what
 * actually runs — nobody leaves the app open between lessons.
 */
export const UPDATE_CHECK_MS = 5 * 60_000
export const UPDATE_CHECK_MIN_GAP_MS = 20_000

/**
 * Where a reload remembers which version it was for.
 *
 * `sessionStorage` and not a variable: the memory has to survive the reload it
 * describes, which is the whole point — it is the loop guard in `decideUpdate`.
 * Per tab, per app instance, and dropped with the app, which is right: a future
 * launch should be allowed to try again.
 */
export const UPDATE_ATTEMPT_KEY = 'rc.update.attempted'

/**
 * The version in a served page, or `null` when there is not one to read.
 *
 * `null`, not an empty string or a guess: an error page, a captive portal, an
 * `index.html` from before this feature existed and a service worker serving a
 * cached shell all lack the meta, and none of them is a version anybody should
 * reload into. The build injects `name` before `content`, but both orders are
 * accepted — a reader that depends on the attribute order is one build away from
 * silently ceasing to see updates.
 */
export function appVersionFromHtml(html: string): string | null {
  const meta = /<meta\s[^>]*name=["']app-version["'][^>]*>/i.exec(html)
  if (!meta) return null
  const content = /content=["']([^"']*)["']/i.exec(meta[0])
  const version = content?.[1].trim()
  return version ? version : null
}

/** What a look at the server concluded. */
export type UpdateStep =
  /** Nothing to do: same version, no version, nothing answered, or already done. */
  | 'none'
  /** The reload was carried out. */
  | 'reload'
  /** A new version exists, but the page is in use; say so and look again later. */
  | 'defer'

/**
 * The whole reload rule, in one pure function.
 *
 * `safe` is the caller's answer to "would a reload lose anything" — in the app
 * that means an idle session, an empty transcript and no module download in
 * flight. It is asked at the moment of the decision rather than remembered,
 * because between two checks the answer changes all the time.
 *
 * `alreadyReloaded` is the loop guard. A reload that does not change what the
 * server serves — a proxy mid-deploy, an edge that has not caught up, a page that
 * came back from the cache anyway — would otherwise be repeated on every look,
 * and a page that reloads every five minutes is worse than a page one deploy
 * behind.
 */
export function decideUpdate(input: {
  current: string
  remote: string | null
  safe: boolean
  alreadyReloaded: string | null
}): UpdateStep {
  if (!input.remote || input.remote === input.current) return 'none'
  if (input.remote === input.alreadyReloaded) return 'none'
  return input.safe ? 'reload' : 'defer'
}

export interface UpdateCheckerDeps {
  /** The version this page is actually running — `APP_VERSION`. */
  current: string
  /** Fetches the page the server would serve now, as text. */
  fetchIndex: () => Promise<string>
  /** True only while a reload would not take anything away. */
  canReload: () => boolean
  reload: () => void
  /** Called just before `reload`, for the line that explains it afterwards. */
  beforeReload: (version: string) => void
  /** Called when a reload is *not* possible, so the user knows one is waiting. */
  announce: (version: string) => void
  /** The version this page already reloaded for, if any (survives the reload). */
  reloadedVersion: () => string | null
  rememberReload: (version: string) => void
}

export interface UpdateChecker {
  /** Looks once. Never throws: a phone without a network is not an error. */
  check: () => Promise<UpdateStep>
}

/**
 * The checker, with everything it touches handed in.
 *
 * Split from the app so that the behaviour can be tested without a server — and,
 * more to the point, without the two mistakes this feature invites: interrupting
 * a recording, and reloading forever.
 */
export function createUpdateChecker(deps: UpdateCheckerDeps): UpdateChecker {
  /** The version the user has already been told about, so the sentence is said once. */
  let announced: string | null = null

  return {
    async check(): Promise<UpdateStep> {
      let remote: string | null
      try {
        remote = appVersionFromHtml(await deps.fetchIndex())
      } catch {
        // A phone loses its network all the time. A page that turns every dropped
        // wifi into a warning is a page whose warnings nobody reads.
        return 'none'
      }
      if (remote === null) return 'none'

      const step = decideUpdate({
        current: deps.current,
        remote,
        safe: deps.canReload(),
        alreadyReloaded: deps.reloadedVersion(),
      })
      if (step === 'none') return 'none'

      if (step === 'defer') {
        // Once per version, not once per look: this runs every few minutes, and a
        // status bar repeating the same sentence reads as a stuck app.
        if (announced !== remote) {
          announced = remote
          deps.announce(remote)
        }
        return 'defer'
      }

      // The line goes first on purpose: after `reload()` there is no page left to
      // write it from, and the reload it explains is the next thing in the log.
      deps.beforeReload(remote)
      deps.rememberReload(remote)
      deps.reload()
      return 'reload'
    },
  }
}
