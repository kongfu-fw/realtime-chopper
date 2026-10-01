<script lang="ts">
  import { session, showToast } from '../lib/app/state'
  import { settings } from '../lib/store/settings'
  import { info } from '../lib/log/store'
  import { t, translator, uiLang } from '../lib/i18n/index.ts'
  import { exportFileName, saveText, transcriptRows, transcriptText } from '../lib/ui/export.ts'
  import { reservedLines, tierOf } from '../lib/ui/tiers.ts'
  import Glyph from './Glyph.svelte'
  import LangPicker from './LangPicker.svelte'
  import type { Line } from '../lib/types'

  const tr = $derived(translator($uiLang))

  interface Props {
    lines: Line[]
  }

  let { lines }: Props = $props()

  const { provider, providerLabel, queues } = session
  /** The reader is far enough behind that dropping the backlog is worth offering. */
  const lagging = $derived($queues.lagSeconds > 8)
  let bodyEl: HTMLElement | undefined = $state()
  let pinned = $state(true)

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
   * Writes the translations to a file, in the order they were read out.
   *
   * The other half of the pair in the original-text panel: each button exports
   * its own column, so the two artifacts a lesson leaves behind — what was said
   * and what it was translated into — are taken separately. Rows whose
   * translation has not arrived (or failed) are left out rather than saved as
   * blanks.
   */
  function exportTranslation() {
    const rows = transcriptRows(lines, 'translation')
    if (rows.length === 0) {
      showToast(t('还没有内容可以导出'))
      return
    }
    saveText(exportFileName('translation', new Date()), transcriptText(lines, 'translation'))
    info('ui', t('已导出译文（{n} 句）', { n: rows.length }))
  }

  /*
   * The ladder itself lives in `lib/ui/tiers.ts`, with its tests: three sizes by
   * recency, and the reserved room that keeps a row from resizing as it ages.
   */
</script>

<section class="panel" aria-label={tr('翻译结果')}>
  <div class="panel-head">
    <!-- No column title: the picker names this half of the screen (译 中文), and
         a heading above it was one more line the eye had to pass on the way to the
         sentence. The section keeps its accessible name (翻译结果). -->
    <LangPicker which="target" />

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
     * Placed before the provider mark, and `flex: none`, so it takes its room from
     * the empty space between the controls and the right-hand corner rather than
     * from them: a control that appears only when the reader is behind must not
     * move the controls that are always there.
     *
     * The voice picker used to live here as well. It moved into the read-aloud
     * settings dialog beside the read-aloud switch (`StatusBar`), because the
     * *voice* is one setting among three that belong together — which engine
     * speaks, which translation it reads, and which voice it uses — and a picker
     * that changes the engine's namespace on its own, in a header, was the one
     * place those three could be set apart from each other.
     -->
    {#if lagging}
      <button class="rc-btn small accent lag" onclick={() => session.skipToLatest()}>
        {tr('跳到最新（落后 {sec} 秒）', { sec: $queues.lagSeconds.toFixed(0) })}
      </button>
    {/if}

    <span class="spacer"></span>

    <!--
     * The read-aloud switch has moved to the status bar, beside the record
     * button: one of the two is what this app is for, and having one at the
     * bottom of the screen and the other in a panel header meant the pair the
     * user reaches for was never in the same place twice.
     -->

    <!--
     * Which engine is translating — but only when it is *not* the one that
     * ships. Google is the default, so a mark for it was a badge that never
     * carried news; what is worth a glance is a fallback, which is named in plain
     * text so a silent switch can never look like the usual path.
     -->
    {#if $provider !== 'google' && $providerLabel}
      <span class="provider" title={tr('翻译来源：{source}', { source: $providerLabel })}>
        {$providerLabel}
      </span>
    {/if}

    <button
      class="rc-btn ghost small export"
      title={tr('导出译文')}
      aria-label={tr('导出译文')}
      onclick={exportTranslation}
    >
      <Glyph name="download" size={15} />
      <span class="export-text">{tr('导出')}</span>
    </button>
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
  .spacer {
    flex: 1 1 auto;
  }

  .export {
    flex: 0 0 auto;
    gap: 5px;
  }

  @media (max-width: 560px) {
    .export-text {
      display: none;
    }
  }

  /* A sentence, so it must not be squeezed by the picker beside it. */
  .lag {
    flex: 0 0 auto;
    white-space: nowrap;
  }

  /* The name of the provider the app fell back to, in the words the translator
     itself uses. Plain text rather than a mark: see the note in the markup. */
  .provider {
    font-size: 11px;
    font-weight: 500;
    color: var(--rc-ink-soft);
  }

  /*
   * Phone widths: this header holds a language picker, the name of a fallback
   * provider and an export button in roughly 175 px once the filler is gone. Each
   * of them is allowed to shrink (`min-width: 0`), and the filler gives way first
   * — 3 px of horizontal page scroll on a 393 px iPhone is what the old 92 px
   * floor on the voice picker produced, and nothing here gets to do that again.
   */
  @media (max-width: 560px) {
    .lag {
      font-size: 12px;
      padding: 0 8px;
    }
  }
</style>
