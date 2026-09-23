<!--
  A rotating RING from a border, not the registry's spinning icon — a motion utility cannot honour Reduce
  Motion, and a 2px ring needs no glyph dependency. `role="status"` with a default aria-label, because a
  spinner that announces nothing is invisible to a screen reader while a search runs.
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

<span role={role} aria-label={ariaLabel} data-slot="spinner" class={cn('encore-spinner', className)} {...restProps}
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
