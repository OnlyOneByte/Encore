<script lang="ts">
	// ONE row shape for all readiness states: the state decides the badge line and which actions appear, and the
	// layout never changes, so a row that finishes processing morphs in place instead of jumping between lists.
	// Every guest-facing string below is PARTY ENGLISH: a guest waits for a karaoke track, not an "instrumental".
	import { untrack } from 'svelte';
	import type { Readiness } from '$lib/readiness';
	import { processStageLabel, STALLED_TURN_LABEL } from '$lib/phrasing/process-phrasing';
	import { songRef } from '$lib/phrasing/row-action-names';
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
		 * ('G#'/'Ab'): a typographic sharp or flat is a codepoint whose glyph the platform picks, and a TV browser may
		 * have none for it. */
		keyName?: string;
		/** Descriptive library tags, shown on a READY row only — a raw search result has none worth showing. */
		tags?: string[];
		pct?: number; // processing progress, 0..100
		/** Present, the bar shows `overallProcessPct(status, pct)` rather than the raw per-step pct, which fills to
		 * 100% at the end of EVERY step and jumps backward when the next resets it. Absent, the raw pct is used. */
		status?: MediaStatus;
		/** The server's verdict that no connected worker can make this (`media:status.unservable`). */
		unservable?: boolean;
		/** Already in the rotation — the add action becomes a confirmation instead of a repeat. */
		inQueue?: boolean;
		/** False is the metadata-only case, and BOTH actions must go with it: the branches below are an either/or, so
		 * dropping only `onmake` falls through to a live add — and a turn on a song that can never be processed is held
		 * in the rotation and silently skipped every pass. The row still says why, in the chip line. */
		processable?: boolean;
		/** Nothing connected can make it now: no action, since a Sing that cannot work is a dead tap (docs/FRONTEND.md). */
		cantMake?: boolean;
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
		unservable = false,
		inQueue = false,
		processable = true,
		cantMake = false,
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

	/*
	 * WHAT EARNS A PILL, and this is the row's one typographic rule: a pill is for a CLASSIFICATION the eye should
	 * catch — the process state, the video kind, a library tag. A row was spending up to FIVE of them in four colours,
	 * and three of those were carrying MEASUREMENTS: a view count, a key, a duration verdict. Numbers in pills is what
	 * made the row read as a debug dump rather than a list, and the wrapping second pill row cost a whole line.
	 *
	 * So the measurements join the byline as dim text on a `·`, which is the same grammar NowPlayingStrip's own byline
	 * (`.who` · `.song`), /queue's `.now-by` and the queue subtitle already use. Built HERE and not inline: an `{#if}`
	 * between two lines of markup puts a NEWLINE in
	 * the element's text, which reaches a screen reader and any assertion — the defect already fixed once on
	 * /library's count line. MUST STAY BELOW `showKey`, which it reads: `$derived` is lazy at runtime, but the checker
	 * sees a direct reference and reports a block-scoped use before declaration.
	 */
	const metaFacts = $derived(
		[byline, views ? `${views} views` : '', showKey ? keyName : ''].filter(Boolean).join(' · ')
	);
	/* `durationNote` IS NOT IN THAT JOIN, and the measurement is why. It was demoted to byline text with the other two
	   and it does not fit: the byline is 144px on a 390px phone and "Longer than a song" alone measures 116 of them.
	   Sharing one ellipsising box truncated the WARNING away ("StopMotion Movies · 36…"); making it unshrinkable instead
	   crushed the ARTIST to 28px of a 183px string. Both readings are worse than the pill. So it keeps a pill — the only
	   measurement that does — and the fix for the original complaint is the TONE: `warn`, not `bad`. Amber is the right
	   register for "this is probably not a song", it stops a mild metadata note wearing the failure colour, and it
	   matches the `Live` chip that sits beside it on most of these same rows. */

	const barPct = $derived(status ? overallProcessPct(status, pct) : pct);
	/* "PROCESSING" THAT NOBODY IS RUNNING: the server has said no connected worker can make it, so the row says what the
	   TV, the strip and the queue card say, with no bar, no sparkle and no percentage — any figure would be invented. */
	const stalled = $derived(readiness === 'processing' && unservable);

	/* WHAT IS ANNOUNCED, and deliberately NOT `stateChip`, which carries the percentage. The chip's text changes on every
	   whole-percent step, so as a live region it announced hundreds of times per song and drowned out the queue
	   announcer. This is the STAGE only; the progress bar still exposes its value for AT to read on demand. Empty for a
	   row with no process state, which renders no region at all. Only a CHANGE out of `bornStage` reaches the region —
	   see the markup at the foot of this file. */
	const announcedStage = $derived(
		stalled
			? STALLED_TURN_LABEL
			: readiness === 'processing' || readiness === 'failed' || readiness === 'ready'
				? processStageLabel(readiness === 'processing' ? 'queued' : readiness === 'failed' ? 'failed' : 'ready')
				: ''
	);
	/* THE STAGE THIS ROW WAS BORN IN, captured once at init and never again. `untrack` rather than a bare read, which
	   is this tree's idiom for exactly this position (TvPlayer.svelte, settings/you's drafts): a bare read of a rune
	   outside an effect raises `state_referenced_locally`, which `bun run check` surfaces. MUST STAY BELOW
	   `announcedStage` for the same reason `metaFacts` does — $derived is lazy at runtime, but the checker reports a
	   block-scoped use before declaration. */
	const bornStage = untrack(() => announcedStage);

	const stateChip = $derived.by(() => {
		if (readiness === 'ready') return processStageLabel('ready');
		// A dead process must say so, or it keeps rendering the in-flight line forever on a stopped job.
		if (readiness === 'failed') return processStageLabel('failed');
		if (stalled) return STALLED_TURN_LABEL;
		// 'queued' is the LEAST-COMMITTAL in-flight value: the row has no worker sub-status and naming a step would
		// print a guess as fact. Only the READOUT is rounded — the bar keeps the unrounded value so its transition
		// stays smooth, and an unrounded readout prints "31.200000000000003%".
		if (readiness === 'processing') return processStageLabel('queued', { pct: Math.round(barPct) });
		// Metadata-only, LAST so it can never mask a real process state. The row MUST say why its actions are gone:
		// on a phone a `title` on a disabled button is unreachable, and a dead control reads as a broken app.
		if (!processable) return 'Name match only — search to sing it';
		return null;
	});

	// The buttons are bare marks, so these labels are the whole name. They stay short, because a results list reads one
	// per row: the process COST and the name-match instruction live in each button's `title`, which a screen reader
	// reads as the description, so saying them in the name too would say them twice.
	// `onmake` WITH `inQueue` is the retry state — the singer already holds a turn and its process died — so it needs
	// its own words: "Sing" would promise a turn the action does not take. Every label names the song as the row
	// shows it, because a results list is the same button once per row — see $lib/phrasing/row-action-names.
	const retryProcess = $derived(!!onmake && inQueue);
	const song = $derived(songRef(title, byline));
	const actionLabel = $derived(
		retryProcess
			? `Make ${song} again — you keep your turn`
			: onmake
				? `Sing ${song}`
				: // Announced BEFORE the inQueue branch because it is the stronger fact: this song can never be
					// sung here, so "Already in the queue" would be both wrong and beside the point.
					!processable
					? `Can't sing ${song} — it's a name match only`
					: inQueue
						? `${song} is already in the queue`
						: `Add a turn for ${song}`
	);
