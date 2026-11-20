<!-- Three traps, all of them silent. NO T-SHIRT SIZING UTILITY MAY APPEAR HERE: Encore bridges t-shirt SPACING keys
  into the theme and does not bridge Tailwind's container scale, so `max-w-xs` resolves through the spacing namespace and
  emits `max-width: var(--space-xs)` — six pixels, which nothing but a screenshot sees. Radius and spacing are arbitrary
  values for the same reason: `--radius-*` is deliberately unregistered, and numeric spacing utilities resolve against
  Tailwind's own multiplier. `z-50` is correct rather than arbitrary — the phone ladder tops out at --z-dock (30) and a
  modal must clear the dock. The scrim lives on alert-dialog-overlay.svelte, not here. -->
<script lang="ts">
	import { AlertDialog as AlertDialogPrimitive } from 'bits-ui';
	import { cn, type WithoutChild, type WithoutChildrenOrChild } from '$lib/utils.js';
	import AlertDialogOverlay from './alert-dialog-overlay.svelte';
	import AlertDialogPortal from './alert-dialog-portal.svelte';
	import type { ComponentProps } from 'svelte';

	let {
		ref = $bindable(null),
		class: className,
		size = 'default',
		portalProps,
		...restProps
	}: WithoutChild<AlertDialogPrimitive.ContentProps> & {
		size?: 'default' | 'sm';
		portalProps?: WithoutChildrenOrChild<ComponentProps<typeof AlertDialogPortal>>;
	} = $props();
</script>

<AlertDialogPortal {...portalProps}>
	<AlertDialogOverlay />
	<AlertDialogPrimitive.Content
		bind:ref={ref}
		data-slot="alert-dialog-content"
		data-size={size}
		class={cn(
			'bg-popover text-popover-foreground gap-[var(--space-2xl)] rounded-[var(--radius)] border border-[var(--line-strong)] p-[var(--space-4xl)] shadow-[var(--shadow)] w-[calc(100vw-2*var(--space-4xl))] data-[size=default]:max-w-[26rem] data-[size=sm]:max-w-[22rem] group/alert-dialog-content fixed top-1/2 left-1/2 z-50 grid -translate-x-1/2 -translate-y-1/2 outline-none',
			className
		)}
		{...restProps}
	/>
</AlertDialogPortal>

<style>
	/* The element is rendered by a CHILD component, so it carries no scoping hash for this file and a plain class rule
	   would ship and match nothing; a global data-slot rule is the correct reach. Motion is opt-in inside the
	   no-preference block — the registry's `animate-*` utilities cannot honour Reduce Motion. */
	@media (prefers-reduced-motion: no-preference) {
		:global([data-slot='alert-dialog-content'][data-state='open']) {
			animation: encore-alert-in var(--motion-fast) ease-out;
		}
	}
	/* Scale ONLY. The centring is Tailwind v4's `-translate-*-1/2`, which sets the separate `translate` property,
	   and `translate` composes with `transform` rather than being replaced by it: a `translate(-50%, -50%)` here
	   is applied a SECOND time, and the dialog draws half its own size up-left until the animation ends. */
	@keyframes encore-alert-in {
		from {
			opacity: 0;
			scale: 0.96;
		}
		to {
			opacity: 1;
			scale: 1;
		}
	}
</style>
