import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'

/**
 * Cross-origin isolation has to cover *every* response — including the ones with
 * no body — and the way it fails is silent.
 *
 * What these tests exist for. `require-corp` is checked per response, not once at
 * the document, and Chrome refuses to start a same-origin classic worker whose own
 * response is not embedder-policy compatible. The dev server used to declare the
 * headers with `server.headers`, which stamps a 200 but **not a 304**. So a
 * response cached before the headers existed revalidated, got a bare 304, and kept
 * its bare stored copy — permanently. The page then reported
 * `crossOriginIsolated: false` (one thread) no matter how often it was reloaded,
 * and `/sherpa-asr.worker.js` came back as
 *
 *     GET /sherpa-asr.worker.js → net::ERR_BLOCKED_BY_RESPONSE
 *
 * which killed both sherpa modules while Moonshine kept working, because
 * Moonshine's worker is a bundler chunk on a query-string URL and never matched
 * the stale entry. Everything pointed at sherpa; nothing pointed at a header.
 *
 * Hence a test that asks the running server, twice — once cold, once conditional.
 *
 * Node resolves ESM specifiers literally, so the imports carry the `.ts` extension.
 */

const OPENER = 'cross-origin-opener-policy'
const EMBEDDER = 'cross-origin-embedder-policy'

/** Paths worth arguing about: one per way Vite can produce a response. */
const PROBES = [
  // The document itself, which is what turns isolation on in the first place.
  { path: '/', why: 'document' },
  // A classic worker script under publicDir (`static/`) — the one that was blocked.
  { path: '/sherpa-asr.worker.js', why: 'publicDir worker script' },
  // A manifest, fetched by the browser, not by us.
  { path: '/manifest.webmanifest', why: 'publicDir manifest' },
  // A source module, i.e. a response that goes through the transform pipeline.
  { path: '/@vite/client', why: 'transformed module' },
]

function assertIsolated(response: Response, label: string): void {
  // Both, always: one of the two is not enough for the browser to isolate the page,
  // and a missing pair surfaces three layers away as "SharedArrayBuffer is not
  // defined".
  assert.equal(response.headers.get(EMBEDDER), 'require-corp', `${label} 缺 ${EMBEDDER}`)
  assert.equal(response.headers.get(OPENER), 'same-origin', `${label} 缺 ${OPENER}`)
}

test('dev server 的每一个响应都带跨源隔离头', async () => {
  // A port in a high, unlikely range: the developer may well have `npm run dev`
  // running on 5273 in another window while this runs.
  const port = 40000 + Math.floor(Math.random() * 20000)
  const server = await createServer({ server: { port, strictPort: false }, logLevel: 'silent' })
  try {
    await server.listen()
    const address = server.httpServer?.address()
    assert.ok(address && typeof address === 'object', 'dev server 没有监听端口')
    const origin = `http://127.0.0.1:${address.port}`

    for (const probe of PROBES) {
      const url = origin + probe.path
      const response = await fetch(url)
      assert.equal(response.status, 200, `${probe.path}（${probe.why}）没返回 200`)
      assertIsolated(response, `${probe.path}（${probe.why}）`)

      // The half that used to be missing, and the reason the whole thing was
      // unfixable from the browser side: a conditional request must come back
      // stamped too, or the stored copy never gains the headers.
      const validator =
        response.headers.get('etag') ?? response.headers.get('last-modified') ?? null
      assert.ok(validator, `${probe.path}（${probe.why}）没有校验器，无法验证重新校验那条路`)
      const condition = response.headers.get('etag') ? 'If-None-Match' : 'If-Modified-Since'
      const revalidated = await fetch(url, { headers: { [condition]: validator! } })
      const label = `${probe.path}（${probe.why}）的 ${condition} 响应`
      assertIsolated(revalidated, label)
    }
  } finally {
    await server.close()
  }
})