</script>

<!-- THE ROW IS A CONTAINER, NEVER A BUTTON: as a role="button" wrapper it announces one control while offering
	three, and lets a keyboard user add the same song twice. Item.Root supplies the row grammar through its `child`
	snippet, and this file keeps the row ELEMENT so its state classes stay attributable here. -->
<Item.Root variant="bare" size="bare">
	{#snippet child({ props })}
		<div
			{...props}
			class={['row', 'card', 'list-row', { ready: readiness === 'ready', processing: readiness === 'processing' }]}
		>
			<Item.Media
				><div class="thumb">
					{#if thumbSrc}
						<!-- alt="" on purpose: the title sits immediately beside it, so a described thumbnail says the song twice. -->
						<img src={thumbSrc} alt="" loading="lazy" decoding="async" width="84" height="47" />
					{:else}
						<!-- No thumbnail (a local library file, or a resolver that reports none) — keep the mark. -->
						<span class="ph"><Icon name="play" /></span>
					{/if}
					{#if duration}
						<span class={['dur', { odd: oddDuration }]}>{duration}</span>
					{/if}
				</div></Item.Media
			>

			<Item.Content>
				<!-- THE MARK MUST STAY A SIBLING of `.t`, never a child: `.t` is a two-line clamp with overflow hidden, so a
					mark inside it is laid out on the discarded third line and never paints on a phone. -->
				<div class="title-line">
					<span class="t">{title}</span>
					{#if readiness === 'processing' && !stalled}<span class="sparkle"><Icon name="sparkle" /></span>{/if}
				</div>
				<!-- THE BYLINE NOW CARRIES THE MEASUREMENTS — see `metaFacts`. One expression and no inline `{#if}`, so it
					cannot contribute a stray newline to the element's text. -->
				{#if metaFacts}<div class="byline">{metaFacts}</div>{/if}
				{#if kindLabel || stateChip || durationNote || showTags}
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
								wrap>{stateChip}</Badge
							>
						{/if}
						<!-- `official` IS THE NEUTRAL CASE, not an --ok chip. It used to be green, which put a second --ok pill
							immediately beside "Karaoke ready" in this same chips row, meaning something completely different — and with
							the card's --ok border gone the ready pill is now the row's ONE statement of readiness, so a green
							neighbour defeats it. Only the EXCEPTIONAL kinds are toned: red for "Not music", amber for "Live", accent
							for "Lyric video". "Official video" is the common, expected kind and should not shout. -->
						{#if kindLabel}<Badge
								variant={kind === 'lyric'
									? 'accent'
									: kind === 'live'
										? 'warn'
										: kind === 'suspect'
											? 'bad'
											: 'neutral'}>{kindLabel}</Badge
							>{/if}
						<!-- `warn`, NOT `bad`, and ordered after the kind so "Live · Longer than a song" reads as one thought about
							one recording. The tone change is the whole fix here: red is the failure colour and this is a mild metadata
							note. It is the one measurement that keeps a pill, because it is the one that does not fit the byline —
							`durationNote`'s note has the numbers. -->
						{#if durationNote}<Badge variant="warn" wrap>{durationNote}</Badge>{/if}
						<!-- TAGS ARE THE OTHER SURVIVING PILL, and they earn it: a tag is a describing WORD, which is what a pill is
							for. The key and the view count used to sit here and have moved to the byline — see `metaFacts`. -->
						{#if showTags}{#each tags! as tag (tag)}<Badge variant="tag">{tag}</Badge>{/each}{/if}
					</div>
				{/if}
				{#if readiness === 'processing' && !stalled}
					<!-- GPU-composited fill: scaleX from the left edge, never animates layout width -->
					<div class="bar-slot"><Progress value={barPct} size="sm" aria-label="Process progress" /></div>
				{/if}
			</Item.Content>

			{#if cantMake}
				<!-- The button's box, empty: the row keeps its height when a maker drops, so nothing moves under a thumb. -->
				<span class="action-slot" aria-hidden="true"></span>
			{:else if onmake}
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
						: 'Take a turn — strips the vocals first, about a minute. You keep your place in line.'}
					onclick={() => onmake?.()}
				>
					<Icon name="sparkle" />
				</Button>
			{:else}
				<!-- ARIA-DISABLED, NEVER `disabled`, and the keyboard is the reason: the optimistic add flips `inQueue` in the
					SAME frame as the press, and every browser blurs a focused element the instant it becomes disabled. So Enter on
					`+` dropped focus to `<body>` and every add after the first needed a pointer to get back — three adds off one
					search cost three focus resets. It also gives `actionLabel` somewhere to land: that string is the only place the
					row says "Already in the queue", or why a name-match row can never be sung, and a `disabled` button is out of
					the tab order, so on a phone the sentence was unreachable. Nothing is lost visually — `data-row-state` below
					paints both dead states — and Playwright counts `aria-disabled` as disabled, so the probes that poll
					`isDisabled()` for "the add landed" still read it. -->
				<Button
					variant="iconPrimary"
					size="icon"
					data-testid="song-add"
					data-row-state={inQueue ? 'queued' : !processable ? 'unavailable' : undefined}
					aria-label={actionLabel}
					title={processable ? actionLabel : `${actionLabel}. Search for the song to make karaoke.`}
					aria-disabled={inQueue || !processable || undefined}
					onclick={() => {
						// The GUARD is what `disabled` used to do: an aria-disabled button still dispatches clicks, so without this
						// the queued row would add a second turn for one song and the unavailable row would queue an unsingable one.
						if (inQueue || !processable) return;
						onadd?.();
					}}
				>
					{#if inQueue}<Icon name="check" />{:else}<Icon name="plus" />{/if}
				</Button>
			{/if}
		</div>
	{/snippet}
</Item.Root>

<!-- THE STAGE TRANSITION IS THE ANNOUNCEMENT, NEVER THE PERCENTAGE — see `announcedStage`. A row announces the stage it
	CHANGED INTO, never the stage it was BORN in, which extends the same "no region rather than an empty one" rule from a
	row with no process state to a row whose stage was settled before it existed. /library is the case that forced it:
	every row there is handed `readiness="ready"` and can never transition, so it mounted one polite region per rendered
	row, all reading "Karaoke ready". MEASURED on a 135-song library at 390x844, 60 rows on arrival: a MutationObserver
	armed before the tab tap counted 63 `role=status` INSERTIONS against 3 removals, so every one of them is a dynamic
	insertion, which is the condition under which AT may speak. The same drive with this gate in place counts 3 and 3.
	`.vh` is clip-based, not display:none, so each region also sat in the accessibility tree beside the visible pill:
	with all 135 rows revealed, Chrome's full AX tree now names "Karaoke ready" 270 times — two nodes per row, the
	pill's container and its text — where the duplicate region doubled that, and `innerText` now holds the string 135
	times where it held it twice per row.
	THE DOCUMENTED ANNOUNCEMENT SURVIVES, which is the whole point: on `/` an optimistically-processed row keeps its
	component instance (`processingRows` is fed only by the search response, so the optimistic `setMediaStatus` leaves
	the row in the same keyed group), so `bornStage` is '' there. DRIVEN on `/`: a "Needs karaoke" row carries no region
	at all, and one tap on its sing action inserts a `role=status` reading "Making karaoke…" — `processStageLabel`'s own
	words for an in-flight process, with no worker needed to prove the transition speaks.
	ONE BEHAVIOUR GIVEN UP deliberately: a row that mounts ALREADY failed announces nothing. Its visible chip still
	says so, and a failure the guest did not watch happen is not news a live region should interrupt them with. -->
{#if announcedStage && announcedStage !== bornStage}
	<div class="vh" role="status">{announcedStage}</div>
{/if}

<style>
	/* Geometry comes from `.list-row` in app.css, shared with the two queue rows. Every rule that declares a COLOUR has
	   to stay in this file, so a contrast question about this row is answerable from it. */
	/* The surface fade is opt-in; reduced, the row's background changes at once. */
	@media (prefers-reduced-motion: no-preference) {
		.row {
			transition: background var(--motion-fast) ease;
		}
	}
	/* THE READY ROW HAS NO BORDER OF ITS OWN, and the deletion is the finding. Ready was stated three times per card —
	   an --ok border here, the "Karaoke ready" pill, and the add button's --ok ring — and /library renders every row
	   with readiness="ready", so all three were on in all of them and none discriminated anything. The button's ring is
	   gone (one fill for the action, see button.svelte's iconPrimary) and the WORDED pill is what stays: it is bounded,
	   it is readable by a guest who cannot separate --ok #33d6a6 from --warn #ffb84d, and it keeps --ok to one small
	   region instead of tracing the whole card, which was the largest --ok area on the screen. The `ready` class STAYS
	   on the row element as a state hook even with no rule reading it — do not tidy it out of the class array.
	   `.row.processing` keeps its border because processing is TRANSIENT, and its tint is the only pre-attentive mark of
	   a row that is changing under the guest. */
	.row.processing {
		background: linear-gradient(var(--card), var(--card-tint));
		border-color: var(--line-tint);
	}
	/* The `size="icon"` button's box (`size-tap`), with nothing in it. */
	.action-slot {
		width: var(--tap);
		height: var(--tap);
		flex: 0 0 auto;
	}

	/* 84×47 is 16:9, matching the source frame, so nothing is letterboxed or cropped. It arrives as a TOKEN pair
	   because the search skeleton has to stand in for this exact box and a second copy of the numbers is how the two
	   drifted 40px apart — see --row-thumb-w in app.css, which also carries the narrow step-down below. */
	.thumb {
		position: relative;
		width: var(--row-thumb-w);
		height: var(--row-thumb-h);
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

	/* The uploader / canonical artist, now followed by the view count and the key on a `·` — see `metaFacts`. ONE
	   ellipsising box, which only works because the demoted facts are SHORT: the artist comes first, so what a narrow
	   phone drops is the tail of a view count rather than the identity, and both numbers are restated on
	   /song/[mediaId]. Letting it wrap instead would give the row a variable height. */
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
		/* THE CONFIRMATION IS AN OUTLINE, NEVER A DIMMED FILL, and the ratio is the reason. The action is one accent fill
		   now, so the old `opacity: 0.7` would composite #7254e6 at 70% over the --card row to #5843ad — 2.31:1 against
		   that row, under SC 1.4.11's 3:1 for a control's boundary, where the fill at full strength measures 3.38:1. So
		   the dim is a SURFACE AND INK SWAP in the accent family's own certified pair, which is also the right grammar:
		   filled means press me, outlined means done. The BORDER carries the visibility (3.38:1 on --card, 3.10:1 on its
		   own --card2 fill) and the check mark carries the meaning. NOT --ok: that token states the ready STATE, once per
		   row, in the pill. Unlayered under a scoped class, so it beats the layered `bg-`/`border-` utilities on the
		   variant — the same mechanism the `aria-disabled` rule below relies on. */
		background: var(--card2);
		border-color: var(--accent);
		color: var(--accent-ink);
	}
	/* THE PRESS FEEDBACK HAS TO GO WITH `disabled`, AND IT LIVES ON TWO PROPERTIES. Button answers a press with
	   `transform: scale(0.96)` (its own `[data-press='none']:active:not(:disabled)`) AND with `translate: 0 1px` (the
	   base's `active:not-aria-[haspopup]:translate-y-px`, which Tailwind 4 emits on `translate`, never on `transform`).
	   Both were gated on the NATIVE attribute this control no longer sets, so both dead states would answer a press with
	   the same squeeze-and-drop the live `+` gives — tactile "it worked" for a handler that deliberately returns.
	   Measured on /components at 390x844, pointerdown held: native-disabled moved 0px, the queued add moved 1.88px, and
	   cancelling `transform` alone still left 1.0px, which is the whole reason `translate` is named here too. Anchored
	   under `.row` like the three above; it beats Button's scale rule on specificity and the translate utility by being
	   unlayered against a layered one. */
	.row :global([data-slot='button'][aria-disabled='true']:active) {
		transform: none;
		translate: none;
	}
	/* NOT-PROCESSABLE MUST NOT WEAR "GO" CLOTHES, AND THE FILL IS NOW PART OF THAT. The shared variant is an accent
	   FILL, so neutralising only the border and the ink — which was enough while this branch used the --card2-based
	   iconReady — would leave a full-strength purple circle reading as the live action. The background swap is what
	   keeps this rule doing its job. Separated from `queued` above by the border (--line is 1.23:1 on --card, i.e.
	   effectively no boundary, against --accent's 3.38:1), by the ink, by the glyph (plus, not check), and by the extra
	   dim — `opacity` is legal here because this leaf carries no text, only an Icon path. */
	.row :global([data-slot='button'][data-row-state='unavailable']) {
		background: var(--card2);
		border-color: var(--line);
		color: var(--ink-dim);
		opacity: 0.65;
	}

	/* Below the narrow breakpoint the title gains a third line, because the version marker this row exists to show is
	   what a two-line clamp eats here. The frame's own 20px step-down moved to the --row-thumb-* tokens, so the search
	   skeleton takes it at the same width instead of staying 84px while the row goes to 64px. */
	@media (max-width: 380px) {
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
