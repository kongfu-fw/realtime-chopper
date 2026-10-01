<script lang="ts">
  import Logo from './Logo.svelte'
  import SessionClock from './SessionClock.svelte'
  import { closeSettings, logOpen, navOpen, openSettings, view } from '../lib/app/state'
  import { APP_NAME } from '../lib/brand/logo'
  import { settings } from '../lib/store/settings'
  import { translator, uiLang } from '../lib/i18n/index.ts'

  // Markup uses `tr`, so that changing the language re-renders it; script code
  // below uses `t`, which reads the language as it is at that moment.
  const tr = $derived(translator($uiLang))

  /**
   * The mascot opens the navigation drawer, and answers the tap with a wobble on
   * the way.
   *
   * What it used to be: one tap was a pat and *nothing else*, and the easter egg
   * cost three quick taps — which was right while the egg was the only thing
   * behind the mark, and wrong the moment the mark became a door. A logo in the
   * corner of an app means "this app", and pressing it means "take me to the
   * front of it" on almost every piece of software there is; the three taps are
   * gone, the whole egg moved into the drawer's 版本号 row, and what is left here
   * is one tap that opens one list.
   */
  const SHAKE_MS = 420
  let shake = $state(false)
  let shakeTimer: ReturnType<typeof setTimeout> | undefined

  /** Answers a tap with the wobble, restarting it if the previous one is still running. */
  function pat(): void {
    shake = true
    if (shakeTimer) clearTimeout(shakeTimer)
    shakeTimer = setTimeout(() => (shake = false), SHAKE_MS)
  }

  function onBrand(event: MouseEvent): void {
    // A keyboard activation arrives with `detail === 0` and has no wobble to
    // answer: Enter and Space open the list the same way a tap does.
    if (event.detail !== 0) pat()
    navOpen.set(!$navOpen)
  }
</script>

<div class="titlebar">
    <!-- The middle cell is the clock, and it is sized by the grid rather than by
         whatever happens to sit beside it: the brand on the left and the buttons
         on the right can each grow or shrink without moving it. -->
    <button
      type="button"
      class="brand"
      class:shake
      onclick={onBrand}
      aria-expanded={$navOpen}
      title={tr('打开导航')}
      aria-label={tr('打开导航')}
    >
      <Logo size={24} />
      <span class="name">{APP_NAME}</span>
    </button>

  <!--
    * The clock takes the middle of the header, and the language pair has moved
    * out of it — each half onto the panel it belongs to (`LangPicker`).
    *
    * A header is for the state of the whole app, and "what am I recording" and
    * "how long have I been recording" are that; "what goes in" and "what comes
    * out" are each one panel's business, and putting them here meant both panels
    * had a control that was nowhere near the text it governed.
    *
    * Only on the translate view: the timer is about a session, and the settings
    * screen is not part of one.
  -->
  {#if $view === 'translate'}
    <SessionClock />
  {/if}

  <div class="actions">
    <button
      class="rc-btn ghost small"
      onclick={() => ($view === 'settings' ? closeSettings() : openSettings())}
      aria-label={$view === 'settings' ? tr('返回') : tr('打开设置')}
    >
      {$view === 'settings' ? tr('← 返回') : tr('设置')}
    </button>

    <!--
      Requirement 18: the vertical ellipsis on the right opens the log drawer and
      the self-check. Both are diagnostics, so the button only exists in debug
      mode — a user who is just translating has no reason to open it, and the
      header should not offer what it does not need.
    -->
    {#if $settings.debugMode}
      <button
        class="rc-btn ghost dots"
        onclick={() => logOpen.set(true)}
        aria-label={tr('打开日志与自检')}
        title={tr('日志与自检')}
      >
        ⋮
      </button>
    {/if}
  </div>
</div>

<style>
  /*
   * Three cells, so the language pair is centred on the window rather than on
   * whatever happens to sit beside it. The side cells may shrink to nothing
   * (minmax(0, …)) — with plain `1fr` they refuse to go below their content's
   * width and push the header into a horizontal overflow on a narrow window.
   */
  .titlebar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: center;
    gap: 8px;
    width: 100%;
  }

  /* A button so it is reachable by keyboard and announced as clickable, but
     styled as plain text: the mark is the app's own name in the corner of its
     own window, and a boxed button there would read as one of the controls
     beside it rather than as the app itself. */
  .brand {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    overflow: hidden;
    color: var(--rc-ink);
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    cursor: pointer;
    border-radius: var(--rc-radius-s);
  }

  .brand :global(.mark) {
    transition: transform 120ms ease;
  }

  .brand:hover :global(.mark),
  .brand:focus-visible :global(.mark) {
    transform: scale(1.12) rotate(-4deg);
  }

  /*
   * The pat: a short wobble of the mascot, and nothing else happens. It is the
   * whole answer to a tap, which is what makes a tap feel like touching a
   * character rather than like a missed click — and what makes the difference
   * between one tap and three taps something the finger learns.
   */
  .brand.shake :global(.mark) {
    animation: rc-pat 420ms ease-in-out;
  }

  @keyframes rc-pat {
    0% {
      transform: none;
    }
    25% {
      transform: rotate(-11deg) scale(1.06);
    }
    55% {
      transform: rotate(9deg) scale(1.04);
    }
    80% {
      transform: rotate(-4deg);
    }
    100% {
      transform: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .brand.shake :global(.mark) {
      animation: none;
    }
  }

  .brand:focus-visible {
    outline: 2px solid var(--rc-accent);
    outline-offset: 3px;
  }

  .name {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.3px;
    white-space: nowrap;
  }

  .actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    /* "设置" must never break into two stacked glyphs. */
    white-space: nowrap;
  }

  /* Narrow window: the name would be clipped to a stub, so keep the deer and
     drop the word — the app is on screen, nobody needs to be told its name. */
  @media (max-width: 480px) {
    .name {
      display: none;
    }
  }

  .dots {
    font-size: 18px;
    line-height: 1;
    padding: 2px 10px;
    align-self: center;
  }
</style>
