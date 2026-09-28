import assert from 'node:assert/strict'
import test from 'node:test'
import { transcriptFlaw } from './transcript-guard.ts'

/**
 * The first list is measured, not imagined: every string in it was produced by
 * `onnx-community/moonshine-base-ko-ONNX` (q8, the app's own call options) on
 * audio that held no Korean speech, or too little of it to read — 0.6 s
 * segments, silence, room noise, short complete words.
 *
 * The rest of the file is the two other things a guard is judged on: what it
 * must not refuse, and where its boundary actually sits.
 */

test('编造的识别结果会被指出来', () => {
  const invented: Array<[string, string]> = [
    // The string that started this: a 0.6 s segment, at every level from −48 to
    // −8 dBFS, and any short utterance ("네."), whatever the room was doing.
    ['audiotext', 'memorised'],
    // What the model concludes a clip with. 4 s of room noise.
    ['다음 영상에서 만나요.', 'memorised'],
    ['다음영상에서만나요', 'memorised'],
    // 1.5 s of room noise, cut off by the token budget.
    ['지금까지 뉴스 스', 'memorised'],
    // Loops: 1.5 s of silence, and a merged pair that ran away.
    ['언망 언망 언망', 'repetition'],
    ['우리는 육. 우리는 육. 우리는 육.', 'repetition'],
    ['잠깐만요. 잠깐만요. 잠깐만요.', 'repetition'],
    // The same runaway shape, in the English module that has no other failure
    // this file can catch: a loop is a loop in every language.
    ['Thank you. Thank you. Thank you.', 'repetition'],
  ]
  for (const [text, expected] of invented) {
    assert.equal(transcriptFlaw(text, 'ko'), expected, `${JSON.stringify(text)} was not flagged`)
  }
  assert.equal(transcriptFlaw('Thank you. Thank you. Thank you.', 'en'), 'repetition')
})

test('同一个句子换个写法还是同一个句子', () => {
  // Punctuation, spacing and case come off both sides before matching, because
  // the model's choice of them is not evidence of anything.
  assert.equal(transcriptFlaw('Audio text.', 'ko'), 'memorised')
  assert.equal(transcriptFlaw('AUDIOTEXT', 'ko'), 'memorised')
  assert.equal(transcriptFlaw('다음 영상에서 만나요！', 'ko'), 'memorised')
})

test('一两句外文是编的，一整句不是', () => {
  // A measured string cannot demonstrate this rule: the only Latin output the
  // Korean module was caught saying is `audiotext`, and the memorised list
  // catches that one first. So this is the rule's own example.
  assert.equal(transcriptFlaw('Hello world', 'ko'), 'no-script')
  assert.equal(transcriptFlaw('OK', 'ko'), 'no-script')
  // Same rule for Chinese, which asks for Han.
  assert.equal(transcriptFlaw('안녕', 'zh'), 'no-script')
  // English asks for no particular script — the module answers non-speech with
  // an empty string, and a numbers-only line is legitimate English output.
  assert.equal(transcriptFlaw('2026', 'en'), null)
})

test('正常的识别结果一个都不能误伤', () => {
  const kept = [
    // The recording this app was measured against, and the probe sentence:
    // both were read correctly, at length.
    '우리는 교회를 다니는 사람이 아니에요',
    '오늘 수업은 여기까지 하겠습니다.',
    // One word is a whole utterance in Korean, and short answers do repeat.
    '네.',
    '네. 네.',
    '매우 좋아요. 네.',
    // A long line in the target language's script is never touched.
    'OK Google stop',
    'We are not the kind of people who go to church.',
    'And so my fellow Americans, ask not what your country can do',
  ]
  for (const text of kept) {
    assert.equal(transcriptFlaw(text, 'ko'), null, `${JSON.stringify(text)} was dropped`)
  }
  assert.equal(transcriptFlaw('We are not the kind of people', 'en'), null)
  assert.equal(transcriptFlaw('今天下雨了', 'zh'), null)
})

/**
 * The boundary, written down because it is a choice rather than a fact.
 *
 * Two identical units are not a loop — "네. 네." and "고맙습니다. 고맙습니다."
 * are things people say — so the rule waits for three, and a two-word repeat of
 * an invention gets through. (Measured: 1.9 s of raw room noise gives
 * "잠깐만요. 잠깐만요."; 4 s of the same noise gives three of them and is
 * refused. Room noise that quiet does not open a segment after the front-end
 * anyway — the floor for a segment is `absoluteMin` in `segmenter.ts`.)
 */
test('两次重复是边界，不算循环', () => {
  assert.equal(transcriptFlaw('네. 네.', 'ko'), null)
  assert.equal(transcriptFlaw('잠깐만요. 잠깐만요.', 'ko'), null)
  assert.equal(transcriptFlaw('잠깐만요. 잠깐만요. 잠깐만요.', 'ko'), 'repetition')
})

test('空字符串不是护栏的事', () => {
  // "Nothing was recognised" is the branch `session.ts` already had; this
  // module must not claim to have dropped what was never there.
  assert.equal(transcriptFlaw('', 'ko'), null)
  assert.equal(transcriptFlaw('   ', 'ko'), null)
  assert.equal(transcriptFlaw('\n\t', 'ko'), null)
})
