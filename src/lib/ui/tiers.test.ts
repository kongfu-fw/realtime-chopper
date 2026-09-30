import assert from 'node:assert/strict'
import test from 'node:test'
import { LINE_TIERS, RESERVED_LINES, reservedLines, tierOf } from './tiers.ts'

/**
 * The size ladder of the translation list, and the room each rung is allowed.
 *
 * Two things go wrong here on a phone, and both are *invisible in a screenshot*.
 * The first is a rung off by one: a line that is two translations old wearing the
 * newest size, so the reader looks at the wrong sentence. The second is the one
 * that made the list jump: a line whose block gets shorter or taller as it ages,
 * because the height it takes was decided by its font size. So the tests below
 * are about the ladder's *edges* (the newest line, the oldest, an index that no
 * longer exists) and about the space being stable between the two rungs a
 * sentence spends most of its life on.
 *
 * Node resolves ESM specifiers literally, hence the `.ts` extension above.
 */

test('the newest line wears the biggest size, and an older one the next', () => {
  assert.equal(tierOf(0, 1), 0)
  // Index 1 of 2 is the newest; index 0 is one older.
  assert.equal(tierOf(1, 2), 0)
  assert.equal(tierOf(0, 2), 1)
  assert.equal(tierOf(2, 3), 0)
  assert.equal(tierOf(1, 3), 1)
  assert.equal(tierOf(0, 3), 2)
})

test('everything older than the last rung stays on the last rung', () => {
  // A lesson is hundreds of lines long: the rungs must not keep going down past
  // the last size, and they must not wrap back to the top.
  assert.equal(tierOf(0, 4), LINE_TIERS - 1)
  assert.equal(tierOf(0, 400), LINE_TIERS - 1)
  assert.equal(tierOf(12, 400), LINE_TIERS - 1)
  assert.equal(tierOf(399, 400), 0)
  assert.equal(tierOf(398, 400), 1)
})

test('every line of every list length lands on a rung that exists', () => {
  // The stylesheet has exactly `LINE_TIERS` sizes; a class of `size-4` renders at
  // body size, which reads as a bug rather than as a smaller line.
  for (let count = 0; count <= 60; count += 1) {
    for (let index = 0; index <= count + 2; index += 1) {
      const tier = tierOf(index, count)
      assert.ok(
        Number.isInteger(tier) && tier >= 0 && tier < LINE_TIERS,
        `tierOf(${index}, ${count}) = ${tier}`,
      )
    }
  }
})

test('an index past the end of the list does not wrap around', () => {
  // A render can be one frame behind a list that just shrank (`lines` is replaced
  // wholesale), which is the only way this is reachable — and a negative age
  // through `Math.min` would put the *oldest* row on the biggest size.
  assert.equal(tierOf(3, 2), 0)
  assert.equal(tierOf(0, 0), 0)
})

test('the sizes and their reserved space are the same length', () => {
  // Adding a size without deciding how much room it keeps is how the list starts
  // jumping again, so the mismatch is a test failure rather than a surprise.
  assert.equal(RESERVED_LINES.length, LINE_TIERS)
})

test('the newest line reserves two lines of room, the rest one', () => {
  // Two lines for the newest: it is the sentence being read, it is the one that
  // arrives after the row already exists, and a row that grows from nothing is
  // what pushed the list up and down.
  assert.equal(reservedLines(0), 2)
  assert.equal(reservedLines(1), 1)
  assert.equal(reservedLines(LINE_TIERS - 1), 1)
  // Clamped, not `undefined`: an out-of-range rung must not reserve no room at
  // all. Past the end it lands on the smallest rung; below the start it lands on
  // the largest, which is the safe direction — reserving too much room never
  // moves a row, reserving too little is the bug this table exists to prevent.
  assert.equal(reservedLines(99), 1)
  assert.equal(reservedLines(-1), 2)
})

test('the two oldest rungs reserve the same room, so ageing cannot move a row', () => {
  // This is the property the jitter fix rests on: a sentence spends most of its
  // life going from the middle size to the small one, and if those two rungs
  // asked for different amounts of space, every new translation would resize
  // every older row — which is exactly the drop-and-push this replaces.
  assert.equal(reservedLines(1), reservedLines(LINE_TIERS - 1))
})
