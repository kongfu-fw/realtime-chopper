import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addressProblem,
  KoasrEngine,
  remoteConfigFor,
  requestTimeoutMs,
  resolveBaseUrl,
} from './koasr.ts'
import {
  localModuleIdFor,
  mayFallBackToLocal,
  moduleIdFor,
  networkModuleFor,
  setAsrBackendChoice,
} from './models.ts'

/**
 * The network recogniser's decisions that can be checked without a service.
 *
 * Three of them are worth this file on their own. The address check exists because
 * the failure it catches is *invisible*: a page on HTTPS asking an `http://`
 * service is refused by the browser before a packet leaves, and the only report
 * the app would otherwise get is the same `TypeError` as an unreachable machine.
 * The routing check exists because "auto" is a device-dependent answer that reads
 * like a constant, and a routing table that quietly ignores the explicit setting
 * is a picker that does nothing.
 *
 * The third is the device rule: on Apple's mobile an unreachable service is an
 * error rather than a quiet step down to the local model, and that is a decision
 * about *which* recogniser answers a classroom, taken on the device this app was
 * built for and invisible from anywhere else.
 *
 * Nothing here talks to a running service. That would make the suite depend on a
 * machine in one room — and the thing it would prove is that Whisper reads Korean,
 * which is the service's business rather than this app's. What *is* this app's
 * business is the request it builds, and that is worth pinning down to the field
 * name: a rewrite of the service is exactly when a path or a form field changes
 * quietly, and the symptom of getting one wrong is a transcript that never
 * arrives. So `fetch` is stubbed and the request is read back, while the service
 * itself is exercised by hand (see DOCS.md for the `curl` forms).
 */


test('http 地址配 https 页面会被认出来', () => {
  // The deployment trap: the phone opens the app over https (Tailscale), and the
  // service is a plain http port on another machine. The browser blocks it.
  assert.equal(addressProblem('http://100.110.58.91:8900', 'https:'), 'insecure')
  assert.equal(addressProblem('HTTP://kongfu.local:8900', 'https:'), 'insecure')
  // Same address, same page scheme: nothing to block.
  assert.equal(addressProblem('http://100.110.58.91:8900', 'http:'), null)
  assert.equal(addressProblem('https://kongfu.example/asr', 'https:'), null)
  // And the form that cannot ever be mixed content: a path on our own origin.
  assert.equal(addressProblem('/asr', 'https:'), null)
})

test('空地址和地址写错是两件事', () => {
  // Different sentences, because they have different fixes: fill the field, or
  // change the address. Whitespace counts as empty — a field holding a space is a
  // field nobody filled in.
  assert.equal(addressProblem('', 'https:'), 'empty')
  assert.equal(addressProblem('   ', 'https:'), 'empty')
})

test('配置的地址解析成不带尾斜杠的绝对地址', () => {
  // A relative path resolves against the app's own origin: same-origin cannot be
  // mixed content and needs no CORS header from anyone, so it is still the form
  // that asks the least of a deployment — it is just not the one that is running.
  assert.equal(resolveBaseUrl('/asr', 'https://app.example'), 'https://app.example/asr')
  assert.equal(resolveBaseUrl('/asr/', 'https://app.example'), 'https://app.example/asr')
  // An absolute address is left alone apart from the trailing slash, which would
  // otherwise double up in every path this engine appends.
  assert.equal(resolveBaseUrl('http://100.0.0.1:8900/', 'https://app.example'), 'http://100.0.0.1:8900')
  assert.equal(resolveBaseUrl('http://100.0.0.1:8900', 'https://app.example'), 'http://100.0.0.1:8900')
  // A bare host is a host, not a path. `new URL` would resolve it as a relative
  // path against the page — `/kongfu.kooka-salmon.ts.net` — and 404 there, which
  // from a classroom is indistinguishable from a service that is switched off.
  assert.equal(
    resolveBaseUrl('kongfu.kooka-salmon.ts.net', 'https://app.example'),
    'https://kongfu.kooka-salmon.ts.net',
  )
  // Trailing slash, no scheme, and from an http page: still https, because that
  // page would not be allowed to call http anyway.
  assert.equal(
    resolveBaseUrl('kongfu.kooka-salmon.ts.net/', 'http://kongfu-onedrive.kooka-salmon.ts.net:8080'),
    'https://kongfu.kooka-salmon.ts.net',
  )
  assert.equal(resolveBaseUrl('100.0.0.1:8900', 'https://app.example'), 'https://100.0.0.1:8900')
  // ...while the forms that are paths stay paths. `./asr` matters: a dot is how a
  // relative path starts, and it must not become the host `https://./asr`.
  assert.equal(resolveBaseUrl('./asr', 'https://app.example'), 'https://app.example/asr')
  assert.equal(resolveBaseUrl('//app.example/asr', 'https://app.example'), 'https://app.example/asr')
  // Empty is the app's own origin rather than the empty string: this value is only
  // built when the setting is non-empty, but a URL builder that can produce one is
  // one that can produce a request to nowhere.
  assert.equal(resolveBaseUrl('', 'https://app.example'), 'https://app.example')
})

