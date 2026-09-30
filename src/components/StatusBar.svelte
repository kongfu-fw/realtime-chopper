<script lang="ts">
  import {
    session,
    installLang,
    showToast,
    headphoneAck,
    headphonePrompt,
  } from '../lib/app/state'
  import { isLangInstalled, settings } from '../lib/store/settings'
  import { info, warn } from '../lib/log/store'
  import { t, translator, uiLang } from '../lib/i18n/index.ts'
  import ModelInstallModal from './ModelInstallModal.svelte'

  const tr = $derived(translator($uiLang))

  // `state` is renamed on destructuring: a local called `state` would collide
  // with the `$state` rune.
  const { state: sessionState, lines, autoRead } = session

  let busy = $state(false)

  const recording = $derived($sessionState === 'recording')
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
   */
  const recordLabel = $derived(
    preparing ? tr('取消启动') : recording ? tr('停止录音') : tr('开始录音'),
  )

  /**
   * The same state, in one word — what the pill actually shows.
   *
   * The full sentence above is the tooltip and the accessible name; the pill
   * itself is a thumb target at the bottom of a phone with a second one beside it,
   * so it says what the button *is* in the fewest characters that still read as
   * words rather than as an icon (`录音` / `停止` / `取消`).
   */
  const pillLabel = $derived(preparing ? tr('取消') : recording ? tr('停止') : tr('录音'))

  /** What the read-aloud switch currently is, in one word, for the same reason. */
  const readLabel = $derived($autoRead ? tr('朗读') : tr('静音'))

  async function toggle() {
    // While we are waiting on the microphone permission prompt the button turns
    // into a way out, instead of being disabled with a spinner and no escape.
    if ($sessionState === 'preparing') {
      session.abortStart()
      return
    }
    if (busy) return
    busy = true
    try {
      if (recording) {
        await session.stop()
      } else if (!isLangInstalled($settings.sourceLang, $settings.installedModels)) {
        // Requirement 11: prompt on first use, and only for the language the
        // user actually selected — never pre-download every model.
        installLang.set($settings.sourceLang)
      } else if (!$headphoneAck) {
        headphonePrompt.set(true)
      } else {
        await session.start()
      }
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
 * whose length changes is a bar whose two ends move, and the ends are what a thumb
 * is aimed at. Nothing is lost by it either, because every one of those sentences
 * is written to the log as it happens (the notice mirror in `App.svelte`), and the
 * log is where a classroom's worth of these is actually read.
 *
 * The one exception is the microphone level, which is not a sentence and is not
 * drawn at all any more: "it can hear me" was a readout to interpret, and at the
 * distance a phone sits from its owner it was being interpreted wrong (the whole
 * history is in the "电平" section of DOCS.md). The button now says what it does
 * and whether it is doing it; whether the microphone is loud enough is a question
 * the transcript answers.
 -->
<button
  class="record-btn"
  class:recording
  onclick={toggle}
  aria-label={recordLabel}
  title={recordLabel}
  disabled={$sessionState === 'stopping'}
>
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
 * The read-aloud switch, and the same three bars the speaking line wears in the
 * translation panel — so "the app is talking" is legible from the corner of the
 * screen, next to the button that says whether it will talk at all.
 *
 * The bars keep their space when nothing is being read (dimmed, not removed): a
 * control whose width changes every sentence is a control that moves under the
 * thumb that is about to press it.
 -->
<button
  class="read-btn"
  class:on={$autoRead}
  class:reading={speaking}
  aria-pressed={$autoRead}
  aria-label={$autoRead ? tr('暂停自动朗读') : tr('恢复自动朗读')}
  title={$autoRead ? tr('暂停自动朗读') : tr('恢复自动朗读')}
  onclick={() => autoRead.set(!$autoRead)}
>
  <span class="label">{$autoRead ? '🔊' : '🔇'} {readLabel}</span>
  <span class="playing-bars" aria-hidden="true"><i></i><i></i><i></i></span>
</button>

{#if $installLang}
  <ModelInstallModal want={$installLang} ondone={onInstallDone} oncancel={onInstallCancel} />
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

  .read-btn .label {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /*
   * The bars keep their width whether or not anything is being read, and this is
   * the whole of that decision: a footer control that grew and shrank once per
   * sentence would move under the thumb reaching for it. Colour and motion are
   * what change.
   */
  .read-btn .playing-bars {
    color: var(--rc-line-strong);
    opacity: 0.55;
  }

  .read-btn.reading .playing-bars {
    color: var(--rc-ok);
    opacity: 1;
  }

  .read-btn:not(.reading) .playing-bars i {
    animation: none;
    transform: scaleY(0.35);
  }

  @media (any-hover: hover) {
    .read-btn:hover {
      border-color: var(--rc-ink);
      color: var(--rc-ink);
    }
  }

  /*
   * The narrowest phones (a 320 px screen, still plenty of them in a classroom).
   * Two labelled pills plus the notices do not fit there, and the notice is the
   * one piece of the three that cannot be guessed from a shape: the speaker emoji
   * and the bars say what the switch is and which way it is set, and the full name
   * is on the accessible label either way.
   */
  @media (max-width: 360px) {
    .read-btn .label {
      display: none;
    }
  }
</style>
