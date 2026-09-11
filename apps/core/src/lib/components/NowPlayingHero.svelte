<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	/*
	 * The now-playing HERO — direction A's home screen (docs/DECISIONS.md, issue #832).
	 *
	 * Not a row and not a docked peek. Under direction A the room's queue IS the home screen, so the
	 * playing song is the one thing on it that is not a list item: it gets its own surface, at the top,
	 * in normal flow. The bottom of the screen belongs to the one primary button instead, which is why
	 * this carries no drag gesture of its own — a range input inside a pointer-drag surface fights that
	 * gesture, which is the constraint GuidingTrack and RangeBar both state in their own headers and
	 * XR-PH-15 carries across this relocation.
	 *
	 * Everything the hero shows is passed in: it owns no state, reads no store and imports no `$app`
	 * module, so it MOUNTS under the repo's happy-dom harness and its rendering is measured rather than
	 * source-scanned (XR-PH-21).
	 */
	import type { Snippet } from 'svelte';
	import { formatClock, formatRemaining, progressFraction } from '$lib/clock';
	import Icon from '$lib/ui/Icon.svelte';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import { Progress } from '$lib/components/ui/progress';

	interface Props {
		/** The song, or the empty-state line when nothing is playing. */
		title: string;
		/** Who is singing it. Absent when nothing is playing. */
		singerName?: string | null;
		/** That singer's identity colour, for the eyebrow dot. */
		singerColor?: string | null;
		/** Second line: artist, and the key when one is detected. */
		byline?: string | null;
		/** Shown when nothing is playing, in place of the byline — what to do next. */
		hint?: string | null;
		elapsedSec?: number;
		durationSec?: number;
		isPlaying?: boolean;
		/** False when there is no song to act on: restart and skip then have nothing to command. */
		hasSong?: boolean;
		/** True when play can still mean something with nothing playing (a queue waiting to start). */
		canStart?: boolean;
		onrestart?: () => void;
		ontoggleplay?: () => void;
		onskip?: () => void;
		/**
		 * The live singing controls (guide vocals, key, range). Rendered in the disclosure BODY, never
		 * in its summary — XR-PH-15. The collapsed summary carries `controlsSummary` instead.
		 */
		controls?: Snippet;
		/** The current values, so the collapsed disclosure still says where the controls stand. */
		controlsSummary?: string | null;
		/**
		 * One sentence at the head of the control group when a control cannot act on this song — the
		 * reason, plus what still works (XR-PH-15). It lives HERE, beside the group, rather than inside
		 * the control it explains: #253 deleted that line from `GuidingTrack.svelte` and a guard pins its
		 * absence, and #835 Q1-D is the owner's ruling that the reason belongs on the hero instead.
		 *
		 * It is deliberately a sibling of the snippet's own markup, not a child of it, because the
		 * disabled controls dim their subtree with `opacity` (`.gt.disabled`, `.key.disabled`) — a
		 * sentence rendered inside one of those would paint at half its measured contrast (XR-PH-03).
		 */
		controlsNote?: string | null;
	}
	let {
		title,
		singerName = null,
		singerColor = null,
		byline = null,
		hint = null,
		elapsedSec = 0,
		durationSec = 0,
		isPlaying = false,
		hasSong = false,
		canStart = false,
		onrestart,
		ontoggleplay,
		onskip,
		controls,
		controlsSummary = null,
		controlsNote = null
	}: Props = $props();

	// null (not 0) for an unknown length, so the row HIDES rather than showing a bar pinned at zero —
	// which reads as a stalled song. Same decision, same reason, as the position card's absent wait.
	const progress = $derived(progressFraction(elapsedSec, durationSec));
	let controlsOpen = $state(false);
</script>

