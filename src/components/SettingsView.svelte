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
    LANG_LABEL,
  } from '../lib/store/settings'
  import {
    ASR_MODULES,
    MODULE_CACHE_KEYS,
    MODULE_LANGS,
    MODULE_SHORT,
    type ModuleLang,
  } from '../lib/asr/models'
  import { APP_ICONS, iconFor, iconPreviewUrl, type AppIconId } from '../lib/brand/logo'
  import { info } from '../lib/log/store'
  import type { Accelerator, LlmFormat, LogLevelSetting, MtProviderId, Precision } from '../lib/store/settings'
  import type { Lang } from '../lib/types'

  function pickIcon(id: AppIconId) {
    if (id === $settings.appIcon) return
    setSetting('appIcon', id)
    // Applying it happens in App.svelte, where the setting is watched.
    info('ui', `应用图标换成「${iconFor(id).label}」`, { note: '已经装到桌面的图标要删掉重新添加才会更新' })
  }

  async function clearModule(moduleLang: ModuleLang) {
    const owned = MODULE_CACHE_KEYS[moduleLang]
    if (typeof caches !== 'undefined') {
      // The module's own bucket(s), plus anything an older build left under this
      // module's prefix. See `MODULE_CACHE_KEYS`: English does not live under
      // `rc-model-en-…` at all, so the prefix guess deleted nothing and the app
      // still reported the 62 MB as cleared.
      for (const key of await caches.keys()) {
        if (owned.includes(key) || key.startsWith(`rc-model-${moduleLang}-`)) await caches.delete(key)
      }
    }
    forgetModel(moduleLang)
    await session.releaseModel()
    info('storage', `已清除 ${MODULE_SHORT[moduleLang]} 识别模块，下次使用需要重新下载`)
  }

  // Version-aware: a module whose bytes were replaced by a newer build is not
  // installed, so the download button comes back instead of lying to the user.
  const installed = $derived(
    MODULE_LANGS.filter((key) => isModuleCurrent(key, $settings.installedModels[key])),
  )
  const totalInstalledBytes = $derived(
    installed.reduce((sum, key) => sum + ($settings.installedModels[key]?.bytes ?? ASR_MODULES[key].approxBytes), 0),
  )

  /** Continuous recording state, mirrored from the pipeline worker. */
  const { recording } = session
  const hasRecording = $derived(($recording?.seconds ?? 0) >= 1)
  const recordingSummary = $derived.by(() => {
    if (!$recording || !hasRecording) return '没有'
    const total = Math.round($recording.seconds)
    const minutes = Math.floor(total / 60)
    const seconds = String(total % 60).padStart(2, '0')
    return `${minutes}:${seconds} · ${formatBytes($recording.bytes)}`
  })
</script>

