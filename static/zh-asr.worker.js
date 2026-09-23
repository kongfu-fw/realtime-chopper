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
 * file. We fetch the two files we actually want and empty that manifest, so the
 * 362 MB / Mandarin-only CTC pack never enters the picture.
 *
 * How those two files reach the runtime — this is the part that decides whether
 * a phone can run the module at all, so it is worth being explicit. The demo's
 * own route is to concatenate them into a `.data` blob and let the packager XHR
 * it: that materialises the 228 MB model as an ArrayBuffer in the JavaScript
 * heap, which the generated loader then pins on `DataRequest.prototype.byteArray`
 * *for the lifetime of the worker*, on top of the browser-side blob it was read
 * from. Two and a half copies of the largest file in the app, one of them
 * permanent, is what an iPhone runs out of.
 *
 * So we skip the packager for these files: after the runtime is up we write them
 * into its Emscripten file system ourselves with `FS_createDataFile(…, canOwn)`,
 * which stores our buffer instead of copying it, and once the recognizer has read
 * the weights into its ONNX session we unlink the file *and* drop our own array —
 * leaving one copy of the model in this worker instead of two, and none of it
 * resident after startup. Same files, same runtime, ~228 MB less.
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
/**
 * The model bytes we handed to the runtime's file system, kept here so they can
 * be dropped once the recognizer owns them. `null` means we hold no reference.
 */
