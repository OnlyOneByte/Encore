<script lang="ts" module>
	/** Which takeover is up, ONE at a time: /tv's `transient`. */
	export type TakeoverKind = 'error' | 'waiting' | 'next' | 'loading';
</script>

<script lang="ts">
	import type { TransitionEventHandler } from 'svelte/elements';
	import { songDisplay, type Media, type QueueEntry, type ServerEvent } from '$lib/contract';
	import { processStageLabelAscii } from '$lib/phrasing/process-phrasing';
	import { UP_NEXT } from '$lib/phrasing/turn-phrasing';
	import { waitingProgress, PROCESS_STEPS } from '$lib/tv/screen';
	import Icon from '$lib/ui/Icon.svelte';

	/** The full-screen takeovers. /tv decides which card is up and when it fades; this draws it. */
	interface Props {
		/** The layer is up (`layerShown`). */
		shown: boolean;
		/** What the card SAYS; a change re-mounts the lines. */
		cardWords: string | null;
		handoff: { entry: QueueEntry; label: string } | null;
		cardKind: TakeoverKind | null;
		/** The Skipped notice's words, held through its fade. */
		notice: string;
		skipNext: QueueEntry | null;
		current: QueueEntry | null;
		liveStatus: Map<string, Extract<ServerEvent, { type: 'media:status' }>>;
		mediaOf: (entry: QueueEntry | null) => Media | null;
		singerName: (id: string | undefined) => string;
		layer?: HTMLDivElement;
		ontransitionend: TransitionEventHandler<HTMLDivElement>;
	}

	let {
		shown,
		cardWords,
		handoff,
		cardKind,
		notice,
		skipNext,
		current,
		liveStatus,
		mediaOf,
		singerName,
		layer = $bindable(),
		ontransitionend
	}: Props = $props();
</script>

<!-- Transient states, ONE at a time, in ONE layer that stays mounted so it can fade out as well as in. See
	docs/FRONTEND.md#the-full-screen-takeovers. -->
