#!/usr/bin/env node
/**
 * Tells a deployment apart from a push.
 *
 * Pushing to the git server is what *triggers* a deployment; it is not the
 * deployment. Between the two the server checks out, builds, and swaps what nginx
 * serves — which on this machine is a `docker compose up -d --build`, so the page
 * a URL serves is the previous build for minutes after the push has returned. Every
 * check made during that window looks like a failed deploy, and every check made
 * right after it looks like a successful one, which is how "it's deployed" gets
 * said about a build that never ran.
 *
 * The marker is already in the page: `vite.config.ts` stamps `<meta
 * name="app-version">` into every build from `APP_VERSION` in
 * `src/lib/app/version.ts`, and the file is served `no-cache`, so the number in it
 * is the build the server is serving *now*. This script polls the address until
 * that number is the number this checkout carries, and when the wait is over it
 * fails with the last thing actually observed — the old number, a page without the
 * meta, an HTTP status, or no answer at all — because those are four different
 * problems and the console should not make them look like one.
 *
 * Where the version comes from: the regex `scripts/e2e.mjs` uses to stamp its
 * report, for the same reason — `version.ts` is a TypeScript module and a plain
 * `node` script cannot import it, so the number is read the way the report reader
 * reads it. The meta is read with the same lenient rule as `appVersionFromHtml` in
 * `src/lib/app/update.ts` (either attribute order, `null` when absent), so the
 * script and the app agree on what "serving version X" means.
 *
 * The address defaults to the deployment people open. Anything else is a flag:
 *
 *     node scripts/verify-deploy.mjs --url http://127.0.0.1:5274 --timeout 30
 *
 * — which is also how the checker itself is checked, against a local `vite
 * preview` instead of a deployment. `RC_DEPLOY_URL`, `RC_DEPLOY_TIMEOUT` and
 * `RC_DEPLOY_INTERVAL` carry the same three values for npm scripts.
 *
 * Writes `dist/deploy-check/report.json` (and a readable `report.md` beside it) —
 * one run's numbers, gitignored, so a failed wait can be read later without the
 * terminal it scrolled out of. Exit code 0 only when the versions matched.
 *
 * The exit code is set with `process.exitCode`, not `process.exit()`: calling
 * `process.exit()` after a completed fetch killed Node on Windows — a libuv
 * assertion (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`, process
 * exit 127) — measured three times out of three on the `--timeout 0` path, with
 * and without a request timeout attached, while setting the exit code and
 * returning exits 1 quietly and at once. So `fail()` (which does call
 * `process.exit`) is used only while parsing arguments, before any request exists,
 * and the check itself ends at the bottom of this file.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const REPORT_DIR = join(ROOT, 'dist', 'deploy-check')

/**
 * Where the app answers on the server that deploys it.
 *
 * The same build is reachable as `http://100.113.136.125:8080/` (the nginx port,
 * over the tailnet), and both were checked against each other when this was
 * written. The name is the default because it is the address that is *used*: a
 * certificate or proxy problem lives on that name and nowhere else, and a check
 * that only ever looks at the origin would never see one.
 */
const DEFAULT_URL = 'https://kongfu-onedrive.kooka-salmon.ts.net/'

const DEFAULT_TIMEOUT_S = 600
const DEFAULT_INTERVAL_S = 5
/** One look may not hang the wait: a stalled connection is retried like any other miss. */
const REQUEST_TIMEOUT_MS = 10_000
/** How often a look that changed nothing is still printed, so a long build does not read as a stuck script. */
const HEARTBEAT_MS = 15_000

