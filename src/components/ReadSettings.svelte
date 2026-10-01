<script lang="ts">
  import Modal from './Modal.svelte'
  import SettingRow from './SettingRow.svelte'
  import { session } from '../lib/app/state'
  import { settings, setSetting, ttsVoiceFor } from '../lib/store/settings'
  import { createTtsEngine, ttsConfigFrom, ttsEngineLabel, type TtsEngine } from '../lib/tts/engine'
  import { ensureVoices, voiceList, voiceListFor } from '../lib/tts/voices.ts'
  import { providerLabel } from '../lib/mt/probe'
  import { info } from '../lib/log/store'
  import { t, translator, uiLang } from '../lib/i18n/index.ts'
  import type { MtProviderId } from '../lib/store/settings'
  import type { TtsEngineId } from '../lib/tts/engine'

  const tr = $derived(translator($uiLang))

  /**
   * Everything about how this app speaks, in one dialog next to the switch that
   * turns speaking on and off.
   *
   * Three settings that only make sense together, and that used to be in three
   * places: the translation provider was in the settings screen, the engine was in
   * the settings screen's 朗读 section, and the voice was a picker in the
   * translation panel's header. All three answer the same question — "what comes
   * out of the phone" — and the answer has to be reachable while a lesson is
   * running, which the settings screen is not: opening it leaves the transcript.
   *
   * The advanced half of the read-aloud settings (base rate, auto speedup, the
   * Edge proxy address) is deliberately *not* here: those are set once and then
   * never touched, so they live in the debug settings with the rest of the
   * set-once controls. What is here is what a user changes mid-lesson.
   */
  interface Props {
    onclose: (reason?: string) => void
  }

  let { onclose }: Props = $props()

  const chosenVoice = $derived(ttsVoiceFor($settings))
  const hasLlmKey = $derived($settings.llmApiKey.trim() !== '')

  const ttsEngine = $derived<TtsEngine>(createTtsEngine(ttsConfigFrom($settings)))

  /**
   * The voice list — loaded before this dialog was opened, not while it is on
   * screen.
   *
   * It used to be fetched right here, in an effect, which is what made the picker
   * render its placeholder (`正在读取音色…`) and then grow a list of options a
   * moment later: the rows under it moved, and so did whatever the finger was
   * already reaching for. `lib/tts/voices.ts` now keeps the list for the current
   * settings loaded and cached, so the picker draws its options on the first frame.
   *
   * This effect is the one case that module cannot cover for itself: a dialog
   * opened for a key nothing has asked about yet — a proxy address typed into
   * another screen, opened here before that write came back.
   */
  const list = $derived(voiceListFor($settings, $voiceList))
  $effect(() => ensureVoices($settings))

  /**
   * Switching engines swaps a whole voice namespace, so the engine is rebuilt and
   * the picker above re-reads its list — the two engines have no voice names in
   * common.
   */
  function pickTtsEngine(id: TtsEngineId) {
    if (id === $settings.ttsEngine) return
    setSetting('ttsEngine', id)
    info('ui', t('朗读引擎换为{engine}', { engine: ttsEngineLabel(id) }), {
      [t('说明')]:
        id === 'edge'
          ? t('走代理 {url}', { url: $settings.ttsProxyUrl })
          : t('用系统音色，不需网络'),
    })
  }

  function pickProvider(id: MtProviderId) {
    if (id === $settings.mtProvider) return
    setSetting('mtProvider', id)
    session.applySettings()
    info('ui', t('翻译引擎换为{name}', { name: providerLabel(id, $uiLang) }))
  }
</script>

<Modal title={tr('朗读设置')} onclose={onclose}>
  <SettingRow label={tr('翻译用哪家')} help={tr('默认谷歌；谷歌用不了会自动换微软。AI 模型要先在调试设置里填好密钥，才能选这一项。')}>
    <select
      class="rc-select"
      value={$settings.mtProvider}
      onchange={(e) => pickProvider((e.currentTarget as HTMLSelectElement).value as MtProviderId)}
    >
      <option value="google">{providerLabel('google', $uiLang)}</option>
      <option value="microsoft">{providerLabel('microsoft', $uiLang)}</option>
      <!-- An option that cannot work is shown and refused, not hidden: the user
           looking for it has to learn what it needs, and a missing entry reads as
           a feature that does not exist. -->
      <option value="llm" disabled={!hasLlmKey}>
        {providerLabel('llm', $uiLang)}{hasLlmKey ? '' : tr('（需要先填密钥）')}
      </option>
    </select>
  </SettingRow>

  <SettingRow
    label={tr('朗读引擎')}
    help={tr('默认用系统自带的朗读：不需要网络，句子之间几乎没有间隙，手机上还能在「设置 → 辅助功能 → 朗读内容」里装更好的音色。换成「Edge TTS 代理」则读的是微软的在线神经音色（你自己的代理，见调试设置），各平台听起来一样好，代价是每句一次网络请求、断网时读不出来。')}
  >
    <select
      class="rc-select"
      value={$settings.ttsEngine}
      onchange={(e) => pickTtsEngine((e.currentTarget as HTMLSelectElement).value as TtsEngineId)}
    >
      <option value="system">{tr('系统朗读（默认）')}</option>
      <option value="edge">{tr('Edge TTS 代理')}</option>
    </select>
  </SettingRow>

  <SettingRow label={tr('朗读音色')}>
    <select
      class="rc-select"
      aria-label={tr('朗读音色')}
      title={`${tr('朗读音色')} · ${ttsEngineLabel($settings.ttsEngine, $uiLang)}${list.error ? ` · ${list.error}` : ''}`}
      value={chosenVoice}
      disabled={list.loading || list.voices.length === 0}
      onchange={(e) => {
        const value = (e.currentTarget as HTMLSelectElement).value
        setSetting($settings.ttsEngine === 'edge' ? 'edgeVoice' : 'voiceURI', value)
      }}
    >
      {#if list.voices.length === 0}
        <option value="">
          {list.loading
            ? tr('正在读取音色…')
            : !ttsEngine.available
              ? $settings.ttsEngine === 'edge'
                ? tr('没填 TTS 代理地址（在调试设置里）')
                : tr('这个浏览器不支持语音朗读')
              : list.error
                ? tr('音色读取失败（见日志）')
                : tr('没有可用音色')}
        </option>
      {:else}
        <option value="">{tr('默认音色')}</option>
        {#each list.voices as voice (voice.voiceURI)}
          <option value={voice.voiceURI}>{voice.name}{voice.localService ? '' : tr('（网络）')}</option>
        {/each}
      {/if}
    </select>
  </SettingRow>

  {#snippet footer()}
    <button class="rc-btn accent" onclick={() => onclose(t('点完成'))}>{tr('完成')}</button>
  {/snippet}
</Modal>
