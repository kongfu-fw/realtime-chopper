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
  const { state: sessionState, level, notice, queues, stage } = session

  let busy = $state(false)

  const recording = $derived($sessionState === 'recording')
  const preparing = $derived($sessionState === 'preparing' || $sessionState === 'stopping')
  const lagging = $derived($queues.lagSeconds > 8)

  /**
   * The live input level, as the fraction the ring on the button consumes.
   *
   * The raw level is a small number: the horizontal meter this replaced turned it
   * into a percentage with `* 320` (`* 3.2` over 0..100), so the same factor is
   * applied here and the meter answers to exactly the loudness it always did.
   */
  const meterLevel = $derived(Math.min(1, Math.max(0, ($level || 0) * 3.2)).toFixed(3))

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

<div class="left">
  {#if preparing}
    <!-- The real phase, not a guess: loading the module, probing the translator
         and warming up the microphone are three different waits. -->
    <span class="hint">{$stage || tr('浏览器问权限时点「允许」')}</span>
  {/if}
  {#if $notice}
    <span class="hint warn" title={$notice}>{$notice}</span>
  {/if}
</div>

<!--
 * The input level is drawn *on* the button: a halo that grows with the voice,
 * inside a fixed ring that marks full scale. "It is recording" and "it can hear
 * me" are then one look at one place, instead of two readings on either side of
 * the bar.
 -->
<button
  class="record-btn"
  class:recording
  style={`--level:${meterLevel}`}
  onclick={toggle}
  aria-label={recording ? tr('停止录音') : preparing ? tr('取消启动') : tr('开始录音')}
  title={recording ? tr('停止录音') : preparing ? tr('取消启动') : tr('开始录音')}
  disabled={$sessionState === 'stopping'}
>
  {#if preparing}
    <span class="spinner" aria-hidden="true"></span>
  {:else if recording}
    <span class="square" aria-hidden="true"></span>
  {:else}
    <span class="dot" aria-hidden="true"></span>
  {/if}
</button>

<div class="right">
  {#if lagging}
    <!-- The only path in the app that discards queued speech, and it only
         happens when the user asks for it. -->
    <button class="rc-btn small accent" onclick={() => session.skipToLatest()}>
      {tr('跳到最新（落后 {sec} 秒）', { sec: $queues.lagSeconds.toFixed(0) })}
    </button>
  {/if}
</div>

{#if $installLang}
  <ModelInstallModal want={$installLang} ondone={onInstallDone} oncancel={onInstallCancel} />
{/if}

<style>
  .left,
  .right {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--rc-ink-soft);
    min-width: 0;
  }

  /*
   * The hints moved to the left column, which is the one the level meter used to
   * occupy. `min-width: 0` on the containers is what lets a long notice ellipsise
   * instead of pushing the button off centre: the footer is a `1fr auto 1fr` grid,
   * and a grid item's automatic minimum size would otherwise be its full text.
   */
  .left {
    justify-content: flex-start;
  }

  .right {
    justify-content: flex-end;
  }

  .hint {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }

  .hint.warn {
    color: var(--rc-warn);
    font-weight: 600;
  }

  .dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #fff;
  }

  .square {
    width: 14px;
    height: 14px;
    background: #fff;
    border-radius: 2px;
  }

  .spinner {
    width: 16px;
    height: 16px;
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
</style>
