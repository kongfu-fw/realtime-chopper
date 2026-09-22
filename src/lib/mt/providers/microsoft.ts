import type { MtContext, MtProvider } from '../types'
import { MtError } from '../types'
import { decodeEntities, escapeText } from '../text'
import { microsoftCode } from '../lang'

/**
 * Microsoft Translate — the keyless fallback.
 *
 * This is the unauthenticated successor to the `api-edge.cognitive` flow: the
 * older `edge.microsoft.com/translate/auth` token endpoint was removed upstream
 * in July 2026. The current endpoint takes a bare JSON array of strings and
 * answers with one object per input, which makes it the only provider in the
 * chain that needs no credentials at all.
 *
 * That property is why it is the fallback rather than an also-ran: in networks
 * where Google is unreachable (mainland China being the obvious case), the
 * Google probe fails and the app keeps working with zero configuration.
 *
 * Verified against a real page origin: 200, CORS allowed, batch in / batch out,
 * no key required.
 */
const ENDPOINT = 'https://edge.microsoft.com/translate/translatetext'

interface MicrosoftItem {
  translations?: { text?: string }[]
}

export const microsoftProvider: MtProvider = {
  id: 'microsoft',
  label: '微软翻译',
  supportsBatch: true,

  async translate(texts: string[], ctx: MtContext): Promise<string[]> {
    if (texts.length === 0) return []
    const url = `${ENDPOINT}?from=${encodeURIComponent(microsoftCode(ctx.sl))}&to=${encodeURIComponent(
      microsoftCode(ctx.tl),
    )}&isEnterpriseClient=false`
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(texts.map(escapeText)),
        signal: ctx.signal,
      })
    } catch (err) {
      throw new MtError(`微软翻译网络错误：${err instanceof Error ? err.message : String(err)}`, {
        retryable: true,
        cause: err,
      })
    }
    if (!response.ok) {
      throw new MtError(`微软翻译返回 HTTP ${response.status}`, {
        retryable: response.status === 429 || response.status >= 500,
        status: response.status,
      })
    }
    const payload: unknown = await response.json().catch(() => undefined)
    if (!Array.isArray(payload) || payload.length !== texts.length) {
      throw new MtError('微软翻译返回的句子数量与请求不一致', { retryable: false })
    }
    return (payload as MicrosoftItem[]).map((item, index) => {
      const text = item?.translations?.[0]?.text
      if (typeof text !== 'string') {
        throw new MtError(`微软翻译第 ${index + 1} 句缺少译文`, { retryable: false })
      }
      return decodeEntities(text).trim()
    })
  },
}
