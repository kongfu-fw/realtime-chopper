<script lang="ts">
  import { session } from '../lib/app/state'
  import { settings, setSetting, ttsVoiceFor } from '../lib/store/settings'
  import { createTtsEngine, ttsConfigFrom, ttsEngineLabel, type TtsEngine, type VoiceOption } from '../lib/tts/engine'
  import { translator, uiLang } from '../lib/i18n/index.ts'
  import { reservedLines, tierOf } from '../lib/ui/tiers.ts'
  import type { Line } from '../lib/types'

  const tr = $derived(translator($uiLang))

  interface Props {
    lines: Line[]
  }

  let { lines }: Props = $props()

  const { provider, providerLabel, queues } = session
  /** The reader is far enough behind that dropping the backlog is worth offering. */
  const lagging = $derived($queues.lagSeconds > 8)
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

  /*
   * The ladder itself lives in `lib/ui/tiers.ts`, with its tests: three sizes by
   * recency, and the reserved room that keeps a row from resizing as it ages.
   */
</script>

<section class="panel" aria-label={tr('翻译结果')}>
  <div class="panel-head">
    <span class="panel-title">{tr('译文')}</span>

    <!--
     * The only path in the app that discards queued speech, and it only happens
     * when the user asks for it.
     *
     * It lives here rather than in the status bar because the status bar is now two
     * buttons and nothing else: a sentence that appears and disappears would change
     * the width of the bar, and the two ends of that bar are what a thumb is aimed
     * at. It is also the right panel — what it drops is translations waiting to be
     * read, and this is the panel that shows them being read.
     *
     * Placed before the voice picker, and `flex: none`, so it takes its room from
     * the empty space between the title and the right-hand controls rather than from
     * the voice picker: a control that appears only when the reader is behind must
     * not move the control that is always there.
     -->
    {#if lagging}
      <button class="rc-btn small accent lag" onclick={() => session.skipToLatest()}>
        {tr('跳到最新（落后 {sec} 秒）', { sec: $queues.lagSeconds.toFixed(0) })}
      </button>
    {/if}

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

    <!--
     * The read-aloud switch has moved to the status bar, beside the record
     * button: one of the two is what this app is for, and having one at the
     * bottom of the screen and the other in a panel header meant the pair the
     * user reaches for was never in the same place twice.
     -->

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
        {@const tier = tierOf(index, lines.length)}
        <div
          class="line selectable"
          class:failed={line.mtState === 'failed'}
          role="button"
          tabindex="0"
          title={line.ttsState === 'speaking' ? tr('正在朗读…') : tr('从这里开始读')}
          onclick={() => session.speakFrom(line.id)}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') session.speakFrom(line.id)
          }}
        >
          <!--
            * "This one is being read" as three moving bars in the corner, rather
            * than the words `正在朗读…` in front of the sentence.
            *
            * The words cost a whole text line above every translation being read —
            * the panel grew a row, the sentence underneath slid down, and back
            * again a second later when the reader moved on. A mark drawn in the
            * gutter the rows keep free (see `.line` in app.css) takes no space
            * from the text at all, and bars that move say the same thing without
            * being read.
            -->
          {#if line.ttsState === 'speaking'}
            <span class="playing" aria-hidden="true">
              <span class="playing-bars"><i></i><i></i><i></i></span>
            </span>
          {/if}
          {#if $settings.debugMode && line.mtProvider}
            <div class="line-meta">
              <span>{line.mtProvider}{line.mtState === 'cached' ? tr(' · 缓存') : ''}</span>
            </div>
          {/if}
          <!--
            * The text box is rendered from the moment the row exists, empty, at
            * the height its size reserves — not only once there is something to
            * read.
            *
            * A sentence is either there to read or it is not, and this used to
            * render nothing until it arrived, which is what made the list jump:
            * the row appeared as 16 px of padding, then grew to two lines when the
            * translation landed, shoving everything above it up the screen while
            * the reader was looking at it. The reversed placeholder (`翻译中…` on
            * every row) was removed for a different reason and stays removed: text
            * that appears in the sentence's place reads as the sentence arriving
            * twice. What is here now is *space*, and space does not promise
            * anything.
            -->
          {#if line.mtState === 'failed' && !line.translation}
            <div class="line-text size-{tier}" style={`--reserve:${reservedLines(tier)}`}>
              {tr('翻译失败')}
            </div>
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
          {:else}
            <div class="line-text size-{tier}" style={`--reserve:${reservedLines(tier)}`}>
              {#if line.translation}
                <!-- Only the text animates in: the box was already here, and
                     animating it is what made the row look like it moved. -->
                <span class="line-inner">{line.translation}</span>
              {/if}
            </div>
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

  /* A sentence, so it must not be squeezed by the picker beside it. */
  .lag {
    flex: 0 0 auto;
    white-space: nowrap;
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

  /*
   * Phone widths: this header holds a title, the voice picker and the provider
   * mark in roughly 175 px. The picker's 92 px floor made it the one item that
   * refused to give, which pushed the provider mark past the panel edge — 3 px of
   * horizontal page scroll on a 393 px iPhone.
   */
  @media (max-width: 560px) {
    .voice {
      min-width: 0;
    }
  }
</style>
