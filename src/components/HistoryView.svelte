<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import Glyph from './Glyph.svelte'
  import Modal from './Modal.svelte'
  import SaveNoteDialog from './SaveNoteDialog.svelte'
  import { openNote, showToast } from '../lib/app/state'
  import { openBackLayer } from '../lib/app/back'
  import { hashOf } from '../lib/app/route'
  import { whenText } from '../lib/history/place'
  import {
    deleteEntries,
    historyFresh,
    historyList,
    historyPersistent,
    historyReady,
    loadHistory,
    readAudio,
    readEntry,
    renameEntry,
    totalAudioBytes,
    type HistoryEntry,
    type HistoryMeta,
  } from '../lib/history/store'
  import { formatBytes } from '../lib/store/settings'
  import { warn } from '../lib/log/store'
  import { t, translator, uiLang } from '../lib/i18n/index.ts'

  /**
   * Every note on the device, newest first.
   *
   * The list is what a note becomes: a recording nobody can find again is a
   * recording that was never kept, and the two things this screen has to answer
   * are "which one was that" — hence the date, the place and the duration on every
   * row — and "what did it say" — hence a detail that shows the sentences with
   * their translations, which is the only part of a lesson that is worth reading
   * twice.
   *
   * ## Deleting, which is the one destructive thing here
   *
   * A note is up to ~115 MB of audio the user may have been counting on, so
   * deletion goes the way a phone's photo library goes: a 选择 mode, taps that
   * accumulate a selection, a count on the delete button, and a confirmation that
   * names how many notes it is about to remove. One tap on a list row must never
   * be able to delete an hour of a lecture — so a tap opens the note, and the
   * only thing that deletes is a button that says so.
   */

  const tr = $derived(translator($uiLang))

  /**
   * The note being read in full; `null` while the list is showing.
   *
   * The id itself lives in the app's state rather than in this component, because
   * it is part of the address: `#/history/<id>` names one note, and the app is
   * loaded with it when the page is opened at that address (`state.ts`). What this
   * component keeps is the *reading* of it — the entry, its audio, and which id the
   * two belong to — so that the screen that shows a note is still the only thing
   * that knows how to read one.
   */
  const openId = $derived($openNote)
  let openEntry = $state<HistoryEntry | null>(null)
  /** The note `openEntry` and `audioUrl` belong to, so "still reading" is a comparison, not a flag. */
  let loaded = $state<string | null>(null)
  let audioUrl = $state('')
  const loading = $derived(openId !== null && loaded !== openId)
  /** Selection mode, and the notes picked in it. */
  let selecting = $state(false)
  let chosen = $state<string[]>([])
  let confirming = $state(false)
  let renaming = $state<HistoryMeta | null>(null)

  onMount(() => {
    // Re-read rather than trust the store: another tab of this app may have filed
    // a note since this page was loaded, and `index.json` is the only thing that
    // knows.
    void loadHistory()
  })

  onDestroy(() => releaseAudio())

  function releaseAudio(): void {
    if (audioUrl) URL.revokeObjectURL(audioUrl)
    audioUrl = ''
  }

  /**
   * Reads one note: its words first, then its audio.
   *
   * `loaded` is written before the first `await`, so the effect below sees a note
   * as being read instead of asking for it again — and re-read after every one,
   * because opening another note while this one is still coming out of storage
   * must not be answered with the previous one's text.
   */
  async function load(id: string): Promise<void> {
    releaseAudio()
    openEntry = null
    loaded = id
    // Opening a note is the answer to its 新 badge.
    if ($historyFresh === id) historyFresh.set(null)
    const entry = await readEntry(id)
    if (!entry) {
      warn('storage', t('这条历史记录读不出来了（可能已被删除）'))
      // The address named a note that is not there any more, and the way out of it
      // is the one the screen underneath offers: the list, whose address is what
      // this puts back (`back.ts` closes the note's layer and consumes the entry
      // that named it). Only if this is still the note being read — a user who has
      // already opened another one is not asking for this one to be closed.
      if ($openNote === id) openNote.set(null)
      return
    }
    if ($openNote !== id) return
    openEntry = entry
    const blob = await readAudio(id)
    if (blob && $openNote === id) audioUrl = URL.createObjectURL(blob)
  }

  /**
   * The note the address names is the note that gets read.
   *
   * Watching the store rather than loading from the row's own onclick is what lets
   * a note be opened by something that never touched this component: a reload on
   * `#/history/<id>`, a link somebody sent, an address typed into the bar. The row
   * now does the only thing a row has to do — it changes the address — and the
   * screen follows, exactly as it does for the other screens.
   */
  $effect(() => {
    const id = $openNote
    if (!id) {
      releaseAudio()
      openEntry = null
      loaded = null
      return
    }
    if (loaded !== id) void load(id)
  })

  /**
   * The way out of a note: the list it came from.
   *
   * Which is now also the note's entry being given back, because the note carries
   * the address `#/history/<id>`: clearing the store releases its layer, and the
   * layer's entry is consumed by `back.ts` on the way out (see `reconcile`). The
   * audio URL is released by the effect above, which sees the same clearing.
   */
  function back(): void {
    openNote.set(null)
  }

  /**
   * A note that is open is a layer of the app's own back stack (`back.ts`), so the
   * phone's own back key leaves the note and lands on the list — the same `back()`
   * as the 返回 button beside the note's heading, because they are the same request.
   *
   * It is the one layer in the app that carries an address of its own rather than
   * inheriting the screen's: a note *is* an address, and it is the whole reason
   * `#/history/<id>` exists.
   */
  $effect(() => {
    if (!openId) return
    return openBackLayer(back, hashOf({ view: 'history', note: openId }))
  })

  function toggleSelecting(): void {
    selecting = !selecting
    if (!selecting) chosen = []
  }

  function toggle(id: string): void {
    chosen = chosen.includes(id) ? chosen.filter((item) => item !== id) : [...chosen, id]
  }

  /** Everything, or nothing — the second half of a phone's selection screen. */
  function toggleAll(): void {
    chosen = chosen.length === $historyList.length ? [] : $historyList.map((meta) => meta.id)
  }

  async function remove(ids: readonly string[]): Promise<void> {
    const opened = openId
    if (opened && ids.includes(opened)) back()
    await deleteEntries(ids)
    chosen = []
    selecting = false
    confirming = false
  }

  async function saveName(title: string): Promise<void> {
    const target = renaming
    renaming = null
    if (!target) return
    await renameEntry(target.id, title)
    if (openEntry?.id === target.id) openEntry = { ...openEntry, title: title.trim(), auto: false }
    showToast(t('已重命名'))
  }

  /** `m:ss`, and `h:mm:ss` once a note is that long. */
  function duration(seconds: number): string {
    const total = Math.max(0, Math.round(seconds))
    const pad = (n: number) => String(n).padStart(2, '0')
    const hours = Math.floor(total / 3600)
    return hours > 0
      ? `${hours}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
      : `${Math.floor(total / 60)}:${pad(total % 60)}`
  }

  /**
   * A row's second line: the facts that outlive a rename.
   *
   * A generated title *is* `日期 时间 · 定位`, so repeating those under it would
   * be the same three facts twice; a name someone typed says nothing about when
   * or where, and those are the two fields a rename keeps. So the date and the
   * place appear here exactly when the title no longer carries them.
   */
  function subtitle(meta: HistoryMeta): string {
    const bits: string[] = []
    if (!meta.auto) {
      bits.push(whenText(meta.at))
      if (meta.place) bits.push(meta.place)
    }
    bits.push(duration(meta.seconds))
    if (meta.audioBytes > 0) bits.push(formatBytes(meta.audioBytes))
    return bits.join(' · ')
  }
</script>

<div class="history">
  <header class="bar">
    <!--
      * The way back exists on the note, not on the list.
      *
      * A list of notes is not a screen anybody is stranded on: the logo in the
      * header opens the drawer, and the drawer is how every other destination is
      * reached. So a 返回 here was a control that had to remember where the list
      * was opened from — the start page's card, the drawer over a transcript, or
      * the pause panel that had just filed a note — and it got that wrong in the
      * one case a user could name, which is "the screen I was looking at". The
      * detail *does* keep it, and there 返回 means the one thing that is never
      * ambiguous: this list, where the user just came from.
      *
      * What replaces it is the small heading, which is what a screen with no way
      * back needs most: a word at the top saying where this is.
    -->
    {#if openId}
      <button class="rc-btn ghost small" onclick={back}>{tr('返回')}</button>
    {/if}

    <div class="head">
      <p class="heading">{openId ? tr('记录详情') : tr('历史记录')}</p>
      {#if !openId && $historyList.length}
        <span class="summary">
          {tr('共 {n} 条 · {size}', {
            n: $historyList.length,
            size: formatBytes(totalAudioBytes($historyList)),
          })}
        </span>
      {/if}
    </div>

    {#if !openId && $historyList.length > 0}
      <button class="rc-btn ghost small" onclick={toggleSelecting}>
        {selecting ? tr('完成') : tr('选择')}
      </button>
    {/if}
  </header>

  {#if !$historyPersistent}
    <p class="note">{tr('这个浏览器不能长期保存：这些记录关掉页面就没了。')}</p>
  {/if}

  {#if openId && openEntry}
    <!-- --------------------------------------------------------------- one note -->
    <div class="detail">
      <h2>{openEntry.title}</h2>
      <p class="facts">{subtitle(openEntry)}</p>

      {#if audioUrl}
        <!--
          * One row: the sound, and the file it came in.
          *
          * These were stacked — a player, and under it a link — which read as
          * two unrelated things that happened to sit together. They are one
          * thing, and side by side they say it: listen to it, or keep it. The
          * player takes whatever width is left and the button keeps its own, so
          * the row also gives the transcript back a line it was not using.
        -->
        <div class="media">
          <audio class="player" controls preload="metadata" src={audioUrl}></audio>
          <a
            class="rc-btn ghost small dl"
            href={audioUrl}
            download={`${openEntry.id}.wav`}
            title={tr('下载录音')}
          >
            <Glyph name="download" size={15} />
            <span class="dl-text">{tr('下载录音')}</span>
          </a>
        </div>
      {:else}
        <p class="facts">{tr('没有录音（记录时关闭了「保存整场录音」）')}</p>
      {/if}

      <div class="transcript">
        {#each openEntry.transcript as line, index (index)}
          <div class="pair">
            <p class="src">{line.text}</p>
            {#if line.translation}<p class="mt">{line.translation}</p>{/if}
          </div>
        {/each}
        {#if openEntry.transcript.length === 0}
          <p class="facts">{tr('这一场没有识别到文字')}</p>
        {/if}
      </div>

      <div class="row-actions">
        <button class="rc-btn ghost small" onclick={() => (renaming = openEntry)}>
          {tr('重命名')}
        </button>
        <button
          class="rc-btn ghost small danger"
          onclick={() => {
            if (!openEntry) return
            chosen = [openEntry.id]
            confirming = true
          }}
        >
          {tr('删除')}
        </button>
      </div>
    </div>
  {:else if openId && loading}
    <p class="facts pad">{tr('读取中…')}</p>
  {:else}
    <!-- ------------------------------------------------------------------ list -->
    <div class="list">
      {#each $historyList as meta (meta.id)}
        <div class="item">
          {#if selecting}
            <button
              class="check"
              class:on={chosen.includes(meta.id)}
              aria-pressed={chosen.includes(meta.id)}
              aria-label={tr('选择')}
              onclick={() => toggle(meta.id)}
            ></button>
          {/if}
          <button class="row" onclick={selecting ? () => toggle(meta.id) : () => openNote.set(meta.id)}>
            <span class="lines">
              <span class="title">{meta.title}</span>
              <span class="sub">{subtitle(meta)}</span>
            </span>
            {#if $historyFresh === meta.id}
              <span class="badge">{tr('新')}</span>
            {/if}
          </button>
        </div>
      {/each}

      {#if $historyReady && $historyList.length === 0}
        <p class="facts pad">{tr('还没有历史记录：录完一场，在暂停面板里点「保存」。')}</p>
      {/if}
      {#if !$historyReady}
        <p class="facts pad">{tr('读取中…')}</p>
      {/if}
    </div>
  {/if}
</div>

{#if selecting}
  <!-- The selection bar, at the bottom of the screen where a phone puts it. -->
  <div class="selectbar">
    <span class="picked">{tr('已选 {n} 条', { n: chosen.length })}</span>
    <button class="rc-btn ghost small" onclick={toggleAll}>
      {chosen.length === $historyList.length ? tr('取消全选') : tr('全选')}
    </button>
    <button
      class="rc-btn ghost small danger"
      disabled={chosen.length === 0}
      onclick={() => (confirming = true)}
    >
      {tr('删除')}
    </button>
  </div>
{/if}

{#if confirming}
  <Modal title={tr('删除历史记录')} onclose={() => (confirming = false)}>
    <p>
      {tr('删除 {n} 条记录？录音和文字都会一起删掉，删了找不回来。', { n: chosen.length })}
    </p>
    {#snippet footer()}
      <button class="rc-btn ghost" onclick={() => (confirming = false)}>{tr('取消')}</button>
      <button class="rc-btn accent" onclick={() => void remove(chosen)}>{tr('删除')}</button>
    {/snippet}
  </Modal>
{/if}

{#if renaming}
  <SaveNoteDialog
    heading={tr('重命名')}
    initial={renaming.title}
    when={whenText(renaming.at)}
    place={renaming.place}
    at={renaming.at}
    confirm={tr('重命名')}
    onsave={saveName}
    onclose={() => (renaming = null)}
  />
{/if}

<style>
  .history {
    height: 100%;
    overflow-y: auto;
    padding: 10px 14px calc(18px + env(safe-area-inset-bottom));
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--rc-line);
  }

  /* The heading and its footnote travel together and take the middle: the heading
     is what the screen is, the summary is how much of it there is, and the button
     at the end is what can be done to it. */
  .head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex: 1;
    min-width: 0;
  }

  /*
   * The small heading: 13 px, semibold, in the ink colour rather than the grey the
   * summary beside it is in. Small enough not to compete with a note's own title
   * (19 px, under it) and dark enough to be the thing the eye lands on first — a
   * screen that has no 返回 needs one line that says where it is.
   */
  .heading {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.4px;
    color: var(--rc-ink);
    white-space: nowrap;
  }

  .summary {
    font-size: 12px;
    color: var(--rc-ink-soft);
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .note {
    margin: 10px 0 0;
    padding: 8px 10px;
    border: 1px dashed var(--rc-line-strong);
    border-radius: var(--rc-radius);
    font-size: 12px;
    color: var(--rc-ink-soft);
  }

  /* ---------------------------------------------------------------- the list */

  .list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 0;
  }

  .item {
    display: flex;
    align-items: stretch;
    gap: 8px;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex: 1;
    min-width: 0;
    padding: 12px 14px;
    border: 2px solid var(--rc-line-strong);
    border-radius: var(--rc-radius);
    background: var(--rc-surface);
    color: var(--rc-ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
    box-shadow: var(--rc-shadow-hard);
  }

  .row:hover,
  .row:focus-visible {
    border-color: var(--rc-ink);
  }

  .lines {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .title {
    font-size: 15px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sub {
    font-size: 12px;
    color: var(--rc-ink-soft);
    font-variant-numeric: tabular-nums;
  }

  /* The badge the requirement asks for: the note filed a moment ago, and nothing
     else in the list. It is small, loud and temporary — see `historyFresh`. */
  .badge {
    flex: 0 0 auto;
    padding: 1px 8px;
    border-radius: var(--rc-radius-pill);
    background: var(--rc-accent);
    color: var(--rc-ink);
    font-size: 11px;
    font-weight: 700;
  }

  /* The selection tick: a square that fills with a mark, the way a phone's
     selection screen does it. */
  .check {
    flex: 0 0 auto;
    width: 30px;
    border: 2px solid var(--rc-line-strong);
    border-radius: var(--rc-radius);
    background: var(--rc-surface);
    cursor: pointer;
    position: relative;
  }

  .check.on {
    border-color: var(--rc-ink);
    background: var(--rc-accent);
  }

  .check.on::after {
    content: '✓';
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    font-weight: 700;
  }

  /* -------------------------------------------------------------- one note */

  .detail {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px 0;
  }

  .detail h2 {
    margin: 0;
    font-size: 19px;
    line-height: 1.3;
  }

  .facts {
    margin: 0;
    font-size: 12px;
    color: var(--rc-ink-soft);
    font-variant-numeric: tabular-nums;
  }

  .pad {
    padding: 16px 4px;
  }

  /*
   * The player and the download button, on one line.
   *
   * The browser draws everything inside an `<audio>`'s shadow root, so the only
   * parts of it this stylesheet can reach are the ones on the host: the frame. It
   * is given the frame the controls around it already wear — 2 px of ink-strong
   * outline, a rounded box, the recessed paper of an input — so the native widget
   * reads as one more control of this app rather than as a grey box the page
   * happens to contain.
   *
   * Three details, each for a reason the browser decides and not this file:
   *
   * - `border-radius` is the input's, not the buttons' pill. The player's own
   *   content is drawn edge to edge inside the host, and a 20 px curve on a 40 px
   *   box would clip the top and bottom of the play button at the ends of the bar.
   * - `overflow: hidden`, because that same content is a *square* panel and would
   *   otherwise poke its corners out through the curve.
   * - `flex: 1` with `width: 0` rather than a percentage: a native player refuses
   *   to shrink below its own controls' intrinsic width, and on a 320 px phone it
   *   has to. The floor is 140 px — a play button and a scrubber and no more — on
   *   the narrowest screen this app supports.
   */
  .media {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .player {
    flex: 1 1 auto;
    width: 0;
    min-width: 140px;
    height: 40px;
    padding: 0 2px;
    border: 2px solid var(--rc-line-strong);
    border-radius: var(--rc-radius);
    overflow: hidden;
    background: var(--rc-surface-alt);
    box-shadow: var(--rc-shadow-hard);
  }

  /*
   * The download button: the app's own pill (`.rc-btn ghost small`), with the
   * glyph it shares with the header's download and a word beside it. The word is
   * the important half — three icons in three places that all mean "the file"
   * would be a language of its own — and it is dropped only when there is no room
   * for it, where the icon and the link's own `title` still carry it.
   */
  .dl {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 34px;
    text-decoration: none;
  }

  @media (max-width: 400px) {
    .dl-text {
      display: none;
    }
  }

  .transcript {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  /* One sentence, two lines: what was said, and what it means. The pair travels
     together because either alone is the wrong half of a note. */
  .pair {
    border-left: 2px solid var(--rc-line);
    padding-left: 10px;
  }

  .pair .src {
    margin: 0;
    font-size: 15px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .pair .mt {
    margin: 2px 0 0;
    font-size: 13px;
    line-height: 1.5;
    color: var(--rc-ink-soft);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .row-actions {
    display: flex;
    gap: 8px;
  }

  .danger {
    color: var(--rc-danger);
  }

  /* --------------------------------------------------- the selection bar */

  .selectbar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 14px calc(10px + env(safe-area-inset-bottom));
    border-top: 2px solid var(--rc-line-strong);
    background: var(--rc-surface);
  }

  .picked {
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }

  @media (hover: hover) {
    .check:hover {
      border-color: var(--rc-ink);
    }
  }
</style>
