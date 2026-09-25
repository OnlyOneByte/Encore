<!--
  A travelling shimmer, not the registry's `animate-pulse` — a motion utility cannot honour Reduce Motion.
  The shapes are variants rather than caller classes, because a class handed to a component is scoped to
  the caller and stripped there.
-->
<script lang="ts">
	import { cn, type WithElementRef, type WithoutChildren } from '$lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		variant = 'line',
		class: className,
		...restProps
	}: WithoutChildren<WithElementRef<HTMLAttributes<HTMLDivElement>>> & {
		variant?: 'line' | 'line-short' | 'thumb';
	} = $props();
</script>

<div
	bind:this={ref}
	data-slot="skeleton"
	data-variant={variant}
	class={cn('encore-skel', className)}
	{...restProps}
></div>

<style>
	/* The gradient is four times the box so only its POSITION animates — no layout property moves. */
	.encore-skel {
		background: linear-gradient(90deg, var(--card2) 25%, var(--line) 37%, var(--card2) 63%);
		background-size: 400% 100%;
	}
	/* Motion is OPT-IN rather than declared-then-reset: there is no reset here to lose the cascade to a
	   later rule, and a static block is a fine resting state for a placeholder. */
	@media (prefers-reduced-motion: no-preference) {
		.encore-skel {
			animation: shimmer 1.3s infinite;
		}
	}
	.encore-skel[data-variant='line'],
	.encore-skel[data-variant='line-short'] {
		height: 12px;
		border-radius: 6px;
	}
	.encore-skel[data-variant='line-short'] {
		width: 55%;
	}
	.encore-skel[data-variant='thumb'] {
		width: 44px;
		height: 44px;
		flex: none;
		border-radius: var(--radius-btn);
	}
	@keyframes shimmer {
		0% {
			background-position: 100% 0;
		}
		100% {
			background-position: 0 0;
		}
	}
</style>
