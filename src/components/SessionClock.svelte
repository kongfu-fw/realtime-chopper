<script lang="ts">
  import { session } from '../lib/app/state'
  import { levelFraction } from '../lib/ui/level.ts'
  import { translator, uiLang } from '../lib/i18n/index.ts'
  import Glyph from './Glyph.svelte'

  const tr = $derived(translator($uiLang))

  const { state: sessionState, level, recording } = session

  /**
   * How long this session has been recording, and where the file is afterwards.
   *
   * The middle of the title bar, which is the one strip of screen that is always
   * visible and never scrolls: "how long have I been recording?" is the question a
   * lecture raises every few minutes, and it was the one thing the old language
   * pair in that spot could not answer.
   *
   * Counted here rather than read off `session.recording.seconds`, and that is a
   * deliberate duplication: those are the seconds *saved to the file*, and with
   * 「保存整场录音」 switched off there is no file at all — the clock would sit at
   * 00:00 for a whole lesson. The clock measures the session, the export measures
   * the file, and the two are allowed to disagree.
   *
   * One interval per session, 2 Hz, and the number is an integer: a tenth of a
   * second is not information a person reads, and re-rendering twice a second for
   * the length of a lecture is the whole memory budget this widget is allowed.
   */
  const TICK_MS = 500
  let seconds = $state(0)

  $effect(() => {
    // Only a running session counts. Leaving it: the cleanup clears the interval
    // and the number stays where it stopped, which is what the export button
    // below is about to refer to.
    if ($sessionState !== 'recording') return
    const startedAt = Date.now()
    seconds = 0
    const timer = setInterval(() => {
      seconds = Math.floor((Date.now() - startedAt) / 1000)
    }, TICK_MS)
    return () => clearInterval(timer)
  })

  /**
   * Whether there is a recording to save, and no session still writing to it.
   *
   * `bytes > 0` rather than `seconds > 0`: what the button offers is a file, and
   * with 「保存整场录音」 off there is no file — a button that opens a share sheet
   * with nothing in it would be worse than no button.
   */
  const canDownload = $derived($sessionState !== 'recording' && ($recording?.bytes ?? 0) > 0)

  /** `mm:ss`, and `h:mm:ss` only once a lesson is that long. */
  function stamp(total: number): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const rest = total % 60
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`
  }

  const live = $derived($sessionState === 'recording')
</script>

<!--
 * Two rows, fixed: the download button on top and the voiceprint underneath it,
 * with the time spanning both.
 *
 * The top row is *always* there, even when it is empty, and that is the point of
 * the grid: the button appears the moment a recording ends, and a button that
 * appears takes its space from whatever is below it — which is the voiceprint the
 * eye is on. Reserved room costs 16 px of header and buys a header that never
 * moves.
 *
 * The download goes *above* the voiceprint rather than beside the clock because
 * that is where the user asked for it, and because it keeps the one number in the
 * header — the time — at the same x position whether or not the button is there.
-->
<div class="clock">
  <div class="slot">
    {#if canDownload}
      <button
        class="dl"
        title={tr('下载录音')}
        aria-label={tr('下载录音')}
        onclick={() => void session.exportRecording()}
      >
        <Glyph name="download" size={13} />
      </button>
    {/if}
  </div>

  <!--
    * The voiceprint: five bars that rise with the microphone.
    *
    * The level comes from the same store the record button's own effect reads, at
    * the same 10 Hz, and it is applied as a single custom property on the
    * container — five `scaleY`s in a stylesheet instead of five style writes from
    * JavaScript. Bars rather than one bar because a voiceprint is a *shape*: at
    * rest it still reads as the mark of a voice, which is what makes "it is
    * listening" legible without a number to interpret.
    *
    * Dim when nothing is being recorded: after a stop, the mark belongs to the
    * time beside it, not to the microphone.
  -->
  <div
    class="vp"
    class:live
    style={`--level:${levelFraction($level).toFixed(3)}`}
    aria-hidden="true"
  >
    <i></i><i></i><i></i><i></i><i></i>
  </div>

  <div class="time" title={tr('录音时长')}>{stamp(seconds)}</div>
</div>

<style>
  .clock {
    display: grid;
    grid-template-columns: auto auto;
    grid-template-rows: 16px auto;
    align-items: center;
    justify-items: center;
    column-gap: 7px;
    /* Nothing in here is a text input: the header's own padding is the margin. */
    line-height: 1;
  }

  .slot {
    grid-area: 1 / 1;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 16px;
  }

  .dl {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 16px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--rc-ink-soft);
    cursor: pointer;
  }

  .dl:hover,
  .dl:focus-visible {
    color: var(--rc-accent);
  }

  .vp {
    grid-area: 2 / 1;
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 16px;
    color: var(--rc-line-strong);
  }

  .vp.live {
    color: var(--rc-accent);
  }

  .vp i {
    display: block;
    width: 2.5px;
    border-radius: 2px;
    background: currentColor;
    transform-origin: bottom;
    /*
     * 14 % at rest, and 86 % of the remaining height at a full bar, so the tallest
     * bar reaches exactly the top of the box: a transform that overflowed its own
     * row would draw over the download button above it.
     *
     * The per-bar multipliers are what make it a voiceprint instead of a level
     * meter — five heights that rise together, symmetric around the middle one.
     */
    transform: scaleY(calc(0.14 + var(--level, 0) * var(--m, 1) * 0.86));
    /* Bridging the 10 Hz updates into something the eye reads as movement. */
    transition: transform 120ms linear;
  }

  .vp i:nth-child(1) {
    height: 8px;
    --m: 0.5;
  }

  .vp i:nth-child(2) {
    height: 12px;
    --m: 0.78;
  }

  .vp i:nth-child(3) {
    height: 16px;
    --m: 1;
  }

  .vp i:nth-child(4) {
    height: 12px;
    --m: 0.7;
  }

  .vp i:nth-child(5) {
    height: 8px;
    --m: 0.44;
  }

  .time {
    grid-area: 1 / 2 / span 2 / span 1;
    font-size: 15px;
    font-weight: 700;
    /* Digits that do not shuffle sideways as the seconds tick over. */
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.4px;
    color: var(--rc-ink);
  }

  @media (prefers-reduced-motion: reduce) {
    .vp i {
      transition: none;
    }
  }
</style>
