<script lang="ts">
  import Logo from './Logo.svelte'
  import { headphoneAck, headphonePrompt, openSettings, session } from '../lib/app/state'
  import { settings, isLangInstalled, markModelInstalled } from '../lib/store/settings'
  import { ASR_MODULES, moduleIdFor } from '../lib/asr/models'
  import { warn } from '../lib/log/store'
  import { APP_NAME } from '../lib/brand/logo'
  import { t, translator, uiLang } from '../lib/i18n/index.ts'

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
   * Three things, top to bottom, and the middle one is the reason for the layout:
   * a recording can take a minute to become a recording (a 62 MB module on a
   * classroom's wifi, a permission prompt, a screen lock), and a start button that
   * turns into a spinner with no words is indistinguishable from one that did
   * nothing. So the loading has a *place*, reserved whether or not there is
   * anything to say in it, and the button stays where the thumb left it.
   *
   * The reserved height is what keeps the button still: 84 px, which is the
   * sentence plus the download bar plus the percentage at their tallest.
   */
  const { state: sessionState, stage, model, failure } = session

  let installing = $state(false)
  /** Something went wrong and the user needs to read a sentence about it. */
  let error = $state('')
  let busy = $state(false)

  const preparing = $derived($sessionState === 'preparing')

  /** The same readout the install dialog uses, from the same store. */
  const percent = $derived(
    $model?.progress !== undefined
      ? Math.round($model.progress * 100)
      : $model?.loadedBytes && $model?.totalBytes
        ? Math.round(($model.loadedBytes / $model.totalBytes) * 100)
        : null,
  )

  /** Bytes are in; the engine is being built, which reports no numbers at all. */
  const starting = $derived(percent !== null && percent >= 100)

  /**
   * What the reserved area is saying.
   *
   * Ordered by what the user should hear first: a failure, then the work that is
   * happening (two sources — this component's own install, and the session's
   * `stage`, and the install is the part with a percentage), and then *nothing*.
   *
   * It used to rest on 「戴上耳机，点下面开始」, and that sentence is gone. A line
   * that is always there is a line that stops being read, and the headphone check
   * is not this line's job anyway: it is the dialog a first run has to answer
   * before the microphone opens (`App.svelte`), and it says the same thing with a
   * button under it. What is left is the reserved height — which is the part with a
   * job: the button below stays exactly where the thumb left it while this area
   * fills up during a start.
   */
  const status = $derived.by(() => {
    if (error) return error
    if (installing) return tr('正在准备识别模块，第一次会慢一些')
    if ($stage) return $stage
    if ($sessionState === 'error') return $failure?.message ?? tr('启动失败，再试一次')
    return ''
  })

  /**
   * The one button, doing whatever the next step actually is.
   *
   * The install lives here rather than in the modal the footer opens, because a
   * cold start *is* the install: the modal exists to answer "the ribbon button needs
   * a module that is not here", and from this page that question has already been
   * asked and answered by the button the user just pressed.
   */
  async function begin(): Promise<void> {
    if (preparing) {
      // Same escape as the footer button: the microphone prompt is the one wait a
      // user can get out of.
      session.abortStart()
      return
    }
    if (busy || installing) return
    busy = true
    error = ''
    try {
      const lang = $settings.sourceLang
      if (!isLangInstalled(lang, $settings.installedModels)) {
        const module = moduleIdFor(lang)
        installing = true
        try {
          await session.prepare(module)
          markModelInstalled(module, ASR_MODULES[module].approxBytes, ASR_MODULES[module].version)
        } finally {
          installing = false
        }
      }
      if (!$headphoneAck) {
        // The same prompt the footer raises, and it is deliberately not a gate: a
        // browser cannot tell whether headphones are on.
        headphonePrompt.set(true)
        return
      }
      await session.start()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      error = message
      warn('session', t('启动失败：{message}', { message }))
    } finally {
      busy = false
    }
  }
</script>

<div class="start">
  <!-- The one door out of this page, and it has to be here: the language and the
       module the button below is about to load are both settings, and a cold
       launch with nothing installed would otherwise be a dead end. -->
  <button class="settings" onclick={openSettings}>{tr('设置')}</button>

  <div class="stack">
    <div class="brand">
      <Logo size={76} />
      <h1>{APP_NAME}</h1>
      <p class="tagline">{tr('实时翻译')}</p>
    </div>

    <div class="stage" role="status">
      <p class="line" class:bad={error !== ''}>{status}</p>
      {#if installing}
        <span class="bar" class:starting><i style={`width:${percent ?? 6}%`}></i></span>
        <span class="pct">{percent !== null ? `${percent}%` : tr('准备中')}</span>
      {/if}
    </div>

    <button
      class="rc-btn accent begin"
      disabled={$sessionState === 'stopping'}
      onclick={() => void begin()}
    >
      {preparing ? tr('取消启动') : error ? tr('再试一次') : tr('开始录音')}
    </button>
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
    gap: 22px;
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
   * The reserved middle: same height whether it holds a percentage, a sentence or
   * nothing, so the button below never moves under the thumb that is waiting on it.
   */
  .stage {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    gap: 8px;
    min-height: 84px;
    width: 100%;
  }

  .line {
    margin: 0;
    font-size: 14px;
    line-height: 1.5;
    color: var(--rc-ink-soft);
  }

  .line.bad {
    color: var(--rc-danger);
  }

  .bar {
    display: block;
    width: 180px;
    height: 10px;
    border: 1px solid var(--rc-line-strong);
    border-radius: var(--rc-radius-pill);
    overflow: hidden;
    background: var(--rc-surface-alt);
  }

  .bar i {
    display: block;
    height: 100%;
    background: var(--rc-accent);
    transition: width 200ms ease;
  }

  /* A full bar that has stopped moving is what "it froze" looks like: the bytes
     are in, the engine is still being built. */
  .bar.starting i {
    animation: rc-start-pulse 900ms ease-in-out infinite;
  }

  @keyframes rc-start-pulse {
    50% {
      opacity: 0.45;
    }
  }

  .pct {
    font-size: 12px;
    color: var(--rc-ink-soft);
    font-variant-numeric: tabular-nums;
  }

  /* The thumb target this whole page exists for. */
  .begin {
    min-width: 180px;
    padding: 12px 26px;
    font-size: 16px;
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
    .bar i {
      transition: none;
    }

    .bar.starting i {
      animation: none;
    }
  }
</style>
