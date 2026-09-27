/// <reference types="vite/client" />

/**
 * A content hash of `static/sherpa-asr.worker.js`, stamped in by the build
 * (`SHERPA_WORKER_REV` in `vite.config.ts`).
 *
 * It gives that worker's URL a different identity per build, so a browser cannot
 * pair this build's client with a previous build's worker. `vite.config.ts`
 * carries the long version of why that is worth a global.
 */
declare const __SHERPA_WORKER_REV__: string

declare module '*.svelte' {
  import type { Component } from 'svelte'
  const component: Component<Record<string, unknown>>
  export default component
}
