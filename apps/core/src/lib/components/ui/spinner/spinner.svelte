<!--
  ── ENCORE DEVIATIONS (S7) ───────────────────────────────────────────────────────────────────
  Rewritten from the registry's `<Loader2Icon class="animate-spin" />` to Encore's own spinner, for
  two reasons that are both rules rather than taste:

  1. `animate-spin` is a banned motion utility name (motion.test.ts) — a keyframes utility cannot
     honour Reduce Motion. Encore's spinner is a rotating RING built from a border, whose animation is
     declared here in CSS with the `prefers-reduced-motion` arm that already guarded it.
  2. It is not an icon. A 2px ring with one coloured edge needs no glyph and no icon dependency, and
     the app already draws it this way inside the search dock.

  `role="status"` and a default `aria-label` are kept from the registry: a spinner that announces
  nothing is invisible to a screen reader, which is the one thing it must not be while a search runs.
-->
<script lang="ts">
	import { cn } from '$lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		class: className,
		role = 'status',
		'aria-label': ariaLabel = 'Loading',
		...restProps
	}: HTMLAttributes<HTMLSpanElement> = $props();
</script>

<span {role} aria-label={ariaLabel} data-slot="spinner" class={cn('encore-spinner', className)} {...restProps}
></span>

<style>
	.encore-spinner {
		display: inline-block;
		width: 15px;
		height: 15px;
		flex: none;
		border-radius: 50%;
		border: 2px solid var(--line);
		border-top-color: var(--accent2);
	}
	/* Motion is OPT-IN. A static ring is a fine resting state while a search runs. */
	@media (prefers-reduced-motion: no-preference) {
		.encore-spinner {
			animation: spin 0.8s linear infinite;
		}
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
