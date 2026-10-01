<script lang="ts">
  import { fade, fly } from 'svelte/transition'
  import Logo from './Logo.svelte'
  import AboutChopper from './AboutChopper.svelte'
  import { APP_VERSION } from '../lib/app/version'
  import { APP_NAME } from '../lib/brand/logo'
  import { navOpen, openHistory, openSettings, view } from '../lib/app/state'
  import { translator, uiLang } from '../lib/i18n/index.ts'

  /**
   * The list that slides out of the left edge, behind the logo.
   *
   * It exists because the app grew a second and third destination that had
   * nowhere to live. The title bar holds one button (设置) and the footer holds
   * two, and both of those corners are *thumb* real estate — a phone's bottom
   * corners are where the things pressed mid-lecture belong, and the record
   * button is one of them. Everything else — where do I put this phone down and
   * start again, what did I record yesterday, which build is this — is a question
   * asked *between* lessons, and this is where one belongs.
   *
   * The top row is the app itself, and pressing it goes home: the start page is
   * the one screen that knows how to begin anything, and a logo means "this app"
   * and therefore "the front of this app".
   *
   * The version sits at the bottom, where a version number belongs — out of the
   * way of the rows above it, and reachable the one time it is needed. It is also
   * where the mascot's easter egg moved: the title bar's logo now opens this
   * list, so the three taps that used to be the only door to the About panel
   * would have been triple taps on a navigation control. One tap on 版本号 opens
   * it, which is both easier to find and easier to explain.
   */

  const tr = $derived(translator($uiLang))

  let about = $state(false)

  function go(destination: 'start' | 'settings' | 'history' | 'translate'): void {
    navOpen.set(false)
    if (destination === 'settings') {
      openSettings()
      return
    }
    if (destination === 'history') {
      openHistory()
      return
    }
    if (destination === 'start') {
      view.set('start')
      return
    }
    // 开始翻译 *goes* to the translating screen and starts nothing.
    //
    // It used to start a session when the transcript was empty, which read well
    // in theory and badly in the hand: a menu row that sometimes begins recording
    // — through an install it might have to ask for, and a headphone question —
    // is a row nobody can predict, and its three neighbours here are all plain
    // destinations. Starting is what the record button and the start page's own
    // card are for, and both of them say so.
    view.set('translate')
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape' && $navOpen) navOpen.set(false)
  }}
/>

{#if $navOpen}
  <!-- The backdrop takes the fade and the panel takes the slide, which is what
       makes the list read as arriving from the edge rather than appearing. -->
  <div
    class="scrim"
    role="presentation"
    transition:fade={{ duration: 180 }}
    onclick={() => navOpen.set(false)}
  ></div>

  <nav class="drawer" transition:fly={{ x: -260, duration: 220 }} aria-label={tr('导航')}>
    <button class="row brand" onclick={() => go('start')}>
      <Logo size={30} />
      <span class="name">{APP_NAME}</span>
    </button>

    <button class="row" onclick={() => go('translate')}>{tr('开始翻译')}</button>
    <button class="row" onclick={() => go('history')}>{tr('历史记录')}</button>
    <button class="row" onclick={() => go('settings')}>{tr('设置')}</button>

    <div class="spacer"></div>

    <!--
      The list closes on the way in, and not only for tidiness: the mascot's
      panel is a `Modal`, the drawer sits above modals, and a dialog behind the
      thing that opened it is a dialog nobody can read.
    -->
    <button
      class="row version"
      onclick={() => {
        navOpen.set(false)
        about = true
      }}
    >
      <span>{tr('版本 {version}', { version: APP_VERSION })}</span>
      <span class="hint">{tr('关于')}</span>
    </button>
  </nav>
{/if}

{#if about}
  <AboutChopper onclose={() => (about = false)} />
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgb(29 45 53 / 38%);
    z-index: 60;
  }

  .drawer {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: min(258px, 78vw);
    /* Above the scrim, and above everything else except the easter egg. */
    z-index: 61;
    display: flex;
    flex-direction: column;
    padding: calc(14px + env(safe-area-inset-top)) 12px calc(14px + env(safe-area-inset-bottom));
    background: var(--rc-surface);
    border-right: 2px solid var(--rc-ink);
    box-shadow: var(--rc-shadow-pop);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 12px;
    border: 0;
    border-radius: var(--rc-radius);
    background: none;
    color: var(--rc-ink);
    font: inherit;
    font-size: 15px;
    text-align: left;
    cursor: pointer;
  }

  .row:hover,
  .row:focus-visible {
    background: var(--rc-surface-alt);
  }

  .brand {
    margin-bottom: 8px;
    padding: 6px 12px 14px;
    border-bottom: 1px solid var(--rc-line);
    border-radius: 0;
  }

  .name {
    font-size: 18px;
    font-weight: 700;
    letter-spacing: 0.3px;
  }

  /* Push the version to the bottom: it is not a destination, it is a footnote. */
  .spacer {
    flex: 1;
  }

  .version {
    justify-content: space-between;
    color: var(--rc-ink-soft);
    font-size: 13px;
  }

  .version .hint {
    font-size: 12px;
    opacity: 0.75;
  }
</style>
