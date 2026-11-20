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
	 *  stream. It also bounds what is on screen: at most ceil(RISE_MS / SPACING_MS) = 7 discs at once. */
	const SPACING_MS = 350;
	/** The waiting line. Past this the oldest waiting cheer drops, so a full line is at most 12 x 350 ms = 4.2 s
	 *  behind the tap that joined it last — late, but still during the song it was for. */
	const MAX_WAITING = 12;
	/** Reduced motion: each disc fades in place on one of these rows. Its whole fade lasts SLOTS x SPACING_MS, so a
	 *  row is free again by the time the release order comes back round to it. */
	const SLOTS = 4;

	let items = $state<Item[]>([]);
	let waiting: Item[] = [];
	let releaseTimer: ReturnType<typeof setTimeout> | undefined;
	let seq = 0;

	export function add(e: Reacted): void {
		waiting = [...waiting, { id: ++seq, kind: e.kind, color: e.color }].slice(-MAX_WAITING);
		if (releaseTimer === undefined) release();
	}

	function release(): void {
		const next = waiting.shift();
		if (!next) {
			releaseTimer = undefined;
			return;
		}
		items = [...items, next];
		releaseTimer = setTimeout(release, SPACING_MS);
	}

	// Removed when its own animation ends, rise and reduced-motion fade alike.
	const done = (id: number) => (items = items.filter((i) => i.id !== id));

	onDestroy(() => clearTimeout(releaseTimer));
</script>

<div class="reaction-lane" aria-hidden="true" style:--rise-ms="{RISE_MS}ms" style:--fade-ms="{SLOTS * SPACING_MS}ms">
	{#each items as it (it.id)}
		<span class="reaction" style:--singer={it.color} style:--slot={it.id % SLOTS} onanimationend={() => done(it.id)}>
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
