/*
 * sherpa-onnx recognition worker.
 *
 * Runs the modules whose runtime is sherpa-onnx's browser WASM build:
 *
 *   zh  — SenseVoice-Small (int8, ~228 MB), Chinese
 *   ko  — Zipformer Korean (int8, ~73 MB), Korean
 *
 * SenseVoice is the right model for Chinese and always was: non-autoregressive (one
 * forward pass per utterance, roughly an order of magnitude faster than Whisper's
 * token-by-token decode), and it recognises Chinese, English, Japanese, Korean and
 * Cantonese in one model with inverse text normalisation — so Chinese speech with
 * English words inside it survives, which a Mandarin-only CTC model cannot do.
 *
 * This worker used to serve a second module as well (`en-nemo`, NVIDIA Parakeet on
 * the same runtime). It is gone and the pack table below says why; what matters
 * here is that the *runtime* stays, because both modules above are built out of
 * it — one download of wasm serves every language that does not go through a
 * transformers.js model. See `src/lib/asr/models.ts` for the registry these ids
 * mirror, and `src/workers/asr.worker.ts` for the module-worker counterpart.
 *
 * The two packs differ in shape, not just in bytes: SenseVoice is one graph with a
 * language it picks itself, and Korean is a *transducer* — encoder, decoder and
 * joiner as three files, decoded greedily without an LM. That difference is
 * confined to the `config` builder of each pack; everything around it (download,
 * mount, self-check, release) is written against the pack's file table.
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
 * The languages this worker can speak, for the lines it writes itself.
 *
 * A worker is a separate thread with its own copy of everything — but this file is
 * not even a module: it is a *classic* script served as-is (see the header), so it
 * cannot import `src/lib/i18n`. The table below is the whole of it, keyed by the
 * Chinese source text exactly as in the app, so one message reads the same in the
 * log drawer whichever side produced it.
 *
 * The interface language arrives with the load message (`uiLang`) and is applied
 * in `setLang`; anything the worker says before that is Chinese, which is the
 * language the app itself falls back to.
 */
