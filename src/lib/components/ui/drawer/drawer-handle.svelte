<script lang="ts">
	/*
	 * THE HANDLE SHADCN'S DRAWER LEAVES OUT — and leaving it out is a trap, not a simplification.
	 *
	 * `vaul-svelte` exports a real `Drawer.Handle`, which renders the element carrying
	 * `data-vaul-handle` plus its own hit-area span. shadcn's copied `drawer-content.svelte` does not
	 * use it: it renders a DECORATIVE div that looks like a grab handle and drags nothing. That is
	 * harmless while a drawer is draggable from anywhere in its content, and it becomes a silent
	 * failure the moment you set `handleOnly` on the Root — vaul then restricts dragging to the
	 * handle, there is no element carrying the attribute, and the drawer cannot be dragged AT ALL.
	 * Nothing warns; the gesture just stops working.
	 *
	 * Encore needs `handleOnly`, because the drawer's body is sliders (the guiding track) and a
	 * drag-to-dismiss surface underneath a slider fights the thumb — which is the whole substance of
	 * XR-PH-15's ban on a control sharing a drag surface. So this file exists and Content uses it.
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
	 * THE GRAB AREA IS BIGGER THAN THE BAR IT DRAWS. The visible handle is 6px tall, and a 6px drag
	 * target is unusable with a thumb — vaul renders its own `data-vaul-handle-hitarea` span for
	 * exactly this, but ships no dimensions for it, so without this rule the hit area is the bar.
	 *
	 * Sized from `--tap`, never a literal (XR-PH-01), and pulled back with negative margins so the
	 * enlarged target does not add height to the drawer's header. `:global` because the span is
	 * rendered by a child component, which Svelte's scope hash cannot reach.
	 */
	/*
	 * THE BAR'S HEIGHT IS A TOKEN, not shadcn's `h-1.5`. It has to be, because the hit-area rule below
	 * subtracts it from --tap, and a literal on one side of that arithmetic with a Tailwind class on the
	 * other is two sources of truth for one number — change the class and the centring silently drifts.
	 * `--space-xs` is 6px, which is what `h-1.5` resolved to, so the drawn handle is unchanged.
	 */
	:global([data-slot='drawer-handle']) {
		height: var(--space-xs);
	}
	:global([data-slot='drawer-handle'] [data-vaul-handle-hitarea]) {
		display: block;
		height: var(--tap);
		/*
		 * Centre the tap box on the bar and take its overhang back out of the flow, so a full-tap grab
		 * area costs the drawer's header no height. Both terms are tokens (XR-PH-01), so this stays
		 * correct if either moves.
		 */
		margin-block: calc((var(--tap) - var(--space-xs)) / -2);
		/* Wider than the 100px bar, so the grab area is findable without drawing a wider handle. */
		width: 240px;
		margin-inline: auto;
	}
</style>
