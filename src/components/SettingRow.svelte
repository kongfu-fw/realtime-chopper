<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    label: string
    /**
     * Optional. Something only needs explaining when the name does not already
     * say it; a row whose meaning is obvious gets no bubble at all rather than a
     * sentence of filler.
     */
    help?: string
    children: Snippet
  }

  let { label, help, children }: Props = $props()
  let open = $state(false)
</script>

<!--
  Requirement 10: names in plain language, explanations in a bubble. The help
  text is never shown inline, so the list stays scannable.
-->
<div class="row">
  <div class="label">
    <span class="text">{label}</span>
    {#if help}
      <button
        class="help"
        type="button"
        aria-label={`${label}的说明`}
        aria-expanded={open}
        onclick={() => (open = !open)}
      >
        ?
      </button>
      {#if open}
        <div class="bubble" role="tooltip">
          {help}
          <button class="close" type="button" onclick={() => (open = false)} aria-label="关闭说明">✕</button>
        </div>
      {/if}
    {/if}
  </div>
  <div class="control">
    {@render children()}
  </div>
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 0;
    border-bottom: 1px solid var(--rc-line);
  }

  .label {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1 1 auto;
    min-width: 0;
  }

  .text {
    font-size: 14px;
  }

  .help {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 1px solid var(--rc-line-strong);
    background: var(--rc-surface-alt);
    color: var(--rc-ink-soft);
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
    flex: 0 0 auto;
  }

  .bubble {
    position: absolute;
    z-index: 20;
    top: 26px;
    left: 0;
    width: min(320px, 76vw);
    background: var(--rc-ink);
    color: #fff;
    font-size: 12.5px;
    line-height: 1.5;
    padding: 10px 26px 10px 12px;
    border-radius: var(--rc-radius);
    box-shadow: var(--rc-shadow-pop);
  }

  .close {
    position: absolute;
    top: 6px;
    right: 6px;
    background: none;
    border: none;
    color: #fff;
    cursor: pointer;
    font-size: 11px;
    opacity: 0.7;
  }

  .control {
    flex: 0 0 auto;
    max-width: 55%;
    display: flex;
    align-items: center;
    gap: 6px;
    justify-content: flex-end;
  }
</style>
