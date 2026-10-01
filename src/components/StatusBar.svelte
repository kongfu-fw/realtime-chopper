<script lang="ts">
  import { session, beginSession, installLang, showToast } from '../lib/app/state'
  import { info, warn } from '../lib/log/store'
  import { levelFraction } from '../lib/ui/level.ts'
  import { t, translator, uiLang } from '../lib/i18n/index.ts'
  import Glyph from './Glyph.svelte'
  import ModelInstallModal from './ModelInstallModal.svelte'
  import ReadSettings from './ReadSettings.svelte'

  const tr = $derived(translator($uiLang))

  // `state` is renamed on destructuring: a local called `state` would collide
  // with the `$state` rune.
  const { state: sessionState, lines, autoRead, level } = session

  let busy = $state(false)
  let readSettings = $state(false)

  const recording = $derived($sessionState === 'recording')
  const paused = $derived($sessionState === 'paused')
  const preparing = $derived($sessionState === 'preparing' || $sessionState === 'stopping')
  /**
   * Whether a sentence is being read out right now.
   *
   * Read off the lines rather than kept as a flag of its own: the reader marks the
   * line it is speaking, and that mark is already what the translation panel draws
   * its own mark from. Two sources for one fact is how a switch comes to say
   * "reading" while nothing is being read.
   */
  const speaking = $derived($lines.some((line) => line.ttsState === 'speaking'))

  /**
   * The button's own word, in the state it is in.
   *
   * `取消启动` while preparing is deliberate: the microphone permission prompt is
   * the one wait the user can actually get out of, and a disabled button in its
   * place would leave a phone sitting behind a prompt with no way back.
   *
   * And it says 暂停 rather than 停止 while recording, which is the change the
   * history brought: a session no longer ends by being stopped, it ends by being
   * *filed* — so the button stops the microphone and the panel that appears asks
   * what the note is for. 继续录音 is here as well as on that panel because the
   * panel is a screen and this button is a thumb at the bottom of it: two doors,
   * one of them where the hand already is.
   */
  const recordLabel = $derived(
    preparing
      ? tr('取消启动')
      : recording
        ? tr('暂停录音')
        : paused
          ? tr('继续录音')
          : tr('开始录音'),
  )

  /**
   * The same state, in one word — what the pill actually shows.
   *
   * The full sentence above is the tooltip and the accessible name; the pill
   * itself is a thumb target at the bottom of a phone with a second one beside it,
   * so it says what the button *is* in the fewest characters that still read as
   * words rather than as an icon (`录音` / `停止` / `取消`).
   */
  const pillLabel = $derived(
    preparing ? tr('取消') : recording ? tr('暂停') : paused ? tr('继续') : tr('录音'),
  )

  /** What the read-aloud switch currently is, in one word, for the same reason. */
  const readLabel = $derived($autoRead ? tr('朗读') : tr('静音'))

  async function toggle() {
    if (busy) return
    busy = true
    try {
      if (recording) await session.pause()
      else if (paused) await session.resume()
      else
        // Requirement 11 (a module is downloaded on first use, for the language
        // the user actually chose) and the headphone question both live behind
        // this call, which is also what the drawer's 开始翻译 uses.
        await beginSession()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      warn('ui', t('操作失败：{error}', { error: message }))
      showToast(message)
    } finally {
      busy = false
    }
  }

  // The dialog records the install itself; here we only continue where the user
  // was heading (they pressed the record button).
  function onInstallDone() {
    installLang.set(null)
    void session.start().catch((err: unknown) => {
      showToast(err instanceof Error ? err.message : String(err))
    })
  }

  function onInstallCancel(reason = t('未知')) {
    installLang.set(null)
    // The reason matters: on a phone a tap on the backdrop closes this dialog
    // just as easily as the close button, and "cancelled" with no reason reads
    // like the install failed on its own.
    info('storage', t('已取消安装识别模块（{reason}）', { reason }))
  }
</script>

<!--
 * The two things the user reaches for, at the two bottom corners of the screen:
 * recording on the left, and the read-aloud switch on the right. Both are pills,
 * because a pill is a control you press with a thumb without aiming.
 *
 * And that is the whole bar. It used to hold a column of sentences between them
 * as well — the start-up phase, the notices, the "skip to latest" escape hatch —
 * and the argument for taking them out is the phone rather than the pixels: a bar
 * whose length changes is a bar whose ends move, and the ends are what a thumb is
 * aimed at. Nothing is lost by it either, because every one of those sentences is
 * written to the log as it happens (the notice mirror in `App.svelte`), and the
 * log is where a classroom's worth of these is actually read.
 *
 * The microphone level comes back here in a different guise, and the difference is
 * the whole reason it can: not a bar to read, but the *inside of the button* — a
 * session being recorded is hollowed out, and the sound the microphone is catching
 * rises inside it. It is decoration that answers "is it still hearing me?" at a
 * glance, at a distance, without a scale to interpret; the history of why the
 * readout left is in the "电平" section of DOCS.md, and nothing in it is
 * contradicted by an effect that is inside the control rather than beside it.
 -->
<button
  class="record-btn"
  class:recording
  onclick={toggle}
  aria-label={recordLabel}
  title={recordLabel}
  disabled={$sessionState === 'stopping'}
