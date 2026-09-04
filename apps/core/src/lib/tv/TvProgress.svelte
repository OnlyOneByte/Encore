<script lang="ts">
	// Song progress for the stage, in the three placements a room can choose between.
	//
	// One component rather than three so the fill geometry and the reduced-motion rule are stated once.
	// Every style is matched EXPLICITLY: a trailing else would render the edge bar for 'off'.
	// The `card` variant renders inline and is placed INSIDE the now-singing card by the caller; the
	// other two position themselves against the stage.
	import { formatClock, formatRemaining, progressFraction } from '$lib/clock';
	import type { TvProgressStyle } from '@encore/shared';

	interface Props {
		style: TvProgressStyle;
		elapsedSec: number;
		durationSec: number;
	}
	let { style, elapsedSec, durationSec }: Props = $props();

	const progress = $derived(progressFraction(elapsedSec, durationSec));
</script>

{#if progress !== null}
	{#if style === 'card'}
		<span class="card-row">
			<span class="t">{formatClock(elapsedSec)}</span>
			<span class="track card"><i style="transform:scaleX({progress})"></i></span>
			<span class="t">{formatRemaining(elapsedSec, durationSec)}</span>
		</span>
	{:else if style === 'corner'}
		<div class="topbar"><i style="transform:scaleX({progress})"></i></div>
		<!-- Top-LEFT because the score badge owns top-right, and the lower third owns the bottom. -->
		<div class="pill"><span class="lab">left</span> {formatRemaining(elapsedSec, durationSec).slice(1)}</div>
	{:else if style === 'edge'}
		<div class="edgebar"><i style="transform:scaleX({progress})"></i></div>
	{/if}
{/if}

<style>
	/* scaleX on a full-width fill, never an animated width: transitioning a layout property is banned
	   outright by motion.test.ts, and on the TV it would jank a 60fps video underneath. */
	.track > i,
	.topbar > i,
	.edgebar > i {
		display: block;
		height: 100%;
		width: 100%;
		transform-origin: left center;
		transition: transform 1s linear;
	}
	@media (prefers-reduced-motion: reduce) {
		.track > i,
		.topbar > i,
		.edgebar > i {
			transition: none;
		}
	}

	/* ── card: inside the now-singing lower third ─────────────────────────── */
	.card-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
	.t { font-size: var(--tv-label); font-variant-numeric: tabular-nums; opacity: 0.95; }
	.track.card { width: 210px; height: 5px; background: rgba(0, 0, 0, 0.35); border-radius: 4px; overflow: hidden; }
	/* Solid white, not --grad: this sits on the card's own purple/pink gradient, where the accent
	   gradient reads as noise rather than as a fill level. */
	.track.card > i { background: #fff; border-radius: 4px; }

	/* ── corner: hairline along the top, remaining time top-left ──────────── */
	.topbar {
		position: absolute; left: 0; right: 0; top: 0; height: 6px;
		background: rgba(255, 255, 255, 0.12); z-index: 7; overflow: hidden;
	}
	.topbar > i { background: var(--grad); }
	.pill {
		position: absolute; top: var(--tv-safe-y); left: var(--tv-safe-x); z-index: 7;
		padding: 8px 16px; border-radius: 999px;
		background: rgba(33, 33, 51, 0.85); border: 1px solid var(--line);
		font-size: var(--tv-body); font-variant-numeric: tabular-nums;
	}
	.pill .lab { color: var(--ink-dim); font-size: var(--tv-label); letter-spacing: 0.1em; text-transform: uppercase; }

	/* ── edge: full-bleed on the bottom edge ──────────────────────────────── */
	.edgebar {
		position: absolute; left: 0; right: 0; bottom: 0; height: 8px;
		background: rgba(255, 255, 255, 0.12); z-index: 7; overflow: hidden;
	}
	.edgebar > i { background: var(--grad); }
</style>
