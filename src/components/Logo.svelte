<script lang="ts">
  import { MARK } from '../lib/brand/logo'

  interface Props {
    /** Height in px; the width follows the mark's own aspect ratio. */
    size?: number
  }

  let { size = 24 }: Props = $props()

  // Tight view box around the antlers, cups and head, so the mascot fills the
  // space instead of floating in a 64-box with margins.
  const BOX = { x: 8, y: 0.8, w: 48, h: 58.4 }
</script>

<!--
  The mark, in the app's own palette: currentColor for the animal (so it can sit
  on any background), the accent for the ear cups, and the page colour for the
  eyes and muzzle so they read as openings in the face.

  The two-tone treatment is deliberate — at 24 px an outline drawn in the same
  colour as the fill is invisible, so the icon's bold outlines are simply left
  off here. Same geometry, fewer strokes.

  Decorative: the name is right next to it, so announcing it twice would only
  make the header noisier for screen readers.
-->
<svg
  class="mark"
  viewBox={`${BOX.x} ${BOX.y} ${BOX.w} ${BOX.h}`}
  width={Math.round((size * BOX.w) / BOX.h)}
  height={size}
  aria-hidden="true"
  focusable="false"
>
  {#each MARK.ears as ear (ear.cx)}
    <ellipse
      cx={ear.cx}
      cy={ear.cy}
      rx={ear.rx}
      ry={ear.ry}
      transform={`rotate(${ear.rot} ${ear.cx} ${ear.cy})`}
      fill="currentColor"
    />
  {/each}

  {#each MARK.antler.paths as d (d)}
    <path
      {d}
      fill="none"
      stroke="currentColor"
      stroke-width={MARK.antler.width}
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  {/each}

  <path d={MARK.head} fill="currentColor" />

  <path
    d={MARK.phones.band}
    fill="none"
    stroke="var(--rc-accent)"
    stroke-width={MARK.phones.width}
    stroke-linecap="round"
    stroke-linejoin="round"
  />
  {#each MARK.phones.cups as cup (cup.cx)}
    <ellipse
      cx={cup.cx}
      cy={cup.cy}
      rx={cup.rx}
      ry={cup.ry}
      transform={`rotate(${cup.rot} ${cup.cx} ${cup.cy})`}
      fill="var(--rc-accent)"
    />
  {/each}

  <ellipse
    cx={MARK.muzzle.cx}
    cy={MARK.muzzle.cy}
    rx={MARK.muzzle.rx}
    ry={MARK.muzzle.ry}
    fill="var(--rc-bg)"
  />
  <ellipse cx={MARK.nose.cx} cy={MARK.nose.cy} rx={MARK.nose.rx} ry={MARK.nose.ry} fill="currentColor" />
  {#each MARK.eyes.list as eye (eye.cx)}
    <circle cx={eye.cx} cy={eye.cy} r={MARK.eyes.sclera} fill="var(--rc-bg)" />
    <circle cx={eye.cx} cy={eye.cy + MARK.eyes.pupilDy} r={MARK.eyes.pupil} fill="currentColor" />
  {/each}
</svg>

<style>
  .mark {
    display: block;
    flex: 0 0 auto;
  }
</style>
