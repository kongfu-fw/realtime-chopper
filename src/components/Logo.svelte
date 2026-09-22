<script lang="ts">
  import { iconPreviewUrl } from '../lib/brand/logo'
  import { settings } from '../lib/store/settings'

  interface Props {
    /** Height in px; the width follows the artwork's proportions. */
    size?: number
  }

  let { size = 24 }: Props = $props()

  // The same face as the app icon: whatever is picked in 设置 → 外观 → 应用图标 is
  // what sits beside the name, so the header, the settings picker and the home
  // screen can never disagree.
  const art = $derived(iconPreviewUrl($settings.appIcon))
</script>

<!--
  Decorative: the name is right next to it, so announcing the picture too would
  only make the header noisier for screen readers.

  Unlike the mark it replaces, this is the icon's own artwork — a red hat, a
  brown deer — so it cannot be drawn in `currentColor` and follow the theme. It
  is a picture, not a glyph, and it is shown as one.
-->
<img class="mark" src={art} alt="" width={size} height={size} />

<style>
  .mark {
    display: block;
    flex: 0 0 auto;
    /* The artwork is wider than it is tall (except the deer): contain keeps its
       proportions instead of stretching it into the square. */
    object-fit: contain;
    /* Small enough that it never bites into the artwork, big enough that the
       one icon with an opaque background reads as a deliberate tile rather than
       a stray white rectangle in the header. */
    border-radius: 4px;
  }
</style>
