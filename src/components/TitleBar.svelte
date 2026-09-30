<script lang="ts">
  import Logo from './Logo.svelte'
  import AboutChopper from './AboutChopper.svelte'
  import { session, logOpen, view } from '../lib/app/state'
  import { APP_NAME } from '../lib/brand/logo'
  import { settings, setSetting, SOURCE_ORDER, TARGET_ORDER, langLabel } from '../lib/store/settings'
  import { info } from '../lib/log/store'
  import { t, translator, uiLang } from '../lib/i18n/index.ts'
  import type { SourceLang, TargetLang } from '../lib/types'

  // Markup uses `tr`, so that changing the language re-renders it; script code
  // below uses `t`, which reads the language as it is at that moment.
  const tr = $derived(translator($uiLang))

  async function changeSource(lang: SourceLang) {
    if (lang === $settings.sourceLang) return
    // Every language has its own module now, so a language switch is always a
    // module switch — and one model at a time is the memory budget: drop the old
    // engine before the new language's module is requested.
    //
    // This used to be conditional. Korean rode on the Chinese module, so zh → ko
    // had to leave the engine alone rather than throw away the very bytes that
    // answer Korean. With a Korean module of its own that reasoning is gone, and
    // leaving the deleted condition behind would have kept a model that can no
    // longer answer the chosen language.
    setSetting('sourceLang', lang)
    await session.releaseModel()
    info('ui', t('识别语言切换为{lang}', { lang: langLabel(lang) }), {
      note: t('下次开始录音时会加载对应模块'),
    })
  }

  function changeTarget(lang: TargetLang) {
    if (lang === $settings.targetLang) return
    setSetting('targetLang', lang)
    setSetting('voiceURI', '')
    info('ui', t('译文语言切换为{lang}', { lang: langLabel(lang) }))
  }

  /**
   * The mascot: one tap is a pat, three quick taps open the easter egg.
   *
   * It used to open on any click, which is the wrong door for something that sits
   * in the corner of the window a person touches all day: one stray tap and the app
   * leaves the screen. Now a tap is answered with a wobble and nothing else, and
   * the egg costs the three taps a phone game would ask for.
   */
  const TAP_WINDOW_MS = 600
  const SHAKE_MS = 420
  const TAPS_FOR_EGG = 3
  let about = $state(false)
  let shake = $state(false)
  let taps = 0
  let tapTimer: ReturnType<typeof setTimeout> | undefined
  let shakeTimer: ReturnType<typeof setTimeout> | undefined

  /** Answers a tap with the wobble, restarting it if the previous one is still running. */
  function pat(): void {
    shake = true
    if (shakeTimer) clearTimeout(shakeTimer)
    shakeTimer = setTimeout(() => (shake = false), SHAKE_MS)
  }

  function onBrand(event: MouseEvent): void {
    // A keyboard activation arrives with `detail === 0`, and it cannot come three
    // times in a row — the egg is the only thing behind this button, so Enter (or
    // Space) opens it directly rather than leaving the keyboard without a door.
    if (event.detail === 0) {
      about = true
      return
    }
    pat()
    taps += 1
    if (tapTimer) clearTimeout(tapTimer)
    if (taps >= TAPS_FOR_EGG) {
      taps = 0
      about = true
      return
    }
    // Each tap restarts the window, so "three quick taps" is measured between
    // taps rather than from the first one.
    tapTimer = setTimeout(() => (taps = 0), TAP_WINDOW_MS)
  }
</script>  <div class="titlebar">
    <!-- The language pair is centred by the grid, not by whatever happens to sit
         beside it, so this cell is sized by the grid and clipped if the window
         gets too narrow. -->
    <button
      type="button"
      class="brand"
      class:shake
      onclick={onBrand}
      title={tr('关于{name}', { name: APP_NAME })}
      aria-label={tr('关于{name}', { name: APP_NAME })}
    >
      <Logo size={24} />
      <span class="name">{APP_NAME}</span>
    </button>

  <div class="langs" role="group" aria-label={tr('语言选择')}>
    <label class="lang">
      <span class="lang-label">{tr('说')}</span>
      <select
        class="rc-select"
        value={$settings.sourceLang}
        onchange={(e) => changeSource((e.currentTarget as HTMLSelectElement).value as SourceLang)}
        aria-label={tr('源语言')}
      >
        {#each SOURCE_ORDER as lang (lang)}
          <option value={lang}>{langLabel(lang, $uiLang)}</option>
        {/each}
      </select>
    </label>
    <span class="arrow" aria-hidden="true">→</span>
    <label class="lang">
      <span class="lang-label">{tr('译')}</span>
      <select
        class="rc-select"
        value={$settings.targetLang}
        onchange={(e) => changeTarget((e.currentTarget as HTMLSelectElement).value as TargetLang)}
        aria-label={tr('译文语言')}
      >
        {#each TARGET_ORDER as lang (lang)}
          <option value={lang}>{langLabel(lang, $uiLang)}</option>
        {/each}
      </select>
    </label>
  </div>

  <div class="actions">
    <button
      class="rc-btn ghost small"
      onclick={() => view.set($view === 'settings' ? 'translate' : 'settings')}
      aria-label={$view === 'settings' ? tr('返回翻译') : tr('打开设置')}
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

<!-- Rendered outside the header's grid so the panel can never be squeezed by
     it; the backdrop is fixed, so it sits over the app either way. -->
{#if about}
  <AboutChopper onclose={() => (about = false)} />
{/if}

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
     styled as plain text — an easter egg should not look like a control. */
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

  .langs {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .lang {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .lang-label {
    font-size: 12px;
    color: var(--rc-ink-soft);
  }

  .arrow {
    color: var(--rc-ink-soft);
  }

  .actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    /* "设置" must never break into two stacked glyphs. */
    white-space: nowrap;
  }

  /* Narrow window: "说 英文 → 译 中文" is self-explanatory without the verbs. */
  @media (max-width: 560px) {
    .lang-label {
      display: none;
    }
  }

  /* Narrower still: the name would be clipped to a stub, so keep the deer and
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
