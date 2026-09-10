<!--
  ── ENCORE DEVIATIONS (#913 S8) ───────────────────────────────────────────────────────────────────
  Encore's metrics table, replacing the registry's `caption-bottom text-sm`. All of it is `:global`
  because a table's appearance is inherently DESCENDANT — the cells are rendered by sibling
  components (Table.Cell, Table.Head), which Svelte's scoped CSS cannot reach — and keyed on shadcn's
  own `data-slot` attributes so it survives a re-vendor.

  Two things here are behaviour rather than decoration, and both came from the page:

  1. `min-width: 34rem` inside a `.scroller`, with a STICKY first column. A processing-metrics table
     is eight numeric columns wide; on a phone it must scroll horizontally rather than crush every
     column, and the step name has to stay on screen while it does, or the numbers lose their labels.
  2. `font-variant-numeric: tabular-nums`. Durations are compared DOWN a column, and proportional
     digits make a column of numbers ragged enough to defeat that comparison.
-->
<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLTableAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLTableAttributes> = $props();
</script>

<div data-slot="table-container" class="relative w-full overflow-x-auto">
	<table bind:this={ref} data-slot="table" class={cn("encore-table", className)} {...restProps}>
		{@render children?.()}
	</table>
</div>

<style>
	:global([data-slot='table']) {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.82rem;
		/* Durations are compared down a column; proportional digits make that ragged. */
		font-variant-numeric: tabular-nums;
	}
	/* Eight numeric columns do not fit a phone: scroll instead of crushing them. */
	:global(.scroller [data-slot='table']) {
		min-width: 34rem;
	}
	:global([data-slot='table-head']) {
		font-weight: 600;
		color: var(--ink-dim);
		border-bottom: 1px solid var(--line);
		white-space: nowrap;
		text-align: right;
	}
	:global([data-slot='table-cell']) {
		text-align: right;
		padding: 0.4rem 0 0.4rem 0.5rem;
		border-bottom: 1px solid var(--line-tint);
	}
	/* The label column reads left, and is the anchor the numbers belong to. */
	:global([data-slot='table-head']:first-child),
	:global([data-slot='table-cell']:first-child) {
		text-align: left;
		padding-left: 0;
	}
	/*
	 * …and it stays on screen while the numbers scroll under it. Without this the step name leaves the
	 * viewport and a row of durations belongs to nothing.
	 */
	:global(.scroller [data-slot='table-cell']:first-child) {
		position: sticky;
		left: 0;
		background: var(--card);
	}
</style>
