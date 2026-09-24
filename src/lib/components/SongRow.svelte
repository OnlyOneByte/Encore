<script lang="ts">
	// ONE row shape for all readiness states: the state decides the badge line and which actions appear, and the
	// layout never changes, so a row that finishes processing morphs in place instead of jumping between lists.
	import type { Readiness } from '$lib/readiness';
	import { processStageLabel } from '$lib/phrasing/process-phrasing';
	import { type MediaStatus } from '$lib/contract';
	import { overallProcessPct } from '$lib/process-progress';
	import Icon from '$lib/ui/Icon.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Progress } from '$lib/components/ui/progress';
	import * as Item from '$lib/components/ui/item';
	import {
		classifyVideoKind,
		durationHint,
		formatDuration,
		formatViewCount,
		isUnusualSongDuration,
		VIDEO_KIND_LABEL
	} from '$lib/video-kind';

	interface Props {
		/** The RAW source title, shown verbatim and deliberately NOT the canonical one: the normalizer feeds LOOKUPS,
		 * where a wrong guess costs a missed match, and here a wrong guess would be shown to a human as fact. */
		title: string;
		/** The UPLOADER as the source reported it — a YouTube channel, often not the artist. */
		artist?: string;
		/** The normalizer's confident artist (Media.artistCanonical), when there is one. */
		artistCanonical?: string;
		readiness: Readiness;
		/** Remote thumbnail URL (proxied through /api/thumb). Absent → the gradient placeholder. */
		thumbnail?: string;
		/** Runtime in seconds; 0/absent hides the badge rather than rendering "0:00". */
		durationSec?: number;
		/** Views as the source reported them. Absent → no chip; see Media.viewCount. */
		viewCount?: number;
		/** A FLAT prop rather than the whole profile, because the row shows only this string. MUST stay ASCII
		 * ('G#'/'Ab'): a typographic sharp or flat trips icons.test.ts. */
		keyName?: string;
		/** Descriptive library tags, shown on a READY row only — a raw search result has none worth showing. */
		tags?: string[];
		pct?: number; // processing progress, 0..100
		/** Present, the bar shows `overallProcessPct(status, pct)` rather than the raw per-step pct, which fills to
		 * 100% at the end of EVERY step and jumps backward when the next resets it. Absent, the raw pct is used. */
		status?: MediaStatus;
		/** Already in the rotation — the add action becomes a confirmation instead of a repeat. */
		inQueue?: boolean;
		/** False is the metadata-only case, and BOTH actions must go with it: the branches below are an either/or, so
		 * dropping only `onmake` falls through to a live add — and a turn on a song that can never be processed is held
		 * in the rotation and silently skipped every pass. The row still says why, in the chip line. */
		processable?: boolean;
		onadd?: () => void;
		/** Request stem separation. Absent when it makes no sense (already ready / already processing). */
		onmake?: () => void;
	}
	let {
		title,
		artist,
		artistCanonical,
		readiness,
		thumbnail,
		durationSec,
		viewCount,
		keyName,
		tags,
		pct = 0,
		status,
		inQueue = false,
		processable = true,
		onadd,
		onmake
	}: Props = $props();

	/* The byline answers a different question on each side of `ready`: a raw or processing row is a CANDIDATE
	   UPLOAD, where the channel distinguishes two uploads of one song and is raw data so cannot be wrong; a ready
	   row is a song in YOUR LIBRARY, where the channel is meaningless and the artist is the useful fact. */
	const byline = $derived(
		readiness === 'ready' ? (artistCanonical ?? artist ?? '') : (artist ?? artistCanonical ?? '')
	);

	/* ALWAYS through the app's own proxy, never straight to the upstream host: the phone may be on a LAN with no
	   route to the internet, and a direct img would leak every guest's IP and User-Agent upstream per keystroke. */
	const thumbSrc = $derived(thumbnail ? `/api/thumb?u=${encodeURIComponent(thumbnail)}` : null);

	const duration = $derived(formatDuration(durationSec));
	// Carried by BOTH the badge colour and a worded chip: colour alone reads as "a red badge you don't understand".
	const oddDuration = $derived(isUnusualSongDuration(durationSec));
	const durationNote = $derived(durationHint(durationSec));

	// Guessed from the RAW title, so `unknown` yields no label and therefore no chip, not a false "Official".
	const kind = $derived(classifyVideoKind(title));
	const kindLabel = $derived(VIDEO_KIND_LABEL[kind]);

	const views = $derived(formatViewCount(viewCount));

	/* READY-row facts only: a raw or processing row has no analysed key yet, so one here would be a phantom, and a
	   tag on a candidate upload is noise. A falsy guard removes the chip and, when last, the whole wrapper. */
	const showKey = $derived(readiness === 'ready' && !!keyName);
	const showTags = $derived(readiness === 'ready' && !!tags && tags.length > 0);

	// Guest-facing copy in this file is PARTY ENGLISH: a guest waits for a karaoke track, not an "instrumental".
	const barPct = $derived(status ? overallProcessPct(status, pct) : pct);

	const stateChip = $derived.by(() => {
		if (readiness === 'ready') return processStageLabel('ready');
		// A dead process must say so, or it keeps rendering the in-flight line forever on a stopped job.
		if (readiness === 'failed') return processStageLabel('failed');
		// 'queued' is the LEAST-COMMITTAL in-flight value: the row has no worker sub-status and naming a step would
		// print a guess as fact. Only the READOUT is rounded — the bar keeps the unrounded value so its transition
		// stays smooth, and an unrounded readout prints "31.200000000000003%".
		if (readiness === 'processing') return processStageLabel('queued', { pct: Math.round(barPct) });
		// Metadata-only, LAST so it can never mask a real process state. The row MUST say why its actions are gone:
		// on a phone a `title` on a disabled button is unreachable, and a dead control reads as a broken app.
		if (!processable) return 'Name match only — search to sing it';
		return null;
	});

	// The buttons are bare marks, so these labels are the whole announcement, and the process label names its COST.
	// `onmake` WITH `inQueue` is the retry state — the singer already holds a turn and its process died — so it needs
	// its own words: "Sing this" would promise a turn the action does not take.
	const retryProcess = $derived(!!onmake && inQueue);
	const actionLabel = $derived(
		retryProcess
			? 'Try making the karaoke again — you already have a turn for this song'
			: onmake
				? 'Sing this — strips the vocals first, takes about a minute'
				: // Announced BEFORE the inQueue branch because it is the stronger fact: this song can never be
					// sung here, so "Already in the queue" would be both wrong and beside the point.
					!processable
					? 'Can’t sing this one — it’s a name match only. Search for the song to make karaoke.'
					: inQueue
						? 'Already in the queue'
						: 'Add a turn'
	);
