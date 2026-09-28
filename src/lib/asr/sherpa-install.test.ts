import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createContext, runInContext } from 'node:vm'

/**
 * The sherpa worker's install pass, driven for real.
 *
 * `static/sherpa-asr.worker.js` is a *classic* worker script (the runtime it loads
 * is two classic scripts that must be evaluated into the global scope), so it
 * cannot be imported. It is evaluated here instead, in a context with a stubbed
 * `self`, `caches` and `fetch`, and its `downloadPack` is called directly.
 *
 * What that buys is the part no one can check by eye: the arithmetic behind the
 * one bar in the install dialog, and which bytes reach the network. Neither is
 * cosmetic. The runtime is ~11.7 MB that `ensureRuntime` has already fetched and
 * parked on `Module.wasmBinary` by the time this function runs, so it belongs in
 * the denominator and not in the pass — reading it a second time to measure it put
 * another 11.7 MB array in the JavaScript heap at the exact moment the 239 MB model
 * needs that room, which is the phase a phone dies in.
 *
 * Node resolves ESM specifiers literally, so the imports carry their extension.
 */

const SOURCE = readFileSync(
  new URL('../../../static/sherpa-asr.worker.js', import.meta.url),
  'utf8',
)

/**
 * The pack these tests install: the real shape (a word list and a big weight file,
 * role-keyed, with the size each one declares to the bar), small enough to serve
 * from memory. The labels are the Chinese source text the worker's own packs use,
 * because the error path translates them.
 */
const PACK = {
  cache: 'test-sherpa-zh',
  repo: 'https://assets.test/sherpa-zh/',
  weights: 'model',
  files: {
    tokens: { name: 'tokens.txt', bytes: 20000, label: '词表' },
    model: { name: 'model.int8.onnx', bytes: 50000, label: '中文模型' },
  },
} as const

type Role = keyof typeof PACK.files

/** Total bytes the bar is asked to account for, before the runtime's share. */
const DECLARED = PACK.files.tokens.bytes + PACK.files.model.bytes

/**
 * One worker, with a network and a Cache Storage behind it.
 *
 * `missing` makes the named file 404, which is the failure this pass has to
 * survive honestly: a half-installed module must never look installed.
 */
function installer(options: { chunk?: number; missing?: string } = {}) {
  const chunk = options.chunk ?? 8192
  const served = new Map<string, Uint8Array>()
  const fetched: string[] = []
  const buckets = new Map<string, Map<string, Uint8Array>>()
  const messages: Array<Record<string, unknown>> = []

  for (const role of Object.keys(PACK.files) as Role[]) {
    const file = PACK.files[role]
    if (file.name === options.missing) continue
    served.set(PACK.repo + file.name, new Uint8Array(file.bytes).fill(role === 'model' ? 7 : 3))
  }

  /**
   * A body that arrives in pieces, so that progress is reported while a file is
   * still coming in rather than once at the end — which is the only way a wrong
   * offset can show up as a bar that jumps or goes backwards.
   */
  const chunked = (bytes: Uint8Array) => {
    let at = 0
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= bytes.byteLength) {
          controller.close()
          return
        }
        controller.enqueue(bytes.subarray(at, Math.min(at + chunk, bytes.byteLength)))
        at += chunk
      },
    })
  }

  /** Just enough of the Cache Storage interface for this worker's three uses. */
  const openBucket = (name: string) => {
    const entries = buckets.get(name) ?? new Map<string, Uint8Array>()
    buckets.set(name, entries)
    return {
      match: async (url: string) => {
        const bytes = entries.get(url)
        // `slice` rather than the array itself: a cache hit has to hand back a
        // body whose view does not alias the buffer the previous response owned.
        return bytes ? new Response(bytes.slice()) : undefined
      },
      put: async (url: string, response: Response) => {
        entries.set(url, new Uint8Array(await response.arrayBuffer()))
      },
      keys: async () => [...entries.keys()].map((url) => ({ url })),
      delete: async (url: string) => entries.delete(url),
    }
  }

  const sandbox: Record<string, unknown> = {
    performance,
    console,
    Response,
    ReadableStream,
    URL,
    Blob,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    caches: { open: async (name: string) => openBucket(name) },
    fetch: async (url: string) => {
      fetched.push(url)
      const bytes = served.get(url)
      if (!bytes) return new Response('missing', { status: 404 })
      return new Response(chunked(bytes), {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) },
      })
    },
  }

  const context = createContext(sandbox)
  sandbox.self = sandbox
  sandbox.postMessage = (message: Record<string, unknown>) => {
    messages.push(message)
  }
  runInContext(SOURCE, context, { filename: 'static/sherpa-asr.worker.js' })

  // `downloadPack` is a function declaration in a classic script, and `RUNTIME` is
  // a `const` in the same context's global lexical scope: both are reachable from
  // a later script in that context, which is how the runtime's own size is read
  // here instead of being copied into this file as a second, drifting constant.
  const worker = runInContext('({ downloadPack, RUNTIME })', context) as {
    downloadPack: (pack: unknown) => Promise<Record<string, Uint8Array>>
    RUNTIME: { wasm: { url: string; bytes: number } }
  }

  return { worker, messages, fetched }
}