test('远程模块拿到地址和语言，本地模块什么都没有', () => {
  const remote = remoteConfigFor('ko-net', '/asr', 'https://app.example')
  assert.equal(remote?.baseUrl, 'https://app.example/asr')
  assert.equal(remote?.language, 'ko')
  // The floor is explained at its definition; the assertion is that it exists and
  // is a number the request builder can use.
  assert.equal(typeof remote?.timeoutMs, 'number')
  // A module made of local bytes is not a service and must not be describable as
  // one — every download would otherwise acquire an address.
  assert.equal(remoteConfigFor('ko', '/asr', 'https://app.example'), null)
  assert.equal(remoteConfigFor('en', '/asr', 'https://app.example'), null)
})

test('请求预算跟着音频长，而且短句不会更容易超时', () => {
  // The measurements behind this: the service spends about 4.3 s on a 2.3 s clip
  // and about 5.2 s on an 18.5 s one — Whisper's 30 s window makes the length
  // nearly free and the request nearly constant. So the budget must *not* be
  // “twice realtime” scaled to the audio: that would give a short utterance the
  // shortest leash of all, and short utterances are exactly what this cost
  // dominates.
  const budget = (seconds: number) => requestTimeoutMs(seconds * 16000)
  // Below the floor everything gets the same, generous leash — and that is the
  // intended shape rather than a rounding artefact: the fixed cost is what a short
  // clip pays, so a formula that gave it the *smallest* budget would be backwards.
  assert.equal(budget(0.6), 12_000)
  assert.equal(budget(2.3), 12_000)
  // Exactly 3 s is where the growing term catches the floor (6000 + 3000×2), which
  // is worth pinning: it is the point where the two rules hand over.
  assert.equal(budget(3), 12_000)
  // Above it the budget grows with the audio.
  assert.equal(budget(5), 16_000)
  assert.ok(budget(4) > budget(3))
  assert.ok(budget(8) > budget(4))
  // And it stays under the session's own 30 s recognise timeout, so a slow service
  // is reported by this engine rather than resolved to an empty result by the
  // pipeline — a timeout there reads as “nothing was said”.
  assert.ok(budget(60) <= 25_000)
  // A configured floor raises the budget — that is how a slower service is
  // accommodated without recompiling the measurement above...
  assert.equal(requestTimeoutMs(0.6 * 16000, 15_000), 15_000)
  // ...and the ceiling still wins, because staying under the session's own timeout
  // is not negotiable: a budget above it would turn a slow service into the silent
  // skip (an empty result) that this engine's timeouts exist to avoid.
  assert.equal(requestTimeoutMs(0.6 * 16000, 30_000), 25_000)
})

/** A `fetch` that answers like the service, recording what it was asked for. */
function stubService(
  payload: (url: string) => { status?: number; body: unknown },
): { calls: { url: string; init?: RequestInit }[]; restore: () => void } {
  const calls: { url: string; init?: RequestInit }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const { status = 200, body } = payload(url)
    // A string body stands in for an answer that is not the service's JSON at all
    // — a proxy's error page, a truncated response.
    return typeof body === 'string'
      ? new Response(body, { status, headers: { 'content-type': 'text/html' } })
      : new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        })
  }) as typeof fetch
  return { calls, restore: () => (globalThis.fetch = original) }
}

/** The healthy answer, so a test only has to say what it wants to go wrong. */
const HEALTHY = {
  status: 'ok',
  engine: 'faster-whisper',
  model_id: 'ghost613/faster-whisper-large-v3-turbo-korean',
  queue_depth: 0,
  uptime_s: 1.0,
}

