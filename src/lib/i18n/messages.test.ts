import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { DEFAULT_LANG, detectLang, translate } from './index.ts'
import { EN } from './en.ts'
import { KO } from './ko.ts'

/**
 * The two rules the dictionaries live or die by.
 *
 * Because a string is *keyed* by its Chinese text (see `index.ts`), a missing
 * translation is not an error at runtime — it falls back to Chinese, which is
 * exactly what the app did before it had languages at all. That is the right
 * behaviour in production and a silent trap in development: without a check, the
 * English interface would grow a Chinese sentence per release and nobody would
 * notice until a user did.
 *
 * So the first test reads the source tree and refuses to pass while any
 * `t('…')` lacks an entry. Node resolves ESM specifiers literally, hence the
 * `.ts` extensions on the imports above.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
// Ideographs plus CJK punctuation: '、' and '：' are sources too, and a key made
// only of punctuation is still Chinese text rather than an identifier.
const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'static') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sourceFiles(path, out)
    else if (name.endsWith('.ts') || name.endsWith('.svelte')) out.push(path)
  }
  return out
}

/**
 * Every `t('…')` in the code, as `file` + key.
 *
 * Only single-quoted sources are recognized, and that is deliberate: the key has
 * to be readable out of the source text, and a template literal or a variable
 * could not be. Both spellings are scanned — `t`, which reads the language as it
 * is now, and `tr`, the same translator bound to the store inside a component's
 * markup. Both are matched at a word boundary, so `translator(` and `format(` do
 * not fool the scan.
 */
function callSites(): Array<{ file: string; key: string }> {
  const sites: Array<{ file: string; key: string }> = []
  const pattern = /\b(?:t|tr)\(\s*'((?:[^'\\]|\\.)*)'/g
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    // Comments are blanked out rather than scanned: this codebase documents
    // itself with examples like `t('原文')`, and a comment must not be able to
    // demand a translation of its own.
    const source = readFileSync(file, 'utf8')
      .replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '))
      .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (comment) => comment.replace(/[^\n]/g, ' '))
    for (const match of source.matchAll(pattern)) {
      sites.push({ file: file.slice(ROOT.length), key: match[1] })
    }
  }
  return sites
}

test('every wrapped string has an English and a Korean translation', () => {
  const missing: string[] = []
  const notChinese: string[] = []
  const seen = new Set<string>()
  for (const { file, key } of callSites()) {
    if (seen.has(key)) continue
    seen.add(key)
    // A key without Chinese in it is almost always a mistake — an identifier, or
    // an English sentence nobody translated from. Both belong in the value, not
    // in the source text.
    if (!CJK.test(key)) notChinese.push(`${file}: ${key}`)
    if (EN[key] === undefined) missing.push(`en ${file}: ${key}`)
    if (KO[key] === undefined) missing.push(`ko ${file}: ${key}`)
  }
  assert.deepEqual(notChinese, [], 'these t() sources are not Chinese text')
  assert.deepEqual(missing, [], 'these t() sources have no translation')
})

test('the two dictionaries cover the same strings', () => {
  // An entry added to one language and forgotten in the other is the mistake
  // that survives every review, because both files look complete on their own.
  assert.deepEqual(Object.keys(EN).sort(), Object.keys(KO).sort())
})

test('a browser language picks the matching language', () => {
  assert.equal(detectLang(['en-US', 'en']), 'en')
  assert.equal(detectLang(['ko-KR']), 'ko')
  assert.equal(detectLang(['zh-Hans-CN']), 'zh')
  // Traditional Chinese is served by the same interface: the alternative is a
  // Chinese reader getting English because of a region.
  assert.equal(detectLang(['zh-TW']), 'zh')
  // Most preferred first, which is the whole point of reading the list.
  assert.equal(detectLang(['fr-FR', 'ko', 'en']), 'ko')
  assert.equal(detectLang(['de-DE', 'en-GB']), 'en')
  // Nothing we speak: the project's own language, not English.
  assert.equal(detectLang(['de-DE', 'fr']), DEFAULT_LANG)
  assert.equal(detectLang([]), DEFAULT_LANG)
})

test('params are filled in, and a missing one stays visible', () => {
  assert.equal(translate('zh', '已清理 {n} 个模块', { n: 3 }), '已清理 3 个模块')
  // Left as `{n}` rather than becoming `undefined`: a mistyped name has to be
  // obvious on screen, and `undefined` reads like a crash.
  assert.equal(translate('zh', '已清理 {n} 个模块'), '已清理 {n} 个模块')
})

test('an untranslated string falls back to the Chinese it was written as', () => {
  assert.equal(translate('en', '这句话还没有译本'), '这句话还没有译本')
})

test('plural forms are resolved, never shown, and only where they belong', () => {
  for (const [key, value] of Object.entries(EN)) {
    if (!value.includes('|')) continue
    const one = translate('en', key, { n: 1 })
    const many = translate('en', key, { n: 2 })
    assert.equal(one.includes('|'), false, `“${key}” kept its forms at n=1`)
    assert.notEqual(one, many, `“${key}” claims to inflect but does not`)
  }
  // Korean has no number agreement, so a `|` in there is an English entry that
  // was copied over without being read.
  for (const [key, value] of Object.entries(KO)) {
    assert.equal(value.includes('|'), false, `“${key}” carries forms Korean does not need`)
  }
})
