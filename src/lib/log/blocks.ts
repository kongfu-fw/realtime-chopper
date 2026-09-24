import type { LogEntry, LogLevel, Stage } from '../types'

/**
 * How the log drawer groups lines, kept out of the Svelte component.
 *
 * Log lines arrive in bursts — one step of the pipeline reports several of them
 * inside the same second — and a flat list buries the line that explains the
 * failure under its own reporting. So one second's lines become a block whose
 * heading says how many, and from which stages, folded unless it is small or
 * carries a warning.
 *
 * It lives here, with no Svelte and no storage in it, because it is a rule rather
 * than a rendering detail: it decides what the user gets to see, and getting it
 * wrong is invisible until somebody is reading a report that quietly hides the
 * error inside a folded batch.
 */

/**
 * How many lines inside one second become a batch.
 *
 * Two is not a batch, it is a conversation: a heading, two stage headings and two
 * folds would be more chrome than the lines themselves. From three up it is one
 * step of the pipeline reporting itself, and a single heading says the same thing
 * more cheaply. So this decides *both* whether there is a heading and whether it
 * starts folded.
 */
export const BATCH_MIN = 3

/** One stage's consecutive lines inside a batch. */
export interface StageGroup {
  stage: Stage
  entries: LogEntry[]
}

/** One second's worth of lines, as the list renders them. */
export interface Block {
  /** The first entry's id: stable while the block is, and unique in the list. */
  key: number
  ts: number
  second: number
  /** Worst level inside, which is what the dot and the colour show. */
  level: LogLevel
  groups: StageGroup[]
  size: number
  /** Holds a warning or an error, so folding it away by default is not allowed. */
  hot: boolean
}

/**
 * Lines of the same second, in arrival order, split into runs of one stage.
 *
 * Grouped by *consecutive* stage, not by stage overall: the order is what shows
 * the path a failure took (capture → vad → asr → translate), and sorting by stage
 * name would destroy exactly the thing a report is examined for.
 */
export function buildBlocks(list: readonly LogEntry[]): Block[] {
  const blocks: Block[] = []
  for (const entry of list) {
    const second = Math.floor(entry.ts / 1000)
    let block = blocks[blocks.length - 1]
    if (!block || block.second !== second) {
      block = {
        key: entry.id,
        ts: entry.ts,
        second,
        level: entry.level,
        groups: [],
        size: 0,
        hot: false,
      }
      blocks.push(block)
    }
    const group = block.groups[block.groups.length - 1]
    if (group && group.stage === entry.stage) group.entries.push(entry)
    else block.groups.push({ stage: entry.stage, entries: [entry] })
    block.size += 1
    if (entry.level === 'error') block.level = 'error'
    else if (entry.level === 'warn' && block.level !== 'error') block.level = 'warn'
    if (entry.level === 'error' || entry.level === 'warn') block.hot = true
  }
  return blocks
}

/** Whether a block is big enough to be worth a heading of its own. */
export function isBatch(block: Block): boolean {
  return block.size >= BATCH_MIN
}

/**
 * Whether a block starts open.
 *
 * A batch folds itself, except when it carries a warning or an error — the one
 * thing in a log nobody is allowed to have to click for. Everything the folded
 * heading promises is still on the heading itself: when, how many, from where.
 */
export function defaultOpen(block: Block): boolean {
  return !isBatch(block) || block.hot
}

/**
 * What to render for one block, with the user's hand-made choice on top.
 *
 * The override is keyed by the block's *first* line, and that is what makes
 * folding usable where it is wanted: a batch that is folded by hand stays folded
 * while more lines land in it, because its identity does not move when it grows.
 * Keyed by the newest line instead, every arrival would pop the block open again.
 *
 * The same rule has one accepted cost: once the ring buffer drops the first line,
 * the block is a different block, so a hand-made choice is forgotten.
 */
export function isOpen(block: Block, overrides: ReadonlyMap<number, boolean>): boolean {
  return overrides.get(block.key) ?? defaultOpen(block)
}

/** `overrides` with this block flipped, as a new map (it is component state). */
export function toggled(overrides: ReadonlyMap<number, boolean>, block: Block): Map<number, boolean> {
  const next = new Map(overrides)
  next.set(block.key, !isOpen(block, overrides))
  return next
}
