<script lang="ts">
	// Component preview (dev-only gallery). Not a product surface.
	import SongRow from '$lib/components/SongRow.svelte';
	import QueueRow from '$lib/components/QueueRow.svelte';
	import ProcessingCard from '$lib/components/ProcessingCard.svelte';
	import GuidingTrack from '$lib/components/GuidingTrack.svelte';
	import LyricsOverlay from '$lib/tv/LyricsOverlay.svelte';
	import { LYRICS_BALL_STYLES, LYRICS_HIGHLIGHTS } from '@encore/shared';
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

	// Demo: a word-timed fixture + an auto-advancing position so the karaoke sweep is visible
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
	/*
	 * A SHORT-line variant, for the row-count cards only.
	 *
	 * The real demo lines wrap to two visual lines at gallery width, which doubles a row's height and
	 * makes "how many rows are showing" impossible to read off a frame — the one thing those cards
	 * exist to show. Two words per line cannot wrap, so a row is one line and the count is countable.
	 */
	const demoShort: LyricsDoc = {
		language: 'en',
		lines: demoLyrics.lines.map((l) => {
			const words = l.words.slice(0, 2);
			return { ...l, words, text: words.map((w) => w.word).join(' ') || l.text };
		}),
		words: []
	};
	let demoPos = $state(0);
	onMount(() => {
		const t0 = performance.now();
		let raf = 0;
		const loop = () => {
			const elapsed = (performance.now() - t0) / 1000;
			demoPos = elapsed % 18; // loop 0→18s across all six demo lines
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	});
</script>

<main style="padding:14px 16px 200px;">
	<h2 style="font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);">SongRow · the readiness axis</h2>
	<!--
		One row shape, three states. Thumbnails are the DERIVED i.ytimg mqdefault URL (see
		ytThumbnailUrl), served through /api/thumb — so on a box with no route to the internet these
		render the gradient placeholder rather than a broken image, which is itself worth seeing here.
	-->
	<SongRow title="a-ha - Take On Me (Official Video)" artistCanonical="a-ha" artist="a-ha" readiness="ready"
		thumbnail="https://i.ytimg.com/vi/djV11Xbc914/mqdefault.jpg" durationSec={225} viewCount={1892000000} />
	<SongRow title="a-ha - Take On Me (Official Video)" artistCanonical="a-ha" artist="a-ha" readiness="ready" inQueue
		thumbnail="https://i.ytimg.com/vi/djV11Xbc914/mqdefault.jpg" durationSec={225} viewCount={1892000000} />
	<SongRow title="Queen — Bohemian Rhapsody (Sub. Español / Lyrics)"
		artistCanonical="Queen" artist="Richie Lyrics" readiness="cooking"
		thumbnail="https://i.ytimg.com/vi/AlmHSUirAOs/mqdefault.jpg" durationSec={358} viewCount={265947}
		pct={68} etaSec={70} />
	<SongRow title="The Killers - Mr. Brightside" artistCanonical="The Killers" artist="TheKillersMusic" readiness="unacquired" onmake={() => {}}
		thumbnail="https://i.ytimg.com/vi/gGdGFtwCNBE/mqdefault.jpg" durationSec={228} viewCount={648760065} />

	<h2 style="font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);margin-top:18px;">SongRow · telling one song's uploads apart</h2>
	<!--
		The reason this row exists, as real yt-dlp results for one query. Under the old one-line row all
		six read as the same song: the version marker was truncated, there was no duration, and the
		thumbnail was a grey gradient. Rows 5 and 6 are a movie trailer and a 22-minute concert rip.
	-->
	<SongRow title="Queen – Bohemian Rhapsody (Official Video Remastered)"
		artistCanonical="Queen" artist="Queen Official" readiness="unacquired"
		thumbnail="https://i.ytimg.com/vi/fJ9rUzIMcZQ/mqdefault.jpg" durationSec={360} viewCount={2093310583} onmake={() => {}} />
	<SongRow title="Queen - Bohemian Rhapsody (Lyrics)"
		artistCanonical="Queen" artist="Vibe Tracks" readiness="unacquired"
		thumbnail="https://i.ytimg.com/vi/Vsum-2Cs2gI/mqdefault.jpg" durationSec={361} viewCount={3105203} onmake={() => {}} />
	<SongRow title="Queen - Bohemian Rhapsody (Live Aid 1985)"
		artistCanonical="Queen" artist="Live Aid and Queen Official" readiness="unacquired"
		thumbnail="https://i.ytimg.com/vi/vbvyNnw8Qjg/mqdefault.jpg" durationSec={165} viewCount={306017891} onmake={() => {}} />
	<SongRow title="Bohemian Rhapsody | Official Trailer [HD] | 20th Century FOX" artist="20th Century Studios" readiness="unacquired"
		thumbnail="https://i.ytimg.com/vi/mP0VHJYFOAU/mqdefault.jpg" durationSec={151} viewCount={40878083} onmake={() => {}} />
	<SongRow title="Bohemian Rhapsody 2018 BONUS Complete Live Aid Performance 1080p BluRay" artist="Rulli Haerul" readiness="unacquired"
		thumbnail="https://i.ytimg.com/vi/QXbqiAZgeCE/mqdefault.jpg" durationSec={1316} viewCount={7866057} onmake={() => {}} />
	<!-- No thumbnail, no duration, no views — a local library file. Must degrade, not break. -->
	<SongRow title="A local file with no metadata at all" readiness="unacquired" onmake={() => {}} />

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

	<h2 style="font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);margin-top:18px;">GuidingTrack · every state</h2>
	<!-- Off (the shipped default), a faint guide, halfway, full sing-along, the pinned-override hint,
	     and unavailable because the song has no isolated vocals stem. -->
	<div style="display:grid;gap:14px;">
		<GuidingTrack pct={0} available={true} />
		<GuidingTrack pct={15} available={true} />
		<GuidingTrack pct={60} available={true} />
		<GuidingTrack pct={100} available={true} />
		<GuidingTrack pct={40} available={true} pinned={true} roomDefaultPct={15} />
		<GuidingTrack pct={0} available={false} />
	</div>

	<h2 style="font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);margin-top:18px;">LyricsOverlay (TV) · VERIFIED text</h2>
	<div style="position:relative;height:280px;border-radius:16px;overflow:hidden;background:radial-gradient(120% 90% at 50% 20%, #241a3d, #0b0b12);">
		<LyricsOverlay doc={demoLyrics} positionSec={demoPos} playing visible
			provenance={{ textSource: 'lrclib', textConfidence: 'high', timing: 'word' }} />
	</div>

	<!-- The same doc, same perfect sweep, but the words are a GUESS. The pair is the point —
	     without the caption these two are visually indistinguishable, which is exactly the problem. -->
	<h2 style="font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);margin-top:18px;">LyricsOverlay · AUTO-TRANSCRIBED</h2>
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

	<!--
		Every room-selectable treatment, on one doc, at ONE PINNED position. Side by side is the only way
		to judge these: the difference between a bouncing and a steady dot is motion, and between word and
		line highlighting is what a patchy artifact does to each.

		`playing={false}` and a fixed position are load-bearing, not laziness. The demo clock above loops
		0→18s, so with it running each card renders a different moment and the variants are not comparable
		— and a screenshot lands wherever the rAF happened to be. Pinned at 0.8s (+0.3s default lead =
		1.1s) "the" is mid-word, so one frame shows all three word states at once: "Is"/"this" sung,
		"the" current, "real"/"life" still ahead.

		These cards are TALLER than the ones above because the reel is 9.5em of a clamp()-scaled font —
		around 470px here. At 280px the card clipped it and hid the centred current row, which is the row
		these variants exist to show.
	-->
	{#each LYRICS_BALL_STYLES as s (s.id)}
		<h2 style="font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);margin-top:18px;">LyricsOverlay · marker: {s.label}</h2>
		<div style="position:relative;height:500px;border-radius:16px;overflow:hidden;background:radial-gradient(120% 90% at 50% 20%, #241a3d, #0b0b12);">
			<LyricsOverlay doc={demoLyrics} positionSec={0.8} playing={false} visible ball={s.id} highlight="word"
				provenance={{ textSource: 'lrclib', textConfidence: 'high', timing: 'word' }} />
		</div>
	{/each}

	{#each LYRICS_HIGHLIGHTS as h (h.id)}
		<h2 style="font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);margin-top:18px;">LyricsOverlay · highlight: {h.label}</h2>
		<div style="position:relative;height:500px;border-radius:16px;overflow:hidden;background:radial-gradient(120% 90% at 50% 20%, #241a3d, #0b0b12);">
			<LyricsOverlay doc={demoLyrics} positionSec={0.8} playing={false} visible ball="off" highlight={h.id}
				provenance={{ textSource: 'lrclib', textConfidence: 'high', timing: 'word' }} />
		</div>
	{/each}

	<!--
		The TYPE settings. These cards are chosen for what a STILL frame can actually prove: a size
		extreme, an asymmetric row count, a case transform and a font swap all show up in one shot,
		whereas the marker variants needed motion. Each holds every other knob at its default so one
		card demonstrates one thing.

		Row-count cards carry their own height, because the reel's height is now DERIVED from the count —
		a fixed 500px box would clip the 7-row case and hide exactly what it is meant to show.

		The demo doc has SIX lines, so the largest reels reserve rows the song cannot fill: at 4 lines
		after, a current line near the end shows empty space below rather than four lyrics. That is the
		doc's limit, not the reel's — the exact row counts and offsets are asserted numerically against
		the DOM rather than read off these frames.
	-->
	{#each [
		{ what: 'size 80% (the legibility floor)', props: { scalePct: 80 }, h: 500, short: false },
		{ what: 'size 160% (the ceiling)', props: { scalePct: 160 }, h: 760, short: false },
		{ what: 'case ALL CAPS — note the extra wrapping', props: { textCase: 'upper' as const }, h: 500, short: false },
		{ what: 'case all lowercase', props: { textCase: 'lower' as const }, h: 500, short: false },
		{ what: 'font serif', props: { font: 'serif' as const }, h: 500, short: false },
		{ what: 'font monospace — fewest words per row', props: { font: 'mono' as const }, h: 500, short: false },
		{ what: 'rows 0 before / 2 after — no history', props: { linesBefore: 0, linesAfter: 2 }, h: 460, short: true },
		{ what: 'rows 2 before / 0 after — nothing revealed ahead', props: { linesBefore: 2, linesAfter: 0 }, h: 460, short: true },
		{ what: 'rows 2 before / 2 after — the default, for comparison', props: { linesBefore: 2, linesAfter: 2 }, h: 700, short: true },
		{ what: 'rows 1 before / 4 after — asymmetric, current line sits high', props: { linesBefore: 1, linesAfter: 4 }, h: 820, short: true },
		{ what: 'rows 3 before / 4 after — the maximum reel', props: { linesBefore: 3, linesAfter: 4 }, h: 1080, short: true }
	] as c (c.what)}
		<h2 style="font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);margin-top:18px;">LyricsOverlay · {c.what}</h2>
		<div style="position:relative;height:{c.h}px;border-radius:16px;overflow:hidden;background:radial-gradient(120% 90% at 50% 20%, #241a3d, #0b0b12);">
			<!--
				9.5s puts the current line at index 3 of 6, so there are three lines BEFORE it and two
				after. Pinning at 0.8s (as the marker cards do) sits on line 0, where "2 lines before" has
				nothing to show and the card proves nothing — which is exactly how it read first time.
			-->
			<LyricsOverlay doc={c.short ? demoShort : demoLyrics} positionSec={9.5} playing={false} visible highlight="word" ball="bounce"
				provenance={{ textSource: 'lrclib', textConfidence: 'high', timing: 'word' }} {...c.props} />
		</div>
	{/each}

	<h2 style="font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);margin-top:18px;">TV room states · lobby + corner join card</h2>
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
		<JoinBadge qrDataUrl={demoQr} joinUrl="encore.local/join" placement="corner" onlineCount={4} />
	</div>
</main>
