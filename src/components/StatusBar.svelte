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
  import ModelInstallModal from './ModelInstallModal.svelte'

  // `state` is renamed on destructuring: a local called `state` would collide
  // with the `$state` rune.
  const { state: sessionState, level, notice, queues, stage } = session

  let busy = $state(false)

  const recording = $derived($sessionState === 'recording')
  const preparing = $derived($sessionState === 'preparing' || $sessionState === 'stopping')
  const lagging = $derived($queues.lagSeconds > 8)

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
      warn('ui', `操作失败：${message}`)
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

  function onInstallCancel(reason = '未知') {
    installLang.set(null)
    // The reason matters: on a phone a tap on the backdrop closes this dialog
    // just as easily as the close button, and "cancelled" with no reason reads
    // like the install failed on its own.
    info('storage', `已取消安装识别模块（${reason}）`)
  }
</script>

<div class="left">
  {#if recording}
    <span class="level" aria-hidden="true">
      <i style={`width:${Math.min(100, Math.round(($level || 0) * 320))}%`}></i>
    </span>
  {/if}
</div>

<button
  class="record-btn"
  class:recording
  onclick={toggle}
  aria-label={recording ? '停止录音' : preparing ? '取消启动' : '开始录音'}
  title={recording ? '停止录音' : preparing ? '取消启动' : '开始录音'}
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
  {#if preparing}
    <!-- The real phase, not a guess: loading the module, probing the translator
         and warming up the microphone are three different waits. -->
    <span class="hint">{$stage || '浏览器问权限时点「允许」'}</span>
  {/if}
  {#if $notice}
    <span class="hint warn" title={$notice}>{$notice}</span>
  {/if}
  {#if lagging}
    <!-- The only path in the app that discards queued speech, and it only
         happens when the user asks for it. -->
    <button class="rc-btn small accent" onclick={() => session.skipToLatest()}>
      跳到最新（落后 {$queues.lagSeconds.toFixed(0)} 秒）
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

  .right {
    justify-content: flex-end;
  }

  .hint {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 26vw;
  }

  .hint.warn {
    color: var(--rc-warn);
    font-weight: 600;
  }

  .level {
    display: block;
    width: 56px;
    height: 8px;
    border: 1px solid var(--rc-line-strong);
    border-radius: var(--rc-radius-pill);
    overflow: hidden;
    background: var(--rc-surface-alt);
  }

  .level i {
    display: block;
    height: 100%;
    background: var(--rc-ok);
    transition: width 90ms linear;
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