/**
 * The other reason the phone could not load the dev server, and the one that has
 * nothing to do with headers-on-304.
 *
 * Vite validates the `Host` header, and a reverse proxy forwards the *original*
 * hostname — that is what `tailscale serve` is. So the one hostname the phone can
 * actually use (`https://<machine>.<tailnet>.ts.net`, the only secure context this
 * app has on a real device that is not a laptop) is precisely the one the dev
 * server answers with
 *
 *     403 Blocked request. This host ("…ts.net") is not allowed.
 *
 * The fix is a config line, which is why it needs a test: the failure mode is a
 * 403 that only appears from another device, and `localhost` — the path every
 * other test and every developer uses — keeps working either way. The last
 * assertion is the one that would catch an `allowedHosts` that accidentally
 * replaced the built-in allowance for `localhost` and IP literals.
 */
test('dev server 认 tailnet 主机名，也继续认 localhost 和 IP', async () => {
  const port = 40000 + Math.floor(Math.random() * 20000)
  const server = await createServer({ server: { port, strictPort: false }, logLevel: 'silent' })
  try {
    await server.listen()
    const address = server.httpServer?.address()
    assert.ok(address && typeof address === 'object', 'dev server 没有监听端口')

    // The real shape: `tailscale serve` terminates TLS on 443, so the forwarded
    // host carries no port — the branch that matches on the `.ts.net` suffix.
    const tailnet = await getWithHost(address.port, '/', 'shaomings-mac-mini.kooka-salmon.ts.net')
    assert.equal(
      tailnet.status,
      200,
      'tailnet 主机名被 Host 检查拦下了：`tailscale serve` 后面手机上打不开 dev server',
    )
    assertIsolated(tailnet, 'tailnet 主机名的响应')

    const foreign = await getWithHost(address.port, '/', 'evil.example.com')
    assert.equal(foreign.status, 403, '外来主机名不该访问得到 dev server')

    const local = await getWithHost(address.port, '/', `127.0.0.1:${address.port}`)
    assert.equal(local.status, 200, 'allowedHosts 不能把内置的 localhost / IP 一起顶掉')
  } finally {
    await server.close()
  }
})

/**
 * `node:http` rather than `fetch`, because `Host` is a forbidden header name in
 * fetch and gets dropped — a test that cannot set the header cannot test the
 * header. The response is wrapped in a `Response` so `assertIsolated` reads it the
 * same way it reads a real one.
 */
function getWithHost(port: number, path: string, host: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { Host: host } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        resolve(
          new Response(Buffer.concat(chunks), {
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string>,
          }),
        ),
      )
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * The nginx side cannot be exercised without a container, so it is checked
 * structurally — but for the one property that actually bit us: inheritance.
 *
 * `add_header` in nginx stops applying at the first level that declares it, so a
 * single `add_header` inside any `location` silently drops the isolation headers
 * for that location. That is the same bug as the dev server's, wearing different
 * clothes, so it gets the same kind of guard. Unlike the dev server, nginx's
 * `add_header … always` does cover a 304, which is what the `always` is for.
 */
test('nginx 的隔离头写在 server 级，不在 location 里另起 add_header', () => {
  const conf = readFileSync(fileURLToPath(new URL('../deploy/nginx.conf', import.meta.url)), 'utf8')
  // Anchored to the start of a line on purpose: the comment at the top of the file
  // talks *about* locations, and a plain `indexOf('location ')` lands inside it.
  const firstLocation = conf.search(/^\s*location\b/m)
  assert.ok(firstLocation > 0, 'deploy/nginx.conf 里找不到 location')

  const serverLevel = conf.slice(0, firstLocation)
  assert.match(serverLevel, /add_header Cross-Origin-Opener-Policy same-origin always;/)
  assert.match(serverLevel, /add_header Cross-Origin-Embedder-Policy require-corp always;/)

  const all = conf.match(/^\s*add_header\b/gm) ?? []
  const atServerLevel = serverLevel.match(/^\s*add_header\b/gm) ?? []
  assert.equal(
    all.length,
    atServerLevel.length,
    '某个 location 里出现了 add_header，server 级的隔离头会在那里静默失效',
  )
})
