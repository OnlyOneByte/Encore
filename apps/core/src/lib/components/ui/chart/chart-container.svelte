<!--
  ── ENCORE DEVIATIONS (#913 S8) ───────────────────────────────────────────────────────────────────
  What Encore uses this for is the CONFIG CONTRACT — `config` → a `--color-<series>` custom property
  per series, emitted by ChartStyle onto `[data-chart=<id>]` — not layerchart's marks.

  That is deliberate, and the reason is accessibility. /stats' Trend is not an SVG chart: every column
  is a real <button> with its own `aria-label` naming that day and its count, and the group carries
  `role="group"` rather than `role="img"` precisely so those per-day counts are NOT presentational.
  #144 additionally sizes each column to a 44px tap target, pinned by trend-tap-target.test.ts.
  layerchart draws `<rect>`/`<path>` marks, which are neither focusable nor individually labelled, so
  adopting them would delete the chart's entire keyboard and screen-reader surface. Bars is likewise a
  labelled proportional list rather than a plotted series.

  So the container wraps Encore's own accessible marks, and the marks paint from the config's
  variables. `min-width: 0` is added because this container now sits between /stats' card and the
  chart's own scroll region: a flex/grid item defaults to min-content, and #144's containment chain
  (measured: document overflow 21px → 0) breaks if any link in it can be sized by its content.

  ── PHASE 2: THE REGISTRY'S LAYOUT CLASSES AND ITS layerchart OVERRIDES ARE BOTH REMOVED ───────────
  The registry's base was `flex aspect-video justify-center overflow-visible text-xs` plus ~30
  `[&_.lc-*]` override classes. Both were actively wrong HERE, and measured so on /stats at 1440px
  inside its 720px card:

    - `justify-center` on a flex row SHRINK-WRAPS the marks to content width and centres them, so
      Bars' <ol> rendered 211px wide inside 672px of available space (31%) — a `width: 100%` "top
      song" bar drawn at a third of the card.
    - `aspect-video` forced a 378px-tall box (16/9 of 672) around Trend's 96px column row, leaving
      282px of dead space beneath it, and stretched Bars' three auto grid rows apart.
      Document overflow was 0 throughout, which is why an overflow-focused check passed it: this is
      dead space and shrink-wrap, not clipping.

  Those utilities exist for a PLOTTED SVG that must fill a responsive box. Encore's marks size
  themselves (`.chart { height: 96px }`, `.bars { display: grid; gap }`), so the container's only job
  is to be a full-width block that emits the config variables — hence `w-full text-xs`.

  The `[&_.lc-*]` overrides are deleted because they can never match: no `lc-` class appears anywhere
  in app source (layerchart draws none of these marks). They were ~30 lines describing a rendering
  path this component does not take. `layerchart` itself remains a dependency only for
  chart-tooltip.svelte, which has zero call sites — retiring both is a follow-up.
-->
<!--
  NOTE FOR A RE-PULL: `shadcn-svelte add chart --overwrite` will restore `flex aspect-video
  justify-center` and the lc-* block. Both must be removed again, or /stats regresses to the measured
  geometry above.
-->
<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import ChartStyle from './chart-style.svelte';
	import { setChartContext, type ChartConfig } from './chart-utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	const uid = $props.id();

	let {
		ref = $bindable(null),
		id = uid,
		class: className,
		children,
		config,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLElement>> & {
		config: ChartConfig;
	} = $props();

	const chartId = $derived(`chart-${id || uid.replace(/:/g, '')}`);

	setChartContext({
		get config() {
			return config;
		}
	});
</script>

<div
	bind:this={ref}
	data-chart={chartId}
	data-slot="chart"
	class={cn('encore-chart-container', 'w-full text-xs', className)}
	{...restProps}
>
	<ChartStyle id={chartId} config={config} />
	{@render children?.()}
</div>

<style>
	/* See the note above: a link in #144's containment chain must not min-content-size. */
	.encore-chart-container {
		min-width: 0;
	}
</style>
