<script lang="ts">
	// Word-timed lyrics overlay for the TV: a karaoke sweep with a ball over the word being sung. The
	// authoritative position arrives from the player at ~4Hz and is interpolated to 60fps.
	// See docs/FRONTEND.md#the-lyrics-reel.
	import {
		parseLyricsDoc,
		activeLineIndex,
		activeWordIndex,
		isAutoTranscribed,
		wipesWords,
		wordGap,
		betweenLines,
		changedRows,
		fixStepsBack,
		rowsOf,
		chorusLines,
		lineBounds,
		holdFloor,
		LYRICS_LEAD_SEC,
		type LyricsDoc,
		type LyricsProvenance
	} from './lyrics';
	import { untrack } from 'svelte';
	import { drawPosition } from '$lib/playhead';
	import { reelOffset as reelOffsetFor } from './reel-offset';
	import type { WordsFit } from './TvWordsOnly.svelte';
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
		/** Which turn is on stage. A new `lyricsRef` for the SAME turn is a lyrics fix, swapped in at a gap. */
		songKey?: string;
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
		/** The room's "Show the chorus to the room" (proposal 38). */
		chorus?: boolean;
		/** Rows each lyric line may wrap to inside the reel's budget (Words only gives two). */
		wrapRows?: number;
		/** Cap the type so every line, at `wrapRows` rows, fits the band at any room size (Words only, whose lazy chunk
		 *  carries the helpers, so the stage ships none of them). */
		fit?: WordsFit | null;
	}
	let {
		lyricsRef,
		doc: docProp,
		positionSec,
		playing = true,
		visible = true,
		provenance = null,
		leadSec = LYRICS_LEAD_SEC,
		songKey,
		ball = DEFAULT_LYRICS_BALL,
		highlight = DEFAULT_LYRICS_HIGHLIGHT,
		scalePct = DEFAULT_LYRICS_SCALE_PCT,
		font = DEFAULT_LYRICS_FONT,
		textCase = DEFAULT_LYRICS_CASE,
		linesBefore = DEFAULT_LYRICS_LINES_BEFORE,
		linesAfter = DEFAULT_LYRICS_LINES_AFTER,
		singerColor = null,
		chorus = true,
		wrapRows = 1,
		fit = null
	}: Props = $props();

	const FIX_WAIT_MAX_MS = 10_000;

	let fetched = $state<LyricsDoc | null>(null);
	let loadedRef: string | undefined;
	let loadedSong: string | undefined;
	// A lyrics fix for the turn on stage waits here for a gap between lines.
	let heldDoc = $state<LyricsDoc | null>(null);
	let heldSince = 0;
	let heldAtLine = -1;
	// The rows the last swap rewrote. They are new nodes (keyed by text), so the class fades each in once.
	let freshRows = $state<ReadonlySet<number>>(new Set());
	// Reactive, unlike `loadedRef`, because it keeps the one distinction `doc === null` cannot make: "this song has
	// no words" versus "the artifact is still in flight". Both render nothing, but only the first may SAY so.
	let settledRef = $state<string | undefined>(undefined);
	// pre-parsed doc wins (gallery/tests); otherwise use whatever the fetch produced
	const doc = $derived(docProp ?? fetched);

	// Neither of these IS the drawn position: `drawPosition` derives it and ignores the clock while paused, so a
	// backgrounded tab with a stopped rAF has no accumulated position to lose.
	let anchoredAt = 0;
	let now = $state(0);
	let anchorPos = 0;
	let anchorPlaying = false;
	let floorSec = 0;
	$effect(() => {
		/* Re-anchor whenever the authoritative position ticks in, so the sweep never drifts far — AND whenever
		   `playing` flips, which is the whole of docs/FRONTEND.md#a-dependency-set-is-not-a-value and the third
		   site of the only reactivity defect this tree has shipped twice.
		   Why `void playing` is load-bearing here: a paused <audio> fires no `ontimeupdate`, so `positionSec`
		   stops arriving and this anchor freezes at the last pre-pause tick. The rAF effect below DOES read
		   `playing`, so on resume it restarts and writes a fresh `now` — and `drawPosition` then returns
		   `positionSec + (now - anchoredAt)/1000`, which is the position plus THE WHOLE PAUSE. Pause the TV for
		   thirty seconds and the lyric reel flew thirty seconds ahead of the song on resume.
		   The rule the other two sites settled on: capture the anchor in an effect that reads every signal it
		   depends on, which makes a stale anchor unrepresentable rather than merely unlikely. */
		void positionSec;
		void playing;
		// A late anchor holds what the last frame drew rather than stepping the row back (#1401). Paused draws the
		// anchor exactly, and a new song's is a jump.
		const drawn = drawPosition({
			positionSec: anchorPos,
			playing: anchorPlaying,
			anchoredAtMs: anchoredAt,
			nowMs: untrack(() => now)
		});
		floorSec = holdFloor(anchorPlaying ? Math.max(floorSec, drawn) : drawn, positionSec);
		anchorPos = positionSec;
		anchorPlaying = playing;
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
		// The same turn with words already up: fetch behind them, and keep them if the fix does not load.
		const fix = songKey !== undefined && songKey === loadedSong && untrack(() => fetched) !== null;
		loadedRef = ref;
		loadedSong = songKey;
		if (!fix) {
			settledRef = undefined;
			// Clear on the ref CHANGE, or the derived `doc` keeps the old artifact until the fetch resolves and one frame
			// renders the PREVIOUS song's lyrics under the new song's title.
			fetched = null;
			heldDoc = null;
			freshRows = new Set();
		}
		let cancelled = false;
		fetch(`/media/${ref}`)
			.then((r) => (r.ok ? r.json() : null))
			.then((j) => {
				if (cancelled) return;
				const parsed = parseLyricsDoc(j);
				if (fix) {
					if (parsed) heldDoc = parsed;
					heldSince = performance.now();
					return;
				}
				fetched = parsed;
				settledRef = ref;
			})
			.catch(() => {
				if (!cancelled && !fix) {
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

	// The HIGHLIGHT's position: playback position, held through a late anchor while playing, plus the lead.
	// `displayPos` itself stays honest.
	const cuePos = $derived((playing ? Math.max(floorSec, displayPos) : displayPos) + leadSec);

	// Which row of the reading on screen each row of the held fix stands for, so a dropped row is not a step back.
	const heldRows = $derived(heldDoc && doc ? rowsOf(doc, heldDoc) : null);

	// A held fix goes in where neither the old nor the new reading is inside a line, so no word is cut off, and on
	// every path only where the new current row is not an earlier one. See docs/FRONTEND.md#lyrics-fixes.
	$effect(() => {
		if (!heldDoc) return;
		// shortcut: after 10 s with no shared gap, the old reading being between lines or a new line starting is
		// enough (a slow screen paints right over short gaps), so the fix can land with a word already lit.
		const overdue = heldSince > 0 && now - heldSince > FIX_WAIT_MAX_MS;
		const lineStarted = lineIdx !== heldAtLine;
		heldAtLine = lineIdx;
		const oldGap = betweenLines(doc, cuePos);
		const atGap = !playing || !doc || (oldGap ? overdue || betweenLines(heldDoc, cuePos) : overdue && lineStarted);
		if (!atGap || fixStepsBack(heldDoc, heldRows, cuePos, lineIdx)) return;
		// The new rows sit at other heights, and words that have ended land on their last row, often far up the reel:
		// cut to the current slot, never slide (#1299).
		snapReel = true;
		requestAnimationFrame(() => requestAnimationFrame(() => (snapReel = false)));
		freshRows = changedRows(fetched, heldDoc);
		fetched = heldDoc;
		settledRef = loadedRef;
		heldDoc = null;
		heldSince = 0;
	});

	const lineIdx = $derived(doc ? activeLineIndex(doc.lines, cuePos) : -1);
	const curLine = $derived(doc && lineIdx >= 0 ? doc.lines[lineIdx] : null);
	const ballWord = $derived(curLine ? activeWordIndex(curLine, cuePos) : -1);
	// The chorus (proposal 38): its rows take the room's colour, and "Everyone" stands over the row that opens each
	// time it comes round, from the line before until that row starts. See docs/FRONTEND.md#the-chorus.
	const chorusRows = $derived(chorus && doc ? chorusLines(doc.lines) : new Set<number>());
	const opensChorus = (i: number) => chorusRows.has(i) && !chorusRows.has(i - 1);
	const cueRow = $derived.by(() => {
		if (opensChorus(lineIdx + 1)) return lineIdx + 1;
		const start = curLine ? lineBounds(curLine)?.[0] : undefined;
		return opensChorus(lineIdx) && start !== undefined && cuePos < start ? lineIdx : -1;
	});
	const show = $derived(visible && !!curLine);
	// Deliberately narrow, so it cannot fire on a normal blank frame: `!doc` lets a song WITH words that is merely
	// between lines stay blank, and the settled check keeps the notice from flashing during a load.
	const noLyrics = $derived(visible && !doc && (!lyricsRef || settledRef === lyricsRef));
	// MEASURE where the current row sits, rather than rows × height — a wrapped line drifts the whole column.
	let viewportEl = $state<HTMLElement | null>(null);
	let reelEl = $state<HTMLElement | null>(null);
	let reelOffset = $state(0);
	// Two frames with no transition after a version swaps in, so the first offset measured for its rows is a cut.
	let snapReel = $state(false);
	function measureReel() {
		// The row `lineIdx` names, not the one marked current: a ResizeObserver frame can land before the class follows a
		// line change, and parked the reel on the next row through a gap (#1326).
		const row = reelEl?.children[lineIdx] as HTMLElement | undefined;
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
			fadeTop: linesBefore > 0 && !fit ? fadeCap : 0,
			fadeBot: linesAfter > 0 && !fit ? fadeCap : 0
		});
		// The fit cap counts rows, not letters: a wide font (mono) still takes a 42-character line past `wrapRows`, so a
		// shown line taller than its budget steps the type down (to half at most), measured again on the frame it lands.
		if (
			fit &&
			shrink > 0.5 &&
			fit.over(reelEl!.children, lineIdx - linesBefore, lineIdx + linesAfter, wrapRows, oneRow)
		) {
			shrink = Math.max(0.5, shrink * 0.92);
			snapReel = true;
			requestAnimationFrame(() => {
				snapReel = false;
				measureReel();
			});
		}
	}
	let shrink = $state(1);
	$effect(() => {
		void [doc, font, textCase, scalePct, wrapRows, fit];
		shrink = 1;
	});
	$effect(() => {
		void lineIdx; // re-measure on every line change
		void doc; // and in the flush that swaps a version in, before the ResizeObserver's frame
		// The row counts move the bias AND the viewport height, and a settings write can land mid-song.
		void linesBefore;
		void linesAfter;
		untrack(measureReel);
	});
	// A change of GEOMETRY (the type size, the row counts or the wrap budget, as when a screen turns Words only) puts
	// the sung row somewhere new at once, so the reel lands there with no glide: gliding from the old offset left the
	// sung line outside the view for ~100 ms. `snapReel` drops the transition for one frame only.
	let geometry: string | undefined;
	$effect(() => {
		const now = `${scalePct}/${linesBefore}/${linesAfter}/${wrapRows}/${fit}`;
		if (geometry !== undefined && geometry !== now) {
			snapReel = true;
			untrack(measureReel);
			const f = requestAnimationFrame(() => (snapReel = false));
			geometry = now;
			return () => cancelAnimationFrame(f);
		}
		geometry = now;
	});
	// A row's height is NOT constant: the current row renders inline-block word spans while the others render plain
	// text, so the geometry shifts the moment a line becomes current (~11px, accumulating over a song).
	$effect(() => {
		if (!reelEl) return;
		const ro = new ResizeObserver(() => measureReel());
		ro.observe(reelEl);
		if (viewportEl) ro.observe(viewportEl);
		// A lyrics font arriving late rewraps every row.
		document.fonts?.addEventListener('loadingdone', measureReel);
		return () => {
			ro.disconnect();
			document.fonts?.removeEventListener('loadingdone', measureReel);
		};
	});
	const unverified = $derived(isAutoTranscribed(provenance));
	// EVERY row of the reel renders its own `romanization`, not just the current one, so a romanised doc makes
	// every row taller than `--lyrics-row-h` — and the viewport height is rows x that. The flag adds the second
	// script's own height to the row BUDGET, so `linesBefore`/`linesAfter` still fit. See
	// docs/FRONTEND.md#the-lyrics-reel.
	const romanized = $derived(!!doc?.lines.some((l) => l.romanization));
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
	const fitStyle = $derived(fit ? fit.style(rowCount, wrapRows, shrink) : '');
	const typeStyle = $derived(
		// REBASED: the neutral 100 renders what 80 rendered before — see LYRICS_SCALE_BASE.
		`--lyrics-scale: ${(scalePct / 100) * LYRICS_SCALE_BASE * (fit ? shrink : 1)}; --lyrics-rows: ${rowCount}; ` +
			`--lyrics-wrap: ${wrapRows}${fitStyle}; ` +
			`--lyrics-font: ${fontStack}; --lyrics-case: ${caseTransform}; ` +
			// An edge with no context rows must not be faded — there the current line IS the edge row.
			// In fit mode the box holds exactly its lines and nothing trails past them, so neither edge fades.
			`--lyrics-fade-top-on: ${linesBefore > 0 && !fit ? 1 : 0}; --lyrics-fade-bot-on: ${linesAfter > 0 && !fit ? 1 : 0}` +
			(singerHighlight ? `; --reel-singer: ${singerHighlight}` : '') +
			(partColor ? `; --reel-part: ${partColor}` : '')
	);
</script>

{#if show && doc && curLine}
	<div class={['lyrics', `hl-${highlight}`, { unverified, romanized }]} role="presentation" style={typeStyle}>
		<!--
			A SCROLLING REEL, not a two-slot swap: every line is a persistent keyed node in one column and only the
			column transform changes, so the singer keeps the line they just sang in view.
		-->
		<div class="viewport" bind:this={viewportEl}>
			<div
				class="reel"
				bind:this={reelEl}
				style="transform: translateY({reelOffset}px){snapReel ? '; transition: none' : ''}"
			>
				<!-- A row a lyrics fix rewrote is a new node, not a centred line sliding sideways; the rest keep index keys,
				     so a new song reuses the rows as before. -->
				{#each doc.lines as l, i (freshRows.has(i) ? `${i}:${l.text}` : i)}
					<div
						class={[
							'row',
							{
								current: i === lineIdx,
								past: i < lineIdx,
								fresh: freshRows.has(i),
								chorus: chorusRows.has(i),
								// Fit mode budgets for these lines alone, so a wrapped one past them never peeks in at an edge.
								beyond: fit && (i < lineIdx - linesBefore || i > lineIdx + linesAfter)
							}
						]}
					>
						{#if opensChorus(i)}
							<!-- Out of flow, in the leading above the row, so showing it moves nothing. -->
							<span class={['everyone', { on: i === cueRow }]}>Everyone</span>
						{/if}
						{#if i === lineIdx && l.words.length && wordLevel && wipesWords(l)}
							{#each l.words as w, wi (wi)}
								<span class={['word', { done: cuePos >= w.end, active: wi === ballWord }]}>
									{#if wi === ballWord && ball !== 'off'}<span class="ball {ball}" aria-hidden="true"
										></span>{/if}{w.word}
									<!--
										The inter-word gap HAS to stay a mustache. Compiled, this each body emits `</span> ` with
										`{' '}` and `</span>` with a bare literal space, because Svelte trims whitespace at the end of a
										block body — so the plain-space form runs every word of the line together, with no break to wrap
										on. It also has to sit OUTSIDE `.word`, or the gap takes the `.done` fill and the ball.
										`wordGap` is what makes it a RULE rather than a space: CJK writes none between its own
										characters, so a Japanese line rendered word-by-word is not spelled out letter by letter.
									-->
								</span>{wordGap(l.words, wi)}
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
		<span class="nl-sub">The song still plays - sing from memory</span>
	</div>
{/if}

<style>
	.lyrics {
		position: absolute;
		/* NOT `inset: 0`: the bottom is pulled up by the chrome band the join corner and the lower-third occupy. The
		   box stays CENTRED, so reserving that band also raises the centreline into the freed space. */
		top: var(--tv-top-reserve);
		left: 0;
		right: 0;
		bottom: var(--tv-chrome-h);
		z-index: var(--z-tv-reel);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.7em;
		/* Safe-area token, not a percentage: every edge-anchored element on the TV shares one inset. Plus the reaction
		   lane's reserve, on BOTH sides so a row stays centred; /tv publishes it only while reactions are on. */
		padding: 0 calc(var(--tv-safe-x) + var(--tv-reaction-reserve));
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
		/* The room's colour on chorus rows: a warm gold that is no singer's (SINGER_COLORS) and not the cream of
		   unverified words. */
		--reel-room: #ffdf7a;
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
		/* A MULTIPLIER on the token, not a replacement: the token is what makes the reel adapt to the screen. Capped by
		   `--lyrics-fit` only when the caller asks every line to fit (Words only); unset, the cap is never reached. */
		font-size: min(calc(var(--tv-lyric) * var(--lyrics-scale, 1)), var(--lyrics-fit, 100vh));
		font-weight: 800;
		font-family: var(--lyrics-font, inherit);
		text-transform: var(--lyrics-case, none);
		width: 100%;
		/* The mask FADES the outer rows rather than clipping them. Its stops are in `em` (one row per edge), never
		   percentages, which were tuned for five rows and at three reached into the current line. An edge with NO
		   context rows is not faded at all, which is why the two edges are separate variables. */
		--lyrics-row-h: 1.9em;
		/* The second script's own type, declared ONCE here and read by both `.romanization` and the row budget
		   below, so the rendered height and the height the viewport reserves cannot drift. The gap is unitless
		   because `margin-top` on `.romanization` resolves against ITS font-size, not the row's. */
		--romanization-size: 0.62em;
		--romanization-leading: var(--lh-snug);
		--romanization-gap: 0.15;
		/* A ROW IS ITS LEADING PLUS WHATEVER ELSE IT RENDERS. 0 by default; `.lyrics.romanized` adds the second
		   script's line, since every row of a romanised doc carries one. */
		--lyrics-row-extra: 0em;
		--lyrics-row-budget: calc(var(--lyrics-row-h) + var(--lyrics-row-extra));
		/* Capped, so the two ramps can never eat the box and leave no opaque plateau for the sung row. `100%` is this
		   box's own POST-CAP height, and measureReel mirrors this exact cap in px — off the TEXT line's leading, which
		   is what the ramp was tuned to, so the two stay the same number. */
		--lyrics-fade-cap: min(var(--lyrics-row-h), calc((100% - var(--lyrics-row-h)) / 2));
		--lyrics-fade-top: calc(var(--lyrics-fade-cap) * var(--lyrics-fade-top-on, 1));
		--lyrics-fade-bot: calc(var(--lyrics-fade-cap) * var(--lyrics-fade-bot-on, 1));
		/* Each line's budget is `--lyrics-wrap` rows: one on the stage, two on Words only, where the bigger type wraps. */
		height: calc(var(--lyrics-rows, 5) * var(--lyrics-wrap, 1) * var(--lyrics-row-budget) + var(--lyrics-slack, 0em));
		/*
		 * EXACTLY the parent band, and it must NOT subtract a further `--tv-safe-y`: the box is centred, so charging
		 * one against its height buys only half of it as top inset while removing a full one of reel — and
		 * `--tv-chrome-h` already contains one. The cap is ACTIVE at the default five rows on short panels (they want
		 * ~79.8vh against ~76vh of band at 720p); seating all five there needs the type budget itself to change.
		 */
		max-height: calc(100vh - var(--tv-chrome-h) - var(--tv-top-reserve));
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
		/* The whole animation is one transform, GPU-composited, never touching layout; the transition that
		   interpolates it is declared in the opt-in block below. `will-change` is unconditional because the
		   transform still changes every line under Reduce Motion — it jumps instead of gliding. */
		will-change: transform;
	}
	/* The ROW BUDGET the viewport reserves per row, grown by the second script's own line — every row of a
	   romanised doc renders one, so without this the fixed-height viewport clipped a context row per edge. */
	.lyrics.romanized .viewport {
		--lyrics-row-extra: calc(var(--romanization-size) * (var(--romanization-leading) + var(--romanization-gap)));
	}
	.row {
		/* LOOSE LEADING IS LOAD-BEARING: the ball is absolutely positioned above its word, so at tight leading it
		   lands on the previous wrapped line — which is also why leading is not a room setting. This is the TEXT
		   line's leading alone; what the viewport reserves per row is `--lyrics-row-budget`, which adds the
		   romanisation's own height when the doc carries one, so leading and row count cannot disagree. */
		line-height: var(--lyrics-row-h, 1.9em);
		max-width: 100%;
		color: rgba(255, 255, 255, 0.62); /* upcoming — must be READ, not merely sensed */
	}
	.row.past {
		color: rgba(255, 255, 255, 0.2); /* already sung — present for continuity, not for reading */
	}
	/* Inherits the row's colour transition, so it fades in step with its line rather than at one fixed brightness. */
	.romanization {
		/* The three tokens the row budget is computed from (`.viewport`), never literals of their own. */
		font-size: var(--romanization-size);
		line-height: var(--romanization-leading);
		margin-top: calc(var(--romanization-gap) * 1em);
		/* DERIVED FROM THE ROW'S INK, not an opacity on it — which is what keeps the "fades in step with its line"
		   behaviour above while making the dim a colour. As a subtree alpha it multiplied the row's own 0.62 to an
		   effective ~0.48 that no reading of either rule revealed. Still dim by design: a second script is a hint
		   under the words, not a competing line. */
		color: color-mix(in srgb, currentColor 78%, transparent);
		letter-spacing: 0.01em;
	}
	/* Covers the current line as ONE text node: under `line`/`off`, and under `word` when a poorly aligned line
	   reaches the reel with an empty `words[]` or with a `low` grade (`wipesWords`). Without this rule those cases
	   inherit `.row`'s dim. NO ACCENT here, deliberately, and it is the whole point of the `low` branch: the accent
	   (`--reel-now`) answers WHERE the singer is, and a row that reaches this branch is one nothing can say that
	   about. `hl-line` overrides the colour below because there the accent is a per-LINE answer. */
	.row.current {
		color: var(--reel-current);
	}
	/* THE CHORUS (proposal 38): the room's colour in place of white, at the same levels, so its shape shows as it
	   scrolls in. `--reel-now` and the ball are left alone: the singer, or their duet part, still leads the wipe.
	   Colour only, so nothing moves. */
	.row.chorus {
		position: relative;
		--reel-current: var(--reel-room);
		--reel-ahead: color-mix(in srgb, var(--reel-room) 66%, transparent);
		color: color-mix(in srgb, var(--reel-room) 62%, transparent);
	}
	.row.chorus.past {
		color: color-mix(in srgb, var(--reel-room) 20%, transparent);
	}
	.row.chorus.current {
		color: var(--reel-current);
	}
	/* Centred in the leading between this row and the one above, at the second script's size. */
	.everyone {
		position: absolute;
		top: 0;
		left: 50%;
		transform: translate(-50%, -50%);
		font-size: var(--romanization-size);
		line-height: 1;
		letter-spacing: 0.04em;
		color: var(--reel-room);
		opacity: 0;
		pointer-events: none;
	}
	.everyone.on {
		opacity: 1;
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
	   the same dot as `bounce` with no animation — not a separate glyph, only the movement differs. DRAWN, not a `●`:
	   the TV draws no sign outside ASCII (stage-words.test.ts). The box is where the old glyph's ink sat. */
	.ball.bounce,
	.ball.steady {
		top: 0.55em;
		width: 0.94em;
		height: 0.94em;
		border-radius: 50%;
		background: var(--accent2);
		transform: translateX(-50%);
		font-size: 0.5em;
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
	/* EVERY ANIMATION ON THIS OVERLAY, in one opt-in block — none of it is declared-then-reset, so there is no
	   `none` reset for a later rule to out-cascade and hand motion back to a room that asked for none. `color` is
	   animatable per the rule, so the two ink sweeps need the gate as much as the reel's transform does. What
	   Reduce Motion gets: the highlight still moves word to word and the reel still moves line to line, both
	   stepping instead of gliding, and `bounce` is the `steady` dot — the mark stays, only the movement goes. */
	@media (prefers-reduced-motion: no-preference) {
		.row {
			transition: color 0.3s ease;
		}
		.word {
			transition: color var(--motion-fast) linear;
		}
		.everyone {
			transition: opacity var(--motion-base) ease;
		}
		/* The line-to-line transform slides the WHOLE full-width column — the most vestibular-triggering motion on
		   the TV, and the one this gate matters most for. */
		.reel {
			transition: transform 0.42s cubic-bezier(0.22, 0.9, 0.24, 1);
		}
		.ball.bounce {
			animation: bounce 0.5s ease-in-out infinite alternate;
		}
		/* The reel ARRIVES rather than cuts in, whenever it mounts: on /tv that is a song coming on, and after a handoff
		   card only once the card has faded out, so the card's words and the song's never share a frame. Opacity only.
		   `--motion-fast`: the first line has to be readable within ~100 ms of when it was with no fade at all. */
		.lyrics {
			animation: lyrics-arrive var(--motion-fast) ease-out both;
		}
		/* A row a lyrics fix rewrote fades its new words in. Opacity only, so the reel does not move. */
		.row.fresh {
			animation: lyrics-arrive var(--motion-base) ease-out both;
		}
	}
	@keyframes lyrics-arrive {
		from {
			opacity: 0;
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
