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
  import { appTitle } from './lib/brand/logo'
  import {
    configureLogging,
    error as logError,
    flushLogs,
    info,
    releaseLogClaim,
    restoredCount,
    warn,
  } from './lib/log/store'
  import { createTtsEngine, ttsConfigFrom } from './lib/tts/engine'
  import { moduleFor, moduleLabel, moduleName, purgeRetiredModuleCaches } from './lib/asr/models'
  import { rememberGpuFailure } from './lib/asr/device'
  import { takeAsrCrashReport } from './lib/boot-guard'
  import { APP_VERSION } from './lib/app/version'
  import { effectiveLang, setUiLang, t, translator, uiLang } from './lib/i18n/index.ts'

  // Strings shown in the markup go through this one, so that picking a different
  // language in settings re-renders the screen; the bare `t` imported above reads
  // the language as it is right now, which is what the log lines want (they are
  // written once, and never re-rendered).
  const tr = $derived(translator($uiLang))

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

  // The interface language follows the setting, and `auto` follows the browser.
  //
  // The window title and the manifest are re-applied here too, and not only when
  // the icon changes: both carry text, and text follows the language.
  $effect(() => {
    setUiLang(effectiveLang($settings.uiLang))
    document.title = appTitle()
    applyAppIcon($settings.appIcon)
  })

  // Logging configuration follows the settings live.
  $effect(() => {
    configureLogging($settings.logRing, $settings.logLevel)
  })

  // VAD thresholds, provider config and rate limits are re-read on every change,
  // so a slider takes effect without a restart.
  $effect(() => {
    void $settings
    session.applySettings()
  })

  onMount(() => {
    // English no longer has a second module (Parakeet) — anyone who installed it
    // is holding 126 MB that nothing will open again. Drop the record and the
    // caches in the same breath, once.
    //
    // Korean used to be forgotten here as well, and that is now wrong: back then
    // the record to drop was the one the *Chinese* module's download had left
    // behind (that module was answering Korean), so `ko` could only be a leftover
    // from the Moonshine era. Korean has a module of its own again, which makes
    // `ko` the genuine key — this line would have deleted a real Korean install on
    // every reload, and the app would have asked for the download again each
    // time, which reads as storage that does not stick.
    //
    // A Moonshine-era record needs no help anyway: its `version` no longer
    // matches the registry, so it already reads as not installed, and the retired
    // cache prefix clears its bytes.
    if (getSettings().installedModels['en-nemo']) forgetModel('en-nemo')
    void purgeRetiredModuleCaches().then((gone) => {
      if (gone.length) info('storage', t('已清理不再使用的识别模块：{list}', { list: gone.join(t('、')) }))
    })

    // Named at startup because "which module is running" is the first thing a bug
    // report from a phone needs to say, and it is a decision made here (by the
    // source language) rather than typed in by the user anywhere.
    const spec = moduleFor($settings.sourceLang)
    // Named here too, for the same reason as the module: a bug report that says
    // which read-aloud engine was in use answers the first question about it.
    const tts = createTtsEngine(ttsConfigFrom($settings))
    info('session', t('应用已启动'), {
      [t('版本')]: APP_VERSION,
      [t('默认语向')]: `${$settings.sourceLang} → ${$settings.targetLang}`,
      [t('识别模块')]: moduleLabel(spec),
      [t('朗读')]: `${tts.label}${tts.available ? '' : t('（不可用）')}`,
    })
    if (!window.isSecureContext) {
      // On a phone this single fact explains almost everything that looks broken:
      // opened over a plain http:// LAN address, the browser withholds the
      // microphone, Cache Storage and WebGPU at the same time. Say it where a
      // phone can actually read it (the status bar), not just in the log.
      warn('session', t('当前不是安全上下文（https/localhost）：麦克风、模型缓存和显卡加速都会被浏览器禁用'))
      session.notice.set(t('这个地址不能用麦克风：请用 https 或电脑上的 localhost 打开'))
    }
    if (!tts.available) {
      warn(
        'tts',
        $settings.ttsEngine === 'edge'
          ? t('没有填 Edge TTS 代理地址，译文不会自动读出来')
          : t('这个浏览器不支持语音朗读，译文不会自动读出来'),
      )
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
      const name = moduleName(crash.module)
      if (crash.accelerator === 'webgpu') {
        // Measured on an iPhone 14 Pro: the page dies ~2.7 s after the engine is
        // asked for WebGPU, twice, silently — and the same module on the CPU is
        // fine. So this crash bans the *accelerator*, never the module: the note
        // that recorded it is what lets the next attempt succeed instead of
        // repeating the flash.
        rememberGpuFailure(t('上次启用显卡加速时整个页面被系统关掉了'))
        logError('asr', t('上次启动{name}时页面被系统直接关掉了 —— 当时用的是显卡加速（WebGPU），已记住，下次改用 CPU', { name }), {
          [t('依据')]: t('iPhone / Safari 上启用 WebGPU 会把渲染进程带崩，一闪重开、无异常可捕'),
        })
        logNotice.set({
          title: t('显卡加速把页面带崩了，已自动改用 CPU'),
          body: `${t('iPhone / Safari 上的 WebGPU 一启用就会把整个页面关掉，这个模块本身没问题。现在再试一次即可（设置里也可以自己确认「显卡加速」选的是 CPU）。')}${
            restoredCount > 0 ? t('下面标红的那一条记着当时用的是哪个加速器。') : ''
          }`,
          // The fix is already in place, so this is the one failure the drawer can
          // offer to undo with a button rather than describe.
          retry: true,
        })
      } else {
        logError('asr', t('上次启动{name}时页面被系统直接关掉了（第 {n} 次，多半是内存不够）', { name, n: crash.count }), {
          [t('提示')]: t('弹窗闪一下就没了、控制台没有任何报错，通常就是这一种'),
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
            ? t('下面标红的那一条就是它倒下的地方，它前面几行是崩溃前的最后状态。')
            : t('这次没能找回崩溃前的日志尾巴，只能确认它是在这一步倒下的。')
        logNotice.set({
          title: t('上次启动{name}时，页面被系统直接关掉了', { name }),
          body:
            crash.count >= 2
              ? `${t('这台设备装不下这个模块（240MB 的模型加上识别引擎）。再点还是会一样，先别试了。')}${tail}`
              : `${t('多半是内存不够：这种失败不会弹任何错误，页面只是闪一下就重开了。')}${tail}`,
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
          ? t('页面切到后台（手机上系统可能就在这里回收掉页面）')
          : t('页面回到前台'),
      )
    const onPageHide = () => {
      info('session', t('页面正在关闭或重新加载'))
      flushLogs()
      // Flush first: the claim is what tells the next load whether this tab is
      // still in use, so giving it up has to happen after this page's last write.
      releaseLogClaim()
    }
    /*
     * iOS only lets a page produce speech from inside a user gesture, and
     * read-aloud is driven by the recognition pipeline — never by a tap. So the
     * first tap the page gets is spent arming speech, before the user has any
     * reason to press anything in particular: by the time the record button is
     * pressed, the model download has already waited the gesture away.
     *
     * One tap is enough for the page's lifetime, and removing the listener after
     * the first one keeps a mid-sentence tap from queueing anything behind the
     * sentence being read.
     */
    const armSpeech = () => {
      window.removeEventListener('pointerdown', armSpeech)
      session.unlockSpeech()
    }
    window.addEventListener('pointerdown', armSpeech)

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)

    if ('storage' in navigator && 'persist' in navigator.storage) {
      // Installed PWAs are exempt from iOS's 7-day storage sweep; asking for
      // persistence is the cheapest available protection for a 230 MB model.
      void navigator.storage.persist().then((granted) => {
        info('storage', granted ? t('存储已设为持久，模型不会被自动清理') : t('存储未获持久授权，长时间不用可能被清理'))
      })
    }

    return () => {
      window.removeEventListener('pointerdown', armSpeech)
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
    title={tr('先戴上耳机')}
    onclose={() => headphonePrompt.set(false)}
  >
    <p>{tr('不戴耳机，麦克风会听到手机读译文的声音，就会自己翻译自己。')}</p>
    {#snippet footer()}
      <button class="rc-btn ghost" onclick={() => headphonePrompt.set(false)}>{tr('不用了')}</button>
      <button
        class="rc-btn accent"
        onclick={() => {
          acknowledgeHeadphones()
          headphonePrompt.set(false)
          void session.start().catch((err: unknown) =>
            warn('session', t('启动失败：{error}', { error: err instanceof Error ? err.message : String(err) })),
          )
        }}
      >
        {tr('戴好了，开始')}
      </button>
    {/snippet}
  </Modal>
{/if}

{#if $toast}
  <div class="clone-toast">{$toast}</div>
{/if}