let mountedModel = null
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
    const tokensBytes = downloaded.tokens
    const modelBytes = downloaded.model

    const glueText = await fetchText(ASSETS.glue.url)
    const mainText = await fetchText(ASSETS.main.url)
    const runtimeBytes = downloaded.wasm.byteLength + ASSETS.glue.bytes + ASSETS.main.bytes
    note(`运行环境与模型文件已就绪（${Math.round((modelBytes.byteLength + runtimeBytes) / 1048576)}MB）`)

    // Empty preload list: everything the runtime needs is written into its file
    // system by hand below. If this pattern ever stops matching, say so instead
    // of silently falling back to the demo's 367 MB pack.
    const patched = mainText.replace(
      /loadPackage\(\{"files":\[[^\]]*\],"remote_package_size":\d+\}\)/,
      'loadPackage({"files":[],"remote_package_size":0})',
    )
    if (patched === mainText) {
      throw new Error('运行时的资源清单格式变了，需要重新核对 static/zh-asr.worker.js')
    }

    post({ type: 'load-progress', status: '初始化识别模块' })

    const ready = new Promise((resolve) => {
      self.Module = {
        // The generated loader asks for `sherpa-onnx-wasm-main-vad-asr.data` and
        // would XHR the whole thing into a single ArrayBuffer it never releases.
        // Handing it an empty one skips that path entirely — see the file header.
        getPreloadedPackage: () => new ArrayBuffer(0),
        // The same argument for the 11 MB runtime: bytes instead of a fetch.
        wasmBinary: downloaded.wasm,
        // Nothing should need this any more (no `.wasm`, no `.data`), but a
        // future asset must not silently resolve to a wrong relative path.
        locateFile: (path) => {
          debug(`locateFile(${path})`)
          return SPACE + path
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
    try {
      self.importScripts(scriptUrl(glueWithExport), scriptUrl(patched))
    } catch (first) {
      // A WebKit build that refuses `blob:` URLs inside `importScripts` would fail
      // right here — after the 228 MB download, which is the worst possible moment.
      // `data:` is the fallback spelling of the same trick, and the breadcrumb says
      // which one was used, so a report from a phone can tell us if it ever fires.
      caution(`blob 脚本没能加载（${describe(first)}），改试 data: URL`)
      try {
        self.importScripts(dataScriptUrl(glueWithExport), dataScriptUrl(patched))
      } catch (second) {
        throw new Error(`运行环境的脚本没能加载：${describe(second)}`)
      }
    }
    await ready
    note(`运行时初始化完成（${Math.round(performance.now() - startedAt)}ms）`)

    const Module = self.Module
    if (typeof self.OfflineRecognizer !== 'function') {
      throw new Error('运行环境没有导出 OfflineRecognizer，无法识别中文')
    }
    if (!Module || typeof Module._SherpaOnnxFileExists !== 'function') {
      throw new Error('运行环境没有加载完整，无法读取模型文件')
    }
    if (typeof Module.FS_createDataFile !== 'function') {
      throw new Error('运行环境没有提供文件系统，无法写入模型文件')
    }

    // `canOwn` is the whole point: the file system keeps *this* buffer instead of
    // copying it, so the 228 MB model exists once in this worker rather than
    // twice. The tokens stay mounted for the lifetime of the recognizer.
    Module.FS_createDataFile('/', 'tokens.txt', tokensBytes, true, true, true)
    Module.FS_createDataFile('/', 'model.int8.onnx', modelBytes, true, true, true)
    mountedModel = modelBytes
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
    note(`识别器就绪（${Math.round(performance.now() - startedAt)}ms）`)
    // The model has been read into the recognizer's own session by now; both the
    // copy in the virtual file system and the array we kept to write it are dead
    // weight, and on a phone they are the difference between fitting and not.
    releaseModelFile(Module, recognizer)
    void pruneCache()
  })()
  try {
    await booting
  } catch (err) {
    // A failed boot must not poison every later attempt.
    booting = null
    recognizer = null
    mountedModel = null
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

/**
 * Breadcrumbs, with the level they belong at.
 *
 * They used to be dropped on the floor by the main thread, which made a failure
 * that only ever happens on a phone — where there is no console to read —
 * unexplainable. The milestones below are one-liners per boot, so they belong at
 * `info` (the default level); only the per-file chatter stays at `debug`.
 */
function debug(message) {
  post({ type: 'log', level: 'debug', message })
}

function note(message) {
  post({ type: 'log', level: 'info', message })
}

function caution(message) {
  post({ type: 'log', level: 'warn', message })
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

/**
 * The same script as a `data:` URL.
 *
 * Only reachable when blob URLs are refused; `encodeURIComponent` (rather than
 * base64) keeps the text readable in a stack trace and needs no TextEncoder round
 * trip.
 */
function dataScriptUrl(text) {
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(text)}`
}

/**
 * Gives the 228 MB model file back to the runtime's file system.
 *
 * sherpa-onnx reads the ONNX weights into its own session while the recognizer is
 * constructed, so from that moment both the copy in Emscripten's file system and
 * the array we handed to it are dead weight — and on a phone that dead weight is
 * most of what decides whether the page fits in memory at all (WebKit hands a
 * page roughly 1–1.5 GB, and this module peaks far above that once the model, the
 * session and the runtime are all resident).
 *
 * It is dropped only after one throwaway decode has proven the recognizer works
 * without it: the opposite failure — a silent read of a file that is no longer
 * there, 228 MB into a session — would be far worse than the memory it saves.
 */
function releaseModelFile(Module, recognizer) {
  let stream = null
  try {
    stream = recognizer.createStream()
    stream.acceptWaveform(SAMPLE_RATE, new Float32Array(1600)) // 100 ms of silence
    recognizer.decode(stream)
    recognizer.getResult(stream)
  } catch (err) {
    caution(`模型自检解码失败，保留文件副本（${describe(err)}）`)
    return
  } finally {
    try {
      stream && stream.free && stream.free()
    } catch {
      /* the runtime owns this memory */
    }
  }

  const unlink =
    typeof Module.FS_unlink === 'function'
      ? (path) => Module.FS_unlink(path)
      : Module.FS && typeof Module.FS.unlink === 'function'
        ? (path) => Module.FS.unlink(path)
        : null
  if (!unlink) {
    caution('运行环境没有提供 unlink，模型文件留在内存里')
    return
  }
  for (const path of [MODEL, '/model.int8.onnx', 'model.int8.onnx']) {
    try {
      unlink(path)
      // Both halves of the release matter: the file system held our buffer, and
      // this worker held the only other reference to it.
      mountedModel = null
      note(`已释放模型字节（约 ${Math.round(ASSETS.model.bytes / 1048576)}MB）`)
      return
    } catch {
      /* the runtime may resolve its working directory differently */
    }
  }
  caution('模型文件没有释放成功，识别本身不受影响')
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
  const assets = {}
  let done = 0
  for (let i = 0; i < ORDER.length; i++) {
    const key = ORDER[i]
    const remaining = ORDER.slice(i + 1).reduce((sum, k) => sum + ASSETS[k].bytes, 0)
    assets[key] = await fetchIntoCache(ASSETS[key].url, LABELS[key], ASSETS[key].bytes, {
      // Everything already fetched, so the fraction describes the module and not
      // the file: what is downloaded + what this file has + what is still ahead.
      offset: done,
      ceiling: done + ASSETS[key].bytes + remaining,
      total,
    })
    done += assets[key].byteLength
  }
  return assets
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
 * Streams a large asset into Cache Storage while reporting progress, and returns
 * it as one exact-size array.
 *
 * Deliberately no Blob anywhere on this path. The previous version parked the
 * 228 MB model in blob storage and read it back through XHR, which left the
 * browser holding the bytes offline *and* the fetched ArrayBuffer live — and the
 * generated packager never lets go of that ArrayBuffer. One array we own, and can
 * release ourselves, is the cheapest the model can be before the ONNX session
 * copies it into the WebAssembly heap.
 */
async function fetchIntoCache(url, label, fallbackBytes, scale) {
  const cache = await openCache()
  if (cache) {
    const hit = await cache.match(url).catch(() => undefined)
    if (hit) {
      const bytes = new Uint8Array(await hit.arrayBuffer())
      report(label + '（已缓存）', scale.offset + bytes.byteLength, scale)
      return bytes
    }
  }

  const response = await fetch(url)
  if (!response.ok) throw new Error(`${label}失败：HTTP ${response.status}`)
  // The CDN does not always send content-length through its redirect, so the
  // measured size is the better denominator when it is missing. It is also what
  // lets us allocate the destination array once instead of growing it.
  const expected = Number(response.headers.get('content-length') || 0) || fallbackBytes

  // Tee keeps one copy flowing to the cache and the other to the progress bar.
  let body = response
  let progressBody = null
  if (cache && response.body && typeof response.body.tee === 'function') {
    const [reporting, storing] = response.body.tee()
    body = new Response(storing, { headers: response.headers })
    progressBody = reporting
  }

  const storePromise = cache ? cache.put(url, body).catch(() => undefined) : Promise.resolve()
  const bytes = progressBody
    ? await readIntoProgress(progressBody, scale, label, expected)
    : new Uint8Array(await response.arrayBuffer())
  if (!progressBody) report(label, scale.offset + bytes.byteLength, scale)
  await storePromise
  return bytes
}

/**
 * Fills one pre-allocated array from a response body, reporting as it goes.
 *
 * Holding the body as a list of chunks and joining them at the end would cost a
 * second copy of the whole file at exactly the wrong moment; allocating up front
 * costs one array and one 8 MB chunk at a time. If the response turns out to be
 * bigger than advertised the tail is buffered separately and joined once — rare,
 * and announced in the log rather than silently doubling the peak.
 */
async function readIntoProgress(stream, scale, label, expected) {
  const reader = stream.getReader()
  const target = new Uint8Array(Math.max(1, expected))
  let filled = 0
  let received = 0
  let overflow = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value || !value.byteLength) continue
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
    if (!overflow && filled + chunk.byteLength <= target.byteLength) {
      target.set(chunk, filled)
      filled += chunk.byteLength
    } else {
      if (!overflow) {
        overflow = []
        caution(`${label}比声明的大小更大，末尾另存后再拼一次`)
      }
      overflow.push(chunk)
    }
    received += chunk.byteLength
    report(label, scale.offset + received, scale)
  }
  if (!overflow) return filled === target.byteLength ? target : target.subarray(0, filled)
  const joined = new Uint8Array(received)
  joined.set(target.subarray(0, filled), 0)
  let at = filled
  for (const chunk of overflow) {
    joined.set(chunk, at)
    at += chunk.byteLength
  }
  return joined
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
