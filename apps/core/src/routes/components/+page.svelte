<script lang="ts">
	// Component preview (dev-only gallery). Not a product surface.
	import SongRow from '$lib/components/SongRow.svelte';
	import QueueRow from '$lib/components/QueueRow.svelte';
	import ProcessingCard from '$lib/components/ProcessingCard.svelte';
	import GuidingTrack from '$lib/components/GuidingTrack.svelte';
	import RangeBar from '$lib/components/RangeBar.svelte';
	import type { SongProfile } from '@encore/shared';
	import ColourPicker from '$lib/components/ColourPicker.svelte';
	import QueueSheet from '$lib/components/QueueSheet.svelte';
	import LyricsOverlay from '$lib/tv/LyricsOverlay.svelte';
	import {
		LYRICS_BALL_STYLES,
		LYRICS_HIGHLIGHTS,
		SINGER_COLORS,
		TV_VISUALIZERS,
		TV_PROGRESS_STYLES,
		DEFAULT_GLOBAL_SETTINGS,
		DEFAULT_ROOM_SETTINGS,
		resolveLyricsPresentation
	} from '@encore/shared';
	import type { LyricsCandidate } from '@encore/shared';
	import type { PublicSinger } from '@encore/shared';

	/*
	 * Fixture singer colours, taken from the shared palette by INDEX rather than retyped as hexes.
	 * These are data (a guest's chosen accent), not theme tokens -- but the literals were byte-identical
	 * to SINGER_COLORS[0..2], so a reorder of that array would have left the gallery demonstrating
	 * colours the app can no longer produce. Named so each demo reads as a different singer.
	 */
	const VIOLET = SINGER_COLORS[0];
	const PINK = SINGER_COLORS[1];
	const GREEN = SINGER_COLORS[2];
	const SKY = SINGER_COLORS[4];
	import TvLobby from '$lib/tv/TvLobby.svelte';
	import JoinBadge from '$lib/tv/JoinBadge.svelte';
	import TvProgress from '$lib/tv/TvProgress.svelte';
	import VisualizerStage from '$lib/tv/VisualizerStage.svelte';

	// The dark stage backdrop every TV overlay demo sits on, as ONE constant so the wrappers cannot
	// drift apart. It re-expresses the real stage glow (--stage-glow over --bg); tokens, not literals,
	// so it tracks a theme change the way the real .stage does.
	const stageBg = 'radial-gradient(120% 90% at 50% 20%, var(--stage-glow), var(--bg))';

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

	// Demo SongProfiles for the RangeBar gallery. A tenor-ish chorus that lives high, so the histogram
	// weight is visibly lopsided (index 0 = lowMidi = 48/C3). p05..p95 is the solid block; low/high the
	// whiskers. `keyFull` carries a detected key too, for the SongRow chip example below.
	const profileFull: SongProfile = {
		keyTonic: 7, // G
		keyMode: 'major',
		keyConfidence: 0.82,
		lowMidi: 48, // C3
		highMidi: 72, // C5
		p05Midi: 55, // G3
		p95Midi: 67, // G4
		// 25 semitones C3..C5; time piles up around the upper-middle (the chorus camps high)
		histogram: [2, 3, 4, 5, 6, 9, 14, 20, 26, 30, 28, 22, 15, 10, 7, 5, 4, 3, 2, 1, 1, 0, 0, 0, 0]
	};
	// Same range, but NO histogram — the block must degrade to a flat fill (range known, weight unknown).
	const profileNoHist: SongProfile = { ...profileFull, histogram: null };
	// A key but NO measured range (silent/instrumental vocal stem). The bar renders NOTHING.
	const profileKeyOnly: SongProfile = {
		keyTonic: 2, // D
		keyMode: 'minor',
		keyConfidence: 0.71,
		lowMidi: null,
		highMidi: null,
		p05Midi: null,
		p95Midi: null,
		histogram: null
	};

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
	 * THE LINE-ONLY SONG, as a candidate — the fixture the per-song clamp is judged against.
	 *
	 * `demoLineOnly` above is only half of a line-only song: it is the DOC, and the resolver never sees
	 * a doc. What decides the treatment is the candidate's `timing`, so a card that renders the doc
	 * while passing `highlight` by hand cannot exercise the clamp at all — which is why every card
	 * below this one was blind to the defect. The doc and the candidate must agree, and they are stated
	 * together here so they cannot drift.
	 *
	 * Both halves match what the real worker publishes, verified against the producer rather than
	 * guessed: `apps/worker/src/lyrics/source.py:line_synced_lyrics` writes lines with an EMPTY
	 * `words: []` (not an absent key), and `apps/worker/src/steps/lyrics.py:333` records
	 * `"timing": "line"` on the candidate. Checking that is not optional ceremony — a fixture in this
	 * repo once published `startSec`/`endSec` where the parser reads `start`/`end` and manufactured a
	 * false CRITICAL against a working overlay (fixed in c544f46).
	 */
	const lineOnlyCandidate: LyricsCandidate = {
		ref: 'derived/lyrics/demo.lrclib.line.json',
		textSource: 'lrclib',
		timing: 'line',
		textConfidence: 'high',
		createdAt: 0
	};
	/*
	 * A stock deployment: the default word-level `syncMode` and the default word-level room treatment.
	 * Held as the DEFAULTS rather than literals so this card keeps demonstrating what a fresh install
	 * actually does after a defaults change, instead of a combination nobody ships.
	 */
	const wordLevelDeployment = { global: DEFAULT_GLOBAL_SETTINGS, room: DEFAULT_ROOM_SETTINGS };
	// Ask the SAME resolver the TV asks. Passing `highlight`/`ball` by hand here would make the card a
	// picture of a decision rather than a test of one, and the decision is the thing that was wrong.
	const lineOnlyResolved = $derived(resolveLyricsPresentation(wordLevelDeployment, lineOnlyCandidate.timing));
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
			demoPos = elapsed % 18; // loop 0-18s across all six demo lines
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	});

	// FIXTURE: a stand-in singer for the profile sheet — this is DATA, not styling. The colour is a
	// singer's chosen accent, deliberately a literal.
	const demoSinger: PublicSinger = {
		id: 'demo',
		displayName: 'Dana',
		color: PINK,
		joinedAt: Date.now()
	};

	// The picker and the sheet are bindable/stateful. Keep the gallery interactive so their real
	// behaviour (preset-vs-slider agreement, open/close, drag) can be exercised, not just posed. The
	// sheet defaults CLOSED so it does not cover the gallery it is being reviewed in — the toggle
	// button opens it on demand instead.
	let demoColour = $state(VIOLET);
	let queueOpen = $state(false);
