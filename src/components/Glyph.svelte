<script lang="ts">
  /**
   * The three glyphs the shell draws, in one place.
   *
   * Inline SVG rather than emoji: an emoji is rendered by the *platform*, so the
   * same button is a different picture on iOS, on Android and on a laptop — and
   * the two that matter here (a download arrow and the voice mark) are exactly
   * the shapes a platform is most opinionated about. Inline also means the icon
   * inherits `currentColor`, so it follows the button's own state instead of
   * needing a second rule per state.
   */
  interface Props {
    name: 'download' | 'voice' | 'sliders'
    /** Height in px; the box is square. */
    size?: number
  }

  let { name, size = 16 }: Props = $props()
</script>

{#if name === 'download'}
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 3.5v11" />
    <path d="M7.5 10.5 12 15l4.5-4.5" />
    <path d="M4.5 19.5h15" />
  </svg>
{:else if name === 'voice'}
  <!--
    The voice-message mark: a small dot with arcs fanning out of it, the shape
    every Chinese phone user has tapped a thousand times. The label beside it
    says what the switch does; this says "voice", which is what the button is.
  -->
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
    <circle cx="5" cy="19.5" r="1.6" fill="currentColor" stroke="none" />
    <path d="M5 14.8a4.7 4.7 0 0 1 4.7 4.7" />
    <path d="M5 10.6a8.9 8.9 0 0 1 8.9 8.9" />
    <path d="M5 6.4A13.1 13.1 0 0 1 18.1 19.5" />
  </svg>
{:else}
  <!-- Sliders rather than a cogwheel: it survives being drawn at 16 px, which a
       8-tooth gear does not. -->
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
    <path d="M3.5 7h17" />
    <path d="M3.5 12h17" />
    <path d="M3.5 17h17" />
    <circle cx="15" cy="7" r="2.4" fill="currentColor" stroke="none" />
    <circle cx="9" cy="12" r="2.4" fill="currentColor" stroke="none" />
    <circle cx="17" cy="17" r="2.4" fill="currentColor" stroke="none" />
  </svg>
{/if}
