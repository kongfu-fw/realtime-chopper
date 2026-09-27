<script lang="ts">
  import Modal from './Modal.svelte'
  import { session } from '../lib/app/state'
  import {
    ASR_MODULES,
    MODULE_IDS,
    isMemoryFailure,
    moduleIdFor,
    moduleLabel,
    moduleTitle,
    moduleTooBigForDevice,
    moduleUsedOnThisDevice,
  } from '../lib/asr/models'
  import { formatBytes, markModelInstalled, isModuleCurrent, settings } from '../lib/store/settings'
  import { info } from '../lib/log/store'
  import { diagnosticReport } from '../lib/diag'
  import { isAppleMobile } from '../lib/asr/device'
  import { t, translator, uiLang } from '../lib/i18n/index.ts'
  import type { Lang, ModuleId } from '../lib/types'

  const tr = $derived(translator($uiLang))

  interface Props {
    /** The language the user was trying to use, so we know where to continue. */
    want: Lang
    ondone: () => void
    /** Carries how the dialog was dismissed, so the log can name it. */
    oncancel: (reason: string) => void
  }

  let { want, ondone, oncancel }: Props = $props()

  const { model, failure } = session
  let downloading = $state<ModuleId | null>(null)
  let error = $state<string | null>(null)
  /** '' = not tried, 'ok' = on the clipboard, 'fail' = the report is on screen. */
  let copied = $state<'' | 'ok' | 'fail'>('')
  let report = $state('')

  /**
   * The raw runtime message, which is the only part that identifies a bug.
   *
   * On a phone there is no console, and the log drawer is behind a debug switch,
   * so failing without showing this made the failure unreportable — the user could
   * only say "it errors".
   */
  const rawError = $derived($failure?.raw ?? '')

  /**
   * The one failure with a fix the user can apply themselves.
   *
   * The 228 MB Chinese module is past what iOS will hand a web page, so "out of
   * memory" there is an expected outcome rather than a bug — and the advice differs
   * by platform, which is why this is not part of the sentence above. The sizes in
   * it are the other two modules' own: a phone is *known* to manage the English
   * one (the log of an iPhone 12 that lost its page to the Chinese module shows the
   * English one loading on the same device minutes earlier) and the Korean one is
   * smaller than either of the others' arrival cost, which is why it is named as a
   * candidate rather than promised to fit.
   */
  const memoryHint = $derived(
    rawError && isMemoryFailure(rawError)
      ? isAppleMobile()
        ? tr('iPhone 内存比较紧：先关掉其他 App 再试；英文（62 MB）和手机上的韩语（64 MB）模块都比中文模块轻得多。')
        : tr('内存不够：关掉其他应用，或换用更小的模块（英文 62 MB、手机上的韩语 64 MB）。')
      : '',
  )

  /**
   * Copies a report that is worth something.
   *
   * The clipboard API needs a user gesture and can still be refused on iOS, so a
   * refusal is not an error: the report is put on screen to be selected instead.
   * Either way the user ends up holding text they can paste into a message.
   */
  async function copyReport() {
    report = await diagnosticReport(error ?? t('识别模块安装失败'))
    try {
      await navigator.clipboard.writeText(report)
      copied = 'ok'
    } catch {
      copied = 'fail'
    }
  }

  const percent = $derived(
    $model?.progress !== undefined
      ? Math.round($model.progress * 100)
      : $model?.loadedBytes && $model?.totalBytes
        ? Math.round(($model.loadedBytes / $model.totalBytes) * 100)
        : null,
  )

  /**
   * Bytes are downloaded at 100 %, but the engine is not ready.
   *
   * Building the session (ONNX/WebGPU) or unpacking the runtime is seconds of
   * real work that reports no numbers at all, and a bar sitting at 100 % with
   * nothing else happening is exactly what "it froze" looks like. This flag is
   * what turns that silence into a sentence.
   */
  const starting = $derived(percent !== null && percent >= 100)

  /**
   * Installs one module.
   *
   * The argument is a module rather than a language because those are different
   * things even now that they line up: this dialog offers the *bytes*, and the
   * question of which language those bytes answer is `moduleIdFor`'s.
   */
  async function download(module: ModuleId) {
    downloading = module
    error = null
    copied = ''
    report = ''
    try {
      info('storage', t('开始安装识别模块：{module}', { module: moduleLabel(ASR_MODULES[module]) }), {
        [t('设备')]: navigator.userAgent,
        [t('显卡加速')]: 'gpu' in navigator ? t('浏览器有 WebGPU') : t('没有 WebGPU，走 CPU'),
      })
      await session.prepare(module)
      // Only reachable once the module is genuinely usable — `prepare` no longer
      // resolves on "the request was sent".
      markModelInstalled(module, ASR_MODULES[module].approxBytes, ASR_MODULES[module].version)
      if (moduleIdFor(want) === module) {
        ondone()
        return
      }
      // A different module was installed: free the engine so only the module in
      // use is ever resident in memory.
      await session.releaseModel()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      downloading = null
    }
  }
