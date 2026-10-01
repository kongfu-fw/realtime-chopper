<script lang="ts">
  import { session } from '../lib/app/state'
  import { levelFraction } from '../lib/ui/level.ts'
  import { translator, uiLang } from '../lib/i18n/index.ts'
  import Glyph from './Glyph.svelte'

  const tr = $derived(translator($uiLang))

  /**
   * How much larger than the header's copy this one is drawn.
   *
   * A scale rather than a second set of sizes, because the pause panel asks for
   * "the same clock, bigger" and building a second clock would be two things to
   * keep in step — every later change to the voiceprint or the mosaic digits
   * would have to be made twice, and the copy that nobody was looking at is the
   * one that would drift. The panel passes ~2 and animates it: the clock grows
   * out of its own size as the panel arrives, which is what makes it read as the
   * header's clock come forward rather than as a new widget appearing.
   */
  interface Props {
    zoom?: number
    /**
     * Whether this copy of the clock offers the recording as a file.
     *
     * True in the header, false on the pause panel. The panel is drawn between a
     * stop and a decision, and it already answers "what happens to this note"
     * three ways (see `PausePanel`); a fourth, unlabelled icon that downloads the
     * WAV *in addition* to filing it was a second meaning for the same recording,
     * sitting in the middle of the row the user is reading to decide. The file is
     * still one tap away — the header keeps it, and the note itself carries it
     * once filed.
     */
    showDownload?: boolean
  }

  let { zoom = 1, showDownload = true }: Props = $props()

  const { state: sessionState, level, recording } = session

  /**
   * How long this session has been recording, and where the file is afterwards.
   *
   * The middle of the title bar, which is the one strip of screen that is always
   * visible and never scrolls: "how long have I been recording?" is the question a
   * lecture raises every few minutes, and it was the one thing the old language
   * pair in that spot could not answer.
   *
   * The number itself belongs to the session (`Session.elapsedSeconds`), and only
   * the ticking belongs here: a pause mounts this component a second time, and a
   * clock that counted from its own construction would open the pause panel on
   * 00:00 and start over after 继续录音.
   *
   * It is deliberately *not* `session.recording.seconds` either: those are the
   * seconds saved to the file, and with 「保存整场录音」 switched off there is no
   * file at all — the clock would sit at 00:00 for a whole lesson. The clock
   * measures the session, the export measures the file, and the two are allowed to
   * disagree.
   *
   * One interval per session, 2 Hz, and the number is an integer: a tenth of a
   * second is not information a person reads, and re-rendering twice a second for
   * the length of a lecture is the whole budget this widget is allowed.
   */
  const TICK_MS = 500
  let seconds = $state(0)

  $effect(() => {
    // Read the state first so that entering it or leaving it re-runs this: a paused
    // session stops ticking and the number stays where it stopped, which is what
    // the panel it is drawn on and the export button beside it both refer to.
    const state = $sessionState
    seconds = Math.floor(session.elapsedSeconds())
    if (state !== 'recording') return
    const timer = setInterval(() => {
      seconds = Math.floor(session.elapsedSeconds())
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
  const value = $derived(stamp(seconds))

  /**
   * The clock's alphabet: a 3×5 mosaic per glyph, one string per row, `1` for a lit
   * block, and a one-column colon.
   *
   * Drawn rather than typed. The time used to be text in the interface font, and a
   * "block" face for it is not something this app may have: a webfont is a network
   * dependency in a PWA that is otherwise complete on the device, and the platform
   * fonts that render digits as blocks exist on no two machines the same way. Five
   * rows of three squares are the whole font, they are the same on every device,
   * and they scale with `--rc-*` tokens like everything else here.
   *
   * Deliberately *not* a `tabular-nums` number any more: every glyph is exactly as
   * wide as every other, so the clock cannot shuffle sideways as the seconds tick —
   * which was the one property the old face had to be given specially.
   */
  const FONT: Record<string, string[]> = {
    '0': ['111', '101', '101', '101', '111'],
    '1': ['010', '110', '010', '010', '111'],
    '2': ['111', '001', '111', '100', '111'],
    '3': ['111', '001', '111', '001', '111'],
    '4': ['101', '101', '111', '001', '001'],
    '5': ['111', '100', '111', '001', '111'],
    '6': ['111', '100', '111', '101', '111'],
    '7': ['111', '001', '001', '001', '001'],
    '8': ['111', '101', '111', '101', '111'],
    '9': ['111', '101', '111', '001', '111'],
    ':': ['0', '1', '0', '1', '0'],
  }

  /** The clock broken into glyphs, each one five rows of cells. */
  const glyphs = $derived(
    value.split('').map((char) => ({ colon: char === ':', rows: FONT[char] ?? FONT['0'] })),
  )

  /**
   * The growth itself: one frame at the small size, then the one it was asked
   * for, so the transition has two states to move between.
   *
   * A frame rather than a `tick`, and it matters: the browser has to have laid
   * the element out at scale 1 for a later change to be animated at all, and a
   * microtask is not enough for that.
   */
  let grown = $state(false)

  $effect(() => {
    if (zoom === 1) {
      grown = true
      return
    }
    const raf = requestAnimationFrame(() => (grown = true))
    return () => cancelAnimationFrame(raf)
  })

  const scale = $derived(grown ? zoom : 1)
</script>

<!--
 * One row, three things, in the order they are asked about: the voiceprint (is it
 * hearing me?), the download (can I keep it?) and the time (how long has this been
 * going?). The download sits *between* the other two — where it belongs in the
 * reading order, and where it is a button the eye passes on its way from the sound
 * to the number rather than one it has to go looking for. Where it is not wanted at
 * all (`showDownload`), the row is simply two things.
 *
 * The time is the only thing in this row with a fixed width, and the other two are
 * what move around it: the voiceprint's bars breathe without changing their box,
 * and the download keeps its 18 px whether or not there is a file to save. That
 * last part is the whole reason the button has a slot of its own: it appears the
 * moment a recording ends, and a button that appears takes its space from whatever
 * is next to it — which is the clock, and the clock is a number being watched.
-->
<div class="clock" style={`--zoom:${scale}`}>
  <!--
    * The voiceprint: five bars, rising with the microphone.
    *
    * The level comes from the same store the record button's own effect reads, at
    * the same 10 Hz, and it is applied as a single custom property on the container
    * — five `scaleY`s in a stylesheet instead of five style writes from JavaScript.
    * Bars rather than one bar because a voiceprint is a *shape*: at rest it still
    * reads as the mark of a voice, which is what makes "it is listening" legible
    * without a number to interpret.
    *
    * Framed, faintly: a hairline border and a slightly recessed background are what
    * make five moving marks read as one instrument with a scale, rather than as five
    * loose sticks beside a number. Dim when nothing is being recorded: after a stop,
    * the mark belongs to the time beside it, not to the microphone.
  -->
  <div
    class="vp"
    class:live
    style={`--level:${levelFraction($level).toFixed(3)}`}
    aria-hidden="true"
  >
    <i></i><i></i><i></i><i></i><i></i>
  </div>

  <!-- The reserved download slot; see the note above. Left out entirely on a copy
       that does not offer the file (the pause panel), so nothing is reserved for a
       button that cannot appear. -->
  {#if showDownload}
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
  {/if}

  <!--
    * The time, as blocks. `role="img"` with the time in `aria-label` is the way a
    * graphic that *is* a value gets read out: the five rows of squares are marked
    * decorative, and what a screen reader announces is the number they spell.
  -->
  <div
    class="time"
    role="img"
    aria-label={`${tr('录音时长')} ${value}`}
    data-value={value}
  >
    {#each glyphs as glyph, index (index)}
      <span class="d" class:colon={glyph.colon}>
        {#each glyph.rows as row, r (r)}
          {#each [...row] as cell, c (c)}
            <i class:on={cell === '1'}></i>
          {/each}
        {/each}
      </span>
    {/each}
  </div>
</div>

<style>
  .clock {
    display: flex;
    align-items: center;
    gap: 7px;
    /* Nothing in here is a text input: the header's own padding is the margin. */
    line-height: 1;
    /*
     * The whole row scales as one drawing, `transform-origin` at its centre so a
     * grown clock stays centred on the axis the small one is on — the pause panel
     * centres this box, and a scale from a corner would make the panel look off.
     */
    transform: scale(var(--zoom, 1));
    transform-origin: center center;
    transition: transform 320ms cubic-bezier(0.2, 0.9, 0.2, 1);
  }

  /*
   * The frame around the voiceprint. `height: 20px` with 2 px of padding and a 1 px
   * border leaves 14 px inside, which is the tallest bar — so a full-scale bar
   * touches the frame's inner edge exactly, and never draws over the number beside
   * it.
   */
  .vp {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    gap: 2px;
    height: 20px;
    padding: 2px 4px;
    border: 1px solid var(--rc-line);
    border-radius: 6px;
    background: var(--rc-surface-alt);
    color: var(--rc-line-strong);
    transition:
      border-color 160ms ease,
      background-color 160ms ease;
  }

  .vp.live {
    border-color: var(--rc-line-strong);
    color: var(--rc-accent);
  }

  .vp i {
    display: block;
    width: 3px;
    border-radius: 1.5px;
    background: currentColor;
    transform-origin: bottom;
    /*
     * 16 % at rest, and 84 % of the remaining height at a full bar, so the tallest
     * bar reaches exactly the top of the frame at full scale.
     *
     * The per-bar multipliers are what make it a voiceprint instead of a level
     * meter — five heights that rise together, symmetric around the middle one.
     */
    transform: scaleY(calc(0.16 + var(--level, 0) * var(--m, 1) * 0.84));
    /* Bridging the 10 Hz updates into something the eye reads as movement. */
    transition: transform 120ms linear;
  }

  .vp i:nth-child(1) {
    height: 7px;
    --m: 0.45;
  }

  .vp i:nth-child(2) {
    height: 10px;
    --m: 0.75;
  }

  .vp i:nth-child(3) {
    height: 14px;
    --m: 1;
  }

  .vp i:nth-child(4) {
    height: 10px;
    --m: 0.8;
  }

  .vp i:nth-child(5) {
    height: 7px;
    --m: 0.5;
  }

  /*
   * The download's room, held open. It is the same 18 px whether the button is in
   * it or not, and that is the point: the icon appears when a recording ends, and
   * nothing beside it may move when it does.
   */
  .slot {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
  }

  .dl {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
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

  /*
   * The mosaic. One grid per glyph: 3 × 3 px cells with 1 px between them, so a
   * digit is 11 × 19 px and the colon is one column of the same cells. The colour
   * comes from `currentColor`, so a themed clock is a change to `.time` alone.
   */
  .time {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--rc-ink);
  }

  .time .d {
    display: grid;
    grid-template-columns: repeat(3, 3px);
    grid-auto-rows: 3px;
    gap: 1px;
  }

  .time .d.colon {
    grid-template-columns: 3px;
    /* A colon hangs in the middle of the row rather than sitting on the baseline:
       it is two dots between two digits, not a glyph with a top and a bottom. */
    align-self: center;
  }

  .time i {
    display: block;
    border-radius: 1px;
    /* Unlit cells are nothing: the blocks that are on are the number. */
    background: transparent;
  }

  .time i.on {
    background: currentColor;
  }

  @media (prefers-reduced-motion: reduce) {
    .vp i {
      transition: none;
    }

    .vp {
      transition: none;
    }

    .clock {
      transition: none;
    }
  }
</style>
