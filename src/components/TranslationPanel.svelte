<script lang="ts">
  import { session } from '../lib/app/state'
  import { settings, setSetting, ttsVoiceFor } from '../lib/store/settings'
  import { createTtsEngine, ttsConfigFrom, ttsEngineLabel, type TtsEngine, type VoiceOption } from '../lib/tts/engine'
  import { translator, uiLang } from '../lib/i18n/index.ts'
  import type { Line } from '../lib/types'

  const tr = $derived(translator($uiLang))

  interface Props {
    lines: Line[]
  }

  let { lines }: Props = $props()

  const { autoRead, provider, providerLabel } = session
  let voices = $state<VoiceOption[]>([])
  let loadingVoices = $state(false)
  /** Why the list is empty, when it is empty for a reason worth naming. */
  let voiceError = $state('')
  let bodyEl: HTMLElement | undefined = $state()
  let pinned = $state(true)

  const ttsEngine = $derived<TtsEngine>(createTtsEngine(ttsConfigFrom($settings)))
  const chosenVoice = $derived(ttsVoiceFor($settings))

  /**
   * Voice lists are per-*engine* as much as per-platform: the system engine lists
   * what the OS has (iOS exposes only pre-installed voices, and nothing at all
   * until it feels like it), while the Edge engine lists what the proxy reports.
   * Any of those inputs changing means re-reading, so all of them are watched.
   */
  $effect(() => {
    const lang = $settings.targetLang
    // Reading the derived registers both the choice and the proxy address as
    // dependencies of this effect, which is what makes re-listing automatic.
    const engine = ttsEngine
    voiceError = ''
    voices = []
    if (!engine.available) {
      loadingVoices = false
      return
    }
    let cancelled = false
    loadingVoices = true
    void engine
      .voicesFor(lang, 2500)
      .then((list) => {
        if (cancelled) return
        voices = list
        loadingVoices = false
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // A failing proxy used to surface here as "没有可用音色", which reads as
        // "your phone has no voices" — the opposite of what just happened.
        voiceError = err instanceof Error ? err.message : String(err)
        loadingVoices = false
      })
    return () => {
      cancelled = true
    }
  })

  $effect(() => {
    if (!pinned || !bodyEl) return
    // The newest line's translation is a dependency, not just the count: a line
    // renders nothing until its text arrives and then grows, and a panel that only
    // followed the count would leave the sentence that just landed below the fold.
    const newest = lines[lines.length - 1] as Line | undefined
    void lines.length
    void newest?.translation
    bodyEl.scrollTop = bodyEl.scrollHeight
  })

  function onScroll() {
    if (!bodyEl) return
    pinned = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 40
  }

  /**
   * Which of the four sizes a line wears: 0 for the newest, 3 for everything
   * older.
   *
   * Recency, not age and not length: what a reader wants is the sentence that was
   * *just* translated, and the ladder has to hold still while a slow translation
   * lands (`lines.length - 1 - index` is stable for every line whose translation
   * has already arrived, because a new line only ever appears at the end).
   */
  function tier(index: number): number {
    return Math.min(3, lines.length - 1 - index)
  }
</script>

