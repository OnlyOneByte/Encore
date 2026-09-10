<!--
  ── ENCORE DEVIATIONS (#913 S4) ───────────────────────────────────────────────────────────────────
  The registry's appearance is kept — S4 deliberately accepted the visual change from Encore's
  bordered card to shadcn's ring-and-spacing one. One containment rule is ADDED, and it is not
  cosmetic:

  `min-width: 0`. A card is frequently a GRID ITEM, and a grid item defaults to `min-width: auto`
  (= min-content). Without this, /stats' trend chart — a row of 44px day buttons (#144) — sizes its
  card to the full 1424px scroll width and overflows the document horizontally, turning a tap-target
  fix into a layout regression. It was measured when first fixed: document overflow 21px → 0, chart
  scrollable true. The rule lived in the page until #913; scoped CSS there can no longer reach the
  element this component renders, so it moved here with the guard that holds it.

  Safe to apply to every card: `min-width` only participates when the box is a flex or grid item.
-->
<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
		size = "default",
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & { size?: "default" | "sm" } = $props();
</script>

<div
	bind:this={ref}
	data-slot="card"
	data-size={size}
	class={cn("encore-card gap-(--card-spacing) overflow-hidden rounded-xl bg-card py-(--card-spacing) text-sm text-card-foreground shadow-xs ring-1 ring-foreground/10 [--card-spacing:--spacing(6)] has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(4)] *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl group/card flex flex-col", className)}
	{...restProps}
>
	{@render children?.()}
</div>

<style>
	.encore-card {
		min-width: 0;
	}
</style>
