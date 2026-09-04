<!--
  A ranked horizontal bar list. Hand-rolled because Encore has no charting library and one bar row is
  a div with a width — pulling in a chart dependency to draw a rectangle would be the larger cost.

  Bars are scaled to the LARGEST value in the set, not to a round number above it, so the longest bar
  always fills the row: with a handful of plays a 0-to-10 axis would render every bar as a stub.
-->
<script lang="ts">
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
	<p class="empty">{empty}</p>
{:else}
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
		font-size: 0.9rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.value {
		/*
		 * The count IS the data, so it reads at the label's weight rather than as a footnote. At
		 * 0.82rem/--ink-dim it was the smallest, dimmest thing in a row whose entire purpose is that
		 * number. min-width keeps the right edge stable so a column of values aligns.
		 */
		font-size: 0.9rem;
		font-variant-numeric: tabular-nums;
		color: var(--ink);
		flex: none;
		min-width: 5ch;
		text-align: right;
	}
	.track {
		height: 8px;
		border-radius: 999px;
		background: var(--track-bg);
		overflow: hidden;
	}
	.fill {
		height: 100%;
		border-radius: 999px;
		background: var(--grad);
		min-width: 2px;
	}
	.hint {
		display: block;
		font-size: 0.75rem;
		color: var(--ink-dim);
		margin-top: 0.25rem;
	}
	.empty {
		color: var(--ink-dim);
		font-size: 0.9rem;
		margin: 0;
	}
</style>