<section class="panel" aria-label={tr('翻译结果')}>
  <div class="panel-head">
    <span class="panel-title">{tr('译文')}</span>

    <!-- Requirement 19: the voice picker lives in the translation header. -->
    <select
      class="rc-select voice"
      aria-label={tr('朗读音色')}
      title={`${tr('朗读音色')} · ${ttsEngineLabel($settings.ttsEngine, $uiLang)}${voiceError ? ` · ${voiceError}` : ''}`}
      value={chosenVoice}
      disabled={loadingVoices || voices.length === 0}
      onchange={(e) => {
        const value = (e.currentTarget as HTMLSelectElement).value
        setSetting($settings.ttsEngine === 'edge' ? 'edgeVoice' : 'voiceURI', value)
      }}
    >
      {#if voices.length === 0}
        <option value="">
          {loadingVoices
            ? tr('正在读取音色…')
            : voiceError
              ? tr('音色读取失败（见日志）')
              : tr('没有可用音色')}
        </option>
      {:else}
        <option value="">{tr('默认音色')}</option>
        {#each voices as voice (voice.voiceURI)}
          <option value={voice.voiceURI}>{voice.name}{voice.localService ? '' : tr('（网络）')}</option>
        {/each}
      {/if}
    </select>

    <span class="spacer"></span>

    <!-- Icon only: the speaker with a slash is understood at a glance, and the
         label next to it only competed with the voice picker. -->
    <button
      class="rc-btn ghost small speaking-toggle"
      title={$autoRead ? tr('暂停自动朗读') : tr('恢复自动朗读')}
      aria-label={$autoRead ? tr('暂停自动朗读') : tr('恢复自动朗读')}
      aria-pressed={$autoRead}
      onclick={() => autoRead.set(!$autoRead)}
    >
      {$autoRead ? '🔊' : '🔇'}
    </button>

    <!--
     * Which engine is translating is worth one glance, not a sentence. The
     * Google mark is drawn from two glyphs rather than shipping a logo file;
     * anything else (Microsoft, the local AI model) is named in plain text so
     * a silent fallback can never look like Google.
     -->
    {#if $providerLabel}
      <span
        class="provider"
        class:fallback={$provider !== 'google'}
        title={tr('翻译来源：{source}', { source: $providerLabel })}
      >
        {#if $provider === 'google'}
          <span class="brand-zh">文</span><span class="brand-en">A</span>
        {:else}
          {$providerLabel}
        {/if}
      </span>
    {/if}
  </div>

  <div class="panel-body" bind:this={bodyEl} onscroll={onScroll}>
    {#if lines.length === 0}
      <p class="empty">{tr('译文会出现在这里。')}</p>
    {:else}
      {#each lines as line, index (line.id)}
        <div
          class="line selectable"
          class:failed={line.mtState === 'failed'}
          role="button"
          tabindex="0"
          title={tr('从这里开始读')}
          onclick={() => session.speakFrom(line.id)}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') session.speakFrom(line.id)
          }}
        >
          {#if $settings.debugMode || line.ttsState === 'speaking'}
            <div class="line-meta">
              {#if $settings.debugMode && line.mtProvider}
                <span>{line.mtProvider}{line.mtState === 'cached' ? tr(' · 缓存') : ''}</span>
              {/if}
              {#if line.ttsState === 'speaking'}
                <span class="speaking">{tr('正在朗读…')}</span>
              {/if}
            </div>
          {/if}
          <!--
            * Nothing at all while the translation is still coming: a sentence is
            * either there to read or it is not, and a placeholder in its place made
            * every line flash `翻译中…` — which read as the text arriving twice, and
            * as a promise the panel could not always keep. The text fades in when
            * it lands (`.line-text` in app.css).
            -->
          {#if line.translation}
            <div class="line-text size-{tier(index)}">{line.translation}</div>
          {:else if line.mtState === 'failed'}
            <div class="line-text size-{tier(index)}">{tr('翻译失败')}</div>
            <button
              class="rc-btn small"
              onclick={(e) => {
                e.stopPropagation()
                session.retryLine(line.id)
              }}
            >
              {tr('重试')}
            </button>
            {#if line.error}
              <div class="debug-box">{line.error}</div>
            {/if}
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</section>

<style>
  /*
   * A native <select> sizes itself to its widest option, so a list containing
   * "Microsoft Huihui - Chinese (Simplified, PRC)" would stretch the control
   * across the whole header. Fixed bounds keep the two panel headers balanced.
   */
  .voice {
    width: 40%;
    min-width: 92px;
    max-width: 180px;
    font-size: 13px;
  }

  .spacer {
    flex: 1 1 auto;
  }

  /* Square-ish, and no text: emoji carry their own width. */
  .speaking-toggle {
    padding: 0 8px;
    min-width: 26px;
    justify-content: center;
    font-size: 14px;
  }

  /* Brand colours: this is the Google Translate mark, not a UI accent. */
  .provider {
    display: inline-flex;
    align-items: baseline;
    font-size: 14px;
    font-weight: 700;
    line-height: 1;
    font-family: var(--rc-mono);
  }

  .provider .brand-zh {
    color: #4285f4;
  }

  .provider .brand-en {
    color: #34a853;
    margin-left: 1px;
  }

  .provider.fallback {
    font-family: inherit;
    font-size: 11px;
    font-weight: 500;
    color: var(--rc-ink-soft);
  }

  .speaking {
    color: var(--rc-ok);
    font-weight: 600;
  }

  /*
   * Phone widths: this header holds a title, the voice picker, the read-aloud
   * toggle and the provider mark in roughly 175 px. The picker's 92 px floor made
   * it the one item that refused to give, which pushed the provider mark past the
   * panel edge — 3 px of horizontal page scroll on a 393 px iPhone.
   */
  @media (max-width: 560px) {
    .voice {
      min-width: 0;
    }
  }
</style>
