#!/usr/bin/env node
/**
 * End-to-end test: the built app, in a real browser, driven through the Chrome
 * DevTools Protocol.
 *
 * `npm test` covers the pure arithmetic (`tiers`, `level`, `export`, the i18n
 * dictionaries) and `svelte-check` covers the types, and neither of them can see
 * the two things this round is about: whether a page *makes sense on a phone*, and
 * whether a session can genuinely start, record and hand its audio back. So this
 * script builds the app, serves it with the same isolation headers a deployment
 * sends, opens it in headless Chrome with a **fake microphone**, and walks the
 * whole path a user walks — start page, settings behind the debug switch, a
 * recording, a stop, an export — asserting as it goes, and writing a report and a
 * handful of screenshots next to the build.
 *
 * Why CDP and not Playwright: nothing here may add a dependency to the project's
 * `package.json` (this is a phone app with one runtime dependency and a build that
 * has to stay reproducible), and Node 22+ ships a global `WebSocket`, which is the
 * whole of what a CDP client needs. The alternative — a DOM shim in Node — would
 * test a page that no browser would ever render.
 *
 * Run it: `npm run e2e`. Needs Google Chrome (override the path with
 * `CHROME_PATH`); needs the network the first time, because a real recognition
 * module is downloaded and loaded — that is the part of the app a fake module
 * would prove nothing about. `RC_E2E_SKIP_BUILD=1` reuses the existing `dist/`.
 *
 * The report is written to `dist/e2e/` (gitignored, because it is a measurement
 * of one run rather than a source file), and the exit code is the number of failed
 * assertions.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PORT = Number(process.env.RC_E2E_PORT ?? 5288)
const BASE = `http://127.0.0.1:${PORT}`
const DEBUG_PORT = Number(process.env.RC_E2E_DEBUG_PORT ?? 9333)
/**
 * The local Vite entry point, run by this same Node.
 *
 * Not `npx`: on Windows that is a batch shim, which a spawn without a shell cannot
 * start (ENOENT), and a shell would then own a process this script has to be able
 * to kill. Not the script by itself either — `node_modules/vite/bin/vite.js` is a
 * text file with a shebang, which is a program on macOS and a format error on
 * Windows.
 */
const VITE = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
/** `npm` is a batch shim on Windows, and a batch file needs a shell to be spawned. */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const REPORT_DIR = join(ROOT, 'dist', 'e2e')
const DOWNLOADS = join(REPORT_DIR, 'downloads')

/**
 * How long a session may take to start: the recognition module is a single
 * ~230 MB download now (SenseVoice; see `asr/models.ts`) plus engine init, and a
 * fresh browser profile means it comes down on every run — the test trades time
 * for using the real module rather than a fake one.
 */
const START_TIMEOUT_MS = Number(process.env.RC_E2E_START_TIMEOUT_MS ?? 480_000)

const CHROME =
  process.env.CHROME_PATH ??
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
   '/Applications/Chromium.app/Contents/MacOS/Chromium',
   '/usr/bin/google-chrome',
   '/usr/bin/chromium'].find((path) => existsSync(path)) ??
  ''

const results = []
const notes = []

function record(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

function note(text) {
  notes.push(text)
  console.log(`  ..  ${text}`)
}

/** The screenshots a run leaves, in the order a person would read them. */
const SHOTS = [
  ['01-start-page', '起始页：logo 与两颗方块卡片（开始录音 / 历史记录）'],
  ['02-settings-debug-off', '设置页，调试关闭'],
  ['03-settings-debug-on', '设置页，调试打开'],
  ['04-transcript', '转录页：声纹 → 下载位 → 方块时钟，两栏都没有标题'],
  ['05-paused', '暂停面板：放大居中的声纹与时钟，中间没有下载钮，下面三个按钮'],
  ['06-exported', '导出之后'],
  ['07-read-settings', '朗读设置：音色打开时已经是满的，底下没有提示语'],
  ['08-drawer', '左上角 logo 拉出的列表：logo / 名字 / 主页 / 开始翻译 / 历史记录 / 设置 / 版本号'],
  ['09-save-dialog', '保存对话框：名称可以改，日期和定位是保留字段'],
  ['10-history', '历史记录：最新的那条挂着 新 标签'],
  ['11-history-detail', '一条记录：返回 + 小标题，播放器和下载在同一行，下面是原文与译文'],
  ['12-history-select', '批量选择：勾选一条，底部出现删除栏'],
  ['13-note-from-its-address', '直接从地址打开的一条记录（标签页名字也是 记录详情）'],
]

/** Escapes text for the HTML report; the app's own strings are trusted, paths are not. */
function esc(text) {
  return String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch])
}

/**
 * The run as a page: every assertion, and the screenshots underneath it.
 *
 * `report.md` is for reading in a terminal and `report.json` for a script, and
 * neither of them shows what the app actually looked like — which is the whole
 * subject of half these checks (centring, borders, a button that must not move).
 * This file is that look, next to the evidence that produced it, and it opens by
 * itself in the app's own preview pane.
 */
