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
	<!-- role=group (not img): img would make the per-day buttons presentational to AT, hiding the
	     counts. The group carries the summary via aria-label; each column button exposes its own day. -->
	<div class="chart" role="group" aria-label="{total} sings over {calendar.length} days">
		{#each calendar as slot (slot.day)}
			<button
				type="button"
				class="col"
				class:missing={slot.plays === null}
				title={slot.plays === null ? `${slot.day}: no plays recorded` : `${slot.day}: ${slot.plays}`}
				aria-label={slot.plays === null ? `${slot.day}: no plays recorded` : `${slot.day}: ${slot.plays} sings`}
			>
				<div class="bar" style:height="{slot.plays === null ? 0 : Math.max(6, (slot.plays / max) * 100)}%"></div>
				<!-- title alone is desktop-only (no :hover on touch), so the count also lives in aria-label
				     for AT and in this readout, revealed on tap/focus, so a phone can surface the value. -->
				<span class="readout">{slot.plays === null ? '·' : slot.plays}</span>
			</button>
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
		/* Was a div; now a real button so the day is tap-/keyboard-reachable. Strip the chrome. */
		position: relative;
		padding: 0;
		border: 0;
		background: none;
		font: inherit;
		color: inherit;
		cursor: pointer;
	}
	.readout {
		/*
		 * The per-day count, hidden until the column is hovered, tapped, or focused. title= is
		 * desktop-only (touch never fires :hover), so this is the path that makes the number reachable
		 * on a phone. opacity only — layout props in transitions are forbidden, and this needs none.
		 */
		position: absolute;
		left: 50%;
		bottom: 100%;
		transform: translateX(-50%);
		font-size: 0.66rem;
		font-variant-numeric: tabular-nums;
		color: var(--ink);
		background: var(--card2);
		padding: 1px 5px;
		border-radius: var(--radius-xs);
		pointer-events: none;
		opacity: 0;
		transition: opacity 0.12s ease;
		white-space: nowrap;
	}
	/* :focus as well as :focus-visible, because :focus-visible is keyboard-driven and does NOT match a
	   touch tap — without the plain :focus a phone tap focused the column and still revealed nothing,
	   which was the whole point of moving the count out of title=. */
	.col:hover .readout,
	.col:focus .readout,
	.col:focus-visible .readout {
		opacity: 1;
	}
	.col:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
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
		/* !important is load-bearing: the bar carries an inline style:height (0 for a missing day),
		   and only !important lets this stylesheet rule beat that inline value to draw the 2px tick. */
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