const USAGE = `用法：node scripts/verify-deploy.mjs [选项]

  --url <地址>      要检查的线上地址（默认 ${DEFAULT_URL}；也可用 RC_DEPLOY_URL）
  --timeout <秒>    最多等多久（默认 ${DEFAULT_TIMEOUT_S}；0 = 只看一次；也可用 RC_DEPLOY_TIMEOUT）
  --interval <秒>   两次检查之间隔多久（默认 ${DEFAULT_INTERVAL_S}；也可用 RC_DEPLOY_INTERVAL）
  -h, --help        这一段

线上 index.html 里的 <meta name="app-version"> 和 src/lib/app/version.ts 里的
APP_VERSION 一致就退出 0；等到超时仍不一致就退出 1，并写清最后看到的是什么。
报告写到 dist/deploy-check/。`

function fail(message) {
  console.log(` FAIL  ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const out = {
    url: process.env.RC_DEPLOY_URL ?? DEFAULT_URL,
    timeoutS: Number(process.env.RC_DEPLOY_TIMEOUT ?? DEFAULT_TIMEOUT_S),
    intervalS: Number(process.env.RC_DEPLOY_INTERVAL ?? DEFAULT_INTERVAL_S),
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const read = (name) => {
      if (arg === name) {
        if (i + 1 >= argv.length) fail(`缺少 ${name} 的值（--help 看用法）`)
        return argv[++i]
      }
      return arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : null
    }
    let value
    if (arg === '-h' || arg === '--help') {
      console.log(USAGE)
      process.exit(0)
    } else if ((value = read('--url')) !== null) out.url = value
    else if ((value = read('--timeout')) !== null) out.timeoutS = Number(value)
    else if ((value = read('--interval')) !== null) out.intervalS = Number(value)
    else fail(`不认识的参数：${arg}（--help 看用法）`)
  }
  if (!Number.isFinite(out.timeoutS) || out.timeoutS < 0) fail('--timeout 要是一个不小于 0 的秒数')
  if (!Number.isFinite(out.intervalS) || out.intervalS <= 0) fail('--interval 要是一个正数秒')
  // A bare host is accepted, the way the app's own recognition-service setting
  // accepts one (https assumed) — the same address gets typed in both places.
  try {
    out.url = new URL(/^https?:\/\//i.test(out.url) ? out.url : `https://${out.url}`)
  } catch {
    fail(`不是能理解的地址：${out.url}`)
  }
  return out
}

/** The version this checkout carries. */
function localVersion() {
  const source = readFileSync(join(ROOT, 'src', 'lib', 'app', 'version.ts'), 'utf8')
  const version = source.match(/APP_VERSION = '([^']+)'/)?.[1]
  if (!version) fail('读不出 src/lib/app/version.ts 里的 APP_VERSION')
  return version
}

/**
 * The version in a served page, or `null` when there is not one to read.
 *
 * The same rule as `src/lib/app/update.ts`, copied rather than shared (that one is
 * a module of the app; this runs before any build). `null` is a real answer — an
 * error page, a captive portal, a proxy in front of the wrong service and a build
 * from before this meta existed all lack it, and none of them is a version.
 */
function appVersionFromHtml(html) {
  const meta = /<meta\s[^>]*name=["']app-version["'][^>]*>/i.exec(html)
  if (!meta) return null
  const content = /content=["']([^"']*)["']/i.exec(meta[0])
  const version = content?.[1].trim()
  return version ? version : null
}

/** One look at the address. Never throws: every way of failing is a result to report. */
async function look(url) {
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
    })
    const html = await response.text()
    if (!response.ok) return { kind: 'http', status: response.status }
    const version = appVersionFromHtml(html)
    return version ? { kind: 'version', version } : { kind: 'missing' }
  } catch (err) {
    const cause = err?.cause ?? {}
    return { kind: 'error', message: String(cause.code ?? cause.message ?? err?.message ?? err) }
  }
}

/** What a look found, as one phrase for the console line and the report table. */
function describe(result) {
  switch (result.kind) {
    case 'version':
      return `线上是 ${result.version}`
    case 'missing':
      return '页面里没有 <meta name="app-version">'
    case 'http':
      return `线上回了 HTTP ${result.status}`
    default:
      return `连不上：${result.message}`
  }
}

