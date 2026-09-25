/*
 * App-shell service worker.
 *
 * Scope is deliberately narrow: it caches the HTML/CSS/JS shell so the app opens
 * offline (and so iOS treats it as installable). Model files and translation
 * responses are left alone — model caching is owned by the recognition engines
 * (see static/sherpa-asr.worker.js) under their own cache names, and translation
 * answers must never be served stale.
 */
const CACHE = 'rc-shell-v2'

/**
 * Caches this worker is allowed to delete when it takes over.
 *
 * The version bump above is why this exists. `activate` used to delete *every*
 * cache that was not the current shell, which includes the model buckets the
 * recognition engines own (`rc-model-*`) and transformers.js's
 * `transformers-cache` — so a shell update, the one thing that happens on every
 * deploy, threw away every downloaded ASR module and re-downloaded up to 350 MB.
 * It also contradicted this file's own header comment. Scoped to our own prefix,
 * the worker cleans up after itself and touches nothing else.
 */
const SHELL_PREFIX = 'rc-shell-'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(['./', './manifest.webmanifest']).catch(() => undefined))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key.startsWith(SHELL_PREFIX) && key !== CACHE).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  if (url.pathname.endsWith('sw.js')) return

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone()
        caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined)
        return response
      })
      .catch(() => caches.match(request).then((cached) => cached ?? caches.match('./'))),
  )
})
