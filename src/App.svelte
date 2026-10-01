<script lang="ts">
  import { onMount } from 'svelte'
  import { fade } from 'svelte/transition'
  import { get } from 'svelte/store'
  import TitleBar from './components/TitleBar.svelte'
  import StartPage from './components/StartPage.svelte'
  import SubtitleBar from './components/SubtitleBar.svelte'
  import AsrPanel from './components/AsrPanel.svelte'
  import TranslationPanel from './components/TranslationPanel.svelte'
  import StatusBar from './components/StatusBar.svelte'
  import LogDrawer from './components/LogDrawer.svelte'
  import SettingsView from './components/SettingsView.svelte'
  import HistoryView from './components/HistoryView.svelte'
  import NavDrawer from './components/NavDrawer.svelte'
  import PausePanel from './components/PausePanel.svelte'
  import Modal from './components/Modal.svelte'
  import {
    session,
    view,
    toast,
    logNotice,
    logOpen,
    headphonePrompt,
    installLang,
    acknowledgeHeadphones,
  } from './lib/app/state'
  import { getSettings, forgetModel, settings } from './lib/store/settings'
  import { loadHistory } from './lib/history/store'
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
  import { ensureVoices } from './lib/tts/voices.ts'
  import { moduleFor, moduleLabel, moduleName, purgeRetiredModuleCaches } from './lib/asr/models'
  import { rememberGpuFailure } from './lib/asr/device'
  import { takeAsrCrashReport } from './lib/boot-guard'
  import { APP_VERSION } from './lib/app/version'
  import {
    createUpdateChecker,
    UPDATE_ATTEMPT_KEY,
    UPDATE_CHECK_MIN_GAP_MS,
    UPDATE_CHECK_MS,
  } from './lib/app/update'
  import { effectiveLang, setUiLang, t, translator, uiLang } from './lib/i18n/index.ts'

  // Strings shown in the markup go through this one, so that picking a different
  // language in settings re-renders the screen; the bare `t` imported above reads
  // the language as it is right now, which is what the log lines want (they are
  // written once, and never re-rendered).
  const tr = $derived(translator($uiLang))

  const { lines: linesStore, state: sessionState, notice } = session
  const lines = $derived($linesStore)
  const keepAudio = $derived($settings.keepAudio)
  /**
   * A paused session is a session waiting to be told what it is.
   *
   * The panel is keyed on the state rather than on a flag of its own, so that
   * every way into a pause — the footer's button, a future gesture, a resumed
   * session paused again — arrives at the same screen, and so that no path out of
   * one can leave the panel behind: whatever ends the pause changes the state,
   * and the panel is gone with it.
   */
  const paused = $derived($sessionState === 'paused')

  // The crash note exists to explain a failure the user has just lived through,
  // and it stops being true the moment a recording actually starts. Left up, it
  // would turn "the page died last time" into a permanent red headline over a
  // session that is working fine.
  $effect(() => {
    if ($sessionState === 'recording' && $logNotice) logNotice.set(null)
  })

  // The start page hands over the moment there is a session to look at.
  //
  // Keyed on the recording rather than on the button: a start can take a minute
  // (a module download, a permission prompt), and the page that reports that is
  // exactly the page the user is watching — the transition is what says "that is
  // done, this is the transcript", and it must not fire a second before the
  // microphone is actually open.
  $effect(() => {
    if ($sessionState === 'recording' && $view === 'start') view.set('translate')
  })

  /**
   * The cross-fade duration, and why it is zero on some phones.
   *
   * `prefers-reduced-motion` is the one accessibility setting this app can read,
   * and the transition from the start page to the transcript is the largest
   * movement in it — a full screen in, a full screen out.
   */
  const reducedMotion = $derived(
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  const swap = $derived({ duration: reducedMotion ? 0 : 260 })

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

  // ------------------------------------------------------------- panel split
  /**
   * How much of the content area the original-text panel gets.
   *
   * Kept under its own `localStorage` key rather than in settings: it is a window
   * measurement ("how much room does the text need right now"), not a preference
   * about the app, and the settings screen is not the place to go looking for it.
   * The default is the 50/50 the layout had before the divider existed, and the
   * range is bounded so neither panel can be dragged out of existence.
   */
  const SPLIT_KEY = 'rc.split.v1'
  const SPLIT_MIN = 0.18
  const SPLIT_MAX = 0.82
  /** The same query `app.css` stacks the panels with — the drag axis follows it. */
  const STACKED_QUERY = '(pointer: coarse) and (orientation: portrait)'

  function clampSplit(value: number): number {
    return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value))
  }

  function readSplit(): number {
    try {
      const stored = Number.parseFloat(localStorage.getItem(SPLIT_KEY) ?? '')
      if (Number.isFinite(stored)) return clampSplit(stored)
    } catch {
      /* storage refused: the split just does not survive the page */
    }
    return 0.5
  }

  function saveSplit(): void {
    try {
      localStorage.setItem(SPLIT_KEY, String(split))
    } catch {
      /* see `readSplit` */
    }
  }

  let split = $state(readSplit())
  /** True while the layout is the stacked one, where the divider drags up and down. */
  let stacked = $state(window.matchMedia(STACKED_QUERY).matches)
  let panelsEl: HTMLDivElement | undefined = $state()
  let splitDragging = $state(false)

  function onSplitDown(event: PointerEvent): void {
    splitDragging = true
    // Capture, not a document listener: the pointer only has to stay on the
    // divider to keep dragging it, and a move that runs off the edge still counts.
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function onSplitMove(event: PointerEvent): void {
    if (!splitDragging || !panelsEl) return
    const rect = panelsEl.getBoundingClientRect()
    split = clampSplit(
      stacked ? (event.clientY - rect.top) / rect.height : (event.clientX - rect.left) / rect.width,
    )
  }

  function endSplitDrag(event: PointerEvent): void {
    if (!splitDragging) return
    splitDragging = false
    ;(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId)
    saveSplit()
  }

  /** The same adjustment from the keyboard, which a drag-only control would deny. */
  function onSplitKey(event: KeyboardEvent): void {
    const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown'
    if (!back && !forward) return
    split = clampSplit(split + (back ? -0.04 : 0.04))
    saveSplit()
    event.preventDefault()
  }

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
    // The notes on this device, read once at startup: the start page's card shows
    // how many there are, and the drawer's 历史记录 opens a list that is already
    // there rather than an empty screen that fills in a moment later.
    void loadHistory()

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
      // microphone, Cache Storage and WebGPU at the same time. Said twice on
      // purpose: the line above is the fact, the notice below is the sentence for
      // the person holding the phone — and the notice mirror further down is what
      // puts that sentence in the log, now that no bar draws it.
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
      // And the voice list is asked for again, for the same reason it is armed
      // here at all: iOS publishes no voices until the page has spoken, so the
      // list that came back empty at startup — before any tap existed to arm
      // speech with — is out of date the moment this line has run. Asking is
      // cheap (a cached, non-empty list is not asked again) and it is what makes
      // the read-aloud dialog open on a full list rather than on a placeholder.
      ensureVoices(getSettings())
    }
    window.addEventListener('pointerdown', armSpeech)

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)

    /*
     * A page that never navigates never learns about a deployment. iOS keeps a
     * suspended Home Screen web app alive for days, and the page that comes back
     * is still the build it was opened with — across however many deploys
     * happened in between. Every check from the outside (the deployed shell, the
     * asset hashes, the service worker) says the app is current, and the phone
     * says otherwise, and both are right. So the page asks the server for its own
     * `index.html` and compares the version stamped into it with the one it is
     * running; `lib/app/update.ts` owns the rule, this is when it is asked and
     * what a postponed update says on screen.
     */
    const updates = createUpdateChecker({
      current: APP_VERSION,
      fetchIndex: async () => {
        // `no-store`, because the whole question is what the server has *now*.
        // The request also goes through the service worker, which is
        // network-first and falls back to its cache only when offline.
        const response = await fetch(new URL('./', location.href), { cache: 'no-store' })
        if (!response.ok) throw new Error(`index.html: ${response.status}`)
        return response.text()
      },
      // The things a reload would take away, in the order they matter: a session
      // in progress, a transcript the user may still need, and a module download
      // the install dialog is watching. Everything else on screen is rebuilt from
      // storage on the way back up. `session.model` is deliberately not part of
      // this: it is a load *progress* readout, and a load abandoned by a cancelled
      // start leaves it non-null forever — which would turn the update check off
      // for the rest of the page's life, the one failure this feature exists to
      // prevent.
      canReload: () =>
        get(sessionState) === 'idle' &&
        get(linesStore).length === 0 &&
        get(installLang) === null,
      reload: () => location.reload(),
      beforeReload: (version) =>
        info('session', t('服务端有新版本 {version}，页面正在自动更新', { version })),
      announce: (version) => {
        warn('session', t('服务端有新版本 {version}，这一场还占着页面：先不更新', { version }))
        session.notice.set(
          t('服务端有新版本 {version}：不打断这一场；把应用关掉再打开就会更新', { version }),
        )
      },
      // The loop guard has to survive the reload it describes, hence the storage
      // rather than a variable — see `UPDATE_ATTEMPT_KEY`. If storage is refused
      // (private mode), the worst case is one extra reload of an unchanged page.
      reloadedVersion: () => {
        try {
          return sessionStorage.getItem(UPDATE_ATTEMPT_KEY)
        } catch {
          return null
        }
      },
      rememberReload: (version) => {
        try {
          sessionStorage.setItem(UPDATE_ATTEMPT_KEY, version)
        } catch {
          /* see above */
        }
      },
    })
    let lastUpdateCheck = 0
    const checkForUpdates = () => {
      const now = Date.now()
      if (now - lastUpdateCheck < UPDATE_CHECK_MIN_GAP_MS) return
      lastUpdateCheck = now
      void updates.check()
    }
    // Foreground is the moment that matters: the user is looking at the app
    // again, and a build that went stale while it was suspended starts being
    // wrong right there.
    const onUpdateCheck = () => {
      if (document.visibilityState === 'visible') checkForUpdates()
    }
    document.addEventListener('visibilitychange', onUpdateCheck)
    const updateTimer = setInterval(checkForUpdates, UPDATE_CHECK_MS)
    checkForUpdates()

    /*
     * Every notice the session produces, written to the log as it is produced.
     *
     * `session.notice` used to be the status bar's line: one sentence, on screen,
     * explaining why nothing is being read out or why the microphone went quiet.
     * The user asked for that bar to hold nothing but its two buttons, so the
     * sentences need somewhere to go — and the log is the right place for them, not
     * a second reason: a classroom's worth of notices is one line each, most of them
     * arrive while nobody is looking at the phone, and the drawer can be read
     * afterwards where a bar that changed width could only be noticed afterwards.
     *
     * One subscription rather than a log call beside each of the twenty-odd
     * `notice.set`s: the invariant that matters is that *nothing lands here and is
     * lost*, and a rule applied in one place is the only version of that rule a
     * later change cannot forget. Most of those sites log the technical cause
     * themselves; this line is the sentence the user would have read, which is
     * exactly what a bug report needs and what the drawer previously could not show.
     *
     * Repeated while it stands writes one line, not one per sentence. The one
     * notice that repeats by design is the read-aloud failure — a dead TTS proxy
     * says the same thing once per sentence for the rest of the lesson — and a log
     * whose drawer groups *by timestamp* is not helped by four thousand copies of
     * it. Clearing the notice (`notice.set('')`, at the top of every start) is what
     * makes the same sentence news again.
     */
    let lastNotice = ''
    const stopNoticeMirror = notice.subscribe((text) => {
      if (!text) {
        lastNotice = ''
        return
      }
      if (text === lastNotice) return
      lastNotice = text
      warn('ui', text)
    })

    // The divider's axis has to follow the layout, and the layout is a media
    // query — so the query is watched rather than sampled once. Rotating the
    // phone is exactly when this changes.
    const stackedMedia = window.matchMedia(STACKED_QUERY)
    const onStacked = () => (stacked = stackedMedia.matches)
    stackedMedia.addEventListener('change', onStacked)

    if ('storage' in navigator && 'persist' in navigator.storage) {
      // Installed PWAs are exempt from iOS's 7-day storage sweep; asking for
      // persistence is the cheapest available protection for a 230 MB model.
      void navigator.storage.persist().then((granted) => {
        info('storage', granted ? t('存储已设为持久，模型不会被自动清理') : t('存储未获持久授权，长时间不用可能被清理'))
      })
    }

    return () => {
      stopNoticeMirror()
      window.removeEventListener('pointerdown', armSpeech)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      document.removeEventListener('visibilitychange', onUpdateCheck)
      clearInterval(updateTimer)
      stackedMedia.removeEventListener('change', onStacked)
    }
  })
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape' && $headphonePrompt) headphonePrompt.set(false)
  }}
