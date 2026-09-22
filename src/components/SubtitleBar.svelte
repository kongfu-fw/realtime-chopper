<script lang="ts">
  import { session } from '../lib/app/state'

  // Svelte's `$` prefix treats the *identifier* as the store, so member stores
  // are pulled out into locals first.
  const { queues, rate } = session

  const format = (seconds: number) => (seconds >= 10 ? `${seconds.toFixed(0)}s` : `${seconds.toFixed(1)}s`)
</script>

<!-- Requirement 20: one line showing how much work is waiting at each stage. -->
<div class="subtitle" role="status" aria-label="流水线状态">
  <span class="chip" title="还没识别的">识别 <b>{$queues.seg}</b></span>
  <span class="chip" title="还没翻译的">翻译 <b>{$queues.mt}</b></span>
  <span class="chip" title="还没读的">朗读 <b>{$queues.tts}</b></span>
  {#if $queues.failed > 0}
    <span class="chip danger" title="翻译失败的，点译文可以重试">失败 <b>{$queues.failed}</b></span>
  {/if}
  <span class="chip" class:lagging={$queues.lagSeconds > 8} title="朗读落后了多久">
    滞后 <b>{format($queues.lagSeconds)}</b>
  </span>
  {#if $rate > 1.001}
    <span class="chip accent" title="正在自动加速">语速 <b>{$rate.toFixed(2)}x</b></span>
  {/if}
</div>

<style>
  .subtitle {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    min-height: var(--rc-subtitle-h);
    background: var(--rc-surface-alt);
    border-bottom: 2px solid var(--rc-ink);
    overflow-x: auto;
    white-space: nowrap;
  }

  .chip {
    font-size: 12px;
    color: var(--rc-ink-soft);
    background: var(--rc-surface);
    border: 1px solid var(--rc-line-strong);
    border-radius: var(--rc-radius-pill);
    padding: 1px 9px;
    font-variant-numeric: tabular-nums;
  }

  .chip b {
    color: var(--rc-ink);
  }

  .chip.danger {
    border-color: var(--rc-danger);
    background: var(--rc-danger-soft);
  }

  .chip.lagging {
    border-color: var(--rc-warn);
    background: var(--rc-warn-soft);
  }

  .chip.accent {
    border-color: var(--rc-accent);
    background: var(--rc-accent-soft);
  }
</style>