<div class={['takeover-layer', { shown }]} aria-hidden={!shown} bind:this={layer} ontransitionend={ontransitionend}>
	{#key cardWords}
		{#if handoff}
			{@const d = songDisplay(mediaOf(handoff.entry))}
			<div class="interstitial takeover state-next">
				<div class="up-label">{handoff.label}</div>
				<div class="up-name hero-name">{singerName(handoff.entry.singerId)}</div>
				<div class="up-song">
					{d.title}{#if d.artist}<span class="up-artist-inline">{'\u00a0- '}{d.artist}</span>{/if}
				</div>
			</div>
		{:else if cardKind === 'error'}
			<!-- Names what is GOING and what REPLACES it in one breath, so the room never wonders whose turn it is. -->
			<div class="interstitial takeover state-error" role="alert">
				<div class="state-mark"><Icon name="warning" /></div>
				<div class="up-label">Skipped</div>
				<div class="up-song">{notice}</div>
				{#if skipNext}
					<div class="up-replaces">
						{UP_NEXT} - {singerName(skipNext.singerId)} - {songDisplay(mediaOf(skipNext)).title}
					</div>
				{/if}
			</div>
		{:else if cardKind === 'waiting'}
			<!-- A WAIT, not a failure: a bounded 3-step progress makes it read as finite, in words from
			     process-phrasing (the ONE guest-facing vocabulary, shared with the phone). The bar and the step are the
			     song's `liveStatus`, the phone's own figure; with none held for it, neither is drawn. -->
			{@const processMedia = mediaOf(current)}
			{@const proc = waitingProgress(current ? liveStatus.get(current.mediaId) : undefined)}
			<div class="interstitial takeover state-waiting">
				<div class="state-mark"><Icon name="flame" /></div>
				<div class="up-label">{processStageLabelAscii('queued')}</div>
				<div class="up-song hero-song">{songDisplay(processMedia).title}</div>
				<!-- Always laid out, hidden with no figure, so the centred title holds still when a status arrives or goes. -->
				<div class={{ 'process-slot': true, unknown: !proc }} aria-hidden={proc ? undefined : 'true'}>
					<div class="process-bar"><i style="width: {proc?.pct ?? 0}%"></i></div>
					<div class="process-steps">
						{#each PROCESS_STEPS as label, i (label)}
							<span class={{ 'step-current': i === proc?.index, 'step-done': !!proc && i < proc.index }}>{label}</span>
						{/each}
					</div>
				</div>
			</div>
		{/if}
	{/key}
</div>

<style>
	/* Mounted for the whole stage, so it can fade OUT: invisible and inert until a takeover is up. Only opacity and
	   transform move, and only for `no-preference`; under reduce the card cuts in and out. The exit is the player
	   slots' crossfade (TvPlayer, `--motion-base` ease), so the card leaves as the song arrives. */
	.takeover-layer {
		position: absolute;
		inset: 0;
		z-index: var(--z-tv-interstitial);
		opacity: 0;
		pointer-events: none;
	}
	.takeover-layer.shown {
		opacity: 1;
		pointer-events: auto;
	}
	@media (prefers-reduced-motion: no-preference) {
		.takeover-layer {
			transition: opacity var(--motion-base) ease;
		}
		.takeover-layer.shown {
			transition: opacity var(--motion-slow) ease-out;
		}
		/* The lines, not the scrim: a change of words re-mounts them (`{#key cardWords}`), so they rise in again
		   while the layer stays up. */
		.takeover-layer.shown .interstitial > * {
			animation: card-rise var(--motion-slow) ease-out both;
		}
	}
	@keyframes card-rise {
		from {
			opacity: 0;
			transform: translateY(var(--tv-space-4xl));
		}
	}
	.interstitial {
		position: absolute;
		inset: 0;
		z-index: var(--z-tv-interstitial);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--tv-space-lg);
		/* A SCRIM, not a wash: an opaque wash blanks the room's chosen backdrop for every song change — the exact
		   black flash the background layer's visibility band exists to avoid, undone one layer up. */
		background: radial-gradient(
			70% 55% at 50% 50%,
			color-mix(in srgb, var(--bg) 88%, transparent) 0%,
			color-mix(in srgb, var(--bg) 62%, transparent) 62%,
			transparent 100%
		);
		padding: var(--tv-safe-y) var(--tv-safe-x);
		text-align: center;
	}
	.up-label {
		font-size: var(--tv-eyebrow);
		letter-spacing: 0.2em;
		text-transform: uppercase;
		color: var(--ink-dim);
	}
	.up-name {
		font-size: var(--tv-hero);
		font-weight: 900;
		line-height: 1.02;
	}
	.up-song {
		font-size: var(--tv-name);
	}
	.up-artist-inline {
		color: var(--ink-dim);
	}
	/* Large enough to be the first thing read, since it is what distinguishes these states. */
	.state-mark {
		font-size: var(--tv-hero);
		line-height: var(--lh-none);
		margin-bottom: var(--tv-space-2xs);
	}

	/* Colour is NEVER the only carrier: each takeover also keeps its own eyebrow, and error/processing a mark. */
	.takeover {
		align-items: flex-start;
		justify-content: center;
		text-align: left;
		padding-left: var(--tv-safe-x);
		border-left: var(--tv-takeover-border) solid transparent;
	}
	/* --accent as a NON-TEXT border/fill, which is what it is certified for; the text is --ink / --accent2. */
	.state-next.takeover {
		border-left-color: var(--accent);
		background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 16%, transparent), transparent 55%);
	}
	.hero-name {
		font-size: var(--tv-takeover-name);
		font-weight: 900;
		line-height: 1.02;
	}
	.state-next .up-song {
		color: var(--accent2);
		margin-top: 1.4vh;
	}

	.state-error.takeover {
		border-left-color: var(--danger);
		background: linear-gradient(90deg, color-mix(in srgb, var(--danger) 14%, transparent), transparent 55%);
	}
	.state-error .state-mark {
		color: var(--danger);
	}
	.state-error .up-label {
		color: var(--danger-ink);
	}
	.state-error .up-song {
		color: var(--danger-ink);
	}
	.up-replaces {
		font-size: var(--tv-name);
		color: var(--ink-dim);
		margin-top: 1.4vh;
	}

	.state-waiting.takeover {
		border-left-color: var(--warn);
		background: linear-gradient(90deg, color-mix(in srgb, var(--warn) 10%, transparent), transparent 55%);
	}
	.state-waiting .state-mark {
		color: var(--warn);
	}
	.state-waiting .up-label {
		color: var(--warn);
	}
	.state-waiting .up-song {
		color: var(--ink);
	}
	.hero-song {
		font-size: var(--tv-hero);
		font-weight: 900;
		line-height: 1.04;
		margin-top: 1vh;
	}
	/* `contents`, so the bar and steps stay the takeover's own flex items; `visibility` inherits into both. */
	.process-slot {
		display: contents;
	}
	.process-slot.unknown {
		visibility: hidden;
	}
	.process-bar {
		width: var(--tv-process-bar-w);
		height: var(--tv-process-bar-h);
		border-radius: var(--radius-pill);
		background: var(--track-bg);
		margin-top: 3vh;
		overflow: hidden;
	}
	.process-bar i {
		display: block;
		height: 100%;
		background: var(--warn);
	}
	.process-steps {
		display: flex;
		gap: var(--tv-space-4xl);
		margin-top: 2vh;
		font-size: var(--tv-small);
		color: var(--ink-dim);
	}
	.process-steps .step-current {
		color: var(--warn);
		font-weight: 700;
	}
	.process-steps .step-done {
		color: var(--ink);
	}
</style>
