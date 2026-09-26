<script lang="ts">
  import { settings } from '../lib/store/settings'
  import { session, showToast } from '../lib/app/state'
  import { t, translator, uiLang } from '../lib/i18n/index.ts'
  import LineAudio from './LineAudio.svelte'

  const tr = $derived(translator($uiLang))

  interface Props {
    lines: import('../lib/types').Line[]
    /** False when nothing is being recorded, so replay is not offered. */
    audioAvailable: boolean
  }

  let { lines, audioAvailable }: Props = $props()

  let bodyEl: HTMLElement | undefined = $state()
  let pinned = $state(true)

  // Follow the newest line until the user scrolls up to read something older.
  $effect(() => {
    if (!pinned || !bodyEl) return
    lines.length
    bodyEl.scrollTop = bodyEl.scrollHeight
  })

  function onScroll() {
    if (!bodyEl) return
    pinned = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 40
  }

  /**
   * Plays one line straight from the session recording.
   *
   * The URL lives only as long as the audio being played: a session's worth of
   * per-line URLs would otherwise be held for the whole session.
   */
  async function play(line: import('../lib/types').Line) {
    const blob = await session.lineAudio(line.id)
    if (!blob) {
      showToast(t('这句没有录音'))
      return
    }
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    audio.onended = () => URL.revokeObjectURL(url)
    void audio.play().catch(() => URL.revokeObjectURL(url))
  }

  function time(ms: number, endMs: number): string {
    const s = Math.floor(ms / 1000)
    const stamp = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    return `${stamp} · ${((endMs - ms) / 1000).toFixed(1)}s`
  }
</script>

<section class="panel" aria-label={tr('原文')}>
  <div class="panel-head">
    <span class="panel-title">{tr('原文')}</span>
    <span class="spacer"></span>
    {#if !pinned}
      <button
        class="rc-btn ghost small"
        onclick={() => {
          pinned = true
          if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight
        }}
      >
        {tr('回到最新')}
      </button>
    {/if}
  </div>

  <div class="panel-body" bind:this={bodyEl} onscroll={onScroll}>
    {#if lines.length === 0}
      <p class="empty">{tr('点下面的按钮开始说话。')}</p>
    {:else}
      {#each lines as line (line.id)}
        <article class="line">
          <!--
           * Timestamps, engine details and the replay / re-recognise actions are
           * all repair tools. They are only in the way for someone who just
           * wants to read the transcript, so they live behind debug mode.
           -->
          {#if $settings.debugMode}
            <div class="line-meta">
              <span>{time(line.startMs, line.endMs)}</span>
              <span title={tr('识别引擎')}>{line.engine || '—'}</span>
              <span title={tr('推理耗时')}>{line.inferMs} ms</span>
              {#if audioAvailable}
                <button
                  class="rc-btn ghost small"
                  title={tr('播放这句的原始录音')}
                  onclick={() => void play(line)}
                >
                  {tr('▶ 原声')}
                </button>
              {/if}
              <button
                class="rc-btn ghost small"
                title={tr('用录音里的这段音频重新识别一次')}
                onclick={() => void session.reRecognize(line.id)}
              >
                {tr('重新识别')}
              </button>
            </div>
          {/if}
          <div class="line-text">{line.text}</div>

          {#if $settings.debugMode}
            <!-- Requirement 12: put the audio and the text side by side so the
                 recognition can be judged by ear. -->
            <div class="debug-box">
              <div>{tr('模型原始输出：{text}', { text: line.rawText || '—' })}</div>
              <div>
                {tr('引擎：{engine} · 推理 {ms} ms · 时长 {sec}s', {
                  engine: line.engine || '—',
                  ms: line.inferMs,
                  sec: ((line.endMs - line.startMs) / 1000).toFixed(2),
                })}
              </div>
              <div>{tr('时间轴：{start} → {end} ms', { start: line.startMs, end: line.endMs })}</div>
              {#if audioAvailable}
                <LineAudio {line} />
              {:else}
                <div>{tr('（没有录音，可在设置里打开「保存整场录音」）')}</div>
              {/if}
            </div>
          {/if}
        </article>
      {/each}
    {/if}
  </div>
</section>

<style>
  .spacer {
    flex: 1 1 auto;
  }
</style>
