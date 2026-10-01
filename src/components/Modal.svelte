<script lang="ts">
  import { onMount } from 'svelte'
  import type { Snippet } from 'svelte'
  import { openBackLayer } from '../lib/app/back'
  import { t } from '../lib/i18n/index.ts'

  interface Props {
    title: string
    /**
     * `reason` names *how* it was dismissed ("点关闭" / "点遮罩" / "按 Esc" /
     * "按返回键").
     *
     * A dialog that disappears without a word is unreadable from a log: when the
     * user reports "it just closed", the reason is the difference between a bug
     * and a stray tap on the backdrop — and on a phone that tap is very easy.
     */
    onclose?: (reason?: string) => void
    children: Snippet
    footer: Snippet
    wide?: boolean
  }

  let { title, onclose, children, footer, wide = false }: Props = $props()

  function onBackdrop(event: MouseEvent) {
    if (event.target === event.currentTarget) onclose?.(t('点遮罩'))
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') onclose?.(t('按 Esc'))
  }

  /**
   * Every dialog in the app is a layer of its own back stack, registered here
   * rather than in each of the six dialogs that exist.
   *
   * A dialog is the thing a back press is most obviously aimed at — it is the top
   * of the screen and there is a way out printed on it — so a phone's back key that
   * walked out of the app instead would be the one gesture a user would read as
   * the app being broken. On mount, because a `Modal` exists exactly while it is
   * open; the close goes through `onclose`, so the dialog's owner hears about the
   * back key the same way it hears about the ✕, the backdrop and Escape, with the
   * reason attached for the log.
   */
  onMount(() => openBackLayer(() => onclose?.(t('按返回键'))))
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="backdrop"
  role="presentation"
  onclick={onBackdrop}
  aria-hidden="false"
>
  <div class="modal" class:wide role="dialog" aria-modal="true" aria-label={title}>
    <h2>{title}</h2>
    <div class="body">
      {@render children()}
    </div>
    <div class="footer">
      {@render footer()}
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgb(29 45 53 / 42%);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    z-index: 50;
  }

  .modal {
    background: var(--rc-surface);
    border: 2px solid var(--rc-ink);
    border-radius: var(--rc-radius-l);
    box-shadow: var(--rc-shadow-pop);
    width: min(440px, 100%);
    max-height: 86vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .modal.wide {
    width: min(760px, 100%);
  }

  h2 {
    margin: 0;
    padding: 14px 18px 10px;
    font-size: 17px;
    border-bottom: 1px solid var(--rc-line);
  }

  .body {
    padding: 14px 18px;
    overflow-y: auto;
    font-size: 14px;
  }

  .footer {
    padding: 12px 18px 16px;
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    border-top: 1px solid var(--rc-line);
  }
</style>
