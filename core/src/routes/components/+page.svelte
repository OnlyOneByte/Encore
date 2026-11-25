<script lang="ts">
	// Component preview (dev-only gallery). Not a product surface.
	import { onMount } from 'svelte';
	import SongRow from '$lib/components/SongRow.svelte';
	import QueueRow from '$lib/components/QueueRow.svelte';
	import ProcessingCard from '$lib/components/ProcessingCard.svelte';
	import OnDeckCard from '$lib/components/OnDeckCard.svelte';
	import GuidingTrack from '$lib/components/GuidingTrack.svelte';
	import RangeBar from '$lib/components/RangeBar.svelte';
	import NowPlayingStrip from '$lib/ui/NowPlayingStrip.svelte';
	import TabBar from '$lib/ui/TabBar.svelte';
	import { Button } from '$lib/components/ui/button';
	/* THE PRIMITIVES, imported so the gallery can show them. See the `Primitives` section below for why
	   their ABSENCE was the defect: `ui/README.md` closes with "Look at it. The four worst defects of the
	   migration were all correct in source and wrong on screen", and until now there was nowhere to look. */
	import * as Alert from '$lib/components/ui/alert';
	import * as Card from '$lib/components/ui/card';
	import * as Empty from '$lib/components/ui/empty';
	import { Badge } from '$lib/components/ui/badge';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import * as NativeSelect from '$lib/components/ui/native-select';
	import { Switch } from '$lib/components/ui/switch';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Progress } from '$lib/components/ui/progress';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Spinner } from '$lib/components/ui/spinner';
	import SkeletonRows from '$lib/ui/SkeletonRows.svelte';
	import FindField from '$lib/ui/FindField.svelte';
	import Icon from '$lib/ui/Icon.svelte';
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

	// The gallery's one interactive fixture: the picker's preset-vs-rail agreement can only be exercised by binding
	// a real value. There used to be a second — two triggers for the now-playing drawer, because a portalled
	// overlay can only show one state at a time. The strip that replaced it is an inline element with no open
	// state, so every state is a stacked frame like the rest of this file.

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

	/* Live state for the primitive matrix. Interactive on purpose: a switch that cannot be thrown cannot show
	   its own focus ring, and the focus ring is what half these findings were about. */
	const BUTTON_VARIANTS = [
		'default',
		'secondary',
		'outline',
		'ghost',
		'destructive',
		'link',
		'identity',
		'keycap',
		'eyebrow',
		'iconPrimary'
	] as const;
	const BUTTON_SIZES = ['default', 'tap', 'sm', 'lg', 'block', 'blockLg', 'icon'] as const;
	const BADGE_TONES = ['neutral', 'ok', 'warn', 'bad', 'accent', 'tag'] as const;
	const ALERT_TONES = ['default', 'warn', 'accent', 'destructive'] as const;
	let galSwitch = $state(true);
	let galCheck = $state<boolean>(true);
	let galSelect = $state('music');
	let galFind = $state('');
</script>

