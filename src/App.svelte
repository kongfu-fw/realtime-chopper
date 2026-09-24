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
    logNotice,
    logOpen,
    headphonePrompt,
    acknowledgeHeadphones,
  } from './lib/app/state'
  import { getSettings, forgetModel, settings } from './lib/store/settings'
  import { applyAppIcon } from './lib/brand/apply'
  import {
    configureLogging,
    error as logError,
    flushLogs,
    info,
    releaseLogClaim,
    restoredCount,
    warn,
  } from './lib/log/store'
  import { speechSupported } from './lib/tts/speech'
  import { MODULE_NAME, moduleFor, purgeRetiredModuleCaches } from './lib/asr/models'
  import { rememberGpuFailure } from './lib/asr/device'
  import { takeAsrCrashReport } from './lib/boot-guard'

  const { lines: linesStore, state: sessionState } = session
  const lines = $derived($linesStore)
  const keepAudio = $derived($settings.keepAudio)

  // The crash note exists to explain a failure the user has just lived through,
  // and it stops being true the moment a recording actually starts. Left up, it
  // would turn "the page died last time" into a permanent red headline over a
  // session that is working fine.
  $effect(() => {
    if ($sessionState === 'recording' && $logNotice) logNotice.set(null)
  })

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
    // user is left looking at a page that just flashed.
    //
    // So the diagnosis is written into the log and the drawer is opened on it.
    // This used to raise a red box beside the title bar instead, which meant the
    // failure was explained *outside* the log while the lines that prove it sat
    // behind a switch — on a phone the box was the whole report, with no way to
    // reach the evidence it was describing.
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
        logNotice.set({
          title: '显卡加速把页面带崩了，已自动改用 CPU',
          body: `iPhone / Safari 上的 WebGPU 一启用就会把整个页面关掉，这个模块本身没问题。现在再试一次即可（设置里也可以自己确认「显卡加速」选的是 CPU）。${
            restoredCount > 0 ? '下面标红的那一条记着当时用的是哪个加速器。' : ''
          }`,
          // The fix is already in place, so this is the one failure the drawer can
          // offer to undo with a button rather than describe.
          retry: true,
        })
      } else {
        logError('asr', `上次启动${name}时页面被系统直接关掉了（第 ${crash.count} 次，多半是内存不够）`, {
          提示: '弹窗闪一下就没了、控制台没有任何报错，通常就是这一种',
        })
        // Where the evidence is decides what can be promised. A tail can still be
        // missing — the page was killed before its first write reached storage,
        // or it died long enough ago that the tail aged out — and pointing
        // somebody at a line that is not there is worse than saying plainly that
        // it did not survive.
        //
        // "标红的那一条", not "最后一条": the failure's line is logged by *this*
        // load, so by the time anybody reads it there are already newer lines
        // under it (startup, the storage probe, the visibility events). The line
        // itself is unambiguous; its position is not.
        const tail =
          restoredCount > 0
            ? '下面标红的那一条就是它倒下的地方，它前面几行是崩溃前的最后状态。'
            : '这次没能找回崩溃前的日志尾巴，只能确认它是在这一步倒下的。'
        logNotice.set({
          title: `上次启动${name}时，页面被系统直接关掉了`,
          body:
            crash.count >= 2
              ? `这台设备装不下这个模块（240MB 的模型加上识别引擎）。再点还是会一样，先别试了。${tail}`
              : `多半是内存不够：这种失败不会弹任何错误，页面只是闪一下就重开了。${tail}`,
        })
      }
      // The evidence only exists in the log, so for this one failure the log comes
      // to the user instead of waiting to be asked for.
      logOpen.set(true)
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
      // Flush first: the claim is what tells the next load whether this tab is
      // still in use, so giving it up has to happen after this page's last write.
      releaseLogClaim()
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
