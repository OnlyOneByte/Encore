<script lang="ts">
	// M3-C1 component preview (dev-only gallery). Not a product surface.
	import SongRow from '$lib/components/SongRow.svelte';
	import QueueRow from '$lib/components/QueueRow.svelte';
	import ProcessingCard from '$lib/components/ProcessingCard.svelte';
	import NowPlaying from '$lib/components/NowPlaying.svelte';
	import LyricsOverlay from '$lib/tv/LyricsOverlay.svelte';
	import ScoreBadge from '$lib/tv/ScoreBadge.svelte';
	import TvLobby from '$lib/tv/TvLobby.svelte';
	import JoinBadge from '$lib/tv/JoinBadge.svelte';

	// A tiny inline QR stand-in for the gallery — the real one is generated server-side per room.
	const demoQr =
		'data:image/svg+xml;utf8,' +
		encodeURIComponent(
			`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" shape-rendering="crispEdges">` +
				`<rect width="64" height="64" fill="#fff"/>` +
				[...Array(64)]
					.map((_, i) => {
						const x = i % 8;
						const y = Math.floor(i / 8);
						// deterministic checker-ish blocks so it reads as a QR without pretending to scan
						return (x * 7 + y * 13) % 3 === 0 ? `<rect x="${x * 8}" y="${y * 8}" width="8" height="8" fill="#0b0b12"/>` : '';
					})
					.join('') +
				`</svg>`
		);
	import type { LyricsDoc } from '$lib/tv/lyrics';
	import { onMount } from 'svelte';

	// M8-C2 demo: a word-timed fixture + an auto-advancing position so the karaoke sweep is visible
	// here in the dev gallery (the real /tv route feeds position from player telemetry).
	const demoLyrics: LyricsDoc = {
	  "language": "en",
	  "lines": [
	    {
	      "start": 0.0,
	      "end": 2.6,
	      "text": "Is this the real life",
	      "words": [
	        {
	          "word": "Is",
	          "start": 0.0,
	          "end": 0.408
	        },
	        {
	          "word": "this",
	          "start": 0.48,
	          "end": 0.888
	        },
	        {
	          "word": "the",
	          "start": 0.96,
	          "end": 1.368
	        },
	        {
	          "word": "real",
	          "start": 1.44,
	          "end": 1.848
	        },
	        {
	          "word": "life",
	          "start": 1.92,
	          "end": 2.328
	        }
	      ]
	    },
	    {
	      "start": 3.0,
	      "end": 5.6,
	      "text": "Is this just fantasy",
	      "words": [
	        {
	          "word": "Is",
	          "start": 3.0,
	          "end": 3.51
	        },
	        {
	          "word": "this",
	          "start": 3.6,
	          "end": 4.11
	        },
	        {
	          "word": "just",
	          "start": 4.2,
	          "end": 4.71
	        },
	        {
	          "word": "fantasy",
	          "start": 4.8,
	          "end": 5.31
	        }
	      ]
	    },
	    {
	      "start": 6.0,
	      "end": 8.6,
	      "text": "Caught in a landslide",
	      "words": [
	        {
	          "word": "Caught",
	          "start": 6.0,
	          "end": 6.51
	        },
	        {
	          "word": "in",
	          "start": 6.6,
	          "end": 7.11
	        },
	        {
	          "word": "a",
	          "start": 7.2,
	          "end": 7.71
	        },
	        {
	          "word": "landslide",
	          "start": 7.8,
	          "end": 8.31
	        }
	      ]
	    },
	    {
	      "start": 9.0,
	      "end": 11.6,
	      "text": "No escape from reality",
	      "words": [
	        {
	          "word": "No",
	          "start": 9.0,
	          "end": 9.51
	        },
	        {
	          "word": "escape",
	          "start": 9.6,
	          "end": 10.11
	        },
	        {
	          "word": "from",
	          "start": 10.2,
	          "end": 10.71
	        },
	        {
	          "word": "reality",
	          "start": 10.8,
	          "end": 11.31
	        }
	      ]
	    },
	    {
	      "start": 12.0,
	      "end": 14.6,
	      "text": "Open your eyes",
	      "words": [
	        {
	          "word": "Open",
	          "start": 12.0,
	          "end": 12.68
	        },
	        {
	          "word": "your",
	          "start": 12.8,
	          "end": 13.48
	        },
	        {
	          "word": "eyes",
	          "start": 13.6,
	          "end": 14.28
	        }
	      ]
	    },
	    {
	      "start": 15.0,
	      "end": 17.6,
	      "text": "Look up to the skies and see",
	      "words": [
	        {
	          "word": "Look",
	          "start": 15.0,
	          "end": 15.291
	        },
	        {
	          "word": "up",
	          "start": 15.343,
	          "end": 15.634
	        },
	        {
	          "word": "to",
	          "start": 15.686,
	          "end": 15.977
	        },
	        {
	          "word": "the",
	          "start": 16.029,
	          "end": 16.32
	        },
	        {
	          "word": "skies",
	          "start": 16.371,
	          "end": 16.663
	        },
	        {
	          "word": "and",
	          "start": 16.714,
	          "end": 17.006
	        },
	        {
	          "word": "see",
	          "start": 17.057,
	          "end": 17.349
	        }
	      ]
	    }
	  ],
	  "words": []
	};

	// The line-sync floor: same lines, no per-word timings — what an un-alignable LRC renders as.
	const demoLineOnly: LyricsDoc = {
		language: 'en',
		lines: demoLyrics.lines.map((l) => ({ ...l, words: [] })),
		words: []
	};
	let demoPos = $state(0);
	let demoScore = $state(0); // sweeps 0→100 so the badge moves through all bands (M8-C3 eyes-on)
	onMount(() => {
		const t0 = performance.now();
		let raf = 0;
		const loop = () => {
			const elapsed = (performance.now() - t0) / 1000;
			demoPos = elapsed % 18; // loop 0→18s across all six demo lines
			demoScore = Math.round(((elapsed % 10) / 10) * 100); // 0→100 over 10s
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	});
</script>

<main style="padding:14px 16px 200px;">
	<h2 style="font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);">SongRow · the readiness axis</h2>
	<!-- One row shape, three states. The sub-line's job is to answer "what do I get if I tap this?" -->
	<SongRow title="Take On Me" artist="a-ha" readiness="ready" />
	<SongRow title="Take On Me" artist="a-ha" readiness="ready" inQueue />
	<SongRow title="Bohemian Rhapsody" artist="Queen" readiness="cooking" pct={68} etaSec={70} />
	<SongRow title="Mr. Brightside" artist="The Killers" readiness="raw" onmake={() => {}} />

	<h2 style="font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);margin-top:18px;">QueueRow</h2>
	<QueueRow seq={1} title="Take On Me" singerName="Sam" singerColor="#33d6a6" up subtitle="now playing" />
	<QueueRow seq={3} title="Dancing Queen" singerName="You" singerColor="#ff5cae" mine subtitle="after Liam" />
	<QueueRow seq={4} title="Sweet Caroline" singerName="Liam" singerColor="#5cb8ff" />
	<QueueRow seq={5} title="Wonderwall" singerName="You" singerColor="#ff5cae" mine pending />

	<h2 style="font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);margin-top:18px;">ProcessingCard</h2>
	<ProcessingCard seq={2} title="Bohemian Rhapsody" singerName="You" singerColor="#ff5cae" status="separating" pct={68} />

	<!-- A cooking song is still a queue entry, so it carries the SAME controls as a ready row. Paired
	     with the QueueRow below deliberately: the two ↑↓✕ groups must line up, so a song finishing its
	     cook doesn't visually reshuffle its own buttons. -->
	<ProcessingCard
		seq={3} title="Toto - Africa (Lyrics)" singerName="You" singerColor="#ff5cae"
		status="separating" pct={16}
		reorderable canUp canDown onremove={() => {}} onup={() => {}} ondown={() => {}}
	/>
	<QueueRow
		seq={4} title="Gwen Stefani - Rich Girl" singerName="You" singerColor="#ff5cae" mine
		subtitle="up next" removable reorderable canUp canDown
	/>

	<NowPlaying title="Take On Me" sub="a-ha · Sam is singing" />

	<h2 style="font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);margin-top:18px;">LyricsOverlay (M8-C2 · TV) · VERIFIED text</h2>
	<div style="position:relative;height:280px;border-radius:16px;overflow:hidden;background:radial-gradient(120% 90% at 50% 20%, #241a3d, #0b0b12);">
		<LyricsOverlay doc={demoLyrics} positionSec={demoPos} playing visible
			provenance={{ textSource: 'lrclib', textConfidence: 'high', timing: 'word' }} />
		<ScoreBadge score={demoScore} hits={demoScore} total={100} />
	</div>

	<!-- B-3-C6: the same doc, same perfect sweep, but the words are a GUESS. The pair is the point —
	     without the caption these two are visually indistinguishable, which is exactly the problem. -->
	<h2 style="font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);margin-top:18px;">LyricsOverlay · AUTO-TRANSCRIBED (B-3-C6)</h2>
	<div style="position:relative;height:280px;border-radius:16px;overflow:hidden;background:radial-gradient(120% 90% at 50% 20%, #241a3d, #0b0b12);">
		<LyricsOverlay doc={demoLyrics} positionSec={demoPos} playing visible
			provenance={{ textSource: 'asr', textConfidence: 'low', timing: 'word' }} />
	</div>

	<!-- The FLOOR: authoritative words, line-level timing only. Whole-line highlight, no ball. -->
	<h2 style="font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);margin-top:18px;">LyricsOverlay · LINE-SYNC floor (no word timings)</h2>
	<div style="position:relative;height:280px;border-radius:16px;overflow:hidden;background:radial-gradient(120% 90% at 50% 20%, #241a3d, #0b0b12);">
		<LyricsOverlay doc={demoLineOnly} positionSec={demoPos} playing visible
			provenance={{ textSource: 'lrclib', textConfidence: 'high', timing: 'line' }} />
	</div>

	<h2 style="font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);margin-top:18px;">TV room states (B-6) · lobby + corner join card</h2>
	<!-- The three TV surfaces, scaled down. The point of the pair is that "nobody here" and "people
	     here, nothing queued" are now DIFFERENT screens — they used to be the same one. -->
	<div style="position:relative;height:300px;border-radius:16px;overflow:hidden;background:var(--bg);">
		<TvLobby
			qrDataUrl={demoQr}
			joinUrl="encore.local/join"
			roster={[
				{ id: 'a', displayName: 'Angelo', color: '#7c5cff' },
				{ id: 'm', displayName: 'Maya', color: '#ff5cae' },
				{ id: 'd', displayName: 'Devon', color: '#33d6a6' }
			]}
			overflow={2}
		/>
	</div>
	<div style="position:relative;height:300px;margin-top:10px;border-radius:16px;overflow:hidden;background:radial-gradient(120% 90% at 50% 20%, #241a3d, #0b0b12);">
		<span style="position:absolute;inset:0;display:grid;place-items:center;font-size:.8rem;letter-spacing:.3em;text-transform:uppercase;color:rgba(255,255,255,.22);">music video</span>
		<ScoreBadge score={demoScore} hits={demoScore} total={100} />
		<JoinBadge qrDataUrl={demoQr} joinUrl="encore.local/join" placement="corner" onlineCount={4} />
	</div>

	<h2 style="font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);margin-top:18px;">Phone score pill (M8-C3)</h2>
	<div style="display:flex;justify-content:center;padding:16px;background:var(--bg);border-radius:16px;">
		<span style="display:inline-flex;align-items:center;gap:8px;font-weight:700;color:#fff;background:var(--card);border:1px solid var(--accent2);border-radius:999px;padding:10px 18px;">
			<span style="width:10px;height:10px;border-radius:50%;background:#ff5cae;"></span>
			Score <strong style="font-size:1.25rem;color:var(--accent2);font-variant-numeric:tabular-nums;">{demoScore}</strong> · {demoScore}/100 on pitch
		</span>
	</div>
</main>
