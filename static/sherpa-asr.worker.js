/*
 * sherpa-onnx recognition worker.
 *
 * Runs the one module whose runtime is sherpa-onnx's browser WASM build:
 *
 *   zh  — SenseVoice-Small (int8, ~228 MB), Chinese/Korean
 *
 * It is the right model for Chinese and always was: non-autoregressive (one
 * forward pass per utterance, roughly an order of magnitude faster than Whisper's
 * token-by-token decode), and it recognises Chinese, English, Japanese, Korean and
 * Cantonese in one model with inverse text normalisation — so Chinese speech with
 * English words inside it survives, which a Mandarin-only CTC model cannot do.
 *
 * This worker used to serve a second module as well (`en-nemo`, NVIDIA Parakeet on
 * the same runtime). It is gone and the pack table below says why; what matters
 * here is that the *runtime* stays, because `zh` is built out of it. See
 * `src/lib/asr/models.ts` for the registry these ids mirror, and
 * `src/workers/asr.worker.ts` for the module-worker counterpart.
 *
 * What was actually missing was never the model, it was the runtime:
 *   - the npm `sherpa-onnx` package is Node-only (`require('./…-nodejs.js')`,
 *     no ESM exports), so it cannot be imported into a worker;
 *   - no release ships a runtime-only WASM artifact any more;
 *   - k2-fsa.github.io, where the prebuilt browser runtime lives, is not
 *     reachable from mainland networks (plain fetch *and* importScripts fail).
 * The runtime we use comes from k2-fsa's published browser demo on HuggingFace,
 * pinned to the commit it was verified against.
 *
 * Why this is a plain classic script in `static/` rather than a TypeScript module
 * under `src/workers/` like the other two workers: that runtime is a pair of
 * *classic* scripts that must be evaluated in order into the global scope —
 *
 *   sherpa-onnx-asr.js            defines the OfflineRecognizer class
 *   sherpa-onnx-wasm-main-*.js    boots emscripten, which reads the pre-existing
 *                                 global `Module` object and calls
 *                                 `Module.onRuntimeInitialized`
 *
 * `importScripts` does not exist in a module worker, and `import()` of the same
 * files would scope their `var Module` / `class OfflineRecognizer` to the module
 * instead of the global, so that handshake cannot happen. A classic worker is the
 * only way to load the runtime as published.
 *
 * The model packs are ours rather than the demo's: that build embeds a resource
 * manifest in its JS (a fixed offset table for /silero_vad.onnx, /tokens.txt and a
 * 367 MB /zipformer-ctc.onnx) and the packager then fetches one big `.data` file.
 * We fetch the files we actually want and empty that manifest, so the 362 MB /
 * Mandarin-only CTC pack never enters the picture.
 *
 * How those files reach the runtime — this is the part that decides whether a
 * phone can run a module at all, so it is worth being explicit. The demo's own
 * route is to concatenate them into a `.data` blob and let the packager XHR it:
 * that materialises the model as an ArrayBuffer in the JavaScript heap, which the
 * generated loader then pins on `DataRequest.prototype.byteArray` *for the
 * lifetime of the worker*, on top of the browser-side blob it was read from. Two
 * and a half copies of the largest file in the app, one of them permanent, is
 * what an iPhone runs out of.
 *
 * So we skip the packager for these files: after the runtime is up we write them
 * into its Emscripten file system ourselves with `FS_createDataFile(…, canOwn)`,
 * which stores our buffer instead of copying it, and once the recognizer has read
 * the weights into its ONNX session we unlink the file — leaving one copy of the
 * model inside the session instead of two in this worker, and none of it resident
 * after startup. Same files, same runtime, ~240 MB less.
 *
 * The message protocol is byte-for-byte the one in src/workers/asr.worker.ts, so
 * the main thread cannot tell which of the two workers answered:
 *
 *   in   { type:'load', module, plan }
 *        { type:'recognize', id, samples, startMs, endMs }
 *        { type:'dispose' }
 *   out  { type:'load-progress', module?, status, file?, progress?, loaded?, total? }
 *        { type:'loaded', module, device, reason }
 *        { type:'result', id, startMs, endMs, text, rawText, engine, inferMs, durationMs }
 *        { type:'error', where, module?, id?, message }
 *        { type:'disposed' }
 */

