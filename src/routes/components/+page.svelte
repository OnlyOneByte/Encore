<script lang="ts">
	// Component preview (dev-only gallery). Not a product surface.
	import SongRow from '$lib/components/SongRow.svelte';
	import QueueRow from '$lib/components/QueueRow.svelte';
	import ProcessingCard from '$lib/components/ProcessingCard.svelte';
	import GuidingTrack from '$lib/components/GuidingTrack.svelte';
	import RangeBar from '$lib/components/RangeBar.svelte';
	import NowPlayingBand from '$lib/components/NowPlayingBand.svelte';
	import type { SongProfile } from '$lib/contract';
	import ColourPicker from '$lib/components/ColourPicker.svelte';
	import NowPlayingDrawer from '$lib/components/NowPlayingDrawer.svelte';
	import { Button } from '$lib/components/ui/button';
	import MyPositionCard from '$lib/components/MyPositionCard.svelte';
	import { positionWords } from '$lib/phrasing/position-sentence';
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
	} from '$lib/contract';
	import type { LyricsCandidate } from '$lib/contract';

	/*
	 * Fixture singer colours, taken from the shared palette by INDEX rather than retyped as hexes.
	 * These are data (a guest's chosen accent), not theme tokens -- but the literals were byte-identical
	 * to SINGER_COLORS[0..2], so a reorder of that array would have left the gallery demonstrating
	 * colours the app can no longer produce. Named so each demo reads as a different singer.
	 */
	const VIOLET = SINGER_COLORS[0];
	const PINK = SINGER_COLORS[1];
	const GREEN = SINGER_COLORS[2];
	/*
	 * Named for the an earlier change highlight cards. Mint is the pick there rather than another violet because the
	 * cards need a singer colour that can be COLLIDED with a stage colour convincingly — a mid-tone teal
	 * field reads as a plausible room choice, where a mid-tone violet field does not.
	 */
	const MINT = SINGER_COLORS[7];
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
						return (x * 7 + y * 13) % 3 === 0
							? `<rect x="${x * 8}" y="${y * 8}" width="8" height="8" fill="#0b0b12"/>`
							: '';
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
		histogram: [2, 3, 4, 5, 6, 9, 14, 20, 26, 30, 28, 22, 15, 10, 7, 5, 4, 3, 2, 1, 1, 0, 0, 0, 0],
		loudnessLufs: -11.2 // a loud modern master, for the level half of the profile
	};
	// Same range, but NO histogram — the block must degrade to a flat fill (range known, weight unknown).
	const profileNoHist: SongProfile = { ...profileFull, histogram: null };

	// Drives the two drawer triggers below — a portalled overlay can only show one state at a time.
	let drawerOpen = $state(false);
	let drawerHasSong = $state(true);
	// A key but NO measured range (silent/instrumental vocal stem). The bar renders NOTHING.
	const profileKeyOnly: SongProfile = {
		keyTonic: 2, // D
		keyMode: 'minor',
		keyConfidence: 0.71,
		lowMidi: null,
		highMidi: null,
		p05Midi: null,
		p95Midi: null,
		histogram: null,
		loudnessLufs: null // unmeasurable level too — never a default, so nothing normalizes it
	};

	// Demo: a word-timed fixture + an auto-advancing position so the karaoke sweep is visible
	// here in the dev gallery (the real /tv route feeds position from player telemetry).
	const demoLyrics: LyricsDoc = {
		language: 'en',
		lines: [
			{
				start: 0.0,
				end: 2.6,
				text: 'Is this the real life',
				words: [
					{
						word: 'Is',
						start: 0.0,
						end: 0.408
					},
					{
						word: 'this',
						start: 0.48,
						end: 0.888
					},
					{
						word: 'the',
						start: 0.96,
						end: 1.368
					},
					{
						word: 'real',
						start: 1.44,
						end: 1.848
					},
					{
						word: 'life',
						start: 1.92,
						end: 2.328
					}
				]
			},
			{
				start: 3.0,
				end: 5.6,
				text: 'Is this just fantasy',
				words: [
					{
						word: 'Is',
						start: 3.0,
						end: 3.51
					},
					{
						word: 'this',
						start: 3.6,
						end: 4.11
					},
					{
						word: 'just',
						start: 4.2,
						end: 4.71
					},
					{
						word: 'fantasy',
						start: 4.8,
						end: 5.31
					}
				]
			},
			{
				start: 6.0,
				end: 8.6,
				text: 'Caught in a landslide',
				words: [
					{
						word: 'Caught',
						start: 6.0,
						end: 6.51
					},
					{
						word: 'in',
						start: 6.6,
						end: 7.11
					},
					{
						word: 'a',
						start: 7.2,
						end: 7.71
					},
					{
						word: 'landslide',
						start: 7.8,
						end: 8.31
					}
				]
			},
			{
				start: 9.0,
				end: 11.6,
				text: 'No escape from reality',
				words: [
					{
						word: 'No',
						start: 9.0,
						end: 9.51
					},
					{
						word: 'escape',
						start: 9.6,
						end: 10.11
					},
					{
						word: 'from',
						start: 10.2,
						end: 10.71
					},
					{
						word: 'reality',
						start: 10.8,
						end: 11.31
					}
				]
			},
			{
				start: 12.0,
				end: 14.6,
				text: 'Open your eyes',
				words: [
					{
						word: 'Open',
						start: 12.0,
						end: 12.68
					},
					{
						word: 'your',
						start: 12.8,
						end: 13.48
					},
					{
						word: 'eyes',
						start: 13.6,
						end: 14.28
					}
				]
			},
			{
				start: 15.0,
				end: 17.6,
				text: 'Look up to the skies and see',
				words: [
					{
						word: 'Look',
						start: 15.0,
						end: 15.291
					},
					{
						word: 'up',
						start: 15.343,
						end: 15.634
					},
					{
						word: 'to',
						start: 15.686,
						end: 15.977
					},
					{
						word: 'the',
						start: 16.029,
						end: 16.32
					},
					{
						word: 'skies',
						start: 16.371,
						end: 16.663
					},
					{
						word: 'and',
						start: 16.714,
						end: 17.006
					},
					{
						word: 'see',
						start: 17.057,
						end: 17.349
					}
				]
			}
		],
		words: []
	};

	// The line-sync floor: same lines, no per-word timings — what an un-alignable LRC renders as.
	const demoLineOnly: LyricsDoc = {
		language: 'en',
		lines: demoLyrics.lines.map((l) => ({ ...l, words: [] })),
		words: []
	};
	/*
	 * A CONFIDENT DUET, as the worker's diarization would write it: alternating lines
	 * carry an abstract `part` letter ("A"/"B"). The overlay maps the two parts onto two DISTINCT
	 * legible SINGER_COLORS through `duetPartColors`, so the two frames below show line 0 (part A) and
	 * line 1 (part B) painted in different colours. An undiarized song has no `part` on any line and
	 * renders exactly as the VERIFIED card above — that fallback is the demoLyrics cards, unchanged.
	 */
	const demoDuet: LyricsDoc = {
		language: 'en',
		lines: demoLyrics.lines.map((l, i) => ({ ...l, part: i % 2 === 0 ? 'A' : 'B' })),
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
	 * guessed: `worker/src/lyrics/source.py:line_synced_lyrics` writes lines with an EMPTY
	 * `words: []` (not an absent key), and `worker/src/steps/lyrics.py:333` records
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

	// FIXTURE: a stand-in singer's chosen accent — this is DATA, not styling, deliberately a literal.
	// The picker is bindable/stateful. Keep the gallery interactive so its real behaviour
	// (preset-vs-slider agreement) can be exercised, not just posed.
	let demoColour = $state(VIOLET);
</script>

<main style="padding:14px 16px 200px;">
	<h2 class="section">SongRow · the readiness axis</h2>
	<!--
		One row shape, three states. Thumbnails are the DERIVED i.ytimg mqdefault URL (see
		ytThumbnailUrl), served through /api/thumb — so on a box with no route to the internet these
		render the gradient placeholder rather than a broken image, which is itself worth seeing here.
	-->
	<SongRow
		title="a-ha - Take On Me (Official Video)"
		artistCanonical="a-ha"
		artist="a-ha"
		readiness="ready"
		thumbnail="https://i.ytimg.com/vi/djV11Xbc914/mqdefault.jpg"
		durationSec={225}
		viewCount={1892000000}
	/>
	<SongRow
		title="a-ha - Take On Me (Official Video)"
		artistCanonical="a-ha"
		artist="a-ha"
		readiness="ready"
		inQueue
		thumbnail="https://i.ytimg.com/vi/djV11Xbc914/mqdefault.jpg"
		durationSec={225}
		viewCount={1892000000}
	/>
	<!-- Ready row carrying a detected KEY chip (the chip is ready-only; a processing/raw row never shows it). -->
	<SongRow
		title="Journey - Don't Stop Believin' (Official Video)"
		artistCanonical="Journey"
		artist="Journey"
		readiness="ready"
		thumbnail="https://i.ytimg.com/vi/1k8craCGpgs/mqdefault.jpg"
		durationSec={251}
		viewCount={789000000}
		keyName="E major"
	/>
	<SongRow
		title="Queen — Bohemian Rhapsody (Sub. Español / Lyrics)"
		artistCanonical="Queen"
		artist="Richie Lyrics"
		readiness="processing"
		thumbnail="https://i.ytimg.com/vi/AlmHSUirAOs/mqdefault.jpg"
		durationSec={358}
		viewCount={265947}
		pct={68}
	/>
	<!--
		an earlier change SPARKLE-HUG, made visible. The three processing rows above all carry a title long enough to
		wrap to two lines, so none of them shows the case an earlier change is about: a SHORT title where the clamp
		box must SHRINK to hug its text (flex: 0 1 auto) so the processing sparkle sits right beside the
		title instead of floating out at the metadata column’s right edge. Reopen an earlier change (.t { flex: 1 },
		in the base rule OR the <=380px @media rule) and the sparkle jumps ~80px away on this row while
		the wrapped rows above barely move — which is exactly why the eyes-on gallery could not see it
		before. No status/etaSec: a short processing title mid-fetch is a real, un-decorated state.
	-->
	<SongRow
		title="Africa"
		artistCanonical="Toto"
		artist="Toto"
		readiness="processing"
		thumbnail="https://i.ytimg.com/vi/FTQbiNvZqaY/mqdefault.jpg"
		durationSec={295}
		viewCount={630000000}
		pct={42}
	/>
	<!--
		THE an earlier change BUG STATE, made visible. `status="downloading" pct={100}` is the exact instant this
		issue names: the FETCH step reports 100% while separating/aligning/ready are unstarted. With the
		live status threaded in, the bar reads OVERALL process completion (~20% — the top of the downloading
		band) and the readout says "20%", NOT the solid "100%" the raw per-step number produced before.
		A row without a status (the fixture above) is unchanged — it still shows the raw pct.
	-->
	<SongRow
		title="Sweet Caroline — Neil Diamond (first step at 100%, process barely started)"
		artistCanonical="Neil Diamond"
		artist="Neil Diamond"
		readiness="processing"
		thumbnail="https://i.ytimg.com/vi/1vhFnTjia_I/mqdefault.jpg"
		durationSec={201}
		viewCount={12345678}
		status="downloading"
		pct={100}
	/>
	<!--
		an earlier change ROUNDING check, committed. `status="separating" pct={68}` gives overallProcessPct ~67.6 (a
		band-interpolated FLOAT), so the readout MUST print a rounded "68%", never "67.6%". The bar keeps
		the unrounded fraction for a smooth transition. This is the fractional case the two band-edge
		fixtures (downloading pct=100 -> exactly 20; statusless control -> raw 68) could not exercise.
	-->
	<SongRow
		title="Bohemian Rhapsody — Queen (mid-separation, fractional overall pct)"
		artistCanonical="Queen"
		artist="Queen"
		readiness="processing"
		status="separating"
		pct={68}
	/>
	<SongRow
		title="The Killers - Mr. Brightside"
		artistCanonical="The Killers"
		artist="TheKillersMusic"
		readiness="unacquired"
		onmake={() => {}}
		thumbnail="https://i.ytimg.com/vi/gGdGFtwCNBE/mqdefault.jpg"
		durationSec={228}
		viewCount={648760065}
	/>

	<h2 class="section">SongRow · telling one song's uploads apart</h2>
	<!--
		The reason this row exists, as real yt-dlp results for one query. Under the old one-line row all
		six read as the same song: the version marker was truncated, there was no duration, and the
		thumbnail was a grey gradient. Rows 5 and 6 are a movie trailer and a 22-minute concert rip.
	-->
	<SongRow
		title="Queen – Bohemian Rhapsody (Official Video Remastered)"
		artistCanonical="Queen"
		artist="Queen Official"
		readiness="unacquired"
		thumbnail="https://i.ytimg.com/vi/fJ9rUzIMcZQ/mqdefault.jpg"
		durationSec={360}
		viewCount={2093310583}
		onmake={() => {}}
	/>
	<SongRow
		title="Queen - Bohemian Rhapsody (Lyrics)"
		artistCanonical="Queen"
		artist="Vibe Tracks"
		readiness="unacquired"
		thumbnail="https://i.ytimg.com/vi/Vsum-2Cs2gI/mqdefault.jpg"
		durationSec={361}
		viewCount={3105203}
		onmake={() => {}}
	/>
	<SongRow
		title="Queen - Bohemian Rhapsody (Live Aid 1985)"
		artistCanonical="Queen"
		artist="Live Aid and Queen Official"
		readiness="unacquired"
		thumbnail="https://i.ytimg.com/vi/vbvyNnw8Qjg/mqdefault.jpg"
		durationSec={165}
		viewCount={306017891}
		onmake={() => {}}
	/>
	<SongRow
		title="Bohemian Rhapsody | Official Trailer [HD] | 20th Century FOX"
		artist="20th Century Studios"
		readiness="unacquired"
		thumbnail="https://i.ytimg.com/vi/mP0VHJYFOAU/mqdefault.jpg"
		durationSec={151}
		viewCount={40878083}
		onmake={() => {}}
	/>
	<SongRow
		title="Bohemian Rhapsody 2018 BONUS Complete Live Aid Performance 1080p BluRay"
		artist="Rulli Haerul"
		readiness="unacquired"
		thumbnail="https://i.ytimg.com/vi/QXbqiAZgeCE/mqdefault.jpg"
		durationSec={1316}
		viewCount={7866057}
		onmake={() => {}}
	/>
	<!-- No thumbnail, no duration, no views — a local library file. Must degrade, not break. -->
	<SongRow title="A local file with no metadata at all" readiness="unacquired" onmake={() => {}} />

	<!--
		THE DRAWER GETS TRIGGERS, NOT A STACK OF FRAMES, and the reason is structural rather than lazy.
		Every other entry on this page is an inline card, so five of them sit side by side and one
		screenshot judges all five. A drawer is PORTALLED to the end of the body and fixed to the
		viewport: two open at once occupy the same 82dvh, so a stack of them would show one frame with
		four invisible siblings underneath. So the states are reachable one at a time, and the frame that
		matters is captured by driving the real app.
		(This is also the only surface here that cannot be judged without interacting — worth knowing
		before trusting a gallery screenshot of it.)
	-->
	<h2 class="section">NowPlayingDrawer · MyPositionCard</h2>
	<div class="row-demo">
		<Button
			variant="secondary"
			size="tap"
			onclick={() => {
				drawerHasSong = true;
				drawerOpen = true;
			}}>Open · playing, full profile</Button
		>
		<Button
			variant="secondary"
			size="tap"
			onclick={() => {
				drawerHasSong = false;
				drawerOpen = true;
			}}>Open · nothing playing</Button
		>
	</div>
	<NowPlayingDrawer
		bind:open={drawerOpen}
		title={drawerHasSong ? "Livin' on a Prayer" : null}
		artist={drawerHasSong ? 'Bon Jovi' : null}
		singerName={drawerHasSong ? 'Maya' : null}
		singerColor={GREEN}
		profile={drawerHasSong ? profileFull : null}
		keyShift={drawerHasSong ? -2 : 0}
		keyShiftEnabled={drawerHasSong}
		guideServerPct={20}
		guideEnabled={drawerHasSong}
		elapsedSec={drawerHasSong ? 104 : 0}
		durationSec={drawerHasSong ? 249 : 0}
		isPlaying={drawerHasSong}
		hasSong={drawerHasSong}
		canStart
	/>
	<MyPositionCard
		words={positionWords({ place: 3, beforeName: 'Priya', nowRemainingSec: 145, aheadDurationsSec: [249, 321] })}
	/>
	<MyPositionCard
		words={positionWords({ place: 3, beforeName: 'Priya', nowRemainingSec: 145, aheadDurationsSec: [249, null] })}
	/>
	<MyPositionCard words={positionWords({ place: 1, nowRemainingSec: 40, aheadDurationsSec: [] })} />

	<h2 class="section">QueueRow</h2>
	<!-- singerColor values here are FIXTURE data — each is a singer's chosen accent standing in for a
	     person, not a theme token (some equal --accent2, but they mean "this singer's colour"). -->
	<QueueRow seq={1} title="Take On Me" singerName="Sam" singerColor={GREEN} up subtitle="now playing" />
	<QueueRow seq={3} title="Dancing Queen" singerName="You" singerColor={PINK} mine subtitle="after Liam" />
	<QueueRow seq={4} title="Sweet Caroline" singerName="Liam" singerColor="#5cb8ff" />
	<QueueRow seq={5} title="Wonderwall" singerName="You" singerColor={PINK} mine pending="add" />
	<!-- an earlier change / XR-PH-10: the unconfirmed REORDER, which had no fixture because the state did not exist —
	     a pending move was indistinguishable from a landed one. Paired directly below its `pending="add"`
	     twin so the only difference under review is the WORD: a row already in the queue must say
	     "moving…", never "adding…". Both share the warn surface, which is the state signal (never
	     opacity, per XR-PH-03). -->
	<QueueRow seq={6} title="Wonderwall" singerName="You" singerColor={PINK} mine pending="move" />
	<!-- issue an earlier change: a 32-char name (the profile-name maxlength) overflows the byline. The identity dot
	     (.who i) must keep its 10px width — it is flex:0 0 auto, not a shrinkable flex item — so the
	     singer's colour survives on the very row where the truncated name least disambiguates them. -->
	<QueueRow
		seq={7}
		title="Africa"
		singerName="Christopher Alexander Montgomery"
		singerColor={PINK}
		mine
		subtitle="after Liam"
	/>

	<h2 class="section">ProcessingCard</h2>
	<ProcessingCard seq={2} title="Bohemian Rhapsody" singerName="You" singerColor={PINK} status="separating" pct={68} />

	<!-- an earlier change: the pending ProcessingCard, which had no fixture at all — the only `pending` surface in
	     the gallery was the QueueRow above, so the processing card's unconfirmed state (the one that
	     actually renders during the primary ✨ Sing flow) had never been eyes-on anywhere. Paired
	     immediately below its non-pending twin so the state signal is judged as a DIFFERENCE: the warn
	     tint and border must be obvious, while `Making karaoke… / 68%`, the byline and the singer dot
	     must stay exactly as legible as they are on the card above. Re-introducing `opacity` on
	     `.pending` is visible here as all three washing out together. -->
	<ProcessingCard
		seq={2}
		title="Bohemian Rhapsody"
		singerName="You"
		singerColor={PINK}
		status="separating"
		pct={68}
		pending="add"
	/>

	<!-- The bug this fixed: an early stage (downloading) at pct=100. Old code filled the bar solid and
	     read 100%; overallProcessPct maps it to the downloading band top (20%), so this card is the one that
	     makes the fix self-evident to a human eyes-on. -->
	<ProcessingCard
		seq={2}
		title="Africa (downloading complete)"
		singerName="You"
		singerColor={PINK}
		status="downloading"
		pct={100}
	/>

	<!-- A processing song is still a queue entry, so it carries the SAME controls as a ready row. Paired
	     with the QueueRow below deliberately: the two reorder/remove button groups must line up, so a
	     song finishing its process doesn't visually reshuffle its own buttons. -->
	<ProcessingCard
		seq={3}
		title="Toto - Africa (Lyrics)"
		singerName="You"
		singerColor={PINK}
		status="separating"
		pct={16}
		reorderable
		canUp
		canDown
		onremove={() => {}}
		onup={() => {}}
		ondown={() => {}}
	/>
	<!-- Coverage gap closed: the only long-name fixture used to be a QueueRow, so
	     the narrower `.who` on a processing card WITH its queue controls was never eyes-on. This is the
	     reachable-collapse case — actions cluster present, name at the 32-char profile maxlength. The
	     name is a single UNBROKEN token (no space, so it cannot wrap): dropping the `.who i { flex: 0 0
	     auto }` rule the surface protects then collapses the dot to 0px, the unmissable failure an earlier change
	     was filed to keep on demo (a spaced name would only shrink it to ~5.45px, an easy-to-miss
	     witness). ChristopherAlexanderMontgomeryJr is 32 chars, exactly the profile-name maxlength. -->
	<ProcessingCard
		seq={5}
		title="Toto - Africa (Lyrics)"
		singerName="ChristopherAlexanderMontgomeryJr"
		singerColor={PINK}
		status="separating"
		pct={16}
		reorderable
		canUp
		canDown
		onremove={() => {}}
		onup={() => {}}
		ondown={() => {}}
	/>
	<QueueRow
		seq={4}
		title="Gwen Stefani - Rich Girl"
		singerName="You"
		singerColor={PINK}
		mine
		subtitle="up next"
		removable
		reorderable
		canUp
		canDown
	/>

	<h2 class="section">NowPlayingBand · every state</h2>
	<!--
		The band, which on the phone is DOCKED to the bottom of the viewport and (from phase 1b) lives in
		the layout as app chrome. Here it renders inline, so its top border and shadow read as a seam
		rather than as a lift off the page — that is the gallery's cost, not a defect.

		Each state is captioned with what it proves. Two of them are the ones a screenshot is for:
		`progress={null}` must draw an EMPTY ring rather than one pinned at zero (a 0% ring reads as a
		stalled song), and the long-title case must ellipsise inside the band instead of sizing it, which
		is only true while `.meta` keeps its `min-width: 0`.
	-->
	<!--
		CONSTRAINED TO PHONE WIDTH ON PURPOSE. The gallery's column is desktop-wide, and the band is a
		phone surface whose two controls are pinned right — demoed full-width they fall off the edge and
		the long-title case stops proving anything, because a 900px band fits any title. 390px is the
		reference device, so these five read as they will on the thing they are for.
	-->
	<div style="display:grid;grid-template-columns:minmax(0,390px);gap:20px;">
		<div>
			<p class="caption">Playing, mid-song — the canonical state</p>
			<NowPlayingBand
				title="Sweet Caroline"
				singerName="Maya"
				singerColor={SINGER_COLORS[0]}
				artist="Neil Diamond"
				progress={0.38}
				isPlaying
			/>
		</div>
		<div>
			<p class="caption">Duration unknown (progress=null) — empty ring, NOT a zeroed one</p>
			<NowPlayingBand
				title="Africa"
				singerName="Ada"
				singerColor={SINGER_COLORS[2]}
				artist="Toto"
				progress={null}
				isPlaying
			/>
		</div>
		<div>
			<p class="caption">Paused — the glyph swaps, the ring holds its position</p>
			<NowPlayingBand
				title="Mr. Brightside"
				singerName="Liam"
				singerColor={SINGER_COLORS[3]}
				artist="The Killers"
				progress={0.72}
			/>
		</div>
		<div>
			<p class="caption">Nothing playing — the disc is disabled and states why in words</p>
			<NowPlayingBand />
		</div>
		<div>
			<p class="caption">Long title + long name — both ellipsise, the band does not grow</p>
			<NowPlayingBand
				title="Don't Stop Believin' (Live at the Budokan, Remastered)"
				singerName="Bartholomew"
				singerColor={SINGER_COLORS[1]}
				artist="Journey featuring absolutely everybody"
				progress={0.11}
				isPlaying
			/>
		</div>
	</div>

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
		<ColourPicker
			bind:value={demoColour}
			label="Your color"
			hint="How you'll spot yourself in the queue and on the TV."
		/>
	</div>

	<!--
		ProfileSheet's demo lived here. The sheet was retired when /settings split into You / Party /
		Server scopes — its name field, this picker and the leave-the-room confirm are now the You tab, so
		the surface to review is that route rather than a component in isolation.
	-->

	<!--
		QueueSheet's and QueueSheetDrawer's demos lived here. Both were retired with the drawer surface
		itself: the ratified phone design has no drawer, an earlier change built the inline-rows/hero/docked-band
		home instead, and the gallery was the only place either component still rendered — so a fix landed
		here reached no guest. The band contract they carried now lives on.cta-dock /.search-dock in
		routes/+page.svelte, which publish --dock-h; see docs/research/827-queuesheet-drawer-spike.md for
		the vaul port spike this also retires.
	-->

	<h2 class="section">LyricsOverlay (TV) · VERIFIED text</h2>
	<div style="position:relative;height:280px;border-radius:16px;overflow:hidden;background:{stageBg};">
		<LyricsOverlay
			doc={demoLyrics}
			positionSec={demoPos}
			playing
			visible
			provenance={{ textSource: 'lrclib', textConfidence: 'high', timing: 'word' }}
		/>
	</div>

	<!-- The same doc, same perfect sweep, but the words are a GUESS. The pair is the point —
	     without the caption these two are visually indistinguishable, which is exactly the problem. -->
	<h2 class="section">LyricsOverlay · AUTO-TRANSCRIBED</h2>
	<div style="position:relative;height:280px;border-radius:16px;overflow:hidden;background:{stageBg};">
		<LyricsOverlay
			doc={demoLyrics}
			positionSec={demoPos}
			playing
			visible
			provenance={{ textSource: 'asr', textConfidence: 'low', timing: 'word' }}
		/>
	</div>

	<!-- The FLOOR: authoritative words, line-level timing only. Whole-line highlight, no ball. -->
	<h2 class="section">LyricsOverlay · LINE-SYNC floor (no word timings)</h2>
	<div style="position:relative;height:280px;border-radius:16px;overflow:hidden;background:{stageBg};">
		<LyricsOverlay
			doc={demoLineOnly}
			positionSec={demoPos}
			playing
			visible
			provenance={{ textSource: 'lrclib', textConfidence: 'high', timing: 'line' }}
		/>
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
		<LyricsOverlay
			doc={demoLineOnly}
			positionSec={0.8}
			leadSec={0.3}
			playing={false}
			visible
			ball={lineOnlyResolved.ball}
			highlight={lineOnlyResolved.highlight}
			provenance={{
				textSource: lineOnlyCandidate.textSource,
				textConfidence: lineOnlyCandidate.textConfidence,
				timing: lineOnlyCandidate.timing
			}}
		/>
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
			<LyricsOverlay
				doc={demoLyrics}
				positionSec={0.8}
				leadSec={0.3}
				playing={false}
				visible
				ball={s.id}
				highlight="word"
				provenance={{ textSource: 'lrclib', textConfidence: 'high', timing: 'word' }}
			/>
		</div>
	{/each}

	{#each LYRICS_HIGHLIGHTS as h (h.id)}
		<h2 class="section">LyricsOverlay · highlight: {h.label}</h2>
		<div style="position:relative;height:500px;border-radius:16px;overflow:hidden;background:{stageBg};">
			<LyricsOverlay
				doc={demoLyrics}
				positionSec={0.8}
				leadSec={0.3}
				playing={false}
				visible
				ball="off"
				highlight={h.id}
				provenance={{ textSource: 'lrclib', textConfidence: 'high', timing: 'word' }}
			/>
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
	{#each [{ what: 'size 100% (the neutral legibility floor)', props: { scalePct: 100 }, h: 500, short: false }, { what: 'size 300% (the ceiling)', props: { scalePct: 300 }, h: 900, short: false }, { what: 'case ALL CAPS — note the extra wrapping', props: { textCase: 'upper' as const }, h: 500, short: false }, { what: 'case all lowercase', props: { textCase: 'lower' as const }, h: 500, short: false }, { what: 'font serif', props: { font: 'serif' as const }, h: 500, short: false }, { what: 'font monospace — fewest words per row', props: { font: 'mono' as const }, h: 500, short: false }, { what: 'rows 0 before / 2 after — no history', props: { linesBefore: 0, linesAfter: 2 }, h: 460, short: true }, { what: 'rows 2 before / 0 after — nothing revealed ahead', props: { linesBefore: 2, linesAfter: 0 }, h: 460, short: true }, { what: 'rows 2 before / 2 after — the default, for comparison', props: { linesBefore: 2, linesAfter: 2 }, h: 700, short: true }, { what: 'rows 1 before / 4 after — asymmetric, current line sits high', props: { linesBefore: 1, linesAfter: 4 }, h: 820, short: true }, { what: 'rows 3 before / 4 after — the maximum reel', props: { linesBefore: 3, linesAfter: 4 }, h: 1080, short: true }] as c (c.what)}
		<h2 class="section">LyricsOverlay · {c.what}</h2>
		<div style="position:relative;height:{c.h}px;border-radius:16px;overflow:hidden;background:{stageBg};">
			<!--
				9.5s puts the current line at index 3 of 6, so there are three lines BEFORE it and two
				after. Pinning at 0.8s (as the marker cards do) sits on line 0, where "2 lines before" has
				nothing to show and the card proves nothing — which is exactly how it read first time.
			-->
			<LyricsOverlay
				doc={c.short ? demoShort : demoLyrics}
				positionSec={9.5}
				playing={false}
				visible
				highlight="word"
				ball="bounce"
				provenance={{ textSource: 'lrclib', textConfidence: 'high', timing: 'word' }}
				{...c.props}
			/>
		</div>
	{/each}

	<!--
WHOSE COLOUR THE HIGHLIGHT IS.

		Four cards, and the pairing is the whole point: the first is the room accent (what every song
		painted before this feature), the second is a singer's own colour on the same doc at the same
		pinned position, so the ONLY difference between those two frames is the active word's hue.

		Pinned at 0.8s with `playing={false}` for the same reason the marker cards are: the active word's
		colour is the entire observable, and a running clock makes two frames incomparable.

		The last two cards are the case the owner's ruling turns on. an earlier change removed the pinned stage tier,
		so a room may now paint the field ANY colour — including one that lands on top of the singer's.
		Card 3 puts a mint singer on a mid-tone teal stage (a realistic collision); card 4 is the
		pathological floor, the stage set to the singer's colour EXACTLY, so the fill has 1:1 contrast
		against the field behind it and the ONLY thing separating the glyphs from the background is the
		reel's own `-webkit-text-stroke`. If the words are still readable in card 4, the ruling
		("keep the hue, rely on the stroke") holds for every less-extreme case by construction. No second
		stroke is added for these — `lyrics-stroke.test.ts` asserts there is exactly one, and one is what
		this leans on.
	-->
	{#each [{ what: 'highlight colour: the ROOM ACCENT (nobody up — the before frame)', singer: null, bg: stageBg }, { what: 'highlight colour: the SINGER (violet) — same doc, same position', singer: VIOLET, bg: stageBg }, { what: 'highlight colour: mint singer on a mid-tone TEAL stage — low contrast, held by the stroke', singer: MINT, bg: '#1f6f63' }, { what: 'highlight colour: mint singer on a stage of EXACTLY that mint — 1:1 fill contrast, stroke only', singer: MINT, bg: MINT }] as c (c.what)}
		<h2 class="section">LyricsOverlay · {c.what}</h2>
		<div style="position:relative;height:280px;border-radius:16px;overflow:hidden;background:{c.bg};">
			<LyricsOverlay
				doc={demoLyrics}
				positionSec={0.8}
				playing={false}
				visible
				highlight="word"
				ball="bounce"
				provenance={{ textSource: 'lrclib', textConfidence: 'high', timing: 'word' }}
				singerColor={c.singer}
			/>
		</div>
	{/each}

	<!--
		DUET PARTS IN TWO COLOURS — the visible half of the duet feature. The worker's
		diarization writes an abstract `part` letter on each line of a confident duet; the reel
		maps the parts onto two DISTINCT legible SINGER_COLORS (the same palette + `isLegibleSingerColor`
		floor the singer colour above uses — a hard-coded second colour is rejected because it would skip
		that floor). The two cards are the SAME duet doc at two positions: the first frame's current line
		is part A, the second's is part B, so the two colours are visible side by side. Frames pinned
		(playing={false}) so the two are comparable. An undiarized song has no `part` and renders as the
		VERIFIED card far above — nothing here changes that path.
	-->
	{#each [{ what: 'duet part A sings (line 0) — first part colour', pos: 0.8 }, { what: 'duet part B sings (line 1) — second, distinct part colour', pos: 3.3 }] as c (c.what)}
		<h2 class="section">LyricsOverlay · {c.what}</h2>
		<div style="position:relative;height:280px;border-radius:16px;overflow:hidden;background:{stageBg};">
			<LyricsOverlay
				doc={demoDuet}
				positionSec={c.pos}
				playing={false}
				visible
				highlight="word"
				ball="bounce"
				provenance={{ textSource: 'lrclib', textConfidence: 'high', timing: 'word' }}
			/>
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
		<span
			style="position:absolute;inset:0;display:grid;place-items:center;font-size:.8rem;letter-spacing:.3em;text-transform:uppercase;color:rgba(255,255,255,.22);"
			>music video</span
		>
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
				<div
					style="font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-dim);margin-bottom:4px;"
				>
					{p.label}
				</div>
				{#if p.id === 'card'}
					<!-- Inline placement: a stand-in for the now-singing card. This surface CARRIES TEXT
					     (the time readouts), so it uses --accent + --on-accent, never --grad
					     (decoration only, no text label on any stop). -->
					<div style="padding:14px 18px;border-radius:16px;background:var(--accent);color:var(--on-accent);">
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
				<div
					style="font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-dim);margin-bottom:4px;"
				>
					{v.label}
				</div>
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
	/* The drawer's two triggers, side by side. A portalled overlay cannot be stacked like the inline
	   cards above it, so the states are reachable one at a time — see the note beside them. */
	.row-demo {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-sm);
		margin-bottom: var(--space-md);
	}
	.section {
		margin-top: var(--space-3xl);
		font-size: var(--ph-text-sm);
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
		margin: 0 0 var(--space-2xs);
		font-size: 0.7rem;
		color: var(--ink-dim);
	}
</style>
