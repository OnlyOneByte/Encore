<!--
  ── ENCORE DEVIATIONS (S6) ────────────────────────────────────────────────────────────────────────
  Encore's cook bar, replacing the registry's flat `bg-muted` / `bg-primary` pair. Both call sites —
  ProcessingCard and SongRow — carried the SAME hand-rolled idiom (`.bar` + an `<i>` scaled from the
  left edge), differing only in height, so this consolidates a duplicate rather than restyling one.

  1. What the registry does NOT give these sites, and why the swap is worth making at all:
     `role="progressbar"` with `aria-valuenow`/`min`/`max`. Neither hand-rolled bar had any of it, so
     a cook's progress was invisible to assistive tech. Bits UI supplies it.

  2. The fill is `var(--grad)`, Encore's gradient, not a flat `bg-primary`.

  3. The fill keeps a `transform`-only transition. That is deliberate and allowed: motion.test.ts bans
     TRANSITIONING A LAYOUT PROPERTY, and this is exactly why both sites drove a scaleX rather than a
     width. shadcn's own indicator already moves by `translateX`, so it agrees; only its
     `transition-all` had to go, since that would have animated layout properties too.

  4. A `size` axis, because the two bars are 6px and 4px. Spacing from the element ABOVE stays at the
     call site on a wrapper, since that is page layout rather than the bar's own metric.
-->
<script lang="ts">
	import { Progress as ProgressPrimitive } from "bits-ui";
	import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		max = 100,
		value,
		size = "default",
		...restProps
	}: WithoutChildrenOrChild<ProgressPrimitive.RootProps> & { size?: "default" | "sm" } = $props();
</script>

<ProgressPrimitive.Root
	bind:ref
	data-slot="progress"
	data-size={size}
	class={cn("relative flex w-full items-center", className)}
	{value}
	{max}
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
	/*
	 * GPU-composited fill: the indicator is translated, never resized, so no layout property is
	 * animated. `transform-origin` matters — the fill must grow from the left edge, not the centre.
	 */
	.encore-bar-fill {
		background: var(--grad);
		border-radius: inherit;
		transform-origin: left center;
		transition: transform 200ms ease-out;
	}
	@media (prefers-reduced-motion: reduce) {
		.encore-bar-fill {
			transition: none;
		}
	}
</style>
