<!--
  Encore's metrics table. All of it is global and keyed on shadcn's data-slot attributes, because a
  table's appearance is inherently DESCENDANT — the cells are rendered by sibling components, which
  scoped CSS cannot reach, and a data-slot survives a re-vendor where a class of ours would not.
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
		/* A ladder step, so the table sizes from the same scale as its captions. Safe to grow: the
		   min-width below is a floor inside an overflow-x container, so wider cells widen the scrollable
		   table and never the page. */
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
	/* `.name` opts a NON-first cell out of the numeric right-alignment (the ASR table's syncMode column is
	   second). The rule has to live here: the class sits on a component, so a scoped `.name` rule written
	   in the page compiles to a hash that lands on no element. */
	:global([data-slot='table-cell'].name) {
		padding-left: 0;
		text-align: left;
	}

	:global([data-slot='table-cell']:first-child) {
		text-align: left;
		padding-left: 0;
	}
	/* Sticky, so the step name stays on screen while the numbers scroll under it — otherwise a row of
	   durations belongs to nothing. */
	:global(.scroller [data-slot='table-cell']:first-child) {
		position: sticky;
		left: 0;
		background: var(--card);
	}
</style>