const MESSAGES = {
  en: {
    '这个版本不认识识别模块 {module}': 'This build does not know the recognition module {module}',
    '模型已在内存中': 'The model is already in memory',
    'sherpa-onnx WASM + SenseVoice Small int8（CPU）': 'sherpa-onnx WASM + SenseVoice Small int8 (CPU)',
    'sherpa-onnx WASM + Zipformer 韩语 int8（CPU）': 'sherpa-onnx WASM + Korean Zipformer int8 (CPU)',
    '下载词表': 'Downloading the vocabulary',
    '下载中文模型': 'Downloading the Chinese model',
    '下载韩语模型': 'Downloading the Korean model',
    '下载韩语模型解码器': 'Downloading the Korean model’s decoder',
    '下载韩语模型连接器': 'Downloading the Korean model’s joiner',
    '下载运行环境': 'Downloading the runtime',
    '初始化识别模块': 'Initialising the recognition module',
    '初始化运行环境': 'Initialising the runtime',
    '识别器创建失败': 'creating the recogniser failed',
    '运行时的资源清单格式变了，需要重新核对 static/sherpa-asr.worker.js':
      'The runtime’s asset manifest changed shape; static/sherpa-asr.worker.js needs another look',
    '运行环境已就绪（{mb}MB）': 'Runtime ready ({mb}MB)',
    'blob 脚本没能加载（{why}），改试 data: URL': 'The blob script would not load ({why}); trying a data: URL',
    '运行环境的脚本没能加载：{why}': 'The runtime scripts would not load: {why}',
    '运行时初始化完成（{ms}ms）': 'Runtime initialised ({ms}ms)',
    'wasm 堆 {mb}MB（{step}）': 'WebAssembly heap {mb}MB ({step})',
    '运行环境起来后': 'after the runtime came up',
    '模型挂进文件系统后': 'after the model files were mounted',
    '识别器建好后': 'after the recogniser was built',
    '模型字节交出去之后': 'after the model bytes were handed over',
    '已下载 {what}（{mb}MB）': 'Downloaded {what} ({mb}MB)',
    '运行环境没有导出 OfflineRecognizer，无法识别语音': 'The runtime exposed no OfflineRecognizer, so it cannot recognise speech',
    '运行环境没有加载完整，无法读取模型文件': 'The runtime did not finish loading, so the model files cannot be read',
    '运行环境没有提供文件系统，无法写入模型文件': 'The runtime has no filesystem, so the model files cannot be written',
    '模型没有写进运行时的文件系统': 'The model was not written into the runtime’s filesystem',
    '模型文件已就绪（约 {mb}MB）': 'Model files ready (about {mb}MB)',
    '识别模块还没准备好': 'The recognition module is not ready yet',
    '模型自检解码失败，保留文件副本（{why}）':
      'The model failed its own decode check; keeping a copy of the files ({why})',
    '运行环境没有提供 unlink，模型文件留在内存里': 'The runtime has no unlink, so the model files stay in memory',
    '已释放模型字节（约 {mb}MB）': 'Released the model bytes (about {mb}MB)',
    '运行环境下载失败：HTTP {status}': 'Downloading the runtime failed: HTTP {status}',
    '{what}失败：HTTP {status}': '{what} failed: HTTP {status}',
    '{what}比声明的大小更大，末尾另存后再拼一次':
      '{what} is larger than declared; saving the tail separately and stitching it on',
    '已从 {cache} 清理 {n} 个过期缓存条目': 'Cleared {n} stale cache entries from {cache}',
  },
  ko: {
    '这个版本不认识识别模块 {module}': '이 버전은 인식 모듈 {module}을(를) 모릅니다',
    '模型已在内存中': '모델이 이미 메모리에 있습니다',
    'sherpa-onnx WASM + SenseVoice Small int8（CPU）': 'sherpa-onnx WASM + SenseVoice Small int8(CPU)',
    'sherpa-onnx WASM + Zipformer 韩语 int8（CPU）': 'sherpa-onnx WASM + 한국어 Zipformer int8(CPU)',
    '下载词表': '어휘 목록 내려받는 중',
    '下载中文模型': '중국어 모델 내려받는 중',
    '下载韩语模型': '한국어 모델 내려받는 중',
    '下载韩语模型解码器': '한국어 모델 디코더 내려받는 중',
    '下载韩语模型连接器': '한국어 모델 조이너 내려받는 중',
    '下载运行环境': '런타임 내려받는 중',
    '初始化识别模块': '인식 모듈 초기화 중',
    '初始化运行环境': '런타임 초기화 중',
    '识别器创建失败': '인식기 생성에 실패했습니다',
    '运行时的资源清单格式变了，需要重新核对 static/sherpa-asr.worker.js':
      '런타임 자원 목록 형식이 바뀌었습니다. static/sherpa-asr.worker.js를 다시 확인해야 합니다',
    '运行环境已就绪（{mb}MB）': '런타임 준비 완료({mb}MB)',
    'blob 脚本没能加载（{why}），改试 data: URL': 'blob 스크립트를 불러오지 못했습니다({why}). data: URL로 시도합니다',
    '运行环境的脚本没能加载：{why}': '런타임 스크립트를 불러오지 못했습니다: {why}',
    '运行时初始化完成（{ms}ms）': '런타임 초기화 완료({ms}ms)',
    'wasm 堆 {mb}MB（{step}）': 'wasm 힙 {mb}MB({step})',
    '运行环境起来后': '런타임이 올라온 뒤',
    '模型挂进文件系统后': '모델 파일을 올린 뒤',
    '识别器建好后': '인식기를 만든 뒤',
    '模型字节交出去之后': '모델 바이트를 넘긴 뒤',
    '已下载 {what}（{mb}MB）': '{what} 내려받기 완료({mb}MB)',
    '运行环境没有导出 OfflineRecognizer，无法识别语音':
      '런타임이 OfflineRecognizer를 내보내지 않아 음성을 인식할 수 없습니다',
    '运行环境没有加载完整，无法读取模型文件': '런타임이 완전히 올라오지 않아 모델 파일을 읽을 수 없습니다',
    '运行环境没有提供文件系统，无法写入模型文件': '런타임에 파일 시스템이 없어 모델 파일을 쓸 수 없습니다',
    '模型没有写进运行时的文件系统': '모델이 런타임 파일 시스템에 기록되지 않았습니다',
    '模型文件已就绪（约 {mb}MB）': '모델 파일 준비 완료(약 {mb}MB)',
    '识别模块还没准备好': '인식 모듈이 아직 준비되지 않았습니다',
    '模型自检解码失败，保留文件副本（{why}）': '모델 자체 검사 디코딩이 실패해 파일 사본을 남깁니다({why})',
    '运行环境没有提供 unlink，模型文件留在内存里': '런타임에 unlink가 없어 모델 파일이 메모리에 남습니다',
    '已释放模型字节（约 {mb}MB）': '모델 바이트를 해제했습니다(약 {mb}MB)',
    '运行环境下载失败：HTTP {status}': '런타임 내려받기 실패: HTTP {status}',
    '{what}失败：HTTP {status}': '{what} 실패: HTTP {status}',
    '{what}比声明的大小更大，末尾另存后再拼一次':
      '{what}이(가) 선언된 크기보다 큽니다. 끝부분을 따로 저장해 이어 붙입니다',
    '已从 {cache} 清理 {n} 个过期缓存条目': '{cache}에서 오래된 캐시 항목 {n}개를 정리했습니다',
  },
}

