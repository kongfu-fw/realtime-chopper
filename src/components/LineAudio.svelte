<script lang="ts">
  import { session } from '../lib/app/state'
  import type { Line } from '../lib/types'

  /**
   * The original audio of one line, loaded on demand.
   *
   * Requirement 12 asks for the audio and the text side by side in debug mode.
   * The samples are not carried on the line any more, so the WAV is cut out of
   * the session recording when this element appears — and only then.
   */
  interface Props {
    line: Line
  }

  let { line }: Props = $props()

  let url = $state<string | null>(null)
  let missing = $state(false)

  $effect(() => {
    let cancelled = false
    void session.lineAudio(line.id).then((blob) => {
      if (cancelled) return
      if (!blob) {
        missing = true
        return
      }
      url = URL.createObjectURL(blob)
    })
    return () => {
      cancelled = true
      if (url) {
        URL.revokeObjectURL(url)
        url = null
      }
    }
  })
</script>

{#if url}
  <audio controls src={url} style="width:100%;margin-top:6px"></audio>
{:else if missing}
  <div>（这句没有录音，可能是录音已删除）</div>
{:else}
  <div>正在取出录音…</div>
{/if}
