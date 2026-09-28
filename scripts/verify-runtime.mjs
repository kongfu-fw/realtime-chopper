#!/usr/bin/env node
/**
 * Checks the runtime this app downloads against what its worker says about it.
 *
 * `static/sherpa-asr.worker.js` can only describe the pinned HuggingFace build from
 * memory: the artifact is 11.7 MB, it is not in the repository, and the comments that
 * justify the worker's whole design — which file system calls the runtime exposes, how
 * much memory it declares, what shape its resource manifest has — are exactly the kind
 * that go stale without anything failing. One of them had: the heap ceiling was written
 * as `max 8192 pages = 512 MB`, when 8192 pages is the *initial* size and the declared
 * maximum is four times that.
 *
 * So nothing here restates the numbers. Every value is parsed out of the worker's own
 * source — the runtime table, the `FS_*` list in the comment, the memory figures in the
 * comment — and then compared against the artifact it describes. `npm run
 * verify:runtime` fails when the pinned commit changes under us, when a comment stops
 * describing the build, or when the patch `initRuntime` applies to the resource
 * manifest stops matching (the failure that would silently stop models from mounting).
 *
 * Needs the network, because that artifact is the thing being checked. Writes nothing.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

/** An argument lets the checker itself be checked against a deliberately wrong copy. */
const worker = readFileSync(
  process.argv[2]
    ? resolve(process.argv[2])
    : fileURLToPath(new URL('../static/sherpa-asr.worker.js', import.meta.url)),
  'utf8',
)

let failures = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

function must(pattern, what) {
  const match = worker.match(pattern)
  if (!match) {
    console.log(` FAIL  ${what} (the worker's source no longer matches this script)`)
    failures += 1
    process.exit(1)
  }
  return match
}

// ------------------------------------------------------------ what the worker claims

const SPACE = must(/const SPACE =\s*\n?\s*'([^']+)'/, 'the pinned runtime URL').at(1)
const runtime = [...must(/const RUNTIME = \{[\s\S]*?\n\}/, 'the runtime table').at(0).matchAll(
  /(\w+): \{ url: SPACE \+ '([^']+)', bytes: (\d+) \}/g,
)].map((match) => ({ role: match[1], url: SPACE + match[2], declared: Number(match[3]) }))

/** The `FS_*` names the comment says are the *only* ones the runtime exports. */
const claimedFs = must(/not exported \(only ([^)]*)\)/, 'the exported-filesystem claim')
  .at(1)
  .match(/FS_\w+/g)

/** The memory figures the comment states, from the wasm's own memory section. */
const claimedMemory = [...worker.matchAll(/`(\d+) pages = (\d+) (MB|GB)`/g)].map((match) => ({
  pages: Number(match[1]),
  mb: Number(match[2]) * (match[3] === 'GB' ? 1024 : 1),
}))
if (claimedMemory.length !== 2) {
  console.log(` FAIL  the memory claim (expected two figures, found ${claimedMemory.length})`)
  process.exit(1)
}

/** The patch `initRuntime` applies to the runtime's embedded resource manifest. */
const patch = must(/mainText\.replace\(\s*\n?\s*(\/.*?\/),/, 'the manifest patch').at(1)
const patchRegex = eval(patch)

console.log(`pinned runtime: ${SPACE}`)
console.log(`files: ${runtime.map((asset) => asset.role).join(', ')}\n`)

// -------------------------------------------------------------------- the artifact

const fetched = new Map()
for (const asset of runtime) {
  const response = await fetch(asset.url)
  const bytes = new Uint8Array(await response.arrayBuffer())
  fetched.set(asset.role, bytes)
  check(
    `${asset.role}: ${asset.declared} bytes`,
    bytes.byteLength === asset.declared,
    bytes.byteLength === asset.declared ? '' : `the server serves ${bytes.byteLength}`,
  )
}

const main = new TextDecoder().decode(fetched.get('main'))
const wasm = fetched.get('wasm')

/** The exported names, counted rather than grepped: the glue is a handful of long lines. */
const exported = [...new Set([...main.matchAll(/Module\["(FS_\w+)"\]/g)].map((match) => match[1]))]
check(
  `the runtime exports exactly ${claimedFs.length} filesystem calls`,
  exported.length === claimedFs.length && claimedFs.every((name) => exported.includes(name)),
  exported.join(', '),
)
check('and no whole filesystem object', !main.includes('Module["FS"]'))

/**
 * The memory section of a wasm module: section id 5, then its limits. Parsed by hand
 * because `WebAssembly.Module.exports()` reports that a memory is exported but not how
 * large it may grow, and instantiating an 11.7 MB runtime to ask is not worth it.
 */
function memoryLimits(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const leb = (at) => {
    let value = 0
    let shift = 0
    for (;;) {
      const byte = bytes[at.at++]
      value |= (byte & 0x7f) << shift
      shift += 7
      if (!(byte & 0x80)) return value
    }
  }
  let at = { at: 8 } // magic + version
  while (at.at < bytes.byteLength) {
    const id = bytes[at.at++]
    const size = leb(at)
    if (id === 5) {
      const count = bytes[at.at++]
      const limits = []
      for (let i = 0; i < count; i++) {
        const flags = bytes[at.at++]
        const min = leb(at)
        const max = flags & 1 ? leb(at) : null
        limits.push({ min, max })
      }
      return limits
    }
    at.at += size
  }
  return []
}

const limits = memoryLimits(wasm)
check('the wasm declares one memory', limits.length === 1, JSON.stringify(limits))
const [memory = { min: -1, max: -1 }] = limits
check(
  `memory: initial ${claimedMemory[0].pages} pages = ${claimedMemory[0].mb} MB`,
  memory.min === claimedMemory[0].pages && (memory.min * 65536) / 1048576 === claimedMemory[0].mb,
  `the wasm says initial ${memory.min} pages`,
)
check(
  `memory: maximum ${claimedMemory[1].pages} pages = ${claimedMemory[1].mb} MB`,
  memory.max === claimedMemory[1].pages && (memory.max * 65536) / 1048576 === claimedMemory[1].mb,
  `the wasm says max ${memory.max} pages`,
)

// The manifest `initRuntime` empties: if its shape changes, the patch silently misses
// and the runtime goes looking for a 367 MB demo pack instead of our model files.
const patched = main.replace(patchRegex, 'loadPackage({"files":[],"remote_package_size":0})')
check('the resource-manifest patch still matches', patched !== main)
check(
  'the manifest names the demo pack the header describes',
  main.includes('"/silero_vad.onnx"') && main.includes('"/zipformer-ctc.onnx"'),
)
check('and its file table is not reached', !patched.includes('"/zipformer-ctc.onnx"'))

console.log(
  failures === 0
    ? '\nthe worker still describes the runtime it downloads.'
    : `\n${failures} claim${failures === 1 ? '' : 's'} no longer match the pinned runtime.`,
)
process.exit(failures === 0 ? 0 : 1)
