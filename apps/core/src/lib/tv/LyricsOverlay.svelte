<script lang="ts">
	// aligned lyrics overlay for the TV. Fetches the word-timed artifact referenced
	// by the current media and highlights each word in time as a classic karaoke sweep with a
	// bouncing ball over the word being sung. The authoritative position arrives from the player
	// (~4Hz via ontimeupdate); we interpolate it with requestAnimationFrame for a smooth 60fps sweep.
	import {
		parseLyricsDoc,
		activeLineIndex,
		activeWordIndex,
		isAutoTranscribed,
		LYRICS_LEAD_SEC,
		type LyricsDoc,
		type LyricsProvenance
	} from './lyrics';
	import {
		DEFAULT_LYRICS_BALL,
		DEFAULT_LYRICS_CASE,
		DEFAULT_LYRICS_FONT,
		DEFAULT_LYRICS_HIGHLIGHT,
		DEFAULT_LYRICS_LINES_AFTER,
		DEFAULT_LYRICS_LINES_BEFORE,
		DEFAULT_LYRICS_SCALE_PCT,
		getLyricsCase,
		getLyricsFont,
		type LyricsBallStyleId,
		type LyricsCaseId,
		type LyricsFontId,
		type LyricsHighlightId
	} from '@encore/shared';

	interface Props {
		lyricsRef?: string; // MediaStore key of the lyrics JSON on the current media
		doc?: LyricsDoc | null; // pre-parsed lyrics (dev gallery / tests); bypasses the fetch when set
		positionSec: number; // authoritative playback position (from TvPlayer telemetry)
		playing?: boolean; // interpolate forward only while actually playing
		visible?: boolean; // hide during attract/interstitial
		/**
		 * Where this text came from — `chosenCandidate(media)` on the TV route. Drives the
		 * auto-transcribed caption. Absent/null means provenance is UNKNOWN (a pre-candidate artifact),
		 * which is rendered exactly like verified text: we will not assert either way.
		 */
		provenance?: LyricsProvenance | null;
		/** Seconds to run the highlight AHEAD of the audio — see LYRICS_LEAD_SEC for why. */
		leadSec?: number;
		/**
		 * How the sung word is marked, and how the current lyric is lit. Both come from the room's
		 * settings via `resolveLyricsPresentation`, which has ALREADY clamped them against what the
		 * deployment's sync mode produces — so this component renders what it is handed and does not
		 * re-derive the rule. Defaults reproduce the treatment that was hardcoded here.
		 */
		ball?: LyricsBallStyleId;
		highlight?: LyricsHighlightId;
		/**
		 * The reel's TYPE. Read straight off the room — unlike `ball`/`highlight` these need no clamp,
		 * because none of them depends on whether word timings exist.
		 *
		 * `scalePct` is a percent of the computed distance-based scale, NOT a size. See
		 * DEFAULT_LYRICS_SCALE_PCT for why storing an absolute size would break on a resolution change.
		 */
		scalePct?: number;
		font?: LyricsFontId;
		textCase?: LyricsCaseId;
		linesBefore?: number;
		linesAfter?: number;
	}
	let {
		lyricsRef,
		doc: docProp,
		positionSec,
		playing = true,
		visible = true,
		provenance = null,
		leadSec = LYRICS_LEAD_SEC,
		ball = DEFAULT_LYRICS_BALL,
		highlight = DEFAULT_LYRICS_HIGHLIGHT,
		scalePct = DEFAULT_LYRICS_SCALE_PCT,
		font = DEFAULT_LYRICS_FONT,
		textCase = DEFAULT_LYRICS_CASE,
		linesBefore = DEFAULT_LYRICS_LINES_BEFORE,
		linesAfter = DEFAULT_LYRICS_LINES_AFTER
	}: Props = $props();

	let fetched = $state<LyricsDoc | null>(null);
	let loadedRef: string | undefined;
	let displayPos = $state(0);
	// pre-parsed doc wins (gallery/tests); otherwise use whatever the fetch produced
	const doc = $derived(docProp ?? fetched);

	// Interpolation anchors (plain locals — not reactive; the rAF loop reads them each frame).
	let basePos = 0;
	let baseWall = 0;
	$effect(() => {
		// Re-anchor whenever the authoritative position ticks in, so the sweep never drifts far.
		basePos = positionSec;
		baseWall = performance.now();
	});

	// Fetch + parse the lyrics artifact when the ref changes (once per song). Skipped if a doc prop
	// was supplied directly (dev gallery / tests).
	$effect(() => {
		const ref = lyricsRef;
		if (docProp) return;
		if (!ref) {
			fetched = null;
			loadedRef = undefined;
			return;
		}
		if (ref === loadedRef) return;
		loadedRef = ref;
		let cancelled = false;
		fetch(`/media/${ref}`)
			.then((r) => (r.ok ? r.json() : null))
			.then((j) => {
				if (!cancelled) fetched = parseLyricsDoc(j);
			})
			.catch(() => {
				if (!cancelled) fetched = null; // dead/absent lyrics → overlay silently no-ops
			});
		return () => {
			cancelled = true;
		};
	});

	// Smoothly advance the shown position between authoritative ticks.
	$effect(() => {
		let raf = 0;
		const tick = () => {
			displayPos = playing ? basePos + (performance.now() - baseWall) / 1000 : basePos;
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	});

	// The position the HIGHLIGHT uses: the real playback position plus the lead. displayPos itself stays
	// honest so anything else reading it is unaffected.
	const cuePos = $derived(displayPos + leadSec);
	const lineIdx = $derived(doc ? activeLineIndex(doc.lines, cuePos) : -1);
	const curLine = $derived(doc && lineIdx >= 0 ? doc.lines[lineIdx] : null);
	const nextLine = $derived(
		doc && lineIdx >= 0 && lineIdx + 1 < doc.lines.length ? doc.lines[lineIdx + 1] : null
	);
	const ballWord = $derived(curLine ? activeWordIndex(curLine, cuePos) : -1);
	const show = $derived(visible && !!curLine);
	// Reel scrolling: measure where the current row sits and place it. Measured (not row*height) so a
	// wrapped line cannot drift the whole column out of alignment.
	let viewportEl = $state<HTMLElement | null>(null);
	let reelEl = $state<HTMLElement | null>(null);
	let reelOffset = $state(0);
	function measureReel() {
		const row = reelEl?.querySelector<HTMLElement>('.row.current');
		if (!row || !viewportEl) return;
		/*
		 * CENTRED is only correct when the row counts match.
		 *
		 * Centring the current row makes "equal rows above and below" a geometric consequence rather
		 * than a choice — with it centred you CANNOT show 1 before and 3 after at any viewport height.
		 * So asymmetry has to move the anchor, not the height.
		 *
		 * The sign matters and is easy to get backwards (it was, first time): wanting MORE lines AFTER
		 * means the current line must sit HIGHER, to leave room below it. So the bias is
		 * before-minus-after, and a positive result pushes the current line down.
		 *
		 * `rowHeight` is read from the DOM rather than computed from the em, because the scale is a
		 * clamp() the browser resolves and a wrapped row is taller than one line — the same reason the
		 * offset itself is measured.
		 */
		const rowHeight = row.offsetHeight;
		const bias = ((linesBefore - linesAfter) / 2) * rowHeight;
		reelOffset = -(row.offsetTop + row.offsetHeight / 2 - viewportEl.clientHeight / 2 - bias);
	}
	$effect(() => {
		void lineIdx; // re-measure on every line change
		// Re-measure when the row counts move too: the bias and the viewport height both change, and a
		// settings write can land mid-song.
		void linesBefore;
		void linesAfter;
		measureReel();
	});
	// Re-measure on any SIZE change too, not just a line change. A row's height is not constant: the
	// current row renders inline-block word spans while the others render plain text, so the column's
	// geometry shifts the moment a line becomes current — which silently drifted the reel out of centre
	// (caught by measuring: ~11px per change, accumulating over a song). Also covers window resize and
	// late font loading.
	$effect(() => {
		if (!reelEl) return;
		const ro = new ResizeObserver(() => measureReel());
		ro.observe(reelEl);
		return () => ro.disconnect();
	});
	const unverified = $derived(isAutoTranscribed(provenance));
	/**
	 * Whether to render the current line as individual word spans at all.
	 *
	 * Only the `word` treatment needs them. Under `line`/`off` the plain-text branch is both cheaper
	 * and the reason no second renderer exists — and it keeps the row a single text node, so the
	 * ResizeObserver has less to re-measure per line change.
	 */
	const wordLevel = $derived(highlight === 'word');
	/*
	 * The type, as custom properties on the root, so the stylesheet keeps owning the geometry and this
	 * component only supplies numbers.
	 *
	 * `--lyrics-rows` is the load-bearing one: the viewport height was a hardcoded 9.5em because it was
	 * 5 rows of 1.9em leading, and that constant is exactly what a row-count setting invalidates.
	 */
	const rowCount = $derived(linesBefore + 1 + linesAfter);
	const fontStack = $derived(getLyricsFont(font)?.stack ?? 'inherit');
	const caseTransform = $derived(getLyricsCase(textCase)?.transform ?? 'none');
	const typeStyle = $derived(
		`--lyrics-scale: ${scalePct / 100}; --lyrics-rows: ${rowCount}; ` +
			`--lyrics-font: ${fontStack}; --lyrics-case: ${caseTransform}; ` +
			// An edge with no context rows must not be faded — there the current line IS the edge row.
			`--lyrics-fade-top-on: ${linesBefore > 0 ? 1 : 0}; --lyrics-fade-bot-on: ${linesAfter > 0 ? 1 : 0}`
	);
</script>

{#if show && doc && curLine}
	<div class="lyrics hl-{highlight}" class:unverified role="presentation" style={typeStyle}>
		<!--
			A SCROLLING REEL, not a two-slot swap. Previously the current line was replaced in place and
			the "next" line jumped up into it, which read as a hard cut on every line change. Here every
			line is a persistent keyed node in one column and only the column's transform changes, so the
			browser animates the scroll for free and the singer keeps the line they just sang in view.
			The offset is MEASURED from the DOM rather than computed as rows x height, because a long
			lyric can still wrap to two rows and fixed-height maths would drift out of alignment.
		-->
		<div class="viewport" bind:this={viewportEl}>
			<div class="reel" bind:this={reelEl} style="transform: translateY({reelOffset}px)">
				{#each doc.lines as l, i (i)}
					<div class="row" class:current={i === lineIdx} class:past={i < lineIdx}>
						{#if i === lineIdx && l.words.length && wordLevel}
							{#each l.words as w, wi (wi)}
								<span class="word" class:done={cuePos >= w.end} class:active={wi === ballWord}>
									{#if wi === ballWord && ball !== 'off'}<span
											class="ball {ball}"
											aria-hidden="true">{ball === 'underline' ? '' : '●'}</span
										>{/if}{w.word}
								</span>{' '}
							{/each}
						{:else}
							<!--
								The plain-text branch. It already existed as the fallback for a line-timed doc, and
								a room choosing `line`/`off` reuses it rather than adding a second renderer — the
								whole reason this feature is small. `.row.current` carries the line-level treatment.
							-->
							{l.text}
						{/if}
					</div>
				{/each}
			</div>
		</div>
	</div>
{/if}

<style>
	.lyrics {
		/* CENTRED, not bottom-anchored. A cooked song plays an instrumental with no picture to avoid
		   covering, so lyrics belong in the middle of the screen where they read from across a room;
		   `bottom: 14%` left them crowding the lower-third and the join card. `inset` + flex centering
		   keeps a wrapped 2-line lyric visually centred instead of growing downward off-balance. */
		position: absolute;
		/* NOT `inset: 0`. The bottom is pulled up by the reserved chrome band the join/QR corner and the
		   now-playing lower-third occupy, so the reel's box ends where the cards begin and the two can
		   never overlap. Because the box stays `justify-content: center`, reserving that band shrinks it
		   and RAISES the centreline into the freed upper space — the "compress the lyrics, move the
		   centreline up" the user asked for, achieved structurally with no new setting. Top/left/right
		   are unchanged. */
		top: 0;
		left: 0;
		right: 0;
		bottom: var(--tv-chrome-h);
		z-index: 6;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.7em;
		/* Safe-area token, not a hardcoded 6%: an edge inset the whole TV surface shares one source of
		   truth, so a future overscan change propagates here instead of leaving the lyrics wider than
		   every other edge-anchored element. */
		padding: 0 var(--tv-safe-x);
		text-align: center;
		pointer-events: none;
		/* The black wash that lifts the words off the video. Tokenised to --scrim-strong (the 0.85 alpha
		   this used is exactly that token's value): the tree had grown five different black-wash alphas
		   for this one effect, and this was one of them. Not a legibility risk — it darkens BEHIND the
		   glyphs, it does not touch the pure-white ink itself. */
		text-shadow: 0 2px 18px var(--scrim-strong);
		/*
		 * THE FOUR COLOURS THE REEL CAN PAINT, as variables — because provenance and highlight are two
		 * independent axes, and competing selectors are a bad way to combine two axes.
		 *
		 * Both were written as rules of equal specificity, and both broke, in opposite directions. The
		 * amber provenance tint listed `.word` / `.word.done` / `.word.active` specifically to
		 * out-specify the word ladder, and it did: measured in a browser, a sung and an unsung word on
		 * an auto-transcribed line were BOTH rgb(255,230,184), so word-by-word highlighting had stopped
		 * existing on every ASR song — while `.word.active` went white under a marker that stayed pink,
		 * so the two cues for "sing this now" disagreed. Meanwhile that same tint LOST to
		 * `.hl-line`/`.hl-off .row.current` on nothing but source order, so those two treatments showed
		 * no provenance tint at all.
		 *
		 * As variables there is nothing to out-specify: provenance sets WHICH colours, the rules below
		 * say WHERE they go, and neither can silently erase the other. Adding a provenance state is one
		 * override block; adding a treatment is one rule that reads these.
		 *
		 * Pure white and the 0.66 alpha stay LITERAL on purpose: white is the maximum-contrast state
		 * over video and has no token (--ink is #f3f3fb, deliberately not pure white, so swapping to it
		 * would REDUCE contrast at three metres), and the alpha IS the "not yet" cue.
		 */
		--reel-current: #fff;
		--reel-ahead: rgba(255, 255, 255, 0.66);
		--reel-done: #fff;
		--reel-line: var(--accent2);
		--reel-now: var(--accent2);
	}
	/*
	 * Unverified text is tinted WARM AMBER rather than set in italic.
	 *
	 * The tint is what actually tells the singer these words are a machine's guess: they read the line
	 * and simultaneously see it does not look like the confident white of every other song, so the
	 * meaning arrives without a warning line to ignore. The old standalone `.notice` strip — one ~880px
	 * letter-spaced sentence pinned centre-bottom — is gone; it landed in the gutter between the two
	 * bottom cards and read as debris, and the route now carries a short `Auto-Transcribed lyrics` label
	 * in the song block, which is what that string is ABOUT.
	 *
	 * Deliberately NOT dimmed: these are still the words to sing from, so making them harder to read
	 * would punish the singer for a provenance problem. Amber is legible on the dark stage (#ffe6b8 on
	 * #0b0b12 measures well past 4.5:1) and is the palette's existing caution family; the dim state
	 * mirrors the white ladder's own 0.66 alpha, which lands ~7:1 on the stage, so "not yet" is still
	 * comfortably readable rather than merely sensed.
	 *
	 * `--reel-now` is deliberately NOT overridden. Pink means "sing this word now" on every song, and
	 * the marker sitting directly above the word is `--accent2` regardless of provenance — recolouring
	 * the word white here left a pink dot over a white word and made the two cues disagree. Amber
	 * carries the doubt; pink carries the position. They are different questions.
	 *
	 * `--reel-line` IS overridden, for the mirror-image reason: it colours the WHOLE current lyric, so
	 * leaving it pink would mean the `line` treatment shows no provenance at all — which is what the
	 * cascade was silently doing before. Under amber the current line is still unmistakably the current
	 * line (the rows around it are dim white), so nothing is lost by tinting it.
	 */
	.lyrics.unverified {
		--reel-current: #ffe6b8;
		--reel-ahead: rgba(255, 230, 184, 0.66);
		--reel-done: #ffe6b8;
		--reel-line: #ffe6b8;
	}
	/*
	 * Uniform row size, differentiated by COLOUR not scale. Growing the current line would reflow the
	 * column mid-animation and fight the transform; keeping every row the same height makes the scroll
	 * exact, and pink/white against grey is already a stronger cue than size.
	 */
	.viewport {
		/*
		 * The reel's own tier, times the room's preference.
		 *
		 * A MULTIPLIER, not a replacement: the token is what makes the reel adapt to the screen, so a
		 * stored pixel size would render wrong the moment the TV's resolution changed. `--lyrics-scale`
		 * is bounded well away from 0 in @encore/shared for the same reason.
		 *
		 * --tv-lyric replaced an inline clamp(3.1rem, 6.4vh, 6rem) here. The reel and the corner chrome
		 * now sit on separate ladders (see app.css): at 6.4vh the sung line wrapped to three rows on a
		 * long lyric, which pushed the marked word off the optical centre — the thing the marker exists
		 * to locate.
		 */
		font-size: calc(var(--tv-lyric) * var(--lyrics-scale, 1));
		font-weight: 800;
		font-family: var(--lyrics-font, inherit);
		text-transform: var(--lyrics-case, none);
		width: 100%;
		/*
		 * Height is DERIVED from the row count, not a constant. It was 9.5em because that is 5 rows of
		 * 1.9em leading — two sung above, the current one, two coming below. The moment the counts became
		 * a setting that constant was a bug waiting to be seen, so the arithmetic is written out instead.
		 *
		 * The mask fades the OUTER rows rather than clipping them, which is what makes the reel read as a
		 * continuous scroll: a line dims away as it leaves instead of vanishing at a hard edge.
		 *
		 * The fade stops are in `em` (one row deep at each edge), NOT the percentages they used to be.
		 * Percentages were tuned for exactly five rows: at three rows a 13% stop reaches into the current
		 * line and dims the words being sung, and at seven rows it barely fades at all. In em the fade is
		 * one row regardless of how many there are.
		 *
		 * An edge with NO context rows is not faded at all. With `linesBefore: 0` the current line IS the
		 * top row, so fading the top edge dims the words being sung — caught eyes-on, and the reason the
		 * two edges are separate variables rather than one. There is nothing there to fade away to.
		 */
		--lyrics-row-h: 1.9em;
		--lyrics-fade-top: calc(var(--lyrics-row-h) * var(--lyrics-fade-top-on, 1));
		--lyrics-fade-bot: calc(var(--lyrics-row-h) * var(--lyrics-fade-bot-on, 1));
		height: calc(var(--lyrics-rows, 5) * var(--lyrics-row-h));
		/*
		 * A ceiling so an EXTREME setting cannot outgrow the freed space above the chrome band. At the
		 * max scalePct with max linesBefore+linesAfter the derived height can exceed what remains once
		 * the band is reserved; capping it lets the existing edge mask fade absorb the surplus rows
		 * rather than the reel spilling back down toward the cards. Symmetric --tv-safe-y keeps a little
		 * breathing room at the top mirror of the band. Does not change default geometry: at the default
		 * five rows the derived height is well under this cap, so the reel is unaffected.
		 */
		max-height: calc(100vh - var(--tv-chrome-h) - var(--tv-safe-y));
		overflow: hidden;
		/*
		 * DELIBERATE LITERALS, not scrims. A mask reads only the LUMINANCE/alpha of each stop, never the
		 * hue — `#000`/`rgba(0,0,0,·)` here mean "fully visible" / "partly visible", they are an opacity
		 * ramp for the edge fade, not the black wash that lifts text off video. Tokenising them to
		 * --scrim-strong would silently change the fade (that token is 0.85, this ramp is a full-black
		 * core with a 0.35 knee) and couple two unrelated effects. So these stay literal on purpose.
		 */
		mask-image: linear-gradient(
			to bottom,
			transparent 0,
			rgba(0, 0, 0, 0.35) calc(var(--lyrics-fade-top) * 0.45),
			#000 var(--lyrics-fade-top),
			#000 calc(100% - var(--lyrics-fade-bot)),
			rgba(0, 0, 0, 0.35) calc(100% - var(--lyrics-fade-bot) * 0.45),
			transparent 100%
		);
		-webkit-mask-image: linear-gradient(
			to bottom,
			transparent 0,
			rgba(0, 0, 0, 0.35) calc(var(--lyrics-fade-top) * 0.45),
			#000 var(--lyrics-fade-top),
			#000 calc(100% - var(--lyrics-fade-bot)),
			rgba(0, 0, 0, 0.35) calc(100% - var(--lyrics-fade-bot) * 0.45),
			transparent 100%
		);
	}
	.reel {
		/* the whole animation: one transform, GPU-composited, never touching layout */
		transition: transform 0.42s cubic-bezier(0.22, 0.9, 0.24, 1);
		will-change: transform;
	}
	.row {
		/*
		 * Loose leading is LOAD-BEARING: the ball is absolutely positioned above its word, so at tight
		 * leading it landed on the previous wrapped line ("this" in "Is this the"). That is also why
		 * leading is NOT a room setting — it would let a room silently break the marker.
		 *
		 * Reads the same variable the viewport's height is computed from, so the row leading and the row
		 * count can never disagree. As an em it resolves against the row's own (inherited) font size, so
		 * it means exactly what the bare `1.9` did.
		 */
		line-height: var(--lyrics-row-h, 1.9em);
		max-width: 100%;
		color: rgba(255, 255, 255, 0.62); /* upcoming — must be READ, not merely sensed */
		transition: color 0.3s ease;
	}
	.row.past {
		color: rgba(255, 255, 255, 0.2); /* already sung — present for continuity, not for reading */
	}
	/*
	 * The current line, when it is rendered as ONE text node rather than word spans.
	 *
	 * That happens under `line`/`off`, and it also happens under `word` when the current line carries
	 * no timed words (`normalize_lyrics` drops words the aligner left un-timed, so a poorly-aligned
	 * line can reach the reel with an empty `words[]`). Without this rule that case inherited `.row`'s
	 * 0.62 dim and the line being sung was indistinguishable from the ones coming up.
	 */
	.row.current {
		color: var(--reel-current);
	}
	/*
	 * LINE-LEVEL treatment. The `line` room setting lights the whole current lyric in the accent and
	 * says nothing about position within it — which is the honest reading when word timings are patchy
	 * (measured coverage runs 87-93% with real holes, and a stale word held for five seconds reads as
	 * broken where a stale line does not).
	 *
	 * `off` deliberately gets NO accent: the reel's own contrast ladder — 0.62 upcoming, current at
	 * full strength, 0.2 past — is what shows position, and PR #8 raised those dim states specifically
	 * so they can be read rather than merely sensed. That is what makes a no-highlight read-along
	 * viable at all, and it is why `off` needs no rule of its own now that `.row.current` carries the
	 * current line's colour.
	 */
	.lyrics.hl-line .row.current {
		color: var(--reel-line);
	}
	.word {
		position: relative;
		display: inline-block;
		color: var(--reel-ahead); /* not yet sung */
		transition: color 0.12s linear;
	}
	.word.done {
		color: var(--reel-done); /* sung */
	}
	/*
	 * WHOLE-WORD highlight, not a left-to-right fill.
	 *
	 * The fill was a lie dressed as precision: it interpolated a sweep across each word as though we
	 * knew where inside the word the singer was, when all we have is a start and an end from the
	 * aligner — and on ASR text those bounds are themselves approximate. A partial wipe therefore
	 * animated made-up sub-word detail, and read as busy while telling the singer nothing.
	 *
	 * Three flat states say exactly what is known and no more: dim = not yet, PINK = sing this now,
	 * white = done.
	 */
	.word.active {
		color: var(--reel-now);
	}
	/*
	 * THE MARKER. One absolutely-positioned element per variant, so switching style never changes the
	 * word's own box and cannot reflow the reel mid-song (the transform-only animation is the whole
	 * reason the scroll is smooth).
	 */
	.ball {
		position: absolute;
		left: 50%;
		/* --accent2 is unconditionally defined in app.css, so the old `#7cf` fallback was dead code and
		   a stray literal — the pink marker is theme-bound, it must ride the token. */
		color: var(--accent2);
	}
	/* Dot variants sit ABOVE the word. The loose 1.9 line-height above is load-bearing for this: at
	   tight leading the dot lands on the previous wrapped row. */
	.ball.bounce,
	.ball.steady {
		top: -0.85em;
		transform: translateX(-50%);
		font-size: 0.5em;
	}
	.ball.bounce {
		animation: bounce 0.5s ease-in-out infinite alternate;
	}
	/*
	 * `steady` is the same dot with no animation — for a wall-sized screen where a bouncing mark is
	 * motion in the corner of the eye all song. Not a separate glyph: the point is that only the
	 * movement differs.
	 */
	/*
	 * `underline` is a BAR, not a glyph — hence the empty text node in the markup. A rule under the
	 * word reads as position without adding anything above the line, which is what makes it the calm
	 * option on a busy screen.
	 */
	.ball.underline {
		bottom: 0.42em;
		width: 100%;
		height: 0.07em;
		border-radius: 0.04em;
		transform: translateX(-50%);
		/* Theme-bound like the dot marker above; --accent2 is always defined, the `#7cf` fallback was
		   dead. */
		background: var(--accent2);
	}
	@media (prefers-reduced-motion: reduce) {
		/* Degrade to `steady` rather than removing the mark: the singer still needs to know which word
		   it is. */
		.ball.bounce {
			animation: none;
		}
		/* The reel's line-to-line transform slides the WHOLE full-width lyric column on every line
		   change — the largest, most vestibular-triggering motion on the TV. Snap it instead: the row
		   still moves to the right place, it just does not glide there. */
		.reel {
			transition: none;
		}
	}
	@keyframes bounce {
		from {
			transform: translate(-50%, 0);
		}
		to {
			transform: translate(-50%, -0.35em);
		}
	}
</style>
