<script lang="ts">
  import { logOpen, runDiagnostics, selfCheckRunning, selfCheckReport, copyText } from '../lib/app/state'
  import { entries, clearLogs, exportLogs, markRead } from '../lib/log/store'
  import type { LogLevel } from '../lib/types'

  let filter = $state<LogLevel | 'all'>('all')
  let expanded = $state<Set<number>>(new Set())

  const labels: Record<LogLevel | 'all', string> = {
    all: '全部',
    error: '错误',
    warn: '警告',
    info: '信息',
    debug: '调试',
  }

  const visible = $derived(
    filter === 'all' ? $entries : $entries.filter((entry) => entry.level === filter),
  )

  const counts = $derived({
    error: $entries.filter((e) => e.level === 'error').length,
    warn: $entries.filter((e) => e.level === 'warn').length,
  })

  function close() {
    logOpen.set(false)
  }

  function toggleDetail(id: number) {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    expanded = next
  }

  function stamp(ts: number): string {
    return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
  }

  function download() {
    const text = exportLogs()
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `realtime-chopper-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.log`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  $effect(() => {
    if ($logOpen) markRead()
  })
</script>

{#if $logOpen}
  <div class="scrim" role="presentation" onclick={close}></div>
  <!-- Requirement 18: slides in from the left, one copy button per entry. -->
  <aside class="drawer" aria-label="日志与自检">
    <header>
      <strong>日志</strong>
      {#if counts.error > 0}<span class="pill danger">{counts.error} 错误</span>{/if}
      {#if counts.warn > 0}<span class="pill warn">{counts.warn} 警告</span>{/if}
      <span class="spacer"></span>
      <button class="rc-btn ghost small" onclick={close} aria-label="关闭日志">✕</button>
    </header>

    <div class="actions">
      <select class="rc-select" value={filter} onchange={(e) => (filter = (e.currentTarget as HTMLSelectElement).value as LogLevel | 'all')}>
        {#each Object.entries(labels) as [key, text] (key)}
          <option value={key}>{text}</option>
        {/each}
      </select>
      <button class="rc-btn small" disabled={$selfCheckRunning} onclick={() => void runDiagnostics(false)}>
        {$selfCheckRunning ? '自检中…' : '运行自检'}
      </button>
      <button class="rc-btn ghost small" disabled={$selfCheckRunning} title="连发 5 次，看会不会被限流" onclick={() => void runDiagnostics(true)}>
        连发探测
      </button>
      <span class="spacer"></span>
      <button class="rc-btn ghost small" onclick={download}>导出</button>
      <button class="rc-btn ghost small" onclick={() => clearLogs()}>清空</button>
    </div>

    {#if $selfCheckReport}
      <section class="report">
        <div class="report-head">
          <strong>自检结果</strong>
          <button class="rc-btn ghost small" onclick={() => copyText($selfCheckReport!.results.map((r) => `${r.label}：${r.detail}`).join('\n'), '自检结果已复制')}>复制全部</button>
        </div>
        {#each $selfCheckReport.results as result, index (index)}
          <div class="report-row">
            <span class="dot" class:ok={result.ok === true} class:warn={result.ok === 'warn'} class:bad={result.ok === false}></span>
            <div>
              <div class="report-label">{result.label}</div>
              <div class="report-detail">{result.detail}</div>
            </div>
          </div>
        {/each}
      </section>
    {/if}

    <div class="list">
      {#if visible.length === 0}
        <p class="empty">还没有日志。</p>
      {:else}
        {#each visible as entry (entry.id)}
          <article class="entry" class:has-detail={Boolean(entry.detail)}>
            <span class="dot" class:ok={entry.level === 'info'} class:warn={entry.level === 'warn'} class:bad={entry.level === 'error'} class:debug={entry.level === 'debug'}></span>
            <div class="entry-main">
              <div class="entry-head">
                <span class="time">{stamp(entry.ts)}</span>
                <span class="stage">{entry.stage}</span>
                {#if entry.detail}
                  <button class="rc-btn ghost small" onclick={() => toggleDetail(entry.id)}>
                    {expanded.has(entry.id) ? '收起' : '详情'}
                  </button>
                {/if}
                <span class="spacer"></span>
                <button
                  class="rc-btn ghost small"
                  title="复制这一条"
                  onclick={() =>
                    copyText(
                      `${stamp(entry.ts)} [${entry.level}] [${entry.stage}] ${entry.message}${entry.detail ? `\n${entry.detail}` : ''}`,
                    )}
                >
                  复制
                </button>
              </div>
              <div class="entry-msg">{entry.message}</div>
              {#if entry.detail && expanded.has(entry.id)}
                <pre>{entry.detail}</pre>
              {/if}
            </div>
          </article>
        {/each}
      {/if}
    </div>
  </aside>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgb(29 45 53 / 32%);
    z-index: 40;
  }

  .drawer {
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    width: min(460px, 94vw);
    background: var(--rc-surface);
    border-right: 2px solid var(--rc-ink);
    z-index: 45;
    display: flex;
    flex-direction: column;
    animation: slide-in 180ms ease-out;
  }

  @keyframes slide-in {
    from {
      transform: translateX(-100%);
    }
  }

  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px;
    border-bottom: 2px solid var(--rc-ink);
  }

  .pill {
    font-size: 11px;
    border-radius: var(--rc-radius-pill);
    padding: 1px 8px;
    border: 1px solid var(--rc-line-strong);
  }

  .pill.danger {
    color: var(--rc-danger);
    border-color: var(--rc-danger);
    background: var(--rc-danger-soft);
  }

  .pill.warn {
    color: var(--rc-warn);
    border-color: var(--rc-warn);
    background: var(--rc-warn-soft);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--rc-line);
    flex-wrap: wrap;
  }

  .spacer {
    flex: 1 1 auto;
  }

  .report {
    padding: 10px 14px;
    border-bottom: 1px solid var(--rc-line);
    background: var(--rc-surface-alt);
    max-height: 34vh;
    overflow-y: auto;
  }

  .report-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }

  .report-row {
    display: flex;
    gap: 8px;
    padding: 3px 0;
  }

  .report-label {
    font-size: 12px;
    font-weight: 600;
  }

  .report-detail {
    font-size: 12px;
    color: var(--rc-ink-soft);
    word-break: break-word;
  }

  .list {
    flex: 1 1 auto;
    overflow-y: auto;
  }

  .entry {
    display: flex;
    gap: 8px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--rc-line);
  }

  .entry-main {
    flex: 1 1 auto;
    min-width: 0;
  }

  .entry-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--rc-ink-soft);
  }

  .stage {
    font-family: var(--rc-mono);
  }

  .entry-msg {
    font-size: 13px;
    word-break: break-word;
  }

  pre {
    margin: 4px 0 0;
    font-family: var(--rc-mono);
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--rc-ink-soft);
  }

  .dot {
    flex: 0 0 auto;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-top: 5px;
    background: var(--rc-line-strong);
  }

  .dot.ok {
    background: var(--rc-ok);
  }

  .dot.warn {
    background: var(--rc-warn);
  }

  .dot.bad {
    background: var(--rc-danger);
  }

  .dot.debug {
    background: var(--rc-line-strong);
  }
</style>
