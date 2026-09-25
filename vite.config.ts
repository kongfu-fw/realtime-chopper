import { defineConfig, type Plugin, type ViteDevServer } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

/**
 * Cross-origin isolation, needed for `SharedArrayBuffer` and therefore for
 * WebAssembly threads.
 *
 * Without these two headers `crossOriginIsolated` is false, `SharedArrayBuffer`
 * is not even defined, and onnxruntime-web silently falls back to one thread —
 * which is what this app did until now. The dev server sets them too, because a
 * deployment-only setting is one nobody can test.
 *
 * The catch, and the reason this was off for so long: `require-corp` forbids
 * *no-cors* cross-origin subresources. Everything this app fetches cross-origin
 * is already a CORS `fetch()` to a server that sends `Access-Control-Allow-Origin`
 * (HuggingFace for the models, the translation endpoints for text), so none of it
 * is affected — but that is a property to re-check before adding any future
 * third-party asset, and `deploy/nginx.conf` carries the same note.
 */
const ISOLATION_HEADERS: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

/**
 * Stamps the two headers onto **every** response, by sitting in front of the
 * dev/preview middleware chain rather than beside it.
 *
 * This used to be `server.headers`, and the difference only shows up on a
 * **conditional request** — which is why it took a blocked worker to find it.
 * Measured on the same URL, with `If-None-Match` sent back:
 *
 *     server.headers :  200 → both headers ✓        304 → neither header ✗
 *     this plugin    :  200 → both headers ✓        304 → both headers ✓
 *
 * That is not a cosmetic difference. A browser that cached a response *before*
 * these headers existed revalidates, gets a 304 with no cross-origin headers, and
 * keeps the header-less stored copy — so the entry can never heal, no matter how
 * many times the page is reloaded. The document then reports
 * `crossOriginIsolated: false` forever (one thread), and Chrome refuses to start a
 * same-origin classic worker whose response is not embedder-policy compatible:
 *
 *     GET /sherpa-asr.worker.js → net::ERR_BLOCKED_BY_RESPONSE
 *     [session] asr 崩溃了
 *
 * Every module on that runtime — Chinese SenseVoice, and the English one that was
 * still shipped at the time — became unloadable, while Moonshine kept working.
 * That asymmetry is what made it look like a sherpa bug: Moonshine's worker is a
 * bundler chunk on a URL with a query string, so it never matched the stale cache
 * entry.
 *
 * Middleware registered in `configureServer`/`configurePreviewServer` runs
 * *before* Vite's internal middleware, so even a 304 goes out stamped. Production
 * never had this problem: nginx's `add_header … always` covers 304 as well (see
 * `deploy/nginx.conf`), and `src/cross-origin-isolation.test.ts` holds both sides
 * to it.
 */
function crossOriginIsolation(): Plugin {
  const stamp = (middlewares: ViteDevServer['middlewares']) => {
    middlewares.use((_req, res, next) => {
      for (const [key, value] of Object.entries(ISOLATION_HEADERS)) res.setHeader(key, value)
      next()
    })
  }
  return {
    name: 'rc-cross-origin-isolation',
    configureServer(server) {
      stamp(server.middlewares)
    },
    configurePreviewServer(server) {
      stamp(server.middlewares)
    },
  }
}

/**
 * Hostnames the dev/preview server accepts besides `localhost` and bare IPs.
 *
 * Vite's host check is not a detail that can be skipped: it works on the `Host`
 * header, so a reverse proxy that forwards the original hostname — which is
 * exactly what `tailscale serve` does — gets
 *
 *     Blocked request. This host ("shaomings-mac-mini.kooka-salmon.ts.net") is not allowed.
 *
 * Which is a dead end for the one device this app is really written for. A real
 * iPhone cannot load `http://127.0.0.1:5273` (that is the phone talking to
 * itself), and `http://192.168.x.x` costs the microphone, Cache Storage and
 * `SharedArrayBuffer` because it is not a secure context. The tailnet name is:
 * HTTPS with a certificate Safari already trusts, reachable from anywhere, and
 * — the reason it beats a local CA — no certificate warning to click through on
 * a device whose Safari you cannot easily clear a stale exception from.
 *
 * `localhost` and IP literals stay allowed regardless of this list; the test in
 * `src/cross-origin-isolation.test.ts` keeps both paths honest.
 */
const TAILNET_HOSTS = ['.ts.net']

export default defineConfig({
  plugins: [svelte(), crossOriginIsolation()],
  // PWA is served from a sub-path-friendly relative base.
  base: './',
  publicDir: 'static',
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // onnxruntime-web ships its own wasm assets and must stay un-prebundled so
    // the dynamic import inside asr.worker.ts keeps working in dev.
    exclude: ['onnxruntime-web', '@huggingface/transformers'],
  },
  build: {
    target: 'es2022',
    // The ASR runtime is a large lazy chunk on purpose: it is only fetched when
    // a speech-recognition module is actually installed/loaded.
    chunkSizeWarningLimit: 4096,
  },
  server: {
    host: '127.0.0.1',
    port: 5273,
    allowedHosts: TAILNET_HOSTS,
  },
  preview: {
    host: '127.0.0.1',
    port: 5274,
    allowedHosts: TAILNET_HOSTS,
  },
})
