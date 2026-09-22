/*
 * Chinese recognition worker.
 *
 * Runs SenseVoice-Small (int8, ~228 MB) on sherpa-onnx's own browser WASM
 * build. SenseVoice is the right model for this app and always was: it is
 * non-autoregressive (one forward pass per utterance, roughly an order of
 * magnitude faster than Whisper's token-by-token decode), and it recognises
 * Chinese, English, Japanese, Korean and Cantonese in one model with inverse
 * text normalisation — so Chinese speech with English words inside it survives,
 * which a Mandarin-only CTC model cannot do.
 *
 * What was actually missing was never the model, it was the runtime:
 *   - the npm `sherpa-onnx` package is Node-only (`require('./…-nodejs.js')`,
 *     no ESM exports), so it cannot be imported into a worker;
 *   - no release ships a runtime-only WASM artifact any more;
 *   - k2-fsa.github.io, where the prebuilt browser runtime lives, is not
 *     reachable from mainland networks (plain fetch *and* importScripts fail).
 * The runtime we use comes from k2-fsa's published browser demo on
 * HuggingFace, pinned to the commit it was verified against.
 *
 * Why this is a plain classic script in `static/` rather than a TypeScript
 * module under `src/workers/` like the other two workers: that runtime is a pair
 * of *classic* scripts that must be evaluated in order into the global scope —
 *
 *   sherpa-onnx-asr.js            defines the OfflineRecognizer class
 *   sherpa-onnx-wasm-main-*.js    boots emscripten, which reads the pre-existing
 *                                 global `Module` object and calls
 *                                 `Module.onRuntimeInitialized`
 *
 * `importScripts` does not exist in a module worker, and `import()` of the same
 * files would scope their `var Module` / `class OfflineRecognizer` to the module
 * instead of the global, so that handshake cannot happen. A classic worker is
 * the only way to load the runtime as published.
 *
 * The model pack is ours rather than the demo's: that build embeds a resource
 * manifest in its JS (a fixed offset table for /silero_vad.onnx, /tokens.txt and
 * a 367 MB /zipformer-ctc.onnx) and the packager then fetches one big `.data`
 * file. We fetch the two files we actually want, rewrite that manifest to match
 * them, and hand the runtime a `.data` blob composed from them — the runtime's
 * own loading path, with our contents. 240 MB instead of 362 MB, and no
 * Mandarin-only CTC model.
 *
 * The message protocol is byte-for-byte the one in src/workers/asr.worker.ts, so
 * the main thread cannot tell which of the two workers answered:
 *
 *   in   { type:'load', lang, preference, precision }
 *        { type:'recognize', id, samples, startMs, endMs }
 *        { type:'dispose' }
 *   out  { type:'load-progress', lang?, status, file?, progress?, loaded?, total? }
 *        { type:'loaded', lang, device, reason }
 *        { type:'result', id, startMs, endMs, text, rawText, engine, inferMs, durationMs }
 *        { type:'error', where, lang?, id?, message }
 *        { type:'disposed' }
 */

/** Runtime, pinned to the commit this worker was verified against. */
const SPACE =
  'https://huggingface.co/spaces/k2-fsa/web-assembly-vad-asr-sherpa-onnx-zh-zipformer-ctc/resolve/9d5fc71d88ab1222ed1af2274fb194592af48455/'
/** Model, pinned to the commit whose bytes these sizes were measured from. */
const MODEL_REPO =
  'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/'

/** Cache Storage bucket: the runtime and the model survive a reload. */
const CACHE = 'rc-model-zh-sherpa-zh'

/**
 * `bytes` is the measured size, used as the progress denominator because the CDN
 * does not always send content-length through its redirect, and a download bar
 * stuck on "…" for a 228 MB file is worse than a slightly stale estimate.
 */
const ASSETS = {
  glue: { url: SPACE + 'sherpa-onnx-asr.js', bytes: 47391 },
  main: { url: SPACE + 'sherpa-onnx-wasm-main-vad-asr.js', bytes: 95308 },
  wasm: { url: SPACE + 'sherpa-onnx-wasm-main-vad-asr.wasm', bytes: 11722172 },
  model: { url: MODEL_REPO + 'model.int8.onnx', bytes: 239233841 },
  tokens: { url: MODEL_REPO + 'tokens.txt', bytes: 315894 },
}

const SAMPLE_RATE = 16000
/** Paths *inside* the emscripten filesystem. */
const MODEL = './model.int8.onnx'
const TOKENS = './tokens.txt'

