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
    problem,
    logOpen,
    headphonePrompt,
    acknowledgeHeadphones,
    copyText,
  } from './lib/app/state'
  import { getSettings, forgetModel, settings } from './lib/store/settings'
  import { applyAppIcon } from './lib/brand/apply'
  import { configureLogging, error as logError, flushLogs, info, warn } from './lib/log/store'
  import { speechSupported } from './lib/tts/speech'
  import { MODULE_NAME, moduleFor, purgeRetiredModuleCaches } from './lib/asr/models'
  import { rememberGpuFailure } from './lib/asr/device'
  import { takeAsrCrashReport } from './lib/boot-guard'
  import { diagnosticReport } from './lib/diag'

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
      // On a phone this single fact explains almost everything that looks broken:
      // opened over a plain http:// LAN address, the browser withholds the
      // microphone, Cache Storage and WebGPU at the same time. Say it where a
      // phone can actually read it (the status bar), not just in the log.
      warn('session', '当前不是安全上下文（https/localhost）：麦克风、模型缓存和显卡加速都会被浏览器禁用')
      session.notice.set('这个地址不能用麦克风：请用 https 或电脑上的 localhost 打开')
    }
    if (!speechSupported()) {
      warn('tts', '这个浏览器不支持语音朗读，译文不会自动读出来')
    }
    // Did the previous load of this page die while starting the engine? Nothing
    // else can tell us: a killed renderer throws no error, logs nothing, and the
    // user is left looking at a page that just flashed. This is the only moment
    // the evidence can be surfaced, so it goes in the log *and* on screen.
    const crash = takeAsrCrashReport()
    if (crash) {
      const name = crash.module === 'zh' || crash.module === 'en' ? MODULE_NAME[crash.module] : crash.module
      if (crash.accelerator === 'webgpu') {
        // Measured on an iPhone 14 Pro: the page dies ~2.7 s after the engine is
        // asked for WebGPU, twice, silently — and the same module on the CPU is
        // fine. So this crash bans the *accelerator*, never the module: the note
        // that recorded it is what lets the next attempt succeed instead of
        // repeating the flash.
        rememberGpuFailure('上次启用显卡加速时整个页面被系统关掉了')
        logError('asr', `上次启动${name}时页面被系统直接关掉了 —— 当时用的是显卡加速（WebGPU），已记住，下次改用 CPU`, {
          依据: 'iPhone / Safari 上启用 WebGPU 会把渲染进程带崩，一闪重开、无异常可捕',
        })
        problem.set({
          title: '显卡加速把页面带崩了，已自动改用 CPU',
          body: 'iPhone / Safari 上的 WebGPU 一启用就会把整个页面关掉，这个模块本身没问题。现在再点一次录音即可（设置里也可以自己确认「显卡加速」选的是 CPU）。',
        })
      } else {
        logError('asr', `上次启动${name}时页面被系统直接关掉了（第 ${crash.count} 次，多半是内存不够）`, {
          提示: '弹窗闪一下就没了、控制台没有任何报错，通常就是这一种',
        })
        problem.set({
          title: `上次启动${name}时，页面被系统直接关掉了`,
          body:
            crash.count >= 2
              ? '这台设备装不下这个模块（240MB 的模型加上识别引擎）。再点还是会一样，先别试了 —— 日志里最后一行的位置就是它倒下的地方。'
              : '多半是内存不够：这种失败不会弹任何错误，页面只是闪一下就重开了。日志里最后一行就是它倒下的地方。',
        })
      }
    }
    // Where a phone session actually ends. A page that gets killed has no error
    // to report — the tab is simply gone — so the only trace of it is the last
    // line before it went away.
    const onVisibility = () =>
      info(
        'session',
        document.visibilityState === 'hidden'
          ? '页面切到后台（手机上系统可能就在这里回收掉页面）'
          : '页面回到前台',
      )
    const onPageHide = () => {
      info('session', '页面正在关闭或重新加载')
      flushLogs()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)

    if ('storage' in navigator && 'persist' in navigator.storage) {
      // Installed PWAs are exempt from iOS's 7-day storage sweep; asking for
      // persistence is the cheapest available protection for a 230 MB model.
      void navigator.storage.persist().then((granted) => {
        info('storage', granted ? '存储已设为持久，模型不会被自动清理' : '存储未获持久授权，长时间不用可能被清理')
      })
    }

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
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
    {#if $problem}
      <!-- The failure that cannot report itself. Rendered above everything, with
           the log one click away and no debug switch in the way. -->
      <div class="problem" role="alert">
        <div class="problem-head">
          <strong>{$problem.title}</strong>
          <button
            class="rc-btn ghost small"
            aria-label="关闭提示"
            onclick={() => problem.set(null)}>✕</button
          >
        </div>
        <p>{$problem.body}</p>
        <div class="problem-actions">
          {#if $problem.title.includes('显卡加速')}
            <!-- The one case where the fix is already in place: the accelerator
                 was downgraded, so the very next attempt is the retry. -->
            <button
              class="rc-btn accent small"
              onclick={() => void session.start().catch(() => undefined)}>现在再试一次</button
            >
          {/if}
          <button class="rc-btn accent small" onclick={() => logOpen.set(true)}>查看日志</button>
          <button
            class="rc-btn ghost small"
            onclick={() => void diagnosticReport($problem?.title ?? '启动失败').then((text) => copyText(text, '诊断信息已复制'))}
          >
            复制诊断信息
          </button>
        </div>
      </div>
    {/if}

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

<style>
  /* Deliberately loud: this is the one failure the user cannot get out of the
     browser themselves, on a device with no devtools. */
  .problem {
    margin: 8px 10px 0;
    padding: 10px 12px;
    border: 2px solid var(--rc-ink);
    border-radius: var(--rc-radius-s);
    background: var(--rc-danger-soft);
    font-size: 13px;
  }

  .problem-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .problem-head strong {
    flex: 1;
    line-height: 1.4;
  }

  .problem p {
    margin: 6px 0 0;
    color: var(--rc-ink-soft);
    line-height: 1.5;
  }

  .problem-actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }
</style>