test('请求就是 API 文档里的那一条：/healthz 探活，/v1/transcriptions 送 WAV', async () => {
  // The contract this pins is the part of the integration that a service rewrite
  // breaks: the health path, the transcribe path, and the form fields. The service
  // itself is not the app's business — but its *form* is, because a renamed field
  // fails as “the transcript never arrived” rather than as an error anyone can
  // debug from a phone.
  const { calls, restore } = stubService((url) =>
    url.endsWith('/healthz')
      ? { body: { ...HEALTHY, queue_depth: 2 } }
      : { body: { text: '  안녕하세요  ', language: 'ko', duration: 3.0 } },
  )
  try {
    const engine = new KoasrEngine('ko-net', {
      baseUrl: 'https://app.example/asr',
      language: 'ko',
      timeoutMs: 12_000,
    })
    // Before a load there is nothing to talk to, and it says so rather than
    // sending a request with no health answer behind it.
    // Matched in either language: `t` in Node answers with whatever `uiLang`
    // resolves to, and a test that only spoke Chinese would start failing the
    // first time that default changed.
    await assert.rejects(() => engine.recognize(new Float32Array(1600)), /还没连上|not connected/i)

    const info = await engine.load()
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, 'https://app.example/asr/healthz')
    assert.equal(engine.ready, true)
    // What the service reports about itself reaches the log: the weights it loaded
    // and the queue in front of it, which is the number that explains a slow answer.
    assert.equal(info.dtype, 'faster-whisper-large-v3-turbo-korean')
    assert.match(String(info.reason), /faster-whisper/)
    assert.match(String(info.reason), /2/)

    const result = await engine.recognize(new Float32Array(3 * 16000))
    const request = calls[1]
    assert.equal(request?.url, 'https://app.example/asr/v1/transcriptions')
    assert.equal(request?.init?.method, 'POST')
    const form = request?.init?.body
    assert.ok(form instanceof FormData)
    assert.equal(form.get('language'), 'ko')
    assert.equal(form.get('response_format'), 'json')
    // The field that decides whether silence comes back as nothing or as an
    // invented sentence; measured both ways against the service (see the header of
    // `koasr.ts`). A deployment's own `KOASR_VAD_FILTER=false` must not reach here.
    assert.equal(form.get('vad_filter'), 'true')
    const file = form.get('file')
    assert.ok(file instanceof Blob)
    assert.equal(file.type, 'audio/wav')
    // 44 bytes of header plus 16 kHz mono 16-bit — the whole segment, nothing else.
    const bytes = await file.arrayBuffer()
    assert.equal(bytes.byteLength, 44 + 3 * 16000 * 2)
    // And it really is a WAV: the service decodes the file it is given, so a body
    // that is bare PCM would be a decode failure rather than a transcript.
    assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF')

    // Trimmed, because the service returns each segment's text with its own
    // whitespace and a leading space would land in a subtitle.
    assert.equal(result.text, '안녕하세요')
    assert.equal(result.rawText, '안녕하세요')
    assert.equal(result.engine, 'koasr-ko')
    // The engine name carries the language so two services on two sets of weights
    // do not look like one in a log.
    assert.ok(result.inferMs >= 0)
  } finally {
    restore()
  }
})

test('服务说自己没准备好、或者拒绝了这次转写，都带原话出来', async () => {
  // Three failures that are one line each in the log and must not be confused with
  // each other. `draining` is a 200 — a restart in progress, which a naive “did it
  // answer?” check would call a working service. The other two are the service's own
  // `detail`, which is the only description of what went wrong that exists.
  const cases: {
    health?: unknown
    transcribe?: { status?: number; body: unknown }
    expect: RegExp
  }[] = [
    { health: { ...HEALTHY, status: 'draining' }, expect: /draining/ },
    { transcribe: { status: 404, body: { detail: 'Not Found' } }, expect: /Not Found/ },
    // The engine's own failure: a string `detail`, which is what arrives when the
    // service accepted the upload and could not decode it.
    {
      transcribe: { status: 422, body: { detail: 'EngineError: audio decode failed' } },
      expect: /EngineError/,
    },
    // A rejected form instead: FastAPI's validation array, whose `msg` fields are
    // the only readable part.
    {
      transcribe: {
        status: 422,
        body: { detail: [{ loc: ['body', 'file'], msg: 'Field required', type: 'missing' }] },
      },
      expect: /Field required/,
    },
    // And an answer that is not JSON at all, where the status code is all there is.
    { transcribe: { status: 500, body: '<html>Bad Gateway</html>' }, expect: /HTTP 500/ },
  ]
  for (const { health, transcribe, expect } of cases) {
    const { restore } = stubService((url) =>
      url.endsWith('/healthz') ? { body: health ?? HEALTHY } : (transcribe ?? { body: {} }),
    )
    try {
      const engine = new KoasrEngine('ko-net', {
        baseUrl: 'https://app.example/asr',
        language: 'ko',
        timeoutMs: 12_000,
      })
      await assert.rejects(
        () => engine.load().then(() => engine.recognize(new Float32Array(1600))),
        expect,
      )
      // A service that refused at the handshake is not one to send audio to. A
      // refusal *during* a transcription does not undo a healthy handshake, and
      // saying otherwise would make the next utterance re-probe for no reason.
      assert.equal(engine.ready, !health)
    } finally {
      restore()
    }
  }
})

