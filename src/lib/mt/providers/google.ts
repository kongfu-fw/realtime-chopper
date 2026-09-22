import type { MtContext, MtProvider } from '../types'
import { MtError } from '../types'
import { decodeEntities, escapeText } from '../text'
import { googleCode } from '../lang'

/**
 * Google Translate, via the endpoint Google's own website-translator widget
 * uses.
 *
 * Not the widely-scraped `translate_a/single`: that endpoint ignores repeated
 * `q` parameters (verified — two `q` values return one translation), which
 * makes it useless for the batching this app depends on. `translateHtml`
 * accepts an array and returns translations in the same order, and it is the
 * interface the widget itself ships with.
 *
 * Two consequences, both recorded in the plan:
 *  - A Google API key is mandatory. We use the public widget key that Google
 *    serves to every page that embeds the translator, and the settings screen
 *    lets the user supply their own. The public key is rate-limited and can be
 *    rotated at any time, so the fallback chain is not optional.
 *  - The payload is parsed as HTML, hence the escaping.
 *
 * Verified against a real page origin: 200, CORS allowed, batch of 2 in /
 * batch of 2 out, 403 without a key.
 */
const ENDPOINT = 'https://translate-pa.googleapis.com/v1/translateHtml'
const WIDGET_CLIENT = 'wt_lib'
/** Public key served with Google's website-translator snippet. */
export const GOOGLE_WIDGET_KEY = 'AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520'

export const googleProvider: MtProvider = {
  id: 'google',
  label: '谷歌翻译',
  supportsBatch: true,

  async translate(texts: string[], ctx: MtContext): Promise<string[]> {
    if (texts.length === 0) return []
    const key = ctx.googleApiKey?.trim() || GOOGLE_WIDGET_KEY
    const body = [[texts.map(escapeText), googleCode(ctx.sl), googleCode(ctx.tl)], WIDGET_CLIENT]
    let response: Response
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json+protobuf',
          'X-Goog-API-Key': key,
        },
        body: JSON.stringify(body),
        signal: ctx.signal,
      })
    } catch (err) {
      throw new MtError(`谷歌翻译网络错误：${err instanceof Error ? err.message : String(err)}`, {
        retryable: true,
        cause: err,
      })
    }
    if (!response.ok) {
      throw new MtError(`谷歌翻译返回 HTTP ${response.status}`, {
        retryable: response.status === 429 || response.status >= 500,
        status: response.status,
      })
    }
    const payload: unknown = await response.json().catch(() => undefined)
    const first = Array.isArray(payload) ? (payload[0] as unknown) : undefined
    if (!Array.isArray(first) || first.length !== texts.length) {
      throw new MtError('谷歌翻译返回的句子数量与请求不一致', { retryable: false })
    }
    return first.map((item) => decodeEntities(String(item)).trim())
  },
}