<div class="settings">
  <h1>设置</h1>

  <section>
    <h2>外观</h2>
    <SettingRow
      label="应用图标"
      help="装到手机或桌面上时用的图标。已经装过的，要删掉重新「添加到主屏幕」才会换成新的。"
    >
      <div class="icons">
        {#each APP_ICONS as icon (icon.id)}
          <button
            class="icon"
            class:on={$settings.appIcon === icon.id}
            type="button"
            title={icon.label}
            aria-label={`图标：${icon.label}`}
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
    <h2>识别</h2>
    <SettingRow label="说话停顿多久算一句" help="停顿超过这么久，就算一句说完了。">
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

    <SettingRow label="一句话最长不超过" help="一直不停顿，也会在这里切一句。">
      <input
        type="range"
        min="3000"
        max="20000"
        step="1000"
        value={$settings.maxSegMs}
        oninput={(e) => setSetting('maxSegMs', Number((e.currentTarget as HTMLInputElement).value))}
      />
      <span class="value">{($settings.maxSegMs / 1000).toFixed(0)} 秒</span>
    </SettingRow>

    <SettingRow label="识别精度" help="省电优先更流畅，也更容易听错。">
      <select
        class="rc-select"
        value={$settings.precision}
        onchange={(e) => setSetting('precision', (e.currentTarget as HTMLSelectElement).value as Precision)}
      >
        <option value="high">高精度</option>
        <option value="eco">省电优先</option>
      </select>
    </SettingRow>

    <SettingRow
      label="用显卡加速"
      help="有显卡会更快。中文识别一直用 CPU；iPhone / iPad 上别选「显卡优先」——实测一启用就把整个页面带崩，所以那边的自动档走 CPU。"
    >
      <select
        class="rc-select"
        value={$settings.accelerator}
        onchange={(e) => setSetting('accelerator', (e.currentTarget as HTMLSelectElement).value as Accelerator)}
      >
        <option value="auto">自动</option>
        <option value="webgpu">显卡优先</option>
        <option value="wasm">CPU 兜底</option>
      </select>
    </SettingRow>

    <SettingRow label="已下载的识别模块">
      <span class="value">
        {installed.length === 0 ? '还没有' : `${installed.length} 个 · ${formatBytes(totalInstalledBytes)}`}
      </span>
    </SettingRow>

    <div class="module-list">
      {#each MODULE_LANGS as key (key)}
        <div class="module">
          <span>{MODULE_SHORT[key]}</span>
          <span class="dim">{formatBytes(ASR_MODULES[key].approxBytes)}</span>
          {#if isModuleCurrent(key, $settings.installedModels[key])}
            <span class="badge ok">已安装</span>
            <button class="rc-btn ghost small" onclick={() => void clearModule(key)}>清除</button>
          {:else}
            <span class="badge">未安装</span>
          {/if}
        </div>
      {/each}
      <p class="dim note">中文和韩语共用同一个模块。</p>
    </div>
  </section>

  <section>
    <h2>翻译</h2>
    <SettingRow label="翻译用哪家" help="默认谷歌；谷歌用不了会自动换微软。">
      <select
        class="rc-select"
        value={$settings.mtProvider}
        onchange={(e) => {
          setSetting('mtProvider', (e.currentTarget as HTMLSelectElement).value as MtProviderId)
          session.applySettings()
        }}
      >
        <option value="google">谷歌翻译</option>
        <option value="microsoft">微软翻译</option>
        <option value="llm">AI 模型</option>
      </select>
    </SettingRow>

    <SettingRow label="翻译攒几句一起发" help="攒多几句一起发：省流量，但更慢。">
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

    <SettingRow label="记住翻过的句子" help="同一句话不重复翻译。">
      <input
        type="checkbox"
        checked={$settings.mtCache}
        onchange={(e) => setSetting('mtCache', (e.currentTarget as HTMLInputElement).checked)}
      />
    </SettingRow>

    <SettingRow label="谷歌 API 密钥（可选）" help="不用填。">
      <input
        class="rc-input"
        type="password"
        placeholder="留空即可"
        value={$settings.googleApiKey}
        oninput={(e) => setSetting('googleApiKey', (e.currentTarget as HTMLInputElement).value)}
      />
    </SettingRow>

    <SettingRow label="AI 模型的密钥" help="只存在这台设备上。">
      <input
        class="rc-input"
        type="password"
        placeholder="sk-…"
        value={$settings.llmApiKey}
        oninput={(e) => setSetting('llmApiKey', (e.currentTarget as HTMLInputElement).value)}
      />
    </SettingRow>

    <SettingRow label="AI 模型接口格式" help="不确定就用 OpenAI 兼容。">
      <select
        class="rc-select"
        value={$settings.llmFormat}
        onchange={(e) => setSetting('llmFormat', (e.currentTarget as HTMLSelectElement).value as LlmFormat)}
      >
        <option value="openai">OpenAI 兼容</option>
        <option value="anthropic">Anthropic</option>
        <option value="gemini">Gemini</option>
      </select>
    </SettingRow>

    <SettingRow label="AI 模型地址">
      <input
        class="rc-input"
        type="text"
        value={$settings.llmBaseUrl}
        oninput={(e) => setSetting('llmBaseUrl', (e.currentTarget as HTMLInputElement).value)}
      />
    </SettingRow>

    <SettingRow label="AI 模型名称">
      <input
        class="rc-input"
        type="text"
        value={$settings.llmModel}
        oninput={(e) => setSetting('llmModel', (e.currentTarget as HTMLInputElement).value)}
      />
    </SettingRow>

    <SettingRow label="结果读到哪一段">
      <select
        class="rc-select"
        value={$settings.targetLang}
        onchange={(e) => setSetting('targetLang', (e.currentTarget as HTMLSelectElement).value as Lang)}
      >
        {#each TARGET_ORDER as lang (lang)}
          <option value={lang}>{LANG_LABEL[lang]}</option>
        {/each}
      </select>
    </SettingRow>
  </section>

  <section>
    <h2>朗读</h2>
    <SettingRow label="朗读基础语速">
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

    <SettingRow label="忙时自动加速" help="译文堆积时自动读快一点。">
      <input
        type="checkbox"
        checked={$settings.autoSpeedup}
        onchange={(e) => setSetting('autoSpeedup', (e.currentTarget as HTMLInputElement).checked)}
      />
    </SettingRow>

    <SettingRow label="加速上限" help="太快会听不清。">
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
    <h2>录音与存储</h2>
    <SettingRow
      label="保存整场录音"
      help="整段声音都存在手机上：可以回放、导出，也能重新识别某一句话。"
    >
      <input
        type="checkbox"
        checked={$settings.keepAudio}
        onchange={(e) => setSetting('keepAudio', (e.currentTarget as HTMLInputElement).checked)}
      />
    </SettingRow>

    <SettingRow label="录音最长保存" help="录到这里就停止保存录音，识别不受影响。">
      <input
        type="range"
        min="5"
        max="120"
        step="5"
        value={$settings.audioRetentionMin}
        oninput={(e) => setSetting('audioRetentionMin', Number((e.currentTarget as HTMLInputElement).value))}
      />
      <span class="value">{$settings.audioRetentionMin} 分钟</span>
    </SettingRow>

    <div class="module-list">
      <div class="module">
        <span>当前录音</span>
        <span class="dim">{recordingSummary}</span>
        <button class="rc-btn ghost small" disabled={!hasRecording} onclick={() => void session.exportRecording()}>
          导出
        </button>
        <button class="rc-btn ghost small" disabled={!hasRecording} onclick={() => void session.clearRecording()}>
          删除
        </button>
      </div>
    </div>
  </section>

  <section>
    <h2>诊断</h2>
    <SettingRow label="调试模式" help="显示识别细节，用来排查问题。">
      <input
        type="checkbox"
        checked={$settings.debugMode}
        onchange={(e) => setSetting('debugMode', (e.currentTarget as HTMLInputElement).checked)}
      />
    </SettingRow>

    <SettingRow label="记录详细程度" help="调试会记录每次识别和翻译的细节。">
      <select
        class="rc-select"
        value={$settings.logLevel}
        onchange={(e) => setSetting('logLevel', (e.currentTarget as HTMLSelectElement).value as LogLevelSetting)}
      >
        <option value="debug">调试</option>
        <option value="info">普通</option>
        <option value="warn">只看警告</option>
        <option value="error">只看错误</option>
      </select>
    </SettingRow>

    <SettingRow label="日志保留条数">
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
        {$selfCheckRunning ? '自检中…' : '运行自检'}
      </button>
      <button class="rc-btn ghost" onclick={() => resetSettings()}>恢复默认设置</button>
    </div>
  </section>

  <p class="footnote">
    当前语向：{$settings.sourceLang} → {$settings.targetLang}。语音在手机里识别，只有译文文字会上网。
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
