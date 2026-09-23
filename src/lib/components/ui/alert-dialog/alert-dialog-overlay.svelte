<!--
  The scrim is --scrim-strong, not the registry's 10% black: the page is already near-black, so a light
  wash reads as a floating card rather than a taken screen. No backdrop filter — depth in this app comes
  from one elevation token and the radial stage wash, and a blur here would be the only one in the tree.
-->
<script lang="ts">
	import { AlertDialog as AlertDialogPrimitive } from 'bits-ui';
	import { cn } from '$lib/utils.js';

	let { ref = $bindable(null), class: className, ...restProps }: AlertDialogPrimitive.OverlayProps = $props();
</script>

<AlertDialogPrimitive.Overlay
	bind:ref={ref}
	data-slot="alert-dialog-overlay"
	class={cn('fixed inset-0 z-50 bg-[var(--scrim-strong)]', className)}
	{...restProps}
/>

<style>
	/* Rendered by a child component — see the reach note in `alert-dialog-content.svelte`. */
	@media (prefers-reduced-motion: no-preference) {
		:global([data-slot='alert-dialog-overlay'][data-state='open']) {
			animation: encore-scrim-in var(--motion-fast) ease-out;
		}
	}
	@keyframes encore-scrim-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
</style>
