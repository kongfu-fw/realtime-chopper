import { APP_DESC, APP_NAME, DEFAULT_APP_ICON, iconDataUrl, iconVariant } from './logo'

/**
 * Put the chosen icon where the browser actually looks.
 *
 * Two places can be changed from a running page, and they behave differently:
 *
 *  1. **The favicon** — swapping the `<link rel="icon">` href takes effect at
 *     once, in every browser.
 *  2. **The installed icon** — that comes from the web app manifest, and a
 *     manifest can only be pointed at a URL. For anything other than the icon we
 *     ship in `static/icon.svg` we build one in the page and hand it over as a
 *     blob URL. The browser reads it when the user *installs* the app, which is
 *     why the settings row says an already-installed icon has to be removed and
 *     added again.
 *
 * The default choice deliberately leaves the static manifest alone: it is the
 * path every user gets, and it should not depend on this code running.
 */

const FAVICON_ID = 'rc-favicon'
const MANIFEST_ID = 'rc-manifest'

let liveManifestUrl: string | null = null

export function applyAppIcon(id: string): void {
  if (typeof document === 'undefined') return
  const variant = iconVariant(id)
  const url = iconDataUrl(variant.id)

  let favicon = document.getElementById(FAVICON_ID) as HTMLLinkElement | null
  if (!favicon) {
    favicon = document.createElement('link')
    favicon.id = FAVICON_ID
    favicon.rel = 'icon'
    document.head.append(favicon)
  }
  favicon.type = 'image/svg+xml'
  favicon.href = url

  const manifest = document.getElementById(MANIFEST_ID) as HTMLLinkElement | null
  if (!manifest) return

  if (variant.id === DEFAULT_APP_ICON) {
    manifest.href = './manifest.webmanifest'
    if (liveManifestUrl) {
      URL.revokeObjectURL(liveManifestUrl)
      liveManifestUrl = null
    }
    return
  }

  // A blob URL is not a base for relative URLs, so everything in the generated
  // manifest has to be absolute.
  const base = new URL('.', location.href).href
  const next = URL.createObjectURL(
    new Blob(
      [
        JSON.stringify({
          name: APP_NAME,
          short_name: APP_NAME,
          description: APP_DESC,
          start_url: base,
          scope: base,
          display: 'standalone',
          orientation: 'any',
          background_color: '#FDFBF4',
          theme_color: '#FDFBF4',
          lang: 'zh-CN',
          icons: [{ src: url, sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
        }),
      ],
      { type: 'application/manifest+json' },
    ),
  )

  manifest.href = next
  if (liveManifestUrl) URL.revokeObjectURL(liveManifestUrl)
  liveManifestUrl = next
}