/** The progress events, in the order they were posted. */
function progressOf(messages: Array<Record<string, unknown>>) {
  return messages
    .filter((message) => message.type === 'load-progress' && typeof message.progress === 'number')
    .map((message) => ({
      status: message.status as string,
      loaded: message.loaded as number,
      total: message.total as number,
      progress: message.progress as number,
    }))
}

test('安装：运行时算进分母，但不再被这个流程下载第二遍', async () => {
  const { worker, messages, fetched } = installer()
  const assets = await worker.downloadPack(PACK)
  const runtimeBytes = worker.RUNTIME.wasm.bytes

  // The runtime is already in the cache and on `Module.wasmBinary`; fetching it
  // again to measure it is what this pass stopped doing.
  assert.equal(
    fetched.includes(worker.RUNTIME.wasm.url),
    false,
    'the install pass fetched the runtime a second time',
  )
  assert.deepEqual(fetched, [PACK.repo + 'tokens.txt', PACK.repo + 'model.int8.onnx'])

  // And the bytes still arrive, under the roles `mountPack` looks them up by.
  assert.deepEqual(Object.keys(assets).sort(), ['model', 'tokens'])
  assert.equal(assets.tokens!.byteLength, PACK.files.tokens.bytes)
  assert.equal(assets.model!.byteLength, PACK.files.model.bytes)

  const events = progressOf(messages)
  assert.ok(events.length > 4, `only ${events.length} progress events for two files`)
  for (const event of events) assert.equal(event.total, runtimeBytes + DECLARED)

  // The bar starts at the runtime's share — those bytes really did come down, one
  // step earlier — and the first chunk reported is the word list's.
  assert.equal(events[0]!.loaded, runtimeBytes + 8192)
  // It lands on exactly 1 when the last chunk of the last file arrives, which is
  // what tells the dialog the install is complete rather than merely stalled. The
  // loop above is why it cannot land past it.
  const last = events.at(-1)!
  assert.equal(last.loaded, runtimeBytes + DECLARED)
  assert.equal(last.progress, 1)
})

test('安装：条形图只会前进，两个文件的分母是同一个', async () => {
  const { worker, messages } = installer({ chunk: 4096 })
  await worker.downloadPack(PACK)
  const events = progressOf(messages)

  // One download must not look like three: every event is measured against the
  // whole module, so the second file continues where the first one stopped instead
  // of snapping the bar back to zero.
  for (let i = 1; i < events.length; i++) {
    assert.ok(
      events[i]!.progress >= events[i - 1]!.progress,
      `the bar went backwards: ${events[i - 1]!.progress} then ${events[i]!.progress}`,
    )
    assert.equal(events[i]!.total, events[0]!.total)
  }
  // 20000 + 50000 bytes in 4096-byte pieces, so several events per file — the
  // monotonicity check above is not vacuous at this chunk size.
  assert.ok(events.length >= 18, `only ${events.length} events in 4096-byte chunks`)
})

test('安装：缓存热了以后不走网络，条形图落在同一处', async () => {
  const { worker, messages, fetched } = installer()
  await worker.downloadPack(PACK)
  const cold = progressOf(messages).at(-1)!.progress
  assert.equal(cold, 1)

  fetched.length = 0
  messages.length = 0
  const assets = await worker.downloadPack(PACK)

  // A second install of the same module: the cache answers everything, so the
  // network sees nothing, the bytes are the same, and the bar still finishes.
  assert.deepEqual(fetched, [])
  assert.equal(assets.model!.byteLength, PACK.files.model.bytes)
  const warm = progressOf(messages).at(-1)!
  assert.equal(warm.progress, 1)
  assert.equal(warm.total, progressOf(messages)[0]!.total)
})

test('安装：一个文件 404 时整体失败，且失败前分母已算进运行时', async () => {
  const { worker, messages, fetched } = installer({ missing: 'model.int8.onnx' })
  let failure: unknown = null
  try {
    await worker.downloadPack(PACK)
  } catch (err) {
    failure = err
  }

  assert.ok(failure, 'a missing model file did not fail the install')
  // The label is translated at the error site, which is why it has to be the
  // Chinese source text: the user reads this line, not the file name.
  assert.match(String((failure as Error).message), /中文模型/)
  assert.match(String((failure as Error).message), /404/)
  assert.deepEqual(fetched, [PACK.repo + 'tokens.txt', PACK.repo + 'model.int8.onnx'])

  const events = progressOf(messages)
  assert.ok(events.length > 0)
  assert.equal(events[0]!.total, worker.RUNTIME.wasm.bytes + DECLARED)
})
