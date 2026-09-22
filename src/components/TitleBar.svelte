<script lang="ts">
  import Logo from './Logo.svelte'
  import AboutChopper from './AboutChopper.svelte'
  import { session, logOpen, view } from '../lib/app/state'
  import { APP_NAME } from '../lib/brand/logo'
  import { moduleLangFor } from '../lib/asr/models'
  import { settings, setSetting, SOURCE_ORDER, TARGET_ORDER, LANG_LABEL } from '../lib/store/settings'
  import { info } from '../lib/log/store'
  import type { SourceLang, TargetLang } from '../lib/types'

  async function changeSource(lang: SourceLang) {
    if (lang === $settings.sourceLang) return
    // Chinese and Korean are served by the same module, so switching between
    // them must not throw it away — that would cost a full reload of the same
    // 240 MB the user already has in memory.
    const sameModule = moduleLangFor(lang) === moduleLangFor($settings.sourceLang)
    setSetting('sourceLang', lang)
    // Otherwise: one model at a time (memory budget), so drop the old engine
    // before the new language's module is requested.
    if (!sameModule) await session.releaseModel()
    info('ui', `识别语言切换为${LANG_LABEL[lang]}`, {
      note: sameModule ? '和上一个语言共用识别模块，不用重新加载' : '下次开始录音时会加载对应模块',
    })
  }

  function changeTarget(lang: TargetLang) {
    if (lang === $settings.targetLang) return
    setSetting('targetLang', lang)
    setSetting('voiceURI', '')
    info('ui', `译文语言切换为${LANG_LABEL[lang]}`)
  }

  /** The mascot (or the name beside it) opens the easter egg. */
  let about = $state(false)
</script>  <div class="titlebar">
    <!-- The language pair is centred by the grid, not by whatever happens to sit
         beside it, so this cell is sized by the grid and clipped if the window
         gets too narrow. -->
    <button
      type="button"
      class="brand"
      onclick={() => (about = true)}
      title={`关于${APP_NAME}`}
      aria-label={`关于${APP_NAME}`}
    >
      <Logo size={24} />
      <span class="name">{APP_NAME}</span>
    </button>

  <div class="langs" role="group" aria-label="语言选择">
    <label class="lang">
      <span class="lang-label">说</span>
      <select
        class="rc-select"
        value={$settings.sourceLang}
        onchange={(e) => changeSource((e.currentTarget as HTMLSelectElement).value as SourceLang)}
        aria-label="源语言"
      >
        {#each SOURCE_ORDER as lang (lang)}
          <option value={lang}>{LANG_LABEL[lang]}</option>
        {/each}
      </select>
    </label>
    <span class="arrow" aria-hidden="true">→</span>
    <label class="lang">
      <span class="lang-label">译</span>
      <select
        class="rc-select"
        value={$settings.targetLang}
        onchange={(e) => changeTarget((e.currentTarget as HTMLSelectElement).value as TargetLang)}
        aria-label="译文语言"
      >
        {#each TARGET_ORDER as lang (lang)}
          <option value={lang}>{LANG_LABEL[lang]}</option>
        {/each}
      </select>
    </label>
  </div>

  <div class="actions">
    <button
      class="rc-btn ghost small"
      onclick={() => view.set($view === 'settings' ? 'translate' : 'settings')}
      aria-label={$view === 'settings' ? '返回翻译' : '打开设置'}
    >
      {$view === 'settings' ? '← 返回' : '设置'}
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
        aria-label="打开日志与自检"
        title="日志与自检"
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
