<!--
  THE SCOPE EYEBROW: one line inside a card header, above the title, naming what a change in this card reaches.

  It is the SECTION register — `--ph-text-xs`, 0.14em, uppercase, weight 700, `--ink-dim` — which is the dress
  `app.css` reserves for a heading over a list or an eyebrow over a BLOCK, and a card is a block. It may never land
  on or inside a `<Field.Label>` or a `.control-label`; this renders a sibling of `Card.Title`, never of a control,
  so it cannot. The tracking is `.grouphead`'s own 0.14em and the values are spelled the way the `eyebrow` button
  variant spells them, so there is one register in the app and not a second one 0.04em away from it.

  It carries `.grouphead`'s dress with `.grouphead`'s SECTION margin removed: this sits inside the header it belongs
  to, so its boundary below is the intra-group rung, and `Card.Header`'s own 4px grid gap is already most of it.

  It lives here, beside the other card parts, because it is one dress read by three routes — and because a utility
  class is only emitted for sources under `src/lib/components/ui/`.
-->
<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLParagraphElement>> = $props();
</script>

<p
	bind:this={ref}
	data-slot="card-scope"
	class={cn(
		'm-0 mb-[var(--space-3xs)] text-[length:var(--ph-text-xs)] font-bold tracking-[0.14em] text-[var(--ink-dim)] uppercase',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</p>
