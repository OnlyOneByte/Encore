<!--
  ── ENCORE DEVIATIONS (P0 · alert-dialog adoption) ───────────────────────────────────────────
  1. MOTION UTILITIES REMOVED (`animate-in` / `animate-out` / `fade-*` / `duration-100`), for the
     reason in `alert-dialog-content.svelte` §1. The fade is re-declared below as `opacity` only,
     inside a `prefers-reduced-motion: no-preference` block.
  2. `bg-black/10` → `--scrim-strong`. A 10% black wash does not read as a modal boundary on a dark
     UI — `--bg` is already `#0b0b12`, so the scrim was very nearly invisible and the dialog looked
     like a floating card rather than something that had taken the screen. `--scrim-strong` is the
     token the app already uses when a surface must stop being interactive.
  3. `supports-backdrop-filter:backdrop-blur-xs` REMOVED. Encore's visual language is explicit that
     depth comes from one elevation token and a radial stage wash — no blur, no bloom. A backdrop
     filter here would be the only one in the app.
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
