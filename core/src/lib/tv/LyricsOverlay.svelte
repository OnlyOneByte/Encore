<script lang="ts">
	// Word-timed lyrics overlay for the TV: a karaoke sweep with a ball over the word being sung. The
	// authoritative position arrives from the player at ~4Hz and is interpolated to 60fps.
	// See docs/FRONTEND.md#the-lyrics-reel.
	import {
		parseLyricsDoc,
		activeLineIndex,
		activeWordIndex,
		isAutoTranscribed,
		LYRICS_LEAD_SEC,
		type LyricsDoc,
		type LyricsProvenance
	} from './lyrics';
	import { drawPosition } from '$lib/playhead';
	import { reelOffset as reelOffsetFor } from './reel-offset';
	import {
		DEFAULT_LYRICS_BALL,
		DEFAULT_LYRICS_CASE,
		DEFAULT_LYRICS_FONT,
		DEFAULT_LYRICS_HIGHLIGHT,
		DEFAULT_LYRICS_LINES_AFTER,
		DEFAULT_LYRICS_LINES_BEFORE,
		DEFAULT_LYRICS_SCALE_PCT,
		LYRICS_SCALE_BASE,
		getLyricsCase,
		getLyricsFont,
		lyricHighlightColor,
		duetPartColors,
		type LyricsBallStyleId,
		type LyricsCaseId,
		type LyricsFontId,
		type LyricsHighlightId
	} from '$lib/contract';

	interface Props {
		lyricsRef?: string; // MediaStore key of the lyrics JSON on the current media
		doc?: LyricsDoc | null; // pre-parsed lyrics (dev gallery / tests); bypasses the fetch when set
		positionSec: number; // authoritative playback position (from TvPlayer telemetry)
		playing?: boolean; // interpolate forward only while actually playing
		visible?: boolean; // hide during attract/interstitial
		/** Absent/null means provenance is UNKNOWN, which renders exactly like verified text. */
		provenance?: LyricsProvenance | null;
		/** Seconds to run the highlight AHEAD of the audio — see LYRICS_LEAD_SEC for why. */
		leadSec?: number;
		/**
		 * `resolveLyricsPresentation` has ALREADY clamped both against what the deployment's sync mode produces, so
		 * this component renders what it is handed and must not re-derive the rule.
		 */
		ball?: LyricsBallStyleId;
		highlight?: LyricsHighlightId;
		/** A PERCENT of the computed distance-based scale, not a size: an absolute size breaks on a resolution change. */
		scalePct?: number;
		font?: LyricsFontId;
		textCase?: LyricsCaseId;
		linesBefore?: number;
		linesAfter?: number;
		/** The STORED value, not a pre-validated one: `lyricHighlightColor` is the sanitising boundary. */
		singerColor?: string | null;
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
		linesAfter = DEFAULT_LYRICS_LINES_AFTER,
		singerColor = null
	}: Props = $props();

	let fetched = $state<LyricsDoc | null>(null);
	let loadedRef: string | undefined;
	// Reactive, unlike `loadedRef`, because it keeps the one distinction `doc === null` cannot make: "this song has
	// no words" versus "the artifact is still in flight". Both render nothing, but only the first may SAY so.
	let settledRef = $state<string | undefined>(undefined);
	// pre-parsed doc wins (gallery/tests); otherwise use whatever the fetch produced
	const doc = $derived(docProp ?? fetched);

	// Neither of these IS the drawn position: `drawPosition` derives it and ignores the clock while paused, so a
	// backgrounded tab with a stopped rAF has no accumulated position to lose.
	let anchoredAt = 0;
	let now = $state(0);
	$effect(() => {
		// Re-anchor whenever the authoritative position ticks in, so the sweep never drifts far.
		void positionSec;
		anchoredAt = performance.now();
		now = anchoredAt;
	});
	// Paused -> exactly `positionSec`. No rAF state backs it.
	const displayPos = $derived(drawPosition({ positionSec, playing, anchoredAtMs: anchoredAt, nowMs: now }));

	// Fetch + parse the lyrics artifact on a ref change (once per song).
	$effect(() => {
		const ref = lyricsRef;
		if (docProp) return;
		if (!ref) {
			fetched = null;
			loadedRef = undefined;
			// No artifact at all — the dominant no-lyrics case: nothing is in flight, so this is settled at once.
			settledRef = undefined;
			return;
		}
		if (ref === loadedRef) return;
		loadedRef = ref;
		settledRef = undefined;
		// Clear on the ref CHANGE, or the derived `doc` keeps the old artifact until the fetch resolves and one frame
		// renders the PREVIOUS song's lyrics under the new song's title.
		fetched = null;
		let cancelled = false;
		fetch(`/media/${ref}`)
			.then((r) => (r.ok ? r.json() : null))
			.then((j) => {
				if (!cancelled) {
					fetched = parseLyricsDoc(j);
					settledRef = ref;
				}
			})
			.catch(() => {
				if (!cancelled) {
					fetched = null; // dead/absent lyrics → the notice below says so
					settledRef = ref;
				}
			});
		return () => {
			cancelled = true;
		};
	});

	// Advance the CLOCK, never the position: a throttled or stopped loop leaves the paused reel untouched, because
	// there is no accumulator here to drift back to 0.
	$effect(() => {
		if (!playing) return;
		let raf = 0;
		const tick = () => {
			now = performance.now();
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	});

	// The HIGHLIGHT's position: playback position plus the lead. `displayPos` itself stays honest.
	const cuePos = $derived(displayPos + leadSec);
	const lineIdx = $derived(doc ? activeLineIndex(doc.lines, cuePos) : -1);
	const curLine = $derived(doc && lineIdx >= 0 ? doc.lines[lineIdx] : null);
	const ballWord = $derived(curLine ? activeWordIndex(curLine, cuePos) : -1);
	const show = $derived(visible && !!curLine);
	// Deliberately narrow, so it cannot fire on a normal blank frame: `!doc` lets a song WITH words that is merely
	// between lines stay blank, and the settled check keeps the notice from flashing during a load.
	const noLyrics = $derived(visible && !doc && (!lyricsRef || settledRef === lyricsRef));
	// MEASURE where the current row sits, rather than rows × height — a wrapped line drifts the whole column.
	let viewportEl = $state<HTMLElement | null>(null);
	let reelEl = $state<HTMLElement | null>(null);
	let reelOffset = $state(0);
	function measureReel() {
		const row = reelEl?.querySelector<HTMLElement>('.row.current');
		if (!row || !viewportEl) return;
		// `band` must be the CLIPPED `clientHeight`, and the fade depths must be the RENDERED ones, or the sung row
		// parks inside a ramp. The cap below mirrors the stylesheet's `--lyrics-fade-cap` exactly; the two must
		// agree. See docs/FRONTEND.md#the-lyrics-reel.
		const oneRow = parseFloat(getComputedStyle(row).lineHeight) || row.offsetHeight;
		const fadeCap = Math.max(0, Math.min(oneRow, (viewportEl.clientHeight - oneRow) / 2));
		reelOffset = reelOffsetFor({
			rowTop: row.offsetTop,
			rowHeight: row.offsetHeight,
			band: viewportEl.clientHeight,
			linesBefore,
			linesAfter,
			fadeTop: linesBefore > 0 ? fadeCap : 0,
			fadeBot: linesAfter > 0 ? fadeCap : 0
		});
	}
	$effect(() => {
		void lineIdx; // re-measure on every line change
		// The row counts move the bias AND the viewport height, and a settings write can land mid-song.
		void linesBefore;
		void linesAfter;
		measureReel();
	});
	// A row's height is NOT constant: the current row renders inline-block word spans while the others render plain
	// text, so the geometry shifts the moment a line becomes current (~11px, accumulating over a song).
	$effect(() => {
		if (!reelEl) return;
		const ro = new ResizeObserver(() => measureReel());
		ro.observe(reelEl);
		return () => ro.disconnect();
	});
	const unverified = $derived(isAutoTranscribed(provenance));
	/** Only the `word` treatment needs spans; plain text keeps the row one text node for the ResizeObserver. */
	const wordLevel = $derived(highlight === 'word');
	// The type as custom properties, so the stylesheet keeps owning the geometry. `--lyrics-rows` is the
	// load-bearing one: the viewport height is DERIVED from the row count.
	const rowCount = $derived(linesBefore + 1 + linesAfter);
	const fontStack = $derived(getLyricsFont(font)?.stack ?? 'inherit');
	const caseTransform = $derived(getLyricsCase(textCase)?.transform ?? 'none');
	// `null` means no singer colour applies. Appended CONDITIONALLY below, so the CSS default is the real fallback
	// and the accent is named exactly once.
	const singerHighlight = $derived(lyricHighlightColor(singerColor));
	// Derived per DOC, because a part belongs to the song rather than the frame. `null` on an undiarized song, so
	// `--reel-part` is never written and the reel keeps its single-colour path.
	const partColors = $derived(duetPartColors(doc?.lines));
	const partColor = $derived(
		curLine && typeof curLine.part === 'string' ? (partColors.get(curLine.part) ?? null) : null
	);
	const typeStyle = $derived(
		// REBASED: the neutral 100 renders what 80 rendered before — see LYRICS_SCALE_BASE.
		`--lyrics-scale: ${(scalePct / 100) * LYRICS_SCALE_BASE}; --lyrics-rows: ${rowCount}; ` +
			`--lyrics-font: ${fontStack}; --lyrics-case: ${caseTransform}; ` +
			// An edge with no context rows must not be faded — there the current line IS the edge row.
			`--lyrics-fade-top-on: ${linesBefore > 0 ? 1 : 0}; --lyrics-fade-bot-on: ${linesAfter > 0 ? 1 : 0}` +
			(singerHighlight ? `; --reel-singer: ${singerHighlight}` : '') +
			(partColor ? `; --reel-part: ${partColor}` : '')
	);
</script>

{#if show && doc && curLine}
	<div class="lyrics hl-{highlight}" class:unverified={unverified} role="presentation" style={typeStyle}>
		<!--
			A SCROLLING REEL, not a two-slot swap: every line is a persistent keyed node in one column and only the
			column transform changes, so the singer keeps the line they just sang in view.
		-->
		<div class="viewport" bind:this={viewportEl}>
			<div class="reel" bind:this={reelEl} style="transform: translateY({reelOffset}px)">
				{#each doc.lines as l, i (i)}
					<div class="row" class:current={i === lineIdx} class:past={i < lineIdx}>
						{#if i === lineIdx && l.words.length && wordLevel}
							{#each l.words as w, wi (wi)}
								<span class="word" class:done={cuePos >= w.end} class:active={wi === ballWord}>
									{#if wi === ballWord && ball !== 'off'}<span class="ball {ball}" aria-hidden="true"
											>{ball === 'underline' ? '' : '●'}</span
										>{/if}{w.word}
								</span>{' '}
							{/each}
						{:else}
							<!-- The plain-text branch, shared by a line-timed doc and the `line`/`off` settings — no second
							     renderer. `.row.current` carries the line-level treatment. -->
							{l.text}
						{/if}
						{#if l.romanization}
							<!-- SECOND SCRIPT, only when the source provided one. Display-only: the characters are the words. -->
							<div class="romanization">{l.romanization}</div>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	</div>
{:else if noLyrics}
	<!--
		NO WORDS FOR THIS SONG. A say, not a button — nothing a tap can fix. It reuses `.lyrics`'s box, so it inherits
		the reserved chrome band and cannot collide with the lower-third or the join corner. `role="status"` because
		`presentation` would hide the only information on the stage.
	-->
	<div class="lyrics no-lyrics" role="status" aria-live="polite" style={typeStyle}>
		<span class="nl-head">No lyrics for this one</span>
		<span class="nl-sub">The song still plays — sing from memory</span>
	</div>
{/if}

<style>
	.lyrics {
		position: absolute;
		/* NOT `inset: 0`: the bottom is pulled up by the chrome band the join corner and the lower-third occupy. The
		   box stays CENTRED, so reserving that band also raises the centreline into the freed space. */
		top: 0;
		left: 0;
		right: 0;
		bottom: var(--tv-chrome-h);
		z-index: var(--z-tv-reel);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.7em;
		/* Safe-area token, not a percentage: every edge-anchored element on the TV shares one inset. */
		padding: 0 var(--tv-safe-x);
		text-align: center;
		pointer-events: none;
		/* Darkens BEHIND the glyphs, so it is not a contrast risk for the pure-white ink. */
		text-shadow: 0 2px 18px var(--scrim-strong);
		/* THE STROKE is what lets the stage carry any colour with no brightness bound: the blurred shadow above
		   dissolves against a mid-tone field of similar brightness, which is exactly what a hue-only background
		   paints. `paint-order: stroke fill` is LOAD-BEARING — the default paints the stroke on top of the fill and
		   eats the thin parts of each glyph. Width in `em`, or it reads heavy at 720p and hairline at 4K. */
		-webkit-text-stroke: 0.06em var(--scrim-strong);
		paint-order: stroke fill;
		/* A CHAIN of variables, because provenance and highlight are INDEPENDENT axes and competing selectors of
		   equal specificity broke both at once. Provenance sets WHICH colours; the rules below say WHERE.

		   Pure white and the 0.66 alpha stay LITERAL: `--ink` is deliberately not pure white, so tokenising would
		   REDUCE contrast at three metres, and the alpha IS the "not yet" cue. */
		--reel-current: #fff;
		--reel-ahead: rgba(255, 255, 255, 0.66);
		--reel-done: #fff;
		/* The single place the accent fallback is named. Both highlight colours read the CHAIN rather than naming
		   `--accent2`, which is what keeps `word` and `line` agreeing about whose colour is showing. */
		--reel-singer: var(--accent2);
		/* Layered ON TOP of `--reel-singer`, written only on a confident duet's line, so an undiarized song falls
		   through unchanged. */
		--reel-part: var(--reel-singer);
		--reel-line: var(--reel-part);
		--reel-now: var(--reel-part);
	}
	/*
	 * Amber rather than italic, so the meaning arrives without a warning line to ignore, and NOT dimmed — these are
	 * still the words to sing from.
	 *
	 * `--reel-now` is deliberately NOT overridden: the active word answers WHERE the singer is, a different question
	 * from whether the text is trustworthy, and the marker above it is `--accent2` regardless, so recolouring the
	 * word leaves a pink dot over a white one. `--reel-line` IS overridden for the mirror reason: it colours the
	 * whole current lyric, so leaving it alone shows no provenance.
	 */
	.lyrics.unverified {
		--reel-current: #ffe6b8;
		--reel-ahead: rgba(255, 230, 184, 0.66);
		--reel-done: #ffe6b8;
		--reel-line: #ffe6b8;
	}
	/* Much smaller than a lyric line — a status, not something to sing — but off the same `--tv-lyric` tier, because
	   a px value reads heavy at 720p and hairline at 4K. */
	.no-lyrics {
		gap: 0.35em;
		font-size: calc(var(--tv-lyric) * 0.34);
		font-family: var(--lyrics-font, inherit);
		line-height: var(--lh-snug);
	}
	.nl-head {
		color: rgba(255, 255, 255, 0.86);
		font-weight: 650;
	}
	.nl-sub {
		color: rgba(255, 255, 255, 0.6);
		font-size: 0.62em;
	}

	.viewport {
		/* A MULTIPLIER on the token, not a replacement: the token is what makes the reel adapt to the screen. */
		font-size: calc(var(--tv-lyric) * var(--lyrics-scale, 1));
		font-weight: 800;
		font-family: var(--lyrics-font, inherit);
		text-transform: var(--lyrics-case, none);
		width: 100%;
		/* The mask FADES the outer rows rather than clipping them. Its stops are in `em` (one row per edge), never
		   percentages, which were tuned for five rows and at three reached into the current line. An edge with NO
		   context rows is not faded at all, which is why the two edges are separate variables. */
		--lyrics-row-h: 1.9em;
		/* Capped, so the two ramps can never eat the box and leave no opaque plateau for the sung row. `100%` is this
		   box's own POST-CAP height, and measureReel mirrors this exact cap in px. */
		--lyrics-fade-cap: min(var(--lyrics-row-h), calc((100% - var(--lyrics-row-h)) / 2));
		--lyrics-fade-top: calc(var(--lyrics-fade-cap) * var(--lyrics-fade-top-on, 1));
		--lyrics-fade-bot: calc(var(--lyrics-fade-cap) * var(--lyrics-fade-bot-on, 1));
		height: calc(var(--lyrics-rows, 5) * var(--lyrics-row-h));
		/*
		 * EXACTLY the parent band, and it must NOT subtract a further `--tv-safe-y`: the box is centred, so charging
		 * one against its height buys only half of it as top inset while removing a full one of reel — and
		 * `--tv-chrome-h` already contains one. The cap is ACTIVE at the default five rows on short panels (they want
		 * ~79.8vh against ~76vh of band at 720p); seating all five there needs the type budget itself to change.
		 */
		max-height: calc(100vh - var(--tv-chrome-h));
		overflow: hidden;
		/* DELIBERATE LITERALS, not scrims: a mask reads only the LUMINANCE/alpha of each stop, so these are the edge
		   fade's opacity ramp and not the black wash that lifts text off video. */
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
		/* The whole animation: one transform, GPU-composited, never touching layout. */
		transition: transform 0.42s cubic-bezier(0.22, 0.9, 0.24, 1);
		will-change: transform;
	}
	.row {
		/* LOOSE LEADING IS LOAD-BEARING: the ball is absolutely positioned above its word, so at tight leading it
		   lands on the previous wrapped line — which is also why leading is not a room setting. Reads the same
		   variable the viewport height is computed from, so leading and row count cannot disagree. */
		line-height: var(--lyrics-row-h, 1.9em);
		max-width: 100%;
		color: rgba(255, 255, 255, 0.62); /* upcoming — must be READ, not merely sensed */
	}
	.row.past {
		color: rgba(255, 255, 255, 0.2); /* already sung — present for continuity, not for reading */
	}
	/* Inherits the row's colour transition, so it fades in step with its line rather than at one fixed brightness. */
	.romanization {
		font-size: 0.62em;
		line-height: var(--lh-snug);
		margin-top: 0.15em;
		/* DERIVED FROM THE ROW'S INK, not an opacity on it — which is what keeps the "fades in step with its line"
		   behaviour above while making the dim a colour. As a subtree alpha it multiplied the row's own 0.62 to an
		   effective ~0.48 that no reading of either rule revealed. Still dim by design: a second script is a hint
		   under the words, not a competing line. */
		color: color-mix(in srgb, currentColor 78%, transparent);
		letter-spacing: 0.01em;
	}
	/* Covers the current line as ONE text node: under `line`/`off`, and under `word` when a poorly aligned line
	   reaches the reel with an empty `words[]`. Without this rule that case inherits `.row`'s dim. */
	.row.current {
		color: var(--reel-current);
	}
	/* `line` says nothing about position within the lyric, the honest reading when word timings are patchy (measured
	   coverage 87-93% with real holes). `off` deliberately gets NO accent: the contrast ladder shows position. */
	.lyrics.hl-line .row.current {
		color: var(--reel-line);
	}
	.word {
		position: relative;
		display: inline-block;
		color: var(--reel-ahead); /* not yet sung */
	}
	.word.done {
		color: var(--reel-done); /* sung */
	}
	/* WHOLE-WORD, not a left-to-right fill: a fill would claim to know where inside the word the singer is, when the
	   aligner gives only a start and an end. Three flat states say exactly what is known. */
	.word.active {
		color: var(--reel-now);
	}
	/* Absolutely positioned in every variant, so switching style cannot change the word's box and reflow the reel. */
	.ball {
		position: absolute;
		left: 50%;
		/* Theme-bound: the marker must ride the token, never a literal. */
		color: var(--accent2);
	}
	/* Dot variants sit ABOVE the word, which is what makes the loose line-height above load-bearing. `steady` is
	   the same dot as `bounce` with no animation — not a separate glyph, only the movement differs. */
	.ball.bounce,
	.ball.steady {
		top: -0.85em;
		transform: translateX(-50%);
		font-size: 0.5em;
	}
	.ball.bounce {
		animation: bounce 0.5s ease-in-out infinite alternate;
	}
	.ball.underline {
		bottom: 0.42em;
		width: 100%;
		height: 0.07em;
		border-radius: 0.04em;
		transform: translateX(-50%);
		/* Theme-bound like the dot marker above. */
		background: var(--accent2);
	}
	/* THE TWO INK SWEEPS, opt-in. `color` is animatable per the rule, so these needed a gate as much as the reel's
	   transform below — reduced, the highlight still moves word to word, it just steps instead of fading. Separate
	   from the `reduce` block beneath because the reel's transform is a DEGRADATION (snap, not remove) while these
	   are simply absent. */
	@media (prefers-reduced-motion: no-preference) {
		.row {
			transition: color 0.3s ease;
		}
		.word {
			transition: color var(--motion-fast) linear;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		/* Degrade to `steady` rather than removing the mark: the singer still needs the word. */
		.ball.bounce {
			animation: none;
		}
		/* The line-to-line transform slides the WHOLE full-width column — the most vestibular-triggering motion on
		   the TV. Snapped, not removed: the row still moves, it just does not glide. */
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
