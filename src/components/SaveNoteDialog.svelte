<script lang="ts">
  import Modal from './Modal.svelte'
  import { autoTitle } from '../lib/history/place'
  import { currentLang, translator, uiLang } from '../lib/i18n/index.ts'

  /**
   * The one dialog that names a note, used twice.
   *
   * Filed from the pause panel, a note is being *created*: the title opens as the
   * generated one — 日期 时间 · 定位 — and the place may still be on its way (a
   * position fix followed by a name lookup, both of which take a moment), so the
   * title is recomposed when it lands. Renaming an existing note, nothing is in
   * flight and nothing is recomposed: the name in the field is the name it has.
   *
   * The date and the place are shown as *fields* rather than being part of the
   * text being edited, and that is the whole shape of this dialog: a user who
   * types 第三节课 over the generated title has renamed the note without losing
   * when it was or where it was — both of which are the reasons a list of notes is
   * readable a month later.
   */
  interface Props {
    heading: string
    /** The name the note already has. */
    initial: string
    /** When it was recorded, already formatted. */
    when: string
    /** Where it was recorded; `''` while that is still being found. */
    place: string
    /** Epoch ms, so the generated title can be recomposed as the place arrives. */
    at: number
    /** True while a place is still being looked up — i.e. for a new note. */
    live?: boolean
    /** The verb on the confirm button. */
    confirm: string
    onsave: (title: string) => void | Promise<void>
    onclose: () => void
  }

  let { heading, initial, when, place, at, live = false, confirm, onsave, onclose }: Props = $props()

  const tr = $derived(translator($uiLang))

  // Read once, and then the field owns it: both callers mount this dialog for a
  // single note inside an `{#if}`, so there is no prop change to follow — and a
  // name somebody is halfway through typing must never be reset by one anyway.
  // svelte-ignore state_referenced_locally
  let name = $state(initial)
  let edited = $state(false)
  let busy = $state(false)

  /**
   * The generated title follows the place in.
   *
   * And stops the moment the field has been typed in, which is the rule this
   * effect exists for: the lookup is slow, the user is not, and a name someone
   * has written must never be overwritten by an answer to a question they had
   * already improved on.
   */
  $effect(() => {
    if (!live || edited || !place) return
    name = autoTitle(at, place, currentLang())
  })

  async function confirmSave(): Promise<void> {
    if (busy) return
    busy = true
    try {
      await onsave(name)
    } finally {
      busy = false
    }
  }
</script>

<Modal title={heading} onclose={() => onclose()}>
  <div class="form">
    <label class="field">
      <span class="key">{tr('名称')}</span>
      <input
        class="rc-input"
        type="text"
        bind:value={name}
        oninput={() => (edited = true)}
        aria-label={tr('名称')}
      />
    </label>

    <!-- The two fields a rename keeps. Deliberately plain text: they are facts
         about the recording, and there is nothing in this dialog that could
         change them. -->
    <div class="facts">
      <div class="field">
        <span class="key">{tr('日期')}</span>
        <span class="value">{when}</span>
      </div>
      <div class="field">
        <span class="key">{tr('定位')}</span>
        <span class="value" class:pending={live && !place}>
          {place || tr('正在获取定位…')}
        </span>
      </div>
    </div>
  </div>

  {#snippet footer()}
    <button class="rc-btn ghost" onclick={() => onclose()}>{tr('取消')}</button>
    <button class="rc-btn accent" disabled={busy} onclick={() => void confirmSave()}>
      {busy ? tr('保存中…') : confirm}
    </button>
  {/snippet}
</Modal>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .key {
    font-size: 12px;
    color: var(--rc-ink-soft);
  }

  .facts {
    display: flex;
    gap: 18px;
  }

  .value {
    font-size: 13px;
  }

  .pending {
    color: var(--rc-ink-soft);
  }
</style>