</script>

<main style="padding:14px 16px 200px;">
	<h2 class="section">SongRow · the readiness axis</h2>
	<!--
		One row shape, three states. Thumbnails are the DERIVED i.ytimg mqdefault URL (see
		ytThumbnailUrl), served through /api/thumb — so on a box with no route to the internet these
		render the gradient placeholder rather than a broken image, which is itself worth seeing here.
	-->
	<SongRow title="a-ha - Take On Me (Official Video)" artistCanonical="a-ha" artist="a-ha" readiness="ready"
		thumbnail="https://i.ytimg.com/vi/djV11Xbc914/mqdefault.jpg" durationSec={225} viewCount={1892000000} />
	<SongRow title="a-ha - Take On Me (Official Video)" artistCanonical="a-ha" artist="a-ha" readiness="ready" inQueue
		thumbnail="https://i.ytimg.com/vi/djV11Xbc914/mqdefault.jpg" durationSec={225} viewCount={1892000000} />
	<!-- Ready row carrying a detected KEY chip (the chip is ready-only; a cooking/raw row never shows it). -->
	<SongRow title="Journey - Don't Stop Believin' (Official Video)" artistCanonical="Journey" artist="Journey" readiness="ready"
		thumbnail="https://i.ytimg.com/vi/1k8craCGpgs/mqdefault.jpg" durationSec={251} viewCount={789000000} keyName="E major" />
	<SongRow title="Queen — Bohemian Rhapsody (Sub. Español / Lyrics)"
		artistCanonical="Queen" artist="Richie Lyrics" readiness="cooking"
		thumbnail="https://i.ytimg.com/vi/AlmHSUirAOs/mqdefault.jpg" durationSec={358} viewCount={265947}
		pct={68} etaSec={70} />
	<SongRow title="The Killers - Mr. Brightside" artistCanonical="The Killers" artist="TheKillersMusic" readiness="unacquired" onmake={() => {}}
		thumbnail="https://i.ytimg.com/vi/gGdGFtwCNBE/mqdefault.jpg" durationSec={228} viewCount={648760065} />

	<h2 class="section">SongRow · telling one song's uploads apart</h2>
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

	<h2 class="section">QueueRow</h2>
	<!-- singerColor values here are FIXTURE data — each is a singer's chosen accent standing in for a
	     person, not a theme token (some equal --accent2, but they mean "this singer's colour"). -->
	<QueueRow seq={1} title="Take On Me" singerName="Sam" singerColor={GREEN} up subtitle="now playing" />
	<QueueRow seq={3} title="Dancing Queen" singerName="You" singerColor={PINK} mine subtitle="after Liam" />
	<QueueRow seq={4} title="Sweet Caroline" singerName="Liam" singerColor="#5cb8ff" />
	<QueueRow seq={5} title="Wonderwall" singerName="You" singerColor={PINK} mine pending />

	<h2 class="section">ProcessingCard</h2>
	<ProcessingCard seq={2} title="Bohemian Rhapsody" singerName="You" singerColor={PINK} status="separating" pct={68} />

	<!-- The bug this fixed: an early stage (downloading) at pct=100. Old code filled the bar solid and
	     read 100%; overallCookPct maps it to the downloading band top (20%), so this card is the one that
	     makes the fix self-evident to a human eyes-on. -->
	<ProcessingCard seq={2} title="Africa (downloading complete)" singerName="You" singerColor={PINK} status="downloading" pct={100} />

	<!-- A cooking song is still a queue entry, so it carries the SAME controls as a ready row. Paired
	     with the QueueRow below deliberately: the two reorder/remove button groups must line up, so a
	     song finishing its cook doesn't visually reshuffle its own buttons. -->
	<ProcessingCard
		seq={3} title="Toto - Africa (Lyrics)" singerName="You" singerColor={PINK}
		status="separating" pct={16}
		reorderable canUp canDown onremove={() => {}} onup={() => {}} ondown={() => {}}
	/>
	<QueueRow
		seq={4} title="Gwen Stefani - Rich Girl" singerName="You" singerColor={PINK} mine
		subtitle="up next" removable reorderable canUp canDown
	/>

	<h2 class="section">GuidingTrack · every state</h2>
	<!-- Off (the shipped default), a faint guide, halfway, full sing-along, and unavailable because the
	     song has no isolated vocals stem. There is no longer a pinned-override variant: the
	     override-vs-room-default hint was removed, so that card rendered identically to `pct={40}`. -->
	<div style="display:grid;gap:14px;">
		<GuidingTrack pct={0} available={true} />
		<GuidingTrack pct={15} available={true} />
		<GuidingTrack pct={60} available={true} />
		<GuidingTrack pct={100} available={true} />
		<GuidingTrack pct={0} available={false} />
	</div>

	<h2 class="section">RangeBar · every state</h2>
	<!--
		The vocal-range bar in each state it must survive. Rendered on a card so the token colours match
		the sheet body it lives in on the phone. Each is captioned with what it proves, because several
		of these states render NOTHING and a blank space is only correct if you know it is meant to be
		blank.
	-->
	<div style="display:grid;gap:16px;">
		<div>
			<p class="caption">Full range + histogram (chorus lives high)</p>
			<RangeBar profile={profileFull} />
		</div>
		<div>
			<p class="caption">Full range, NO histogram (flat block)</p>
			<RangeBar profile={profileNoHist} />
		</div>
		<div>
			<p class="caption">Shifted +5 semitones (block + weight slide right)</p>
			<RangeBar profile={profileFull} keyShift={5} />
		</div>
		<div>
			<p class="caption">Shifted −5 semitones (slides left)</p>
			<RangeBar profile={profileFull} keyShift={-5} />
		</div>
		<div>
			<p class="caption">Key only, no range: renders nothing (blank on purpose)</p>
			<RangeBar profile={profileKeyOnly} />
		</div>
		<div>
			<p class="caption">No profile: renders nothing (blank on purpose)</p>
			<RangeBar profile={null} />
		</div>
	</div>

	<h2 class="section">ColourPicker · presets plus hue wheel</h2>
	<!-- The identity picker, extracted from /join and reused by the settings You tab. Bound to live
	     state so the preset-vs-slider agreement (picking a swatch moves the wheel, and vice versa) can
	     actually be exercised here, not just posed. The bound value IS a singer colour = fixture data. -->
	<div style="max-width:420px;">
		<ColourPicker bind:value={demoColour} label="Your color" hint="How you'll spot yourself in the queue and on the TV." />
	</div>

	<!--
		ProfileSheet's demo lived here. The sheet was retired when /settings split into You / Party /
		Server scopes — its name field, this picker and the leave-the-room confirm are now the You tab, so
		the surface to review is that route rather than a component in isolation.
	-->

	<h2 class="section">QueueSheet · docked now-playing, pullable to the rotation</h2>
	<!-- The bottom-docked queue sheet. The button toggles it; open it to see the filled peek (song /
	     singer / position / seek row) and the rotation body via the children snippet. It is
	     position:fixed and pins itself to the bottom of the viewport. -->
	<button class="btn-accent" onclick={() => (queueOpen = !queueOpen)}>Toggle QueueSheet</button>
	<QueueSheet
		open={queueOpen}
		title="Bohemian Rhapsody"
		sub="Maya is singing"
		position="You're #3 · after Liam"
		queueCount={3}
		elapsedSec={82}
		durationSec={358}
		ontoggle={(v) => (queueOpen = v)}
	>
		<QueueRow seq={1} title="Take On Me" singerName="Sam" singerColor={GREEN} up subtitle="now playing" />
		<QueueRow seq={2} title="Sweet Caroline" singerName="Liam" singerColor={SKY} />
		<QueueRow seq={3} title="Dancing Queen" singerName="You" singerColor={PINK} mine subtitle="after Liam" />
	</QueueSheet>

	<h2 class="section">LyricsOverlay (TV) · VERIFIED text</h2>
	<div style="position:relative;height:280px;border-radius:16px;overflow:hidden;background:{stageBg};">
		<LyricsOverlay doc={demoLyrics} positionSec={demoPos} playing visible
			provenance={{ textSource: 'lrclib', textConfidence: 'high', timing: 'word' }} />
	</div>

	<!-- The same doc, same perfect sweep, but the words are a GUESS. The pair is the point —
	     without the caption these two are visually indistinguishable, which is exactly the problem. -->
	<h2 class="section">LyricsOverlay · AUTO-TRANSCRIBED</h2>
	<div style="position:relative;height:280px;border-radius:16px;overflow:hidden;background:{stageBg};">
		<LyricsOverlay doc={demoLyrics} positionSec={demoPos} playing visible
			provenance={{ textSource: 'asr', textConfidence: 'low', timing: 'word' }} />
	</div>

	<!-- The FLOOR: authoritative words, line-level timing only. Whole-line highlight, no ball. -->
	<h2 class="section">LyricsOverlay · LINE-SYNC floor (no word timings)</h2>
	<div style="position:relative;height:280px;border-radius:16px;overflow:hidden;background:{stageBg};">
		<LyricsOverlay doc={demoLineOnly} positionSec={demoPos} playing visible
			provenance={{ textSource: 'lrclib', textConfidence: 'high', timing: 'line' }} />
	</div>

	<!--
		A LINE-ONLY SONG ON A WORD-LEVEL DEPLOYMENT — the case the clamp exists for, and the one no card
		here could show before.

		The card above renders the same doc at the DEFAULT highlight, so it shows the floor looking
		correct while never asking the resolver anything. This one takes the whole route: a stock
		word-level deployment, a stock word-level room, and one song whose winning candidate is
		line-only. What it paints is whatever `resolveLyricsPresentation` decides, so the frame is
		evidence about the decision and not about this markup.

		Pinned position, `playing={false}`: the current row's colour is the whole observable, and a
		running clock makes two frames incomparable. Read the CURRENT (brightest) row —

		  clamped correctly  → the accent colour, and no marker: line-level is what this song can honour
		  clamp not firing   → plain white, no marker, no accent — visually identical to a room that
		                        asked for NO highlight at all, which is the reported symptom. The word
		                        treatment cannot draw itself here: the overlay only emits word spans for
		                        a line that has words, so `hl-word` on an empty `words[]` silently
		                        selects the plain-text branch and loses the one cue the room asked for.
	-->
	<h2 class="section">
		LyricsOverlay · line-only song, word-level deployment · resolved: {lineOnlyResolved.highlight} / marker
		{lineOnlyResolved.ball}{lineOnlyResolved.clamped ? ' (clamped)' : ''}
	</h2>
	<div style="position:relative;height:500px;border-radius:16px;overflow:hidden;background:{stageBg};">
		<LyricsOverlay doc={demoLineOnly} positionSec={0.8} leadSec={0.3} playing={false} visible
			ball={lineOnlyResolved.ball} highlight={lineOnlyResolved.highlight}
			provenance={{
				textSource: lineOnlyCandidate.textSource,
				textConfidence: lineOnlyCandidate.textConfidence,
				timing: lineOnlyCandidate.timing
			}} />
	</div>

	<!--
		Every room-selectable treatment, on one doc, at ONE PINNED position. Side by side is the only way
		to judge these: the difference between a bouncing and a steady dot is motion, and between word and
		line highlighting is what a patchy artifact does to each.

		`playing={false}` and a fixed position are load-bearing, not laziness. The demo clock above loops
		0-18s, so with it running each card renders a different moment and the variants are not comparable
		— and a screenshot lands wherever the rAF happened to be. The frame is pinned by the CODE, not by
		a default defined elsewhere: positionSec=0.8 and leadSec=0.3 are both passed here, so the
		highlight sits at 1.1s where "the" is mid-word and one frame shows all three word states at once
		("Is"/"this" sung, "the" current, "real"/"life" still ahead) regardless of what LYRICS_LEAD_SEC
		defaults to.

		These cards are TALLER than the ones above because the reel is 9.5em of a clamp()-scaled font —
		around 470px here. At 280px the card clipped it and hid the centred current row, which is the row
		these variants exist to show.
	-->
	{#each LYRICS_BALL_STYLES as s (s.id)}
		<h2 class="section">LyricsOverlay · marker: {s.label}</h2>
		<div style="position:relative;height:500px;border-radius:16px;overflow:hidden;background:{stageBg};">
			<LyricsOverlay doc={demoLyrics} positionSec={0.8} leadSec={0.3} playing={false} visible ball={s.id} highlight="word"
				provenance={{ textSource: 'lrclib', textConfidence: 'high', timing: 'word' }} />
		</div>
	{/each}

	{#each LYRICS_HIGHLIGHTS as h (h.id)}
		<h2 class="section">LyricsOverlay · highlight: {h.label}</h2>
		<div style="position:relative;height:500px;border-radius:16px;overflow:hidden;background:{stageBg};">
			<LyricsOverlay doc={demoLyrics} positionSec={0.8} leadSec={0.3} playing={false} visible ball="off" highlight={h.id}
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
		<h2 class="section">LyricsOverlay · {c.what}</h2>
		<div style="position:relative;height:{c.h}px;border-radius:16px;overflow:hidden;background:{stageBg};">
			<!--
				9.5s puts the current line at index 3 of 6, so there are three lines BEFORE it and two
				after. Pinning at 0.8s (as the marker cards do) sits on line 0, where "2 lines before" has
				nothing to show and the card proves nothing — which is exactly how it read first time.
			-->
			<LyricsOverlay doc={c.short ? demoShort : demoLyrics} positionSec={9.5} playing={false} visible highlight="word" ball="bounce"
				provenance={{ textSource: 'lrclib', textConfidence: 'high', timing: 'word' }} {...c.props} />
		</div>
	{/each}

	<h2 class="section">TV room states · lobby + corner join card</h2>
	<!-- The three TV surfaces, scaled down. The point of the pair is that "nobody here" and "people
	     here, nothing queued" are now DIFFERENT screens — they used to be the same one. -->
	<div style="position:relative;height:300px;border-radius:16px;overflow:hidden;background:var(--bg);">
		<TvLobby
			qrDataUrl={demoQr}
			joinUrl="encore.local/join"
			roster={[
				{ id: 'a', displayName: 'Angelo', color: VIOLET, state: 'here' },
				{ id: 'm', displayName: 'Maya', color: PINK, state: 'here' },
				{ id: 'd', displayName: 'Devon', color: GREEN, state: 'away' }
			]}
			overflow={2}
		/>
		<!-- roster colours above are FIXTURE data — each is a singer's chosen accent, not a theme token
		     (violet/pink happen to equal --accent/--accent2 but here they stand in for a person). -->
	</div>
	<div style="position:relative;height:300px;margin-top:10px;border-radius:16px;overflow:hidden;background:{stageBg};">
		<!-- Faint decorative placeholder standing in for the paused music video behind the join badge;
		     a low-opacity white with no matching semantic token, so left as a literal rgba. -->
		<span style="position:absolute;inset:0;display:grid;place-items:center;font-size:.8rem;letter-spacing:.3em;text-transform:uppercase;color:rgba(255,255,255,.22);">music video</span>
		<JoinBadge qrDataUrl={demoQr} joinUrl="encore.local/join" placement="corner" onlineCount={4} />
	</div>

	<!-- TvProgress · every room-selectable placement. A settings picker offers card / corner / edge /
	     off, so each is rendered here on a stage backdrop. 'card' renders inline (the caller places it
	     inside the now-singing card), so it gets a small dark card to sit in; the other two position
	     themselves absolutely against the stage. 'off' renders nothing on purpose — shown so the picker
	     option that means "no TV progress" is not a blank the gallery silently omits. -->
	<h2 class="section">TvProgress (TV) · song progress placements</h2>
	<div style="display:grid;gap:12px;">
		{#each TV_PROGRESS_STYLES as p (p.id)}
			<div>
				<div style="font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-dim);margin-bottom:4px;">{p.label}</div>
				{#if p.id === 'card'}
					<!-- Inline placement: a stand-in for the now-singing card. This surface CARRIES TEXT
					     (the time readouts), so it uses --accent-strong + --on-accent, never --grad
					     (decoration only, no text label). -->
					<div style="padding:14px 18px;border-radius:16px;background:var(--accent-strong);color:var(--on-accent);">
						<TvProgress style={p.id} elapsedSec={82} durationSec={358} />
					</div>
				{:else}
					<div style="position:relative;height:150px;border-radius:16px;overflow:hidden;background:{stageBg};">
						<TvProgress style={p.id} elapsedSec={82} durationSec={358} />
					</div>
				{/if}
			</div>
		{/each}
	</div>

	<!-- VisualizerStage · all four variants. Absent from the gallery until now, which is exactly why the
	     "green tests, dead motion" bug survived: the renderers were unit-tested but the loop that drives
	     them was never mounted anywhere a human could watch it move. Each tile mounts the REAL component
	     (a live ~30fps rAF loop) so a still tile here is a real regression, not a fixture artefact. -->
	<h2 class="section">VisualizerStage (TV) · audio-paced backgrounds</h2>
	<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;">
		{#each TV_VISUALIZERS as v (v.id)}
			<div>
				<div style="font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-dim);margin-bottom:4px;">{v.label}</div>
				<div style="position:relative;height:200px;border-radius:16px;overflow:hidden;background:var(--bg);">
					<VisualizerStage variant={v.id} hue={265} playing />
				</div>
			</div>
		{/each}
	</div>
</main>

<style>
	/*
	 * ONE header rule for the whole gallery, so ~30 hand-inlined <h2> styles cannot drift apart. Kept
	 * LOCAL on purpose: a shared cross-file header primitive is scheduled separately, and this only
	 * needs to make the gallery's own headers agree with each other.
	 */
	.section {
		margin-top: 18px;
		font-size: 0.8rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ink-dim);
	}
	/*
	 * The per-demo caption. Same reason as .section: the RangeBar block arrived with six identical
	 * inline copies of this, and a state that deliberately renders NOTHING is only readable as
	 * intentional if its caption says so -- so the captions have to stay legible and consistent.
	 */
	.caption {
		margin: 0 0 4px;
		font-size: 0.7rem;
		color: var(--ink-dim);
	}
</style>
