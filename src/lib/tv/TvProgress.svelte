<script lang="ts">
	// Song progress for the stage, in the three placements a room can choose between.
	//
	// One component rather than three so the fill geometry and the reduced-motion rule are stated once.
	// Every style is matched EXPLICITLY: a trailing else would render the edge bar for 'off'.
	// The `card` variant renders inline and is placed INSIDE the now-singing card by the caller; the
	// other two position themselves against the stage.
	import { formatClock, formatRemaining, progressFraction } from '$lib/clock';
	import type { TvProgressStyle } from '$lib/contract';

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
		transition: transform var(--motion-tick) linear;
	}
	@media (prefers-reduced-motion: reduce) {
		.track > i,
		.topbar > i,
		.edgebar > i {
			transition: none;
		}
	}

	/* ── card: inside the now-singing lower third ─────────────────────────── */
	.card-row {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		margin-top: var(--space-xs);
	}
	.t {
		font-size: var(--tv-label);
		font-variant-numeric: tabular-nums;
		opacity: 0.95;
	}
	/* rgba(0,0,0,0.35) was an ad-hoc inert track; --track-bg is exactly "an inert track behind a fill". */
	.track.card {
		width: 210px;
		height: 5px;
		background: var(--track-bg);
		border-radius: var(--radius-xs);
		overflow: hidden;
	}
	/* Solid white, not --grad: this sits on the card's own purple/pink gradient, where the accent
	   gradient reads as noise rather than as a fill level. LEGITIMATE white literal (contrast-critical
	   fill on a coloured card) — kept per the token sweep. */
	.track.card > i {
		background: #fff;
		border-radius: var(--radius-xs);
	}

	/* ── corner: hairline along the top, remaining time top-left ──────────── */
	.topbar {
		position: absolute;
		left: 0;
		right: 0;
		top: 0;
		height: 6px;
		/* rgba(255,255,255,0.12) was a translucent-white track over video; --ink is the theme's near-white. */
		background: color-mix(in srgb, var(--ink) 12%, transparent);
		z-index: var(--z-tv-card);
		overflow: hidden;
	}
	.topbar > i {
		background: var(--grad);
	}
	.pill {
		position: absolute;
		top: var(--tv-safe-y);
		left: var(--tv-safe-x);
		z-index: var(--z-tv-card);
		padding: var(--space-sm) var(--space-2xl);
		border-radius: var(--radius-pill);
		/* rgba(33,33,51,0.85) was --card2 at 85%. */
		background: color-mix(in srgb, var(--card2) 85%, transparent);
		border: 1px solid var(--line);
		font-size: var(--tv-body);
		font-variant-numeric: tabular-nums;
	}
	.pill .lab {
		color: var(--ink-dim);
		font-size: var(--tv-label);
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	/* ── edge: full-bleed on the bottom edge ──────────────────────────────── */
	.edgebar {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		height: 8px;
		/* rgba(255,255,255,0.12) was a translucent-white track over video; --ink is the theme's near-white. */
		background: color-mix(in srgb, var(--ink) 12%, transparent);
		z-index: var(--z-tv-card);
		overflow: hidden;
	}
	.edgebar > i {
		background: var(--grad);
	}
</style>