let uiLang = 'zh'

/** The interface language, as the main thread sends it with every load request. */
function setLang(lang) {
  uiLang = lang === 'en' || lang === 'ko' ? lang : 'zh'
}

/** One string, in the language the interface is in. See `MESSAGES` above. */
function t(source, params) {
  const table = uiLang === 'zh' ? null : MESSAGES[uiLang]
  const text = (table && table[source]) || source
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (whole, key) =>
    params[key] === undefined ? whole : String(params[key]),
  )
}

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
    // Chinese source text; `t()` at the moment it is reported, not here.
    reason: 'sherpa-onnx WASM + SenseVoice Small int8（CPU）',
    // Which file holds the weights: what the "ready" note counts, and what gets
    // handed back after the recogniser has read it. Named per pack because the
    // big file of a transducer is its encoder, not a single `model`.
    weights: 'model',
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
  ko: {
    cache: 'rc-model-ko-sherpa-zipformer',
    // k2-fsa's Korean zipformer, pinned to the revision these sizes and this
    // decode path were verified against.
    repo:
      'https://huggingface.co/k2-fsa/sherpa-onnx-zipformer-korean-2024-06-24/resolve/0fb4b2b5c8d3e5766121481ba911961e3649c664/',
    engine: 'sherpa-zipformer-ko-int8',
    reason: 'sherpa-onnx WASM + Zipformer 韩语 int8（CPU）',
    // A transducer: three graphs and no `featConfig`, for the same reason the
    // removed `en-nemo` pack needed none — the encoder export carries its own
    // frontend metadata (sample rate, feature dim, subsampling).
    //
    // No `modelingUnit`/`bpeVocab` either: the pinned runtime keeps the spaces
    // between Hangul syllables as they are (measured on this exact build: ` 그는
    // 괜찮은 척하려고 …`), and passing `bpe` + `bpe.model` changed the text by
    // nothing at all. What *does* remove them is `RemoveSpaceBetweenCjk`, which
    // later sherpa-onnx versions run on every transducer result and whose CJK
    // ranges include Hangul — so this pack's output depends on the runtime pin
    // above. See `src/lib/asr/models.ts` for the measurement and for what an
    // upgrade would cost.
    weights: 'encoder',
    files: {
      tokens: { name: 'tokens.txt', bytes: 60246, label: '下载词表' },
      encoder: { name: 'encoder-epoch-99-avg-1.int8.onnx', bytes: 70784728, label: '下载韩语模型' },
      decoder: { name: 'decoder-epoch-99-avg-1.int8.onnx', bytes: 2844692, label: '下载韩语模型解码器' },
      joiner: { name: 'joiner-epoch-99-avg-1.int8.onnx', bytes: 2581421, label: '下载韩语模型连接器' },
    },
    config: (paths) => ({
      modelConfig: {
        debug: 0,
        tokens: paths.tokens,
        transducer: {
          encoder: paths.encoder,
          decoder: paths.decoder,
          joiner: paths.joiner,
        },
      },
    }),
  },
  // `en-nemo` sat here: NVIDIA Parakeet TDT-CTC 110M int8, English, punctuated,
  // served through the `nemoCtc` branch of this same runtime. Measured against
  // Moonshine on the same audio it lost — after Moonshine's four threads it was
  // 1.8× slower (521→291 ms against Parakeet's 448 ms), twice the download, and
  // its punctuation turned out not to be an advantage (Moonshine punctuates too),
  // so English goes back to being one module — through Moonshine, not this table.
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
  // One entry per file the pack declares, and no two packs may share a path: a
  // worker that has mounted two modules in its lifetime keeps the tokens of the
  // one its recogniser is still pointing at.
  ko: {
    tokens: './tokens.ko.txt',
    encoder: './encoder.ko.int8.onnx',
    decoder: './decoder.ko.int8.onnx',
    joiner: './joiner.ko.int8.onnx',
  },
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
      // resolve to the same thing for `zh`, which is the module such a copy knows
      // — which is why the interface language travels as `uiLang` and not as
      // `lang`, a name this file has already spent.
      setLang(msg.uiLang)
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
    post({
      type: 'error',
      where: 'load',
      module,
      message: t('这个版本不认识识别模块 {module}', { module }),
    })
    return
  }
  if (recognizer && loadedModule === module) {
    post({ type: 'loaded', module, device: 'wasm', reason: t('模型已在内存中') })
    return
  }
  try {
    await boot(module, pack)
    post({ type: 'loaded', module, device: 'wasm', reason: t(pack.reason) })
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

  post({ type: 'load-progress', status: t('初始化识别模块') })

  freeRecognizer()
  recognizer = new self.OfflineRecognizer(pack.config(paths), Module)
  if (!recognizer || typeof recognizer.createStream !== 'function') {
    recognizer = null
    throw new Error(t('识别器创建失败'))
  }
  loadedModule = module
  // The model has been read into the recognizer's own session by now; both the
  // copy in the virtual file system and the array we handed to it are dead weight,
  // and on a phone that dead weight is most of what decides whether the page fits.
  // The heap is read first because the session weights are what it grew for.
  heapNote(Module, '识别器建好后')
  releaseModelFile(Module, recognizer, pack, paths)
  // The other half of the memory story: what the runtime still sits on once the
  // file system and the ONNX sessions have both let go of the weights. An
  // emscripten heap never shrinks, so this is a floor rather than a reading of
  // what a phone could have afforded — but the gap between this line and the one
  // above is the part that was only ever ours to free.
  heapNote(Module, '模型字节交出去之后')
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
    t('下载运行环境'),
    RUNTIME.wasm.bytes,
  )
  const glueText = await fetchText(RUNTIME_CACHE, RUNTIME.glue.url)
  const mainText = await fetchText(RUNTIME_CACHE, RUNTIME.main.url)
  note(
    t('运行环境已就绪（{mb}MB）', {
      mb: Math.round((wasmBytes.byteLength + RUNTIME.glue.bytes + RUNTIME.main.bytes) / 1048576),
    }),
  )

  // Empty preload list: everything the runtime needs is written into its file
  // system by hand below. If this pattern ever stops matching, say so instead of
  // silently falling back to the demo's 367 MB pack.
  const patched = mainText.replace(
    /loadPackage\(\{"files":\[[^\]]*\],"remote_package_size":\d+\}\)/,
    'loadPackage({"files":[],"remote_package_size":0})',
  )
  if (patched === mainText) {
    throw new Error(t('运行时的资源清单格式变了，需要重新核对 static/sherpa-asr.worker.js'))
  }

  post({ type: 'load-progress', status: t('初始化运行环境') })

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
    caution(t('blob 脚本没能加载（{why}），改试 data: URL', { why: describe(first) }))
    try {
      self.importScripts(dataScriptUrl(glueWithExport), dataScriptUrl(patched))
    } catch (second) {
      throw new Error(t('运行环境的脚本没能加载：{why}', { why: describe(second) }))
    }
  }
  await ready
  note(t('运行时初始化完成（{ms}ms）', { ms: Math.round(performance.now() - startedAt) }))

  const Module = self.Module
  if (typeof self.OfflineRecognizer !== 'function') {
    throw new Error(t('运行环境没有导出 OfflineRecognizer，无法识别语音'))
  }
  if (!Module || typeof Module._SherpaOnnxFileExists !== 'function') {
    throw new Error(t('运行环境没有加载完整，无法读取模型文件'))
  }
  if (typeof Module.FS_createDataFile !== 'function') {
    throw new Error(t('运行环境没有提供文件系统，无法写入模型文件'))
  }
  // The floor of this boot's footprint, before a single weight is read.
  heapNote(Module, '运行环境起来后')
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
  const pack = PACKS[module]
  const paths = FS_PATHS[module]
  if (mountedModule && mountedModule !== module) {
    const previous = FS_PATHS[mountedModule]
    unlink(Module, Object.values(previous))
    mountedModule = null
  }
  // Every file the pack declares, by role — the two-file case and the four-file
  // transducer case are the same loop. The tokens stay mounted for the lifetime
  // of the recognizer; the weights do not, and a phone's budget is the reason.
  for (const role of Object.keys(pack.files)) {
    Module.FS_createDataFile('/', paths[role].slice(2), downloaded[role], true, true, true)
  }
  mountedModule = module
  if (!fileExists(Module, paths[pack.weights].slice(2))) {
    throw new Error(t('模型没有写进运行时的文件系统'))
  }
  // `canOwn` above means this should equal the runtime's own heap: our bytes are in
  // the file system as *the same* buffer, not a second copy of it. A number that
  // jumps here would say otherwise.
  heapNote(Module, '模型挂进文件系统后')
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
      // The Chinese source text, like the pack labels: `report` translates it, and
      // the error paths below translate it again for the same reason.
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
    // One breadcrumb per finished file, and on a phone this is the line that
    // matters: the log tail lives in `localStorage`, where a renderer that is
    // killed by the *next* allocation cannot take it away. The bytes are still in
    // the JavaScript heap at this point — the file system only takes them over on
    // mount — which is the phase an iPhone actually dies in, and the one the wasm
    // heap number below cannot see at all.
    note(
      t('已下载 {what}（{mb}MB）', {
        what: t(item.label),
        mb: (assets[item.key].byteLength / 1048576).toFixed(1),
      }),
    )
  }
  note(
    t('模型文件已就绪（约 {mb}MB）', {
      mb: Math.round(assets[pack.weights].byteLength / 1048576),
    }),
  )
  void pruneCache(pack)
  return assets
}

