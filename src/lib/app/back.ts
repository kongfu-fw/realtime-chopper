import { get } from 'svelte/store'
import { goBack, openNote, view } from './state'
import { HOME, hashOf, parseHash, type Address } from './route'

/**
 * The system's own back gesture, mapped onto the app's screens — and the app's
 * addresses, kept in step with the same stack.
 *
 * A phone has a back key, a browser has a back button and iOS has a swipe, and
 * all three mean the same thing: undo the last thing that was done to this app.
 * Until now nothing answered them. The list of notes deliberately carries no 返回
 * of its own (see `openHistory` in `state.ts`), so the back key — the gesture
 * every hand already knows — walked *out* of the app instead: past the app's own
 * entry to whatever was there before it, or out of the window entirely in an
 * installed one.
 *
 * What this module adds is a stack of layers — every screen and panel that is
 * open, in the order it was opened — and the browser's history kept in step with
 * it: one entry of the app's own per open layer, so the platform's back has
 * something of ours to consume, and never an entry more than that. A press closes
 * the top of the stack, exactly one layer per press. When the stack is empty the
 * app holds nothing and the gesture is the browser's again, which on Android
 * means what it means in every other app: the app goes to the background.
 *
 * The alternative — a "where did this screen come from" flag per screen, or a
 * `popstate` handler that guesses from the view it finds — is what this replaced.
 * The app grew several screens that can each be entered from several places, and
 * every one of them would have had to answer that question separately, in the one
 * place a user can always tell it got the answer wrong.
 *
 * ## The same stack is the address bar
 *
 * A layer of this stack may carry the address of the screen it is (`route.ts`),
 * and the entries this module pushes are labelled with it. That is what makes the
 * URL follow the user around: open the notes and the bar says `#/history`; open a
 * note and it says `#/history/<id>`; press the back key and it is the previous
 * screen's address again, because the browser's own traversal is what the bar is
 * showing and the traversal is what the stack follows. Overlays — a drawer, a
 * dialog, the log — carry no address: they are not screens, the URL does not
 * change for them, and the entry one of them gets is labelled with the screen it
 * is over, so that pressing back with a dialog open puts the dialog away and
 * leaves the bar saying exactly what it said before.
 *
 * The stack, not the URL, is still what decides what is on screen. The address is
 * a *projection* of it, rewritten whenever the two could disagree: on the entry
 * underfoot once the app has settled on one, so that a screen reached by a tap
 * (which pushes nothing) and a screen reached by a press (which pops) both end up
 * with the address they describe.
 */

/** What the entries this module pushes carry: how deep the app was when it made one. */
const DEPTH = 'rc'

interface Layer {
  /** Puts this layer away. */
  close: () => void
  /**
   * The address of the screen this layer *is*, when it is one.
   *
   * Absent (or empty) for everything that is not a screen — a drawer, a dialog —
   * which is also what makes such a layer inherit the address of the screen below
   * it rather than invent one.
   */
  url?: string
}

/**
 * What is open right now, oldest first — so the last entry is the top, and the
 * top is what a back press closes.
 *
 * Insertion order is stacking order for every pair this app can draw at once (a
 * drawer under a dialog, a note under its rename dialog), because a layer is
 * registered by the thing that has just appeared. The one place the two orders
 * could disagree — a panel opening in the same tap that closes another — puts the
 * arriving layer last, which is also the one the eye has landed on.
 */
const open: Layer[] = []

