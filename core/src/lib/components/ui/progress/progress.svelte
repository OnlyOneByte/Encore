<!--
  Encore's process bar. The primitive is what supplies `role="progressbar"` with aria-valuenow/min/max,
  which is the reason to use it: both hand-rolled call sites had none, so progress was invisible to
  assistive tech. The fill is --grad, and it MOVES BY translateX rather than resizing, so no layout
  property is animated. Spacing above the bar belongs to the call site, not to the bar's own metric.
-->
<script lang="ts">
	import { Progress as ProgressPrimitive } from 'bits-ui';
	import { cn, type WithoutChildrenOrChild } from '$lib/utils.js';

	let {
		ref = $bindable(null),
		class: className,
		max = 100,
		value,
		size = 'default',
		...restProps
	}: WithoutChildrenOrChild<ProgressPrimitive.RootProps> & { size?: 'default' | 'sm' } = $props();
</script>

<ProgressPrimitive.Root
	bind:ref={ref}
	data-slot="progress"
	data-size={size}
	class={cn('relative flex w-full items-center', className)}
	value={value}
	max={max}
	{...restProps}
>
	<div
		data-slot="progress-indicator"
		class="encore-bar-fill size-full flex-1"
		style="transform: translateX(-{100 - (100 * (value ?? 0)) / (max ?? 1)}%)"
	></div>
</ProgressPrimitive.Root>

<style>
	/* `:global` because the root is a Bits UI COMPONENT; keyed on shadcn's own data-slot. */
	:global([data-slot='progress']) {
		height: 6px;
		border-radius: 6px;
		background: var(--card-tint2);
		overflow: hidden;
	}
	:global([data-slot='progress'][data-size='sm']) {
		height: 4px;
		border-radius: 4px;
	}
	/* `transform-origin` is load-bearing: the fill must grow from the left edge, not the centre. */
	.encore-bar-fill {
		background: var(--grad);
		border-radius: inherit;
		transform-origin: left center;
	}
	/* Motion is OPT-IN, the same form `skeleton` and `spinner` use — see the registry README's motion rule. This was a
	   `transition` on the rule above plus a `reduce` reset, which honours the preference only for as long as the reset
	   stays LAST: any later rule that restates `transition` on this fill — a caller's `:global`, or a re-vendor
	   appending to this block — silently re-animates it for a guest who asked for no motion, and nothing reds.
	   Declaring it inside the query leaves no reset to lose. A bar that jumps straight to its value is a fine resting
	   state, as the static ring is for `spinner`. */
	@media (prefers-reduced-motion: no-preference) {
		.encore-bar-fill {
			transition: transform 200ms ease-out;
		}
	}
</style>
