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

/** How long a session may take to start: a 62 MB download plus engine init. */
const START_TIMEOUT_MS = Number(process.env.RC_E2E_START_TIMEOUT_MS ?? 240_000)

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
  ['01-start-page', '起始页：logo、一块预留的加载位置、一颗开始按钮'],
  ['02-settings-debug-off', '设置页，调试关闭'],
  ['03-settings-debug-on', '设置页，调试打开'],
  ['04-transcript', '转录页：声纹 → 下载位 → 方块时钟，两栏都没有标题'],
  ['05-stopped', '停止后：时长冻住，下载钮出现在声纹和时钟之间'],
  ['06-exported', '导出之后'],
  ['07-read-settings', '朗读设置：音色打开时已经是满的，底下没有提示语'],
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
    const stage = start.querySelector('.stage')
    const button = start.querySelector('.begin')
    if (!brand || !stage || !button) return null
    const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, x: r.left + r.width / 2, h: r.height } }
    return {
      brand: box(brand), stage: box(stage), button: box(button),
      viewport: window.innerWidth / 2,
      label: button.textContent.trim(),
      line: stage.querySelector('.line')?.textContent.trim() ?? null,
      hasSettings: !!start.querySelector('.settings'),
      hasHeader: !!document.querySelector('.titlebar'),
      hasFooter: !!document.querySelector('.record-btn'),
    }
  `)
  record('the start page shows a logo, a loading area and one button', !!stack)
  if (stack) {
    record(
      'the three are stacked in that order, centred on the window',
      stack.brand.bottom <= stack.stage.top &&
        stack.stage.bottom <= stack.button.top &&
        Math.abs(stack.brand.x - stack.viewport) < 2 &&
        Math.abs(stack.stage.x - stack.viewport) < 2 &&
        Math.abs(stack.button.x - stack.viewport) < 2,
      `brand ${Math.round(stack.brand.x)} / stage ${Math.round(stack.stage.x)} / button ${Math.round(stack.button.x)} · centre ${stack.viewport}`,
    )
    record(
      'nothing else is on it: no header, no footer',
      !stack.hasHeader && !stack.hasFooter,
      `settings door: ${stack.hasSettings}`,
    )
    record(
      'the loading area is reserved before there is anything to load',
      stack.stage.h >= 80,
      `${Math.round(stack.stage.h)} px`,
    )
    record('the button says what it starts', stack.label === '开始录音', stack.label)
    record(
      'the reserved area says nothing at rest — the resting hint is gone',
      stack.line === '',
      `“${stack.line}”`,
    )

    // The reason the area is reserved: text appears in it during a start, and the
    // button must not move under the thumb that is already on it. The sentence is
    // put back afterwards — it is the page's own text, and the screenshot below has
    // to show the screen a user actually sees.
    const moved = await cdp.eval(`
      const button = document.querySelector('.begin')
      const stage = document.querySelector('.stage')
      const line = stage.querySelector('.line')
      const original = line.textContent
      const before = button.getBoundingClientRect().top
      line.textContent = '正在加载识别模块'.repeat(3)
      const after = button.getBoundingClientRect().top
      line.textContent = original
      return Math.abs(after - before)
    `)
    record('and the button does not move when that area fills up', moved < 0.5, `moved ${moved.toFixed(2)} px`)
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
  const started = await cdp.eval(`document.querySelector('.begin').click(); return true`)
  record('the start button is pressable', started === true)
  note('starting a session — this downloads and loads the recognition module')
  let sawError = ''
  let lastLine = ''
  /** The first real sentence this area showed, and how far its ink sits off centre. */
  let hintShift = null
  let hintText = ''
  let acknowledged = false
  const deadline = Date.now() + START_TIMEOUT_MS
  let running = false
  while (Date.now() < deadline) {
    const state = await cdp.eval(`
      const line = document.querySelector('.stage .line')
      const confirm = [...document.querySelectorAll('.modal button')].find((b) => b.textContent.includes('戴好了'))
      // Centred by *ink*, not by box. The area is centred as a box, and a Chinese
      // full stop is a full-width glyph whose ink sits in the left of its em box:
      // a sentence ending in one carries ~9 px of blank space on the right, so the
      // words read as shifted left of centre by half of that. Measured from the
      // glyphs with a canvas rather than from the element, because this is a
      // question about what the eye sees. Nothing is said at rest any more, so the
      // sentence this runs on is the real one a start produces.
      const shift = (() => {
        if (!line || !line.textContent.trim()) return null
        const box = line.getBoundingClientRect()
        const style = getComputedStyle(line)
        const canvas = document.createElement('canvas').getContext('2d')
        canvas.font = style.fontStyle + ' ' + style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily
        const metrics = canvas.measureText(line.textContent)
        const start = box.left + (box.width - metrics.width) / 2
        return start + (-metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight) / 2 - (box.left + box.width / 2)
      })()
      return {
        recording: !!document.querySelector('.record-btn.recording'),
        line: line ? line.textContent.trim() : '',
        bad: line ? line.classList.contains('bad') : false,
        confirm: !!confirm,
        shift,
      }
    `)
    if (state.recording) {
      running = true
      break
    }
    if (state.bad) {
      sawError = state.line
      break
    }
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
    if (state.shift !== null && hintShift === null) {
      hintShift = state.shift
      hintText = state.line
    }
    if (state.line && state.line !== lastLine) {
      lastLine = state.line
      note(`  page says: ${state.line}`)
    }
    await sleep(1000)
  }
  record(
    'a sentence in that area is centred by what the eye sees while it is up',
    hintShift !== null && Math.abs(hintShift) <= 2,
    // 2 px, and not 0: the tolerance is a font's side bearings, which differ by a
    // fraction of a pixel between platforms.
    hintShift === null ? 'no sentence was ever shown in it' : `${hintShift.toFixed(1)} px off centre · “${hintText}”`,
  )
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

  // ------------------------------------------------------------------- stop
  await cdp.eval(`document.querySelector('.record-btn').click(); return true`)
  await cdp.waitFor(`return !document.querySelector('.record-btn.recording')`, {
    timeoutMs: 30_000,
    label: 'the recording to stop',
  })
  await sleep(1500)
  const after = await cdp.eval(`
    const time = document.querySelector('.clock .time')
    const stopped = time.dataset.value
    await new Promise((r) => setTimeout(r, 1500))
    return {
      time: stopped,
      still: time.dataset.value === stopped,
      left: time.getBoundingClientRect().left,
      download: !!document.querySelector('.clock .dl'),
      between: (() => {
        const dl = document.querySelector('.clock .dl')
        const vp = document.querySelector('.clock .vp')
        if (!dl || !vp) return null
        const button = dl.getBoundingClientRect()
        return vp.getBoundingClientRect().right <= button.left + 0.5 && button.right <= time.getBoundingClientRect().left + 0.5
      })(),
      rows: document.querySelectorAll('.panel-body .line').length,
    }
  `)
  record('the clock stops with the recording', after.still, `${after.time}`)
  record('a download button appears once there is something to save', after.download === true)
  record('and it sits between the voiceprint and the clock', after.between === true)
  // The button appearing is the moment the reserved slot exists for: the clock is a
  // number being watched, and taking the button's width out of it would move it.
  record(
    'and the clock does not move when the button appears',
    Math.abs(after.left - clockRan.left) < 0.5,
    `${clockRan.left.toFixed(1)} → ${after.left.toFixed(1)} px`,
  )
  note(`transcript rows after the fake microphone: ${after.rows}`)
  await cdp.shot('05-stopped')

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

  // The recording itself: the one artifact a classroom can take away.
  await cdp.eval(`document.querySelector('.clock .dl').click(); return true`)
  await sleep(1500)
  const wav = readdirSync(DOWNLOADS).find((name) => name.endsWith('.wav'))
  record('the download button saves the recording to the device', !!wav, wav ?? `nothing in ${DOWNLOADS}`)
  if (wav) {
    const bytes = readFileSync(join(DOWNLOADS, wav))
    const declared = bytes.length >= 44 ? bytes.readUInt32LE(4) + 8 : 0
    record(
      'and the file is a WAV whose header covers the audio in it',
      bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE' && declared === bytes.length,
      `${bytes.length} bytes, header says ${declared}`,
    )
  }
  await cdp.shot('06-exported')

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