</script>

<Modal title={tr('语音识别模块')} onclose={downloading ? undefined : (reason) => oncancel(reason ?? t('关闭'))}>
  {#each MODULE_IDS as key (key)}
    <div class="module">
      <span class="name">{moduleTitle(key, $uiLang)}</span>
      <!--
        A module this device will never load has to say so, or the row reads as
        "install this and Korean works" when the app has already routed Korean
        elsewhere. See `moduleUsedOnThisDevice`.
      -->
      {#if !moduleUsedOnThisDevice(key)}
        <span class="size">{tr('手机上使用')}</span>
      {/if}

      <span class="spacer"></span>

      {#if isModuleCurrent(key, $settings.installedModels[key])}
        <span class="badge">{tr('已安装')}</span>
      {:else if downloading === key}
        <span class="bar" class:starting><i style={`width:${percent ?? 6}%`}></i></span>
        <span class="size">{percent !== null ? `${percent}%` : tr('准备中')}</span>
      {:else}
        <span class="size">{tr('约 {size}', { size: formatBytes(ASR_MODULES[key].approxBytes) })}</span>
        <button
          class="rc-btn small accent"
          disabled={downloading !== null}
          onclick={() => void download(key)}
        >
          {tr('下载')}
        </button>
      {/if}
    </div>

    <!--
      Said *before* the tap, because the tap is what costs the page: a module past
      what this device can hold dies by killing the whole renderer — silently, with
      nothing to catch and no error to show afterwards. See `moduleTooBigForDevice`.
    -->
    {#if moduleTooBigForDevice(ASR_MODULES[key]) && !isModuleCurrent(key, $settings.installedModels[key])}
      <p class="warn">
        {tr('iPhone 上装不下：iOS 给一个网页的内存比电脑少一个数量级（实测：几百 MB 就会把整页关掉），这个模块的模型文件本身就有 {size}。手机上用英文和韩语（韩语会自动换用更小的 Moonshine 模块），中文留给电脑。', {
          size: formatBytes(ASR_MODULES[key].approxBytes),
        })}
      </p>
    {/if}
  {/each}

  <!-- One line for the phase that has no percentage of its own. -->
  {#if downloading}
    <p class="stage" role="status">
      <span class="spin" aria-hidden="true"></span>
      {#if starting}
        {tr('正在启动识别引擎，第一次会慢一些')}
      {:else}
        {tr('正在下载，别关掉这个窗口')}
      {/if}
    </p>
  {/if}

  {#if error}
    <p class="error">{error}</p>
    {#if memoryHint}
      <p class="hint">{memoryHint}</p>
    {/if}
    {#if rawError && rawError !== error}
      <details class="raw">
        <summary>{tr('报错详情')}</summary>
        <pre>{rawError}</pre>
      </details>
    {/if}
    <div class="diag">
      <button class="rc-btn ghost small" onclick={() => void copyReport()}>{tr('复制诊断信息')}</button>
      {#if copied === 'ok'}<span class="ok">{tr('已复制，把它发给开发者就行')}</span>{/if}
      {#if copied === 'fail'}
        <!-- Long-press → 全选 → 拷贝: the fallback that always works on a phone. -->
        <textarea readonly rows="6" onfocus={(event) => event.currentTarget.select()}>{report}</textarea>
      {/if}
    </div>
  {/if}

  {#snippet footer()}
    <button class="rc-btn ghost" onclick={() => oncancel(t('点关闭'))} disabled={downloading !== null}>{tr('关闭')}</button>
  {/snippet}
</Modal>

<style>
  .module {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 0;
    border-bottom: 1px solid var(--rc-line);
  }

  .module:last-of-type {
    border-bottom: none;
  }

  .name {
    font-size: 15px;
  }

  .spacer {
    flex: 1 1 auto;
  }

  .size {
    font-size: 12px;
    color: var(--rc-ink-soft);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .badge {
    font-size: 12px;
    color: var(--rc-ok);
    background: var(--rc-ok-soft);
    border: 1px solid var(--rc-ok);
    border-radius: var(--rc-radius-pill);
    padding: 1px 9px;
  }

  .bar {
    display: block;
    width: 96px;
    height: 10px;
    border: 1px solid var(--rc-line-strong);
    border-radius: var(--rc-radius-pill);
    overflow: hidden;
    background: var(--rc-surface-alt);
  }

  .bar i {
    display: block;
    height: 100%;
    background: var(--rc-accent);
    transition: width 200ms ease;
  }

  /* A full bar that has stopped moving is the problem this animation solves:
     the download is over, the work is not. */
  .bar.starting i {
    animation: rc-install-pulse 900ms ease-in-out infinite;
  }

  .stage {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 12px 0 0;
    font-size: 13px;
    color: var(--rc-ink-soft);
  }

  .spin {
    flex: 0 0 auto;
    width: 13px;
    height: 13px;
    border-radius: 50%;
    border: 2px solid var(--rc-line-strong);
    border-top-color: var(--rc-accent);
    animation: rc-install-spin 700ms linear infinite;
  }

  @keyframes rc-install-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes rc-install-pulse {
    50% {
      opacity: 0.45;
    }
  }

  /* Busy but not flashing: the spinner still turns, just slowly. */
  @media (prefers-reduced-motion: reduce) {
    .spin {
      animation-duration: 2s;
    }

    .bar.starting i {
      animation: none;
    }
  }

  .error {
    color: var(--rc-danger);
    margin: 10px 0 0;
    font-size: 13px;
  }

  .hint {
    margin: 6px 0 0;
    font-size: 13px;
    color: var(--rc-ink-soft);
  }

  /* Not a failure, so not red: this one is here before anything goes wrong, and it
     is a statement about the device rather than about the attempt. */
  .warn {
    margin: 8px 0 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--rc-ink-soft);
    border-left: 2px solid var(--rc-line-strong);
    padding-left: 8px;
  }

  .raw {
    margin-top: 8px;
    font-size: 12px;
    color: var(--rc-ink-soft);
  }

  .raw summary {
    cursor: pointer;
  }

  .raw pre {
    margin: 6px 0 0;
    padding: 8px;
    max-height: 120px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
    background: var(--rc-surface-alt);
    border: 1px solid var(--rc-line);
    border-radius: var(--rc-radius);
    font-size: 12px;
  }

  .diag {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 10px;
  }

  .diag .ok {
    font-size: 12px;
    color: var(--rc-ok);
  }

  .diag textarea {
    width: 100%;
    margin-top: 8px;
    padding: 8px;
    font-family: var(--rc-mono, monospace);
    font-size: 12px;
    line-height: 1.5;
    background: var(--rc-surface-alt);
    color: var(--rc-ink);
    border: 1px solid var(--rc-line);
    border-radius: var(--rc-radius);
  }
</style>
