<script lang="ts">
	/* THE ROOM'S CHEERS, up the right edge of the TV. Self-contained on purpose: the TV page is the most-fixed file
	   in the repo, so its links to this component are the mount and one `add()` call from its event handler.

	   THE LANE IS INSIDE THE SAFE AREA, against its right edge (--tv-safe-x), because the gutter outside it is the
	   part of the picture a TV may overscan away. The lyrics reel gives up --tv-reaction-reserve on both sides while
	   reactions are on, so a centred row never reaches the lane; the lane ends --tv-chrome-h above the bottom, so it
	   never reaches the lower-third or the corner QR. tests/playwright/specs/probe/reactions-lane.spec.ts measures
	   both while phones burst.

	   CHEAP TO COMPOSITE: each disc animates transform and opacity only, over an OPAQUE fill with a plain border —
	   no translucency to blend against the stage, no shadow to repaint, no glyph to rasterise (the picture is a
	   bundled SVG, decoded once). */
	import { onDestroy } from 'svelte';
	import type { ServerEvent } from '$lib/contract';
	import ReactionGlyph from '$lib/ui/ReactionGlyph.svelte';

	type Reacted = Extract<ServerEvent, { type: 'room:reacted' }>;
	type Item = { id: number; kind: Reacted['kind']; color: string };

	/** One rise, written to --rise-ms below so script and CSS share one number. */
	const RISE_MS = 2400;
	/** The lane is one disc wide, so taps that arrive together would stack exactly; spacing them makes a burst a
	 *  stream. 650 ms is what keeps two discs from TOUCHING: the climb is linear, so neighbours stay one constant
	 *  distance apart (speed x spacing). At this spacing the closest pair still clears by 13 px at 720p, 24 px at
	 *  1080p and 47 px at 4K. It is counted from each disc's animation START (see `started`), so a late first frame
	 *  delays the next disc instead of closing the gap. 550 ms left ~55 ms and touched under load at 4K; an eased
	 *  climb, which slows the disc ahead near the top, overlaps at any spacing here. The probe asserts it. At most ceil(RISE_MS / SPACING_MS) = 4 on screen. */
	const SPACING_MS = 650;
	/** The waiting line. Past this the oldest waiting cheer drops, so a full line is at most 6 x 650 ms = 3.9 s
	 *  behind the tap that joined it last — late, but still during the song it was for. */
	const MAX_WAITING = 6;
	/** Reduced motion: each disc fades in place on one of these rows. Its whole fade lasts SLOTS x SPACING_MS, so a
	 *  row is free again by the time the release order comes back round to it. */
	const SLOTS = 4;

	let items = $state<Item[]>([]);
	let waiting: Item[] = [];
	let releaseTimer: ReturnType<typeof setTimeout> | undefined;
	/** The disc whose spacing has not run yet; the next one waits for it. */
	let pending: number | undefined;
	let seq = 0;

	/** @knipignore Called through `bind:this` from routes/tv/+page.svelte, which knip cannot follow. */
	export function add(e: Reacted): void {
		waiting = [...waiting, { id: ++seq, kind: e.kind, color: e.color }].slice(-MAX_WAITING);
		if (pending === undefined) release();
	}

	function release(): void {
		const next = waiting.shift();
		pending = next?.id;
		if (next) items = [...items, next];
	}

	/* The spacing runs from the disc's own ANIMATION START, not from its mount: on a busy TV the first frame can
	   land hundreds of ms late, and a clock started at mount would release the next disc into the one ahead.
	   Nightly 44844250303 caught exactly that. Positions are a function of each rise's start, so this keeps them. */
	function started(id: number): void {
		if (id !== pending || releaseTimer !== undefined) return;
		releaseTimer = setTimeout(() => {
			releaseTimer = undefined;
			release();
		}, SPACING_MS);
	}

	// Removed when its own animation ends, rise and reduced-motion fade alike.
	const done = (id: number) => (items = items.filter((i) => i.id !== id));

	onDestroy(() => clearTimeout(releaseTimer));
</script>

<div class="reaction-lane" aria-hidden="true" style:--rise-ms="{RISE_MS}ms" style:--fade-ms="{SLOTS * SPACING_MS}ms">
	{#each items as it (it.id)}
		<span
			class="reaction"
			style:--singer={it.color}
			style:--slot={it.id % SLOTS}
			onanimationstart={() => started(it.id)}
			onanimationend={() => done(it.id)}
		>
			<span class="pic"><ReactionGlyph kind={it.kind} /></span>
		</span>
	{/each}
</div>

<style>
	.reaction-lane {
		/* Geometry: one disc wide, a rise of 40% of the stage, standing on the measured chrome band. */
		--rise-h: 40vh;
		position: absolute;
		right: var(--tv-safe-x);
		bottom: var(--tv-chrome-h);
		width: var(--tv-reaction-w);
		height: var(--rise-h);
		/* The reel's tier, legal because the two are disjoint in SPACE: the reel is pulled in by the reserve. */
		z-index: var(--z-tv-reel);
		pointer-events: none;
	}

	.reaction {
		position: absolute;
		bottom: 0;
		left: 0;
		width: var(--tv-reaction-w);
		height: var(--tv-reaction-w);
		display: grid;
		place-items: center;
		box-sizing: border-box;
		border-radius: 50%;
		/* OPAQUE: the sender's colour mixed toward the page, never toward transparent, so the disc blends with nothing
		   and neighbouring singers keep their own hue on any stage. The ring is the colour itself. */
		background: color-mix(in oklab, var(--singer) 62%, var(--bg));
		border: max(2px, 0.07rem) solid var(--singer);
		opacity: 0;
		animation: fade var(--fade-ms) ease-out forwards;
		transform: translateY(calc(var(--slot) * var(--tv-reaction-w) * -1.15));
	}

	.pic {
		width: 62%;
		height: 62%;
	}

	@media (prefers-reduced-motion: no-preference) {
		.reaction {
			transform: none;
			animation: rise var(--rise-ms) ease-out forwards;
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
			/* LINEAR from here to the top, so the gap to the disc ahead never closes (see SPACING_MS). */
			animation-timing-function: linear;
		}
		70% {
			opacity: 1;
		}
		100% {
			opacity: 0;
			transform: translateY(calc(var(--tv-reaction-w) - var(--rise-h))) scale(1);
		}
	}

	/* Reduced motion: no travel at all, each disc fades in and out on its own row. */
	@keyframes fade {
		0%,
		100% {
			opacity: 0;
		}
		20%,
		75% {
			opacity: 1;
		}
	}
</style>