/** What each asset is called while it is being downloaded. */
const LABELS = {
  tokens: '下载词表',
  model: '下载中文模型',
  wasm: '下载运行环境',
}
/** Download order: smallest first, so the bar moves immediately. */
const ORDER = ['tokens', 'model', 'wasm']

let recognizer = null
let booting = null
let blobUrls = []
/** The large assets, tracked separately so they can be dropped after boot. */
let largeBlobs = []
let chain = Promise.resolve()
/** Highest fraction reported so far; the bar must never move backwards. */
let lastFraction = 0

self.onmessage = (event) => {
  const msg = event.data
  switch (msg.type) {
    case 'load':
      chain = chain.then(() => handleLoad(msg.lang))
      break
    case 'recognize':
      chain = chain.then(() => handleRecognize(msg.id, msg.samples, msg.startMs, msg.endMs))
      break
    case 'dispose':
      chain = chain.then(() => handleDispose())
      break
    default:
      break
  }
}

async function handleLoad(lang) {
  if (recognizer) {
    post({ type: 'loaded', lang, device: 'wasm', reason: '模型已在内存中' })
    return
  }
  try {
    await boot()
    post({
      type: 'loaded',
      lang,
      device: 'wasm',
      reason: 'sherpa-onnx WASM + SenseVoice Small int8（CPU）',
    })
  } catch (err) {
    // The install dialog leans on this: a failed install must never look installed.
    post({ type: 'error', where: 'load', lang, message: describe(err) })
  }
}

async function boot() {
  if (booting) return booting
  booting = (async () => {
    lastFraction = 0
    const downloaded = await downloadAssets()
    const tokensBlob = downloaded.tokens
    const modelBlob = downloaded.model
    const wasmBlob = downloaded.wasm

    const glueText = await fetchText(ASSETS.glue.url)
    const mainText = await fetchText(ASSETS.main.url)
    const runtimeBytes = wasmBlob.size + ASSETS.glue.bytes + ASSETS.main.bytes
    debug(`运行环境与本机模型就绪（${Math.round((modelBlob.size + runtimeBytes) / 1048576)}MB）`)

    // Tell the runtime's packager to preload *our* two files instead of the
    // demo's 367 MB zipformer pack. The manifest is the only part of the build we
    // rewrite, and if its shape ever changes we say so instead of hanging.
    const manifest = `{"files":[{"filename":"/tokens.txt","start":0,"end":${tokensBlob.size}},` +
      `{"filename":"/model.int8.onnx","start":${tokensBlob.size},"end":${tokensBlob.size + modelBlob.size}}],` +
      `"remote_package_size":${tokensBlob.size + modelBlob.size}}`
    const patched = mainText.replace(
      /loadPackage\(\{"files":\[[^\]]*\],"remote_package_size":\d+\}\)/,
      `loadPackage(${manifest})`,
    )
    if (patched === mainText) {
      throw new Error('运行时的资源清单格式变了，需要重新核对 static/zh-asr.worker.js')
    }

    // Blob parts share storage rather than copying, so composing the pack costs
    // no extra 228 MB. Cache Storage still holds the two files separately.
    const dataUrl = blobUrl(new Blob([tokensBlob, modelBlob]))
    const wasmUrl = blobUrl(wasmBlob)
    largeBlobs = [dataUrl, wasmUrl]

    post({ type: 'load-progress', status: '初始化识别模块' })

    const ready = new Promise((resolve) => {
      self.Module = {
        // The packager asks for '…wasm' / '…data' by name; hand back the blobs we
        // already downloaded instead of making it fetch them again.
        locateFile: (path) => {
          const mapped = path.endsWith('.wasm') ? wasmUrl : path.endsWith('.data') ? dataUrl : SPACE + path
          debug(`locateFile(${path})`)
          return mapped
        },
        setStatus: (status) => {
          if (status) post({ type: 'load-progress', status: String(status).slice(0, 80) })
        },
        print: () => {},
        printErr: () => {},
        onRuntimeInitialized: () => resolve(),
      }
    })

    // Classic-text evaluation, in the order the official demo loads them. The
    // glue's `class OfflineRecognizer` is a *script-scope lexical* declaration: it
    // is only reachable as a bare identifier and never becomes a property of the
    // global object, so the appended line re-exports it explicitly. Without that,
    // `self.OfflineRecognizer` is undefined even though the class loaded fine —
    // which is exactly how this failed the first time.
    const glueWithExport = `${glueText}\n;self.OfflineRecognizer = OfflineRecognizer;\n`
    const startedAt = performance.now()
    self.importScripts(scriptUrl(glueWithExport), scriptUrl(patched))
    await ready
    debug(`运行时初始化完成（${Math.round(performance.now() - startedAt)}ms）`)

    // The runtime has unpacked both files by now; dropping the browser-side copies
    // keeps a phone from holding the same 240 MB twice.
    releaseLargeBlobs()

    const Module = self.Module
    if (typeof self.OfflineRecognizer !== 'function') {
      throw new Error('运行环境没有导出 OfflineRecognizer，无法识别中文')
    }
    if (!Module || typeof Module._SherpaOnnxFileExists !== 'function') {
      throw new Error('运行环境没有加载完整，无法读取模型文件')
    }
    if (!fileExists(Module, MODEL.slice(2))) {
      throw new Error('模型没有写进运行时的文件系统')
    }

    recognizer = new self.OfflineRecognizer(
      {
        modelConfig: {
          debug: 0,
          tokens: TOKENS,
          // Exactly the three keys the runtime's SenseVoice branch reads;
          // "auto" lets the model itself decide the language of each utterance.
          senseVoice: {
            model: MODEL,
            language: 'auto',
            useInverseTextNormalization: 1,
          },
        },
      },
      Module,
    )
    if (!recognizer || typeof recognizer.createStream !== 'function') {
      recognizer = null
      throw new Error('识别器创建失败')
    }
    debug(`识别器就绪（${Math.round(performance.now() - startedAt)}ms）`)
    void pruneCache()
  })()
  try {
    await booting
  } catch (err) {
    // A failed boot must not poison every later attempt.
    booting = null
    recognizer = null
    revokeBlobUrls()
    throw err
  }
}

