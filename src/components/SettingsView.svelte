<script lang="ts">
  import SettingRow from './SettingRow.svelte'
  import { session, runDiagnostics, selfCheckRunning } from '../lib/app/state'
  import {
    settings,
    setSetting,
    resetSettings,
    formatBytes,
    forgetModel,
    isModuleCurrent,
    TARGET_ORDER,
    langLabel,
  } from '../lib/store/settings'
  import {
    ASR_MODULES,
    MODULE_CACHE_KEYS,
    MODULE_IDS,
    moduleShort,
    moduleUsedOnThisDevice,
  } from '../lib/asr/models'
  import { addressProblem } from '../lib/asr/koasr'
  import { isAppleMobile } from '../lib/asr/device'
  import {
    LANG_NAMES,
    SUPPORTED_LANGS,
    detectLang,
    dropUrlOverride,
    effectiveLang,
    t,
    translator,
    uiLang,
    type UiLangSetting,
  } from '../lib/i18n/index.ts'
  import { ttsEngineLabel, type TtsEngineId } from '../lib/tts/engine'
  import { providerLabel } from '../lib/mt/probe'
  import { APP_VERSION } from '../lib/app/version'
  import { APP_ICONS, iconFor, iconPreviewUrl, type AppIconId } from '../lib/brand/logo'
  import { info } from '../lib/log/store'
  import type {
    Accelerator,
    AsrBackend,
    LlmFormat,
    LogLevelSetting,
    MtProviderId,
    Precision,
  } from '../lib/store/settings'
  import type { Lang, ModuleId } from '../lib/types'

  // Markup reads `tr`, so a language change redraws the page; the handlers below
  // use `t`, which is the language as it is at that moment.
  const tr = $derived(translator($uiLang))

  /**
   * What the follow-the-browser choice says it will actually pick.
   *
   * Naming the language the browser asked for turns an abstract option into an
   * answer: "Follow the browser (English)" is a setting a person can verify,
   * "Auto" is one they have to trust.
   */
  // The browser's language, not what the app is showing: with a `?lang=` link
  // open, the two differ, and this label says what `auto` would follow.
  const autoLang = $derived(LANG_NAMES[detectLang()])

  /**
   * Switching engines swaps a whole voice namespace, so the engine is rebuilt and
   * the picker in the translation panel re-reads its list — the two engines have
   * no voice names in common.
   */
  function pickTtsEngine(id: TtsEngineId) {
    if (id === $settings.ttsEngine) return
    setSetting('ttsEngine', id)
    info('ui', t('朗读引擎换为{engine}', { engine: ttsEngineLabel(id) }), {
      [t('说明')]:
        id === 'edge'
          ? t('走代理 {url}', { url: $settings.ttsProxyUrl })
          : t('用系统音色，不需网络'),
    })
  }

  /**
   * Changing where recognition happens has to drop the resident recogniser.
   *
   * The two backends are different modules, and a module is what a client is bound
   * to: leaving the old one loaded would keep answering with the engine the user
   * just turned off, while the picker said otherwise. Same reasoning — and the same
   * call — as the language picker in `TitleBar`.
   */
  async function pickAsrBackend(id: AsrBackend) {
    if (id === $settings.asrBackend) return
    setSetting('asrBackend', id)
    session.applySettings()
    await session.releaseModel()
    info('ui', t('识别后端换为 {backend}', { backend: id }), {
      note: t('下次开始录音时生效'),
    })
  }

  function pickIcon(id: AppIconId) {
    if (id === $settings.appIcon) return
    setSetting('appIcon', id)
    // Applying it happens in App.svelte, where the setting is watched.
    info('ui', t('应用图标换成「{name}」', { name: t(iconFor(id).label) }), {
      note: t('已经装到桌面的图标要删掉重新添加才会更新'),
    })
  }

  async function clearModule(module: ModuleId) {
    const owned = MODULE_CACHE_KEYS[module]
    if (typeof caches !== 'undefined') {
      // The module's own bucket(s), plus anything an older build left under this
      // module's prefix. See `MODULE_CACHE_KEYS`: Moonshine does not live under
      // `rc-model-en-…` at all, so the prefix guess deleted nothing and the app
      // still reported the 62 MB as cleared.
      for (const key of await caches.keys()) {
        if (owned.includes(key) || key.startsWith(`rc-model-${module}-`)) await caches.delete(key)
      }
    }
    forgetModel(module)
    await session.releaseModel()
    info('storage', t('已清除 {module} 识别模块，下次使用需要重新下载', { module: moduleShort(module) }))
  }

  // Version-aware: a module whose bytes were replaced by a newer build is not
  // installed, so the download button comes back instead of lying to the user.
  const installed = $derived(
    MODULE_IDS.filter((key) => isModuleCurrent(key, $settings.installedModels[key])),
  )
  const totalInstalledBytes = $derived(
    installed.reduce((sum, key) => sum + ($settings.installedModels[key]?.bytes ?? ASR_MODULES[key].approxBytes), 0),
  )

  /**
   * Whether this device refuses to fall back to the local recogniser.
   *
   * Read from the device rather than from a setting, because that is where the
   * rule lives (`mayFallBackToLocal`), and the sentences below have to be the ones
   * that match what will actually happen: on a phone, "the local model" is the
   * small Korean model this whole route exists to stop using.
   */
  const asrNoFallback = isAppleMobile()

  /**
   * Why the configured service address cannot be used from this page, in words.
   *
   * Shown *here* rather than discovered at the start of a session, because at the
   * start of a session the only visible symptom is "it used the local model" — and
   * the whole point of the setting is that this device was supposed to use the
   * service. The two faults are the two ways it silently does not happen: nothing
   * configured, and an `http://` address on an `https:` page, which the browser
   * blocks before the request exists. Where the fallback is not allowed at all
   * (`asrNoFallback`) neither fault is quiet — both stop the session — so the
   * sentence has to say that rather than promise a local model.
   */
  const asrAddressFault = $derived.by(() => {
    if ($settings.asrBackend === 'local') return ''
    const fault = addressProblem($settings.asrBaseUrl, location.protocol)
    if (!fault) return ''
    // Apple's mobile has nothing to fall back to (`mayFallBackToLocal`), so there
    // the same two faults are not "the network will not be used": they are a
    // session that will not start. Two sentences per fault, because a warning that
    // describes the softer behaviour is worse than no warning at all.
    if (asrNoFallback) {
      return fault === 'empty'
        ? tr('还没填地址。这台设备连不上识别服务就直接报错，不会退回本机模型：要么把地址填上，要么把上面改成「只用本机模型」。')
        : tr('页面是 https，填 http 的地址浏览器会直接拦掉，而这台设备不会退回本机模型：把服务也用 https 发出来（见 DOCKER.md），或者把这里改成同一台机器上的 /asr。')
    }
    return fault === 'empty'
      ? tr('还没填地址，网络识别不会启用。')
      : tr('页面是 https，填 http 的地址浏览器会直接拦掉：把服务也用 https 发出来（见 DOCKER.md），或者把这里改成同一台机器上的 /asr。')
  })

  /** Continuous recording state, mirrored from the pipeline worker. */
  const { recording } = session
  const hasRecording = $derived(($recording?.seconds ?? 0) >= 1)
  const recordingSummary = $derived.by(() => {
    // `tr`, not `t`: this value is rendered, so it has to follow the language.
    if (!$recording || !hasRecording) return tr('没有')
    const total = Math.round($recording.seconds)
    const minutes = Math.floor(total / 60)
    const seconds = String(total % 60).padStart(2, '0')
    return `${minutes}:${seconds} · ${formatBytes($recording.bytes)}`
  })
