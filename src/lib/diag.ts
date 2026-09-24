import { exportLogs, formatStamp } from './log/store'
import { gpuBlockReason, isAppleMobile, readGpuVerdict, webgpuAvailable } from './asr/device'

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
  lines.push(`平台：${isAppleMobile() ? 'iOS/iPadOS' : '非 iOS'} · ${navigator.platform ?? '?'}`)
  lines.push(`UA：${navigator.userAgent}`)
  lines.push(
    `安全上下文：${window.isSecureContext ? '是' : '否（麦克风与缓存都会被禁用）'}` +
      ` · SharedArrayBuffer：${typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated ? '可用' : '不可用'}`,
  )
  lines.push(
    `CPU 核心：${navigator.hardwareConcurrency || '未知'}` +
      ` · 设备内存（Chrome 才报）：${(navigator as { deviceMemory?: number }).deviceMemory ?? '未知'}`,
  )
  const verdict = readGpuVerdict()
  lines.push(
    `WebGPU：${webgpuAvailable() ? '浏览器提供' : '没有'}` +
      ` · 上次判定：${verdict ? `${verdict.ok ? '可用' : '失败'}（${verdict.reason}）` : '还没试过'}` +
      `${gpuBlockReason() ? ' · 本次将直接用 CPU' : ''}`,
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
        `存储：配额约 ${((estimate.quota ?? 0) / 1048576).toFixed(0)} MB，` +
          `已用 ${((estimate.usage ?? 0) / 1048576).toFixed(1)} MB`,
      )
    } else {
      lines.push('存储：浏览器不提供配额信息')
    }
  } catch {
    lines.push('存储：读取配额失败')
  }
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys()
      lines.push(`缓存桶：${keys.length ? keys.join('、') : '（空）'}`)
    }
  } catch {
    lines.push('缓存桶：读取失败')
  }
  return lines
}

/**
 * The whole thing: environment + storage + the log ring, which is what turns
 * "it errors on my phone" into a specific line of code.
 */
export async function diagnosticReport(headline: string): Promise<string> {
  const parts = [
    '# 乔巴 · 诊断信息',
    `# ${formatStamp(Date.now())}`,
    headline ? `情况：${headline}` : '',
    ...platformLines(),
    ...(await storageLines()),
    '',
    exportLogs(),
  ]
  return parts.filter((part) => part !== '').join('\n')
}
