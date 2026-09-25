<!-- Encore uses this for the CONFIG CONTRACT only — `config` becomes one `--color-<series>` custom property per
  series, emitted by ChartStyle onto the data-chart element — never layerchart's marks: Encore's own marks are focusable,
  individually labelled elements, and adopting rect and path marks would delete the chart's keyboard and screen-reader
  surface. The registry's `flex aspect-video justify-center` and its lc-prefixed overrides must stay removed, and a
  re-vendor restores them: `justify-center` shrink-wraps a full-width bar, `aspect-video` forces a 16/9 box around a 96px
  column row, and the overrides match marks layerchart never draws here. -->
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
	/* This container is a link in /stats' containment chain between the card and the chart's scroll region, and a flex or
	   grid item defaults to min-content — without this the chart's full scroll width sizes the card and overflows. */
	.encore-chart-container {
		min-width: 0;
	}
</style>
