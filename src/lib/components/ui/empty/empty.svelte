<!--
  ── ENCORE DEVIATIONS ─────────────────────────────────────────────────────────────────────────────
  The registry's Empty is a PANEL: `p-12`, a dashed border, `flex-1`, centred, and `text-balance` inside
  a `max-w-sm` header. Encore's empty state is a quiet dim LINE — `.empty` was
  `color: var(--ink-dim); padding: 0 var(--space-2xs); font-size: var(--ph-text-md)`.

  The panel is not a different look here, it is a broken one, and a screenshot is what showed it: on a
  390px phone the queue's nine-word empty sentence rendered as a full-width dashed box roughly 500px
  tall with ONE WORD PER LINE, because `max-w-sm` plus `text-balance` in a centred column had almost no
  room left. It also outweighed the hero above it — an empty queue is the least important thing on that
  screen, and it was drawing the most attention.

  So the structure is kept (Root / Header / Description, which is what makes the copy addressable) and
  the appearance is Encore's.
-->
<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="empty"
	class={cn(
		"encore-empty",
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>

<style>
	.encore-empty {
		color: var(--ink-dim);
		padding: 0 var(--space-2xs);
		font-size: var(--ph-text-md);
	}
</style>
