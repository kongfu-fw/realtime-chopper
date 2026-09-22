/*
 * App-shell service worker.
 *
 * Scope is deliberately narrow: it caches the HTML/CSS/JS shell so the app opens
 * offline (and so iOS treats it as installable). Model files and translation
 * responses are left alone — model caching is owned by the recognition engines
 * (see static/zh-asr.worker.js) under their own cache names, and translation
 * answers must never be served stale.
 */
const CACHE = 'rc-shell-v1'

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
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
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
