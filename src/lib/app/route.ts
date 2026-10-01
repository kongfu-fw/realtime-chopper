import type { View } from './state'

/**
 * Every screen has an address.
 *
 * 设置, 历史记录 and the note open on top of it are destinations the user arrives
 * at, and until now the only record of one was a variable in this tab: a refresh
 * put the start page back, and a link to a note could not exist, because there was
 * no such link. This is the address of each screen, the two halves of it — how a
 * screen becomes a URL, and how a URL becomes a screen — and nothing else.
 *
 * ## Why after the `#`
 *
 * The app is a folder of files on somebody else's static host, and that shapes
 * this more than any preference does:
 *
 * - A path like `/history/20261001-173355-a1b4` is a request to the *server* for a
 *   file at that path — the same request on every refresh, on every deep link, and
 *   in every deployment the app has ever had. Serving it means teaching each host
 *   to answer an unknown path with `index.html` (nginx: `try_files $uri
 *   /index.html`, and see the file's own note about why it deliberately does not),
 *   and it has to be redone for every reverse proxy somebody puts in front.
 * - It would also break the one property that makes a sub-path deployment work at
 *   all: `vite.config.ts` builds with `base: './'` so that the assets are asked
 *   for relative to the page, and a page at `/history/<id>` would ask for
 *   `/history/assets/index-<hash>.js`. The relative base and nested paths cannot
 *   both be true.
 * - A fragment is never sent to the server. It is the one part of a URL the host
 *   cannot get wrong, and the one part that survives being opened from a file.
 *
 * So the shape is `<origin>/<app>/` for the home screen and `#/settings`,
 * `#/history`, `#/history/<id>` for the rest. The `#` is the price — the address
 * looks like an address, works like an address, and cannot break on a host that
 * knows nothing about this app.
 *
 * ## The state is the truth; this file is the spelling
 *
 * The URL does not drive the app. `view` and the open note are what drive it
 * (`state.ts`), `back.ts` keeps the browser's history in step with them, and this
 * file is the single place where a screen is spelled as a string. Both halves live
 * here so that the two cannot drift apart: a change to the shape of an address is
 * a change to one pair of functions, and the parser is the only reader.
 *
 * The note's id is percent-encoded even though every id the app generates
 * (`newId`, `history/store.ts`) is already URL-safe — an address is a public
 * thing (copy-pasted, shared, bookmarked), and one that only works for ids that
 * happen not to need escaping is a trap for whoever changes the id next.
 */

/** One screen, spelled out: which view, and which note it has open. */
export interface Address {
  view: View
  /** The note the history screen is showing, or `null` while the list is. */
  note: string | null
}

/**
 * The home screen's address — the bare app URL, with no fragment.
 *
 * Home is the start page and the live transcript in front of it. They *are* one
 * address on purpose: which of the two a user sees is decided by whether a
 * session is running, not by where they went, and a URL that disagreed with that
 * would be a URL that cannot be reloaded into the screen it names.
 */
export const HOME = ''

/** How a screen is spelled as a URL. The one place the shape is written down. */
export function hashOf(address: Address): string {
  if (address.view === 'settings') return '#/settings'
  if (address.view === 'history') {
    return address.note ? `#/history/${encodeURIComponent(address.note)}` : '#/history'
  }
  return HOME
}

/**
 * How a URL is read back into a screen.
 *
 * Anything unrecognised — `#/`, `#nonsense`, an empty fragment, an address from a
 * build that spelled things differently — is the home screen, which is the only
 * answer that always shows something: a URL the app does not understand is not a
 * reason to show a blank page, and `back.ts` then rewrites the address to the one
 * the screen actually has, so the heap of a typo is gone by the time the user
 * looks at the bar.
 */
export function parseHash(hash: string): Address {
  // Empty segments are dropped, so `#/history/` is the list and `#` is home rather
  // than two special cases each with its own bug.
  const parts = hash.replace(/^#/, '').split('/').filter((part) => part !== '')
  if (parts[0] === 'settings' && parts.length === 1) return { view: 'settings', note: null }
  if (parts[0] === 'history') {
    if (parts.length === 1) return { view: 'history', note: null }
    if (parts.length === 2) {
      const note = decode(parts[1])
      if (note) return { view: 'history', note }
    }
  }
  return { view: 'start', note: null }
}

/**
 * Percent-decoding that cannot throw.
 *
 * `decodeURIComponent('%')` throws a `URIError`, and this parser runs at module
 * load of every screen: a URL with a stray `%` in it must not be able to take the
 * app down before it draws. An undecodable id simply is not a note, so the list
 * is what a user gets — the same answer as any other address the app does not
 * recognise.
 */
function decode(part: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    return ''
  }
}