<main style="padding:14px 16px 200px;">
	<!-- ═══ PRIMITIVES ═══════════════════════════════════════════════════════════════════════════════
		 WHY THIS SECTION EXISTS, and why it is FIRST. `docs/FRONTEND.md#the-components-gallery` says this route
		 "renders every shared component in every state it must survive, side by side" — and it rendered none of
		 the 24 vendored primitives, only the authored components. A review found that every design-system
		 defect in the tree is a PAIRWISE comparison — `Card.Root` against `.card`, Button's `default` against
		 `size="tap"`, three radii in one row, `Empty.Root`'s bare line against the hero block, `SkeletonRows`
		 against the row it stands in for — and not one of those pairs could be put side by side anywhere in the
		 app. It was a gallery of the healthy half, which is why the unhealthy half went unseen.
		 THE PAIRS ARE THE POINT. Where a vendored primitive and an app idiom express the same thing, they are
		 rendered ADJACENT with identical content, so a divergence is visible rather than inferred. -->
	<h2 class="section">Primitives · Button, every variant × every size</h2>
	<p class="note">
		Each cell is the same label at one variant and one size. Watch the HEIGHT: the tap floor is
		<code>var(--tap)</code> = 44px, and any cell shorter than its neighbours is a control under the floor.
	</p>
	<div class="gal-grid">
		{#each BUTTON_VARIANTS as v (v)}
			<div class="gal-col">
				<span class="gal-label">{v}</span>
				{#each BUTTON_SIZES as sz (sz)}
					<Button variant={v} size={sz}>
						{#if sz === 'icon'}<Icon name="mic" />{:else}{sz}{/if}
					</Button>
				{/each}
				<Button variant={v} disabled>disabled</Button>
			</div>
		{/each}
	</div>

	<h2 class="section">Primitives · the same Button as a &lt;button&gt; and as an &lt;a&gt;</h2>
	<p class="note">
		These MUST look identical. They did not: <code>button,input,select,textarea &#123; font: inherit &#125;</code>
		was unlayered, so it outranked every layered Tailwind utility and killed the declared font-size on the
		<code>&lt;button&gt;</code> form only — 14.4px against the anchor's 14px, and
		<code>variant="eyebrow"</code>'s size dead entirely. The reset now sits in <code>@layer base</code>.
	</p>
	<div class="gal-row">
		<Button>as a button</Button>
		<Button href="/components">as an anchor</Button>
		<Button variant="eyebrow">eyebrow button</Button>
		<Button variant="eyebrow" href="/components">eyebrow anchor</Button>
	</div>

	<h2 class="section">Primitives · Card.Root beside .card, identical content</h2>
	<p class="note">
		THE PAIR. <code>app.css</code> gives <code>.card</code> a flat fill and a <code>--line</code> border;
		<code>Card.Root</code> runs on the registry's keys. Any difference in surface, border or radius between these two boxes
		is the seam.
	</p>
	<div class="gal-row gal-row--stretch">
		<Card.Root>
			<Card.Header><Card.Title>Card.Root</Card.Title></Card.Header>
			<Card.Content>The vendored card. Same words as its neighbour.</Card.Content>
		</Card.Root>
		<div class="card">
			<h3 class="gal-h3">.card</h3>
			<p>The app idiom. Same words as its neighbour.</p>
		</div>
	</div>

	<h2 class="section">Primitives · Empty.Root beside the home column's hero</h2>
	<p class="note">
		The phone home writes its own first-run block; <code>Empty.Root</code> is what every other route uses. Rendered together
		because the two have already drifted, and neither one knows it.
	</p>
	<div class="gal-row gal-row--stretch">
		<Empty.Root>
			<Empty.Header>
				<Empty.Title>No karaoke tracks yet.</Empty.Title>
				<Empty.Description>Search above for a song and we'll make one.</Empty.Description>
			</Empty.Header>
		</Empty.Root>
		<div class="card">
			<h3 class="gal-h3">No karaoke tracks yet.</h3>
			<p>Search above for a song and we'll make one.</p>
		</div>
	</div>

	<h2 class="section">Primitives · Alert, every tone</h2>
	<p class="note">
		<code>--danger</code> means failure and <code>--accent2</code> never does (pink is a valid singer colour). A tone that
		reads as decoration here is a tone that will be missed in a failure.
	</p>
	<div class="gal-stack">
		{#each ALERT_TONES as tone (tone)}
			<Alert.Root variant={tone}>
				<Alert.Title>{tone}</Alert.Title>
				<Alert.Description>What this tone says when something happens.</Alert.Description>
			</Alert.Root>
		{/each}
	</div>

	<h2 class="section">Primitives · Badge, every tone</h2>
	<div class="gal-row">
		{#each BADGE_TONES as tone (tone)}
			<Badge variant={tone}>{tone}</Badge>
		{/each}
	</div>

	<h2 class="section">Primitives · form controls in a 320px track</h2>
	<p class="note">
		THE WIDTH IS THE TEST: 320px is the narrowest phone, and every control here must clear
		<code>var(--tap)</code> tall and 16px of font-size — iOS Safari auto-zooms a focused control under 16px and never zooms
		back. The search field was measured at 4px wide inside this very row shape.
	</p>
	<div class="gal-track">
		<FindField
			bind:value={galFind}
			ariaLabel="Gallery search"
			placeholder="Search a song or artist…"
			clearable={galFind.length > 0}
			clearLabel="Clear"
			onclear={() => (galFind = '')}
		/>
		<Input placeholder="Input" aria-label="Gallery input" />
		<NativeSelect.Root bind:value={galSelect} aria-label="Gallery select">
			<NativeSelect.Option value="music">Music</NativeSelect.Option>
			<NativeSelect.Option value="everything">Everything</NativeSelect.Option>
		</NativeSelect.Root>
		<Textarea placeholder="Textarea" aria-label="Gallery textarea" />
		<label class="gal-inline"><Switch bind:checked={galSwitch} /> Switch</label>
		<label class="gal-inline"><Checkbox bind:checked={galCheck} /> Checkbox</label>
	</div>

	<h2 class="section">Primitives · progress, spinner, skeleton</h2>
	<div class="gal-stack">
		<Progress value={38} />
		<div class="gal-row"><Spinner /> <Skeleton class="gal-skel" /></div>
	</div>

	<h2 class="section">Primitives · SkeletonRows above the rows it stands in for</h2>
	<p class="note">
		A skeleton is a PROMISE about the shape that replaces it. Stacked directly against real rows, a mismatched height is
		visible as a jump — which is the defect, since the hand-off is what the guest sees.
	</p>
	<SkeletonRows label="Searching…" />
	<SongRow title="a-ha - Take On Me (Official Video)" artist="a-ha" durationSec={225} readiness="ready" />
	<SongRow title="Toto - Africa" artist="Toto" durationSec={295} readiness="unacquired" />

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

	<!-- Its own section so numbering restarts at 1. The three wait states, last an UNKNOWN wait: no clause. -->
	<h2 class="section">QueueRow · the wait</h2>
	<QueueRow seq={1} title="Forever Young" singerName="You" singerColor={PINK} mine up subtitle="up next · ~3 min" />
	<QueueRow seq={2} title="Africa" singerName="You" singerColor={PINK} mine subtitle="<1 min" />
	<QueueRow seq={3} title="Heroes" singerName="You" singerColor={PINK} mine subtitle="" />

	<h2 class="section">ProcessingCard</h2>
	<ProcessingCard
		kind="processing"
		seq={2}
		title="Bohemian Rhapsody"
		singerName="You"
		singerColor={PINK}
		status="separating"
		pct={68}
	/>

	<!-- Paired with its non-pending twin: the warn tint must be obvious, and `opacity` on `.pending` washes out. -->
	<ProcessingCard
		kind="processing"
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
		kind="processing"
		seq={2}
		title="Africa (downloading complete)"
		singerName="You"
		singerColor={PINK}
		status="downloading"
		pct={100}
	/>

	<!-- A processing song is a queue entry: its controls and grip must line up with the QueueRow below. -->
	<ProcessingCard
		kind="processing"
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
		kind="processing"
		seq={5}
		title="Toto - Africa (Lyrics)"
		singerName="ChristopherAlexanderMontgomeryJr"
		singerColor={PINK}
		status="separating"
		pct={16}
		reorderable
		onremove={() => {}}
	/>
	<!-- THE TWO NON-FLIGHT KINDS, DELIBERATELY ADJACENT, because the only way to judge the token split is to see it:
		`failed` is a process that ran and died and takes the DANGER border and ink; `stalled` is a turn nothing is
		making karaoke for and takes the WARN border with `.stage`'s own warn ink. A client cannot tell a permanently
		dead turn from the round trip before another phone's process broadcast arrives, so it may not claim --danger —
		docs/FRONTEND.md's token rule. Neither draws a bar; only the stalled one offers the retry. -->
	<ProcessingCard
		kind="failed"
		seq={6}
		title="Never Gonna Give You Up"
		singerName="You"
		singerColor={PINK}
		onremove={() => {}}
	/>
	<ProcessingCard
		kind="stalled"
		noMaker
		seq={7}
		title="Wonderwall"
		singerName="Jo"
		singerColor={PINK}
		singerAway
		onretry={() => {}}
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

	<h2 class="section">NowPlayingStrip · every state</h2>
	<!-- Held to 390px, because the Cheer key is pinned right and at gallery width a long title proves nothing. A long
			title must ellipsise while `.meta` keeps `min-width: 0`. -->
	<div style="display:grid;grid-template-columns:minmax(0,390px);gap:20px;">
		<div>
			<p class="caption">Playing, mid-song — the canonical state</p>
			<NowPlayingStrip
				title="Sweet Caroline"
				singerName="Maya"
				singerColor={SINGER_COLORS[0]}
				elapsedSec={95}
				durationSec={250}
				hasSong
				canStart
				queueCount={2}
			/>
		</div>
		<div>
			<p class="caption">Long title + long name — the TITLE gives up width, the name never truncates</p>
			<NowPlayingStrip
				title="Don't Stop Believin' (Live at the Budokan, Remastered)"
				singerName="Bartholomew"
				singerColor={SINGER_COLORS[1]}
				elapsedSec={27}
				durationSec={251}
				hasSong
				canStart
				queueCount={2}
			/>
		</div>
		<div>
			<p class="caption">A queue but nothing playing yet — "Ready when you are", with its one Play</p>
			<NowPlayingStrip
				title={null}
				singerName={null}
				singerColor={null}
				elapsedSec={0}
				durationSec={0}
				hasSong={false}
				canStart
				queueCount={1}
				onplay={() => {}}
			/>
		</div>
		<div>
			<p class="caption">Nothing playing and nothing queued — "Nothing playing"</p>
			<NowPlayingStrip
				title={null}
				singerName={null}
				singerColor={null}
				elapsedSec={0}
				durationSec={0}
				hasSong={false}
				canStart={false}
				queueCount={0}
			/>
		</div>
		<div>
			<p class="caption">The link is down — "Reconnecting…" takes the title slot, same height</p>
			<NowPlayingStrip
				title="Sweet Caroline"
				singerName="Maya"
				singerColor={SINGER_COLORS[0]}
				elapsedSec={48}
				durationSec={201}
				hasSong
				canStart
				queueCount={1}
				connected={false}
			/>
		</div>
	</div>

	<h2 class="section">TabBar · each tab current</h2>
	<!-- FOUR FRAMES FOR THREE TABS. The fourth is the one a source read gets wrong: `isCurrent` is an EXACT match for
			`/` and a prefix match for the rest, because `startsWith('/')` is true of every path and would light Sing
			everywhere. `/settings` is not a tab at all, so NO tab lights — and `/song/[mediaId]`, reached only from /queue's now-playing card,
			is deliberately the same. Held to 390px for the same reason as the strip: the tracks are `1fr` each. -->
	<div style="display:grid;grid-template-columns:minmax(0,390px);gap:20px;">
		<div>
			<p class="caption">On the Sing tab</p>
			<TabBar pathname="/" />
		</div>
		<div>
			<p class="caption">On the Queue tab</p>
			<TabBar pathname="/queue" />
		</div>
		<div>
			<p class="caption">On the Library tab</p>
			<TabBar pathname="/library" />
		</div>
		<div>
			<p class="caption">On /settings — a non-tab surface, so no tab lights at all</p>
			<TabBar pathname="/settings" />
		</div>
	</div>

	<h2 class="section">OnDeckCard · resting and heads-up</h2>
	<!-- Inert, like the GuidingTrack rows below: the callbacks go nowhere, so each card stays in the state it shows. -->
	<div style="display:grid;gap:14px;">
		<OnDeckCard
			entryId="gallery"
			title="Sweet Caroline"
			artist="Neil Diamond"
			profile={profileFull}
			keyShift={-2}
			guideLevel={0.3}
			guideAvailable={true}
			afterName="Maya"
			timeLeft="~2 min"
			headsUp={false}
			singerColor={PINK}
			notYetName="Theo"
			onkey={() => {}}
			onguide={() => {}}
			onnotyet={() => {}}
		/>
		<OnDeckCard
			entryId="gallery"
			title="Sweet Caroline"
			artist="Neil Diamond"
			profile={profileFull}
			keyShift={-2}
			guideLevel={0.3}
			guideAvailable={true}
			headsUp={true}
			singerColor={PINK}
			onkey={() => {}}
			onguide={() => {}}
			onnotyet={() => {}}
		/>
	</div>

	<h2 class="section">GuidingTrack · every state</h2>
	<!-- Off (the shipped default), faint, halfway, full sing-along, and unavailable for want of a vocals stem.
		THESE FIVE DO NOT DRAG, and that is the control working rather than failing: GuidingTrack's value is CONTROLLED
		(see its header), so the thumb renders `pct` and a move is a request to the caller. There is no caller here, so
		each row stays on the level it is here to show — measured, a full-width drag plus five ArrowRights on every row
		left all five reading Off / 15% / 60% / 100% / Off with matching `aria-valuenow`. That is what a gallery of
		states wants, and it is new: while the primitive owned the value these rows could be dragged off the very
		states they are here to show. On /queue the caller is the room, and a move the room accepts moves the thumb. -->
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
				{ id: 'a', displayName: 'Dana', color: VIOLET, state: 'here' },
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
		<JoinBadge qrDataUrl={demoQr} joinUrl="encore.local/join" placement="corner" />
	</div>

	<!-- Every room-selectable placement, 'off' included, so the option is not a blank the gallery omits. -->
	<h2 class="section">TvProgress (TV) · song progress placements</h2>
	<div style="display:grid;gap:12px;">
		{#each TV_PROGRESS_STYLES as p (p.id)}
			<div>
				<div
					style="font-size:var(--ph-text-xs);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-dim);margin-bottom:4px;"
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
					style="font-size:var(--ph-text-xs);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-dim);margin-bottom:4px;"
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
	/* Gallery-only layout. Not a product surface, so these are plain and local. */
	.note {
		margin: var(--space-xs) 0 var(--space-md);
		max-width: 62ch;
		color: var(--ink-dim);
		font-size: var(--ph-text-sm);
	}
	.note code {
		color: var(--ink);
	}
	.gal-grid {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-lg);
	}
	.gal-col {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-xs);
		min-width: 0;
	}
	.gal-label {
		color: var(--ink-dim);
		font-size: var(--ph-text-xs);
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}
	.gal-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-md);
	}
	.gal-row--stretch {
		align-items: stretch;
	}
	.gal-row--stretch > * {
		flex: 1 1 260px;
		min-width: 0;
	}
	.gal-stack {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
	}
	/* 320px EXACTLY, because that is the width the controls are claimed to survive and the width the
	   search field was measured at 4px in. A wider track would hide the defect this section exists to show. */
	.gal-track {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
		width: 320px;
		max-width: 100%;
		padding: var(--space-md);
		border: 1px dashed var(--line-strong);
		border-radius: var(--radius-md);
	}
	.gal-inline {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		min-height: var(--tap);
	}
	.gal-h3 {
		margin: 0 0 var(--space-xs);
		font-size: var(--ph-text-base);
	}
	:global(.gal-skel) {
		width: 180px;
		height: var(--tap);
	}

	.section {
		/* `4xl`, not the `5xl` section rung this gallery's eyebrows otherwise resemble: the section rung obliges its
		   host a `@media (max-height: 480px)` claw-back (app.css's `.grouphead`), and this is a dev gallery, not a
		   shipped surface, so promoting it would mint an obligation nobody owes. It was the retired `3xl` (18). */
		margin-top: var(--space-4xl);
		font-size: var(--ph-text-sm);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ink-dim);
	}
	.caption {
		margin: 0 0 var(--space-2xs);
		/* On the ladder, not 0.7rem/11.2px: the gallery that documents the design system cannot be the one page that
		   renders under the system's own 12px floor. */
		font-size: var(--ph-text-xs);
		color: var(--ink-dim);
	}
</style>
