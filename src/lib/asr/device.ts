/**
 * The one answer to "is this Apple's mobile WebKit?".
 *
 * That single fact decides whether the recognition module can run here at all:
 * iOS gives a page an order of magnitude less memory than a desktop browser, and
 * the SenseVoice download is past what an Apple page can hold — measured, not
 * guessed (see `moduleTooBigForDevice`). So the check is quoted by the routing,
 * the install dialog, the diagnostic report and the self-check, and it lives in
 * one place because two copies of a user-agent test is how an app ends up telling
 * two different stories about the same phone.
 *
 * This file used to own something else as well — the remembered verdict on
 * WebGPU, which the Moonshine modules consulted before attempting the GPU. Those
 * modules are gone, and the sherpa runtime that replaced them is CPU-only
 * (single-threaded WASM), so there is no accelerator left to choose and nothing
 * left to remember. What remains is the device question, which was always the
 * load-bearing half.
 */

/**
 * Apple's mobile WebKit: iPhone, iPad, and the iPadOS build that reports itself
 * as a Mac.
 *
 * Touch points are what give that last one away: an iPadOS build that says
 * `Macintosh` in its user agent while reporting more than one touch point is not a
 * Mac, which is why the check is not a plain user-agent match.
 */
export function isAppleMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  if (/iPhone|iPad|iPod/.test(ua)) return true
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1
}
