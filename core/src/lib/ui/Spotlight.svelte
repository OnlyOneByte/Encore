<!--
  The one lit surface a screen may have (redesign step 2). It takes the colour of whoever owns the moment, and only
  transform and opacity animate. Design: docs/FRONTEND.md#the-spotlight-and-the-guide-segments.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { nearestPaletteStop } from '$lib/contract/presentation/player-palette';
	import { createGrace } from '$lib/ui/grace';

	type Moment = 'idle' | 'on-deck' | 'your-turn' | 'error';

	let {
		moment = 'idle',
		title,
		meta,
		colour,
		busy = false,
		busyLabel = 'Working',
		children
	}: {
		moment?: Moment;
		title: string;
		meta?: string;
		/** The owner's singer colour. Snapped to its registry stop, whose on_fill is the only ink certified on it. */
		colour?: string;
		busy?: boolean;
		busyLabel?: string;
		children?: Snippet;
	} = $props();

	const stop = $derived(colour ? nearestPaletteStop(colour) : null);
	const lit = $derived(moment === 'on-deck' || moment === 'your-turn');

	let showBusy = $state(false);
	const grace = createGrace({ onShow: (shown) => (showBusy = shown) });
	$effect(() => grace.set(busy));
	$effect(() => () => grace.dispose());
</script>

<section
	class="spotlight {moment}"
	class:lit={lit}
	data-moment={moment}
	aria-label={title}
	aria-busy={busy}
	style:--spot={stop?.fill}
	style:--on-spot={stop?.on_fill}
>
	<span class="fill" aria-hidden="true"></span>
	{#if meta || showBusy}
		<p class="meta">
			{#if meta}<span>{meta}</span>{/if}
			<!-- Not ui/spinner: importing it from here split cn() into its own chunk, +6 KB gz JS on every route. -->
			{#if showBusy}<span class="busy" role="status" aria-label={busyLabel} data-slot="spinner"></span>{/if}
		</p>
	{/if}
	<h2 class="title">{title}</h2>
	{#if children}<div class="body">{@render children()}</div>{/if}
</section>

<style>
	.spotlight {
		position: relative;
		isolation: isolate;
		display: flex;
		flex-direction: column;
		gap: var(--step-1);
		padding: var(--step-4) var(--step-4) var(--step-3);
		border-radius: var(--round-spot);
		background: var(--role-raise);
		color: var(--role-ink);
		box-shadow: inset 0 0 0 2px var(--spot);
		/* What a pressed Guide segment inks itself in, so it reads on this card's own fill. */
		--seg-ink: var(--role-raise);
	}
	/* The fill is a layer, so lighting the card is an opacity change rather than a background animation. An element,
	   not ::before, so the motion capture can seek it. */
	.fill {
		position: absolute;
		inset: 0;
		z-index: -1;
		border-radius: inherit;
		background: var(--spot);
		opacity: 0;
	}
	.lit {
		color: var(--on-spot);
		box-shadow: none;
		--seg-ink: var(--spot);
	}
	.lit .fill {
		opacity: 1;
	}
	.error {
		background: var(--role-danger-surface);
		box-shadow: inset 0 0 0 2px var(--role-danger-line);
	}
	.your-turn {
		padding: var(--step-7) var(--step-4) var(--step-6);
	}
	.meta {
		display: flex;
		align-items: center;
		gap: var(--step-2);
		margin: 0;
		font-size: var(--type-meta);
		font-weight: 600;
		line-height: var(--lh-snug);
	}
	/* 0.8, not lower: at 0.72 sixteen singer stops fall under 4.5:1 (spotlight-tokens.test.ts). */
	.meta span {
		opacity: 0.8;
	}
	.error .meta {
		color: var(--role-danger);
	}
	.error .meta span {
		opacity: 1;
	}
	.busy {
		width: 15px;
		height: 15px;
		flex: none;
		border-radius: 50%;
		border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
		border-top-color: currentColor;
	}
	.title {
		margin: 0;
		font-size: var(--type-lead);
		font-weight: 800;
		line-height: var(--lh-tight);
	}
	.on-deck .title {
		font-size: var(--type-display);
		letter-spacing: -0.02em;
	}
	.your-turn .title {
		font-size: var(--type-hero);
		letter-spacing: -0.03em;
		line-height: var(--lh-none);
	}
	.body {
		margin-top: var(--step-2);
		font-size: var(--type-body);
		line-height: var(--lh-normal);
	}
	@media (prefers-reduced-motion: no-preference) {
		.spotlight {
			animation: spot-in var(--motion-base) var(--ease-out);
		}
		/* No flood: from On deck the fill is already lit, and a fresh mount fades in with spot-in. */
		.your-turn .title {
			animation: spot-pop var(--motion-slow) var(--ease-out);
		}
		.busy {
			animation: spot-spin var(--motion-tick) linear infinite;
		}
	}
	@keyframes spot-spin {
		to {
			transform: rotate(360deg);
		}
	}
	@keyframes spot-in {
		from {
			opacity: 0;
			transform: scale(0.98);
		}
	}
	@keyframes spot-pop {
		from {
			opacity: 0;
			transform: scale(0.92);
		}
	}
</style>
