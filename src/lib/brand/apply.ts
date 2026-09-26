import { APP_NAME, DEFAULT_APP_ICON, appDesc, appTitle, iconAsset, iconFor, iconPreviewUrl } from './logo'
import { currentLang } from '../i18n/index.ts'

/**
 * Put the chosen icon where the browser actually looks.
 *
 * Three places can be changed from a running page:
 *
 *  1. **The favicon** — swapping the `<link rel="icon">` href takes effect at
 *     once, in every browser.
 *  2. **iOS's home-screen icon** — its own link and its own 180 px PNG, because
 *     Safari ignores the manifest here. Best effort: Safari reads the link when
 *     the app is added to the home screen, and a link changed afterwards is not
 *     guaranteed to be picked up.
 *  3. **The installed icon** — that comes from the web app manifest, and the
 *     browser reads it when the user *installs* the app, which is why the
 *     settings row says an already-installed icon has to be removed and added
 *     again.
 *
 * Every size is a real file in `static/` (rendered by `scripts/make-icons.mjs`),
 * so nothing is drawn in the page here — this only ever points at a URL. The
 * default choice deliberately leaves the static manifest alone: it is the path
 * every user gets, and it should not depend on this code running.
 */

const FAVICON_ID = 'rc-favicon'
const MANIFEST_ID = 'rc-manifest'
const APPLE_ID = 'rc-apple-touch'

let liveManifestUrl: string | null = null

export function applyAppIcon(id: string): void {
  if (typeof document === 'undefined') return
  const icon = iconFor(id)
  /** `location.href` is the app's own URL, so a `./` path resolves to the app's root. */
  const absolute = (file: string) => new URL(file, location.href).href

  let favicon = document.getElementById(FAVICON_ID) as HTMLLinkElement | null
  if (!favicon) {
    favicon = document.createElement('link')
    favicon.id = FAVICON_ID
    favicon.rel = 'icon'
    document.head.append(favicon)
  }
  favicon.type = icon.mime ?? 'image/svg+xml'
  favicon.href = absolute(iconPreviewUrl(icon.id))

  let apple = document.getElementById(APPLE_ID) as HTMLLinkElement | null
  if (!apple) {
    apple = document.createElement('link')
    apple.id = APPLE_ID
    apple.rel = 'apple-touch-icon'
    document.head.append(apple)
  }
  // Always set, never only on change: switching back to the default has to undo
  // the choice too.
  apple.sizes = '180x180'
  apple.href = absolute(iconAsset(icon.id, 180))

  const manifest = document.getElementById(MANIFEST_ID) as HTMLLinkElement | null
  if (!manifest) return

  // The static manifest is the Chinese default. Any other language gets a
  // generated one even for the default icon, because the name and the tagline an
  // install carries are part of the interface.
  if (icon.id === DEFAULT_APP_ICON && currentLang() === 'zh') {
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
          name: appTitle(),
          // The name on its own: a home screen has room for one word, and the
          // mascot's name is not translated.
          short_name: APP_NAME,
          description: appDesc(),
          start_url: base,
          scope: base,
          display: 'standalone',
          orientation: 'any',
          background_color: '#FDFBF4',
          theme_color: '#FDFBF4',
          // The tagline follows the interface language, and so does the manifest's
          // own `lang`: an install made by an English user should say so.
          lang: currentLang() === 'zh' ? 'zh-CN' : currentLang(),
          // The same set the static manifest declares, for this icon: two plain
          // sizes and one that bleeds and survives a launcher's circular mask.
          icons: [
            { src: absolute(iconAsset(icon.id, 192)), sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: absolute(iconAsset(icon.id, 512)), sizes: '512x512', type: 'image/png', purpose: 'any' },
            {
              src: absolute(iconAsset(icon.id, 'maskable-512')),
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        }),
      ],
      { type: 'application/manifest+json' },
    ),
  )

  manifest.href = next
  if (liveManifestUrl) URL.revokeObjectURL(liveManifestUrl)
  liveManifestUrl = next
}
