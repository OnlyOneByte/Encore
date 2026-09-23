<script lang="ts">
	/*
	 * The real vaul handle, which is the element carrying `data-vaul-handle` plus its own hit-area span.
	 * The registry's decorative div is not a substitute: with `handleOnly` on the Root and no element
	 * carrying that attribute, vaul has nothing to restrict dragging to and the sheet cannot be dragged at
	 * all, silently. The app needs `handleOnly` because the sheet's body holds sliders, and a
	 * drag-to-dismiss surface under a slider fights the thumb.
	 */
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
	/*
	 * THE GRAB AREA IS BIGGER THAN THE BAR IT DRAWS: vaul renders a hit-area span for exactly this but
	 * ships no dimensions, so without these rules the drag target is the 6px bar. The bar's height must
	 * stay a TOKEN rather than a Tailwind class, because the hit-area rule subtracts it from --tap and a
	 * literal on one side of that arithmetic silently drifts the centring. Global because the span is
	 * rendered by a child component, which a scope hash cannot reach.
	 */
	:global([data-slot='drawer-handle']) {
		height: var(--space-xs);
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
