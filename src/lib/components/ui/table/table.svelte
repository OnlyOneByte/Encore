<!--
  ── ENCORE DEVIATIONS (S8) ───────────────────────────────────────────────────────────────────
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
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLTableAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLTableAttributes> = $props();
</script>

<div data-slot="table-container" class="relative w-full overflow-x-auto">
	<table bind:this={ref} data-slot="table" class={cn(className)} {...restProps}>
		{@render children?.()}
	</table>
</div>

<style>
	:global([data-slot='table']) {
		width: 100%;
		border-collapse: collapse;
		/*
		 * --ph-text-md (0.9rem / 14.4px), raised from 0.82rem / 13.1px (the shadcn migration goal 6). EVERY cell on both
		 * metrics tables inherited that size, so the entire numeric content of the operator dashboard —
		 * the durations and rates the page exists to be read for — was the smallest text on it, smaller
		 * even than the dim `.note` footnotes explaining it at --ph-text-xs (0.75rem). A ladder step
		 * rather than a nudged literal, so the table sizes from the same scale as its captions.
		 *
		 * SAFE TO GROW, because this table's answer to not fitting is already SCROLL rather than crush:
		 * the `min-width: 34rem` below is a floor inside an `overflow-x: auto` container, so wider cells
		 * widen the scrollable table and never the page. That is the same designed response the eight
		 * columns needed at the old size on a phone.
		 */
		font-size: var(--ph-text-md);
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
	/*
	 * A cell that opts out of the numeric right-alignment by name.
	 *
	 * An earlier change deleted the page's `td.name { text-align: left }` after migrating to <Table.Cell>, and three of
	 * main's four `class="name"` cells were `:first-child` and so already covered by the rule above. The
	 * fourth — the ASR table's syncMode column, which is SECOND — silently became right-aligned: a word
	 * in a column of numbers, ranged the wrong way.
	 *
	 * It has to live HERE rather than in the page. The class now sits on a COMPONENT, so a scoped `.name`
	 * rule written in the page compiles to `.name.svelte-<page-hash>` and lands on no element; the page
	 * cannot reach this cell at all any more.
	 */
	:global([data-slot='table-cell'].name) {
		padding-left: 0;
		text-align: left;
	}

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
