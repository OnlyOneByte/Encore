<script lang="ts">
	// M8-C2 — aligned lyrics overlay for the TV. Fetches the word-timed artifact (M7-C8) referenced
	// by the current media and highlights each word in time as a classic karaoke sweep with a
	// bouncing ball over the word being sung. The authoritative position arrives from the player
	// (~4Hz via ontimeupdate); we interpolate it with requestAnimationFrame for a smooth 60fps sweep.
	import {
		parseLyricsDoc,
		activeLineIndex,
		activeWordIndex,
		wordFill,
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
						style={i === ballWord ? `--fill:${(wordFill(w, displayPos) * 100).toFixed(1)}%` : ''}
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
		position: absolute;
		left: 0;
		right: 0;
		bottom: 14%;
		z-index: 6;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.4em;
		padding: 0 6%;
		text-align: center;
		pointer-events: none;
		text-shadow: 0 2px 18px rgba(0, 0, 0, 0.85);
	}
	/* Unverified text is set in italic — a persistent, glanceable signal that costs no space and does
	   not compete with the sweep. Deliberately NOT dimmed: these are still the words to sing from, so
	   making them harder to read would punish the singer for a provenance problem. */
	.lyrics.unverified .line.current { font-style: italic; }
	.notice {
		font-size: 0.30em;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.55);
		font-style: normal;
	}
	.line {
		line-height: 1.15;
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
		transition: color 0.08s linear;
	}
	.word.done {
		color: #fff; /* fully sung */
	}
	.word.active {
		/* left-to-right sweep: bright up to --fill, dim after — the karaoke wipe */
		background: linear-gradient(90deg, var(--accent2, #7cf) var(--fill), rgba(255, 255, 255, 0.4) var(--fill));
		background-clip: text;
		-webkit-background-clip: text;
		color: transparent;
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
