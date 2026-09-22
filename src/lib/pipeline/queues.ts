/**
 * The four pipeline stages (requirement 5) are connected by FIFO queues that
 * preserve arrival order end to end. Backpressure policy is fixed by decision:
 * **nothing is ever dropped automatically** (requirement 6 was accepted with
 * that consequence), so a queue only grows; the only way items leave early is
 * an explicit user action ("跳到最新").
 */
export class OrderedQueue<T> {
  private items: T[] = []
  private notify: (() => void) | null = null
  private closed = false
  /** Total items ever pushed, for diagnostics. */
  public pushed = 0

  constructor(readonly name: string) {}

  get size(): number {
    return this.items.length
  }

  get isClosed(): boolean {
    return this.closed
  }

  push(item: T): void {
    if (this.closed) return
    this.items.push(item)
    this.pushed++
    const n = this.notify
    this.notify = null
    n?.()
  }

  /** Resolves with the next item, or `null` once the queue is closed and drained. */
  async take(): Promise<T | null> {
    while (this.items.length === 0) {
      if (this.closed) return null
      await new Promise<void>((resolve) => {
        this.notify = resolve
      })
    }
    return this.items.shift() ?? null
  }

  /** Remove and return everything currently waiting (used by "跳到最新"). */
  drain(): T[] {
    const out = this.items
    this.items = []
    return out
  }

  snapshot(): T[] {
    return [...this.items]
  }

  close(): void {
    this.closed = true
    const n = this.notify
    this.notify = null
    n?.()
  }

  reopen(): void {
    this.closed = false
  }
}

/** A serial async worker pump: consumes one queue with a single in-flight job. */
export function pump<T>(
  queue: OrderedQueue<T>,
  handler: (item: T) => Promise<void>,
  onEmpty?: () => void,
): { stop: () => void } {
  let running = true
  void (async () => {
    while (running) {
      const item = await queue.take()
      if (item === null) break
      try {
        await handler(item)
      } catch {
        /* handler reports its own errors; the pump must never die */
      }
      if (queue.size === 0) onEmpty?.()
    }
  })()
  return {
    stop: () => {
      running = false
      queue.close()
    },
  }
}
