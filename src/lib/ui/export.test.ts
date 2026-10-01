import assert from 'node:assert/strict'
import test from 'node:test'
import { exportFileName, transcriptText } from './export.ts'

/**
 * Exporting a transcript to a file, as pure text.
 *
 * Written before the code, so the rules are the ones a user would state rather
 * than the ones the implementation happens to have. The ways this goes wrong:
 *
 * - exporting a *placeholders* view: a line whose translation has not arrived
 *   yet must not put an empty row (or the word “翻译中”) into the file;
 * - exporting the wrong column: the original-text button and the translation
 *   button sit in different panels and must produce different files;
 * - a file whose name sorts nowhere: the timestamp is why two exports from one
 *   lesson can both be kept;
 * - a line that arrives with its own newline (a paste, a model's output) must
 *   not break the one-sentence-per-line shape.
 */

const lines = [
  { text: 'Good morning.', translation: '早上好。' },
  { text: 'Today we will look at chapter three.', translation: '' },
  { text: 'Please open your books.', translation: '请打开书。' },
]

test('the original text exports the recognised sentences, in order', () => {
  assert.equal(
    transcriptText(lines, 'original'),
    'Good morning.\nToday we will look at chapter three.\nPlease open your books.\n',
  )
})

test('the translation exports only the sentences that were translated', () => {
  assert.equal(transcriptText(lines, 'translation'), '早上好。\n请打开书。\n')
})

test('a sentence that never arrived is not a blank row', () => {
  const withGaps = [
    { text: '', translation: '好的。' },
    { text: '   ', translation: '   ' },
    { text: 'Right.', translation: '对。' },
  ]
  assert.equal(transcriptText(withGaps, 'original'), 'Right.\n')
  assert.equal(transcriptText(withGaps, 'translation'), '好的。\n对。\n')
})

test('a multi-line sentence keeps one entry per sentence', () => {
  const wrapped = [{ text: 'one\n  two', translation: '' }]
  assert.equal(transcriptText(wrapped, 'original'), 'one\n  two\n')
})

test('nothing recorded exports nothing, not an empty file with a header', () => {
  assert.equal(transcriptText([], 'original'), '')
  assert.equal(transcriptText([], 'translation'), '')
})

test('the file name says which half of the transcript it holds, and when', () => {
  // Local time on purpose: a file named for the moment its author exported it.
  const at = new Date(2026, 8, 30, 9, 5)
  assert.equal(exportFileName('original', at), 'realtime-chopper-original-20260930-0905.txt')
  assert.equal(exportFileName('translation', at), 'realtime-chopper-translation-20260930-0905.txt')
})