test('只有韩语能走网络，而且 自动 档不动电脑上的路由', () => {
  // What the settings screen means by the three choices; see `AsrBackendChoice`.
  const routed = () => moduleIdFor('ko')
  const local = () => localModuleIdFor('ko')

  setAsrBackendChoice('local')
  assert.equal(routed(), local())

  // `'network'` is honoured on *any* device, and this is the assertion that keeps
  // the picker from being decorative: an explicit choice that the routing table
  // overrode would leave the user with a setting that does nothing.
  setAsrBackendChoice('network')
  assert.equal(routed(), 'ko-net')
  assert.equal(moduleIdFor('en'), 'en')
  assert.equal(moduleIdFor('zh'), 'zh')

  // `'auto'` is device-dependent, and in Node there is no `navigator`, so this is
  // the desktop answer: the local model, which is SenseVoice and already larger
  // than what the phone has.
  setAsrBackendChoice('auto')
  assert.equal(routed(), local())
  assert.equal(moduleIdFor('en'), 'en')
  assert.equal(moduleIdFor('zh'), 'zh')

  // A language with no service keeps its local routing whatever the setting says,
  // which is the whole of “Chinese and English are not routed anywhere new”.
  setAsrBackendChoice('network')
  assert.equal(networkModuleFor('en'), null)
  assert.equal(networkModuleFor('zh'), null)
  assert.equal(networkModuleFor('ko'), 'ko-net')
  setAsrBackendChoice('local')
})

test('手机上网络服务不可用就直接报错，不偷偷换成本机模型', () => {
  // There is no iPhone in `node --test`, so the device is stubbed with the only
  // thing `isAppleMobile` reads. Restored in `finally`: the stub is global, and a
  // leaked one would make every later test believe it is a phone.
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15',
      maxTouchPoints: 5,
    },
    configurable: true,
    writable: true,
  })
  try {
    // The rule itself: on this device there is no quiet step down, because the
    // local Korean answer here is Moonshine Base-KO — the model this route was
    // built to stop using. A fallback would not degrade the app, it would remove
    // the upgrade and hide that it did.
    assert.equal(mayFallBackToLocal(), false)

    // And the route it decides about. `auto` is the network on a phone, so this is
    // the state the app ships in there: with the service down, Korean stops with a
    // sentence rather than continuing on the model the route replaced.
    setAsrBackendChoice('auto')
    assert.equal(moduleIdFor('ko'), 'ko-net')
    // The local Korean module is still the small one on a phone — that is *why*
    // there is no fallback, and pinning it keeps the reason from going stale.
    assert.equal(localModuleIdFor('ko'), 'ko')

    // Chinese and English are still not routed anywhere new, phone included.
    assert.equal(moduleIdFor('en'), 'en')
    assert.equal(moduleIdFor('zh'), 'zh')

    // The way out is a setting rather than a hidden retry: an explicit `local`
    // gives the phone its own model back, which is the one way to record Korean
    // there with the service down.
    setAsrBackendChoice('local')
    assert.equal(moduleIdFor('ko'), 'ko')
  } finally {
    // `navigator` is a configurable accessor on `globalThis` in Node, so putting
    // the descriptor back is the whole of the cleanup.
    if (original) Object.defineProperty(globalThis, 'navigator', original)
  }
  // Proof the stub is gone, which is what keeps the assertions above from
  // depending on the order this file happens to run in.
  assert.equal(mayFallBackToLocal(), true)
})
