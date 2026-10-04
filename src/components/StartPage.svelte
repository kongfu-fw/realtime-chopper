<script lang="ts">
  import Logo from './Logo.svelte'
  import { openHistory, openRecording, openSettings } from '../lib/app/state'
  import { historyList } from '../lib/history/store'
  import { APP_NAME } from '../lib/brand/logo'
  import { translator, uiLang } from '../lib/i18n/index.ts'

  const tr = $derived(translator($uiLang))

  /**
   * The page a cold launch opens on.
   *
   * Before this existed, the app opened straight into a transcript with an empty
   * 「点下面的按钮开始说话」 in it, a red button in the bottom-left corner and a
   * header full of language pickers — the screen a user had to interpret before
   * they could do the one thing they came to do. This page says the app's name,
   * says what it is doing, and offers one button.
   *
   * It used to *start* the session as well: the card downloaded the module, asked
   * the headphone question, and opened the microphone, with a reserved area in the
   * middle reporting the whole of that. By request it does none of that any more —
   * 开始录音 goes to the recording screen, and the record button there is what
   * starts. That move puts every start in one place: the same button, in the same
   * corner of the same screen, is what stops a session, resumes one and starts the
   * next, and the two entry points can no longer disagree about what a start is
   * (which is how the headphone question used to be answered differently depending
   * on which of them was pressed).
   *
   * The reserved middle is gone with the work it was reserving room for. Nothing
   * loads on this page now, so there is nothing to keep still: the two cards sit
   * where they are until they are pressed.
   */
</script>

<div class="start">
  <!-- The one door out of this page, and it has to be here: the language and the
       module the recording screen will load are both settings, and a cold launch
       with nothing configured would otherwise be a dead end. -->
  <button class="settings" onclick={openSettings}>{tr('设置')}</button>

  <div class="stack">
    <div class="brand">
      <Logo size={76} />
      <h1>{APP_NAME}</h1>
      <p class="tagline">{tr('录音笔记')}</p>
    </div>

    <!--
     * Two squares, not one pill: the app has two things to offer from a cold
     * start, and they are equals — record something, or read what was recorded
     * before. A second pill beside the first would have made 历史记录 look like a
     * lesser button, and this page only has room for two of anything.
     *
     * 开始录音 is a door, not a trigger: it changes the screen and nothing else.
     * The microphone, the module and the headphone question all belong to the
     * record button the user presses there — a deliberate second tap, and the one
     * the request asked for.
     -->
    <div class="cards">
      <button class="card begin" onclick={openRecording}>
        <span class="dot" aria-hidden="true"></span>
        <span class="card-label">{tr('开始录音')}</span>
      </button>

      <button class="card history" onclick={openHistory}>
        <span class="lines" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="card-label">{tr('历史记录')}</span>
        <span class="count">
          {$historyList.length ? tr('{n} 条记录', { n: $historyList.length }) : tr('还没有')}
        </span>
      </button>
    </div>
  </div>
</div>

<style>
  .start {
    position: relative;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    /*
     * Centred both ways, and the stack is centred *as a stack*: `align-items:
     * center` on a column would centre each child's box on its own width, which
     * left-aligns the words under a centred logo.
     */
    padding: 24px 20px calc(24px + env(safe-area-inset-bottom));
    background: var(--rc-bg);
  }

  .stack {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 26px;
    width: min(360px, 100%);
    text-align: center;
  }

  .brand {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
  }

  h1 {
    margin: 0;
    font-size: 26px;
    letter-spacing: 0.5px;
  }

  .tagline {
    margin: 0;
    font-size: 13px;
    color: var(--rc-ink-soft);
  }

  /*
   * Two squares. Square rather than a row of courses, because the page is read
   * top to bottom and a square is the shape a thumb finds without aiming — and
   * because two of them side by side fill the width the stack already has.
   *
   * `aspect-ratio` rather than a height, so the shape survives a narrow phone and
   * a wide desktop: 42vw of a 320 px screen is a square 134 px across, which is
   * still a comfortable target with one hand.
   */
  .cards {
    display: flex;
    justify-content: center;
    gap: 14px;
    width: 100%;
  }

  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    width: min(150px, 42vw);
    aspect-ratio: 1 / 1;
    padding: 10px;
    border: 2px solid var(--rc-ink);
    border-radius: var(--rc-radius-l);
    background: var(--rc-surface);
    color: var(--rc-ink);
    font: inherit;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: var(--rc-shadow-hard);
    transition: transform 80ms ease;
  }

  .card:hover {
    transform: translateY(-1px);
  }

  .card:active {
    transform: translateY(1px);
  }

  /* The recording mark: the same filled dot the footer's button wears at rest. */
  .card.begin {
    background: var(--rc-accent);
  }

  .dot {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--rc-danger);
  }

  /* 历史记录 reads as a list: three rules of different widths, which is what a
     transcript is — a stack of lines, not a picture. */
  .lines {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 26px;
  }

  .lines i {
    height: 3px;
    border-radius: 2px;
    background: var(--rc-ink-soft);
  }

  .lines i:nth-child(2) {
    width: 74%;
  }

  .lines i:nth-child(3) {
    width: 52%;
  }

  .card-label {
    font-size: 15px;
  }

  .count {
    font-size: 12px;
    font-weight: 500;
    color: var(--rc-ink-soft);
  }

  .settings {
    position: absolute;
    top: calc(10px + env(safe-area-inset-top));
    right: 12px;
    border: 0;
    background: none;
    color: var(--rc-ink-soft);
    font-size: 13px;
    padding: 6px 8px;
    cursor: pointer;
  }

  .settings:hover,
  .settings:focus-visible {
    color: var(--rc-ink);
  }

  @media (prefers-reduced-motion: reduce) {
    .card {
      transition: none;
    }
  }
</style>
