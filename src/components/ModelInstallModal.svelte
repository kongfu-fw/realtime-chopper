<script lang="ts">
  import Modal from './Modal.svelte'
  import { session } from '../lib/app/state'
  import {
    ASR_MODULES,
    MODULE_LANGS,
    MODULE_NAME,
    moduleLangFor,
    type ModuleLang,
  } from '../lib/asr/models'
  import { formatBytes, markModelInstalled, isModuleCurrent, settings } from '../lib/store/settings'
  import { info } from '../lib/log/store'
  import type { Lang } from '../lib/types'

  interface Props {
    /** The language the user was trying to use, so we know where to continue. */
    want: Lang
    ondone: () => void
    oncancel: () => void
  }

  let { want, ondone, oncancel }: Props = $props()

  const { model } = session
  let downloading = $state<ModuleLang | null>(null)
  let error = $state<string | null>(null)

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
   * The argument is a module, not a language: Korean is served by the Chinese
   * module, and passing the module to `prepare` is what makes one download count
   * for both — the engine tells the languages apart from the audio itself.
   */
  async function download(moduleLang: ModuleLang) {
    downloading = moduleLang
    error = null
    try {
      info('storage', `开始安装识别模块：${ASR_MODULES[moduleLang].label}`)
      await session.prepare(moduleLang)
      // Only reachable once the module is genuinely usable — `prepare` no longer
      // resolves on "the request was sent".
      markModelInstalled(moduleLang, ASR_MODULES[moduleLang].approxBytes, ASR_MODULES[moduleLang].version)
      if (moduleLangFor(want) === moduleLang) {
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

<Modal title="语音识别模块" onclose={downloading ? undefined : oncancel}>
  {#each MODULE_LANGS as key (key)}
    <div class="module">
      <span class="name">{MODULE_NAME[key]}</span>

      <span class="spacer"></span>

      {#if isModuleCurrent(key, $settings.installedModels[key])}
        <span class="badge">已安装</span>
      {:else if downloading === key}
        <span class="bar" class:starting><i style={`width:${percent ?? 6}%`}></i></span>
        <span class="size">{percent !== null ? `${percent}%` : '准备中'}</span>
      {:else}
        <span class="size">约 {formatBytes(ASR_MODULES[key].approxBytes)}</span>
        <button
          class="rc-btn small accent"
          disabled={downloading !== null}
          onclick={() => void download(key)}
        >
          下载
        </button>
      {/if}
    </div>
  {/each}

  <!-- One line for the phase that has no percentage of its own. -->
  {#if downloading}
    <p class="stage" role="status">
      <span class="spin" aria-hidden="true"></span>
      {#if starting}
        正在启动识别引擎，第一次会慢一些
      {:else}
        正在下载，别关掉这个窗口
      {/if}
    </p>
  {/if}

  {#if error}
    <p class="error">{error}</p>
  {/if}

  {#snippet footer()}
    <button class="rc-btn ghost" onclick={oncancel} disabled={downloading !== null}>关闭</button>
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
</style>