async function handleRecognize(id, samples, startMs, endMs) {
  if (!recognizer) {
    post({ type: 'error', where: 'recognize', id, message: '识别模块还没准备好' })
    return
  }
  let stream = null
  try {
    const started = performance.now()
    stream = recognizer.createStream()
    stream.acceptWaveform(SAMPLE_RATE, samples)
    recognizer.decode(stream)
    const result = recognizer.getResult(stream)
    const text = (result && result.text) || ''
    post({
      type: 'result',
      id,
      startMs,
      endMs,
      text,
      rawText: text,
      engine: 'sherpa-sensevoice-int8',
      inferMs: Math.round(performance.now() - started),
      durationMs: Math.round((samples.length / SAMPLE_RATE) * 1000),
    })
  } catch (err) {
    post({ type: 'error', where: 'recognize', id, message: describe(err) })
  } finally {
    try {
      stream && stream.free && stream.free()
    } catch {
      /* the runtime owns this memory; a failed free is not worth surfacing */
    }
  }
}

async function handleDispose() {
  try {
    if (recognizer && recognizer.free) recognizer.free()
  } catch {
    /* ignore */
  }
  recognizer = null
  booting = null
  revokeBlobUrls()
  post({ type: 'disposed' })
}

/* ------------------------------------------------------------------ helpers */

function post(message) {
  self.postMessage(message)
}

/** Diagnostic breadcrumbs; the client ignores this type by design. */
function debug(message) {
  post({ type: 'debug', message })
}

function describe(err) {
  const message = err && err.message ? err.message : String(err)
  return message.length > 200 ? message.slice(0, 200) + '…' : message
}

function blobUrl(blob) {
  const url = URL.createObjectURL(blob)
  blobUrls.push(url)
  return url
}

function releaseLargeBlobs() {
  for (const url of largeBlobs) {
    try {
      URL.revokeObjectURL(url)
    } catch {
      /* ignore */
    }
    const index = blobUrls.indexOf(url)
    if (index >= 0) blobUrls.splice(index, 1)
  }
  largeBlobs = []
}

function revokeBlobUrls() {
  for (const url of blobUrls) {
    try {
      URL.revokeObjectURL(url)
    } catch {
      /* ignore */
    }
  }
  blobUrls = []
}

/**
 * `importScripts` needs a real URL; the sources are fetched first so a wrong MIME
 * type from the CDN cannot silently stop the runtime from evaluating.
 */
function scriptUrl(text) {
  return blobUrl(new Blob([text], { type: 'text/javascript' }))
}

function fileExists(Module, name) {
  const length = Module.lengthBytesUTF8(name) + 1
  const buffer = Module._malloc(length)
  try {
    Module.stringToUTF8(name, buffer, length)
    return Module._SherpaOnnxFileExists(buffer) === 1
  } finally {
    Module._free(buffer)
  }
}

