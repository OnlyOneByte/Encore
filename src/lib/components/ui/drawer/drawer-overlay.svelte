<script lang="ts">
	import { Drawer as DrawerPrimitive } from 'vaul-svelte';
	import { cn } from '$lib/utils.js';

	let { ref = $bindable(null), class: className, ...restProps }: DrawerPrimitive.OverlayProps = $props();
</script>

<DrawerPrimitive.Overlay
	bind:ref={ref}
	data-slot="drawer-overlay"
	class={cn('bg-black/10 supports-backdrop-filter:backdrop-blur-xs fixed inset-0 z-50', className)}
	{...restProps}
/>

<style>
	/*
	 * THE FADE IS A DECLARATION, NOT A UTILITY — and that is the guard working, not a workaround.
	 *
	 * Stock shadcn ships this overlay with
	 *   data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0
	 * and `motion.test.ts` rejects `animate-*` OUTRIGHT. That is deliberate: a utility-expressed
	 * animation is invisible to the declaration scans by construction, which is the exact
	 * enforcement gap XR-PH-06 exists to close. Written as CSS the same fade is scannable —
	 * composited property only (opacity), duration from the `--motion-*` scale, and gated on
	 * prefers-reduced-motion for its own selector.
	 *
	 * `:global([data-slot='drawer-overlay'])` is the only form that can work here. The class string
	 * is a PROP handed to a component, so Svelte never stamps a scope hash on it and a scoped rule
	 * would match nothing — the failure mode `ui-scoped-style-reach-913.test.ts` was written for.
	 *
	 * The keyframes are `-global-` prefixed because Svelte rewrites scoped keyframe names, and a
	 * `:global()` selector's `animation` shorthand is not rewritten with them — the pair would
	 * silently stop matching.
	 */
	@media (prefers-reduced-motion: no-preference) {
		:global([data-slot='drawer-overlay'][data-open]) {
			animation: drawer-overlay-in var(--motion-base) ease-out;
		}
		:global([data-slot='drawer-overlay'][data-closed]) {
			animation: drawer-overlay-out var(--motion-base) ease-in;
		}
	}
	@keyframes -global-drawer-overlay-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	@keyframes -global-drawer-overlay-out {
		from {
			opacity: 1;
		}
		to {
			opacity: 0;
		}
	}
</style>
