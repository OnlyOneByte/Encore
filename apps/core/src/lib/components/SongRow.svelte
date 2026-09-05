<script lang="ts">
	// A search row. ONE row shape for all three readiness states, because they are one kind of thing
	// (a song) at three points on one axis — not three kinds of thing. The state decides the badge
	// line and which actions appear; the layout never changes, so a row that finishes cooking morphs
	// in place instead of jumping between lists.
	//
	// WHAT THIS ROW IS FOR. A YouTube search for one song returns the official video, three lyric
	// videos, a live cut, a movie trailer and a 22-minute concert rip. The row's job is to let a singer
	// tell them apart at a glance, which needs four things this row used to withhold:
	//
	//   1. THE THUMBNAIL. `Media.thumbnail` has always been fetched, persisted and sent to the phone,
	//      and the row drew a grey gradient with a play mark instead. The proxy that serves it
	//      (/api/thumb, SSRF-allowlisted + disk-cached) shipped in M6-C1 and had no caller until now.
	//   2. THE DURATION. Also always present, also never displayed. It is the ONLY signal here that
	//      cannot be fooled by a title, which is what makes 21:56 and 2:31 so useful.
	//   3. THE FULL VERSION MARKER. "(Official Music Video)" / "(Lyrics)" / "(Live Aid 1985)" is the
	//      last token of a YouTube title and was the first casualty of a one-line ellipsis — the row
	//      truncated away precisely the information the choice turns on. It is a chip now, so it
	//      cannot be cut off, and the title gets two lines besides.
	//   4. THE VIEW COUNT. The tiebreaker between two lyric uploads of one song (2.1B vs 266K).
	import type { Readiness } from '$lib/readiness';
	import { cookStageLabel } from '$lib/cook-phrasing';
	import Icon from '$lib/ui/Icon.svelte';
	import {
		classifyVideoKind,
		durationHint,
		formatDuration,
		formatViewCount,
		isUnusualSongDuration,
		VIDEO_KIND_LABEL
	} from '$lib/video-kind';

	interface Props {
		/**
		 * The RAW source title, shown verbatim.
		 *
		 * Deliberately NOT `Media.titleCanonical`, and this is the one place that decision matters most.
		 * The normalizer exists to feed LOOKUPS (MusicBrainz, LRCLIB), where a wrong guess costs a missed
		 * match; here a wrong guess is shown to a human as fact. Measured against the live results for
		 * "bohemian rhapsody", it returns `confidence: 'medium'` — so not filterable — for:
		 *
		 *   "Bohemian Rhapsody | Official Trailer [HD] | 20th Century FOX" → title "Official Trailer"
		 *   "Bohemian Rhapsody | Muppet Music Video | The Muppets"        → title "Muppet Music Video"
		 *   "Bohemian Rhapsody scene - Freddie Mercury meets the band"    → artist "Bohemian Rhapsody scene"
		 *
		 * Its `Artist - Title` split assumes the left side is an artist, and for these uploads it is the
		 * SONG. Five of eleven real rows came out mis-titled, and the first one loses the searched-for
		 * words altogether — a row that no longer contains the query the singer typed. Truncating a long
		 * title is a much smaller harm than renaming a song, so the raw string wins.
		 */
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
		/**
		 * The song's ORIGINAL key as a spelled ASCII label ('G major'), or absent. A FLAT prop, not the
		 * whole SongProfile: the row only ever shows the original key text, so passing the profile would
		 * hand it data it must not render and re-derive the label the parent already has. Gated at the
		 * chip (readiness ready AND present), matching the omit-when-null convention of every sibling
		 * chip — a missing key is honest, and a detected key is only meaningful once the song is cooked.
		 * MUST stay ASCII (helper returns 'G#'/'Ab'); a typographic sharp/flat trips icons.test.ts.
		 */
		keyName?: string;
		pct?: number; // cooking progress, 0..100
		etaSec?: number;
		/** Already in the rotation — the add action becomes a confirmation instead of a repeat. */
		inQueue?: boolean;
		onadd?: () => void;
		/** Request stem separation. Absent when it makes no sense (already ready / already cooking). */
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
		pct = 0,
		etaSec,
		inQueue = false,
		onadd,
		onmake
	}: Props = $props();

	/*
	 * The byline answers a DIFFERENT question in each half of the list, and readiness is exactly the
	 * axis that separates them:
	 *
	 *  • A raw or cooking row is a CANDIDATE UPLOAD, and what distinguishes two uploads of one song is
	 *    the channel — "Queen Official" vs "Vibe Tracks" vs "Richie Lyrics". So the channel wins there.
	 *    It is also raw source data, so unlike the canonical it cannot be wrong.
	 *  • A ready row is a song in YOUR LIBRARY, where the channel is meaningless ("7clouds") and the
	 *    artist is the useful fact. That is the case `artistCanonical` was introduced for.
	 *
	 * This preserves the behaviour each group already had before the row was rebuilt; it just states the
	 * rule once here instead of leaving five call sites to remember it (and one of them to forget).
	 */
	const byline = $derived(
		readiness === 'ready' ? (artistCanonical ?? artist ?? '') : (artist ?? artistCanonical ?? '')
	);

	/*
	 * The thumbnail always goes through our own proxy, never straight to i.ytimg.com. Two reasons: the
	 * phone may be on a LAN with no route to the internet (this is self-hosted karaoke), and a direct
	 * <img> would leak every guest's IP and User-Agent to Google on every keystroke of a search.
	 */
	const thumbSrc = $derived(thumbnail ? `/api/thumb?u=${encodeURIComponent(thumbnail)}` : null);

	const duration = $derived(formatDuration(durationSec));
	// A threshold, not a parse — see isUnusualSongDuration. Draws the badge as a warning so a 21:56
	// concert rip and a 0:30 clip invite a second look without being hidden. The colour alone was read
	// by a first-time guest as "a red badge you don't understand", so the words go in a chip too.
	const oddDuration = $derived(isUnusualSongDuration(durationSec));
	const durationNote = $derived(durationHint(durationSec));

	// Kind is guessed from the RAW title, so it is only offered when there is something to say:
	// `unknown` yields no label and therefore no chip, rather than an empty pill or a false "Official".
	const kind = $derived(classifyVideoKind(title));
	const kindLabel = $derived(VIDEO_KIND_LABEL[kind]);

	const views = $derived(formatViewCount(viewCount));

	/*
	 * The key chip is shown ONLY on a READY row with a detected key. Cooking/raw rows have no analysed
	 * key yet (it comes out of the stems job), so a key here would be a phantom; and the omit-when-null
	 * convention means a falsy guard makes both the chip and — if it is the last one — the whole .chips
	 * wrapper disappear. `keyName` is already the confidence-gated ASCII label from the parent.
	 */
	const showKey = $derived(readiness === 'ready' && !!keyName);

	/*
	 * The state chip replaces the old prose sub-line. That line read
	 * "<artist> · sings with the original vocals" on every raw row — repeating the same eight words
	 * down the whole list, and consuming the width the channel name needed. It is safe to drop because
	 * the group header above these rows says "Needs karaoke · has vocals", and the header is guaranteed
	 * to be on screen whenever raw rows are: both are gated on `filter === 'all'` (+page.svelte
	 * `showRaw` / `showGroupHeads`), so there is no filter state that shows one without the other.
	 *
	 * PARTY ENGLISH, not engineer English. A first-time guest called the earlier wording — "Separating
	 * vocals…" and "instrumental ready" — "written for the developer, not the guest at a party":
	 * separating vocals is what the WORKER does, and "instrumental" is a musician's word. What a guest
	 * is waiting for is a karaoke track. The percentage and the ETA stay exactly as they were; the same
	 * review called those the honest part.
	 */
	const stateChip = $derived.by(() => {
		if (readiness === 'ready') return cookStageLabel('ready');
		// SongRow only ever has a 3-value `readiness`, never the worker sub-status. cookStageLabel is
		// coarse for exactly this reason — every in-flight status collapses to one "Making karaoke…"
		// line — so this passes 'queued' as the least-committal in-flight value rather than naming a
		// specific step (e.g. 'separating') the row has no way to know. Naming a step here would print
		// a guess as fact: an aligning song would read as if it were still separating.
		if (readiness === 'cooking') return cookStageLabel('queued', { pct, etaSec });
		return null;
	});

	// Spelled out for a screen reader even though the button is a bare mark. The cook label names its
	// COST ("about a minute") because that is the difference between the two actions, and it is the one
	// thing an icon cannot say.
	const actionLabel = $derived(
		onmake
			? 'Sing this — strips the vocals first, takes about a minute'
			: inQueue
				? 'Already in the queue'
				: 'Add a turn'
	);
