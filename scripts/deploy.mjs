#!/usr/bin/env node
/**
 * Pushes a branch, then waits for the server to actually serve it.
 *
 * Deployment here is a push: the branch goes to the git server, the server builds
 * and swaps what nginx serves. What a push returning proves is that the server has
 * the *commit*; the built page is a build — and a container swap — later, and until
 * it lands, every look at the URL is a look at the previous build. So this wraps
 * the two steps into one command: push to the deployment remote, then run
 * `verify-deploy.mjs`, which polls the served `index.html` until it carries the
 * `APP_VERSION` of this checkout, and fails loudly if it never does.
 *
 * Which remote gets the push: the URL behind `origin`, because that is the git
 * server (see `git remote -v`). The push goes to the URL rather than to the remote
 * *name* on purpose — `git push origin` also hands the commit to the GitHub mirror
 * configured as a second push URL on the same remote, and that mirror needs
 * credentials this machine does not keep (a run of it was left waiting on a
 * credential window). A deploy script that stops at a prompt, or that reports
 * failure because a mirror did, is a deploy script that lies about the thing it
 * just did. `RC_DEPLOY_REMOTE` (or `--remote`) points it somewhere else.
 *
 * Two things it says out loud rather than fixing:
 *
 * - a dirty worktree: whatever is modified on disk is *not* in the commit being
 *   pushed, and the version check below cannot see that — it compares versions,
 *   and an uncommitted change does not move the version;
 * - a version already live: if the server already serves this checkout's version
 *   before the push, then the check below cannot tell this deployment apart from
 *   the previous one. Usually that means a missing `APP_VERSION` bump.
 *
 * Arguments it does not use itself (`--url`, `--timeout`, `--interval`) are passed
 * to `verify-deploy.mjs` unchanged.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const VERIFY = fileURLToPath(new URL('./verify-deploy.mjs', import.meta.url))

/** The meta rule again, copied the same way and for the same reason as in verify-deploy.mjs. */
function appVersionFromHtml(html) {
  const meta = /<meta\s[^>]*name=["']app-version["'][^>]*>/i.exec(html)
  if (!meta) return null
  const content = /content=["']([^"']*)["']/i.exec(meta[0])
  const version = content?.[1].trim()
  return version ? version : null
}

function fail(message) {
  console.log(` FAIL  ${message}`)
  process.exit(1)
}

/** `git` with output collected; `stdio: 'inherit'` is used for the one command a person may have to answer. */
function git(args, options = {}) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...options })
  if (result.error) fail(`跑不起 git：${result.error.message}`)
  return result
}

function gitOrFail(args, what) {
  const result = git(args)
  if (result.status !== 0) fail(`${what}：${result.stderr.trim() || result.stdout.trim()}`)
  return result.stdout.trim()
}

// ---------------------------------------------------------------- arguments

let remote = process.env.RC_DEPLOY_REMOTE ?? ''
let urlOption = ''
const forwarded = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '-h' || arg === '--help') {
    console.log(`用法：node scripts/deploy.mjs [--remote <名字或地址>] [verify-deploy.mjs 的选项]

推送当前分支到部署服务器（默认：origin 的地址），然后等线上真的换成这个版本。
  --remote <名字或地址>  推到哪里（默认取 \`git remote get-url origin\`；也可用 RC_DEPLOY_REMOTE）
  --url / --timeout / --interval   原样交给 scripts/verify-deploy.mjs（--help 看它的说明）`)
    process.exit(0)
  } else if (arg === '--remote') {
    if (i + 1 >= argv.length) fail('缺少 --remote 的值')
    remote = argv[++i]
  } else if (arg.startsWith('--remote=')) {
    remote = arg.slice('--remote='.length)
  } else if (arg === '--url') {
    if (i + 1 >= argv.length) fail('缺少 --url 的值')
    urlOption = argv[++i]
    forwarded.push('--url', urlOption)
  } else if (arg.startsWith('--url=')) {
    urlOption = arg.slice('--url='.length)
    forwarded.push(arg)
  } else {
    forwarded.push(arg)
  }
}

const target = remote || gitOrFail(['remote', 'get-url', 'origin'], '取不到 origin 的地址（用 RC_DEPLOY_REMOTE 指定）')
const branch = gitOrFail(['rev-parse', '--abbrev-ref', 'HEAD'], '取不到当前分支')
if (branch === 'HEAD') fail('现在是分离头指针状态，不知道该推哪个分支')
const head = gitOrFail(['rev-parse', '--short', 'HEAD'], '取不到 HEAD')

// ---------------------------------------------------------------- what is about to go out

const status = git(['status', '--porcelain']).stdout.trim()
if (status) {
  console.log('  ..  工作区有未提交的改动 —— 这次推的是最后一次提交，磁盘上那些改动不在里面：')
  for (const line of status.split('\n').slice(0, 10)) console.log(`        ${line}`)
  if (status.split('\n').length > 10) console.log('        （还有更多）')
}

const localVersion = readFileSync(join(ROOT, 'src', 'lib', 'app', 'version.ts'), 'utf8').match(
  /APP_VERSION = '([^']+)'/,
)?.[1]
if (!localVersion) fail('读不出 src/lib/app/version.ts 里的 APP_VERSION')

/**
 * One look before the push, only to say the one thing the check after it cannot:
 * a server that already serves this version makes a green result meaningless.
 *
 * The address is the one the wait will use — `--url`, then `RC_DEPLOY_URL`, then
 * the default `verify-deploy.mjs` states. It is written out again here rather than
 * imported (importing that file would run its whole check, which has not been
 * asked for yet); the two defaults agreeing is worth one line.
 */
let liveVersion = null
try {
  const raw = urlOption || process.env.RC_DEPLOY_URL || 'kongfu-onedrive.kooka-salmon.ts.net'
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
  if (response.ok) liveVersion = appVersionFromHtml(await response.text())
} catch {
  // Not the subject of this script: verify-deploy.mjs is the one that reports it.
}
if (liveVersion === localVersion) {
  console.log(`  ..  注意：线上已经是 ${localVersion} 了。这次推送若没有把版本号再往前推一格，下面的自检就分不出「这次部署」和「上一次部署」。`)
}

// ---------------------------------------------------------------- push

console.log(`  ..  推送 ${branch} → ${target}`)
const pushed = git(['push', target, `HEAD:refs/heads/${branch}`], {
  stdio: 'inherit',
  // Not a terminal prompt, but not a hard no either: the credential manager's
  // window is still allowed to open, while git asking on stdin would hang a run
  // nobody is watching.
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
})
if (pushed.status !== 0) {
  // `process.exitCode`, not `fail()`: this process has already made a request (the
  // pre-push look), and calling `process.exit()` after one is what crashes Node on
  // Windows — see the note at the top of `verify-deploy.mjs`.
  console.log(` FAIL  推送失败（git 退出码 ${pushed.status}）—— 服务器没有拿到这次提交，下面的等待没有意义。修好后重跑 npm run deploy，或者直接用 npm run verify:deploy 等别人推上去的那一版。`)
  process.exitCode = 1
} else {
  console.log(`  ok  已推送 ${head} → ${branch}`)

  // -------------------------------------------------------------- wait

  const waited = spawnSync(process.execPath, [VERIFY, ...forwarded], { stdio: 'inherit' })
  process.exitCode = waited.status ?? 1
}