>
  <!--
   * The level, drawn inside the pill. One element, one custom property, one
   * `scaleY` (see `app.css`): the store ticks at 10 Hz and a `transform` is the
   * only thing that can move at that rate without laying anything out again.
   *
   * Only while recording. The button at rest is a solid red pill and its inside
   * is not a place anything lives.
  -->
  {#if recording}
    <span
      class="level"
      style={`--level:${levelFraction($level).toFixed(3)}`}
      aria-hidden="true"
    ></span>
  {/if}
  <span class="glyph" aria-hidden="true">
    {#if preparing}
      <span class="spinner"></span>
    {:else if recording}
      <span class="square"></span>
    {:else}
      <span class="dot"></span>
    {/if}
  </span>
  <span class="label">{pillLabel}</span>
</button>

<!--
 * The right-hand end: the settings that change what the phone says, and the switch
 * that says whether it says anything at all.
 *
 * The settings button sits *inside* the pair rather than at the far corner, so
 * that the read-aloud switch — the one of the two that gets pressed mid-lesson —
 * keeps exactly the position it had before there was a second button here.
 *
 * The voice mark replaces the speaker emoji, which was rendered by the platform
 * and therefore looked like three different buttons on three devices. It says
 * "voice", which is the whole subject of this corner; whether that voice is on is
 * said by the word, the outline and the crossed-through dimming, not by the mark.
 *
 * The three animated bars that used to sit after the label are gone. They were a
 * fourth thing in a corner that holds a thumb target, a word and a mark, and the
 * one fact they carried — "a sentence is being read right now" — is carried by the
 * mark's colour instead, which costs no width and moves nothing.
 -->
<div class="read-cluster">
  <button
    class="set-btn"
    aria-label={tr('朗读设置')}
    title={tr('朗读设置')}
    onclick={() => (readSettings = true)}
  >
    <Glyph name="sliders" size={17} />
  </button>

  <button
    class="read-btn"
    class:on={$autoRead}
    class:reading={speaking}
    aria-pressed={$autoRead}
    aria-label={$autoRead ? tr('暂停自动朗读') : tr('恢复自动朗读')}
    title={$autoRead ? tr('暂停自动朗读') : tr('恢复自动朗读')}
    onclick={() => autoRead.set(!$autoRead)}
  >
    <span class="mark" aria-hidden="true"><Glyph name="voice" size={16} /></span>
    <span class="label">{readLabel}</span>
  </button>
</div>

{#if $installLang}
  <ModelInstallModal want={$installLang} ondone={onInstallDone} oncancel={onInstallCancel} />
{/if}

{#if readSettings}
  <ReadSettings onclose={() => (readSettings = false)} />
{/if}

<style>
  .dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #fff;
  }

  .square {
    width: 12px;
    height: 12px;
    background: #fff;
    border-radius: 2px;
  }

  .spinner {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid rgb(255 255 255 / 45%);
    border-top-color: #fff;
    animation: rc-spin 700ms linear infinite;
  }

  @keyframes rc-spin {
    to {
      transform: rotate(360deg);
    }
  }

  /*
   * The read-aloud switch.
   *
   * On is the ordinary state, so it is the quiet one: solid ink outline, ink text,
   * the speaker emoji. Off has to be the one that looks different, because "why is
   * nothing being read out?" is the question this switch answers — hence the
   * dashed outline, the soft grey, and the crossed-out speaker in its label.
   */
  .read-btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 40px;
    padding: 0 14px;
    border: 2px solid var(--rc-line-strong);
    border-radius: var(--rc-radius-pill);
    background: var(--rc-surface);
    color: var(--rc-ink-soft);
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
    box-shadow: var(--rc-shadow-hard);
  }

  .read-btn.on {
    border-color: var(--rc-ink);
    color: var(--rc-ink);
  }

  .read-btn:not(.on) {
    /* Off is the state that has to look different: the emoji says it, the darker
       outline says it, and the word says it — three readings of one fact, because
       "why is nothing being read out?" is the question this switch answers. */
    border-style: dashed;
  }

  .read-cluster {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
  }

  /*
   * A square thumb target, not a pill: the settings button holds one glyph and
   * nothing else, and giving it the read switch's label treatment would make two
   * buttons of the same weight out of one control and one door.
   */
  .set-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border: 2px solid var(--rc-line-strong);
    border-radius: var(--rc-radius-s);
    background: var(--rc-surface);
    color: var(--rc-ink-soft);
    cursor: pointer;
  }

  @media (any-hover: hover) {
    .set-btn:hover {
      border-color: var(--rc-ink);
      color: var(--rc-ink);
    }
  }

  .read-btn .mark {
    display: inline-flex;
    color: inherit;
  }

  .read-btn .label {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /*
   * A sentence is being read right now: the mark goes green.
   *
   * Colour and nothing else. It is the one signal available to this corner that
   * costs no width and moves nothing — the corner holds the control a thumb is
   * aimed at, and the bars that used to carry this fact took their space from the
   * side of the pill that the thumb is on.
   */
  .read-btn.reading .mark {
    color: var(--rc-ok);
  }

  @media (any-hover: hover) {
    .read-btn:hover {
      border-color: var(--rc-ink);
      color: var(--rc-ink);
    }
  }

  /*
   * The narrowest phones (a 320 px screen, still plenty of them in a classroom).
   * The word goes before either glyph does: the voice mark and the bars say what
   * the switch is and which way it is set, and the full name is on the accessible
   * label either way.
   */
  @media (max-width: 360px) {
    .read-btn .label {
      display: none;
    }
  }
</style>
