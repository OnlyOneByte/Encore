<script lang="ts">
	/* The real vaul handle: the element carrying `data-vaul-handle` plus its own hit-area span. The registry's
	   decorative div is not a substitute — with `handleOnly` on the Root and no element carrying that attribute, vaul has
	   nothing to restrict dragging to and the sheet cannot be dragged at all, silently. */
	import { Drawer as DrawerPrimitive } from 'vaul-svelte';
	import { cn } from '$lib/utils.js';

	let { ref = $bindable(null), class: className, ...restProps }: DrawerPrimitive.HandleProps = $props();
</script>

<DrawerPrimitive.Handle
	bind:ref={ref}
	data-slot="drawer-handle"
	class={cn('bg-muted mx-auto mt-4 w-[100px] shrink-0 rounded-full', className)}
	{...restProps}
/>

<style>
	/* THE GRAB AREA IS BIGGER THAN THE BAR IT DRAWS: vaul renders a hit-area span for exactly this but ships no
	   dimensions, so without these rules the drag target is the 6px bar. The bar's height must stay a TOKEN rather than a
	   Tailwind class, because the hit-area rule subtracts it from --tap and a literal there drifts the centring. */
	:global([data-slot='drawer-handle']) {
		height: var(--space-xs);
		/* THE ONE SIGNPOST THAT THE BAND OPENS, and it was invisible. `bg-muted` aliases `--card2` (#212133)
		   over a `--card`-derived sheet (#1a1a28): measured 1.09:1, against SC 1.4.11's 3:1 floor for a
		   non-text control boundary. This 6px bar is the only affordance saying the band can be pulled up to
		   reach the transport, the +/- semitone caps and the guiding track, so at party brightness the whole
		   drawer read as a fixed strip — which wasted every bit of the careful --tap hit-area arithmetic below
		   it, since nothing told a guest there was anything to grab.
		   38% measures 3.32:1: over the floor, and deliberately short of --ink-dim's 6.27:1, because a handle
		   that reads as bright as body text reads as a control. The `bg-muted` class is left in the list above
		   so the next re-vendor diff still shows what the registry ships. */
		background: color-mix(in srgb, var(--ink) 38%, transparent);
	}
	:global([data-slot='drawer-handle'] [data-vaul-handle-hitarea]) {
		display: block;
		height: var(--tap);
		/* The overhang comes back out of the flow, so a full-tap grab area costs the header no height. */
		margin-block: calc((var(--tap) - var(--space-xs)) / -2);
		/* Wider than the drawn bar, so the grab area is findable without drawing a wider handle. */
		width: 240px;
		margin-inline: auto;
	}
</style>
