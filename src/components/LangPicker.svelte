<script lang="ts">
  import {
    settings,
    setSetting,
    SOURCE_ORDER,
    TARGET_ORDER,
    langLabel,
  } from '../lib/store/settings'
  import { info } from '../lib/log/store'
  import { t, translator, uiLang } from '../lib/i18n/index.ts'
  import type { SourceLang, TargetLang } from '../lib/types'

  const tr = $derived(translator($uiLang))

  /**
   * The language pair, split across the two panels it belongs to.
   *
   * It used to be one control in the middle of the title bar, which put the two
   * halves of one question in the one place neither answer happens: the header is
   * where the clock now lives, and "what goes in" is the original panel's business
   * while "what comes out" is the translation panel's. The `说` and `译` labels
   * are kept, and so is the arrow's job of saying which is which — they are two
   * chars each and they are the only thing that makes the two pickers tell each
   * other apart at a glance.
   */
  interface Props {
    which: 'source' | 'target'
  }

  let { which }: Props = $props()

  /**
   * Switching the source language does not switch recognisers any more.
   *
   * There is one module and it is multilingual, deciding the language of each
   * utterance itself (`asr/models.ts`), so the engine that answered the old
   * language answers the new one — nothing to release, nothing to load. This used
   * to drop the resident model here, which was right when each language had bytes
   * of its own and two models must never be resident at once.
   */
  function changeSource(lang: SourceLang) {
    if (lang === $settings.sourceLang) return
    setSetting('sourceLang', lang)
    info('ui', t('识别语言切换为{lang}', { lang: langLabel(lang) }))
  }

  /**
   * Switching the output language drops the chosen voice.
   *
   * A voice is a voice *of a language*: a Chinese voice reading Korean falls back
   * to reading it in Chinese, which is worse than the engine's own choice for the
   * new language. The clear is not logged on its own — the picker beside it shows
   * the consequence.
   */
  function changeTarget(lang: TargetLang) {
    if (lang === $settings.targetLang) return
    setSetting('targetLang', lang)
    setSetting('voiceURI', '')
    info('ui', t('译文语言切换为{lang}', { lang: langLabel(lang) }))
  }
</script>

<label class="lang">
  <span class="lang-label">{which === 'source' ? tr('说') : tr('译')}</span>
  {#if which === 'source'}
    <select
      class="rc-select pick"
      value={$settings.sourceLang}
      onchange={(e) => void changeSource((e.currentTarget as HTMLSelectElement).value as SourceLang)}
      aria-label={tr('源语言')}
    >
      {#each SOURCE_ORDER as lang (lang)}
        <option value={lang}>{langLabel(lang, $uiLang)}</option>
      {/each}
    </select>
  {:else}
    <select
      class="rc-select pick"
      value={$settings.targetLang}
      onchange={(e) => changeTarget((e.currentTarget as HTMLSelectElement).value as TargetLang)}
      aria-label={tr('译文语言')}
    >
      {#each TARGET_ORDER as lang (lang)}
        <option value={lang}>{langLabel(lang, $uiLang)}</option>
      {/each}
    </select>
  {/if}
</label>

<style>
  .lang {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    /* The header holds a title on each side of this: the picker gives way rather
       than pushing the title off the edge. */
    min-width: 0;
  }

  .lang-label {
    font-size: 12px;
    color: var(--rc-ink-soft);
  }

  /*
   * A native <select> sizes itself to its widest option, and the widest option
   * here is a language name that the reader already chose. Capped so the two
   * headers keep the same shape on a phone, where the panel is 393 px wide and
   * the export button has to fit beside it.
   */
  .pick {
    max-width: 84px;
    min-width: 0;
    font-size: 13px;
  }
</style>
