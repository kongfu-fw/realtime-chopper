import assert from 'node:assert/strict'
import process from 'node:process'
import test from 'node:test'

/**
 * The text the app hands to somebody else, locked down.
 *
 * The copy button, the export file and the diagnostic report all go through the
 * same formatter, and all three leave the device — so what they say is a
 * contract: every line carries the date (a pasted log is read days later, in a
 * chat, with no context), the header says which build wrote it and when it was
 * taken, and an API key that reached the log must never reach the clipboard.
 *
 * Node resolves ESM specifiers literally, so the imports carry the `.ts` file
 * extension.
 */

// The stamp is local time on purpose — the browser that wrote the line and the
// person holding the phone share a clock, and a header in UTC above lines in local
// time is how a report gets misread by hours. Fixing the zone is part of fixing the
// expected string.
process.env.TZ = 'Asia/Shanghai'

/** 2026-09-23 10:03:22 in Asia/Shanghai. */
const FIXED = Date.UTC(2026, 8, 23, 2, 3, 22)
/** The day before, same clock: 2026-09-22 18:00:00. */
const PREVIOUS_DAY = Date.UTC(2026, 8, 22, 10, 0, 0)

/**
 * The store persists to `localStorage` and identifies its tab through
 * `sessionStorage`; Node has neither, so the tests bring their own.
 */
function fakeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key)
    },
    setItem: (key: string, value: string) => {
      map.set(key, String(value))
    },
  } as Storage
}

// `defineProperty`, not assignment: a future Node that ships its own web-storage
// global could make this a read-only property, and the tests should not care.
Object.defineProperty(globalThis, 'localStorage', { value: fakeStorage(), configurable: true })
Object.defineProperty(globalThis, 'sessionStorage', { value: fakeStorage(), configurable: true })

// A fixed clock is what makes the assertions exact instead of pattern-matched.
Date.now = () => FIXED

// Every line is mirrored to the console for devtools; the runner does not need a
// second copy of the same twenty lines under the test names.
console.log = () => {}
console.warn = () => {}
console.error = () => {}

const store = await import('./store.ts')

/** The log's own entries, oldest first. */
function logged(): string[] {
  let list: string[] = []
  const unsubscribe = store.entries.subscribe((value) => {
    list = value.map((e) => store.formatEntry(e))
  })
  unsubscribe()
  return list
}

function reset(): void {
  store.clearLogs()
  Date.now = () => FIXED
}

test('一行日志 = 日期 时间 [级别] [环节] 内容', () => {
  reset()
  store.info('asr', '开始识别')
  assert.deepEqual(logged(), ['2026-09-23 10:03:22 [info] [asr] 开始识别'])
})

test('月、日、时都是补零的两位，不能出现 2026-9-8 这种', () => {
  reset()
  Date.now = () => Date.UTC(2026, 8, 8, 1, 5, 3)
  store.info('asr', '跨零点的那一条')
  assert.deepEqual(logged(), ['2026-09-08 09:05:03 [info] [asr] 跨零点的那一条'])
})

test('详情换行后缩进四格', () => {
  reset()
  store.error('asr', '识别失败', '第一行\n第二行')
  assert.deepEqual(logged(), [
    '2026-09-23 10:03:22 [error] [asr] 识别失败\n    第一行\n    第二行',
  ])
  // 对象详情按 JSON 排版，整体仍然缩进四格。
  store.error('asr', '引擎拒绝启动', { 加速器: 'webgpu' })
  assert.equal(
    logged()[1],
    '2026-09-23 10:03:22 [error] [asr] 引擎拒绝启动\n    {\n      "加速器": "webgpu"\n    }',
  )
})

test('复制：三行表头 + 一行一条，条数是真正带上的条数', () => {
  reset()
  store.info('asr', '第一条')
  store.info('asr', '第二条')
  assert.equal(
    store.latestLogsText(),
    [
      '# realtime-chopper logs',
      '# copied 2026-09-23 10:03:22',
      '# entries 2',
      '2026-09-23 10:03:22 [info] [asr] 第一条',
      '2026-09-23 10:03:22 [info] [asr] 第二条',
    ].join('\n'),
  )
  // Asking for fewer lines must not promise more than it carries.
  assert.equal(
    store.latestLogsText(1),
    [
      '# realtime-chopper logs',
      '# copied 2026-09-23 10:03:22',
      '# entries 1',
      '2026-09-23 10:03:22 [info] [asr] 第二条',
    ].join('\n'),
  )
})

test('导出：表头写 exported，收尾有换行', () => {
  reset()
  store.warn('translate', '已切到备用提供方')
  const text = store.exportLogs()
  assert.equal(
    text,
    [
      '# realtime-chopper logs',
      '# exported 2026-09-23 10:03:22',
      '# entries 1',
      '2026-09-23 10:03:22 [warn] [translate] 已切到备用提供方',
      '',
    ].join('\n'),
  )
})

test('日期在每一行上，不是只在表头上', () => {
  reset()
  Date.now = () => PREVIOUS_DAY
  store.info('session', '昨天的那一条')
  Date.now = () => FIXED
  store.info('session', '今天的那一条')
  const lines = store.latestLogsText().split('\n')
  assert.match(lines[3], /^2026-09-22 18:00:00 /)
  assert.match(lines[4], /^2026-09-23 10:03:22 /)
  assert.equal(lines[1], '# copied 2026-09-23 10:03:22')
})

test('清空之后复制只剩表头', () => {
  reset()
  store.info('asr', '要被清掉的一条')
  store.clearLogs()
  assert.equal(
    store.latestLogsText(),
    ['# realtime-chopper logs', '# copied 2026-09-23 10:03:22', '# entries 0', ''].join('\n'),
  )
})

test('默认级别以下的日志不进复制文本', () => {
  reset()
  store.info('asr', '这一条要在')
  store.debug('vad', '这一条不在')
  const text = store.latestLogsText()
  assert.match(text, /这一条要在/)
  assert.doesNotMatch(text, /这一条不在/)
})

test('key 不会跟着复制文本出去', () => {
  reset()
  store.error('translate', '调用失败', 'Authorization: Bearer sk-abc123456789xyz')
  const text = store.latestLogsText()
  assert.match(text, /sk-abc123…/)
  assert.doesNotMatch(text, /abc123456789/)
})

test('导出的文本与复制用的是同一套每行格式', () => {
  reset()
  store.info('tts', '朗读被系统打断')
  const copied = store.latestLogsText().split('\n').slice(3).join('\n')
  const exported = store.exportLogs().split('\n').slice(3).join('\n').trimEnd()
  assert.equal(copied, exported)
  assert.equal(copied, '2026-09-23 10:03:22 [info] [tts] 朗读被系统打断')
})
