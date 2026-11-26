<script lang="ts" module>
	/**
	 * ONE observer shape for every measured band on /tv. `borderBoxSize` is the full rendered box the reel must clear;
	 * `offsetHeight` is the fallback where that form is unsupported. Returns the `$effect` cleanup, or `undefined`
	 * when there is nothing to observe — the caller's effect tracks the binding by passing it in.
	 */
	export function observeBlockSize(el: HTMLElement | undefined, set: (px: number) => void): (() => void) | undefined {
		if (!el || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver((entries) => {
			for (const e of entries) {
				const box = e.borderBoxSize?.[0]?.blockSize;
				set(typeof box === 'number' ? box : el.offsetHeight);
			}
		});
		ro.observe(el);
		return () => ro.disconnect();
	}
</script>

<script lang="ts">
	import { SINGER_COLORS, nearestPaletteStop, songDisplay, type Media, type TvProgressStyle } from '$lib/contract';
	import { keyShiftLabel } from '$lib/song-facts';
	import { IS_NEXT } from '$lib/phrasing/turn-phrasing';
	import TvProgress from '$lib/tv/TvProgress.svelte';

	/** The stage's text chrome: who is singing (bottom-left), the progress, and who is up next (top-right). */
	interface Props {
		name: string;
		color: string | null;
		media: Media | null;
		/** Transpose in semitones. */
		keyShift: number;
		progressStyle: TvProgressStyle;
		positionSec: number;
		durationSec: number;
		/** A takeover card is up (`layerShown`): the progress line hides, and fades back in as it leaves. */
		underCard: boolean;
		/** The card's words are painted at all, its exit fade included: the lower third hides. */
		cardPainted: boolean;
		/** The next turn, when it is not the one on stage. */
		next: { name: string; color: string | undefined; media: Media | null } | null;
		/** The lower third's rendered height, on every resize; /tv turns it into `--tv-chrome-h`. */
		oncardsize: (px: number) => void;
		/** The "Up next" block's rendered height, `--tv-upnext-h`. */
		onupnextsize: (px: number) => void;
		/** A copy's chip is showing: it stands in this block's place, so the block steps aside. */
		yieldUpnext?: boolean;
	}

	let {
		name,
		color,
		media,
		keyShift,
		progressStyle,
		positionSec,
		durationSec,
		underCard,
		cardPainted,
		next,
		oncardsize,
		onupnextsize,
		yieldUpnext = false
	}: Props = $props();

	// Canonical title/artist when a confident parse produced them, NEVER the uploader. Artist is null when
	// there is nothing trustworthy, and the markup omits the line rather than inventing one.
	const display = $derived(songDisplay(media));
	/** `Key -2` while shifted, nothing at 0. Never the key's NAME: see `keyShiftLabel`. */
	const keyLine = $derived(keyShiftLabel(keyShift));
	// The pill's fill and its certified ink, from the singer's palette stop.
	const stop = $derived(nearestPaletteStop(color ?? SINGER_COLORS[0]));
	// The progress is the pill's underline (redesign step 8): the default `edge` line, drawn inside the safe area.
	const underline = $derived(progressStyle === 'edge' || progressStyle === 'card');

	// MEASURED, not predicted: this card grows with its content, so a static sum UNDER-counts and covers the sung line.
	// The phone's dock is the same finding on the other surface — see the `--dock-h` note in src/routes/(phone)/+layout.svelte,
	// where a token-arithmetic height was tried and came to 102px against a rendered 91.
	let lowerThirdEl = $state<HTMLElement | undefined>();
	$effect(() => observeBlockSize(lowerThirdEl, oncardsize));

	// Same for "Up next": `.fs-btn` shares its z-tier and right edge and must clear the whole block, which GROWS when
	// the next title wraps.
	let upnextEl = $state<HTMLElement | undefined>();
	$effect(() => observeBlockSize(upnextEl, onupnextsize));
</script>

<!--
	WHO IS SINGING — bottom-left, a PILL in the singer's colour whose underline is the progress (redesign step 8): the
	singer named once, in their own colour. `--tv-chrome-h` is MEASURED from this element, so the class name and the
	ResizeObserver binding stay.
-->
<!-- Hidden, not unmounted, while a card is painted: its name is never repeated here, and `--tv-chrome-h` stays. -->
<div
	class={['lower-third', { 'under-card': cardPainted }]}
	style="--singer:{stop.fill};--on-singer:{stop.on_fill}"
	bind:this={lowerThirdEl}
>
	<span class="ls-name">{name}</span>
	<!-- The separator carries its own NBSP: Svelte collapses the leading space next to a tag boundary. -->
	<span class="ls-song"
		>{display.title}{#if display.artist}<span class="ls-artist">{'\u00a0- '}{display.artist}</span>{/if}</span
	>
	<!-- No key NAME and no lyric SOURCE: the room cannot act on either. The singer reads both on the phone, and
		the reel's amber tint alone says the words are a guess. -->
	{#if keyLine}
		<span class="ls-key">{keyLine}</span>
	{/if}
	{#if underline}
		{@render progress()}
	{/if}
</div>
{#if !underline}
	{@render progress()}
{/if}
{#snippet progress()}
	<TvProgress style={progressStyle} elapsedSec={positionSec} durationSec={durationSec} underCard={underCard} />
{/snippet}
<!-- PERMANENT, because the song-intro card is gone in seconds and someone waiting their turn needs it. Words, not an
	"UP NEXT" eyebrow. -->
{#if next}
	<div class={['upnext', { yielded: yieldUpnext }]} bind:this={upnextEl}>
		<span class="un-name">
			<span class="un-dot" style="--singer: {next.color ?? 'var(--ink-dim)'}"></span>{next.name}
			<span class="un-is">{IS_NEXT}</span>
		</span>
		<span class="un-song">{songDisplay(next.media).title}</span>
	</div>
{/if}

<style>
	/* The copy chip's place on a TV, and its neighbour across a narrow phone. A cut, as below. */
	.upnext.yielded {
		visibility: hidden;
	}
	/* A cut, not a fade: fading re-rasterises the blurred shadow every frame (docs/FRONTEND.md). */
	.lower-third.under-card {
		visibility: hidden;
	}
	/* CAPPED at 46vw, or a long title grows rightward into the join QR at bottom-right. An opaque fill, so the ink
	   reads on any backdrop with no text stroke or shadow. `overflow` clips the underline to the pill's radius. */
	.lower-third {
		position: absolute;
		left: var(--tv-safe-x);
		bottom: var(--tv-safe-y);
		z-index: var(--z-tv-card);
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		/* In `em` of the song line, so the pill scales with the vh-rooted type at 720p and 4K alike. */
		font-size: var(--tv-body);
		column-gap: 0.6em;
		max-width: 46vw;
		padding: 0.3em 1em 0.45em;
		border-radius: var(--radius-pill);
		background: var(--singer);
		color: var(--on-singer);
		overflow: hidden;
	}
	.ls-name {
		font-size: var(--tv-name);
		font-weight: 800;
		line-height: 1.05;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* Two lines, or an UNPARSED long raw title grows the block upward without bound. `-webkit-line-clamp` needs
	   the -webkit box display and hidden overflow beside it to take effect at all. */
	.ls-song {
		font-size: var(--tv-body);
		font-weight: 600;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
	}
	/* As an INLINE span inside .ls-song it must NOT carry white-space/overflow of its own: the overflow pair is
	   inert on an inline element, while `nowrap` DOES apply and hard-clips a long credit mid-word. */
	.ls-artist {
		font-size: var(--tv-body);
		font-weight: 500;
	}
	.ls-key {
		font-size: var(--tv-label);
		font-weight: 600;
	}

	/* Offset below the connection dot with a vh term, so the clearance scales instead of being right only at 1080p. */
	.upnext {
		position: absolute;
		right: var(--tv-safe-x);
		top: calc(var(--tv-safe-y) + 2.6vh);
		z-index: var(--z-tv-card);
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		/* The tightest rung of the TV ladder, not a flat 1px: 1px between three lines whose type is 58px at 4K is
		   not a gap, it is a collision. */
		gap: var(--tv-space-3xs);
		max-width: 32vw;
		text-align: right;
		text-shadow: 0 2px 14px rgba(0, 0, 0, 0.9);
	}
	.un-is {
		color: var(--ink-dim);
	}
	.un-name {
		font-size: var(--tv-body);
		font-weight: 800;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 32vw;
	}
	.un-dot {
		display: inline-block;
		width: 0.5em;
		height: 0.5em;
		border-radius: 50%;
		margin-right: 0.4em;
		background: var(--singer);
	}
	.un-song {
		font-size: var(--tv-label);
		color: var(--ink-dim);
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 32vw;
	}
</style>
