/**
 * The shipped default for the recognition service address.
 *
 * One assertion, on purpose, and it is worth a file because of *where* a mistake
 * here lands: this field is filled in on a phone, and Apple's mobile has no local
 * Korean fallback (`mayFallBackToLocal`), so a default pointing at nothing is not
 * a slower app — it is the first sentence of the session failing with a network
 * error while someone is standing in a classroom. It went stale in exactly that
 * way once: the default used to be the relative path `/asr`, which assumes the
 * service is served from the same hostname as the app, and the app is served from
 * one tailnet host while `koasr` runs on another.
 *
 * The value is read out of the source rather than imported, and that is deliberate
 * as well: `store/settings.ts` is not a module `node --test` can load — it pulls
 * the whole store and its `svelte/store` dependency in, and its relative imports
 * carry no extensions, because the tests that matter for the app's behaviour are
 * the ones that reach the ASR modules. Reading the file is the leaner trade; the
 * assertion itself still goes through the *real* `resolveBaseUrl`, so what is
 * pinned is a resolved address and not a spelling.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { addressProblem, resolveBaseUrl } from '../asr/koasr.ts'

/** The page the phone actually opens (see DOCKER.md), i.e. the origin that resolves
 *  a relative default and the scheme that forbids an `http://` one. */
const PHONE_PAGE = 'https://kongfu-onedrive.kooka-salmon.ts.net'

test('默认的识别服务地址指向教室那台机器，而且是 https', () => {
  const source = readFileSync(new URL('./settings.ts', import.meta.url), 'utf8')
  // Inside `DEFAULT_SETTINGS`, where the field's doc comment says what belongs in
  // it. Anchored loosely on purpose: reformatting this file should not fail a test
  // about an address.
  const configured = /asrBaseUrl:\s*'([^']*)'/.exec(source)?.[1]
  assert.ok(configured, 'settings.ts 里找不到 asrBaseUrl 的默认值')
  // A host of its own — not a path on the app's origin, which is the failure this
  // guard exists for: that shape 404s on the deployment and reads as "服务没开".
  assert.equal(resolveBaseUrl(configured, PHONE_PAGE), 'https://kongfu.kooka-salmon.ts.net')
  // And https, so there is nothing for `addressProblem` to report from that page:
  // an `http://` default would be blocked before a packet left the device, which
  // the phone shows as an unreachable service.
  assert.equal(addressProblem(configured, 'https:'), null)
})
