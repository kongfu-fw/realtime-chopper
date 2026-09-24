import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBlocks, defaultOpen, isBatch, isOpen, toggled } from './blocks.ts'
import type { LogEntry, LogLevel, Stage } from '../types.ts'

/**
 * The grouping rule the drawer renders, locked down.
 *
 * These are the cases that used to be decided by eye in a browser: what counts as
 * a batch, what a batch keeps from the lines it hides, and which batches may fold
 * themselves. A regression here is quiet by nature — the drawer still draws
 * something, it just hides the line somebody needed.
 *
 * Node resolves ESM specifiers literally, so the imports carry the `.ts` extension.
 */

/** One line, at a fixed second. */
function entry(id: number, second: number, stage: Stage, level: LogLevel = 'info', ms = 0): LogEntry {
  return { id, ts: second * 1000 + ms, level, stage, message: `第 ${id} 条` }
}

test('同一秒内的多行归成一块，跨秒就断开', () => {
  const blocks = buildBlocks([
    entry(1, 100, 'asr'),
    entry(2, 100, 'vad'),
    entry(3, 101, 'asr'),
    entry(4, 101, 'asr'),
  ])
  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks.map((b) => b.size), [2, 2])
  // The key is the first line of the block: it survives re-renders, and it is what
  // a hand-folded block is remembered by.
  assert.deepEqual(blocks.map((b) => b.key), [1, 3])
  assert.deepEqual(blocks.map((b) => b.second), [100, 101])
})

test('块的边界就是秒的边界，不看先后相差多少毫秒', () => {
  const blocks = buildBlocks([entry(1, 100, 'asr', 'info', 999), entry(2, 101, 'asr', 'info', 0)])
  assert.equal(blocks.length, 2)
})

test('同一秒两条不算批，三条起才算', () => {
  const two = buildBlocks([entry(1, 100, 'asr'), entry(2, 100, 'asr')])
  assert.equal(isBatch(two[0]), false)
  // Not a batch means no heading to fold, so the question of open or closed has
  // exactly one sensible answer.
  assert.equal(defaultOpen(two[0]), true)

  const three = buildBlocks([entry(1, 100, 'asr'), entry(2, 100, 'asr'), entry(3, 100, 'asr')])
  assert.equal(isBatch(three[0]), true)
  assert.equal(defaultOpen(three[0]), false)
})

test('批里按连续环节分组，不按环节归并', () => {
  const blocks = buildBlocks([
    entry(1, 100, 'capture'),
    entry(2, 100, 'vad'),
    entry(3, 100, 'capture'),
  ])
  // Three runs, not two groups: the order is the path the failure took.
  assert.deepEqual(blocks[0].groups.map((g) => g.stage), ['capture', 'vad', 'capture'])
  assert.deepEqual(blocks[0].groups.map((g) => g.entries.length), [1, 1, 1])

  const runs = buildBlocks([entry(1, 100, 'asr'), entry(2, 100, 'asr'), entry(3, 100, 'vad')])
  assert.deepEqual(runs[0].groups.map((g) => `${g.stage}×${g.entries.length}`), ['asr×2', 'vad×1'])
})

test('含警告或错误的批默认就是展开的', () => {
  const warned = buildBlocks([entry(1, 100, 'asr'), entry(2, 100, 'asr'), entry(3, 100, 'asr', 'warn')])
  assert.equal(warned[0].hot, true)
  assert.equal(warned[0].level, 'warn')
  assert.equal(defaultOpen(warned[0]), true)

  const failed = buildBlocks([entry(1, 100, 'asr'), entry(2, 100, 'asr'), entry(3, 100, 'asr', 'error')])
  assert.equal(defaultOpen(failed[0]), true)
})

test('批的等级取最坏的那一条', () => {
  const mixed = buildBlocks([
    entry(1, 100, 'asr'),
    entry(2, 100, 'asr', 'warn'),
    entry(3, 100, 'asr'),
    entry(4, 100, 'asr', 'error'),
    entry(5, 100, 'asr', 'warn'),
  ])
  assert.equal(mixed[0].level, 'error')
  assert.equal(mixed[0].hot, true)
})

test('折叠不会丢行，也不会改顺序', () => {
  const list = [
    entry(1, 100, 'asr'),
    entry(2, 100, 'vad'),
    entry(3, 100, 'asr'),
    entry(4, 101, 'tts'),
  ]
  const flattened = buildBlocks(list).flatMap((b) => b.groups.flatMap((g) => g.entries))
  assert.deepEqual(flattened, list)
})

test('没有日志就没有块', () => {
  assert.deepEqual(buildBlocks([]), [])
})

test('手动展开过的批，后面再来的行不会把它顶开', () => {
  const before = buildBlocks([entry(1, 100, 'asr'), entry(2, 100, 'asr'), entry(3, 100, 'asr')])
  assert.equal(isOpen(before[0], new Map()), false)
  const opened = toggled(new Map(), before[0])
  assert.equal(isOpen(before[0], opened), true)

  // The same batch, one line longer: the block is still the block it was, so the
  // choice still applies.
  const after = buildBlocks([
    entry(1, 100, 'asr'),
    entry(2, 100, 'asr'),
    entry(3, 100, 'asr'),
    entry(4, 100, 'asr'),
  ])
  assert.equal(after[0].key, before[0].key)
  assert.equal(isOpen(after[0], opened), true)
})

test('手动状态只属于那一批', () => {
  const blocks = buildBlocks([
    entry(1, 100, 'asr'),
    entry(2, 100, 'asr'),
    entry(3, 100, 'asr'),
    entry(4, 101, 'asr'),
    entry(5, 101, 'asr'),
    entry(6, 101, 'asr'),
  ])
  const opened = toggled(new Map(), blocks[0])
  assert.equal(isOpen(blocks[0], opened), true)
  assert.equal(isOpen(blocks[1], opened), false)
})

test('手动折叠一个带警告的批：人说了算，但只到第一条被挤掉为止', () => {
  const warned = buildBlocks([entry(1, 100, 'asr', 'warn'), entry(2, 100, 'asr'), entry(3, 100, 'asr')])
  assert.equal(isOpen(warned[0], new Map()), true)
  const closed = toggled(new Map(), warned[0])
  assert.equal(isOpen(warned[0], closed), false)

  // The ring buffer dropping the first line makes it a different block, so the
  // hand-made choice is forgotten and the rule takes over again.
  const trimmed = buildBlocks([entry(2, 100, 'asr'), entry(3, 100, 'asr'), entry(4, 100, 'asr')])
  assert.equal(trimmed[0].key, 2)
  assert.equal(isOpen(trimmed[0], closed), false)
  assert.equal(defaultOpen(trimmed[0]), false)
})
