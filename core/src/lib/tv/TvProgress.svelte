<script lang="ts">
	// Song progress in the three styles a room can pick, in one component so the fill and the reduced-motion rule are
	// stated once. `card` and `edge` render inside the singer's pill (TvNowBar); `corner` places itself at the top-left.
	// No trailing else, so `off` renders nothing.
	import { formatClock, formatRemainingAscii, progressFraction } from '$lib/clock';
	import type { TvProgressStyle } from '$lib/contract';

	interface Props {
		style: TvProgressStyle;
		elapsedSec: number;
		durationSec: number;
		/** A takeover card is up: `corner` hides with the lower third (the pill's styles inherit it). */
		underCard?: boolean;
	}
	let { style, elapsedSec, durationSec, underCard = false }: Props = $props();

	const progress = $derived(progressFraction(elapsedSec, durationSec));
</script>

{#if progress !== null}
	{#if style === 'card'}
		<span class="card-row">
			<span class="t">{formatClock(elapsedSec)}</span>
			<span class="track card"><i style="transform:scaleX({progress})"></i></span>
			<span class="t">{formatRemainingAscii(elapsedSec, durationSec)}</span>
		</span>
	{:else if style === 'corner'}
		<div class={['topbar', { 'under-card': underCard }]}><i style="transform:scaleX({progress})"></i></div>
		<!-- Top-LEFT, because top-right is the connection dot / Up-next / fullscreen column and the bottom is the
		     lower-third's. -->
		<div class={['pill', { 'under-card': underCard }]}>
			<span class="lab">left</span>
			{formatRemainingAscii(elapsedSec, durationSec).slice(1)}
		</div>
	{:else if style === 'edge'}
		<div class="edgebar"><i style="transform:scaleX({progress})"></i></div>
	{/if}
{/if}

<style>
	/* scaleX on a full-width fill, never an animated width: animating a LAYOUT property is banned outright, and on the
	   TV it would jank the frame underneath. */
	.track > i,
	.topbar > i,
	.edgebar > i {
		display: block;
		height: 100%;
		width: 100%;
		transform-origin: left center;
	}
	/* OPT-IN, not declared-then-reset: a `transition: none` reset under `reduce` is a declaration a later rule can
	   out-cascade, and then the bar glides again for a viewer who asked for no motion. Reduced, the fill jumps one
	   broadcast's worth per tick. */
	@media (prefers-reduced-motion: no-preference) {
		.track > i,
		.topbar > i,
		.edgebar > i {
			transition: transform var(--motion-tick) linear;
		}
		.topbar,
		.pill {
			transition: opacity var(--motion-base) ease;
		}
	}
	/* Hidden under the card with the lower third (TvNowBar `.under-card`), but FADED back in as it leaves: a flat
	   gradient bar is cheap to fade, where the lower third's shadowed text is not. */
	.under-card {
		visibility: hidden;
		opacity: 0;
	}

	/* `card` and `edge` sit in the singer's pill (TvNowBar), inked in its certified on_fill: currentColor. */
	.card-row {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}
	.t {
		font-size: var(--tv-label);
		font-variant-numeric: tabular-nums;
	}
	.track.card {
		width: 210px;
		height: 5px;
		background: color-mix(in srgb, currentColor 25%, transparent);
		border-radius: var(--radius-xs);
		overflow: hidden;
	}
	.track.card > i,
	.edgebar > i {
		background: currentColor;
	}

	.topbar {
		position: absolute;
		left: 0;
		right: 0;
		top: 0;
		height: 6px;
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
		background: color-mix(in srgb, var(--card2) 85%, transparent);
		border: 1px solid var(--line);
		font-size: var(--tv-body);
		font-variant-numeric: tabular-nums;
	}
	.pill .lab {
		color: var(--ink-dim);
		font-size: var(--tv-label);
	}

	/* The pill's underline: its bottom edge, inside the safe area, never the screen's (redesign step 8). */
	.edgebar {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		height: 0.2em;
		background: color-mix(in srgb, currentColor 25%, transparent);
	}
</style>