/** The line the run ends on, per kind of last look — four failures, four sentences. */
function hint(result, url) {
  switch (result.kind) {
    case 'version':
      return '线上一直有回答、但一直是同一个版本：多半是部署那一步没跑到（构建失败、钩子没触发、或者那次推送根本没到这台服务器）。先看服务器上的构建日志。'
    case 'missing':
      return '这个地址回答的不是这一版应用的页面（反向代理的错误页、别的服务、或者一个比这个 meta 还早的旧构建）。'
    case 'http':
      return '服务器在，但这个地址拿不到页面：先看部署进程起没起来（docker compose ps），再重跑一次检查。'
    default:
      return `${url.href} 连不上：先排除网络（这台机器能打开这个地址吗），再怀疑部署。`
  }
}

const fmt = (ms) => `${(ms / 1000).toFixed(1)}s`
const reportPath = (file) => join(REPORT_DIR, file)

function writeReport(report) {
  mkdirSync(REPORT_DIR, { recursive: true })
  writeFileSync(reportPath('report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(
    reportPath('report.md'),
    [
      `# 部署自检 — ${report.at}`,
      '',
      `- 地址：${report.url}`,
      `- 本地版本：${report.localVersion}`,
      `- 线上版本：${report.liveVersion ?? '（没读到）'}`,
      `- 结果：${report.message}`,
      `- 用时：${fmt(report.elapsedMs)}，看了 ${report.looks} 次（每 ${fmt(report.intervalMs)} 一次，最多等 ${fmt(report.timeoutMs)}）`,
      '',
      '## 每次变化',
      '',
      '| 时刻 | 看到 |',
      '| --- | --- |',
      ...report.observations.map((o) => `| ${fmt(o.atMs)} | ${describe(o.result)} |`),
      '',
    ].join('\n'),
  )
}

const { url, timeoutS, intervalS } = parseArgs(process.argv.slice(2))
const expected = localVersion()
const timeoutMs = timeoutS * 1000
const intervalMs = intervalS * 1000
const startedAt = Date.now()
const deadline = startedAt + timeoutMs

console.log(`  ..  检查 ${url.href}，等的是 ${expected}（最多 ${timeoutS}s，每 ${intervalS}s 看一次）`)

let last = null
let lastIdentity = null
let lastPrintedAt = 0
let looks = 0
let matched = false
const observations = []

for (;;) {
  last = await look(url)
  looks += 1
  const at = Date.now() - startedAt
  const identity = JSON.stringify(last)
  const changed = identity !== lastIdentity
  if (changed) observations.push({ atMs: at, result: last })
  if (changed || at - lastPrintedAt >= HEARTBEAT_MS) {
    console.log(`  ..  ${fmt(at)}：${describe(last)}`)
    lastPrintedAt = at
  }
  lastIdentity = identity

  if (last.kind === 'version' && last.version === expected) {
    matched = true
    break
  }
  if (Date.now() >= deadline) break
  await sleep(intervalMs)
}

const elapsedMs = Date.now() - startedAt
const message = matched ? `线上已是 ${expected}` : `${fmt(elapsedMs)} 内没等到 ${expected}：${describe(last)}`
if (matched) console.log(`  ok  ${message} — ${fmt(elapsedMs)}、${looks} 次`)
else {
  console.log(` FAIL  ${message}（看了 ${looks} 次）`)
  console.log(`       ${hint(last, url)}`)
}
console.log(`       报告：${reportPath('report.md')}`)
writeReport({
  at: new Date(startedAt).toISOString(),
  url: url.href,
  localVersion: expected,
  liveVersion: last.kind === 'version' ? last.version : null,
  last,
  ok: matched,
  elapsedMs,
  looks,
  timeoutMs,
  intervalMs,
  observations,
  message,
})
process.exitCode = matched ? 0 : 1
