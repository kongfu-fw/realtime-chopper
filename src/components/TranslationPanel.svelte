<script lang="ts">
  import { session } from '../lib/app/state'
  import { settings, setSetting } from '../lib/store/settings'
  import { SpeechEngine, speechSupported, type VoiceOption } from '../lib/tts/speech'
  import type { Line } from '../lib/types'

  interface Props {
    lines: Line[]
  }

  let { lines }: Props = $props()

  const { autoRead, providerLabel } = session
  const engine = new SpeechEngine()
  let voices = $state<VoiceOption[]>([])
  let loadingVoices = $state(false)
  let bodyEl: HTMLElement | undefined = $state()
  let pinned = $state(true)

  // Voice lists are per-platform (iOS exposes only pre-installed voices) and
  // arrive asynchronously, so they are re-read whenever the target changes.
  $effect(() => {
    const lang = $settings.targetLang
    if (!speechSupported()) return
    let cancelled = false
    loadingVoices = true
    void engine.voicesFor(lang, 2500).then((list) => {
      if (!cancelled) {
        voices = list
        loadingVoices = false
      }
    })
    return () => {
      cancelled = true
    }
  })

  $effect(() => {
    if (!pinned || !bodyEl) return
    lines.length
    bodyEl.scrollTop = bodyEl.scrollHeight
  })

  function onScroll() {
    if (!bodyEl) return
    pinned = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 40
  }

  const GOOGLE = /谷歌/

  function label(line: Line): string {
    if (line.translation) return line.translation
    if (line.mtState === 'failed') return '翻译失败'
    return '翻译中…'
  }
</script>

<section class="panel" aria-label="翻译结果">
  <div class="panel-head">
    <span class="panel-title">译文</span>

    <!-- Requirement 19: the voice picker lives in the translation header. -->
    <select
      class="rc-select voice"
      aria-label="朗读音色"
      value={$settings.voiceURI}
      disabled={loadingVoices || voices.length === 0}
      onchange={(e) => setSetting('voiceURI', (e.currentTarget as HTMLSelectElement).value)}
    >
      {#if voices.length === 0}
        <option value="">{loadingVoices ? '正在读取音色…' : '没有可用音色'}</option>
      {:else}
        <option value="">默认音色</option>
        {#each voices as voice (voice.voiceURI)}
          <option value={voice.voiceURI}>{voice.name}{voice.localService ? '' : '（网络）'}</option>
        {/each}
      {/if}
    </select>

    <span class="spacer"></span>

    <!-- Icon only: the speaker with a slash is understood at a glance, and the
         label next to it only competed with the voice picker. -->
    <button
      class="rc-btn ghost small speaking-toggle"
      title={$autoRead ? '暂停自动朗读' : '恢复自动朗读'}
      aria-label={$autoRead ? '暂停自动朗读' : '恢复自动朗读'}
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
        class:fallback={!GOOGLE.test($providerLabel)}
        title="翻译来源：{$providerLabel}"
      >
        {#if GOOGLE.test($providerLabel)}
          <span class="brand-zh">文</span><span class="brand-en">A</span>
        {:else}
          {$providerLabel}
        {/if}
      </span>
    {/if}
  </div>

  <div class="panel-body" bind:this={bodyEl} onscroll={onScroll}>
    {#if lines.length === 0}
      <p class="empty">译文会出现在这里。</p>
    {:else}
      {#each lines as line (line.id)}
        <div
          class="line selectable"
          class:failed={line.mtState === 'failed'}
          role="button"
          tabindex="0"
          title="从这里开始读"
          onclick={() => session.speakFrom(line.id)}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') session.speakFrom(line.id)
          }}
        >
          {#if $settings.debugMode || line.ttsState === 'speaking'}
            <div class="line-meta">
              {#if $settings.debugMode && line.mtProvider}
                <span>{line.mtProvider}{line.mtState === 'cached' ? ' · 缓存' : ''}</span>
              {/if}
              {#if line.ttsState === 'speaking'}
                <span class="speaking">正在朗读…</span>
              {/if}
            </div>
          {/if}
          <div class="line-text">{label(line)}</div>
          {#if line.mtState === 'failed'}
            <button
              class="rc-btn small"
              onclick={(e) => {
                e.stopPropagation()
                session.retryLine(line.id)
              }}
            >
              重试
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