</script>

<!-- THE ROW IS A CONTAINER, NEVER A BUTTON: as a role="button" wrapper it announces one control while offering
	three, and lets a keyboard user add the same song twice. Item.Root supplies the row grammar through its `child`
	snippet; the `class` ATTRIBUTE must stay static, because contrast.test.ts splits it to derive the row's classes. -->
<Item.Root variant="bare" size="bare">
	{#snippet child({ props })}
		<div
			{...props}
			class="row card list-row"
			class:ready={readiness === 'ready'}
			class:processing={readiness === 'processing'}
		>
			<Item.Media data-media="thumb"
				><div class="thumb">
					{#if thumbSrc}
						<!-- alt="" on purpose: the title sits immediately beside it, so a described thumbnail says the song twice. -->
						<img src={thumbSrc} alt="" loading="lazy" decoding="async" width="84" height="47" />
					{:else}
						<!-- No thumbnail (a local library file, or a resolver that reports none) — keep the mark. -->
						<span class="ph"><Icon name="play" /></span>
					{/if}
					{#if duration}
						<span class="dur" class:odd={oddDuration}>{duration}</span>
					{/if}
				</div></Item.Media
			>

			<Item.Content>
				<!-- THE MARK MUST STAY A SIBLING of `.t`, never a child: `.t` is a two-line clamp with overflow hidden, so a
					mark inside it is laid out on the discarded third line and never paints on a phone. -->
				<div class="title-line">
					<span class="t">{title}</span>
					{#if readiness === 'processing'}<span class="sparkle"><Icon name="sparkle" /></span>{/if}
				</div>
				{#if byline}<div class="byline">{byline}</div>{/if}
				{#if kindLabel || stateChip || views || durationNote || showKey || showTags}
					<div class="chips">
						{#if stateChip}
							<!-- The tone IS the meaning, so it is passed as a variant; `wrap` because this chip carries a phrase. -->
							<Badge
								variant={readiness === 'ready'
									? 'ok'
									: readiness === 'processing'
										? 'warn'
										: readiness === 'failed'
											? 'bad'
											: 'neutral'}
								wrap
								aria-live="polite">{stateChip}</Badge
							>
						{/if}
						{#if kindLabel}<Badge
								variant={kind === 'official'
									? 'ok'
									: kind === 'lyric'
										? 'accent'
										: kind === 'live'
											? 'warn'
											: kind === 'suspect'
												? 'bad'
												: 'neutral'}>{kindLabel}</Badge
							>{/if}
						<!-- NEUTRAL chips: each is a fact about the song, not a status, so neither may borrow the semantic tints. -->
						{#if showKey}<Badge>{keyName}</Badge>{/if}
						<!-- Ordered after the kind, so "Live · Longer than a song" reads as one thought about one recording. -->
						{#if durationNote}<Badge variant="bad" wrap>{durationNote}</Badge>{/if}
						{#if views}<Badge>{views} views</Badge>{/if}
						{#if showTags}{#each tags! as tag (tag)}<Badge variant="tag">{tag}</Badge>{/each}{/if}
					</div>
				{/if}
				{#if readiness === 'processing'}
					<!-- GPU-composited fill: scaleX from the left edge, never animates layout width -->
					<div class="bar-slot"><Progress value={barPct} size="sm" aria-label="Process progress" /></div>
				{/if}
			</Item.Content>

			{#if onmake}
				<!-- ONE action, never two: queueing without processing holds a rotation slot that can never become ready, and
					processing without queueing gives the singer no turn. Icon-only, and the MARK is load-bearing: the two actions
					differ on three axes, so a bare plus for both dresses an expensive action as a free one. See
					src/lib/process-and-queue.ts. -->
				<Button
					variant="iconPrimary"
					size="icon"
					data-testid="song-sing"
					data-retry={retryProcess ? '' : undefined}
					aria-label={actionLabel}
					title={retryProcess
						? 'Try the karaoke again — you keep the turn you already have'
						: 'Take a turn now and strip the vocals — you keep your place in line while it processes'}
					onclick={() => onmake?.()}
				>
					<Icon name="sparkle" />
				</Button>
			{:else}
				<Button
					variant="iconReady"
					size="icon"
					data-testid="song-add"
					data-row-state={inQueue ? 'queued' : !processable ? 'unavailable' : undefined}
					aria-label={actionLabel}
					title={!processable
						? 'Can’t sing this one — it’s a name match only. Search for the song to make karaoke.'
						: inQueue
							? 'Already in the queue'
							: 'Add a turn'}
					disabled={inQueue || !processable}
					onclick={() => onadd?.()}
				>
					{#if inQueue}<Icon name="check" />{:else}<Icon name="plus" />{/if}
				</Button>
			{/if}
		</div>
	{/snippet}
</Item.Root>

<style>
	/* Geometry comes from `.list-row` in app.css, shared with the two queue rows. Every rule that declares a COLOUR
	   has to stay in this file: contrast.test.ts reasons about a row's surfaces from its own rules. */
	.row {
		transition: background var(--motion-fast) ease;
	}
	/* Readiness is legible from the border alone, before any text is read. */
	.row.ready {
		border-color: var(--ok);
	}
	.row.processing {
		background: linear-gradient(var(--card), var(--card-tint));
		border-color: var(--line-tint);
	}

	/* 84×47 is 16:9, matching the source frame, so nothing is letterboxed or cropped. */
	.thumb {
		position: relative;
		width: 84px;
		height: 47px;
		border-radius: var(--radius-btn);
		flex: 0 0 auto;
		overflow: hidden;
		background: linear-gradient(135deg, var(--track-bg), var(--card));
		display: grid;
		place-items: center;
	}
	.thumb img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	/* A real element, never a `content:` codepoint — a glyph in CSS is the one place an attribute-level scan for
	   stray marks cannot find it. Its translucent white is a PHOTO-OVERLAY exception, not a theme colour. */
	.ph {
		color: rgba(255, 255, 255, 0.55);
		font-size: var(--ph-text-md);
		display: grid;
		place-items: center;
	}

	/* Duration burned into the frame's corner, so it needs no label and costs the row no height. */
	.dur {
		position: absolute;
		right: 3px;
		bottom: 3px;
		/* Both the literal `#fff` and the sub-ladder font-size are PHOTO-OVERLAY exceptions: this sits on an arbitrary
		   video frame, and a ladder step would push the badge past the 84×47 frame it labels. */
		background: var(--scrim-strong);
		color: #fff;
		font-size: 0.62rem;
		font-weight: 700;
		padding: 1px var(--space-2xs);
		border-radius: var(--radius-xs);
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.01em;
	}
	/* DARK ink on the danger fill, never white: white on --danger is 2.78:1, under AA at this size, while
	   --danger-bg measures 5.92:1. The pair is the danger family's own fill and surface. */
	.dur.odd {
		background: var(--danger);
		color: var(--danger-bg);
	}

	/* TWO lines, not one: a single ellipsised line is what hides the version marker at the end of a title.
	   `flex-grow` MUST STAY 0 — with grow:1 the clamp box fills the whole line and pushes the mark to the column's
	   right edge, far from the short title it marks — while `flex-shrink: 1` still clamps a long one. */
	.title-line {
		display: flex;
		align-items: flex-start;
	}
	.t {
		flex: 0 1 auto;
		min-width: 0;
		font-weight: 600;
		font-size: var(--ph-text-md);
		line-height: 1.28;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	/* The margin is load-bearing: a space in the markup is collapsed away by the flex layout, so the gap to
	   the clamped title box has to be a margin. `margin-top` drops the mark onto the first title line. */
	.sparkle {
		flex: 0 0 auto;
		color: var(--warn);
		display: inline-grid;
		place-items: center;
		margin-left: 5px;
		margin-top: var(--space-3xs);
	}

	/* The uploader / canonical artist, alone on its line so it is never truncated by prose beside it. */
	.byline {
		font-size: var(--ph-text-xs);
		color: var(--ink-dim);
		margin-top: var(--space-3xs);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
		margin-top: var(--space-xs);
	}
	/* Spacing above the bar stays here, because that is this row's layout rather than the bar's own metric. */
	.bar-slot {
		margin-top: 7px;
	}

	/* THREE ROW STATES the Button's own axes cannot carry, each arriving as a data attribute the component forwards:
	   a class PASSED to the component is scoped to this file, where Svelte strips it as unused. Every one is ANCHORED
	   under `.row` — unanchored they would match every button in the app carrying these attributes. */
	.row :global([data-slot='button'][data-retry]) {
		/* A retry keeps the primary fill — it is still the action to press — and the ring is what says it failed once. */
		box-shadow: inset 0 0 0 2px var(--danger-line);
	}
	.row :global([data-slot='button'][data-row-state='queued']) {
		/* Dimmed but still GREEN: the song is in the rotation, which is the success state. */
		opacity: 0.7;
	}
	/* NOT-PROCESSABLE MUST NOT WEAR "GO" CLOTHES: `disabled` alone leaves a dimmed GREEN button, which reads as
	   "queued" rather than "impossible". Neutralising the border and ink is what separates the two states. */
	.row :global([data-slot='button'][data-row-state='unavailable']) {
		border-color: var(--line);
		color: var(--ink-dim);
		opacity: 0.65;
	}

	/* Below the narrow breakpoint the full-size thumbnail starves the title and truncates away the version
	   marker this row exists to show, so the frame gives 20px back and the title gains a third line. */
	@media (max-width: 380px) {
		.thumb {
			width: 64px;
			height: 36px;
		}
		.t {
			-webkit-line-clamp: 3;
			line-clamp: 3;
		}
		.row {
			gap: 9px;
		}
		/* Tighter gaps claw back about a fifth of a row on the narrowest phone, without shrinking the 44px target. */
		.chips {
			gap: var(--space-2xs);
			margin-top: 5px;
		}
		.byline {
			font-size: var(--ph-text-xs);
		}
		.row {
			padding: var(--space-sm);
		}
	}
</style>
