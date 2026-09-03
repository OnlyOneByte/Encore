<script lang="ts">
	// M8-C2 — aligned lyrics overlay for the TV. Fetches the word-timed artifact (M7-C8) referenced
	// by the current media and highlights each word in time as a classic karaoke sweep with a
	// bouncing ball over the word being sung. The authoritative position arrives from the player
	// (~4Hz via ontimeupdate); we interpolate it with requestAnimationFrame for a smooth 60fps sweep.
	import {
		parseLyricsDoc,
		activeLineIndex,
		activeWordIndex,
		lyricsNotice,
		isAutoTranscribed,
		type LyricsDoc,
		type LyricsProvenance
	} from './lyrics';

	interface Props {
		lyricsRef?: string; // MediaStore key of the lyrics JSON on the current media
		doc?: LyricsDoc | null; // pre-parsed lyrics (dev gallery / tests); bypasses the fetch when set
		positionSec: number; // authoritative playback position (from TvPlayer telemetry)
		playing?: boolean; // interpolate forward only while actually playing
		visible?: boolean; // hide during attract/interstitial
		/**
		 * Where this text came from (B-3-C6) — `chosenCandidate(media)` on the TV route. Drives the
		 * auto-transcribed caption. Absent/null means provenance is UNKNOWN (a pre-candidate artifact),
		 * which is rendered exactly like verified text: we will not assert either way.
		 */
		provenance?: LyricsProvenance | null;
	}
	let {
		lyricsRef,
		doc: docProp,
		positionSec,
		playing = true,
		visible = true,
		provenance = null
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

	const lineIdx = $derived(doc ? activeLineIndex(doc.lines, displayPos) : -1);
	const curLine = $derived(doc && lineIdx >= 0 ? doc.lines[lineIdx] : null);
	const nextLine = $derived(
		doc && lineIdx >= 0 && lineIdx + 1 < doc.lines.length ? doc.lines[lineIdx + 1] : null
	);
	const ballWord = $derived(curLine ? activeWordIndex(curLine, displayPos) : -1);
	const show = $derived(visible && !!curLine);
	const notice = $derived(lyricsNotice(provenance));
	const unverified = $derived(isAutoTranscribed(provenance));
</script>

{#if show && curLine}
	<div class="lyrics" class:unverified role="presentation">
		<div class="line current">
			{#if curLine.words.length}
				{#each curLine.words as w, i (i)}
					<span
						class="word"
						class:done={displayPos >= w.end}
						class:active={i === ballWord}
					>
						{#if i === ballWord}<span class="ball" aria-hidden="true">●</span>{/if}{w.word}
					</span>{' '}
				{/each}
			{:else}
				<!-- line-sync fallback (no per-word timings): light the whole line while it's active -->
				<span class="word done">{curLine.text}</span>
			{/if}
		</div>
		{#if nextLine}
			<div class="line next">{nextLine.text}</div>
		{/if}
		{#if notice}
			<!-- Small and permanent rather than a one-off toast: a singer who glances up mid-song still
			     needs to know these words are a guess. -->
			<div class="notice">{notice}</div>
		{/if}
	</div>
{/if}

<style>
	.lyrics {
		/* CENTRED, not bottom-anchored. A cooked song plays an instrumental with no picture to avoid
		   covering, so lyrics belong in the middle of the screen where they read from across a room;
		   `bottom: 14%` left them crowding the lower-third and the join card. `inset` + flex centering
		   keeps a wrapped 2-line lyric visually centred instead of growing downward off-balance. */
		position: absolute;
		inset: 0;
		z-index: 6;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.7em;
		padding: 0 6%;
		text-align: center;
		pointer-events: none;
		text-shadow: 0 2px 18px rgba(0, 0, 0, 0.85);
	}
	/* Unverified text is set in italic — a persistent, glanceable signal that costs no space and does
	   not compete with the sweep. Deliberately NOT dimmed: these are still the words to sing from, so
	   making them harder to read would punish the singer for a provenance problem. */
	.lyrics.unverified .line.current { font-style: italic; }
	/*
	 * Pinned to the BOTTOM EDGE and sized in rem.
	 *
	 * It was `0.30em` sitting directly under the lyrics, and em here resolves against .lyrics (1rem),
	 * NOT the 3.6rem lyric — so it rendered at ~5px and was genuinely unreadable on a TV across a room.
	 * A warning nobody can read is worse than none: it looks like diligence while informing no one.
	 * Bottom-centre is deliberate — the lower-third owns bottom-left and the join card bottom-right, so
	 * this is the one free edge, and it keeps the notice out of the sung text's way.
	 */
	.notice {
		position: absolute;
		bottom: 4%;
		left: 0;
		right: 0;
		font-size: 1.15rem;
		font-weight: 600;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.72);
		font-style: normal;
	}
	.line {
		/*
		 * Loose leading is LOAD-BEARING, not decoration: the bouncing ball is absolutely positioned
		 * above its word, so at tight leading it landed on top of the previous WRAPPED line ("this" in
		 * "Is this the"). Long lyric lines wrap often, so the clearance has to come from the line box
		 * itself — a gap between the current/next blocks does nothing for a wrap inside one line.
		 * Verified by measuring ball vs word rects, not by eye.
		 */
		line-height: 1.9;
		max-width: 90%;
	}
	.current {
		font-size: 3.6rem;
		font-weight: 800;
	}
	.next {
		font-size: 1.9rem;
		font-weight: 700;
		color: rgba(255, 255, 255, 0.42);
	}
	.word {
		position: relative;
		display: inline-block;
		color: rgba(255, 255, 255, 0.4); /* not yet sung */
		transition: color 0.12s linear;
	}
	.word.done {
		color: #fff; /* sung */
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
		color: var(--accent2, #ff5cae);
	}
	.ball {
		position: absolute;
		top: -0.85em;
		left: 50%;
		transform: translateX(-50%);
		font-size: 0.5em;
		color: var(--accent2, #7cf);
		animation: bounce 0.5s ease-in-out infinite alternate;
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
