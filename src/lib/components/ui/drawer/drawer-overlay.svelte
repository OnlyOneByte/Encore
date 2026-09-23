<!--
  ENCORE DEVIATIONS. NOTHING RENDERS THIS TODAY, and the absence is deliberate: vaul-svelte gates the
  overlay on modality, and the app's only drawer is non-modal by necessity — a permanently-mounted sheet
  whose collapsed height is the docked band cannot put a scrim and a focus trap over the page in use.
  Kept vendored so a future modal drawer is one import away; `drawer-overlay-modality.test.ts` ties
  "not rendered" to "not modal" so re-adding one without the other reds.

  It carries NO fade, neither the registry's motion utilities nor a hand-written replacement: a rule for a
  slot no element carries is dead code that reads as live. Re-add a fade with the render, never before it,
  and as a declaration inside a reduced-motion block rather than a utility.
-->
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