/**
 * Downloads the module in one pass, reporting progress against the whole module.
 *
 * The dialog has a single bar, so the numbers have to be cumulative: reporting
 * each file against itself (a 300 KB word list, then 228 MB of model, then an
 * 11 MB runtime) makes one download look like three, and each one ends by
 * snapping the bar back to zero.
 */
async function downloadAssets() {
  const total = ORDER.reduce((sum, key) => sum + ASSETS[key].bytes, 0)
  const blobs = {}
  let done = 0
  for (let i = 0; i < ORDER.length; i++) {
    const key = ORDER[i]
    const remaining = ORDER.slice(i + 1).reduce((sum, k) => sum + ASSETS[k].bytes, 0)
    blobs[key] = await fetchIntoCache(ASSETS[key].url, LABELS[key], ASSETS[key].bytes, {
      // Everything already fetched, so the fraction describes the module and not
      // the file: what is downloaded + what this file has + what is still ahead.
      offset: done,
      ceiling: done + ASSETS[key].bytes + remaining,
      total,
    })
    done += blobs[key].size
  }
  return blobs
}

async function fetchText(url) {
  const cache = await openCache()
  if (cache) {
    const hit = await cache.match(url).catch(() => undefined)
    if (hit) return hit.text()
  }
  const response = await fetch(url)
  if (!response.ok) throw new Error(`运行环境下载失败：HTTP ${response.status}`)
  const text = await response.text()
  if (cache) {
    cache.put(url, new Response(text, { headers: { 'content-type': 'text/javascript' } })).catch(() => undefined)
  }
  return text
}

/**
 * Streams a large asset into Cache Storage while reporting progress, without
 * holding a second copy of a 228 MB body in memory.
 */
async function fetchIntoCache(url, label, fallbackBytes, scale) {
  const cache = await openCache()
  if (cache) {
    const hit = await cache.match(url).catch(() => undefined)
    if (hit) {
      const blob = await hit.blob()
      report(label + '（已缓存）', scale.offset + blob.size, scale)
      return blob
    }
  }

  const response = await fetch(url)
  if (!response.ok) throw new Error(`${label}失败：HTTP ${response.status}`)
  // The CDN does not always send content-length through its redirect, so the
  // measured size is the better denominator when it is missing.
  const fileBytes = Number(response.headers.get('content-length') || 0) || fallbackBytes

  // Tee keeps one copy flowing to the cache and the other to the progress bar.
  let body = response
  let progressBody = null
  if (cache && response.body && typeof response.body.tee === 'function') {
    const [reporting, storing] = response.body.tee()
    body = new Response(storing, { headers: response.headers })
    progressBody = reporting
  }

  const storePromise = cache ? cache.put(url, body).catch(() => undefined) : Promise.resolve()
  const blob = progressBody
    ? await readWithProgress(progressBody, scale, label)
    : await response.blob().then((b) => {
        report(label, scale.offset + b.size, scale)
        return b
      })
  await storePromise
  return blob
}

async function readWithProgress(stream, scale, label) {
  const reader = stream.getReader()
  const chunks = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      loaded += value.byteLength
      report(label, scale.offset + loaded, scale)
    }
  }
  return new Blob(chunks)
}

/**
 * `loaded` is cumulative over the whole module; `ceiling` is what the total looks
 * like once this file has arrived, used only when the module total is unknown.
 */
function report(label, loaded, scale) {
  const denominator = scale.total || scale.ceiling || loaded
  const fraction = denominator > 0 ? Math.min(1, loaded / denominator) : undefined
  const progress = fraction === undefined ? undefined : Math.max(lastFraction, fraction)
  if (progress !== undefined) lastFraction = progress
  post({
    type: 'load-progress',
    status: label,
    file: label,
    loaded,
    total: denominator,
    progress,
  })
}

/**
 * Drops anything in our cache that is no longer one of our assets.
 *
 * Cache Storage is quota-managed and a phone has very little of it: the earlier
 * build of this worker cached a 367 MB demo pack, and without this that entry
 * would sit there forever next to the 240 MB this one needs.
 */
async function pruneCache() {
  try {
    const cache = await openCache()
    if (!cache) return
    const keep = new Set(Object.values(ASSETS).map((asset) => asset.url))
    const keys = await cache.keys()
    let dropped = 0
    for (const request of keys) {
      if (keep.has(request.url)) continue
      await cache.delete(request)
      dropped += 1
    }
    if (dropped > 0) debug(`已清理 ${dropped} 个过期缓存条目`)
  } catch {
    /* quota handling is best-effort; never let cleanup break a working engine */
  }
}

function openCache() {
  if (typeof caches === 'undefined') return Promise.resolve(null)
  return caches.open(CACHE).catch(() => null)
}
