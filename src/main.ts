import { mount } from 'svelte'
import App from './App.svelte'
import { t } from './lib/i18n/index.ts'
import './app.css'

const target = document.getElementById('app')
if (!target) throw new Error(t('缺少 #app 挂载点'))

mount(App, { target })

/**
 * The service worker exists for offline shell loading and for making the app
 * installable (requirement 14). It intentionally does not touch model or
 * translation traffic: those are cached by the browser's own Cache Storage
 * entries, where the size and the eviction rules are ours to reason about.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(() => undefined)
  })
}
