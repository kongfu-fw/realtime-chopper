/**
 * The translation list's size ladder — which sentence is big, and how much room
 * each size is allowed to take.
 *
 * Both numbers live here, in one place, because the second one is what the list's
 * stability depends on and the stylesheet cannot be trusted to keep it in sync
 * with the first: `TranslationPanel` renders `size-{tierOf(…)}` and passes the
 * matching reserve in as a custom property, so a size added here without a
 * decision about its height is a test failure rather than a list that jumps.
 *
 * Not part of the component because it is pure arithmetic over two integers, and
 * the interesting cases are the ones a render never reaches on purpose: the
 * newest line, the oldest, and an index one frame behind a list that just shrank.
 */

/** How many sizes the list uses: newest, middle, and everything older. */
export const LINE_TIERS = 3

/**
 * Lines of vertical room each rung keeps, newest first.
 *
 * The newest rung keeps two, because it is the row that *changes*: it exists (as
 * an empty box) the moment a sentence is recognised, and its text lands a moment
 * later. Reserving only one line meant the row grew the instant a translation
 * arrived — taking the whole list up with it — and the reader had just been
 * looking at that spot.
 *
 * The two older rungs keep one line each, and *the same* one line. That equality
 * is the point: a sentence ages from the middle size to the small one while
 * nothing else about it changes, and if those rungs asked for different heights,
 * every new translation would resize every older row. The row height is otherwise
 * font-size-independent on purpose — see `--rc-line-lh` in `tokens.css`.
 */
export const RESERVED_LINES: readonly number[] = [2, 1, 1]

/**
 * Which rung a line wears, by how many translations have landed after it.
 *
 * Recency rather than age or length: the reader is looking for the sentence that
 * was just translated, and the rung has to hold still for every line whose
 * translation has already arrived — `count - 1 - index` only changes at the end
 * of the list, and only when a new line is appended.
 *
 * An index past the end of the list (a render one frame behind) has a negative
 * age, which is a line that is about to be the newest: it gets rung 0 rather than
 * a negative one.
 */
export function tierOf(index: number, count: number): number {
  const age = count - 1 - index
  if (age <= 0) return 0
  return Math.min(LINE_TIERS - 1, age)
}

/** How many lines of room `tier` reserves, clamped to a rung that exists. */
export function reservedLines(tier: number): number {
  const clamped = Math.min(RESERVED_LINES.length - 1, Math.max(0, Math.trunc(tier)))
  return RESERVED_LINES[clamped] ?? 1
}