/** Runtime, pinned to the commit this worker was verified against. */
const SPACE =
  'https://huggingface.co/spaces/k2-fsa/web-assembly-vad-asr-sherpa-onnx-zh-zipformer-ctc/resolve/9d5fc71d88ab1222ed1af2274fb194592af48455/'

/**
 * The runtime is the same bytes for every module, so it gets its own cache bucket
 * rather than a copy inside each module's.
 *
 * Two reasons, one of them a real bug in the obvious design: a per-module bucket
 * would store the 11 MB wasm twice on a device that has both modules, and —
 * worse — `pruneBucket` below deletes anything in a bucket that is not one of
 * *that bucket's* assets, so sharing one bucket between modules would have each
 * module silently evict the other's model the first time it pruned.
 */
const RUNTIME_CACHE = 'rc-model-sherpa-runtime'

/**
 * `bytes` is the measured size, used as the progress denominator because the CDN
 * does not always send content-length through its redirect, and a download bar
 * stuck on "…" for a 200 MB file is worse than a slightly stale estimate.
 */
const RUNTIME = {
  glue: { url: SPACE + 'sherpa-onnx-asr.js', bytes: 47391 },
  main: { url: SPACE + 'sherpa-onnx-wasm-main-vad-asr.js', bytes: 95308 },
  wasm: { url: SPACE + 'sherpa-onnx-wasm-main-vad-asr.wasm', bytes: 11722172 },
}

const SAMPLE_RATE = 16000

/**
 * One entry per module this worker can serve.
 *
 * `files` is keyed by role (`model`, `tokens`) because the recognizer config below
 * needs to name them by path, while the download order and the progress bar need
 * them by size. Keeping the remote filename in the same table is what lets those
 * two stay in step.
 */
const PACKS = {
  zh: {
    cache: 'rc-model-zh-sherpa-zh',
    repo:
      'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/',
    engine: 'sherpa-sensevoice-int8',
    reason: 'sherpa-onnx WASM + SenseVoice Small int8（CPU）',
    files: {
      tokens: { name: 'tokens.txt', bytes: 315894, label: '下载词表' },
      model: { name: 'model.int8.onnx', bytes: 239233841, label: '下载中文模型' },
    },
    config: (paths) => ({
      modelConfig: {
        debug: 0,
        tokens: paths.tokens,
        // Exactly the three keys the runtime's SenseVoice branch reads; "auto"
        // lets the model itself decide the language of each utterance, which is
        // what makes one download serve both Chinese and Korean.
        senseVoice: {
          model: paths.model,
          language: 'auto',
          useInverseTextNormalization: 1,
        },
      },
    }),
  },
  // `en-nemo` sat here: NVIDIA Parakeet TDT-CTC 110M int8, English, punctuated,
  // served through the `nemoCtc` branch of this same runtime. Measured against
  // Moonshine on the same audio it lost — after Moonshine's four threads it was
  // 1.8× slower (521→291 ms against Parakeet's 448 ms), twice the download, and
  // its punctuation turned out not to be an advantage (Moonshine punctuates too),
  // so English goes back to being one module and this table has one entry.
  //
  // Kept as a note rather than deleted, because the shape is reusable if an
  // English model ever lands on this runtime again: `modelConfig: { tokens,
  // nemoCtc: { model } }` with **no** `featConfig`, since the export carries its
  // own `normalize_type`, `subsampling_factor` and `vocab_size` in the ONNX
  // metadata and the runtime configures the feature frontend from those.
}

