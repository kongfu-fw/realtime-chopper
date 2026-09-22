/// <reference lib="webworker" />
import { MtClient, type MtConfig, type MtItem } from '../lib/mt/client'
import { cacheSize, clearCache } from '../lib/mt/cache'

/**
 * Translation worker.
 *
 * Batching means *waiting*: a sentence sits for up to `mtBatchWindowMs` before
 * it goes out. Doing that on the main thread would couple network timing to
 * rendering, and the retry backoff can stretch to seconds. So the whole
 * translation pipeline lives here and only results come back.
 */

interface ConfigureMessage {
  type: 'configure'
  config: MtConfig
}

type Inbound =
  | ConfigureMessage
  | { type: 'translate'; items: MtItem[] }
  | { type: 'once'; requestId: number; texts: string[]; overrides?: Partial<MtConfig> }
  | { type: 'stats' }
  | { type: 'clear-cache' }

let config: MtConfig = {
  provider: 'google',
  batchWindowMs: 300,
  useCache: true,
  googleApiKey: '',
  llm: { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' },
  sl: 'en',
  tl: 'zh',
  preferredProvider: null,
}

const client = new MtClient(
  () => config,
  (result) => postMessage({ type: 'result', ...result }),
  (level, message, detail) => postMessage({ type: 'log', level, message, detail }),
)

self.onmessage = (event: MessageEvent) => {
  const msg = event.data as Inbound
  switch (msg.type) {
    case 'configure':
      config = { ...config, ...msg.config }
      break
    case 'translate':
      client.enqueue(msg.items)
      break
    case 'once':
      void client
        .translateOnce(msg.texts, msg.overrides)
        .then((out) =>
          postMessage({ type: 'once-result', requestId: msg.requestId, texts: out.texts, provider: out.provider }),
        )
        .catch((err: unknown) =>
          postMessage({
            type: 'once-result',
            requestId: msg.requestId,
            error: err instanceof Error ? err.message : String(err),
          }),
        )
      break
    case 'stats':
      postMessage({ type: 'stats', cacheSize: cacheSize(), queued: client.queued })
      break
    case 'clear-cache':
      clearCache()
      postMessage({ type: 'stats', cacheSize: cacheSize(), queued: client.queued })
      break
  }
}