function reviewPage(summary) {
  const rows = summary.results
    .map(
      (r) =>
        `<tr class="${r.ok ? 'ok' : 'bad'}"><td>${r.ok ? 'ok' : 'FAIL'}</td><td>${esc(r.name)}</td><td>${esc(r.detail)}</td></tr>`,
    )
    .join('\n')
  const shots = SHOTS.map(
    ([file, caption]) =>
      `<figure><img src="${file}.png" alt="${esc(caption)}"><figcaption>${esc(caption)}</figcaption></figure>`,
  ).join('\n')
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>端到端报告 — 乔巴</title>
<style>
  body { margin: 0; padding: 24px; background: #fdfbf4; color: #1d2d35; font: 15px/1.6 -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #5b6a72; font-size: 13px; margin-bottom: 20px; }
  .verdict { font-weight: 700; }
  .verdict.bad { color: #b4453a; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 28px; font-size: 13px; }
  td { border-bottom: 1px solid #e3ddcd; padding: 5px 8px; vertical-align: top; }
  td:first-child { font-family: ui-monospace, Consolas, monospace; color: #2f7a55; white-space: nowrap; }
  tr.bad td:first-child { color: #b4453a; font-weight: 700; }
  tr.bad td:nth-child(2) { font-weight: 600; }
  td:last-child { color: #5b6a72; }
  .shots { display: flex; flex-wrap: wrap; gap: 16px; }
  figure { margin: 0; width: 232px; }
  img { width: 100%; border: 2px solid #1d2d35; border-radius: 12px; background: #fff; }
  figcaption { font-size: 12px; color: #5b6a72; margin-top: 6px; }
</style>
<h1>乔巴 · 端到端报告</h1>
<p class="meta">${esc(summary.at)} · 应用版本 ${esc(summary.app)} ·
  <span class="verdict${summary.failed ? ' bad' : ''}">${summary.passed} 通过 · ${summary.failed} 失败</span></p>
<table><tbody>
${rows}
</tbody></table>
<h2>截图</h2>
<div class="shots">
${shots}
</div>
</html>
`
}

// -------------------------------------------------------------- cdp plumbing

class Cdp {
  constructor(url) {
    this.url = url
    this.nextId = 1
    this.pending = new Map()
  }

  async open() {
    this.ws = new WebSocket(this.url)
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
      const wait = this.pending.get(message.id)
      if (!wait) return
      this.pending.delete(message.id)
      if (message.error) wait.reject(new Error(`${message.error.message} (${message.error.code})`))
      else wait.resolve(message.result)
    }
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve
      this.ws.onerror = () => reject(new Error(`could not connect to ${this.url}`))
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(new Error(`${method} timed out`))
      }, 60_000)
    })
  }

  /**
   * Evaluates an expression in the page and returns its value.
   *
   * `async` around the expression, and that is not a detail: several checks here
   * have to *watch* the page for a second or two (does the clock move, does the
   * level react), and a synchronous wrapper makes every one of them a syntax error.
   * `awaitPromise` is what lets the result come back as a value.
   */
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'page threw')
    }
    return result.result.value
  }

  /** Polls an expression until it is truthy, then returns it. */
  async waitFor(expression, { timeoutMs = 10_000, label = expression } = {}) {
    const deadline = Date.now() + timeoutMs
    let last
    while (Date.now() < deadline) {
      last = await this.eval(expression)
      if (last) return last
      await sleep(250)
    }
    throw new Error(`timed out waiting for ${label}`)
  }

  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(REPORT_DIR, `${name}.png`), Buffer.from(data, 'base64'))
  }

  close() {
    try {
      this.ws?.close()
    } catch {
      /* already gone */
    }
  }
}

// ------------------------------------------------------------------- servers

async function startPreview() {
  // Through the local Vite entry point rather than `npx vite`: on Windows `npx` is
  // a batch shim, which a spawn without a shell cannot start (ENOENT, and a report
  // that says the server never answered), and a shell would then own the process
  // this script has to be able to kill. A path into `node_modules` is the same
  // Vite either way.
  const child = spawn(process.execPath, [VITE, 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', (data) => process.stderr.write(`[preview] ${data}`))
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/`)
      if (response.ok) return child
    } catch {
      /* not up yet */
    }
    await sleep(200)
  }
  child.kill('SIGTERM')
  throw new Error('the preview server never answered')
}

async function startChrome(userDataDir) {
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--mute-audio',
      // A microphone that exists and is not the room: without it `getUserMedia`
      // never resolves and no session can start.
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      // A phone-sized window, because the layout this round is about is the phone's.
      '--window-size=430,880',
      '--force-device-scale-factor=1',
      '--lang=zh-CN',
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  child.stderr.on('data', (data) => {
    const text = String(data)
    // Chrome is talkative on macOS about display links and allocators that have no
    // bearing on a headless run; the noise makes real failures hard to see.
    if (!/DevTools listening|ERROR:gpu|Fontconfig|dbus|CVDisplayLink|allocator|voice_transcription/i.test(text)) {
      process.stderr.write(`[chrome] ${text}`)
    }
  })
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
      const page = list.find((target) => target.type === 'page')
      if (page?.webSocketDebuggerUrl) return { child, wsUrl: page.webSocketDebuggerUrl }
    } catch {
      /* not up yet */
    }
    await sleep(200)
  }
  child.kill('SIGKILL')
  throw new Error('Chrome never opened a debugging port')
}

// ------------------------------------------------------------------ scenario

/** A click on the first element matching `selector` that contains `text`. */
function clickText(selector, text) {
  return `const el = [...document.querySelectorAll('${selector}')].find((e) => e.textContent.includes('${text}'))
    if (!el) return false
    el.click()
    return true`
}

/** The headings of the settings screen, which is what the debug gate changes. */
const SETTINGS_HEADINGS = `return [...document.querySelectorAll('.settings h2')].map((h) => h.textContent.trim())`

async function scenario(cdp) {
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Page.navigate', { url: `${BASE}/` })
  await cdp.waitFor(`return document.readyState === 'complete'`, { label: 'the document' })

  // Pin the interface language and the checks below can name strings that exist in
  // the source. The stored settings are also how a test starts from a known state.
  await cdp.eval(`localStorage.setItem('rc.settings.v1', JSON.stringify({ uiLang: 'zh', keepAudio: true, debugMode: false }))
    return true`)
  await cdp.send('Page.reload')
  await cdp.waitFor(`return !!document.querySelector('.start')`, { label: 'the start page' })

  // ---------------------------------------------------------------- start page
  const stack = await cdp.eval(`
    const start = document.querySelector('.start')
    const brand = start.querySelector('.brand')
    const cards = start.querySelector('.cards')
    const button = start.querySelector('.begin')
    const history = start.querySelector('.card.history')
    if (!brand || !cards || !button || !history) return null
    const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, x: r.left + r.width / 2, h: r.height, w: r.width } }
    return {
      brand: box(brand), cards: box(cards), button: box(button), history: box(history),
      viewport: window.innerWidth / 2,
      label: button.textContent.trim(),
      historyLabel: history.textContent.trim(),
      tagline: start.querySelector('.tagline')?.textContent.trim() ?? '',
      hasSettings: !!start.querySelector('.settings'),
      hasHeader: !!document.querySelector('.titlebar'),
      hasFooter: !!document.querySelector('.record-btn'),
    }
  `)
  record('the start page shows a logo and two cards', !!stack)
  if (stack) {
    record(
      'the two are stacked in that order, centred on the window',
      stack.brand.bottom <= stack.cards.top &&
        Math.abs(stack.brand.x - stack.viewport) < 2 &&
        Math.abs(stack.cards.x - stack.viewport) < 2,
      `brand ${Math.round(stack.brand.x)} / cards ${Math.round(stack.cards.x)} · centre ${stack.viewport}`,
    )
    record(
      'nothing else is on it: no header, no footer',
      !stack.hasHeader && !stack.hasFooter,
      `settings door: ${stack.hasSettings}`,
    )
    record('one card opens the recording screen', stack.label === '开始录音', stack.label)
    record(
      'and the other opens the history',
      stack.historyLabel.startsWith('历史记录'),
      stack.historyLabel,
    )
    // Square, and both of them: the shape is the page's whole argument for the
    // change (a thumb finds a square without aiming), and one square beside an
    // oblong is what a half-applied stylesheet looks like.
    record(
      'both cards are squares, and the same square',
      Math.abs(stack.button.w - stack.button.h) < 1 &&
        Math.abs(stack.history.w - stack.history.h) < 1 &&
        Math.abs(stack.button.w - stack.history.w) < 1,
      `${Math.round(stack.button.w)}×${Math.round(stack.button.h)} and ${Math.round(stack.history.w)}×${Math.round(stack.history.h)}`,
    )
    record(
      'the tagline says what the app is now: a recording, not a live translation',
      stack.tagline === '录音笔记',
      stack.tagline,
    )
  }
  await cdp.shot('01-start-page')

  // ------------------------------------------------------- settings and the gate
  await cdp.eval(clickText('.settings', '设置'))
  await cdp.waitFor(`return !!document.querySelector('.settings')`, { label: 'the settings screen' })
  await cdp.eval(`document.querySelectorAll('.settings h2').forEach(() => {})`)
  const offHeadings = await cdp.eval(SETTINGS_HEADINGS)
  const advanced = ['识别', '翻译', '朗读', '诊断工具']
  record(
    'with debug off the settings screen has no workshop in it',
    advanced.every((name) => !offHeadings.includes(name)),
    offHeadings.join(' / '),
  )
  record(
    'but it still has the everyday sections and the switch itself',
    ['语言', '外观', '录音与存储', '调试'].every((name) => offHeadings.includes(name)),
    offHeadings.join(' / '),
  )
  // Scoped to the section by its heading rather than by `.settings` alone: the start
  // page's settings *button* carries that class too, and a view transition leaves it
  // in the DOM for a moment after the screen has changed.
  const wentNote = await cdp.eval(`
    const section = [...document.querySelectorAll('.settings section')].find((s) => s.querySelector('h2')?.textContent.trim() === '调试')
    return section?.querySelector('.note')?.textContent.trim() ?? ''
  `)
  record('and says where the rest went', wentNote.includes('打开调试模式后'), wentNote)
  await cdp.shot('02-settings-debug-off')

  const toggled = await cdp.eval(`
    const row = [...document.querySelectorAll('.settings .row')].find((r) => r.textContent.includes('调试模式'))
    const box = row?.querySelector('input[type=checkbox]')
    if (!box) return null
    box.click()
    return box.checked
  `)
  record('the debug switch turns on', toggled === true)
  await sleep(200)
  const onHeadings = await cdp.eval(SETTINGS_HEADINGS)
  record(
    'and the advanced sections load in',
    advanced.every((name) => onHeadings.includes(name)),
    onHeadings.join(' / '),
  )
  const aiRow = await cdp.eval(`
    const section = [...document.querySelectorAll('.settings section')].find((s) => s.querySelector('h2')?.textContent.trim() === '翻译')
    // The provider picker is not here any more (it is in the read-aloud dialog,
    // checked later, where the key it needs can be judged against its own select),
    // but its key and the model's address are — a debug setting now.
    return {
      key: !!section?.querySelector('input[type=password]'),
      baseUrl: !!section?.querySelector('input[type=text]'),
      pointers: [...section.querySelectorAll('.note')].map((p) => p.textContent.trim()).join(' '),
    }
  `)
  record('the AI model\u2019s key and address are debug settings now', aiRow.key && aiRow.baseUrl, JSON.stringify(aiRow))
  record('and the translation section points at where the picker went', aiRow.pointers.includes('朗读设置'), aiRow.pointers)
  const headingsOn = await cdp.eval(SETTINGS_HEADINGS)
  note(`settings headings with debug on: ${headingsOn.join(' / ')}`)
  await cdp.shot('03-settings-debug-on')

  // Back to the start page — this is the door a user opens settings from.
  await cdp.eval(clickText('.rc-btn', '返回'))
  await cdp.waitFor(`return !!document.querySelector('.start')`, { label: 'the start page again' })
  record('returning from settings lands back on the start page, not in an empty transcript', true)

  // --------------------------------------------------------------- a session
  //
  // Two steps where there used to be one, because that is the change under test:
  // the card is a door that opens the recording screen without starting anything,
  // and the record button there is what starts. A fresh profile has no module, so
  // that button raises the install dialog — which is now the only place a first
  // run downloads the 230 MB SenseVoice model from.
  const opened = await cdp.eval(`
    document.querySelector('.begin').click()
    for (let i = 0; i < 40 && !document.querySelector('.panels'); i += 1) await new Promise((r) => setTimeout(r, 100))
    return {
      panels: !!document.querySelector('.panels'),
      recording: !!document.querySelector('.record-btn.recording'),
      empty: document.querySelector('.panel-body .empty')?.textContent.trim() ?? '',
    }
  `)
  record('the start card opens the recording screen', opened.panels === true)
  record(
    'and it starts nothing: an idle transcript, with the record button still at rest',
    opened.recording === false && opened.empty.includes('点下面的按钮'),
    `recording: ${opened.recording} · “${opened.empty}”`,
  )

  const pressed = await cdp.eval(`document.querySelector('.record-btn').click(); return true`)
  record('the record button there is pressable', pressed === true)
  note('starting a session — the install dialog downloads and loads the recognition module')
  let sawError = ''
  let acknowledged = false
  let downloading = false
  const deadline = Date.now() + START_TIMEOUT_MS
  let running = false
  while (Date.now() < deadline) {
    const state = await cdp.eval(`
      const error = document.querySelector('.modal .error')
      const confirm = [...document.querySelectorAll('.modal button')].find((b) => b.textContent.includes('戴好了'))
      const download = [...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === '下载')
      const progress = document.querySelector('.modal .bar i')
      return {
        recording: !!document.querySelector('.record-btn.recording'),
        error: error ? error.textContent.trim() : '',
        confirm: !!confirm,
        download: !!download,
        percent: progress ? progress.style.width : '',
      }
    `)
    if (state.recording) {
      running = true
      break
    }
    if (state.error) {
      sawError = state.error
      break
    }
    if (state.download && !downloading) {
      // The install dialog, with one row in it: the download button is what fetches
      // the module, and `ondone` starts the session the user was reaching for.
      downloading = true
      await cdp.eval(`
        const button = [...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === '下载')
        button.click()
        return true
      `)
      note('pressed 下载 in the install dialog')
    }
    if (state.percent) note(`  download at ${state.percent}`)
    if (state.confirm && !acknowledged) {
      // The one-time headphone confirmation, which is a gate a first run has to pass
      // — a fresh browser profile has never answered it.
      acknowledged = true
      await cdp.eval(`
        const confirm = [...document.querySelectorAll('.modal button')].find((b) => b.textContent.includes('戴好了'))
        confirm.click()
        return true
      `)
      note('answered the headphone prompt')
    }
    await sleep(1000)
  }
  record('the install dialog was the way in', downloading, downloading ? '' : 'no 下载 button ever appeared')
  if (acknowledged) record('the headphone reminder can be answered and the start carries on', running, sawError)
  record(
    'a session starts (module, provider, microphone, and the view change)',
    running,
    running ? '' : sawError || 'timed out',
  )
  if (!running) return

  await cdp.waitFor(`return !!document.querySelector('.panels')`, { label: 'the transcript view' })
  await sleep(1200)
  await cdp.shot('04-transcript')

  const frame = await cdp.eval(`
    const titlebar = document.querySelector('.titlebar')
    const asr = document.querySelectorAll('.panel-head')[0]
    const mt = document.querySelectorAll('.panel-head')[1]
    const clock = document.querySelector('.clock')
    const time = clock.querySelector('.time')
    const vp = clock.querySelector('.vp')
    return {
      languageInHeader: titlebar.querySelectorAll('select').length,
      sourcePicker: asr.querySelectorAll('select').length,
      targetPicker: mt.querySelectorAll('select').length,
      asrExport: !!asr.querySelector('button[aria-label="导出原文"]'),
      mtExport: !!mt.querySelector('button[aria-label="导出译文"]'),
      voicePicker: mt.querySelectorAll('select').length > 1,
      titles: document.querySelectorAll('.panel-title').length,
      provider: !!mt.querySelector('.provider'),
      time: time.dataset.value ?? '',
      timeLabel: time.getAttribute('aria-label') ?? '',
      glyphs: time.querySelectorAll('.d').length,
      cells: time.querySelectorAll('.d:first-child i').length,
      lit: time.querySelectorAll('.d:first-child i.on').length,
      glyph: (() => {
        const d = time.querySelector('.d')
        if (!d) return null
        const r = d.getBoundingClientRect()
        return { w: Math.round(r.width), h: Math.round(r.height) }
      })(),
      bars: clock.querySelectorAll('.vp i').length,
      vpBorder: getComputedStyle(vp).borderTopWidth,
      download: !!clock.querySelector('.dl'),
      order: [...clock.children].map((el) => el.className.split(' ')[0]).join(','),
      headerButtons: [...document.querySelectorAll('.titlebar .actions button')].map((b) => b.textContent.trim()),
      readBars: !!document.querySelector('.read-btn .playing-bars'),
      level: !!document.querySelector('.record-btn .level'),
      width: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }
  `)
  record('the title bar holds no language picker', frame.languageInHeader === 0)
  record('the 说 picker is in the original-text header', frame.sourcePicker === 1)
  record('and the 译 picker in the translation header', frame.targetPicker === 1)
  record('both panels have their own export button', frame.asrExport && frame.mtExport)
  record('the voice picker has left the translation header', frame.voicePicker === false)
  record(
    'neither column carries a heading, and no Google mark stands in for one',
    frame.titles === 0 && frame.provider === false,
    `${frame.titles} titles · provider mark: ${frame.provider}`,
  )
  record('the header clock is running', /^\d{1,2}:\d{2}(:\d{2})?$/.test(frame.time), frame.time || 'no clock')
  record(
    'and it is drawn as a mosaic of blocks whose count the label spells out',
    frame.glyphs === 5 &&
      frame.cells === 15 &&
      frame.lit > 0 &&
      frame.timeLabel.endsWith(frame.time) &&
      // Whole pixels — 3 px cells with a 1 px gap, which is what keeps the blocks
      // crisp. A fractional cell would draw a blurred clock at every size.
      frame.glyph?.w === 11 &&
      frame.glyph?.h === 19,
    `${frame.glyphs} glyphs · ${frame.cells} cells · ${frame.lit} lit · glyph ${frame.glyph?.w}×${frame.glyph?.h} · “${frame.timeLabel}”`,
  )
  record(
    'with a five-bar voiceprint in a hairline frame beside it',
    frame.bars === 5 && frame.vpBorder === '1px',
    `${frame.bars} bars · border ${frame.vpBorder}`,
  )
  record(
    'the row reads voiceprint, then download, then the clock',
    frame.order === 'vp,slot,time',
    frame.order,
  )
  record('no download button while the recording is running', frame.download === false)
  // The header's 设置 button is gone: the drawer behind the logo is the only way
  // into settings, and the only button left up here is the debug ellipsis.
  record(
    'the header no longer offers 设置 — the drawer is the way in',
    frame.headerButtons.every((text) => text !== '设置'),
    frame.headerButtons.join(' / ') || 'no buttons',
  )
  record('the read-aloud switch carries no second waveform', frame.readBars === false)
  record('the page does not scroll sideways', frame.width <= frame.viewport + 1, `${frame.width} > ${frame.viewport}`)

  // The footer grew a third control this round (the read-aloud settings button),
  // and a bar whose ends a thumb aims at is exactly what a narrow phone breaks:
  // the narrowest screen this app claims to support is 320 px.
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 720,
    deviceScaleFactor: 1,
    mobile: true,
  })
  await sleep(400)
  const narrow = await cdp.eval(`
    const pill = document.querySelector('.record-btn').getBoundingClientRect()
    const set = document.querySelector('.set-btn').getBoundingClientRect()
    const read = document.querySelector('.read-btn').getBoundingClientRect()
    const clipped = (el) => { const r = el.getBoundingClientRect(); const p = el.parentElement.getBoundingClientRect(); return r.left >= p.left - 0.5 && r.right <= p.right + 0.5 && r.top >= p.top - 0.5 && r.bottom <= p.bottom + 0.5 }
    const level = document.querySelector('.record-btn .level')
    return {
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      pill: Math.round(pill.width),
      gap: Math.round(set.left - pill.right),
      order: pill.right <= set.left && set.right <= read.left,
      centre: Math.round(document.querySelector('.clock .time').getBoundingClientRect().left),
      levelInside: level ? clipped(level) : null,
    }
  `)
  record(
    'at 320 px the footer still fits: record, then settings, then the read switch',
    narrow.scrollWidth <= narrow.viewport + 1 && narrow.order && narrow.gap >= 4,
    `pill ${narrow.pill} px, gap ${narrow.gap} px, page ${narrow.scrollWidth} px in ${narrow.viewport}`,
  )
  record(
    'and the level effect is clipped by the pill it fills',
    narrow.levelInside === true,
  )
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 430,
    height: 880,
    deviceScaleFactor: 1,
    mobile: true,
  })
  await sleep(200)

  // The level effect inside the pill: it exists, it is fed by the microphone, and
  // it is drawn as a scale rather than as a number.
  const level = await cdp.eval(`
    const el = document.querySelector('.record-btn .level')
    if (!el) return null
    const samples = []
    for (let i = 0; i < 12; i += 1) {
      samples.push(Number(getComputedStyle(el).getPropertyValue('--level')))
      await new Promise((r) => setTimeout(r, 200))
    }
    const transform = getComputedStyle(el).transform
    const scale = Number(transform.match(/matrix\\(([^,]+), ?([^,]+), ?([^,]+), ?([^,]+)/)?.[4] ?? NaN)
    return { max: Math.max(...samples), min: Math.min(...samples), finite: samples.every(Number.isFinite), scale }
  `)
  record(
    'the level inside the record button is fed by the microphone',
    !!level && level.finite && level.max > 0,
    level ? `max ${level.max}, min ${level.min}, scaleY ${level.scale}` : 'no level element',
  )

  // The clock is blocks now, so what it *says* is its accessible label and the
  // `data-value` it spells out; the glyphs themselves carry no text to count.
  const clockRan = await cdp.eval(`
    const time = document.querySelector('.clock .time')
    const read = () => time.dataset.value
    const first = read()
    const left = time.getBoundingClientRect().left
    await new Promise((r) => setTimeout(r, 2500))
    const second = read()
    return { first, second, left, moved: first !== second }
  `)
  record('the clock counts the recording', clockRan.moved, `${clockRan.first} → ${clockRan.second}`)

  // ------------------------------------------------------------------ pause
  // The button says 暂停 now, not 停止: a session ends by being *filed*, and the
  // panel that comes up is where that decision is made. It arrives with a
  // transition, so the clock is watched *growing* rather than measured once.
  //
  // Headless Chrome reports `prefers-reduced-motion: reduce`, and this app honours
  // it by dropping every transition — which would hide the one thing this round is
  // about. A phone on a desk is in the default mode, so that is what is emulated.
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  })
  await cdp.eval(`document.querySelector('.record-btn').click(); return true`)
  /** `mm:ss` / `h:mm:ss` as seconds, for comparing one clock with another. */
  const asSeconds = (value) =>
    String(value)
      .split(':')
      .reduce((total, part) => total * 60 + Number(part), 0)
  const growth = await cdp.eval(`
    const widths = []
    const started = performance.now()
    while (performance.now() - started < 1400) {
      const clock = document.querySelector('.pause-panel .clock')
      if (clock) widths.push(Math.round(clock.getBoundingClientRect().width))
      await new Promise((r) => setTimeout(r, 25))
    }
    const clock = document.querySelector('.pause-panel .clock')
    return {
      samples: widths.length,
      min: widths.length ? Math.min(...widths) : 0,
      max: widths.length ? Math.max(...widths) : 0,
      duration: clock ? getComputedStyle(clock).transitionDuration : '',
      zoom: clock ? getComputedStyle(clock).getPropertyValue('--zoom').trim() : '',
    }
  `)
  await sleep(900)
  const after = await cdp.eval(`
    const time = document.querySelector('.pause-panel .clock .time')
    const header = document.querySelector('.titlebar .clock .time')
    const stopped = time.dataset.value
    await new Promise((r) => setTimeout(r, 1500))
    return {
      time: stopped,
      still: time.dataset.value === stopped,
      headerLeft: header.getBoundingClientRect().left,
      header: header.dataset.value,
      // Both copies of the clock exist right now: the header's, under the panel's
      // scrim, and the enlarged one on the panel.
      panelDownload: !!document.querySelector('.pause-panel .clock .dl'),
      headerDownload: !!document.querySelector('.titlebar .clock .dl'),
      panelOrder: (() => {
        const clock = document.querySelector('.pause-panel .clock')
        return clock ? [...clock.children].map((el) => el.className.split(' ')[0]).join(',') : ''
      })(),
      rows: document.querySelectorAll('.panel-body .line').length,
    }
  `)
  record('the clock freezes when the recording pauses', after.still, `${after.time}`)
  record(
    'and it freezes at the length of the session, not at zero',
    after.time !== '00:00' && Math.abs(asSeconds(after.time) - asSeconds(after.header)) <= 1,
    `panel ${after.time} · header ${after.header}`,
  )
  // The panel draws the same clock, minus the download icon: up here, between a
  // stop and a decision, the file is what 保存 files, and a second unlabelled way
  // to take it away would be a fourth meaning for one recording. The header keeps
  // its own copy of that button (asserted below), which the panel covers while it
  // is up.
  record('the pause panel carries no download button of its own', after.panelDownload === false)
  record(
    'and its clock is the voiceprint and the time, with nothing between them',
    after.panelOrder === 'vp,time',
    after.panelOrder || 'no clock',
  )
  record('while the header, which the panel covers, still holds one', after.headerDownload === true)
  // The button appearing is the moment the reserved slot exists for: the clock is a
  // number being watched, and taking the button's width out of it would move it.
  record(
    'and the header clock it was copied from did not move',
    Math.abs(after.headerLeft - clockRan.left) < 0.5,
    `${clockRan.left.toFixed(1)} → ${after.headerLeft.toFixed(1)} px`,
  )
  note(`transcript rows after the fake microphone: ${after.rows}`)

  // The panel itself: what it is, and the three ways out of it.
  const panel = await cdp.eval(`
    const heading = document.querySelector('.pause-panel .heading')?.textContent.trim() ?? ''
    const buttons = [...document.querySelectorAll('.pause-panel .actions button')].map((b) => b.textContent.trim())
    const time = document.querySelector('.pause-panel .clock .time')
    const clock = document.querySelector('.pause-panel .clock')
    const rect = clock.getBoundingClientRect()
    const box = document.querySelector('.pause-panel').getBoundingClientRect()
    // The enlargement is measured on a glyph rather than on the whole row: the
    // panel's copy deliberately leaves out the download button the header's has
    // (SessionClock's showDownload), so the two rows are different widths by
    // design and only the drawing itself is comparable between them.
    const glyph = time.querySelector('.d').getBoundingClientRect()
    const headerGlyph = document.querySelector('.titlebar .clock .time .d').getBoundingClientRect()
    return {
      heading,
      buttons,
      centreOff: Math.abs(rect.left + rect.width / 2 - window.innerWidth / 2),
      ratio: glyph.width / headerGlyph.width,
      glyph:
        Math.round(headerGlyph.width) + '×' + Math.round(headerGlyph.height) +
        ' → ' + Math.round(glyph.width) + '×' + Math.round(glyph.height),
      order: [...clock.children].map((el) => el.className.split(' ')[0]).join(','),
      duration: getComputedStyle(clock).transitionDuration,
      covers: box.height >= window.innerHeight - 1,
      scrim: !!document.querySelector('.scrim'),
    }
  `)
  record('pausing brings up a panel that says so', panel.heading === '录音已暂停', panel.heading)
  record(
    'with the three ways out of it: carry on, start again, or file it',
    panel.buttons.length === 3 &&
      panel.buttons[0] === '继续录音' &&
      panel.buttons[1] === '开启新录音' &&
      panel.buttons[2] === '保存',
    panel.buttons.join(' / '),
  )
  record(
    'the header\u2019s clock is drawn again, enlarged and centred on the window',
    panel.ratio > 2 && panel.ratio < 2.5 && panel.centreOff <= 4,
    `${panel.ratio.toFixed(2)}× the header\u2019s digits (${panel.glyph}) · ${panel.centreOff.toFixed(1)} px off centre`,
  )
  record(
    'and it is the same two marks up there, without the download the header keeps',
    panel.order === 'vp,time',
    panel.order,
  )
  record(
    'and it grows into place rather than appearing at its size',
    growth.samples >= 3 && growth.min < growth.max * 0.95 && panel.duration === '0.32s',
    `${growth.samples} frames, ${growth.min} → ${growth.max} px, transition ${panel.duration}, zoom ${growth.zoom}`,
  )
  record('the panel is the screen, not a card on one', panel.covers === true && panel.scrim === true)
  await cdp.shot('05-paused')

  // The recording as a file is checked where a user asks for it: the note's own
  // screen, once it has been filed and it is the note's WAV that comes down.

  // 继续录音: the same session, the microphone reopened, the panel gone.
  const resumed = await cdp.eval(`
    const button = [...document.querySelectorAll('.pause-panel .actions button')].find((b) => b.textContent.trim() === '继续录音')
    button.click()
    await new Promise((r) => setTimeout(r, 1800))
    return {
      recording: !!document.querySelector('.record-btn.recording'),
      panel: !!document.querySelector('.pause-panel'),
      label: document.querySelector('.record-btn').textContent.trim(),
      rows: document.querySelectorAll('.panel-body .line').length,
    }
  `)
  record(
    '继续录音 reopens the microphone and takes the panel away',
    resumed.recording === true && resumed.panel === false,
    `button now says “${resumed.label}”, ${resumed.rows} rows kept`,
  )

  // The export buttons, with whatever the transcript holds: either a file or the
  // sentence that says there is nothing yet. Both are correct; silence is not.
  const downloads = readdirSync(DOWNLOADS).length
  await cdp.eval(`document.querySelector('button[aria-label="导出原文"]').click(); return true`)
  await sleep(800)
  const exported = await cdp.eval(`
    return {
      toast: document.querySelector('.clone-toast')?.textContent.trim() ?? '',
      rows: document.querySelectorAll('.panel-body .line').length,
    }
  `)
  await cdp.eval(`document.querySelector('button[aria-label="导出译文"]').click(); return true`)
  await sleep(800)
  const translated = await cdp.eval(`return document.querySelector('.clone-toast')?.textContent.trim() ?? ''`)
  const files = readdirSync(DOWNLOADS)
  record(
    'exporting the original text either writes a file or says there is nothing to write',
    files.length > downloads || exported.toast.includes('还没有内容可以导出'),
    files.length ? files.join(', ') : exported.toast || 'nothing happened',
  )
  record(
    'and the translation button answers too',
    files.length > downloads || translated.length > 0,
    translated,
  )

  await cdp.shot('06-exported')

  // ------------------------------------------------------------------- file it
  // The place lookup is stubbed, and only here: a real one wants a permission
  // prompt and a gazetteer on the network, and what is under test is the title,
  // the dialog around it and the note that comes out the other end.
  await cdp.eval(`
    const realFetch = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const url = String(input?.url ?? input)
      if (url.includes('reverse-geocode') || url.includes('nominatim')) {
        return Promise.resolve(new Response(
          JSON.stringify({ city: '上海', locality: '上海', principalSubdivision: 'Shanghai', countryName: 'China' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ))
      }
      return realFetch(input, init)
    }
    navigator.geolocation.getCurrentPosition = (ok) => {
      ok({ coords: { latitude: 31.23, longitude: 121.47, accuracy: 20 }, timestamp: Date.now() })
      return 1
    }
    return true
  `)

  const naming = await cdp.eval(`
    document.querySelector('.record-btn').click()
    await new Promise((r) => setTimeout(r, 900))
    const save = [...document.querySelectorAll('.pause-panel .actions button')].find((b) => b.textContent.trim() === '保存')
    save.click()
    // Long enough for the position fix and the lookup behind the dialog.
    await new Promise((r) => setTimeout(r, 1600))
    const modal = document.querySelector('.modal')
    return {
      open: !!modal,
      heading: modal?.querySelector('h2')?.textContent.trim() ?? '',
      keys: [...(modal?.querySelectorAll('.field .key') ?? [])].map((k) => k.textContent.trim()),
      values: [...(modal?.querySelectorAll('.field .value') ?? [])].map((v) => v.textContent.trim()),
      name: modal?.querySelector('input')?.value ?? '',
    }
  `)
  record(
    '保存 asks for a name before it files anything',
    naming.open === true && naming.heading === '保存到历史记录',
    naming.heading || 'no dialog',
  )
  record(
    'opening with the generated title: the date, the time, and where this is',
    naming.name.includes('·') && naming.name.includes('上海'),
    naming.name,
  )
  record(
    'and showing the date and the place as fields of their own',
    naming.keys.join('/') === '名称/日期/定位' && (naming.values[1] ?? '').includes('上海'),
    `${naming.keys.join(' / ')} · ${naming.values.join(' · ')}`,
  )
  await cdp.shot('09-save-dialog')

  const filed = await cdp.eval(`
    const input = document.querySelector('.modal input')
    input.value = '第三节课'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const save = [...document.querySelectorAll('.modal .footer button')].find((b) => b.textContent.trim() === '保存')
    save.click()
    await new Promise((r) => setTimeout(r, 3000))
    return {
      history: !!document.querySelector('.history'),
      footer: !!document.querySelector('.record-btn'),
      rows: [...document.querySelectorAll('.history .row')].map((r) => r.textContent.trim()),
      badge: document.querySelector('.history .badge')?.textContent.trim() ?? '',
      summary: document.querySelector('.history .summary')?.textContent.trim() ?? '',
      heading: document.querySelector('.history .bar .heading')?.textContent.trim() ?? '',
      barButtons: [...document.querySelectorAll('.history .bar button')].map((b) => b.textContent.trim()),
      paused: !!document.querySelector('.pause-panel'),
    }
  `)
  record(
    'saving lands straight on the history screen, with the note at the top',
    filed.history === true && filed.rows.length === 1,
    filed.rows.join(' / ') || 'no rows',
  )
  record('named what was typed, not what was generated', filed.rows[0]?.startsWith('第三节课') === true, filed.rows[0] ?? '')
  record('and badged as the new one', filed.badge === '新', filed.badge || 'no badge')
  record(
    'with the date and the place still on the row, because a rename keeps them',
    (filed.rows[0] ?? '').includes('上海'),
    filed.rows[0] ?? '',
  )
  record(
    'the recording screen is gone: no footer, no pause panel',
    filed.footer === false && filed.paused === false,
    filed.summary,
  )
  // The list's own small heading, and the absence of the 返回 that used to sit
  // where it is now: the list is a destination, and the drawer is the way between
  // destinations.
  record(
    'the list is titled by a small heading, and carries no way back',
    filed.heading === '历史记录' && filed.barButtons.every((text) => !text.includes('返回')),
    `“${filed.heading}” · buttons: ${filed.barButtons.join(' / ') || 'none'}`,
  )
  await cdp.shot('10-history')

  // The artifact: the note is on the device, not in the page.
  const stored = await cdp.eval(`
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('rc-history')
    const names = []
    for await (const [name] of dir.entries()) names.push(name)
    names.sort()
    const index = JSON.parse(await (await (await dir.getFileHandle('index.json')).getFile()).text())
    const id = index[0]?.id ?? ''
    let head = ''
    let bytes = 0
    if (id) {
      const wav = await (await dir.getFileHandle(id + '.wav')).getFile()
      bytes = wav.size
      head = new TextDecoder().decode(await wav.slice(0, 12).arrayBuffer())
    }
    return { names, id, meta: index[0] ?? null, head, bytes }
  `)
  record(
    'the note is on the device: one index, one transcript, one recording',
    stored.names.length === 3 && stored.names.includes('index.json'),
    stored.names.join(', '),
  )
  record(
    'and the WAV beside it is a real WAV',
    stored.head.startsWith('RIFF') && stored.head.slice(8, 12) === 'WAVE' && stored.bytes > 44,
    `${stored.bytes} bytes, header “${stored.head.slice(0, 4)}/${stored.head.slice(8, 12)}”`,
  )
  record(
    'the index carries the fields a rename has to keep',
    stored.meta?.title === '第三节课' && stored.meta?.place === '上海' && typeof stored.meta?.at === 'number',
    JSON.stringify({ title: stored.meta?.title, place: stored.meta?.place, lines: stored.meta?.lines }),
  )

  // Opening it: the transcript, the audio, and the note's own file.
  const detail = await cdp.eval(`
    document.querySelector('.history .row').click()
    await new Promise((r) => setTimeout(r, 1200))
    const audio = document.querySelector('.history audio')
    let duration = null
    for (let i = 0; i < 40 && duration === null; i += 1) {
      if (audio && audio.readyState >= 1 && Number.isFinite(audio.duration)) duration = audio.duration
      else await new Promise((r) => setTimeout(r, 100))
    }
    const link = document.querySelector('.history a[download]')
    const row = (() => {
      if (!audio || !link) return null
      const a = audio.getBoundingClientRect()
      const d = link.getBoundingClientRect()
      return {
        centres: Math.abs(a.top + a.height / 2 - (d.top + d.height / 2)),
        rightOf: d.left >= a.right - 0.5,
        inside: d.right <= window.innerWidth + 1,
      }
    })()
    return {
      title: document.querySelector('.history h2')?.textContent.trim() ?? '',
      facts: document.querySelector('.history .facts')?.textContent.trim() ?? '',
      audio: !!audio,
      kind: (audio?.src ?? '').split(':')[0],
      duration,
      download: !!link,
      heading: document.querySelector('.history .bar .heading')?.textContent.trim() ?? '',
      barButtons: [...document.querySelectorAll('.history .bar button')].map((b) => b.textContent.trim()),
      playerBorder: audio ? getComputedStyle(audio).borderTopWidth : '',
      row,
      pairs: document.querySelectorAll('.history .pair').length,
      empty: document.querySelector('.history .transcript')?.textContent.trim() ?? '',
    }
  `)
  record(
    'opening a note plays its recording back',
    detail.audio === true && detail.kind === 'blob' && (detail.duration ?? 0) > 0,
    `src ${detail.kind}:…, ${detail.duration === null ? 'no duration' : `${detail.duration.toFixed(1)} s`}`,
  )
  record(
    'and its transcript is readable there — the sentences with their translations',
    detail.pairs > 0 || detail.empty.includes('没有识别到文字'),
    detail.pairs ? `${detail.pairs} sentences` : detail.empty,
  )
  record('with a link that hands out the note\u2019s own file', detail.download === true)
  // Where the list has a small heading and no way back, the note has both: 返回
  // to the list it was opened from, and a heading saying which screen this is.
  record(
    'a note is titled by its own small heading, with 返回 beside it',
    detail.heading === '记录详情' && detail.barButtons.join('/') === '返回',
    `“${detail.heading}” · buttons: ${detail.barButtons.join(' / ') || 'none'}`,
  )
  // One line: the player, and the button that keeps the file, dressed as the rest
  // of the app's controls are.
  record(
    'the player and the download link sit on one row, the link to its right',
    detail.row !== null && detail.row.centres <= 3 && detail.row.rightOf === true && detail.row.inside === true,
    detail.row ? `${detail.row.centres.toFixed(1)} px apart vertically, link inside the window: ${detail.row.inside}` : 'no row',
  )
  record('and the player wears this app\u2019s frame like the controls beside it', detail.playerBorder === '2px', detail.playerBorder || 'no player')
  await cdp.shot('11-history-detail')

  const grabbed = readdirSync(DOWNLOADS).length
  await cdp.eval(`document.querySelector('.history a[download]').click(); return true`)
  await sleep(1200)
  const noteFile = readdirSync(DOWNLOADS).filter((name) => name.startsWith(stored.id))
  record('and that link downloads the recording the note holds', noteFile.length === 1, noteFile.join(', ') || `nothing matching ${stored.id} (had ${grabbed})`)
  if (noteFile.length === 1) {
    // The whole chain in one file: a fake microphone, a session, OPFS, and the
    // bytes a user saved. This assertion used to run against the pause panel's own
    // download button; that button is gone, so it runs where the file is actually
    // asked for now.
    const bytes = readFileSync(join(DOWNLOADS, noteFile[0]))
    const declared = bytes.length >= 44 ? bytes.readUInt32LE(4) + 8 : 0
    record(
      'and the file is a WAV whose header covers the audio in it',
      bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE' && declared === bytes.length,
      `${bytes.length} bytes, header says ${declared}`,
    )
  }

  // ------------------------------------------------------------------ rename
  const renamed = await cdp.eval(`
    const rename = [...document.querySelectorAll('.history .row-actions button')].find((b) => b.textContent.trim() === '重命名')
    rename.click()
    await new Promise((r) => setTimeout(r, 350))
    const input = document.querySelector('.modal input')
    const before = input.value
    input.value = '第三节课（改）'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const save = [...document.querySelectorAll('.modal .footer button')].find((b) => b.textContent.trim() === '重命名')
    save.click()
    await new Promise((r) => setTimeout(r, 700))
    const afterTitle = document.querySelector('.history h2')?.textContent.trim() ?? ''
    const back = [...document.querySelectorAll('.history .bar button')].find((b) => b.textContent.trim() === '返回')
    back.click()
    await new Promise((r) => setTimeout(r, 500))
    return { before, afterTitle, row: document.querySelector('.history .row')?.textContent.trim() ?? '' }
  `)
  record('重命名 asks with the name the note already has', renamed.before === '第三节课', renamed.before)
  record('and the new name is what it answers to', renamed.afterTitle === '第三节课（改）', renamed.afterTitle)
  record(
    'while the date and the place stay on the row, which is what a rename keeps',
    renamed.row.startsWith('第三节课（改）') && renamed.row.includes('上海'),
    renamed.row,
  )

  // --------------------------------------------------------- batch delete
  const selection = await cdp.eval(`
    const pick = [...document.querySelectorAll('.history .bar button')].find((b) => b.textContent.trim() === '选择')
    pick.click()
    await new Promise((r) => setTimeout(r, 350))
    const before = document.querySelectorAll('.selectbar .picked').length
    document.querySelector('.history .check').click()
    await new Promise((r) => setTimeout(r, 250))
    return {
      barWasUp: before === 1,
      picked: document.querySelector('.selectbar .picked')?.textContent.trim() ?? '',
      ticked: document.querySelector('.history .check').classList.contains('on'),
      label: [...document.querySelectorAll('.history .bar button')].map((b) => b.textContent.trim()).join('/'),
    }
  `)
  record(
    '选择 turns the list into a selection, one tick at a time',
    selection.barWasUp && selection.ticked === true && selection.picked === '已选 1 条',
    `${selection.picked} · buttons: ${selection.label}`,
  )
  await cdp.shot('12-history-select')

  const deleted = await cdp.eval(`
    const remove = [...document.querySelectorAll('.selectbar button')].find((b) => b.textContent.trim() === '删除')
    remove.click()
    await new Promise((r) => setTimeout(r, 350))
    const confirm = document.querySelector('.modal')
    const heading = confirm?.querySelector('h2')?.textContent.trim() ?? ''
    const body = confirm?.querySelector('.body')?.textContent.trim() ?? ''
    const go = [...document.querySelectorAll('.modal .footer button')].find((b) => b.textContent.trim() === '删除')
    go.click()
    await new Promise((r) => setTimeout(r, 900))
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('rc-history')
    const names = []
    for await (const [name] of dir.entries()) names.push(name)
    const index = JSON.parse(await (await (await dir.getFileHandle('index.json')).getFile()).text())
    return {
      heading,
      body,
      rows: document.querySelectorAll('.history .row').length,
      bar: !!document.querySelector('.selectbar'),
      empty: document.querySelector('.history .list .facts')?.textContent.trim() ?? '',
      left: names.filter((name) => name !== 'index.json').length,
      indexed: index.length,
    }
  `)
  record(
    '删除 asks first, and says what goes with it',
    deleted.heading === '删除历史记录' && deleted.body.includes('录音和文字'),
    `${deleted.heading}: ${deleted.body}`,
  )
  record('and the note is gone from the list', deleted.rows === 0 && deleted.bar === false, deleted.empty)
  record(
    'and gone from the device, recording included',
    deleted.left === 0 && deleted.indexed === 0,
    `${deleted.left} files left, index holds ${deleted.indexed}`,
  )

  // ------------------------------------------------------------------ drawer
  // The logo in the title bar opens the list, and the top row of that list is the
  // way home. It runs here because this is the first screen in the walk that has a
  // title bar at all — the start page does not have one.
  const drawer = await cdp.eval(`
    document.querySelector('.titlebar .brand').click()
    await new Promise((r) => setTimeout(r, 380))
    const nav = document.querySelector('.drawer')
    if (!nav) return { open: false }
    const rows = [...nav.querySelectorAll('.row')].map((b) => b.textContent.trim())
    const rect = nav.getBoundingClientRect()
    return {
      open: true,
      rows,
      left: Math.round(rect.left),
      onScreen: rect.left >= 0 && rect.right <= window.innerWidth + 1,
      scrim: !!document.querySelector('.scrim'),
      expanded: document.querySelector('.titlebar .brand').getAttribute('aria-expanded'),
    }
  `)
  await cdp.shot('08-drawer')
  record('the logo opens a drawer out of the left edge', drawer.open === true && drawer.scrim === true, `left ${drawer.left}`)
  record(
    'holding the app itself, then the way home and the three destinations',
    ['乔巴', '主页', '开始翻译', '历史记录', '设置'].every((name, index) => (drawer.rows?.[index] ?? '').includes(name)),
    (drawer.rows ?? []).join(' / '),
  )
  record(
    'and the version at the bottom',
    /版本 \d{8}(\.\d+)?/.test(drawer.rows?.[drawer.rows.length - 1] ?? ''),
    drawer.rows?.[drawer.rows.length - 1] ?? '',
  )
  record('the logo says whether the list is open', drawer.expanded === 'true', `aria-expanded=${drawer.expanded}`)
  const about = await cdp.eval(`
    const version = [...document.querySelectorAll('.drawer .row')].pop()
    version.click()
    await new Promise((r) => setTimeout(r, 320))
    const modal = document.querySelector('.modal')
    return {
      open: !!modal,
      title: modal?.querySelector('h2')?.textContent.trim() ?? '',
      hint: modal?.querySelector('.hint')?.textContent.trim() ?? '',
      drawer: !!document.querySelector('.drawer'),
    }
  `)
  record(
    'and 版本号 opens the mascot\u2019s own panel, which the logo used to hide',
    about.open === true && about.title.includes('乔巴') && about.drawer === false,
    `${about.title} · drawer still open: ${about.drawer}`,
  )
  record('which now says where to find it again', about.hint.includes('版本号'), about.hint)
  const closed = await cdp.eval(`
    document.querySelector('.modal .footer .rc-btn.accent')?.click()
    await new Promise((r) => setTimeout(r, 350))
    return { modal: !!document.querySelector('.modal'), drawer: !!document.querySelector('.drawer') }
  `)
  record('closing it leaves nothing open but the app', closed.modal === false && closed.drawer === false)
  const away = await cdp.eval(`
    document.querySelector('.titlebar .brand').click()
    await new Promise((r) => setTimeout(r, 380))
    const row = [...document.querySelectorAll('.drawer .row')].find((b) => b.textContent.trim() === '开始翻译')
    row.click()
    await new Promise((r) => setTimeout(r, 700))
    return {
      panels: !!document.querySelector('.panels'),
      footer: !!document.querySelector('.record-btn'),
      drawer: !!document.querySelector('.drawer'),
      label: document.querySelector('.record-btn')?.textContent.trim() ?? '',
      rows: document.querySelectorAll('.panel-body .line').length,
    }
  `)
  record(
    'and 开始翻译 goes back to the transcript rather than starting the microphone',
    away.panels === true && away.footer === true && away.drawer === false && away.label === '录音',
    `button says “${away.label}”, ${away.rows} rows kept`,
  )


  // The read-aloud settings dialog: the three settings that belong together.
  const readDialog = await cdp.eval(`
    document.querySelector('.set-btn').click()
    await new Promise((r) => setTimeout(r, 250))
    const modal = document.querySelector('.modal')
    const rows = modal ? [...modal.querySelectorAll('.row .text')].map((t) => t.textContent.trim()) : []
    const voiceRow = modal
      ? [...modal.querySelectorAll('.row')].find((r) => r.querySelector('.text')?.textContent.trim() === '朗读音色')
      : null
    const voice = voiceRow?.querySelector('select') ?? null
    const height = modal?.getBoundingClientRect().height ?? 0
    // What the picker shows *at the moment the dialog is on screen*. Fetched on
    // open, this is the loading placeholder — and everything under it moves when
    // the options arrive, which is the jitter this check exists for.
    const opening = voice?.options[voice.selectedIndex]?.textContent.trim() ?? ''
    await new Promise((r) => setTimeout(r, 1400))
    return {
      open: !!modal,
      title: modal?.querySelector('h2')?.textContent.trim() ?? '',
      rows,
      options: voice?.options.length ?? 0,
      opening,
      hint: !!modal?.querySelector('.hint'),
      height,
      settled: modal?.getBoundingClientRect().height ?? 0,
    }
  `)
  record(
    'the read-aloud button opens a settings dialog beside the switch',
    readDialog.open && readDialog.title === '朗读设置',
    `${readDialog.title} · ${readDialog.rows.join(' / ')}`,
  )
  record(
    'and the translation provider, the engine and the voice are all in it',
    ['翻译用哪家', '朗读引擎', '朗读音色'].every((name) => readDialog.rows.includes(name)),
    readDialog.rows.join(' / '),
  )
  record(
    'the voice picker is already loaded when the dialog opens',
    readDialog.options > 0 && !readDialog.opening.includes('正在读取'),
    `showing “${readDialog.opening}” · ${readDialog.options} options`,
  )
  record(
    'so nothing in the dialog moves after it has been drawn',
    readDialog.height > 0 && Math.abs(readDialog.settled - readDialog.height) < 0.5,
    `${readDialog.height.toFixed(1)} → ${readDialog.settled.toFixed(1)} px`,
  )
  record(
    'and the sentence that pointed at the debug settings is gone',
    readDialog.hint === false,
  )
  // The AI translator needs a key, and with none configured the option has to be
  // *offered and refused* rather than hidden: a user looking for it has to learn
  // what it wants. Its select is the first row of this dialog.
  const llmGate = await cdp.eval(`
    const select = document.querySelector('.modal select')
    const option = select && [...select.options].find((o) => o.textContent.includes('AI'))
    return { label: option?.textContent.trim() ?? '', disabled: option?.disabled ?? null }
  `)
  record(
    'the AI translator is offered but refused while its key is empty',
    llmGate.disabled === true && llmGate.label.includes('密钥'),
    JSON.stringify(llmGate),
  )
  await cdp.shot('07-read-settings')

  // ------------------------------------------------------------------- home
  // Last, because it leaves the app on the start page: the drawer's own row is the
  // way there, and the card that opened this whole walk is what it lands on.
  const home = await cdp.eval(`
    const done = [...document.querySelectorAll('.modal .footer button')].find((b) => b.textContent.trim() === '完成')
    done?.click()
    await new Promise((r) => setTimeout(r, 350))
    document.querySelector('.titlebar .brand').click()
    await new Promise((r) => setTimeout(r, 380))
    const row = [...document.querySelectorAll('.drawer .row')].find((b) => b.textContent.trim() === '主页')
    row.click()
    await new Promise((r) => setTimeout(r, 500))
    return {
      start: !!document.querySelector('.start'),
      card: document.querySelector('.card.history')?.textContent.trim() ?? '',
      drawer: !!document.querySelector('.drawer'),
    }
  `)
  record(
    'the drawer\u2019s 主页 row goes home, where the card counts what is left',
    home.start === true && home.drawer === false && home.card.includes('还没有'),
    home.card,
  )

  // ------------------------------------------------------------ 开启新录音
  // The third way out of a pause: file what was just recorded, forget its words,
  // and open the microphone on the next one. Opened from the start page's card,
  // which is the door this whole walk came in by — and, as on the first walk, the
  // card only opens the screen: the record button there is what starts. The module
  // is installed by now, so no dialog stands in between.
  const second = await cdp.eval(`
    document.querySelector('.card.begin').click()
    for (let i = 0; i < 40 && !document.querySelector('.panels'); i += 1) await new Promise((r) => setTimeout(r, 100))
    document.querySelector('.record-btn').click()
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline && !document.querySelector('.record-btn.recording')) {
      await new Promise((r) => setTimeout(r, 500))
    }
    return { recording: !!document.querySelector('.record-btn.recording') }
  `)
  note('started a second session from the start page')
  const fresh = await cdp.eval(`
    document.querySelector('.record-btn').click()
    for (let i = 0; i < 40 && !document.querySelector('.pause-panel'); i += 1) await new Promise((r) => setTimeout(r, 200))
    const button = [...document.querySelectorAll('.pause-panel .actions button')].find((b) => b.textContent.trim() === '开启新录音')
    button.click()
    for (let i = 0; i < 90 && !document.querySelector('.record-btn.recording'); i += 1) await new Promise((r) => setTimeout(r, 500))
    return {
      recording: !!document.querySelector('.record-btn.recording'),
      panel: !!document.querySelector('.pause-panel'),
      rows: document.querySelectorAll('.panel-body .line').length,
      editor: !!document.querySelector('.panels'),
      label: document.querySelector('.record-btn')?.textContent.trim() ?? '',
    }
  `)
  record(
    '开启新录音 files the old session and opens the microphone on a blank one',
    second.recording === true && fresh.recording === true && fresh.panel === false && fresh.editor === true && fresh.rows === 0,
    `button says “${fresh.label}”, ${fresh.rows} rows carried over`,
  )
  const replaced = await cdp.eval(`
    document.querySelector('.titlebar .brand').click()
    await new Promise((r) => setTimeout(r, 380))
    const row = [...document.querySelectorAll('.drawer .row')].find((b) => b.textContent.trim() === '历史记录')
    row.click()
    await new Promise((r) => setTimeout(r, 800))
    return {
      rows: [...document.querySelectorAll('.history .row')].map((r) => r.textContent.trim()),
      badge: document.querySelector('.history .badge')?.textContent.trim() ?? '',
    }
  `)
  record(
    'and what it replaced is in the history, titled from the date, the time and the place',
    replaced.rows.length === 1 && replaced.rows[0].includes('·') && replaced.badge === '新',
    `${replaced.rows[0] ?? 'no rows'} · badge “${replaced.badge}”`,
  )

  // ------------------------------------------------------------- the back key
  /**
   * The one control this whole walk has not pressed, and the one a phone has that
   * a finger on the glass does not: the system's own back key. In a browser it is
   * `history.back()`, on Android it is the gesture at the edge of the screen, and
   * in an installed app it is both — same event, same stack.
   *
   * It is here because the list of notes deliberately carries no 返回 of its own:
   * a *button* had to guess where the list was opened from, and the drawer's row
   * opens it from wherever the user happens to be. A back key does not guess — it
   * retraces the step that was actually taken, one step per press — and
   * `lib/app/back.ts` is what keeps the browser's history in step with the app's
   * own screens so that it can.
   *
   * Every check below reads `history.state.rc`: how many of the app's own entries
   * the browser is standing on. One press of the back key takes exactly one of
   * them away, which is the mechanism a screenshot cannot show — and a number that
   * drifts upward over a walk like this one is a back key that would leave a user
   * pressing it at nothing.
   */
  const backToTranscript = await cdp.eval(`
    const depth = () => (history.state && typeof history.state.rc === 'number' ? history.state.rc : 0)
    const before = depth()
    history.back()
    await new Promise((r) => setTimeout(r, 700))
    return {
      before,
      after: depth(),
      entries: history.length,
      list: !!document.querySelector('.history'),
      panels: !!document.querySelector('.panels'),
      recording: !!document.querySelector('.record-btn.recording'),
    }
  `)
  record(
    'the back key takes the list back to the screen it was opened from, and the recording goes on',
    backToTranscript.before === 1 &&
      backToTranscript.after === 0 &&
      backToTranscript.list === false &&
      backToTranscript.panels === true &&
      backToTranscript.recording === true,
    `depth ${backToTranscript.before} → ${backToTranscript.after}, transcript back: ${backToTranscript.panels}, still recording: ${backToTranscript.recording}`,
  )

  const backFromNote = await cdp.eval(`
    const depth = () => (history.state && typeof history.state.rc === 'number' ? history.state.rc : 0)
    document.querySelector('.titlebar .brand').click()
    await new Promise((r) => setTimeout(r, 400))
    const notes = [...document.querySelectorAll('.drawer .row')].find((b) => b.textContent.trim() === '历史记录')
    notes.click()
    await new Promise((r) => setTimeout(r, 900))
    document.querySelector('.history .row').click()
    await new Promise((r) => setTimeout(r, 1300))
    const opened = depth()
    const played = !!document.querySelector('.history audio')
    history.back()
    await new Promise((r) => setTimeout(r, 700))
    return {
      opened,
      played,
      after: depth(),
      rows: document.querySelectorAll('.history .row').length,
      audio: !!document.querySelector('.history audio'),
      heading: document.querySelector('.history .bar .heading')?.textContent.trim() ?? '',
    }
  `)
  record(
    'a back key over a note closes the note and not the app',
    backFromNote.opened === 2 &&
      backFromNote.played === true &&
      backFromNote.after === 1 &&
      backFromNote.rows === 1 &&
      backFromNote.audio === false &&
      backFromNote.heading === '历史记录',
    `depth 2 → ${backFromNote.after}, ${backFromNote.rows} row left, heading “${backFromNote.heading}”`,
  )

  const backFromDrawer = await cdp.eval(`
    const depth = () => (history.state && typeof history.state.rc === 'number' ? history.state.rc : 0)
    document.querySelector('.titlebar .brand').click()
    await new Promise((r) => setTimeout(r, 400))
    const before = depth()
    history.back()
    await new Promise((r) => setTimeout(r, 700))
    return {
      before,
      after: depth(),
      drawer: !!document.querySelector('.drawer'),
      scrim: !!document.querySelector('.scrim'),
      list: !!document.querySelector('.history'),
    }
  `)
  record(
    'a back key with the drawer open shuts the drawer, and the screen under it does not move',
    backFromDrawer.before === 2 &&
      backFromDrawer.after === 1 &&
      backFromDrawer.drawer === false &&
      backFromDrawer.scrim === false &&
      backFromDrawer.list === true,
    `depth ${backFromDrawer.before} → ${backFromDrawer.after}, drawer: ${backFromDrawer.drawer}, list still up: ${backFromDrawer.list}`,
  )

  const backFromDialog = await cdp.eval(`
    const depth = () => (history.state && typeof history.state.rc === 'number' ? history.state.rc : 0)
    document.querySelector('.history .row').click()
    await new Promise((r) => setTimeout(r, 1300))
    const rename = [...document.querySelectorAll('.history .row-actions button')].find((b) => b.textContent.trim() === '重命名')
    rename.click()
    await new Promise((r) => setTimeout(r, 450))
    const before = depth()
    const dialog = !!document.querySelector('.modal')
    history.back()
    await new Promise((r) => setTimeout(r, 700))
    return {
      before,
      dialog,
      after: depth(),
      modal: !!document.querySelector('.modal'),
      note: !!document.querySelector('.history audio'),
    }
  `)
  record(
    'and one press closes one thing: the dialog goes and the note behind it stays',
    backFromDialog.before === 3 &&
      backFromDialog.dialog === true &&
      backFromDialog.after === 2 &&
      backFromDialog.modal === false &&
      backFromDialog.note === true,
    `depth ${backFromDialog.before} → ${backFromDialog.after}, dialog: ${backFromDialog.modal}, note still open: ${backFromDialog.note}`,
  )

  const ownReturn = await cdp.eval(`
    const depth = () => (history.state && typeof history.state.rc === 'number' ? history.state.rc : 0)
    const back = [...document.querySelectorAll('.history .bar button')].find((b) => b.textContent.trim() === '返回')
    back.click()
    await new Promise((r) => setTimeout(r, 800))
    return { after: depth(), rows: document.querySelectorAll('.history .row').length, audio: !!document.querySelector('.history audio') }
  `)
  record(
    'and the app\u2019s own 返回 hands its entry back, so the next press has nothing stale to land on',
    ownReturn.after === 1 && ownReturn.rows === 1 && ownReturn.audio === false,
    `depth back to ${ownReturn.after} with no press of its own`,
  )

  const nothingStale = await cdp.eval(`
    const depth = () => (history.state && typeof history.state.rc === 'number' ? history.state.rc : 0)
    const before = depth()
    document.querySelector('.titlebar .brand').click()
    await new Promise((r) => setTimeout(r, 400))
    const row = [...document.querySelectorAll('.drawer .row')].find((b) => b.textContent.trim() === '开始翻译')
    row.click()
    await new Promise((r) => setTimeout(r, 900))
    return {
      before,
      after: depth(),
      entries: history.length,
      drawer: !!document.querySelector('.drawer'),
      list: !!document.querySelector('.history'),
      panels: !!document.querySelector('.panels'),
    }
  `)
  record(
    'and leaving the list through the drawer leaves nothing of the app behind in the history',
    nothingStale.before === 1 &&
      nothingStale.after === 0 &&
      nothingStale.drawer === false &&
      nothingStale.list === false &&
      nothingStale.panels === true,
    `depth ${nothingStale.before} → ${nothingStale.after} while the drawer shut and the list was left`,
  )

  // --------------------------------------------------------------- 各自的网址
  /**
   * Every screen has an address of its own (`lib/app/route.ts`), and this is that
   * claim checked from outside the app rather than from inside it: the bar after
   * walking into a screen by hand, a page *opened* at an address — which is all a
   * link from somewhere else is, and all a Home Screen shortcut is — a refresh on
   * one, and an address that names nothing that exists.
   *
   * None of it can be seen in a screenshot, so every check here reads
   * `location.hash` beside the screen it is supposed to name. What makes this
   * section possible at all is the depth assertion from the one above it: an
   * address is only right if the screen it names is the screen the app is on, and
   * the app's own entry is what a fresh page has to build for it (`back.ts`,
   * `labelBase`).
   */
  const addressed = await cdp.eval(`
    const depth = () => (history.state && typeof history.state.rc === 'number' ? history.state.rc : 0)
    const heading = () => document.querySelector('.history .bar .heading')?.textContent.trim() ?? ''
    document.querySelector('.titlebar .brand').click()
    await new Promise((r) => setTimeout(r, 400))
    const notes = [...document.querySelectorAll('.drawer .row')].find((b) => b.textContent.trim() === '历史记录')
    notes.click()
    await new Promise((r) => setTimeout(r, 900))
    const list = { hash: location.hash, depth: depth(), heading: heading() }
    document.querySelector('.history .row').click()
    await new Promise((r) => setTimeout(r, 1500))
    const note = {
      hash: location.hash,
      depth: depth(),
      title: document.querySelector('.history .detail h2')?.textContent.trim() ?? '',
      title2: document.title,
    }
    history.back()
    await new Promise((r) => setTimeout(r, 800))
    const back = { hash: location.hash, depth: depth(), heading: heading() }
    return { list, note, back }
  `)
  record(
    'walking into the notes and into a note writes each screen into the address bar',
    addressed.list.hash === '#/history' &&
      addressed.list.depth === 1 &&
      addressed.list.heading === '历史记录' &&
      /^#\/history\/[0-9a-z-]+$/i.test(addressed.note.hash) &&
      addressed.note.depth === 2 &&
      addressed.note.title.length > 0 &&
      addressed.back.hash === '#/history' &&
      addressed.back.depth === 1 &&
      addressed.back.heading === '历史记录',
    `${addressed.list.hash} (${addressed.list.depth}) → ${addressed.note.hash} (${addressed.note.depth}) → ${addressed.back.hash} (${addressed.back.depth})`,
  )

  // A page opened *at* the note's address: what a link pasted into a browser, a
  // bookmark, or a shortcut on a phone's home screen does. Nothing of the walk so
  // far exists in this page — it is a fresh document — so the note has to come out
  // of storage and the screen out of the address alone.
  //
  // The `?from=link` is what makes this a *document* and not a fragment change in
  // the page that is already open (a fragment change is the next check but one,
  // and it is a different path through `back.ts`). The app keeps the query on every
  // entry it pushes (`urlFor`), so the address under test is still the fragment.
  await cdp.send('Page.navigate', { url: `${BASE}/?from=link${addressed.note.hash}` })
  await cdp.waitFor(`return !!document.querySelector('.history .detail h2')`, {
    label: 'the note, opened from its own address',
  })
  const linked = await cdp.eval(`
    const depth = () => (history.state && typeof history.state.rc === 'number' ? history.state.rc : 0)
    return {
      hash: location.hash,
      depth: depth(),
      title: document.querySelector('.history .detail h2')?.textContent.trim() ?? '',
      title2: document.title,
      audio: !!document.querySelector('.history audio'),
    }
  `)
  record(
    'opening a link to a note lands on that note, in a page that never saw the list',
    linked.hash === addressed.note.hash &&
      linked.depth === 2 &&
      linked.title === addressed.note.title &&
      linked.title2.startsWith('记录详情') &&
      linked.audio === true,
    `${linked.hash} (depth ${linked.depth}), “${linked.title}”, tab “${linked.title2}”`,
  )
  await cdp.shot('13-note-from-its-address')

  // A refresh is the same question asked twice: the address has to survive the
  // page it names being thrown away and built again, `history.state` included.
  await cdp.send('Page.reload')
  await cdp.waitFor(`return !!document.querySelector('.history .detail h2')`, { label: 'the note, after a refresh' })
  const refreshed = await cdp.eval(`
    const depth = () => (history.state && typeof history.state.rc === 'number' ? history.state.rc : 0)
    return {
      hash: location.hash,
      depth: depth(),
      title: document.querySelector('.history .detail h2')?.textContent.trim() ?? '',
      title2: document.title,
    }
  `)
  record(
    'and a refresh on it comes back to the same note, not to the app\u2019s first screen',
    refreshed.hash === addressed.note.hash &&
      refreshed.depth === 2 &&
      refreshed.title === addressed.note.title &&
      refreshed.title2.startsWith('记录详情'),
    `${refreshed.hash} (depth ${refreshed.depth}), “${refreshed.title}”`,
  )

  // And out again, one press at a time: the note, the list it came from, and home —
  // the order the app's own entries give, which is what makes a link behave like a
  // walk that started at the start page.
  const deepBack = await cdp.eval(`
    const depth = () => (history.state && typeof history.state.rc === 'number' ? history.state.rc : 0)
    history.back()
    await new Promise((r) => setTimeout(r, 800))
    const first = {
      hash: location.hash,
      depth: depth(),
      heading: document.querySelector('.history .bar .heading')?.textContent.trim() ?? '',
      audio: !!document.querySelector('.history audio'),
    }
    history.back()
    await new Promise((r) => setTimeout(r, 900))
    const second = {
      hash: location.hash,
      depth: depth(),
      start: !!document.querySelector('.start'),
      title: document.title,
    }
    return { first, second }
  `)
  record(
    'and the back key walks a link back out the way it came: the list, then home',
    deepBack.first.hash === '#/history' &&
      deepBack.first.depth === 1 &&
      deepBack.first.heading === '历史记录' &&
      deepBack.first.audio === false &&
      deepBack.second.hash === '' &&
      deepBack.second.depth === 0 &&
      deepBack.second.start === true,
    `${deepBack.first.hash} (${deepBack.first.depth}) → “${deepBack.second.hash || 'no fragment'}” (${deepBack.second.depth})`,
  )

  // An address for a note that is not there any more. It has to end up *somewhere*:
  // a link that was true when it was sent and is not true now is not a reason to
  // show a screen with nothing on it, and the list is the address's own way out.
  await cdp.send('Page.navigate', { url: `${BASE}/#/history/19700101-000000-0000` })
  await cdp.waitFor(`return location.hash === '#/history'`, { label: 'the list, out of a note that is gone' })
  const gone = await cdp.eval(`
    const depth = () => (history.state && typeof history.state.rc === 'number' ? history.state.rc : 0)
    return {
      hash: location.hash,
      depth: depth(),
      heading: document.querySelector('.history .bar .heading')?.textContent.trim() ?? '',
      rows: document.querySelectorAll('.history .row').length,
    }
  `)
  record(
    'an address for a note that no longer exists lands on the list',
    gone.hash === '#/history' && gone.depth === 1 && gone.heading === '历史记录' && gone.rows >= 1,
    `${gone.hash} (depth ${gone.depth}), ${gone.rows} row(s), heading “${gone.heading}”`,
  )

  // An address the app has never heard of: home, with the bar put right. The
  // rewrite is the point — a mistyped address that stayed in the bar would be
  // copied into the next link somebody sends.
  await cdp.send('Page.navigate', { url: `${BASE}/#nonsense` })
  await cdp.waitFor(`return !!document.querySelector('.start') && location.hash === ''`, {
    label: 'home, out of an address the app does not know',
  })
  const nonsense = await cdp.eval(`
    const depth = () => (history.state && typeof history.state.rc === 'number' ? history.state.rc : 0)
    return { hash: location.hash, depth: depth(), start: !!document.querySelector('.start') }
  `)
  record(
    'and an address the app does not recognise is the home screen, with the bar put right',
    nonsense.hash === '' && nonsense.depth === 0 && nonsense.start === true,
    `“${nonsense.hash || 'no fragment'}” (depth ${nonsense.depth}), start page ${nonsense.start}`,
  )

  // The one way in that is not a link at all: an address typed into the bar of a
  // page that is already open. It is a same-document navigation (`hashchange`),
  // which no press of the back key ever produces — so this is the check that the
  // two halves of `route.ts` agree when nothing but the address has changed.
  const typed = await cdp.eval(`
    const depth = () => (history.state && typeof history.state.rc === 'number' ? history.state.rc : 0)
    location.hash = '#/settings'
    await new Promise((r) => setTimeout(r, 900))
    const settings = {
      hash: location.hash,
      depth: depth(),
      headings: document.querySelectorAll('.settings h2').length,
      title: document.title,
    }
    location.hash = '#/history'
    await new Promise((r) => setTimeout(r, 900))
    const list = {
      hash: location.hash,
      depth: depth(),
      heading: document.querySelector('.history .bar .heading')?.textContent.trim() ?? '',
      rows: document.querySelectorAll('.history .row').length,
    }
    return { settings, list }
  `)
  record(
    'an address typed into the bar of the open page goes to that screen too',
    typed.settings.hash === '#/settings' &&
      typed.settings.depth === 1 &&
      typed.settings.headings > 0 &&
      typed.settings.title.startsWith('设置') &&
      typed.list.hash === '#/history' &&
      typed.list.heading === '历史记录' &&
      typed.list.rows >= 1,
    `#/settings (${typed.settings.depth}, “${typed.settings.title}”) → #/history (${typed.list.rows} row(s))`,
  )

  // Last, the plain address again: everything above ends with the app still able to
  // open the way it always did, with no fragment to interpret.
  await cdp.send('Page.navigate', { url: `${BASE}/` })
  await cdp.waitFor(`return !!document.querySelector('.start')`, { label: 'the start page, at the plain address' })
  const plain = await cdp.eval(`
    const depth = () => (history.state && typeof history.state.rc === 'number' ? history.state.rc : 0)
    return { hash: location.hash, depth: depth(), start: !!document.querySelector('.start'), title: document.title }
  `)
  record(
    'and the app opens at its plain address exactly as it did before addresses existed',
    plain.hash === '' && plain.depth === 0 && plain.start === true && plain.title === '乔巴 · 录音笔记',
    `“${plain.hash || 'no fragment'}” (depth ${plain.depth}), title “${plain.title}”`,
  )
}