/** How many entries deep in the app's own history the browser is standing right now. */
function depth(): number {
  const state = history.state as Record<string, unknown> | null
  const value = state?.[DEPTH]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * The address of the app with the first `n` layers of the stack open — what the
 * browser entry at depth `n` is showing.
 *
 * The topmost layer that has an address wins, because that is the screen on top;
 * a drawer or a dialog above it changes nothing about where the user is. With no
 * addressed layer at all it is the home screen, which is what the app is with
 * nothing open.
 */
function urlAt(n: number): string {
  for (let i = Math.min(n, open.length) - 1; i >= 0; i -= 1) {
    const url = open[i]?.url
    if (url) return url
  }
  return HOME
}

/**
 * An address as a URL the history API will take, resolved against this document.
 *
 * Built from `location` rather than handed over as a bare fragment because the
 * empty string — the home screen's address — has no unambiguous meaning to
 * `pushState`: the entry has to be *relabelled to no fragment*, which is a
 * different thing from "leave the URL alone". Prepending the path and the query
 * says which of those is meant, and keeps a `?` in the page's own URL (a debug
 * flag, a campaign tag) on every entry of the app's.
 */
function urlFor(hash: string): string {
  return `${location.pathname}${location.search}${hash}`
}

/**
 * Runs one call into the history API, and refuses to let it break anything.
 *
 * `pushState` and `back` throw a `SecurityError` in the one context this app can
 * be opened in where the history is closed off (a `file://` document, which is
 * not a supported way to run it — the microphone needs a secure context — but is
 * a very easy way to *look* at it). A gesture is a convenience; the screens are
 * not: without this, a browser that refuses the push would take the drawer's own
 * open effect down with it, so opening the drawer would stop working over a
 * feature that only exists to make the back key behave.
 *
 * `false` means the browser would not do it, which every caller has to hear: a
 * push that does not take leaves the depth where it was, and a loop that decided
 * when to stop by reading the depth would otherwise spin on it for ever.
 */
function quietly(act: () => void): boolean {
  try {
    act()
    return true
  } catch {
    /* no history to keep in step with — the screens themselves still work */
    return false
  }
}

/**
 * Makes the browser's history agree with the stack.
 *
 * Upward it is synchronous: a layer that has just opened needs an entry of its
 * own to be closed by, and one push is all that takes.
 *
 * Downward it is deliberately not, and that is the whole reason this is a
 * function rather than two lines at the call sites. `history.back()` is a
 * *navigation* — the browser performs it later — so calling it in the middle of
 * the tap that closed a layer would land the page on an entry the app had already
 * moved past, because closing the drawer and opening 设置 are the same tap and the
 * pop would arrive after both. Waiting for the turn to end lets the decision be
 * made against the state as it finally settles: that one tap pushes nothing and
 * pops nothing, and the drawer's entry simply becomes the settings screen's.
 *
 * Convergence is the popstate's job: this pops at most one entry, and the entry
 * it pops to is what calls `onPop` again, which reconciles against the stack as
 * it is *then*.
 *
 * When the two agree, the entry underfoot is relabelled with the address of what
 * it is showing. That one line is what keeps the address honest for every screen
 * change that is not a push or a pop: a tap in the drawer that swaps one
 * destination for another, and the closing of a layer whose entry is being
 * consumed (`<id>` → the list it came from). It is a `replaceState` and not a
 * push because the browser is standing on the entry that already means "this
 * screen" — the screen simply changed what it is called.
 */
function reconcile(): void {
  while (open.length > depth()) {
    if (!quietly(() => history.pushState({ [DEPTH]: depth() + 1 }, '', urlFor(urlAt(depth() + 1)))))
      return
  }
  if (open.length < depth()) {
    popOne()
    return
  }
  const here = depth()
  // Only an entry of the app's own is relabelled, and that is not tidiness: a
  // fragment navigation dispatches `popstate` *before* it has finished, our own
  // handler reconciles while it is still in flight, and `replaceState` during a
  // navigation **cancels it**. Measured here: an address typed into the bar became
  // a `hashchange` reporting the new address while the bar had already been put
  // back to the page's own, and the app stayed where it was — the one failure this
  // whole section exists to rule out. A stale label is a label on an entry *we*
  // made; the entry a user is arriving at is theirs to name, and its address is
  // applied by `show()` the moment the navigation has actually finished.
  if (ours() && location.hash !== urlAt(here)) {
    quietly(() => history.replaceState({ [DEPTH]: here }, '', urlFor(urlAt(here))))
  }
}

/**
 * Whether the entry the browser is standing on is one the app made.
 *
 * `history.state` is how an entry says so: every entry this module pushes carries
 * the depth, and the one `labelBase` relabels carries it too. An entry without one
 * is the browser's — the document entry of a page opened at a plain URL, or an
 * entry the user made by typing an address into the bar.
 */
function ours(): boolean {
  const state = history.state as Record<string, unknown> | null
  return state !== null && state !== undefined && state[DEPTH] !== undefined
}

/**
 * Whether one of this module's own pops is in flight.
 *
 * At most one at a time, and the reason is not tidiness. The browser is free to
 * merge two `history.back()` calls issued in the same moment into a single
 * traversal, and two pops that arrive as one would leave this stack believing an
 * entry was gone that is still there — so the convergence above would take one
 * more to catch up, and that one more is past the app's own first entry, out of
 * the document, with the app unloaded by a back press that was only meant to shut
 * a drawer. Measured here, in an earlier draft of this file: two timers scheduled
 * by one tap, the drawer and the list both leaving the stack, and the whole page
 * gone. So a pop is asked for, and the next one waits for the traversal it asked
 * for to actually arrive (`popstate`), which is also what makes the re-reading
 * below honest.
 */
let popping = false

/** Takes one entry back, if the app is still standing above its own stack when it lands. */
function popOne(): void {
  if (popping) return
  popping = true
  setTimeout(() => {
    // Re-read rather than trust the count from when this was scheduled: closing a
    // drawer and opening the screen behind it is one tap, and the decision has to
    // be made against the state that finally settled. A pop that is no longer
    // needed is not taken — and neither is one that a later pop has already made
    // good on, because `popping` was released by the traversal in between.
    if (open.length >= depth()) {
      popping = false
      return
    }
    // A pop that is refused has no `popstate` coming to release the flag, so it
    // is released here — the next press gets to try again.
    if (!quietly(() => history.back())) popping = false
  }, 0)
}

/**
 * Registers something that is open, for as long as it is.
 *
 * The return value is the way to unregister, written so that it can be returned
 * straight out of a Svelte `$effect`: the layer then exists exactly while the
 * thing that opened it is on screen, and no close path has to remember to tidy up
 * after itself — the drawer closed by its scrim, by Escape, by a row, or by the
 * back gesture is the same single unregistration.
 *
 * `url` is the address of the screen, for the layers that are one; everything
 * else leaves it out and takes the address of the screen it is over.
 */
export function openBackLayer(close: () => void, url?: string): () => void {
  const layer: Layer = { close, url }
  open.push(layer)
  reconcile()
  return () => {
    const at = open.indexOf(layer)
    if (at < 0) return
    open.splice(at, 1)
    reconcile()
  }
}

/**
 * The gesture itself.
 *
 * One press closes one thing. The loop is for the platform arriving several
 * entries down at once (a browser's back button held down, a history jump), and
 * each layer comes *off* the stack before it is closed: closing is what
 * re-renders the screen, and a stack that waited for that would close the same
 * layer twice.
 */
function onPop(): void {
  // The traversal this was waiting for has arrived, whether it was asked for here
  // or pressed by a hand — and the next one, if any, may be issued.
  popping = false
  const target = depth()
  while (open.length > target) open.pop()?.close()
  reconcile()
}

/**
 * Shows the screen an address names.
 *
 * Used for the one way into the app that is not a step of the app's own: somebody
 * editing the address bar of a page that is already open, which changes the
 * fragment in place — a same-document navigation, `hashchange`, no page load. It
 * sets the same two stores a tap would, and the stack reacts exactly as it does
 * to a tap, which is the point: there is one way a screen changes in this app, and
 * an arriving address is not a second one.
 */
function show(address: Address): void {
  // Compared as *addresses*, not as views, and that is not a shortcut: one address
  // can be two views. Home is the start page and the live transcript in front of it
  // (`route.ts`), and which of the two is showing is decided by whether a session is
  // running — never by the bar.
  //
  // Every traversal of the app's own entries fires a `hashchange` as well as a
  // `popstate`, so an event that lands on the home entry arrives *after* the screen
  // has already been decided. Without this check the address then wins: a recording
  // whose last press took it home is thrown back to the start page, and leaving the
  // notes for the transcript through the drawer does the same thing a moment later —
  // the second one measured here by the harness, which is what put this line in.
  const wanted = hashOf(address)
  if (wanted === hashOf({ view: get(view), note: get(openNote) })) return
  if (address.note !== get(openNote)) openNote.set(address.note)
  if (address.view !== get(view)) view.set(address.view)
}

/**
 * An address arriving without a page load.
 *
 * Rare but real: a link pasted into the address bar of the app that is already
 * open, or a Home Screen shortcut into a page that is running. A traversal does
 * not come through here — that is `popstate` — and the guard is for the moment
 * around one: our own `popOne` has asked for a traversal that has not landed yet,
 * and applying a URL from under it would move the screen out from under the press
 * that is still arriving.
 *
 * The `location` is read rather than the event's `newURL`, and the difference
 * matters in one case that is easy to get wrong: a traversal to a *different*
 * screen's entry, where `popstate` runs first and this app's own convergence may
 * already have pushed or relabelled an entry by the time this event is delivered.
 * The event would then be reporting a URL that has already been superseded;
 * `location.hash` is what the bar says now, which is the only thing worth applying.
 */
function onHash(): void {
  if (popping) return
  const address = parseHash(location.hash)
  show(address)
  // The bar is then put in the app's own spelling of that screen — `#/` and
  // `#/history/` become the forms the app writes, and an address it does not know
  // at all becomes the home screen's, which is where the user has just landed.
  //
  // Here and not in `reconcile`, because this is the first moment it can be done:
  // a `replaceState` during a navigation aborts it, and until this event arrives
  // the navigation is still in flight. It is also the right moment for the *entry
  // the user made* to be relabelled — but relabelled to the address of the screen
  // they are actually looking at, which is the rule everywhere else in this file.
  const canonical = hashOf(address)
  if (location.hash !== canonical) {
    quietly(() => history.replaceState({ [DEPTH]: depth() }, '', urlFor(canonical)))
  }
}

/**
 * Re-labels the entry the page was opened on.
 *
 * A document is loaded *into* one entry the browser made for the navigation, and
 * that entry is not a step of the app's own — it is the page. When the page is
 * opened at an address of ours (a reload, a link, a shortcut), the entry has to
 * become the home screen's: the layer that address names pushes its own entry
 * above this one, and the press after that one has to land *home*, exactly as it
 * would if the user had walked in from the start page. Left alone, the entry
 * under the note would keep the note's address while showing the start page, and
 * a reload there would open the note again — the address disagreeing with the
 * screen is the one bug an address can have.
 *
 * Only when the entry is the app's first (`depth()` is 0): a reload *deeper* in
 * the app reloads an entry the app itself pushed, whose label is already right —
 * and `history.state` survives a reload, so the depth says which of the two this
 * is. An address the app does not recognise is relabelled too, which is what
 * makes a mistyped one disappear from the bar instead of standing there.
 */
function labelBase(): void {
  if (depth() !== 0 || location.hash === HOME) return
  quietly(() => history.replaceState({ [DEPTH]: 0 }, '', urlFor(HOME)))
}

/**
 * Wires the gesture up, once, for the life of the page.
 *
 * Two of the layers are registered here rather than by a component, because they
 * are app-level state instead of something that knows it is open (`view`): 设置
 * and 历史记录. Their close is `goBack()` — the same answer the settings header's
 * own 返回 button gives, because the button and the gesture are the same question.
 *
 * The registered layer is keyed on the *address* of the view rather than on the
 * view itself, because the two destinations can be swapped for each other in one
 * tap (设置 sits in the drawer that opens over the list): the layer is then
 * released and re-registered, which leaves the stack exactly as deep as it was
 * while the entry underfoot is relabelled from one address to the other.
 */
export function armBackNavigation(): () => void {
  window.addEventListener('popstate', onPop)
  window.addEventListener('hashchange', onHash)
  labelBase()

  let destination: { url: string; release: () => void } | null = null
  const stop = view.subscribe((next) => {
    const url = next === 'settings' || next === 'history' ? hashOf({ view: next, note: null }) : null
    if (url === (destination?.url ?? null)) return
    destination?.release()
    destination = url === null ? null : { url, release: openBackLayer(goBack, url) }
  })

  return () => {
    stop()
    destination?.release()
    window.removeEventListener('popstate', onPop)
    window.removeEventListener('hashchange', onHash)
  }
}
