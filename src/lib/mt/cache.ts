import { normalizeKey } from './text'

/**
 * Translation cache.
 *
 * The key deliberately includes the provider id, the model, the prompt version
 * and the language pair, not just the sentence. A cache keyed on text alone
 * would happily serve a Google translation after the user switched to an LLM
 * (or after a prompt change), which is the kind of bug that looks like "the
 * setting does nothing".
 */

const MAX_ENTRIES = 4000

const store = new Map<string, string>()

export function cacheKey(input: {
  provider: string
  model: string
  promptVersion: string
  sl: string
  tl: string
  text: string
}): string {
  return [input.provider, input.model, input.promptVersion, input.sl, input.tl, normalizeKey(input.text)].join('|')
}

export function getCached(key: string): string | undefined {
  const hit = store.get(key)
  if (hit === undefined) return undefined
  // Refresh recency: delete + set moves the entry to the end of insertion order.
  store.delete(key)
  store.set(key, hit)
  return hit
}

export function putCached(key: string, value: string): void {
  if (!value) return
  store.set(key, value)
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
  }
}

export function cacheSize(): number {
  return store.size
}

export function clearCache(): void {
  store.clear()
}
