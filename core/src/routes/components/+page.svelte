<script lang="ts">
	// Component preview (dev-only gallery). Not a product surface.
	import { onMount } from 'svelte';
	import SongRow from '$lib/components/SongRow.svelte';
	import QueueRow from '$lib/components/QueueRow.svelte';
	import ProcessingCard from '$lib/components/ProcessingCard.svelte';
	import GuidingTrack from '$lib/components/GuidingTrack.svelte';
	import RangeBar from '$lib/components/RangeBar.svelte';
	import NowPlayingBand from '$lib/components/NowPlayingBand.svelte';
	import NowPlayingDrawer from '$lib/components/NowPlayingDrawer.svelte';
	import { Button } from '$lib/components/ui/button';
	import LyricsOverlay from '$lib/tv/LyricsOverlay.svelte';
	import TvLobby from '$lib/tv/TvLobby.svelte';
	import JoinBadge from '$lib/tv/JoinBadge.svelte';
	import TvProgress from '$lib/tv/TvProgress.svelte';
	import VisualizerStage from '$lib/tv/VisualizerStage.svelte';
	import {
		LYRICS_BALL_STYLES,
		LYRICS_HIGHLIGHTS,
		SINGER_COLORS,
		TV_VISUALIZERS,
		TV_PROGRESS_STYLES,
		resolveLyricsPresentation
	} from '$lib/contract';
	/* Every sample value lives in one module so this file is only the SHOWING of components. */
	import {
		demoDuet,
		demoLineOnly,
		demoLyrics,
		demoQr,
		demoShort,
		GREEN,
		KNOB_CARDS,
		lineOnlyCandidate,
		MINT,
		PINK,
		profileFull,
		profileKeyOnly,
		profileNoHistogram,
		stageBg,
		VIOLET,
		wordLevelDeployment
	} from '$lib/components/gallery-fixtures';

	// Ask the SAME resolver the TV asks: passing `highlight`/`ball` by hand makes the card a picture of a decision.
	const lineOnlyResolved = $derived(resolveLyricsPresentation(wordLevelDeployment, lineOnlyCandidate.timing));

	// The gallery's two interactive fixtures: a portalled overlay can only show one state at a time, so the drawer
	// gets triggers, and the picker's preset-vs-rail agreement can only be exercised by binding a real value.
	let drawerOpen = $state(false);
	let drawerHasSong = $state(true);

	// The demo clock every word-sweep card reads, so one loop drives them all.
	let demoPos = $state(0);
	onMount(() => {
		const startedAt = performance.now();
		let raf = 0;
		const loop = () => {
			const elapsed = (performance.now() - startedAt) / 1000;
			demoPos = elapsed % 18; // loop 0-18s across all six demo lines
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	});
</script>

<main style="padding:14px 16px 200px;">
	<h2 class="section">SongRow · the readiness axis</h2>
	<!-- Thumbnails are derived i.ytimg URLs via /api/thumb, so a box with no route out shows the placeholder. -->
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
	<!-- A SHORT processing title: the clamp box must hug its text (flex: 0 1 auto) or the sparkle floats right. -->
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
	<!-- Fetch at 100% with later steps unstarted must read ~20% overall; a statusless row shows the raw pct. -->
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
	<!-- The fractional case: overallProcessPct ~67.6 must print as a rounded 68% while the bar keeps the fraction. -->
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
	<!-- Real yt-dlp results for one query: rows 5 and 6 are a trailer and a concert rip, and only metadata says so. -->
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

	<!-- Triggers, not stacked frames: the drawer is portalled and fixed, so two open would share the same 82dvh. -->
	<h2 class="section">NowPlayingDrawer</h2>
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
	<!-- A real-shaped `mediaId` so the door renders; it is gated on `hasSong && mediaId`, so the empty state has none. -->
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
		mediaId={drawerHasSong ? '01M2H2FVB5P1W0G7BCHC29BYFJ' : null}
	/>

	<h2 class="section">QueueRow</h2>
	<!-- singerColor is fixture DATA throughout: a person's accent, never a token, even where the hex matches one. -->
	<QueueRow seq={1} title="Take On Me" singerName="Sam" singerColor={GREEN} up subtitle="now playing" />
	<QueueRow seq={3} title="Dancing Queen" singerName="You" singerColor={PINK} mine subtitle="after Liam" />
	<QueueRow seq={4} title="Sweet Caroline" singerName="Liam" singerColor="#5cb8ff" />

	<QueueRow seq={5} title="Wonderwall" singerName="You" singerColor={PINK} mine pending="add" />
	<!-- Paired with its `pending="add"` twin so only the WORD differs: a queued row says "moving…", not "adding…". -->
	<QueueRow seq={6} title="Wonderwall" singerName="You" singerColor={PINK} mine pending="move" />
	<!-- A 32-char name overflows the byline; the identity dot must keep flex:0 0 auto or its colour is lost. -->
	<QueueRow
		seq={7}
		title="Africa"
		singerName="Christopher Alexander Montgomery"
		singerColor={PINK}
		mine
		subtitle="after Liam"
	/>

	<!-- Its own section so numbering restarts at 1. The three `waitShort` states, last an UNKNOWN wait: no clause. -->
	<h2 class="section">QueueRow · the wait</h2>
	<QueueRow seq={1} title="Forever Young" singerName="You" singerColor={PINK} mine up subtitle="up next · ~3 min" />
	<QueueRow seq={2} title="Africa" singerName="You" singerColor={PINK} mine subtitle="<1 min" />
	<QueueRow seq={3} title="Heroes" singerName="You" singerColor={PINK} mine subtitle="" />

	<h2 class="section">ProcessingCard</h2>
	<ProcessingCard seq={2} title="Bohemian Rhapsody" singerName="You" singerColor={PINK} status="separating" pct={68} />

	<!-- Paired with its non-pending twin: the warn tint must be obvious, and `opacity` on `.pending` washes out. -->
	<ProcessingCard
		seq={2}
		title="Bohemian Rhapsody"
		singerName="You"
		singerColor={PINK}
		status="separating"
		pct={68}
		pending="add"
	/>

	<!-- The same band-edge case on a card: downloading at 100% must read 20% overall, not a solid bar. -->
	<ProcessingCard
		seq={2}
		title="Africa (downloading complete)"
		singerName="You"
		singerColor={PINK}
		status="downloading"
		pct={100}
	/>

	<!-- A processing song is a queue entry: its controls and grip must line up with the QueueRow below. -->
	<ProcessingCard
		seq={3}
		title="Toto - Africa (Lyrics)"
		singerName="You"
		singerColor={PINK}
		status="separating"
		pct={16}
		reorderable
		grip
		gripId="demo-proc"
		onremove={() => {}}
	/>
	<!-- Reachable collapse: a 32-char UNBROKEN name. Drop the `.who i` flex:0 0 auto rule and the dot goes to 0px. -->
	<ProcessingCard
		seq={5}
		title="Toto - Africa (Lyrics)"
		singerName="ChristopherAlexanderMontgomeryJr"
		singerColor={PINK}
		status="separating"
		pct={16}
		reorderable
		onremove={() => {}}
	/>
	<QueueRow
		seq={4}
		title="Gwen Stefani - Rich Girl"
		singerName="You"
		singerColor={PINK}
		mine
		subtitle="up next"
		removable
		grip
	/>

	<h2 class="section">NowPlayingBand · every state</h2>
	<!-- Inline here, so the band's top border reads as a seam rather than a lift — the gallery's cost, not a defect.
			`progress={null}` must draw an EMPTY ring, and a long title must ellipsise while `.meta` keeps min-width:0. Held to
			390px: the band's controls are pinned right, so at gallery width a long title proves nothing. -->
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
	<!-- Off (the shipped default), faint, halfway, full sing-along, and unavailable for want of a vocals stem. -->
	<div style="display:grid;gap:14px;">
		<GuidingTrack pct={0} available={true} />
		<GuidingTrack pct={15} available={true} />
		<GuidingTrack pct={60} available={true} />
		<GuidingTrack pct={100} available={true} />
		<GuidingTrack pct={0} available={false} />
	</div>

	<h2 class="section">RangeBar · every state</h2>
	<!-- Captions are load-bearing: several of these states render NOTHING, and a blank needs saying so. -->
	<div style="display:grid;gap:16px;">
		<div>
			<p class="caption">Full range + histogram (chorus lives high)</p>
			<RangeBar profile={profileFull} />
		</div>
		<div>
			<p class="caption">Full range, NO histogram (flat block)</p>
			<RangeBar profile={profileNoHistogram} />
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

	<!-- Same doc, same sweep, but the words are a GUESS: without the caption these two frames are identical. -->
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

	<!-- The case the clamp exists for: a stock word-level room, and a song whose winning candidate is line-only. Read the
			CURRENT row — accent with no marker means the clamp fired; plain white means it did not. -->
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

	<!-- `playing={false}` plus a pinned position is load-bearing: the demo clock loops, so frames would differ. positionSec
			and leadSec are BOTH passed so 1.1s shows all three word states; 500px fits the reel's 9.5em. -->
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

	{#each KNOB_CARDS as c (c.what)}
		<h2 class="section">LyricsOverlay · {c.what}</h2>
		<div style="position:relative;height:{c.height}px;border-radius:16px;overflow:hidden;background:{stageBg};">
			<!-- 9.5s puts the current line at index 3 of 6, so rows exist before AND after it; 0.8s has none before. -->
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

	<!-- Four frames at one position, so the active word's hue is the only difference. Cards 3 and 4 are the stage-colour
			collision: only `-webkit-text-stroke` holds card 4, and there is one. -->
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

	<!-- The duet doc at two positions. Both part colours come from SINGER_COLORS through the legibility floor. -->
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
	<!-- "Nobody here" and "people here, nothing queued" are different screens; this is the pair. -->
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
	</div>
	<div style="position:relative;height:300px;margin-top:10px;border-radius:16px;overflow:hidden;background:{stageBg};">
		<!-- Stands in for the paused music video; no token matches a faint decorative wash, so the rgba is literal. -->
		<span
			style="position:absolute;inset:0;display:grid;place-items:center;font-size:.8rem;letter-spacing:.3em;text-transform:uppercase;color:rgba(255,255,255,.22);"
			>music video</span
		>
		<JoinBadge qrDataUrl={demoQr} joinUrl="encore.local/join" placement="corner" onlineCount={4} />
	</div>

	<!-- Every room-selectable placement, 'off' included, so the option is not a blank the gallery omits. -->
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
					<!-- This surface carries TEXT, so --accent with --on-accent, never --grad: no stop is contrast-checked. -->
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

	<!-- Each tile mounts the REAL component and its rAF loop: a still tile here is a regression, not a fixture. -->
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
	.caption {
		margin: 0 0 var(--space-2xs);
		font-size: 0.7rem;
		color: var(--ink-dim);
	}
</style>