/**
 * Where inside the emscripten file system each pack's files are written.
 *
 * Prefixed with the module id rather than using the remote filename: every pack on
 * this runtime ships a `tokens.txt`, so a worker that has mounted two modules in
 * its lifetime would otherwise have to overwrite the file the first one's
 * recognizer is still pointing at.
 */
const FS_PATHS = {
  zh: { model: './model.zh.int8.onnx', tokens: './tokens.zh.txt' },
}

/** The built recognizer, its module, and the runtime they belong to. */
let recognizer = null
let loadedModule = null
/** The loaded Emscripten module. One per worker, shared by every pack. */
let runtimeModule = null
/** In-flight runtime init, so two loads cannot boot it twice. */
let runtimeBooting = null
/** Which module's files are currently in the emscripten file system. */
let mountedModule = null
let blobUrls = []
let chain = Promise.resolve()
/** Highest fraction reported so far; the bar must never move backwards. */
let lastFraction = 0

self.onmessage = (event) => {
  const msg = event.data
  switch (msg.type) {
    case 'load':
      // `module` is the current spelling; `lang` is what an older cached copy of
      // this script reads (a worker stays in the HTTP cache across a reload). Both
      // resolve to the same thing for `zh`, which is the module such a copy knows.
      chain = chain.then(() => handleLoad(msg.module || msg.lang))
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

async function handleLoad(module) {
  const pack = PACKS[module]
  if (!pack) {
    // A build/cache mismatch is the only way here (the main thread's registry and
    // this table are edited together), and saying so beats building a Chinese
    // recognizer because the id happened to be truthy.
    post({ type: 'error', where: 'load', module, message: `这个版本不认识识别模块 ${module}` })
    return
  }
  if (recognizer && loadedModule === module) {
    post({ type: 'loaded', module, device: 'wasm', reason: '模型已在内存中' })
    return
  }
  try {
    await boot(module, pack)
    post({ type: 'loaded', module, device: 'wasm', reason: pack.reason })
  } catch (err) {
    // The install dialog leans on this: a failed install must never look installed.
    post({ type: 'error', where: 'load', module, message: describe(err) })
  }
}

/**
 * Brings up the runtime (once per worker) and then the requested module.
 *
 * Split in two because the halves have different lifetimes: the runtime is ~11 MB
 * of wasm that is identical for every module and worth keeping, while a module's
 * recognizer holds the entire model and is rebuilt whenever the module changes.
 * Only one recognizer is ever alive — that is the memory budget the whole design
 * rests on — so switching modules frees the old one first.
 *
 * Nothing here is latched: the message chain above serialises loads, so a retry
 * after a failure simply runs again, which is how a device that was briefly out of
 * memory gets a second chance without a page reload.
 */
async function boot(module, pack) {
  const Module = await ensureRuntime()
  lastFraction = 0
  const downloaded = await downloadPack(pack)
  const paths = mountPack(Module, module, downloaded)

  post({ type: 'load-progress', status: '初始化识别模块' })

  freeRecognizer()
  recognizer = new self.OfflineRecognizer(pack.config(paths), Module)
  if (!recognizer || typeof recognizer.createStream !== 'function') {
    recognizer = null
    throw new Error('识别器创建失败')
  }
  loadedModule = module
  // The model has been read into the recognizer's own session by now; both the
  // copy in the virtual file system and the array we handed to it are dead weight,
  // and on a phone that dead weight is most of what decides whether the page fits.
  releaseModelFile(Module, recognizer, pack, paths.model)
}

/**
 * Starts the Emscripten runtime, or returns the one already running.
 *
 * A failed init must not poison every later attempt, so the latch is cleared and
 * the half-built global dropped: emscripten's own `Module` is what every path
 * here reads, and leaving a broken one in place would turn one transient failure
 * into a permanently dead worker.
 */
async function ensureRuntime() {
  if (runtimeModule) return runtimeModule
  if (!runtimeBooting) runtimeBooting = initRuntime()
  try {
    runtimeModule = await runtimeBooting
    return runtimeModule
  } catch (err) {
    runtimeBooting = null
    self.Module = undefined
    throw err
  }
}

async function initRuntime() {
  const startedAt = performance.now()
  const wasmBytes = await fetchIntoCache(
    RUNTIME_CACHE,
    RUNTIME.wasm.url,
    '下载运行环境',
    RUNTIME.wasm.bytes,
  )
  const glueText = await fetchText(RUNTIME_CACHE, RUNTIME.glue.url)
  const mainText = await fetchText(RUNTIME_CACHE, RUNTIME.main.url)
  note(
    `运行环境已就绪（${Math.round(
      (wasmBytes.byteLength + RUNTIME.glue.bytes + RUNTIME.main.bytes) / 1048576,
    )}MB）`,
  )

  // Empty preload list: everything the runtime needs is written into its file
  // system by hand below. If this pattern ever stops matching, say so instead of
  // silently falling back to the demo's 367 MB pack.
  const patched = mainText.replace(
    /loadPackage\(\{"files":\[[^\]]*\],"remote_package_size":\d+\}\)/,
    'loadPackage({"files":[],"remote_package_size":0})',
  )
  if (patched === mainText) {
    throw new Error('运行时的资源清单格式变了，需要重新核对 static/sherpa-asr.worker.js')
  }

  post({ type: 'load-progress', status: '初始化运行环境' })

  const ready = new Promise((resolve) => {
    self.Module = {
      // The generated loader asks for `sherpa-onnx-wasm-main-vad-asr.data` and
      // would XHR the whole thing into a single ArrayBuffer it never releases.
      // Handing it an empty one skips that path entirely — see the file header.
      getPreloadedPackage: () => new ArrayBuffer(0),
      // The same argument for the 11 MB runtime: bytes instead of a fetch.
      wasmBinary: wasmBytes,
      // Nothing should need this any more (no `.wasm`, no `.data`), but a future
      // asset must not silently resolve to a wrong relative path.
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

  // Classic-text evaluation, in the order the official demo loads them. The glue's
  // `class OfflineRecognizer` is a *script-scope lexical* declaration: it is only
  // reachable as a bare identifier and never becomes a property of the global
  // object, so the appended line re-exports it explicitly. Without that,
  // `self.OfflineRecognizer` is undefined even though the class loaded fine —
  // which is exactly how this failed the first time.
  const glueWithExport = `${glueText}\n;self.OfflineRecognizer = OfflineRecognizer;\n`
  try {
    self.importScripts(scriptUrl(glueWithExport), scriptUrl(patched))
  } catch (first) {
    // A WebKit build that refuses `blob:` URLs inside `importScripts` would fail
    // right here — after a full model download, which is the worst possible
    // moment. `data:` is the fallback spelling of the same trick, and the
    // breadcrumb says which one was used, so a report from a phone can tell us if
    // it ever fires.
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
    throw new Error('运行环境没有导出 OfflineRecognizer，无法识别语音')
  }
  if (!Module || typeof Module._SherpaOnnxFileExists !== 'function') {
    throw new Error('运行环境没有加载完整，无法读取模型文件')
  }
  if (typeof Module.FS_createDataFile !== 'function') {
    throw new Error('运行环境没有提供文件系统，无法写入模型文件')
  }
  return Module
}

/**
 * Writes one module's bytes into the runtime's file system.
 *
 * `canOwn` is the whole point: the file system keeps *this* buffer instead of
 * copying it, so a 228 MB model exists once in this worker rather than twice. The
 * tokens stay mounted for the lifetime of the recognizer; the model does not. No
 * reference to either is kept here, so once the file system lets go — see
 * `releaseModelFile` — nothing else pins the bytes.
 *
 * The previous pack's files are dropped first: the tokens are still mounted from
 * the earlier module and would otherwise sit in the file system for the rest of
 * this worker's life.
 */
function mountPack(Module, module, downloaded) {
  const paths = FS_PATHS[module]
  if (mountedModule && mountedModule !== module) {
    const previous = FS_PATHS[mountedModule]
    unlink(Module, [previous.tokens, previous.model])
    mountedModule = null
  }
  Module.FS_createDataFile('/', paths.tokens.slice(2), downloaded.tokens, true, true, true)
  Module.FS_createDataFile('/', paths.model.slice(2), downloaded.model, true, true, true)
  mountedModule = module
  if (!fileExists(Module, paths.model.slice(2))) {
    throw new Error('模型没有写进运行时的文件系统')
  }
  return paths
}

/**
 * Downloads one module in one pass, reporting progress against the whole module.
 *
 * The dialog has a single bar, so the numbers have to be cumulative: reporting
 * each file against itself (a 300 KB word list, then 126 MB of model, then an
 * 11 MB runtime) makes one download look like three, and each one ends by
 * snapping the bar back to zero.
 *
 * The runtime is part of the same pass on purpose — from the user's side it is one
 * install, and the denominator is what the bar is measured against. On a second
 * module it is already cached, so it costs two cache reads and the bar finishes
 * early rather than lying about how much is left.
 */
async function downloadPack(pack) {
  const items = [
    ...Object.keys(pack.files).map((key) => ({
      key,
      cache: pack.cache,
      url: pack.repo + pack.files[key].name,
      bytes: pack.files[key].bytes,
      label: pack.files[key].label,
    })),
    {
      key: 'wasm',
      cache: RUNTIME_CACHE,
      url: RUNTIME.wasm.url,
      bytes: RUNTIME.wasm.bytes,
      label: '下载运行环境',
    },
  ]
  const total = items.reduce((sum, item) => sum + item.bytes, 0)
  const assets = {}
  let done = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const remaining = items.slice(i + 1).reduce((sum, next) => sum + next.bytes, 0)
    assets[item.key] = await fetchIntoCache(item.cache, item.url, item.label, item.bytes, {
      // Everything already fetched, so the fraction describes the module and not
      // the file: what is downloaded + what this file has + what is still ahead.
      offset: done,
      ceiling: done + item.bytes + remaining,
      total,
    })
    done += assets[item.key].byteLength
  }
  note(`模型文件已就绪（约 ${Math.round(assets.model.byteLength / 1048576)}MB）`)
  void pruneCache(pack)
  return assets
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
      // The engine that answered, so the line in the transcript carries the same
      // provenance whoever produced it. A stale/unknown module id must not throw
      // away an otherwise good transcript.
      engine: loadedModule && PACKS[loadedModule] ? PACKS[loadedModule].engine : 'sherpa-unknown',
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
  freeRecognizer()
  revokeBlobUrls()
  post({ type: 'disposed' })
}

/** Frees the recognizer and forgets its module, so the next load rebuilds it. */
function freeRecognizer() {
  try {
    if (recognizer && recognizer.free) recognizer.free()
  } catch {
    /* ignore */
  }
  recognizer = null
  loadedModule = null
}

/* ------------------------------------------------------------------ helpers */

/**
 * Unlinks a path, trying the spellings the runtime might have registered it under.
 *
 * Returns false only when the runtime offers no unlink at all: "file not found" is
 * indistinguishable from "already gone" here, and both are the state we want.
 */
function unlink(Module, paths) {
  const drop =
    typeof Module.FS_unlink === 'function'
      ? (path) => Module.FS_unlink(path)
      : Module.FS && typeof Module.FS.unlink === 'function'
        ? (path) => Module.FS.unlink(path)
        : null
  if (!drop) return false
  for (const path of paths) {
    for (const spelling of [path, path.replace(/^\.\//, ''), '/' + path.replace(/^\.\//, '')]) {
      try {
        drop(spelling)
        break
      } catch {
        /* the runtime may resolve its working directory differently */
      }
    }
  }
  return true
}

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
 * Gives the model file back to the runtime's file system.
 *
 * sherpa-onnx reads the ONNX weights into its own session while the recognizer is
 * constructed, so from that moment both the copy in Emscripten's file system and
 * the array we handed to it are dead weight — and on a phone that dead weight is
 * most of what decides whether the page fits in memory at all (WebKit hands a page
 * roughly 1–1.5 GB, and a module peaks far above that once the model, the session
 * and the runtime are all resident).
 *
 * It is dropped only after one throwaway decode has proven the recognizer works
 * without it: the opposite failure — a silent read of a file that is no longer
 * there, 228 MB into a session — would be far worse than the memory it saves.
 */
function releaseModelFile(Module, recognizer, pack, modelPath) {
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

  if (!unlink(Module, [modelPath])) {
    caution('运行环境没有提供 unlink，模型文件留在内存里')
    return
  }
  note(`已释放模型字节（约 ${Math.round(pack.files.model.bytes / 1048576)}MB）`)
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

async function fetchText(cacheName, url) {
  const cache = await openCache(cacheName)
  if (cache) {
    const hit = await cache.match(url).catch(() => undefined)
    if (hit) return hit.text()
  }
  const response = await fetch(url)
  if (!response.ok) throw new Error(`运行环境下载失败：HTTP ${response.status}`)
  const text = await response.text()
  if (cache) {
    cache
      .put(url, new Response(text, { headers: { 'content-type': 'text/javascript' } }))
      .catch(() => undefined)
  }
  return text
}

/**
 * Streams a large asset into Cache Storage while reporting progress, and returns
 * it as one exact-size array.
 *
 * Deliberately no Blob anywhere on this path. An earlier version parked the model
 * in blob storage and read it back through XHR, which left the browser holding the
 * bytes offline *and* the fetched ArrayBuffer live — and the generated packager
 * never lets go of that ArrayBuffer. One array we own, and can release ourselves,
 * is the cheapest the model can be before the ONNX session copies it into the
 * WebAssembly heap.
 *
 * `scale` is absent for the runtime wasm, which is fetched before any progress
 * accounting exists; the file still reports its own bytes, just without a fraction.
 */
async function fetchIntoCache(cacheName, url, label, fallbackBytes, scale) {
  const offset = scale ? scale.offset : 0
  const cache = await openCache(cacheName)
  if (cache) {
    const hit = await cache.match(url).catch(() => undefined)
    if (hit) {
      const bytes = new Uint8Array(await hit.arrayBuffer())
      if (scale) report(label, offset + bytes.byteLength, scale)
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
    ? await readIntoProgress(progressBody, scale, label, expected, offset)
    : new Uint8Array(await response.arrayBuffer())
  if (!progressBody && scale) report(label, offset + bytes.byteLength, scale)
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
async function readIntoProgress(stream, scale, label, expected, offset) {
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
    if (scale) report(label, offset + received, scale)
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
 * Drops anything in this module's cache that is no longer one of its assets.
 *
 * Cache Storage is quota-managed and a phone has very little of it: an earlier
 * build of this worker cached a 367 MB demo pack, and without this that entry
 * would sit there forever next to the model this one needs.
 */
async function pruneCache(pack) {
  await pruneBucket(pack.cache, Object.values(pack.files).map((file) => pack.repo + file.name))
  await pruneBucket(RUNTIME_CACHE, Object.values(RUNTIME).map((asset) => asset.url))
}

async function pruneBucket(cacheName, keepUrls) {
  try {
    const cache = await openCache(cacheName)
    if (!cache) return
    const keep = new Set(keepUrls)
    let dropped = 0
    for (const request of await cache.keys()) {
      if (keep.has(request.url)) continue
      await cache.delete(request)
      dropped += 1
    }
    if (dropped > 0) debug(`已从 ${cacheName} 清理 ${dropped} 个过期缓存条目`)
  } catch {
    /* quota handling is best-effort; never let cleanup break a working engine */
  }
}

function openCache(name) {
  if (typeof caches === 'undefined') return Promise.resolve(null)
  return caches.open(name).catch(() => null)
}