<section class="hero card" aria-label="Now playing">
	<!-- The eyebrow names WHO is singing, so with nothing playing it has nothing to say: an earlier
	     version printed "Nothing playing" here AND as the title, one line above the other. Measured on a
	     driven idle room — the frame is what found it. -->
	{#if singerName}
		<div class="eyebrow">
			<!-- app.css's shared `.singer-dot` (#913 Phase 2): the hue arrives as `--singer`, set here. -->
			<span class="singer-dot" style="--singer:{singerColor ?? 'var(--accent)'}"></span>
			<span>Now singing · {singerName}</span>
		</div>
	{/if}
	<h1 class="song">{title}</h1>
	{#if byline}
		<p class="byline">{byline}</p>
	{:else if hint}
		<p class="byline">{hint}</p>
	{/if}

	{#if progress !== null}
		<!-- Time REMAINING on the right, because the question this screen exists to answer is "when am
		     I up?". `aria-hidden` because the position card states the same thing in words. -->
		<div class="seekrow" aria-hidden="true">
			<span class="time">{formatClock(elapsedSec)}</span>
			<!-- The third copy of the hand-rolled `.track` + `<i>` idiom, now ui/progress like the other two
			     (#913 S6): same `var(--grad)` fill, same transform-only transition and reduced-motion reset,
			     `size="sm"` for this row's 4px. It brings `role="progressbar"` with it, which sits inside the
			     `aria-hidden` row deliberately — the position card already states the same thing in words, so
			     announcing it twice is the regression, not the win. -->
			<div class="bar-slot"><Progress value={progress * 100} size="sm" /></div>
			<span class="time r">{formatRemaining(elapsedSec, durationSec)}</span>
		</div>
	{/if}

	<!--
		The transport is disabled when there is nothing for it to act on. It used to be unconditionally
		enabled, so an empty room showed a full-weight primary play button plus restart and skip, all
		three dispatching commands the server could only ignore. Restart and skip need a song that is
		PLAYING; play additionally accepts a queue with something in it, because "start when it is
		ready" is a real intent and the server, not the phone, decides when that is.
	-->
	<div class="transport">
		<Button variant="outline" size="icon" aria-label="restart" disabled={!hasSong} onclick={() => onrestart?.()}>
			<Icon name="prev" />
		</Button>
		<Button
			variant="iconPrimary"
			size="icon"
			aria-label="play/pause"
			disabled={!hasSong && !canStart}
			onclick={() => ontoggleplay?.()}
		>
			<Icon name={isPlaying ? 'pause' : 'play'} />
		</Button>
		<Button variant="outline" size="icon" aria-label="skip" disabled={!hasSong} onclick={() => onskip?.()}>
			<Icon name="next" />
		</Button>
	</div>

	<!--
		`hasSong` gates the disclosure, not just the snippet's presence: these are LIVE controls for the
		song playing now (docs/DECISIONS.md), so an idle room has nothing for them to act on — the driven
		idle frame showed "Adjust while you sing" over an empty stage. This is NOT the XR-PH-15
		degradation, which is about a song that HAS no vocals stem: that case keeps the guide-vocal row
		visible and disabled with its reason, and it is GuidingTrack's own `available` prop.
	-->
	{#if controls && hasSong}
		<!-- Live controls for the song playing NOW, behind a disclosure so the hero stays readable at a
		     glance. Same idiom as the Browse and Vocal-range toggles: a real <button> carrying
		     aria-expanded, a chevron-down/right Icon swap, and the app's shared tap target. -->
		<div class="tools">
			<Collapsible.Root bind:open={controlsOpen}>
				<Collapsible.Trigger>
					{#snippet child({ props })}
						<!--
							Full-width ghost button = <Button variant="ghost" size="block">. `size="block"` is what
							carries the width AND the tap floor (`w-full min-h-tap`); written as a utility at this
							call site it would emit nothing, because app.css is `source(none)` with a single
							`@source` over components/ui.

							`.tools-toggle` stays on the BUTTON rather than moving to an inner span: the e2e drives
							this control by that class and reads `aria-expanded` off it (e2e/contract.ts
							`toolsToggle`), and the disclosure state lives on the button, not on its contents.
						-->
						<Button variant="ghost" size="block" {...props} class="tools-toggle">
							<Icon name={controlsOpen ? 'chevron-down' : 'chevron-right'} />
							<span class="tools-label">Adjust while you sing</span>
							{#if controlsSummary}<span class="tools-peek">{controlsSummary}</span>{/if}
						</Button>
					{/snippet}
				</Collapsible.Trigger>
				<Collapsible.Content>
					{#snippet child({ props })}
						<!--
							The {#if} INSIDE the content is deliberate. This body holds a Bits UI Slider
							(GuidingTrack), which reads `offsetWidth`; the mount rung replaces that with a throw
							(XR-VER-03), so it must not mount while the disclosure is collapsed. Collapsible renders
							its content always and hides it, which would mount the slider on every hero.
						-->
						<div class="tools-body" {...props}>
							{#if controlsOpen}
								<!-- Ahead of the controls, so the reason is read BEFORE the dead control it explains rather
					     than after it — and outside the snippet, so no `opacity` on a disabled control can dim
					     it (XR-PH-15 / XR-PH-03). -->
								{#if controlsNote}<p class="tools-note">{controlsNote}</p>{/if}
								{@render controls()}
							{/if}
						</div>
					{/snippet}
				</Collapsible.Content>
			</Collapsible.Root>
		</div>
	{/if}
</section>

<style>
	/* Surface, radius and border come from .card in app.css. */
	.hero {
		padding: var(--space-xl) var(--space-2xl) var(--space-lg);
		margin: 0 0 var(--space-md);
	}
	.eyebrow {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: var(--ph-text-2xs);
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--ink-dim);
		min-width: 0;
	}
	/* The identity dot is app.css's shared `.singer-dot` (#913 Phase 2) — this was the third of the four
	   byte-identical copies that rule replaced. `flex: 0 0 auto` is load-bearing and lives with it:
	   `.eyebrow` is a flex row, an empty element's automatic minimum size is 0, and under a long singer
	   name the dot is what shrinks — it collapsed to 0px and the colour vanished (issue #89). */
	.eyebrow span:last-child {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* The hero's whole job: the song, at hero weight. Two lines then ellipsis, so a full YouTube title
	   cannot push the transport off screen. */
	.song {
		margin: var(--space-xs) 0 0;
		font-size: 1.35rem;
		font-weight: 800;
		line-height: 1.15;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.byline {
		margin: var(--space-2xs) 0 0;
		font-size: 0.82rem;
		color: var(--ink-dim);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.seekrow {
		display: flex;
		align-items: center;
		gap: 9px;
		margin: var(--space-lg) 0 var(--space-3xs);
	}
	.time {
		font-size: var(--ph-text-2xs);
		color: var(--ink-dim);
		font-variant-numeric: tabular-nums;
		min-width: 30px;
	}
	.time.r {
		text-align: right;
	}
	/*
	 * #913 S6: `.track` and its `<i>` fill are ui/progress now — the same idiom lived in THREE
	 * components (ProcessingCard, SongRow, here), differing only in height, and the vendored bar owns
	 * the gradient, the composited transform and `role="progressbar"`. What stays here is where the bar
	 * sits in this ROW rather than the bar's own metric, which is the same split `.bar-slot` carries at
	 * the other two call sites.
	 */
	.bar-slot {
		flex: 1;
		min-width: 0;
	}
	.transport {
		display: flex;
		align-items: center;
		gap: var(--space-md);
		margin-top: var(--space-md);
	}
	/* The tool buttons take sizing, radius, surface and glyph size from <Button variant="icon"> in
	   components/ui/button, which derives its box from var(--tap) — no literal here (XR-PH-01).
	   `.icon-btn` in app.css was deleted in #913 S1b once all ten of its consumers became that variant;
	   the rules below are this file's own layout only. */
	.tools {
		margin-top: var(--space-lg);
		border-top: 1px solid var(--line);
		padding-top: var(--space-2xs);
	}
	/*
	 * Width, the tap floor, the surface and the press feedback all come from
	 * <Button variant="ghost" size="block">. What is left here is only what that variant cannot know:
	 * the button base CENTRES its content, and this control is a left-aligned label with the current
	 * values pushed to the right edge.
	 *
	 * `:global` is required, not stylistic — the class is handed to a CHILD component, so Svelte's scope
	 * hash lands on nothing and a plain rule would match no element (ui-scoped-style-reach-913.test.ts,
	 * which names `:global()` as one of the two sanctioned fixes).
	 */
	:global(.tools-toggle) {
		gap: var(--space-sm);
		justify-content: flex-start;
		font-size: 0.82rem;
		font-weight: 600;
		text-align: left;
	}
	.tools-label {
		flex: 0 0 auto;
	}
	/* The collapsed peek of the current values, pushed right. Not uppercase — it is data, not a label. */
	.tools-peek {
		margin-left: auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 500;
		color: var(--ink-dim);
	}
	.tools-body {
		padding-bottom: var(--space-2xs);
	}
	/* De-emphasised with the dim INK token, never with `opacity` — an ancestor opacity flattens the
	   sentence and the card behind it into one buffer, so the measured contrast stops being what is
	   painted. This is the same reason the sentence sits outside the snippet at all (XR-PH-03). */
	.tools-note {
		margin: var(--space-3xs) 0 0;
		font-size: 0.7rem;
		line-height: var(--lh-normal);
		color: var(--ink-dim);
	}
</style>
