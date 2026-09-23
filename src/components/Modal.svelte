<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    title: string
    /**
     * `reason` names *how* it was dismissed ("点关闭" / "点遮罩" / "按 Esc").
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
    if (event.target === event.currentTarget) onclose?.('点遮罩')
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') onclose?.('按 Esc')
  }
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
