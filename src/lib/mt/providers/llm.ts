import type { LlmFormat, MtContext, MtProvider } from '../types'
import { MtError } from '../types'
import { languageName } from '../lang'

/**
 * User-supplied LLM as an extra translation option.
 *
 * Three things this provider must get right:
 *  1. The key stays on this device. It is read from localStorage, sent only to
 *     the endpoint the user configured, and never logged (the logger redacts
 *     key-shaped strings as a second line of defence).
 *  2. Batching has to be verifiable. Free-form model output cannot be trusted
 *     to preserve sentence count, so we demand a numbered list and reject the
 *     response when the count does not match — the client then splits the batch
 *     into single sentences, which is also the cheaper failure mode.
 *  3. It is slow. Real latency is recorded in the log so the user can see why
 *     the lag number climbs when an LLM is selected; the settings screen warns
 *     about it in plain language.
 *
 * Note on browsers: OpenAI-compatible and Gemini endpoints answer preflighted
 * browser requests, and Anthropic requires the
 * `anthropic-dangerous-direct-browser-access` header to do so. Nothing here
 * needs a server.
 */

export const PROMPT_VERSION = 'llm-v1'

const SYSTEM_PROMPT = (from: string, to: string, count: number) =>
  [
    `You are a translation engine. Translate each numbered line from ${from} to ${to}.`,
    `Output exactly ${count} line${count === 1 ? '' : 's'}, each in the form "<n>. <translation>", keeping the original numbering.`,
    'Translate only. Never explain, never merge lines, never add or remove lines.',
  ].join(' ')

function buildUserPrompt(texts: string[]): string {
  return texts.map((text, index) => `${index + 1}. ${text}`).join('\n')
}

/** Parses "<n>. text" lines back into an array, or returns null when unusable. */
export function parseNumberedLines(raw: string, expected: number): string[] | null {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length !== expected) return null
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\d+)\s*[.)、:]\s*(.*)$/.exec(lines[i]!)
    if (!match || Number(match[1]) !== i + 1) return null
    out.push(match[2]!.trim())
  }
  return out
}

export function createLlmProvider(): MtProvider {
  return {
    id: 'llm',
    label: 'AI 模型',
    supportsBatch: true,

    async translate(texts: string[], ctx: MtContext): Promise<string[]> {
      const llm = ctx.llm
      if (!llm) throw new MtError('还没有配置 AI 模型', { retryable: false })
      if (!llm.baseUrl.trim() || !llm.model.trim()) {
        throw new MtError('AI 模型的地址和名称不能为空', { retryable: false })
      }
      if (llm.format !== 'gemini' && !llm.apiKey.trim()) {
        throw new MtError('AI 模型需要填写密钥', { retryable: false })
      }
      const system = SYSTEM_PROMPT(languageName(ctx.sl), languageName(ctx.tl), texts.length)
      const user = buildUserPrompt(texts)
      const raw = await callLlm(llm, system, user, ctx.signal)
      const parsed = parseNumberedLines(raw, texts.length)
      if (!parsed) {
        throw new MtError('AI 模型返回的格式不符合要求（编号行数不匹配）', { retryable: false })
      }
      return parsed
    },
  }
}

async function callLlm(
  llm: { format: LlmFormat; baseUrl: string; model: string; apiKey: string },
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
  if (llm.format === 'anthropic') return callAnthropic(llm, system, user, signal)
  if (llm.format === 'gemini') return callGemini(llm, system, user, signal)
  return callOpenAiCompatible(llm, system, user, signal)
}

async function callOpenAiCompatible(
  llm: { baseUrl: string; model: string; apiKey: string },
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
  const base = llm.baseUrl.replace(/\/+$/, '')
  const url = base.endsWith('/chat/completions')
    ? base
    : `${base}/chat/completions`
  const payload = await postJson(
    url,
    { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
    {
      model: llm.model,
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    },
    signal,
  )
  const content = (payload as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message
    ?.content
  if (typeof content !== 'string') throw new MtError('AI 模型没有返回文本内容', { retryable: false })
  return content
}

async function callAnthropic(
  llm: { baseUrl: string; model: string; apiKey: string },
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
  const base = (llm.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '')
  const payload = await postJson(
    `${base}/v1/messages`,
    {
      'Content-Type': 'application/json',
      'x-api-key': llm.apiKey,
      'anthropic-version': '2023-06-01',
      // Required for direct browser access; verified working from a page origin.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    {
      model: llm.model,
      max_tokens: 2048,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: user }],
    },
    signal,
  )
  const blocks = (payload as { content?: { type?: string; text?: unknown }[] })?.content
  const text = Array.isArray(blocks)
    ? blocks.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n')
    : ''
  if (!text.trim()) throw new MtError('AI 模型没有返回文本内容', { retryable: false })
  return text
}

async function callGemini(
  llm: { baseUrl: string; model: string; apiKey: string },
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
  const base = (llm.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '')
  const url = `${base}/models/${encodeURIComponent(llm.model)}:generateContent?key=${encodeURIComponent(llm.apiKey)}`
  const payload = await postJson(
    url,
    { 'Content-Type': 'application/json' },
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0 },
    },
    signal,
  )
  const parts = (payload as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] })?.candidates?.[0]
    ?.content?.parts
  const text = Array.isArray(parts) ? parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : ''
  if (!text.trim()) throw new MtError('AI 模型没有返回文本内容', { retryable: false })
  return text
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
  } catch (err) {
    throw new MtError(`AI 模型网络错误：${err instanceof Error ? err.message : String(err)}`, {
      retryable: true,
      cause: err,
    })
  }
  const text = await response.text()
  if (!response.ok) {
    throw new MtError(`AI 模型返回 HTTP ${response.status}：${text.slice(0, 200)}`, {
      retryable: response.status === 429 || response.status >= 500,
      status: response.status,
    })
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new MtError('AI 模型的响应不是 JSON', { retryable: false })
  }
}
