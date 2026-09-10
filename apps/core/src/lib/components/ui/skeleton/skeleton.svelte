<!--
  ── ENCORE DEVIATIONS (#913 S7) ───────────────────────────────────────────────────────────────────
  1. `animate-pulse` is REPLACED, not kept. motion.test.ts bans motion utility names tree-wide because
     a keyframes utility cannot honour Reduce Motion, and Encore's skeleton was never a pulse: it is a
     travelling SHIMMER, a gradient swept across the box. That gradient and its keyframes move here
     verbatim, with the `prefers-reduced-motion` arm that already guarded them.
  2. A `variant` axis, because the shimmer is used as two shapes — a 44px thumb and a text line, with a
     short line for the second row. Those were three classes in the page; a class handed to a component
     is scoped to the caller and stripped there, so they become variants.
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
	/*
	 * A travelling shimmer rather than a pulse: the gradient is four times the box and its position is
	 * animated, so nothing about the element's layout changes while it plays.
	 */
	.encore-skel {
		background: linear-gradient(90deg, var(--card2) 25%, var(--line) 37%, var(--card2) 63%);
		background-size: 400% 100%;
	}
	/*
	 * Motion is OPT-IN, declared inside a no-preference block rather than declared-then-reset. Both
	 * forms satisfy #148, and this one cannot drift: there is no reset to lose the cascade to a later
	 * rule (#337), and a static block is a fine resting state for a placeholder.
	 */
	@media (prefers-reduced-motion: no-preference) {
		.encore-skel {
			animation: shimmer 1.3s ease-in-out infinite;
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
	/*
	 * Respect a reduced-motion preference: this animation otherwise runs unguarded and indefinitely.
	 * A static block is a fine resting state for a placeholder.
	 */
</style>