async function handleRecognize(id, samples, startMs, endMs) {
  if (!recognizer) {
    post({ type: 'error', where: 'recognize', id, message: t('识别模块还没准备好') })
    return
  }
  let stream = null
  try {
    const started = performance.now()
    stream = recognizer.createStream()
    stream.acceptWaveform(SAMPLE_RATE, samples)
    recognizer.decode(stream)
    const result = recognizer.getResult(stream)
    // Trimmed because a transducer's first token carries its word boundary: the
    // Korean pack answers ` 그는 괜찮은 …`, with a leading space that is part of the
    // model's output rather than of the sentence. Invisible in the paragraph that
    // renders it, but it travels — into the log lines, the copied transcript and
    // the translation request — so it is dropped here, once.
    const text = ((result && result.text) || '').trim()
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

/**
 * How much memory the runtime itself is sitting on, in whole MB.
 *
 * This is the number that decides whether a phone can run this module at all, and
 * there is no way to ask for it from outside: Safari exposes no memory API, and a
 * page the system kills cannot be questioned afterwards. So each step of the load
 * writes it down *as it goes*, and the log tail — which lives in `localStorage`,
 * where a killed renderer cannot take it — carries the last number back to the
 * next boot.
 *
 * `HEAPU8` is the runtime's own linear memory: the ONNX session allocates the
 * weights out of it, which is why the step that builds the recogniser is the one
 * worth watching. An Emscripten heap never shrinks, so the largest number printed
 * is a floor on the peak, not a guess at it.
 */
function heapMb(Module) {
  try {
    if (Module && Module.HEAPU8 && Module.HEAPU8.length) {
      return Math.round(Module.HEAPU8.length / 1048576)
    }
  } catch {
    /* a build without the exported heap: the line is simply not written */
  }
  return null
}

/** One memory checkpoint. Silent when this runtime does not expose its heap. */
function heapNote(Module, step) {
  const mb = heapMb(Module)
  if (mb !== null) note(t('wasm 堆 {mb}MB（{step}）', { mb, step: t(step) }))
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
 * most of what decides whether the page fits in memory at all. What WebKit hands a
 * page on iOS is measured in *hundreds* of megabytes, not gigabytes (about 100 MB
 * on a 4 GB iPhone, 200 MB on an iPad: lapcatsoftware.com, 2026-01-22, iOS 26.2),
 * which is below this module's own download — so on an iPhone this load cannot
 * succeed, and `moduleTooBigForDevice` in src/lib/asr/models.ts refuses it before
 * the page is risked. Everything here is still worth doing precisely: the runtime
 * is told the heap it needs by the module itself (512 MB, see `heapNote` below),
 * and the two copies above are what a desktop-sized budget makes affordable.
 *
 * It is dropped only after one throwaway decode has proven the recognizer works
 * without it: the opposite failure — a silent read of a file that is no longer
 * there, 228 MB into a session — would be far worse than the memory it saves.
 */
function releaseModelFile(Module, recognizer, pack, paths) {
  let stream = null
  try {
    stream = recognizer.createStream()
    stream.acceptWaveform(SAMPLE_RATE, new Float32Array(1600)) // 100 ms of silence
    recognizer.decode(stream)
    recognizer.getResult(stream)
  } catch (err) {
    caution(t('模型自检解码失败，保留文件副本（{why}）', { why: describe(err) }))
    return
  } finally {
    try {
      stream && stream.free && stream.free()
    } catch {
      /* the runtime owns this memory */
    }
  }

  // Every weight file, not just the largest: sherpa-onnx reads all of them into
  // its own sessions while the recognizer is built, and the throwaway decode above
  // has just proven the sessions work with the files gone. The tokens stay — they
  // are 60 KB and the decoder reads them per result.
  const weights = Object.keys(pack.files).filter((role) => role !== 'tokens')
  if (!unlink(Module, weights.map((role) => paths[role]))) {
    caution(t('运行环境没有提供 unlink，模型文件留在内存里'))
    return
  }
  const mb = weights.reduce((sum, role) => sum + pack.files[role].bytes, 0)
  note(t('已释放模型字节（约 {mb}MB）', { mb: Math.round(mb / 1048576) }))
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
  if (!response.ok) throw new Error(t('运行环境下载失败：HTTP {status}', { status: response.status }))
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
  if (!response.ok)
    throw new Error(t('{what}失败：HTTP {status}', { what: t(label), status: response.status }))
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
        caution(t('{what}比声明的大小更大，末尾另存后再拼一次', { what: t(label) }))
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
  // Translated here rather than at the call site: the labels arrive as the
  // Chinese source text (`PACKS.…files.…label`) and go straight to a status line
  // the user reads, which is how a Korean interface ended up saying
  // "下载中文模型". Calling `t` twice is harmless — an already-translated label is
  // simply not found in the table.
  post({
    type: 'load-progress',
    status: t(label),
    file: t(label),
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
    if (dropped > 0)
      debug(t('已从 {cache} 清理 {n} 个过期缓存条目', { cache: cacheName, n: dropped }))
  } catch {
    /* quota handling is best-effort; never let cleanup break a working engine */
  }
}

function openCache(name) {
  if (typeof caches === 'undefined') return Promise.resolve(null)
  return caches.open(name).catch(() => null)
}
