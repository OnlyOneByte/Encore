<!-- Plays per day, as columns. THE GAP RULE: the play log omits days with no plays, because it cannot distinguish
  "nobody sang" from "the server was off". This chart PRESERVES that distinction — an absent day is a faint MISSING slot,
  never a zero-height column — which is why it takes the window and expands the calendar itself rather than plotting the
  rows it was handed. -->
<script lang="ts">
	import * as Empty from '$lib/components/ui/empty';
	import * as Chart from '$lib/components/ui/chart';
	interface Point {
		day: string;
		plays: number;
	}

	let {
		points = [],
		/** Inclusive start of the window, epoch ms — used to expand the calendar. */
		since,
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
	<Empty.Root>
		<Empty.Header>
			<Empty.Description>{empty}</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else}
	<!-- role=group, NEVER img: img makes the per-day buttons presentational and hides every count. The group
	     carries the summary; each column exposes its own day. -->
	<Chart.Container config={{ sings: { label: 'Sings', color: 'var(--accent)' } }}>
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
					<!-- `title` is desktop-only, because touch never fires :hover — so the count also lives in the aria-label and here. -->
					<span class="readout">{slot.plays === null ? '·' : slot.plays}</span>
				</button>
			{/each}
		</div>
	</Chart.Container>
	<p class="axis">
		<span>{calendar[0]?.day}</span>
		<span>{calendar[calendar.length - 1]?.day}</span>
	</p>
{/if}

<style>
	.chart {
		display: flex;
		align-items: flex-end;
		gap: var(--space-3xs);
		height: 96px;
		/* Each column claims a full tap target, so a long window OVERFLOWS a narrow viewport on purpose:
		   scrolling horizontally beats shrinking the days below a tappable size. */
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
	}
	.col {
		/* Grows to fill when the days are few, but NEVER shrinks below the tap target. */
		flex: 1 0 var(--tap);
		height: 100%;
		display: flex;
		align-items: flex-end;
		min-width: var(--tap);
		/* A real button, so the day is tap- and keyboard-reachable; the rest strips the UA chrome. */
		position: relative;
		padding: 0;
		border: 0;
		background: none;
		font: inherit;
		color: inherit;
		cursor: pointer;
	}
	.readout {
		/* The per-day count, revealed on hover, tap or focus — the path that makes the number reachable on a phone at all.
			   Opacity only, which is the one thing here that may be transitioned. */
		position: absolute;
		left: 50%;
		bottom: 100%;
		transform: translateX(-50%);
		font-size: var(--ph-text-2xs);
		font-variant-numeric: tabular-nums;
		color: var(--ink);
		background: var(--card2);
		padding: 1px 5px;
		border-radius: var(--radius-xs);
		pointer-events: none;
		opacity: 0;
		white-space: nowrap;
	}
	/* Opt-in, per docs/FRONTEND.md#motion-in-component-css: a duration token is not a reduced-motion mechanism, so
	   the fade has to be inside the query rather than declared and reset. Reduced, the readout simply appears. */
	@media (prefers-reduced-motion: no-preference) {
		.readout {
			transition: opacity var(--motion-fast) ease;
		}
	}
	/* `:focus` AS WELL AS `:focus-visible`: the latter is keyboard-driven and does not match a touch tap, so
	   without the plain form a phone tap focuses the column and reveals nothing. */
	.col:hover .readout,
	.col:focus .readout,
	.col:focus-visible .readout {
		opacity: 1;
	}
	.col:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.bar {
		width: 100%;
		border-radius: 3px 3px 0 0;
		/* The fallback is deliberate: `--color-<series>` is emitted at RUNTIME from the config above, so no
		   static scan can see it, and a series leaving that config must still paint its own token. */
		background: var(--color-sings, var(--accent));
	}
	/* A day with no plays is a faint TICK on the baseline, never a full-height ghost: there are no zero rows
	   in this data to distinguish it from, and a ghost lets a long quiet stretch read as activity. */
	.missing .bar {
		/* `!important` is load-bearing: the bar carries an inline height, and only this beats an inline value. */
		height: 2px !important;
		background: var(--line);
		opacity: 0.6;
	}
	.axis {
		display: flex;
		justify-content: space-between;
		font-size: var(--ph-text-xs);
		color: var(--ink-dim);
		margin: 0.4rem 0 0;
		font-variant-numeric: tabular-nums;
	}
</style>
