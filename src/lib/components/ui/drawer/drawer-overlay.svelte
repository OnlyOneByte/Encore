<!--
  ── ENCORE DEVIATIONS ───────────────────────────────────────────────────────────────────
  NOT RENDERED BY ANYTHING TODAY, and that is recorded here rather than being left to look like an
  oversight. `drawer-content.svelte` no longer includes it: `vaul-svelte` gates the overlay on modality
  (`use-drawer-overlay.svelte.js`: `shouldRender = ctx.modal.current`), and Encore's only drawer is
  `modal={false}` by necessity — a permanently-mounted sheet whose collapsed height is the docked band on
  every phone surface cannot put a scrim and a focus trap over the page the guest is using.

  KEPT rather than deleted, unlike `Separator`: a part is the registry's unit, this one has no broken
  dependency, and a future modal drawer needs it back with one import. `drawer-overlay-modality.test.ts`
  is what keeps "not rendered" and "not modal" tied together, so re-adding modality without re-adding
  this reds rather than silently shipping an unscrimmed modal.

  1. The registry's `data-open:animate-in data-open:fade-in-0` utilities were stripped. `motion.test.ts`
     rejects `animate-*` tree-wide, because a keyframes utility cannot honour Reduce Motion.

  2. It carried a hand-written replacement for them — a `:global([data-slot='drawer-overlay'])` fade with
     two `-global-` keyframes and a prefers-reduced-motion wrapper. That has been DELETED as dead code:
     no element has carried this slot since the overlay stopped being rendered, so the rule matched
     nothing and the keyframes were emitted for nobody. Re-add the fade WITH the render, not before it,
     and keep it as a declaration rather than a utility for the reason in (1).
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