/>

<!--
  Two views, absolutely placed on top of each other, because that is what a
  cross-fade needs: with both in flow, the incoming view lands below the outgoing
  one for the length of the transition and the app appears to jump.
-->
<div class="views">
{#if $view === 'start'}
  <div class="view" transition:fade={swap}>
    <StartPage />
  </div>
{:else}
  <div class="view" in:fade={swap}>
<div class="sandwich">
  <header>
    <TitleBar />
  </header>

  <main>
    {#if $view === 'settings'}
      <SettingsView />
    {:else if $view === 'history'}
      <HistoryView />
    {:else}
      <!-- The queue/lag strip (requirement 20) is a diagnostics readout: it is
           only rendered in debug mode. Nothing is lost by hiding it — a failed
           translation is marked on its own line in the translation panel, and
           the "skip to latest" escape hatch lives in that panel's header. -->
      {#if $settings.debugMode}
        <SubtitleBar />
      {/if}
      <div class="panels" bind:this={panelsEl} style={`--split:${(split * 100).toFixed(2)}%`}>
        <AsrPanel {lines} audioAvailable={keepAudio} />
        <!--
         * Draggable, and reachable from the keyboard: this is the ARIA window
         * splitter (a separator with a tabindex), and the arrow keys move it. A
         * control that only responds to a drag is a control half the users do not
         * have.
         *
         * The two rules below are silenced on purpose, with the reason attached:
         * they describe the *decorative* separator, and a focusable one is the
         * interactive splitter.
         -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
          class="splitter"
          class:dragging={splitDragging}
          role="separator"
          aria-orientation={stacked ? 'horizontal' : 'vertical'}
          aria-label={tr('拖动调整原文和译文的大小')}
          aria-valuenow={Math.round(split * 100)}
          aria-valuemin={Math.round(SPLIT_MIN * 100)}
          aria-valuemax={Math.round(SPLIT_MAX * 100)}
          tabindex="0"
          onpointerdown={onSplitDown}
          onpointermove={onSplitMove}
          onpointerup={endSplitDrag}
          onpointercancel={endSplitDrag}
          onkeydown={onSplitKey}
        ></div>
        <TranslationPanel {lines} />
      </div>
    {/if}
  </main>

  <!--
   * No footer on the history screen: the recording button and the read-aloud
   * switch are both about a session, and a phone's thumb corners are the last
   * place a button that does nothing belongs. The way out is the screen's own
   * 返回, at the top, where lists put it.
   -->
  {#if $view !== 'history'}
    <footer>
      <StatusBar />
    </footer>
  {/if}
</div>
  </div>
{/if}
</div>

<LogDrawer />
<NavDrawer />

{#if paused}
  <PausePanel />
{/if}

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

<style>
  /*
   * The app is one screen at a time and each screen is the whole window, so the
   * wrapper is exactly the window and the views are pinned to it. Absolute
   * rather than a grid with two rows: an `{#if}` renders one child, not two, so
   * the second row would only exist during a transition.
   */
  .views {
    position: relative;
    height: 100%;
    overflow: hidden;
  }

  .view {
    position: absolute;
    inset: 0;
  }
</style>
