<script lang="ts">
  import { fade, fly } from 'svelte/transition'
  import SessionClock from './SessionClock.svelte'
  import SaveNoteDialog from './SaveNoteDialog.svelte'
  import { openHistory, session, showToast, view } from '../lib/app/state'
  import { autoTitle, currentPlace, placeNow, whenText } from '../lib/history/place'
  import { saveSession } from '../lib/history/save'
  import { warn } from '../lib/log/store'
  import { t, translator, uiLang } from '../lib/i18n/index.ts'

  /**
   * What a pause turns into.
   *
   * Pausing used to be impossible, and stopping used to be the end of everything:
   * the recording was exported or lost, and the transcript went with it. Now that
   * a pause exists it has to *lead* somewhere, and this panel is the three places
   * it leads — each of them a decision about the note that has just been made:
   *
   *   保存          file it and go and look at it (the list badges it as 新)
   *   继续录音      the pause was a pause; open the microphone again
   *   开启新录音    file it and start the next one
   *
   * ## Why the clock is here, and enlarged
   *
   * The header's three marks — the voiceprint, the download button and the
   * timer — are the answer to "what did I just record": how it sounded, how long
   * it ran, and whether there is a file to keep. On the header they are 20 px of
   * a 56 px strip, which is the right size for a glance during a lesson and too
   * small to decide by. So the panel draws *the same component*, scaled up and
   * centred, and the numbers a person is about to make a decision with are the
   * biggest thing on the screen.
   *
   * The transition is that scale: the clock grows into place as the panel
   * arrives, because it is the same clock and it should look like it.
   */

  const tr = $derived(translator($uiLang))

  /** True while the naming dialog is up — see `askName`. */
  let naming = $state(false)
  /** The place the note will be titled with; may still be on its way. */
  let place = $state(placeNow().label)
  let busy = $state(false)

  const at = $derived(session.startedAtMs || Date.now())

  /**
   * 保存: name it, then file it.
   *
   * The dialog opens on the title the note already has, and the position lookup
   * runs *behind* it — a permission prompt and a network call are not reasons to
   * make somebody wait to see their own note's name. When the fix lands, the
   * dialog's title recomposes around it unless it has been typed in.
   */
  function askName(): void {
    place = placeNow().label
    naming = true
    void currentPlace().then((found) => {
      place = found.label
    })
  }

  /**
   * Files the session, and says which of the three things happened.
   *
   * `failed` is separate from `empty` on purpose, and it is the one state the rest
   * of this panel has to respect: a note that could not be written is still on the
   * screen, still pausable and still recoverable, and the two callers below both
   * refuse to do anything destructive when it comes back.
   */
  async function file(title?: string): Promise<'saved' | 'empty' | 'failed'> {
    if (busy) return 'failed'
    busy = true
    try {
      const outcome = await saveSession(title)
      if (outcome === 'empty') {
        // Nothing was said and nothing was recorded: there is no note, and the
        // session still has to end — the user asked for it to be over.
        await session.stop()
      }
      naming = false
      return outcome
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      warn('storage', t('保存失败：{message}', { message }))
      showToast(message)
      return 'failed'
    } finally {
      busy = false
    }
  }

  /** 保存: file it, then go and look at it. */
  async function saveAndOpen(title: string): Promise<void> {
    if ((await file(title)) === 'saved') openHistory()
  }

  /**
   * 开启新录音: file this one, throw its transcript away, and start again.
   *
   * The transcript is cleared *here* and nowhere else (see
   * `Session.resetTranscript`): the note that was just filed is the one it
   * belonged to, and leaving it on screen would make the next note look like it
   * had been recorded at the same time as the last one.
   */
  async function startFresh(): Promise<void> {
    // A note that did not get filed is *not* thrown away to make room for the
    // next one: the panel stays, with the sentence about what failed above it, and
    // the transcript is still there to try again with.
    if ((await file()) === 'failed') return
    session.resetTranscript()
    view.set('translate')
    try {
      await session.start()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      warn('ui', t('操作失败：{error}', { error: message }))
      showToast(message)
    }
  }

  /** 继续录音. */
  async function carryOn(): Promise<void> {
    try {
      await session.resume()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }
</script>

<!--
  The backdrop is the panel's own weight on the screen: while it is up, the
  transcript behind it is not readable anyway, and a pause that left the app
  looking ready to record would be the one thing this state must not look like.
-->
<div class="scrim" transition:fade={{ duration: 180 }}></div>
<div class="panel pause-panel" transition:fly={{ y: 48, duration: 260 }}>
  <p class="heading">{tr('录音已暂停')}</p>

  <!-- The enlargement itself: `zoom` scales the component the header works with,
       drawn with a transition from its own size (see SessionClock). Centred, and
       given the room it needs — 2.2× of the header row is ~240 px wide. -->
  <div class="scale">
    <SessionClock zoom={2.2} />
  </div>

  <div class="actions">
    <button class="rc-btn" disabled={busy} onclick={() => void carryOn()}>
      {tr('继续录音')}
    </button>
    <button class="rc-btn" disabled={busy} onclick={() => void startFresh()}>
      {tr('开启新录音')}
    </button>
    <button class="rc-btn accent save" disabled={busy} onclick={askName}>
      {busy ? tr('保存中…') : tr('保存')}
    </button>
  </div>
</div>

{#if naming}
  <SaveNoteDialog
    heading={tr('保存到历史记录')}
    initial={autoTitle(at, place)}
    when={whenText(at)}
    place={place}
    at={at}
    live
    confirm={tr('保存')}
    onsave={saveAndOpen}
    onclose={() => (naming = false)}
  />
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    /* Above the app, and *below* the naming dialog: `Modal` sits at 50, so this
       panel is 40/41 — a dialog the panel itself opens has to be able to cover
       the screen it was opened from. */
    z-index: 40;
    background: rgb(253 251 244 / 94%);
  }

  .panel {
    position: fixed;
    inset: 0;
    z-index: 41;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 30px;
    padding: calc(20px + env(safe-area-inset-top)) 20px calc(20px + env(safe-area-inset-bottom));
    /* The panel is a screen, not a card: a fixed box in the middle of the window
       would put the clock and the buttons in one phone-sized rectangle and leave
       the two edges of the screen showing a transcript nobody can read while it
       is up. */
    background: var(--rc-bg);
  }

  .heading {
    margin: 0;
    font-size: 15px;
    letter-spacing: 0.4px;
    color: var(--rc-ink-soft);
  }

  /* The scaled clock needs a box of its own: `transform` does not change layout
     size, so without this the panel would centre a 110 px row and let the grown
     copy spill over both neighbours. */
  .scale {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 120px;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 12px;
  }

  .rc-btn {
    padding: 12px 22px;
    font-size: 16px;
  }

  /* The decision this panel exists for, made the loud one. */
  .save {
    min-width: 132px;
    font-weight: 600;
  }
</style>
