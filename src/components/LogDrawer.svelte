<script lang="ts">
  import {
    session,
    logOpen,
    logNotice,
    runDiagnostics,
    selfCheckRunning,
    selfCheckReport,
    copyText,
  } from '../lib/app/state'
  import {
    entries,
    clearLogs,
    exportLogs,
    markRead,
    formatEntry,
    formatStamp,
    latestLogsText,
    COPY_TAIL,
  } from '../lib/log/store'
  import { buildBlocks, isBatch, isOpen, toggled, type Block } from '../lib/log/blocks'
  import type { LogEntry, LogLevel } from '../lib/types'

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

  const blocks = $derived(buildBlocks(visible))

  /**
   * What the user decided by hand, per block; the rest follows `defaultOpen`.
   *
   * The rules themselves live in `$lib/log/blocks`, where they are tested; this is
   * only the state they read.
   */
  let overrides = $state<Map<number, boolean>>(new Map())

  function toggleBlock(block: Block) {
    overrides = toggled(overrides, block)
  }

  function close() {
    logOpen.set(false)
  }

  /**
   * The one copy affordance, shared by the toolbar and every entry.
   *
   * `formatEntry` and `latestLogsText` come from the store rather than being
   * built here, so text copied from this drawer, from the export file and from
   * the install dialog are the same shape.
   */
  function copy(text: string, label: string) {
    void copyText(text, label)
  }

  function toggleDetail(id: number) {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    expanded = next
  }


  /**
   * How many lines "copy the latest" will actually carry.
   *
   * Shown next to the button instead of a hardcoded 20: a session that has just
   * started has three lines to give, and a button promising twenty is a button
   * that looks broken. */
  const tailCount = $derived(Math.min(COPY_TAIL, $entries.length))

  function download() {
    const text = exportLogs()
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `realtime-chopper-${formatStamp(Date.now()).replace(/[: ]/g, '-')}.log`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  let listEl = $state<HTMLDivElement | null>(null)
  /** Whether the list should keep following new lines, the way a terminal does. */
  let follow = $state(true)

  function onListScroll() {
    if (!listEl) return
    // "At the bottom" with a few pixels of slack: sub-pixel layout means the
    // difference is rarely exactly zero, and a strict test would silently turn
    // following off on the first scroll event.
    follow = listEl.scrollHeight - listEl.clientHeight - listEl.scrollTop <= 24
  }

  /**
   * Land on the tail, and stay there while the log grows.
   *
   * The line that explains a failure is the *last* one, and a log restored after a
   * crash can be three hundred lines deep — opening at the top shows the user the
   * beginning of a session that ended badly, which is the opposite of the answer
   * they came for. It also has to *keep* following: several more lines land
   * between the drawer opening and the page settling (startup, the crash, the
   * storage probe), and a one-shot jump ends up above them.
   *
   * Only while the user is still at the bottom, though — being yanked back down
   * while reading line 12 is worse than a stale scroll position.
   */
  $effect(() => {
    const total = $entries.length
    if (!$logOpen) {
      // Re-armed here rather than in `close()` so a drawer reopened after the user
      // scrolled up still starts at the tail.
      if (!follow) follow = true
      return
    }
    markRead()
    if (follow && listEl && total > 0) listEl.scrollTop = listEl.scrollHeight
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

    <!-- The one copy button that matters on a phone: no selecting, no scrolling,
         no filter to think about — just the tail that holds the failure. -->
    <div class="copybar">
      <button
        class="rc-btn small accent"
        disabled={tailCount === 0}
        onclick={() => copy(latestLogsText(), `已复制最新 ${tailCount} 条日志`)}
      >
        复制最新 {tailCount} 条
      </button>
      <span class="copyhint">日期时间 · 级别 · 环节 · 内容，可直接粘进消息里</span>
    </div>

    {#if $logNotice}
      <!-- Where the failure's own sentence lives now. It is rendered inside the
           drawer rather than over the app because the lines it talks about are
           right underneath it. -->
      <section class="notice" role="status">
        <div class="notice-head">
          <strong>{$logNotice.title}</strong>
          <span class="spacer"></span>
          <button class="rc-btn ghost small" aria-label="关闭这条说明" onclick={() => logNotice.set(null)}>✕</button>
        </div>
        <p>{$logNotice.body}</p>
        {#if $logNotice.retry}
          <button
            class="rc-btn accent small"
            onclick={() => {
              logNotice.set(null)
              logOpen.set(false)
              void session.start().catch(() => undefined)
            }}
          >
            现在再试一次
          </button>
        {/if}
      </section>
    {/if}

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

    <div class="list" bind:this={listEl} onscroll={onListScroll}>
      {#if visible.length === 0}
        <p class="empty">还没有日志。</p>
      {:else}
        {#each blocks as block (block.key)}
          {#if !isBatch(block)}
            {#each block.groups as group (group.entries[0].id)}
              {#each group.entries as entry (entry.id)}
                {@render entryRow(entry, true, true)}
              {/each}
            {/each}
          {:else}
            {@const multi = block.groups.length > 1}
            <!-- The heading carries what the folded lines would have said: when,
                 how many, and from which stages. A block holding a warning or an
                 error opens itself, because that is the line somebody came for. -->
            <button
              class="batch"
              class:warn={block.level === 'warn'}
              class:bad={block.level === 'error'}
              aria-expanded={isOpen(block, overrides)}
              onclick={() => toggleBlock(block)}
            >
              <span class="chev">{isOpen(block, overrides) ? '▾' : '▸'}</span>
              <span class="time">{formatStamp(block.ts)}</span>
              <span class="count">{block.size} 条</span>
              <span class="chips">
                {#each block.groups as group (group.entries[0].id)}
                  <span class="chip" class:ok={block.level === 'info'} class:warn={block.level === 'warn'} class:bad={block.level === 'error'}>{group.stage}×{group.entries.length}</span>
                {/each}
              </span>
              {#if block.hot}
                <span class="dot" class:warn={block.level === 'warn'} class:bad={block.level === 'error'}></span>
              {/if}
            </button>
            {#if isOpen(block, overrides)}
              <div class="batch-body">
                {#each block.groups as group (group.entries[0].id)}
                  {#if multi}
                    <div class="group-head"><span class="stage">{group.stage}</span> · {group.entries.length} 条</div>
                  {/if}
                  {#each group.entries as entry (entry.id)}
                    {@render entryRow(entry, false, !multi)}
                  {/each}
                {/each}
              </div>
            {/if}
          {/if}
        {/each}
      {/if}
    </div>

    <!-- One line, used both standalone and inside a batch. Inside a batch the time
         is in the heading, and the stage moves to its group heading when there is
         more than one stage — so the same fields are never printed twice. -->
    {#snippet entryRow(entry: LogEntry, showTime: boolean, showStage: boolean)}
      <article class="entry" class:has-detail={Boolean(entry.detail)}>
        <span class="dot" class:ok={entry.level === 'info'} class:warn={entry.level === 'warn'} class:bad={entry.level === 'error'} class:debug={entry.level === 'debug'}></span>
        <div class="entry-main">
          <div class="entry-head">
            {#if showTime}<span class="time">{formatStamp(entry.ts)}</span>{/if}
            {#if showStage}<span class="stage">{entry.stage}</span>{/if}
            {#if entry.detail}
              <button class="rc-btn ghost small" onclick={() => toggleDetail(entry.id)}>
                {expanded.has(entry.id) ? '收起' : '详情'}
              </button>
            {/if}
            <span class="spacer"></span>
            <button
              class="rc-btn ghost small"
              title="复制这一条"
              onclick={() => copy(formatEntry(entry), '已复制这一条')}
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
    {/snippet}
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

  .copybar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--rc-line);
    background: var(--rc-surface-alt);
  }

  .copyhint {
    font-size: 11px;
    color: var(--rc-ink-soft);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .notice {
    padding: 10px 14px;
    border-bottom: 2px solid var(--rc-line-strong);
    background: var(--rc-danger-soft);
  }

  .notice-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .notice p {
    margin: 6px 0 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--rc-ink-soft);
  }

  .notice .rc-btn {
    margin-top: 8px;
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

  /*
   * The heading of one second's batch. Everything a folded line would have said is
   * on this row — when, how many, and from which stages — so folding a burst does
   * not hide the fact that it happened.
   */
  .batch {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 14px;
    border: 0;
    border-bottom: 1px solid var(--rc-line);
    background: var(--rc-surface-alt);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .batch.warn {
    background: var(--rc-warn-soft);
  }

  .batch.bad {
    background: var(--rc-danger-soft);
  }

  .chev {
    font-size: 10px;
    color: var(--rc-ink-soft);
  }

  .count {
    font-size: 11px;
    color: var(--rc-ink-soft);
    white-space: nowrap;
  }

  .chips {
    display: flex;
    gap: 4px;
    min-width: 0;
    overflow: hidden;
  }

  .chip {
    font-family: var(--rc-mono);
    font-size: 10px;
    padding: 0 6px;
    border: 1px solid var(--rc-line-strong);
    border-radius: var(--rc-radius-pill);
    color: var(--rc-ink-soft);
    white-space: nowrap;
  }

  .batch-body .entry {
    padding-left: 26px;
  }

  /* The heading already closed this batch off; the last line must not repeat it. */
  .batch-body > .entry:last-child {
    border-bottom: 0;
  }

  .group-head {
    padding: 5px 14px 2px 26px;
    font-size: 10px;
    letter-spacing: 0.04em;
    color: var(--rc-ink-soft);
  }

  .time {
    font-family: var(--rc-mono);
    font-size: 11px;
    color: var(--rc-ink-soft);
    white-space: nowrap;
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
