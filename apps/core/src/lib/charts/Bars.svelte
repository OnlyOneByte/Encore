<!--
  A ranked horizontal bar list. Hand-rolled because Encore has no charting library and one bar row is
  a div with a width — pulling in a chart dependency to draw a rectangle would be the larger cost.

  Bars are scaled to the LARGEST value in the set, not to a round number above it, so the longest bar
  always fills the row: with a handful of plays a 0-to-10 axis would render every bar as a stub.
-->
<script lang="ts">
	import * as Empty from '$lib/components/ui/empty';
	import * as Chart from '$lib/components/ui/chart';
	interface Row {
		label: string;
		value: number;
		/** Optional secondary text, right-aligned (e.g. an artist under a title). */
		hint?: string;
	}

	let {
		rows = [],
		/** What one unit is, for the value suffix. Kept short — it repeats on every row. */
		unit = '',
		empty = 'Nothing yet'
	}: { rows?: Row[]; unit?: string; empty?: string } = $props();

	const max = $derived(Math.max(1, ...rows.map((r) => r.value)));
</script>

{#if rows.length === 0}
	<Empty.Root>
		<Empty.Header>
			<Empty.Description>{empty}</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else}
	<!--
		#913 S8: <Chart.Container> supplies the series config, so the fill paints from `--color-plays`
		rather than naming a token directly. The marks stay a labelled <ol> — this is a proportional LIST,
		where each row's label and value are real text, not a plotted series whose values live in an SVG
		path a screen reader cannot read.
	-->
	<Chart.Container config={{ plays: { label: 'Plays', color: 'var(--grad)' } }}>
		<ol class="bars">
		{#each rows as row, i (row.label + i)}
			<li>
				<div class="line">
					<span class="label" title={row.label}>{row.label}</span>
					<span class="value">{row.value}{unit ? ` ${unit}` : ''}</span>
				</div>
				<!-- The track is the full width; the fill is the proportion. A gradient is fine here
				     because nothing is written on top of it — no contrast obligation. -->
				<div class="track" role="presentation">
					<div class="fill" style:width="{(row.value / max) * 100}%"></div>
				</div>
				{#if row.hint}<span class="hint">{row.hint}</span>{/if}
			</li>
		{/each}
	</ol>
	</Chart.Container>
{/if}

<style>
	.bars {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.7rem;
	}
	.line {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 0.75rem;
		margin-bottom: 0.3rem;
	}
	.label {
		font-size: var(--ph-text-md);
		/*
		 * Wrap to a second line rather than clip with an ellipsis. The full label was ONLY in the
		 * title attribute, which never fires on touch (no :hover), so a long artist or model name was
		 * unrecoverable on a phone. Two lines keep it readable everywhere; title stays as a mouse bonus.
		 */
		overflow-wrap: anywhere;
	}
	.value {
		/*
		 * The count IS the data, so it reads at the label's weight rather than as a footnote. At
		 * 0.82rem/--ink-dim it was the smallest, dimmest thing in a row whose entire purpose is that
		 * number. min-width keeps the right edge stable so a column of values aligns.
		 */
		font-size: var(--ph-text-md);
		font-variant-numeric: tabular-nums;
		color: var(--ink);
		flex: none;
		min-width: 5ch;
		text-align: right;
	}
	.track {
		height: 8px;
		border-radius: var(--radius-pill);
		background: var(--track-bg);
		overflow: hidden;
	}
	.fill {
		height: 100%;
		border-radius: var(--radius-pill);
		/*
		 * The fallback is deliberate, not defensive noise: `--color-<series>` is emitted at RUNTIME by
		 * ChartStyle from the `config` above, so no static scan can see it — and if a series ever leaves
		 * that config, the mark still paints its own token instead of nothing.
		 */
		background: var(--color-plays, var(--grad));
		min-width: 2px;
	}
	.hint {
		display: block;
		font-size: var(--ph-text-xs);
		color: var(--ink-dim);
		margin-top: 0.25rem;
	}
	/* #913 S7: `.empty` is ui/empty's now. */
</style>
