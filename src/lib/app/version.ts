/**
 * The app's version number — and the only place it is written down.
 *
 * A date, `YYYYMMDD`: `20260926` is the build that went out on 2026-09-26. It is
 * bumped **by hand, once per iteration**, because the question a report from a
 * phone actually raises is "which build were you on?", and a date answers it
 * without asking anyone to read an asset hash out of a browser they cannot open.
 * A second release on the same day takes a suffix: `20260926.2`.
 *
 * Kept here rather than in `package.json` so that shipping a change is one edit
 * in one file: the npm version would have to stay in sync with the lockfile's
 * copy, which is a way to break a build over a number nobody reads.
 *
 * Where it turns up, so nothing has to re-derive it:
 *
 * - the built `index.html`, as `<meta name="app-version">` — so a deployment can
 *   be identified with `curl` and grepped, which is the quickest way to tell a
 *   live build apart from a Service-Worker-cached older one;
 * - the settings screen and the mascot's easter egg, for a person who is holding
 *   the device;
 * - the startup line in the log drawer, the first line of every copied log, and
 *   the head of the diagnostic report that a phone can send.
 */
export const APP_VERSION = '20261001.3'