</script>

<!--
	The row is a container, NOT a button. It used to be a role="button" div wrapping two real buttons,
	which announced one control to a screen reader while offering three, and let a keyboard user add the
	same song twice (Enter on the row, then Tab-Enter on the button). The two buttons carry the actions.
-->
<div class="row card list-row" class:ready={readiness === 'ready'} class:cooking={readiness === 'cooking'}>
	<div class="thumb">
		{#if thumbSrc}
			<!--
				alt="" on purpose: the title sits immediately beside it, so a described thumbnail would make
				a screen reader announce the same song twice. `loading="lazy"` because a search renders up
				to 12 of these and only the first few are ever on screen.
			-->
			<img src={thumbSrc} alt="" loading="lazy" decoding="async" width="84" height="47" />
		{:else}
			<!-- No thumbnail (a local library file, or a resolver that reports none) — keep the mark. -->
			<span class="ph"><Icon name="play" /></span>
		{/if}
		{#if duration}
			<span class="dur" class:odd={oddDuration}>{duration}</span>
		{/if}
	</div>

	<div class="meta">
		<div class="t">{title}{#if readiness === 'cooking'}<span class="sparkle"><Icon name="sparkle" /></span>{/if}</div>
		{#if byline}<div class="byline">{byline}</div>{/if}
		{#if kindLabel || stateChip || views || durationNote || showKey}
			<div class="chips">
				{#if stateChip}
					<span class="chip state" class:ok={readiness === 'ready'} class:warn={readiness === 'cooking'} aria-live="polite">{stateChip}</span>
				{/if}
				{#if kindLabel}<span class="chip kind {kind}">{kindLabel}</span>{/if}
				<!-- The detected key. A bare chip (no colour family) — it is a neutral musical fact, not a
				     status or a warning, so it must not borrow the semantic tints. ASCII label only. -->
				{#if showKey}<span class="chip">{keyName}</span>{/if}
				<!-- The red badge, said out loud. Ordered after the kind so "Live · Longer than a song"
				     reads as one thought about the same recording. -->
				{#if durationNote}<span class="chip odd-dur">{durationNote}</span>{/if}
				{#if views}<span class="chip">{views} views</span>{/if}
			</div>
		{/if}
		{#if readiness === 'cooking'}
			<!-- GPU-composited fill: scaleX from the left edge, never animates layout width -->
			<div class="bar"><i style="transform:scaleX({pct / 100})"></i></div>
		{/if}
	</div>

	{#if onmake}
		<!--
			ONE action, not two. A raw row used to offer `Karaoke` and `Turn` side by side at equal
			weight, and either one alone was a dead end: queueing without cooking held a rotation slot
			that could never become ready (silently skipped every pass, forever), and cooking without
			queueing filled the library but gave the singer no turn. The primary action is the whole
			intent — take a turn AND start the cook — and the held-slot rule keeps the singer's fair
			position while it separates. See $lib/cook-and-queue.ts.

			ICON-ONLY, and the mark is load-bearing. Dropping the words gave ~30px back to the title, but
			it is only safe because the two actions still differ on THREE axes: `sparkle` on an accent
			fill here versus `plus` outlined in green below, plus the group header. Making both a bare
			`plus` would re-create the inverted hierarchy this comment exists to record — an expensive,
			minute-long action wearing the same clothes as a free instant one. The words survive as the
			`aria-label`, so nothing is lost to a screen reader.
		-->
		<button
			class="sing"
			aria-label={actionLabel}
			title="Take a turn now and strip the vocals — you keep your place in line while it cooks"
			onclick={() => onmake?.()}><Icon name="sparkle" /></button>
	{:else}
		<button
			class="add"
			class:queued={inQueue}
			aria-label={actionLabel}
			title={inQueue ? 'Already in the queue' : 'Add a turn'}
			disabled={inQueue}
			onclick={() => onadd?.()}>{#if inQueue}<Icon name="check" />{:else}<Icon name="plus" />{/if}</button>
	{/if}
</div>

<style>
	/* Geometry comes from .list-row in app.css, shared with the two queue rows -- this row had drifted
	   to gap 11 / padding 10 against their 12 / 11px 12px. */
	.row { transition: background 0.12s ease; }
	/* readiness is legible at a glance from the border alone, before any text is read */
	.row.ready { border-color: var(--ok); }
	.row.cooking { background: linear-gradient(var(--card), var(--card-tint)); border-color: var(--line-tint); }

	/*
	 * 84×47 is 16:9, matching the derived `mqdefault` source (320×180) so nothing is letterboxed or
	 * cropped. The old 56×40 slot was 7:5 — close enough to look deliberate and wrong enough to squash
	 * every frame slightly.
	 */
	.thumb {
		position: relative;
		width: 84px; height: 47px; border-radius: 8px; flex: 0 0 auto; overflow: hidden;
		background: linear-gradient(135deg, var(--track-bg), var(--card));
		display: grid; place-items: center;
	}
	.thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
	/*
	 * The play badge was `content: '▶'` on a pseudo-element — a codepoint in CSS, which is the one place
	 * a naive attribute-level scan for stray glyphs would never have found it. It is a real mark now.
	 */
	.ph { color: rgba(255, 255, 255, 0.55); font-size: 0.9rem; display: grid; place-items: center; }
	/* Translucent white kept as a literal on purpose: it is a wash over the thumbnail slot (a photo
	   when one loads), the same photo-overlay exception as the duration badge's ink — not a theme colour. */

	/*
	 * Duration burned into the frame's corner — YouTube's own convention, so it needs no label and
	 * costs the row no vertical space. `--danger-bg`-adjacent warn treatment (not the bare token) keeps
	 * it legible on top of an arbitrary photograph.
	 */
	.dur {
		position: absolute; right: 3px; bottom: 3px;
		/* The near-black wash is the shared --scrim-strong (0.85 ≈ the old 0.84, reads identically).
		   The ink stays a literal #fff on purpose: this sits on an arbitrary video frame, not a theme
		   surface, so white is a deliberate photo-overlay exception rather than a themeable colour. */
		background: var(--scrim-strong); color: #fff;
		font-size: 0.62rem; font-weight: 700; padding: 1px 4px; border-radius: 4px;
		font-variant-numeric: tabular-nums; letter-spacing: 0.01em;
	}
	/* Dark ink on the danger fill, not white. White on #ff6b6b is 2.78:1 — below AA for this
	   0.62rem/700 badge (normal-size, needs 4.5:1). --danger-bg (#2a1b22) is the danger family's
	   dark surface and measures 5.92:1 here, AA with margin. It reuses a token rather than
	   inventing a hex, and pairs the badge with the same ink the sibling .chip.odd-dur uses. */
	.dur.odd { background: var(--danger); color: var(--danger-bg); }

	.meta { min-width: 0; flex: 1; }
	/*
	 * TWO lines, not one. A single ellipsised line is what hid "(Official Music Video)" — and even two
	 * lines only fits the marker because the action button shrank to an icon. Measured at 390px: the
	 * text column is ~226px, about 35 characters a line.
	 */
	.t {
		font-weight: 600; font-size: 0.9rem; line-height: 1.28;
		display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
	}
	/*
	 * The cooking marker, inline with the title. The margin is load-bearing: the emoji this replaced was
	 * written as `<span class="sparkle"> ✨</span>` with the separating space INSIDE the span, so swapping
	 * in a mark left the glyph welded to the last letter — "Sweet Caroline✨". A space in the markup would
	 * be collapsed away by the flex layout, so the gap has to be a margin.
	 */
	.sparkle { color: var(--warn); display: inline-grid; place-items: center; vertical-align: -2px; margin-left: 5px; }

	/* The uploader / canonical artist, alone on its line so it is never truncated by prose beside it. */
	.byline {
		font-size: 0.74rem; color: var(--ink-dim); margin-top: 2px;
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}

	.chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
	.chip {
		font-size: 0.65rem; font-weight: 600; padding: 2px 7px; border-radius: 999px;
		border: 1px solid var(--line); background: var(--card2); color: var(--ink-dim);
		white-space: nowrap;
	}
	/*
	 * The one chip allowed to wrap. Its text is the longest here and it GROWS as a cook runs
	 * ("Separating vocals… 68% · ~1 min"), so nowrap clipped it to "~1 mi" — losing the ETA, which is
	 * the only part a singer standing there waiting actually wants.
	 */
	.chip.state { white-space: normal; }
	.chip.state.ok { background: var(--ok-bg); border-color: var(--ok-line); color: var(--ok); }
	.chip.state.warn { background: var(--warn-bg); border-color: var(--warn-line); color: var(--warn); }
	/*
	 * One colour per kind, and they are semantic rather than decorative: green = the studio recording
	 * you probably want, purple = a lyric video, amber = a different recording (live), red = probably
	 * not a song at all. The label carries the meaning on its own, so colour is reinforcement — never
	 * the only cue.
	 */
	.chip.kind.official { background: var(--ok-bg); border-color: var(--ok-line); color: var(--ok); }
	.chip.kind.lyric { background: var(--card-tint2); border-color: var(--line-tint); color: var(--accent-ink); }
	.chip.kind.live { background: var(--warn-bg); border-color: var(--warn-line); color: var(--warn); }
	.chip.kind.suspect { background: var(--danger-bg); border-color: var(--danger-line); color: var(--danger-ink); }
	/* Same treatment as the badge it explains, so the two read as one signal rather than two. */
	.chip.odd-dur { background: var(--danger-bg); border-color: var(--danger-line); color: var(--danger-ink); }

	.bar { height: 4px; border-radius: 4px; background: var(--card-tint2); overflow: hidden; margin-top: 7px; }
	.bar > i { display: block; height: 100%; width: 100%; background: var(--grad); border-radius: 4px; transform-origin: left center; transition: transform 0.4s ease; }

	/*
	 * The actions. 44×44 is the project's minimum touch target and is why the button is square rather
	 * than as small as its mark: shrinking the hit area to the glyph is how a control ends up
	 * technically present and practically unhittable.
	 *
	 * The class NAMES (`.sing` / `.add`) are deliberately unchanged even though the buttons no longer
	 * carry those words: they are the anchors `e2e/contract.ts` addresses these controls by, and its
	 * selector-rot guard fires if they move. Renaming them to match the new marks would be churn in a
	 * browser test that cannot run in this environment — so the geometry changed and the hooks did not.
	 */
	.sing,
	.add {
		width: 44px; height: 44px; flex: 0 0 auto;
		border: 0; border-radius: 12px; cursor: pointer;
		display: grid; place-items: center; font-size: 20px; /* Icon defaults to 1em */
	}
	.sing:active,
	.add:active { transform: scale(0.94); }
	/*
	 * The raw row's single primary action takes the accent fill because it IS the primary intent on this
	 * row — and because the weight used to sit on the wrong button: `.add` was the dead end (a turn that
	 * could never become ready) while the cook was styled as a secondary outline. The hierarchy was not
	 * missing, it was inverted.
	 *
	 * Now that both are icon-only, that distinction rests on the MARK as much as the fill: `sparkle` on
	 * accent means "this cooks for a minute", `plus` outlined in green means "queue it now". Giving both
	 * the same glyph would re-create the inversion in a new form.
	 */
	.sing { background: var(--accent-strong); color: var(--on-accent); }
	.add { background: var(--card2); border: 1px solid var(--ok); color: var(--ok); }
	.add.queued { opacity: 0.7; }
	.add:disabled { cursor: default; }

	/*
	 * Below ~380px the 84px thumbnail starves the title: at 320px "Bohemian Rhapsody (Remastered)"
	 * truncated back to "Bohemian Rhapsody…", losing the exact token this row exists to show. Give the
	 * frame back 20px and the title a third line rather than shipping a design that quietly fails on a
	 * small phone.
	 */
	@media (max-width: 380px) {
		.thumb { width: 64px; height: 36px; }
		.t { -webkit-line-clamp: 3; line-clamp: 3; }
		.row { gap: 9px; }
		/*
		 * Claw back height. A guest reviewing the 320px frame could see only about four songs before
		 * the player bar and called it irritating to scroll — and comparing uploads is the entire point,
		 * so how many fit at once IS the feature. Smaller chips and tighter gaps buy roughly a fifth of
		 * a row back without shrinking the title or the 44px target.
		 */
		.chip { font-size: 0.62rem; padding: 1px 6px; }
		.chips { gap: 4px; margin-top: 5px; }
		.byline { font-size: 0.72rem; }
		.row { padding: 8px; }
	}
</style>
