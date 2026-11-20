<script lang="ts">
	/* THE ROOM'S CHEERS, up the right edge of the TV. Self-contained on purpose: the TV page is the most-fixed file
	   in the repo, so its only link to this component is the mount and one `add()` call from its event handler.

	   THE LANE IS THE RIGHT SAFE-AREA GUTTER, and that is the whole readability argument. The lyrics reel pads both
	   edges by --tv-safe-x and ends --tv-chrome-h above the bottom, so a disc no wider than the gutter and no lower
	   than the chrome band cannot cover a word, the lower-third or the corner QR — the probe
	   tests/playwright/specs/probe/reactions-lane.spec.ts measures exactly that while two phones burst.

	   COMPOSITOR ONLY: each disc animates transform and opacity and nothing else, so the reel's rAF loop and its
	   layout are never touched. The server already rate-limits each singer to 3 burst, 1/s; MAX_ON_SCREEN is the
	   TV's own cap for a room full of people tapping at once. */
	import { onDestroy } from 'svelte';
	import { REACTIONS, type ServerEvent } from '$lib/contract';

	type Reacted = Extract<ServerEvent, { type: 'room:reacted' }>;
	type Item = { id: number; emoji: string; color: string };

	/** Oldest drops out past this, on screen and in the waiting line alike, so the whole room tapping stays a stream. */
	const MAX_ON_SCREEN = 12;
	/** One rise, written to --rise-ms below so script and CSS share one number. */
	const RISE_MS = 2400;
	/** The gutter fits one column, so taps that arrive together would stack exactly; spacing them makes a burst a
	 *  stream instead. */
	const SPACING_MS = 350;
	/** A small sway inside the gutter, so the stream does not read as a single rigid column. */
	const DRIFTS = 3;
	/** Reduced motion places discs in fixed rows instead of rising; this many rows before one is reused. */
	const SLOTS = 4;

	let items = $state<Item[]>([]);
	let pending: Item[] = [];
	let releaseTimer: ReturnType<typeof setTimeout> | undefined;
	let seq = 0;

	export function add(e: Reacted): void {
		const emoji = REACTIONS.find((r) => r.id === e.kind)?.emoji;
		if (!emoji) return;
		pending = [...pending, { id: ++seq, emoji, color: e.color }].slice(-MAX_ON_SCREEN);
		if (releaseTimer === undefined) release();
	}

	function release(): void {
		const next = pending.shift();
		if (!next) {
			releaseTimer = undefined;
			return;
		}
		items = [...items.slice(-(MAX_ON_SCREEN - 1)), next];
		releaseTimer = setTimeout(release, SPACING_MS);
	}

	// Removed when its own animation ends, rise and reduced-motion fade alike. A hidden TV defers the event, and
	// MAX_ON_SCREEN bounds what can pile up meanwhile.
	const done = (id: number) => (items = items.filter((i) => i.id !== id));

	onDestroy(() => clearTimeout(releaseTimer));
</script>

<div class="reaction-lane" aria-hidden="true" style:--rise-ms="{RISE_MS}ms">
	{#each items as it (it.id)}
		<span
			class="reaction"
			style:--singer={it.color}
			style:--drift={(it.id % DRIFTS) - 1}
			style:--slot={it.id % SLOTS}
			onanimationend={() => done(it.id)}>{it.emoji}</span
		>
	{/each}
</div>

<style>
	.reaction-lane {
		/* Geometry: the gutter's width, a rise of 40% of the stage, sitting on top of the measured chrome band. Nothing
		   else lives in the gutter above it — Up next, the status dot and the fullscreen button all sit inboard of it. */
		--disc: calc(var(--tv-safe-x) * 0.66);
		--rise-h: 40vh;
		position: absolute;
		right: 0;
		bottom: var(--tv-chrome-h);
		width: var(--tv-safe-x);
		height: var(--rise-h);
		/* The reel's tier, legal because the two are disjoint in SPACE: the reel never paints inside the gutter. */
		z-index: var(--z-tv-reel);
		pointer-events: none;
	}

	.reaction {
		position: absolute;
		bottom: 0;
		left: calc(50% - var(--disc) / 2 + var(--drift) * (var(--tv-safe-x) - var(--disc)) / 4);
		width: var(--disc);
		height: var(--disc);
		display: grid;
		place-items: center;
		border-radius: 50%;
		/* The sender's colour, as a custom property for the same reason as the lower-third's dot. */
		background: color-mix(in oklab, var(--singer) 72%, transparent);
		box-shadow: 0 0 0 max(2px, 0.07rem) var(--singer);
		font-size: calc(var(--disc) * 0.55);
		line-height: var(--lh-none);
		opacity: 0;
		will-change: transform, opacity;
		animation: fade var(--rise-ms) ease-out forwards;
		transform: translateY(calc(var(--slot) * var(--disc) * -1.15));
	}

	@media (prefers-reduced-motion: no-preference) {
		.reaction {
			transform: none;
			animation-name: rise;
		}
	}

	@keyframes rise {
		0% {
			opacity: 0;
			transform: translateY(0) scale(0.6);
		}
		12% {
			opacity: 1;
			transform: translateY(calc(var(--rise-h) * -0.1)) scale(1);
		}
		70% {
			opacity: 1;
		}
		100% {
			opacity: 0;
			transform: translateY(calc(var(--disc) - var(--rise-h))) scale(1);
		}
	}

	/* Reduced motion: no travel at all, each disc fades in and out on its own row. */
	@keyframes fade {
		0%,
		100% {
			opacity: 0;
		}
		15%,
		70% {
			opacity: 1;
		}
	}
</style>
