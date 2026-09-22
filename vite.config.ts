import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte()],
  // PWA is served from a sub-path-friendly relative base.
  base: './',
  publicDir: 'static',
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // onnxruntime-web ships its own wasm assets and must stay un-prebundled so
    // the dynamic import inside asr.worker.ts keeps working in dev.
    exclude: ['onnxruntime-web', '@huggingface/transformers'],
  },
  build: {
    target: 'es2022',
    // The ASR runtime is a large lazy chunk on purpose: it is only fetched when
    // a speech-recognition module is actually installed/loaded.
    chunkSizeWarningLimit: 4096,
  },
  server: {
    host: '127.0.0.1',
    port: 5273,
  },
  preview: {
    host: '127.0.0.1',
    port: 5274,
  },
})
