<script lang="ts">
  import { onMount } from 'svelte'
  import TitleBar from './components/TitleBar.svelte'
  import SubtitleBar from './components/SubtitleBar.svelte'
  import AsrPanel from './components/AsrPanel.svelte'
  import TranslationPanel from './components/TranslationPanel.svelte'
  import StatusBar from './components/StatusBar.svelte'
  import LogDrawer from './components/LogDrawer.svelte'
  import SettingsView from './components/SettingsView.svelte'
  import Modal from './components/Modal.svelte'
  import {
    session,
    view,
    toast,
    headphonePrompt,
    acknowledgeHeadphones,
  } from './lib/app/state'
  import { getSettings, forgetModel, settings } from './lib/store/settings'
  import { applyAppIcon } from './lib/brand/apply'
  import { configureLogging, info, warn } from './lib/log/store'
  import { speechSupported } from './lib/tts/speech'
  import { moduleFor, purgeRetiredModuleCaches } from './lib/asr/models'

  const { lines: linesStore } = session
  const lines = $derived($linesStore)
  const keepAudio = $derived($settings.keepAudio)

  // Logging configuration follows the settings live.
  $effect(() => {
    configureLogging($settings.logRing, $settings.logLevel)
  })

  // The icon follows the setting too: the favicon changes immediately, and the
  // manifest — which is what an *install* reads — is regenerated for any choice
  // other than the one shipped in static/icon.svg.
  $effect(() => {
    applyAppIcon($settings.appIcon)
  })

  // VAD thresholds, provider config and rate limits are re-read on every change,
  // so a slider takes effect without a restart.
  $effect(() => {
    void $settings
    session.applySettings()
  })

  onMount(() => {
    // Korean runs on the Chinese module now. Anyone who installed the old,
    // dedicated Korean model is holding ~62 MB that nothing will open again:
    // drop the record and the cache in the same breath, once.
    if (getSettings().installedModels.ko) forgetModel('ko')
    void purgeRetiredModuleCaches().then((gone) => {
      if (gone.length) info('storage', `已清理不再使用的识别模块：${gone.join('、')}`)
    })

    const spec = moduleFor($settings.sourceLang)
    info('session', '应用已启动', {
      默认语向: `${$settings.sourceLang} → ${$settings.targetLang}`,
      识别模块: spec.label,
      朗读: speechSupported() ? '可用' : '不可用',
    })
    if (!window.isSecureContext) {
      warn('session', '当前不是安全上下文（https/localhost），麦克风会被浏览器拒绝')
    }
    if (!speechSupported()) {
      warn('tts', '这个浏览器不支持语音朗读，译文不会自动读出来')
    }
    if ('storage' in navigator && 'persist' in navigator.storage) {
      // Installed PWAs are exempt from iOS's 7-day storage sweep; asking for
      // persistence is the cheapest available protection for a 230 MB model.
      void navigator.storage.persist().then((granted) => {
        info('storage', granted ? '存储已设为持久，模型不会被自动清理' : '存储未获持久授权，长时间不用可能被清理')
      })
    }
  })
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape' && $headphonePrompt) headphonePrompt.set(false)
  }}
/>

<div class="sandwich">
  <header>
    <TitleBar />
  </header>

  <main>
    {#if $view === 'settings'}
      <SettingsView />
    {:else}
      <!-- The queue/lag strip (requirement 20) is a diagnostics readout: it is
           only rendered in debug mode. Nothing is lost by hiding it — a failed
           translation is marked on its own line in the translation panel, and
           the "skip to latest" escape hatch lives in the status bar. -->
      {#if $settings.debugMode}
        <SubtitleBar />
      {/if}
      <div class="panels">
        <AsrPanel {lines} audioAvailable={keepAudio} />
        <TranslationPanel {lines} />
      </div>
    {/if}
  </main>

  <footer>
    <StatusBar />
  </footer>
</div>

<LogDrawer />

{#if $headphonePrompt}
  <!-- Headphone check (requirement 13): a soft confirmation, deliberately not a
       hard gate — the browser cannot reliably tell whether headphones are on. -->
  <Modal
    title="先戴上耳机"
    onclose={() => headphonePrompt.set(false)}
  >
    <p>不戴耳机，麦克风会听到手机读译文的声音，就会自己翻译自己。</p>
    {#snippet footer()}
      <button class="rc-btn ghost" onclick={() => headphonePrompt.set(false)}>不用了</button>
      <button
        class="rc-btn accent"
        onclick={() => {
          acknowledgeHeadphones()
          headphonePrompt.set(false)
          void session.start().catch((err: unknown) =>
            warn('session', `启动失败：${err instanceof Error ? err.message : String(err)}`),
          )
        }}
      >
        戴好了，开始
      </button>
    {/snippet}
  </Modal>
{/if}

{#if $toast}
  <div class="clone-toast">{$toast}</div>
{/if}
