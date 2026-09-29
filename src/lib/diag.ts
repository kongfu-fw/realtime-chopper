import { exportLogs, formatStamp } from './log/store'
import { gpuBlockReason, isAppleMobile, readGpuVerdict, webgpuAvailable } from './asr/device'
import { moduleIdFor, moduleName } from './asr/models'
import { speechSnapshot, speechSupported } from './tts/speech'
import { ttsEngineLabel } from './tts/engine'
import { getSettings } from './store/settings'
import { APP_VERSION } from './app/version'
import { t } from './i18n/index.ts'

/**
 * A failure report a user can *get off the phone*.
 *
 * This exists because every other diagnostic surface in this app assumes desktop:
 * the log drawer is behind a debug switch, the raw error only reached the console,
 * and a phone has neither devtools nor a way to hover a tooltip. When the model
 * download finishes and the engine then refuses to start, the person holding the
 * device is the only one who can see what happened — so the failure has to be
 * turnable into text and copyable, in one tap.
 */

/** Environment facts worth having in a bug report, cheapest first. */
export function platformLines(): string[] {
  const lines: string[] = []
  if (typeof navigator === 'undefined') return lines
  // First, because every other line describes a build of the app the reporter
  // may no longer be running: a shell cached by the Service Worker keeps an old
  // version alive, and a report that does not say which one is hard to trust.
  lines.push(t('版本：{version}', { version: APP_VERSION }))
  lines.push(
    t('平台：{platform} · {ua}', {
      // Not translated on purpose: it is the platform's name, and it is spelled
      // the same in all three languages.
      platform: `${isAppleMobile() ? 'iOS/iPadOS' : t('非 iOS')} · ${navigator.platform ?? '?'}`,
      ua: navigator.userAgent,
    }),
  )
  lines.push(
    t('安全上下文：{secure}', {
      secure: window.isSecureContext ? t('是') : t('否（麦克风与缓存都会被禁用）'),
    }) +
      t(' · SharedArrayBuffer：{state}', {
        state:
          typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
            ? t('可用')
            : t('不可用'),
      }),
  )
  lines.push(
    t('CPU 核心：{cores}', { cores: navigator.hardwareConcurrency || t('未知') }) +
      t(' · 设备内存（Chrome 才报）：{gb}', {
        gb: (navigator as { deviceMemory?: number }).deviceMemory ?? t('未知'),
      }),
  )
  const verdict = readGpuVerdict()
  lines.push(
    t('WebGPU：{available}', { available: webgpuAvailable() ? t('浏览器提供') : t('没有') }) +
      t(' · 上次判定：{verdict}', {
        verdict: verdict
          ? `${verdict.ok ? t('可用') : t('失败')}${t('（{reason}）', { reason: verdict.reason })}`
          : t('还没试过'),
      }) +
      (gpuBlockReason() ? t(' · 本次将直接用 CPU') : ''),
  )
  // Speech output, because "朗读听不到" is the one failure with no error and no
  // console line to find: `paused` here means the platform stopped calling back
  // (切后台/锁屏之后), and `play-and-record` during recording is the audio session
  // in which iOS demotes system speech to the receiver — see `tts/speech.ts`.
  // Which engine, first: the rest of this line only describes one of them. An
  // Edge read-out goes through the user's proxy, and "no sound" there is a
  // network question, not a platform one.
  const settings = getSettings()
  lines.push(
    t('朗读引擎：{engine}', { engine: ttsEngineLabel(settings.ttsEngine) }) +
      t('（{detail}）', {
        detail:
          settings.ttsEngine === 'edge'
            ? settings.ttsProxyUrl
            : speechSupported()
              ? t('可用')
              : t('浏览器不支持'),
      }),
  )
  if (settings.ttsEngine === 'system') {
    const speech = speechSnapshot()
    lines.push(
      t('系统朗读：音色 {n} 个', { n: speech.voices }) +
        t(' · 暂停态：{paused}', { paused: speech.paused ? t('是（会没声音）') : t('否') }) +
        t(' · 语音会话：{session}', { session: speech.session }),
    )
  }
  // Where recognition actually happens, and — the part a report cannot be read
  // without — which *module* the current language resolved to. On a phone the
  // difference between the 64 MB local Korean model and a service on the network is
  // invisible in the interface and decides both the latency and the error profile,
  // so a report that does not name it leaves the two indistinguishable.
  lines.push(
    t('识别服务：{backend} · {url} · 当前语言用 {module}', {
      backend:
        settings.asrBackend === 'local'
          ? t('只用本机模型')
          : settings.asrBackend === 'network'
            ? t('网络服务优先')
            : t('自动'),
      url: settings.asrBaseUrl.trim() || t('没填地址'),
      module: moduleName(moduleIdFor(settings.sourceLang)),
    }),
  )
  return lines
}

/** Storage facts, which is where a 240 MB module either fit or did not. */
export async function storageLines(): Promise<string[]> {
  const lines: string[] = []
  try {
    const estimate = await navigator.storage?.estimate?.()
    if (estimate) {
      lines.push(
        t('存储：配额约 {quota} MB，已用 {used} MB', {
          quota: ((estimate.quota ?? 0) / 1048576).toFixed(0),
          used: ((estimate.usage ?? 0) / 1048576).toFixed(1),
        }),
      )
    } else {
      lines.push(t('存储：浏览器不提供配额信息'))
    }
  } catch {
    lines.push(t('存储：读取配额失败'))
  }
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys()
      lines.push(t('缓存桶：{keys}', { keys: keys.length ? keys.join(t('、')) : t('（空）') }))
    }
  } catch {
    lines.push(t('缓存桶：读取失败'))
  }
  return lines
}

/**
 * The whole thing: environment + storage + the log ring, which is what turns
 * "it errors on my phone" into a specific line of code.
 */
export async function diagnosticReport(headline: string): Promise<string> {
  const parts = [
    t('# 乔巴 · 诊断信息'),
    `# ${formatStamp(Date.now())}`,
    headline ? t('情况：{headline}', { headline }) : '',
    ...platformLines(),
    ...(await storageLines()),
    '',
    exportLogs(),
  ]
  return parts.filter((part) => part !== '').join('\n')
}