</script>

<div class="settings">
  <h1>{tr('设置')}</h1>

  <section>
    <h2>{tr('语言')}</h2>
    <SettingRow
      label={tr('界面语言')}
      help={tr('默认跟随浏览器；选错了也可以自己定。日志和诊断报告也跟着这个语言走。')}
    >
      <!-- What the interface is *in*, not what the setting says: while a `?lang=`
           link is overriding it the two differ, and this is the honest one. -->
      <select
        class="rc-select"
        value={effectiveLang($settings.uiLang)}
        onchange={(e) => {
          // Picking a language is deliberate, so it also retires a `?lang=` link.
          dropUrlOverride()
          setSetting('uiLang', (e.currentTarget as HTMLSelectElement).value as UiLangSetting)
        }}
      >
        <option value="auto">{tr('跟随浏览器（{lang}）', { lang: autoLang })}</option>
        {#each SUPPORTED_LANGS as lang (lang)}
          <option value={lang}>{LANG_NAMES[lang]}</option>
        {/each}
      </select>
    </SettingRow>
  </section>

  <section>
    <h2>{tr('外观')}</h2>
    <SettingRow
      label={tr('应用图标')}
      help={tr('装到手机或桌面上时用的图标。已经装过的，要删掉重新「添加到主屏幕」才会换成新的。')}
    >
      <div class="icons">
        {#each APP_ICONS as icon (icon.id)}
          <button
            class="icon"
            class:on={$settings.appIcon === icon.id}
            type="button"
            title={tr(icon.label)}
            aria-label={tr('图标：{name}', { name: tr(icon.label) })}
            aria-pressed={$settings.appIcon === icon.id}
            onclick={() => pickIcon(icon.id)}
          >
            <img
              src={iconPreviewUrl(icon.id)}
              style={`background:${icon.bg}`}
              alt=""
              width="30"
              height="30"
            />
          </button>
        {/each}
      </div>
    </SettingRow>
  </section>

  <section>
    <h2>{tr('识别')}</h2>
    <SettingRow label={tr('说话停顿多久算一句')} help={tr('停顿超过这么久，就算一句说完了。')}>
      <input
        type="range"
        min="300"
        max="1200"
        step="50"
        value={$settings.silenceMs}
        oninput={(e) => setSetting('silenceMs', Number((e.currentTarget as HTMLInputElement).value))}
      />
      <span class="value">{$settings.silenceMs} ms</span>
    </SettingRow>

    <SettingRow label={tr('一句话最长不超过')} help={tr('一直不停顿，也会在这里切一句。')}>
      <input
        type="range"
        min="3000"
        max="20000"
        step="1000"
        value={$settings.maxSegMs}
        oninput={(e) => setSetting('maxSegMs', Number((e.currentTarget as HTMLInputElement).value))}
      />
      <span class="value">{tr('{n} 秒', { n: ($settings.maxSegMs / 1000).toFixed(0) })}</span>
    </SettingRow>

    <SettingRow label={tr('识别精度')} help={tr('省电优先更流畅，也更容易听错。')}>
      <select
        class="rc-select"
        value={$settings.precision}
        onchange={(e) => setSetting('precision', (e.currentTarget as HTMLSelectElement).value as Precision)}
      >
        <option value="high">{tr('高精度')}</option>
        <option value="eco">{tr('省电优先')}</option>
      </select>
    </SettingRow>

    <SettingRow
      label={tr('用显卡加速')}
      help={tr('有显卡会更快。中文识别一直用 CPU；iPhone / iPad 上别选「显卡优先」——实测一启用就把整个页面带崩，所以那边的自动档走 CPU。')}
    >
      <select
        class="rc-select"
        value={$settings.accelerator}
        onchange={(e) => setSetting('accelerator', (e.currentTarget as HTMLSelectElement).value as Accelerator)}
      >
        <option value="auto">{tr('自动')}</option>
        <option value="webgpu">{tr('显卡优先')}</option>
        <option value="wasm">{tr('CPU 兜底')}</option>
      </select>
    </SettingRow>

    <SettingRow
      label={tr('英文识别模型')}
      help={tr('英文只有一个识别模型（Moonshine Base，约 62 MB）：桌面上会走显卡加速，iPhone / iPad 上自动用 CPU 加多线程——同一段音频实测比 Parakeet 更快也更小。Parakeet 已经从这个版本里去掉了。')}
    >
      <span class="value">Moonshine Base</span>
    </SettingRow>

    <SettingRow label={tr('已下载的识别模块')}>
      <span class="value">
        {installed.length === 0
          ? tr('还没有')
          : tr('{n} 个 · {size}', { n: installed.length, size: formatBytes(totalInstalledBytes) })}
      </span>
    </SettingRow>

    <div class="module-list">
      {#each MODULE_IDS as key (key)}
        <div class="module">
          <span>{moduleShort(key, $uiLang)}</span>
          {#if !moduleUsedOnThisDevice(key)}
            <span class="dim">{tr('手机上使用')}</span>
          {/if}
          <span class="dim">{formatBytes(ASR_MODULES[key].approxBytes, $uiLang)}</span>
          {#if isModuleCurrent(key, $settings.installedModels[key])}
            <span class="badge ok">{tr('已安装')}</span>
            <button class="rc-btn ghost small" onclick={() => void clearModule(key)}>{tr('清除')}</button>
          {:else}
            <span class="badge">{tr('未安装')}</span>
          {/if}
        </div>
      {/each}
      <p class="dim note">
        {tr('中文和韩语共用 SenseVoice；英文和手机上的韩语用 Moonshine（更小、约 64 MB）；同时只驻留一个。')}
      </p>
    </div>

    <!--
      The network recogniser, beside the downloads it can replace rather than in
      another section: "where does recognition happen" is one question, and the two
      answers are a file on this device and a machine on the network.
    -->
    <SettingRow
      label={tr('识别走哪里')}
      help={tr('韩语还能交给网络上的识别服务：模型大得多，认得更准，但要在同一网络里有台机器开着它。自动档只在手机上用网络——电脑上的韩语本来就有个更大的本机模型，换成网络只会变慢。') +
        (asrNoFallback ? tr('这台设备连不上识别服务会直接报错，不会退回本机韩语模型。') : '')}
    >
      <select
        class="rc-select"
        value={$settings.asrBackend}
        onchange={(e) => void pickAsrBackend((e.currentTarget as HTMLSelectElement).value as AsrBackend)}
      >
        <option value="auto">{tr('自动（手机上韩语走网络）')}</option>
        <option value="local">{tr('只用本机模型')}</option>
        <option value="network">{tr('网络服务优先')}</option>
      </select>
    </SettingRow>

    <SettingRow
      label={tr('识别服务地址')}
      help={tr('默认 /asr，指的是和本页面同一台机器上的服务（怎么转发见 DOCKER.md）。也可以填完整地址，比如 https://主机名:8444（跨源，服务默认允许）—— 但页面是 https 时 http:// 开头的那种地址会被浏览器直接拦掉。')}
    >
      <input
        class="rc-input"
        type="text"
        placeholder="/asr"
        value={$settings.asrBaseUrl}
        oninput={(e) => setSetting('asrBaseUrl', (e.currentTarget as HTMLInputElement).value)}
      />
    </SettingRow>

    {#if asrAddressFault}
      <p class="warn">{asrAddressFault}</p>
    {/if}
  </section>

  <section>
    <h2>{tr('翻译')}</h2>
    <SettingRow label={tr('翻译用哪家')} help={tr('默认谷歌；谷歌用不了会自动换微软。')}>
      <select
        class="rc-select"
        value={$settings.mtProvider}
        onchange={(e) => {
          setSetting('mtProvider', (e.currentTarget as HTMLSelectElement).value as MtProviderId)
          session.applySettings()
        }}
      >
        <option value="google">{providerLabel('google', $uiLang)}</option>
        <option value="microsoft">{providerLabel('microsoft', $uiLang)}</option>
        <option value="llm">{providerLabel('llm', $uiLang)}</option>
      </select>
    </SettingRow>

    <SettingRow label={tr('翻译攒几句一起发')} help={tr('攒多几句一起发：省流量，但更慢。')}>
      <input
        type="range"
        min="0"
        max="1500"
        step="50"
        value={$settings.mtBatchWindowMs}
        oninput={(e) => setSetting('mtBatchWindowMs', Number((e.currentTarget as HTMLInputElement).value))}
      />
      <span class="value">{$settings.mtBatchWindowMs} ms</span>
    </SettingRow>

    <SettingRow label={tr('记住翻过的句子')} help={tr('同一句话不重复翻译。')}>
      <input
        type="checkbox"
        checked={$settings.mtCache}
        onchange={(e) => setSetting('mtCache', (e.currentTarget as HTMLInputElement).checked)}
      />
    </SettingRow>

    <SettingRow label={tr('谷歌 API 密钥（可选）')} help={tr('不用填。')}>
      <input
        class="rc-input"
        type="password"
        placeholder={tr('留空即可')}
        value={$settings.googleApiKey}
        oninput={(e) => setSetting('googleApiKey', (e.currentTarget as HTMLInputElement).value)}
      />
    </SettingRow>

    <SettingRow label={tr('AI 模型的密钥')} help={tr('只存在这台设备上。')}>
      <input
        class="rc-input"
        type="password"
        placeholder="sk-…"
        value={$settings.llmApiKey}
        oninput={(e) => setSetting('llmApiKey', (e.currentTarget as HTMLInputElement).value)}
      />
    </SettingRow>

    <SettingRow label={tr('AI 模型接口格式')} help={tr('不确定就用 OpenAI 兼容。')}>
      <select
        class="rc-select"
        value={$settings.llmFormat}
        onchange={(e) => setSetting('llmFormat', (e.currentTarget as HTMLSelectElement).value as LlmFormat)}
      >
        <option value="openai">{tr('OpenAI 兼容')}</option>
        <option value="anthropic">Anthropic</option>
        <option value="gemini">Gemini</option>
      </select>
    </SettingRow>

    <SettingRow label={tr('AI 模型地址')}>
      <input
        class="rc-input"
        type="text"
        value={$settings.llmBaseUrl}
        oninput={(e) => setSetting('llmBaseUrl', (e.currentTarget as HTMLInputElement).value)}
      />
    </SettingRow>

    <SettingRow label={tr('AI 模型名称')}>
      <input
        class="rc-input"
        type="text"
        value={$settings.llmModel}
        oninput={(e) => setSetting('llmModel', (e.currentTarget as HTMLInputElement).value)}
      />
    </SettingRow>

    <SettingRow label={tr('结果读到哪一段')}>
      <select
        class="rc-select"
        value={$settings.targetLang}
        onchange={(e) => setSetting('targetLang', (e.currentTarget as HTMLSelectElement).value as Lang)}
      >
        {#each TARGET_ORDER as lang (lang)}
          <option value={lang}>{langLabel(lang, $uiLang)}</option>
        {/each}
      </select>
    </SettingRow>
  </section>

  <section>
    <h2>{tr('朗读')}</h2>

    <SettingRow
      label={tr('朗读引擎')}
      help={tr('默认用系统自带的朗读：不需要网络，句子之间几乎没有间隙，手机上还能在「设置 → 辅助功能 → 朗读内容」里装更好的音色。换成「Edge TTS 代理」则读的是微软的在线神经音色（你自己的代理，见下），各平台听起来一样好，代价是每句一次网络请求、断网时读不出来。')}
    >
      <select
        class="rc-select"
        value={$settings.ttsEngine}
        onchange={(e) => pickTtsEngine((e.currentTarget as HTMLSelectElement).value as TtsEngineId)}
      >
        <option value="system">{tr('系统朗读（默认）')}</option>
        <option value="edge">{tr('Edge TTS 代理')}</option>
      </select>
    </SettingRow>

    {#if $settings.ttsEngine === 'edge'}
      <SettingRow
        label={tr('TTS 代理地址')}
        help={tr('你自己的 Edge TTS 代理（这个项目配的是 cloudflare-edge-tts）。音色表就是从它读的：改完地址、离开这一格，译文栏的音色下拉会重新读取。想确认通不通，去下面跑一次自检，看「朗读试读」那一行。')}
      >
        <input
          class="rc-input"
          type="url"
          inputmode="url"
          spellcheck="false"
          autocomplete="off"
          value={$settings.ttsProxyUrl}
          onchange={(e) => setSetting('ttsProxyUrl', (e.currentTarget as HTMLInputElement).value.trim())}
        />
      </SettingRow>
    {/if}

    <SettingRow label={tr('朗读基础语速')}>
      <input
        type="range"
        min="0.6"
        max="1.6"
        step="0.05"
        value={$settings.baseRate}
        oninput={(e) => setSetting('baseRate', Number((e.currentTarget as HTMLInputElement).value))}
      />
      <span class="value">{$settings.baseRate.toFixed(2)}x</span>
    </SettingRow>

    <SettingRow label={tr('忙时自动加速')} help={tr('译文堆积时自动读快一点。')}>
      <input
        type="checkbox"
        checked={$settings.autoSpeedup}
        onchange={(e) => setSetting('autoSpeedup', (e.currentTarget as HTMLInputElement).checked)}
      />
    </SettingRow>

    <SettingRow label={tr('加速上限')} help={tr('太快会听不清。')}>
      <input
        type="range"
        min="1.1"
        max="2"
        step="0.05"
        value={$settings.maxRate}
        oninput={(e) => setSetting('maxRate', Number((e.currentTarget as HTMLInputElement).value))}
      />
      <span class="value">{$settings.maxRate.toFixed(2)}x</span>
    </SettingRow>
  </section>

  <section>
    <h2>{tr('录音与存储')}</h2>
    <SettingRow
      label={tr('保存整场录音')}
      help={tr('整段声音都存在手机上：可以回放、导出，也能重新识别某一句话。')}
    >
      <input
        type="checkbox"
        checked={$settings.keepAudio}
        onchange={(e) => setSetting('keepAudio', (e.currentTarget as HTMLInputElement).checked)}
      />
    </SettingRow>

    <SettingRow label={tr('录音最长保存')} help={tr('录到这里就停止保存录音，识别不受影响。')}>
      <input
        type="range"
        min="5"
        max="120"
        step="5"
        value={$settings.audioRetentionMin}
        oninput={(e) => setSetting('audioRetentionMin', Number((e.currentTarget as HTMLInputElement).value))}
      />
      <span class="value">{tr('{n} 分钟', { n: $settings.audioRetentionMin })}</span>
    </SettingRow>

    <div class="module-list">
      <div class="module">
        <span>{tr('当前录音')}</span>
        <span class="dim">{recordingSummary}</span>
        <button class="rc-btn ghost small" disabled={!hasRecording} onclick={() => void session.exportRecording()}>
          {tr('导出')}
        </button>
        <button class="rc-btn ghost small" disabled={!hasRecording} onclick={() => void session.clearRecording()}>
          {tr('删除')}
        </button>
      </div>
    </div>
  </section>

  <section>
    <h2>{tr('诊断')}</h2>

    <!--
      The version sits at the top of the diagnostic section rather than in a
      section of its own: it is here to be read out to someone else, and this is
      where a person who is about to report a problem is already looking. The
      help text carries the convention, because the number is a date and a date
      nobody can decode is just a number.
    -->
    <SettingRow
      label={tr('版本')}
      help={tr('按日期编号，每改一次手动加一位：20260926 就是 2026-09-26 这一版；同一天发第二次写成 20260926.2。反馈问题时把这个号一起说，就知道是哪一版了。')}
    >
      <span class="value version">{APP_VERSION}</span>
    </SettingRow>

    <SettingRow label={tr('调试模式')} help={tr('显示识别细节，用来排查问题。')}>
      <input
        type="checkbox"
        checked={$settings.debugMode}
        onchange={(e) => setSetting('debugMode', (e.currentTarget as HTMLInputElement).checked)}
      />
    </SettingRow>

    <SettingRow label={tr('记录详细程度')} help={tr('调试会记录每次识别和翻译的细节。')}>
      <select
        class="rc-select"
        value={$settings.logLevel}
        onchange={(e) => setSetting('logLevel', (e.currentTarget as HTMLSelectElement).value as LogLevelSetting)}
      >
        <option value="debug">{tr('调试')}</option>
        <option value="info">{tr('普通')}</option>
        <option value="warn">{tr('只看警告')}</option>
        <option value="error">{tr('只看错误')}</option>
      </select>
    </SettingRow>

    <SettingRow label={tr('日志保留条数')}>
      <input
        type="range"
        min="100"
        max="5000"
        step="100"
        value={$settings.logRing}
        oninput={(e) => setSetting('logRing', Number((e.currentTarget as HTMLInputElement).value))}
      />
      <span class="value">{$settings.logRing}</span>
    </SettingRow>

    <div class="buttons">
      <button class="rc-btn" disabled={$selfCheckRunning} onclick={() => void runDiagnostics(false)}>
        {$selfCheckRunning ? tr('自检中…') : tr('运行自检')}
      </button>
      <button class="rc-btn ghost" onclick={() => resetSettings()}>{tr('恢复默认设置')}</button>
    </div>
  </section>

  <p class="footnote">
    {tr('当前语向：{from} → {to}。语音在手机里识别，只有译文文字会上网。', {
      from: langLabel($settings.sourceLang),
      to: langLabel($settings.targetLang),
    })}
  </p>
</div>

<style>
  .settings {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 14px 16px 40px;
    background: var(--rc-bg);
  }

  h1 {
    font-size: 20px;
    margin: 4px 0 12px;
  }

  h2 {
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--rc-ink-soft);
    margin: 18px 0 4px;
  }

  section {
    background: var(--rc-surface);
    border: 2px solid var(--rc-ink);
    border-radius: var(--rc-radius);
    padding: 4px 14px 12px;
    margin-bottom: 14px;
  }

  section h2 {
    margin-top: 12px;
  }

  .value {
    font-size: 12px;
    color: var(--rc-ink-soft);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  /* A number to be read aloud or typed into a report: tabular digits, and wide
     enough tracking that a digit is not mistaken for its neighbour. */
  .version {
    font-size: 13px;
    letter-spacing: 0.06em;
  }

  /* Icon picker: each swatch is the icon's own artwork on the background it is
     rendered on, so what is previewed is what the installed icon will be — the
     swatch is not a second drawing of it. */
  .icons {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
  }

  .icon {
    display: block;
    padding: 2px;
    border: 2px solid transparent;
    border-radius: 10px;
    background: none;
    cursor: pointer;
    line-height: 0;
  }

  .icon img {
    display: block;
    width: 30px;
    height: 30px;
    border-radius: 7px;
    /* The artwork is wider than it is tall: contain keeps its proportions instead
       of stretching it to the square, and the background shows where it is empty. */
    object-fit: contain;
  }

  .icon.on {
    border-color: var(--rc-ink);
    background: var(--rc-accent-soft);
  }

  input[type='range'] {
    width: 130px;
  }

  .module-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-top: 8px;
  }

  .module {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
  }

  .dim {
    color: var(--rc-ink-soft);
  }

  .note {
    margin: 4px 0 0;
    font-size: 12px;
  }

  /* The same alarm colour the log drawer uses for errors (see `app.css`). */
  .warn {
    margin: 6px 0 0;
    font-size: 12px;
    color: var(--rc-danger);
  }

  .badge {
    font-size: 11px;
    border: 1px solid var(--rc-line-strong);
    border-radius: var(--rc-radius-pill);
    padding: 0 8px;
    color: var(--rc-ink-soft);
  }

  .badge.ok {
    border-color: var(--rc-ok);
    color: var(--rc-ok);
    background: var(--rc-ok-soft);
  }

  .buttons {
    display: flex;
    gap: 8px;
    margin-top: 14px;
  }

  .footnote {
    font-size: 12px;
    color: var(--rc-ink-soft);
    text-align: center;
  }
</style>