// ---------------------------------------------------------------------- main

async function main() {
  if (!CHROME) {
    console.error('No Chrome found. Set CHROME_PATH to a Chrome or Chromium binary.')
    process.exit(2)
  }
  if (!process.env.RC_E2E_SKIP_BUILD) {
    console.log('building…')
    // Vite's own `build` command, through this same Node — `package.json`'s build
    // script is `vite build` and nothing else, and this way the step is portable:
    // no batch shim (Windows), no shell (a deprecation warning about unescaped
    // arguments), and the process this script starts is the process it can wait on.
    const build = spawnSync(process.execPath, [VITE, 'build'], { cwd: ROOT, stdio: 'inherit' })
    if (build.status !== 0) process.exit(build.status ?? 1)
  } else if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
    console.error('RC_E2E_SKIP_BUILD=1 but there is no dist/index.html')
    process.exit(2)
  }

  // After the build, not before: `vite build` empties `dist/`, so a report
  // directory created earlier is swept away with the previous output.
  mkdirSync(REPORT_DIR, { recursive: true })
  rmSync(DOWNLOADS, { recursive: true, force: true })
  mkdirSync(DOWNLOADS, { recursive: true })

  const preview = await startPreview()
  const userDataDir = mkdtempSync(join(tmpdir(), 'rc-e2e-'))
  let chrome
  let cdp
  try {
    chrome = await startChrome(userDataDir)
    cdp = new Cdp(chrome.wsUrl)
    await cdp.open()
    // Downloads have to land somewhere this script can look at them.
    try {
      await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: DOWNLOADS,
        eventsEnabled: true,
      })
    } catch {
      await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS })
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 430,
      height: 880,
      deviceScaleFactor: 1,
      mobile: true,
    })
    await scenario(cdp)
  } catch (err) {
    record('the run finished without the harness falling over', false, String(err?.message ?? err))
  } finally {
    cdp?.close()
    chrome?.child.kill('SIGKILL')
    preview.kill('SIGTERM')
    // Windows holds Chrome's profile directory open for a moment after the process
    // is gone, and `rmSync` throws EPERM on the first attempt — which, thrown from
    // here, would take the report with it. A leftover temp directory is not a test
    // result, so the retries are the fix and the note is the receipt.
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
    } catch {
      note(`could not remove the browser profile at ${userDataDir}`)
    }
  }

  const failed = results.filter((r) => !r.ok)
  const summary = {
    at: new Date().toISOString(),
    app: readFileSync(join(ROOT, 'src', 'lib', 'app', 'version.ts'), 'utf8').match(/APP_VERSION = '([^']+)'/)?.[1] ?? '',
    passed: results.length - failed.length,
    failed: failed.length,
    results,
    notes,
  }
  writeFileSync(join(REPORT_DIR, 'report.json'), `${JSON.stringify(summary, null, 2)}\n`)
  writeFileSync(
    join(REPORT_DIR, 'report.md'),
    [
      `# End-to-end run — ${summary.at}`,
      '',
      `App version: ${summary.app}`,
      '',
      `${summary.passed} passed, ${summary.failed} failed`,
      '',
      '| result | check | detail |',
      '| --- | --- | --- |',
      ...results.map((r) => `| ${r.ok ? 'ok' : 'FAIL'} | ${r.name} | ${r.detail.replace(/\|/g, '\\|')} |`),
      '',
      ...notes.map((n) => `- ${n}`),
      '',
      `Screenshots: ${SHOTS.map(([file]) => file).join(', ')} — in this directory.`,
      'The same run as a page, screenshots included: index.html.',
      '',
    ].join('\n'),
  )
  writeFileSync(join(REPORT_DIR, 'index.html'), reviewPage(summary))

  console.log(`\n${summary.passed} passed, ${summary.failed} failed`)
  console.log(`report: ${join(REPORT_DIR, 'report.md')}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

await main()
