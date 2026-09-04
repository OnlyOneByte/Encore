<!--
  Plays per day, as columns. SVG because it needs no library and the shape is trivial.

  THE GAP RULE. The play log omits days with no plays, because it cannot distinguish "nobody sang"
  from "the server was off" (see PlayLog.perDay). This chart preserves that distinction rather than
  papering over it: absent days render as a faint MISSING slot, not a zero-height column, so a quiet
  Tuesday and a week of downtime do not draw identically. That is why the component takes the window
  and expands the calendar itself instead of just plotting the rows it was handed.
-->
<script lang="ts">
	interface Point {
		day: string;
		plays: number;
	}

	let {
		points = [],
		/** Inclusive start of the window, epoch ms — used to expand the calendar. */
		since,
		/** Now, epoch ms. */
		until,
		empty = 'No sings recorded yet'
	}: { points?: Point[]; since: number; until: number; empty?: string } = $props();

	const DAY = 86_400_000;

	/** Every day in the window, each carrying its count or null for "no record". */
	const calendar = $derived.by(() => {
		const byDay = new Map(points.map((p) => [p.day, p.plays]));
		const out: { day: string; plays: number | null }[] = [];
		// Walk UTC days so the buckets line up with the SQL that produced them (strftime on unixepoch).
		const startDay = Math.floor(since / DAY);
		const endDay = Math.floor(until / DAY);
		for (let d = startDay; d <= endDay; d++) {
			const day = new Date(d * DAY).toISOString().slice(0, 10);
			out.push({ day, plays: byDay.get(day) ?? null });
		}
		return out;
	});

	const max = $derived(Math.max(1, ...calendar.map((c) => c.plays ?? 0)));
	const total = $derived(points.reduce((s, p) => s + p.plays, 0));
</script>

{#if total === 0}
	<p class="empty">{empty}</p>
{:else}
	<div class="chart" role="img" aria-label="{total} sings over {calendar.length} days">
		{#each calendar as slot (slot.day)}
			<div
				class="col"
				class:missing={slot.plays === null}
				title={slot.plays === null ? `${slot.day}: no plays recorded` : `${slot.day}: ${slot.plays}`}
			>
				<div class="bar" style:height="{slot.plays === null ? 0 : Math.max(6, (slot.plays / max) * 100)}%"></div>
			</div>
		{/each}
	</div>
	<p class="axis">
		<span>{calendar[0]?.day}</span>
		<span>{calendar[calendar.length - 1]?.day}</span>
	</p>
{/if}

<style>
	.chart {
		display: flex;
		align-items: flex-end;
		gap: 2px;
		height: 96px;
	}
	.col {
		flex: 1 1 0;
		height: 100%;
		display: flex;
		align-items: flex-end;
		min-width: 3px;
	}
	.bar {
		width: 100%;
		border-radius: 3px 3px 0 0;
		background: var(--accent);
	}
	/*
	 * A day with no plays is a faint 2px tick on the baseline, not a full-height ghost.
	 * The earlier version drew missing days at full height to make them distinguishable from a
	 * zero — but this data set has no zero rows at all (PlayLog.perDay omits empty days), so there
	 * was no zero to distinguish FROM. All the ghost achieved was letting three weeks of quiet
	 * dominate the chart and read as activity. The tick keeps every day addressable for the tooltip
	 * while letting the actual plays carry the shape.
	 */
	.missing .bar {
		height: 2px !important;
		background: var(--line);
		opacity: 0.6;
	}
	.axis {
		display: flex;
		justify-content: space-between;
		font-size: 0.72rem;
		color: var(--ink-dim);
		margin: 0.4rem 0 0;
		font-variant-numeric: tabular-nums;
	}
	.empty {
		color: var(--ink-dim);
		font-size: 0.9rem;
		margin: 0;
	}
</style>
