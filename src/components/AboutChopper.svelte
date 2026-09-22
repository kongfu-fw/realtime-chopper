<script lang="ts">
  import Modal from './Modal.svelte'
  import { APP_NAME, iconDataUrl } from '../lib/brand/logo'
  import { settings } from '../lib/store/settings'

  interface Props {
    onclose: () => void
  }

  let { onclose }: Props = $props()

  // Whatever colourway the user picked in settings is the one that turns up
  // here — the easter egg should look like the mark in their own header.
  const art = $derived(iconDataUrl($settings.appIcon))
</script>

<!--
  The easter egg behind clicking the mascot or the name in the header.

  It shows the app's *own* little deer — the mascot drawn in `lib/brand/logo.ts`,
  not the character the app is named after: that design belongs to its author, so
  the mark here stays ours (see the note at the top of `logo.ts`). The name, and
  the story told below, are what tie the app to the anime.

  Copy rules of the house apply: short sentences a child could follow, one idea
  per line, and no explaining anything the reader did not ask about.
-->
<Modal title={`我是${APP_NAME}`} {onclose}>
  <div class="hero">
    <img src={art} alt="一只戴着耳机的小鹿" width="132" height="132" />
  </div>

  <p class="lead">我来自《海贼王》，作者最喜欢的动漫。</p>
  <p>我是一只驯鹿，也有一半是人。</p>
  <p>动物说的话、人说的话，我都能听懂。</p>
  <p class="hope">所以在这儿当翻译，正合适 —— 希望我帮得上你。</p>
  <p class="hint">想再见到我，点标题栏的小鹿就行。</p>

  {#snippet footer()}
    <button class="rc-btn accent" onclick={onclose}>好，翻译去</button>
  {/snippet}
</Modal>

<style>
  .hero {
    display: flex;
    justify-content: center;
    margin: 2px 0 14px;
  }

  .hero img {
    display: block;
    /* A single friendly nod, then it holds still. */
    animation: bob 620ms ease-out 1;
  }

  p {
    margin: 0 0 9px;
    line-height: 1.6;
  }

  .lead {
    font-weight: 600;
  }

  .hope {
    margin-top: 12px;
  }

  .hint {
    margin: 14px 0 0;
    font-size: 12px;
    color: var(--rc-ink-soft);
  }

  @keyframes bob {
    0% {
      transform: translateY(-8px) rotate(-4deg);
    }
    55% {
      transform: translateY(2px) rotate(2deg);
    }
    100% {
      transform: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .hero img {
      animation: none;
    }
  }
</style>
