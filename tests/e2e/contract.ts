/*
 * THE E2E SELECTOR CONTRACT. See docs/E2E.md#why-selectors-are-centralised,
 * docs/E2E.md#what-a-sel--hooks-entry-means and docs/E2E.md#anchor-discipline.
 */

export interface Hook {
	id: string;
	file: string;
	anchor: string;
	why: string;
}

/*
 * RETIRED IDS AND VALUES, PINNED BY contract.test.ts — reviving any of these reds the guard, because a
 * dead name gets pointed at a class that has returned on another surface:
 *   `.hero`, `.hero .song`, `.tools-toggle`, `.tools-peek`  — the drawer replaced the hero and its
 *     disclosure; `.hero` still RESOLVES, but only against TV markup, which is why the ban is by value.
 *   `.band .handle`, key `bandExpand`, hooks `bandExpand` / `bandExpandWired` — the band's own pull
 *     handle is gone; the successors are `bandOpen` + `bandOpenWired`.
 *   hook `drawerHandleOnly` — vaul's `handleOnly` was replaced by `data-vaul-no-drag` on `.np-fit`.
 *   `SEL.play` — it named an `aria-label="play/pause"` nothing carries, so it would resolve against
 *     nothing while reading as though the old flow worked. The whole transport is in the band row.
 *   no HOOK may name NowPlayingHero.svelte — the component is deleted.
 */

export const SEL = {
	// join
	nameInput: 'input[placeholder^="e.g."]',
	/** One `role="slider"` over 48 stops: a driver picks with `Home`/`End`/arrows, there is nothing to click. */
	colourRing: '.colour-ring',
	/** The BARE colour name ("pink"), the element already being role=radio. Only /components renders these. */
	swatch: (colourName: string) => ({ role: 'radio' as const, name: colourName }),
	/** The gallery picker's hue rail. /settings' native `input[type="color"]` must NOT match this. */
	hueSlider: 'input[type="range"]',
	submit: /Start singing/,
	/** How p8 tells a duplicate-name rejection from a clean join: both leave the form sitting there. */
	joinError: '.err[role=alert]',

	// phone remote
	/** The post-join readiness signal — but chrome on EVERY phone surface, so a caller that also needs "and
	 *  on home" must pair it with `location.pathname === '/'`. */
	homeReady: '.band',
	/** The row `--dock-h` is bound from — NOT `.band`. Handle plus strip is 80px; `.band` alone is the 56px
	 *  strip inside it, and a scrolling column must clear the WHOLE row. */
	dockRow: '.band-slot',
	/** The measured gate reads its padding-bottom to prove the docked row is RESERVED, not overlapping. */
	mainColumn: 'main',
	/** GuidingTrack's root; `.gt.disabled` is the subtree dimmed with opacity — the subject. */
	guidingTrackRoot: '.gt',
	guideReadout: '.gt-val',
	/** By shadcn's own `data-slot`, which survives a re-vendor. NOT `input[type="range"]` — see `hueSlider`. */
	slider: "[data-slot='slider']",
	/** The `<a>` PageHeader renders inside `.back-slot`: wrapper plus tag, because a `<Button href>`'s classes
	 *  can be re-vendored. `clearSearch` is a different act. */
	backToQueue: '.back-slot a',
	search: 'input[aria-label="Search a song or artist"]',
	/** Mark, field, spinner and clear control, in normal flow: neither docked nor sticky. */
	findBox: '.findbox',
	/** Empties the query, restoring queue and library in place — the whole way "back" from a search. */
	clearSearch: '[aria-label="Clear the search"]',
	songRow: '.row',
	songTitle: '.row .t',
	addTurn: '.row [data-testid="song-add"]',
	sing: '.row [data-testid="song-sing"]',
	queueRow: '.qrow',
	queueTitle: '.qrow .t',
	/** ProcessingCard renders `class="qrow proc …"`, so `.proc` is a SUBSET of `.qrow`: fine for existence,
	 *  but `queued + processing` double-counts and is never an exact total. */
	processing: '.proc',
	/** Unscoped, unlike `addTurn`/`sing` above: p3/p8/p10 ask whether a row offers an action AT ALL. */
	addAction: '[data-testid="song-add"]',
	singAction: '[data-testid="song-sing"]',
	/** "queued or ready" in one query — a comma union, so one branch resolving is enough. */
	addOrSing: '[data-testid="song-add"],[data-testid="song-sing"]',
	rowTitle: '.t',
	/** The empty-state line on `/`. NOT `[data-slot='empty']`, by the exact-token rule in
	 *  docs/E2E.md#anchor-discipline. */
	empty: '.encore-empty',
	/** `<Badge>`'s base class, which p10 contrast-checks. The phone home's chip BUTTONS are a different
	 *  control and carry `<Button>`'s classes. */
	chip: '.encore-chip',
	away: '.away',
	/** Attract-only markup p8 uses as a freshness gate: the fixed `Karaoke` label on the split panel. */
	isLabel: '.phrase-kick',
	strip: '.strip',
	stripPerson: '.strip .person',

	// the now-playing band (+layout.svelte → NowPlayingDrawer.svelte → NowPlayingBand.svelte)
	bandTransport: '.disc',
	/** The metadata block in its `<button>` form, and the ONLY way into the sheet for a keyboard or a screen
	 *  reader: `drawerHandle` is a `<div aria-hidden="true">` with no tabindex and no role. */
	bandOpen: '.meta-btn',
	/** Reach for this first for "what is playing": present with no gesture, where the sheet's own title is
	 *  below the fold — and a PLAYING entry renders no `.qrow` at all. */
	bandTitle: '.band .title',

	// the now-playing sheet (NowPlayingDrawer.svelte, which also composes the band as snap point 0)
	/** PRESENCE DOES NOT MEAN OPEN — see docs/E2E.md#presence-is-not-visibility. Encore's own class, not the
	 *  vendored `data-slot='drawer-content'`: that is sturdier but not UNIQUE to THIS drawer. */
	npDrawer: '.np-drawer',
	drawerHandle: "[data-slot='drawer-handle']",
	/** Renders only with a playing song, so its absence on an idle room is correct, not a missing hook. */
	songDoor: '.more-slot a',
	toolsBody: '.tools-body',
	toolsNote: '.tools-note',

	// transport. All three are in the band row at both sheet heights, so none needs a gesture first.
	skip: { role: 'button' as const, name: 'skip' },
	/** Capitalised, unlike `skip` — the two accessible names do not share a convention. */
	restart: { role: 'button' as const, name: 'Restart' },

	// TV
	/** `.on` appears when the WebSocket opens — the only barrier before the room state can be believed. */
	tvConnected: '.status.on',
	/** What "the room is fresh" must key on. NOT `lobbyAddress`, which appears only once somebody HAS joined. */
	attract: '.attract',
	joinAddress: '.jt-url',
	/** The room code every driver joins through — see the `lib/join.mjs` row in docs/E2E.md#shared-helpers. */
	attractCode: '.jt-code',
	stageHeadline: '.phrase-line',
	stageBrand: '.brand',
	/** Replaces the QR block when the advertised address is unroutable, so it is also how a flow tells "the
	 *  origin is not routable" apart from "someone already joined". */
	badQr: '.badqr',
	/** The notice's two text lines, state then remedy — p10 reads them, never clicks them. */
	badQrTitle: '.badqr-t',
	badQrFix: '.badqr-fix',
	/** An <audio> carries the instrumental, so a bare `video` selector silently skips every playing frame. */
	mediaEl: 'video, audio',
	/** A page's landmark heading — capture waits on it to know a route has painted. */
	pageHeading: 'h1',
	pageBody: 'body',
	lowerThird: '.lower-third',
	nowSong: '.ls-song',
	nowName: '.ls-name',
	stateNext: '.state-next',
	stateError: '.state-error',
	stateWaiting: '.state-waiting',
	/** "Is the stage in any non-playing state?" in one query — a comma union. */
	anyTransientState: '.state-error, .state-waiting, .state-next',
	/** Stage structure, read for existence and geometry, never clicked. `.tv` is the stage root, `.lobby` the
	 *  joined-but-not-playing screen (distinct from `.attract`, the empty room), `.interstitial` the
	 *  between-songs card, `.slot` a rotation media slot. */
	tvRoot: '.tv',
	lobby: '.lobby',
	interstitial: '.interstitial',
	slot: '.slot',
	slotVisible: '.slot.visible',
	/** Scoped past the pre-warm slot's paused <audio>, which is why p4 cannot just query `audio`. */
	slotVisibleAudio: '.slot.visible audio',
	seekTime: '.seekrow .time',
	/** p4 reads this element's scaleX transform for fractional progress. */
	seekFill: '.seekrow .track > i',
	upLabel: '.up-label',
	upName: '.up-name',
	upSong: '.up-song',
	/** Scoped forms — p10 measures these nested under .lower-third. */
	nowNameScoped: '.lower-third .ls-name',
	nowSongScoped: '.lower-third .ls-song',
	/** Lyrics overlay internals. `.reel` scrolls, `.viewport` clips it, `.row`/`.row.current` are the
	 *  lines, `.lyrics.unverified` flags ASR-only text, `.ls-source` names the provenance (`.ls-asr` its
	 *  amber guess variant), `.ball` is the bouncing dot. */
	lyrics: '.lyrics',
	lyricsReel: '.lyrics .reel',
	lyricsViewport: '.lyrics .viewport',
	lyricsRow: '.lyrics .row',
	lyricsRowCurrent: '.lyrics .row.current',
	lyricsUnverified: '.lyrics.unverified',
	lsSource: '.ls-source',
	lsAsr: '.ls-asr',
	ball: '.ball',
	/** The full-screen tap-to-start affordance the autoplay-block probe checks for. */
	autoplayHint: '.autoplay-hint',
	/** The scoped forms lobby-overlap.mjs queries. The lobby truncates nothing, so there is no overflow chip. */
	lobbyUrl: '.lobby .url',
	lobbyStrip: '.lobby .strip',
	lobbyStripPerson: '.lobby .strip .person',
	lobbyAddress: '.url',
	/** position:absolute above the lobby roster strip, so the roster must not paint a chip UNDER it — the
	 *  measured gate and lobby-overlap both sweep the roster against this. */
	fsBtn: '.fs-btn',
	/** Wrapper plus tag, so both keycaps are addressed without depending on a class a `<Button
	 *  variant="keycap">` would have to carry for the test's benefit. */
	keyBtn: '.key-cell button',
	keyLabel: '.key .lab',
	/** p10 measures its width to catch a capped grid leaving a void. */
	appShell: '.app-shell',
	/** By ALT TEXT: what a user is promised moves far less often than the class beside it. */
	qrImage: 'img[alt="QR code to join Encore"]',
	activeWord: '.lyrics .word.active',

	// settings (capture drives the room variants through these)
	/** By id, because a settings page has many controls with similar visible labels ("Off" appears in four
	 *  different pickers). */
	setting: (id: string) => `#${id}`,
	/** Capture drives the real tab rather than navigating to `?tab=`, so the control gating every setting
	 *  below it is exercised too. No id list is kept here: contract.test.ts asserts this helper's FORMAT. */
	settingsTab: (id: string) => `#tab-${id}`,
	SETTING_IDS: [
		'join-origin',
		'sync-mode',
		'queue-order',
		'tv-progress',
		'tv-background',
		'tv-visualizer',
		'lyrics-highlight',
		'lyrics-ball',
		'lyrics-font',
		'lyrics-case'
	],

	// dashboards (/stats, read by p11)
	dashCard: '.card',
	dashCardTable: '.card table',
	dashTileNumber: '.tile .n',
	/** A comma UNION. The `:not()` arguments are EXCLUSIONS the source need not render, and `+` resolves
	 *  like `>`: both sides must exist, their relative position is not source-checkable. */
	dashChartOrBody: '.card h2 + .bars, .card h2 + :not(table):not(.note):not(.scroller)',

	// admin (/admin — the entry-delete surface admin-delete drives)
	adminSongRow: "[data-slot='item']",
	/** The first-step Delete button: arms the confirm, and is not itself the commit. */
	adminDelete: "[data-act='arm-delete']",
	adminConfirmDelete: "[data-act='confirm-delete']"
} as const;

/** Picked by NAME, because that is what a screen reader — and therefore a role query — sees. Never by hex. */
export const PRESET_COLOUR_NAMES = ['violet', 'pink', 'green', 'amber', 'blue', 'coral', 'purple', 'mint'] as const;

export const HOOKS: Hook[] = [
	// join. The eight-preset ColourPicker's only remaining surface is the /components gallery.
	{
		id: 'nameInput',
		file: 'src/lib/components/JoinLanding.svelte',
		anchor: 'placeholder="e.g. Maya"',
		why: 'the flow types a singer name here'
	},
	{
		id: 'colourRing',
		file: 'src/lib/components/ColourRing.svelte',
		anchor: 'class="colour-ring"',
		why: 'SEL.colourRing addresses this class because the control names itself from a prop expression, so there is no literal aria-label to resolve'
	},
	{
		id: 'colourRingSlider',
		file: 'src/lib/components/ColourRing.svelte',
		anchor: 'role="slider"',
		why: 'the ring is not a native range input, so its keyboard operation is not inherited — a driver drives it with Home/End/arrows, and a keyboard guest reaches all 48 stops the same way'
	},
	{
		id: 'colourRingMounted',
		file: 'src/lib/components/JoinLanding.svelte',
		anchor: '<ColourRing',
		why: 'colourRing resolves against a COMPONENT; the identity pane rendering it is the separate claim that the join screen has a colour picker at all'
	},
	{
		id: 'swatchRadiogroup',
		file: 'src/lib/components/ColourPicker.svelte',
		anchor: 'aria-label={colorName(c)}',
		why: 'presets are selected by accessible name, not by hex; this picker is the /components gallery demo, since both identity panes use colourRing'
	},
	{
		id: 'colourNames',
		file: 'src/lib/components/ColourPicker.svelte',
		anchor: "'violet', 'pink', 'green', 'amber', 'blue', 'coral', 'purple', 'mint'",
		why: 'PRESET_COLOUR_NAMES here must match the names the gallery picker announces'
	},
	{
		id: 'hueSlider',
		file: 'src/lib/components/ColourPicker.svelte',
		anchor: 'aria-label="Pick your own color by hue"',
		why: 'the gallery picker proves a non-preset hue survives the round trip; the identity panes prove it through the ring, whose 48 stops are all non-preset by construction'
	},
	{
		id: 'submit',
		file: 'src/lib/components/JoinLanding.svelte',
		anchor: 'Start singing',
		why: 'the flow submits the join form by this label'
	},

	// phone remote
	{
		id: 'search',
		file: 'src/routes/+page.svelte',
		anchor: 'aria-label="Search a song or artist"',
		why: 'the flow searches the library through this field. The label is deliberately unchanged across every move of the box, so only the FILE ever has to be re-pointed'
	},
	{
		id: 'songDoor',
		file: 'src/lib/components/NowPlayingDrawer.svelte',
		anchor: 'class="more-slot"',
		why: 'the ··· door to /song/[mediaId]; SEL.songDoor addresses the anchor INSIDE this slot, because being a real <a href> is the property that matters'
	},
	{
		id: 'findBox',
		file: 'src/routes/+page.svelte',
		anchor: 'class="findbox"',
		why: 'the box the field sits in, at the TOP of the home column — the first thing above the queue rather than a separate surface'
	},
	{
		id: 'mainColumn',
		file: 'src/routes/+page.svelte',
		anchor: '<main',
		why: 'the gate measures this column reserving the docked band, so the element itself is load-bearing'
	},
	{
		id: 'npDrawer',
		file: 'src/lib/components/NowPlayingDrawer.svelte',
		anchor: 'class="np-drawer"',
		why: 'the sheet carrying song identity, the seek row, the transport and the live controls'
	},
	{
		id: 'drawerMounted',
		file: 'src/routes/+layout.svelte',
		anchor: '<NowPlayingDrawer',
		why: 'npDrawer can only resolve because the LAYOUT mounts the sheet; the component rendering the class is not the same claim as the app showing it. This is the TOP of a two-link chain (layout → drawer → band) whose other link is bandMounted'
	},
	{
		id: 'drawerHandle',
		file: 'src/lib/components/ui/drawer/drawer-handle.svelte',
		anchor: 'data-slot="drawer-handle"',
		why: 'losing it makes the sheet silently undraggable rather than merely unadorned — shadcn ships a decorative div in its place, which is the trap this file exists to avoid'
	},
	{
		id: 'toolsBody',
		file: 'src/lib/components/NowPlayingDrawer.svelte',
		anchor: 'class="tools-body"',
		why: 'the live-controls body; it means a song is playing, not that a disclosure has been revealed'
	},
	{
		id: 'toolsNote',
		file: 'src/lib/components/NowPlayingDrawer.svelte',
		anchor: 'class="tools-note"',
		why: 'the no-shared-drag-surface rule IS this sentence; p16 asserts its presence for a dead control and its absence for a live one'
	},
	{
		id: 'guidingTrackRoot',
		file: 'src/lib/components/GuidingTrack.svelte',
		anchor: 'class:disabled={!available}',
		why: 'it is a containment question about THIS dimmed subtree, so the dimming is the anchor'
	},
	{
		id: 'guideReadout',
		file: 'src/lib/components/GuidingTrack.svelte',
		anchor: 'class="gt-val"',
		why: "a dead guiding track reads 'Off' rather than a live-looking percentage"
	},
	{
		id: 'slider',
		file: 'src/lib/components/ui/slider/slider.svelte',
		anchor: 'data-slot="slider"',
		why: "the vendored slider is addressed by shadcn's own data-slot, which survives a re-vendor"
	},
	{
		id: 'backToQueue',
		file: 'src/routes/song/[mediaId]/+page.svelte',
		anchor: "back={{ href: '/', label: 'Back to the queue' }}",
		why: 'a pushed phone surface must OFFER a way back to the queue; this is a route asking PageHeader for one'
	},
	{
		id: 'backSlot',
		file: 'src/lib/ui/PageHeader.svelte',
		anchor: 'class="back-slot"',
		why: 'SEL.backToQueue addresses the anchor PageHeader renders inside this wrapper — the two halves of that control live in two files, so both are pinned'
	},
	{
		id: 'homeReady',
		file: 'src/lib/components/NowPlayingBand.svelte',
		anchor: 'class="band"',
		why: 'the band is the chrome a JOINED singer gets, so its presence is the post-join readiness signal both call sites poll for'
	},
	{
		id: 'bandMounted',
		file: 'src/lib/components/NowPlayingDrawer.svelte',
		anchor: '<NowPlayingBand',
		why: "homeReady only holds because the sheet COMPOSES the band as its snap-0 content on every phone surface. The anchor is `<`-prefixed so the layout's leftover import cannot satisfy it — it keys on the band being RENDERED"
	},
	{
		id: 'bandRestart',
		file: 'src/lib/components/NowPlayingBand.svelte',
		anchor: 'aria-label="Restart"',
		why: 'restart is in the band row at BOTH sheet heights, so a driver can tap it with no gesture'
	},
	{
		id: 'bandSkip',
		file: 'src/lib/components/NowPlayingBand.svelte',
		anchor: 'aria-label="skip"',
		why: 'the other half of the always-visible pair — pinned beside restart because the two are revealed and hidden together, so a change that loses one loses both'
	},
	{
		id: 'bandTransport',
		file: 'src/lib/components/NowPlayingBand.svelte',
		anchor: "aria-label={isPlaying ? 'Pause' : 'Play'}",
		why: "the band's transport disc; anchored on the EXPRESSION because that is the only source text either label has, and SEL.bandTransport can only address it by class"
	},
	{
		id: 'dockRow',
		file: 'src/lib/components/NowPlayingDrawer.svelte',
		anchor: 'class="band-slot"',
		why: "the docked row whose clientHeight IS --dock-h (bound through the drawer's bandH prop and written by the layout). `.band` is the strip inside it and is 24px shorter"
	},
	{
		id: 'bandOpen',
		file: 'src/lib/components/NowPlayingBand.svelte',
		anchor: 'class="meta meta-btn"',
		why: 'the band\'s expand control in its BUTTON form. Anchored on the class pair because the accessible name interpolates the song title, so there is no literal for a role+name hook; the pair also distinguishes it from the inert `<div class="meta">` the gallery renders'
	},
	{
		id: 'bandOpenWired',
		file: 'src/lib/components/NowPlayingDrawer.svelte',
		anchor: 'onexpand={() =>',
		why: 'the half that makes `bandOpen` real: the button is gated on `{#if onexpand}`, so a hook on the component alone would pass while nothing passed one. Deleting this wiring reds here rather than silently returning the sheet to pointer-only'
	},
	{
		id: 'drawerBodyNoDrag',
		file: 'src/lib/components/NowPlayingDrawer.svelte',
		anchor: '<div class="np-fit" data-vaul-no-drag',
		why: 'the band row is the only drag surface, and this attribute is what keeps a body made of sliders off it. Without it vaul drags from anywhere and the guiding-track thumb and the dismiss gesture become one gesture, with the drawer winning as the ancestor — a gesture collision rather than a missing element. A control added to the sheet lands inside `.np-fit` and is excluded by construction'
	},
	{
		id: 'bandTitle',
		file: 'src/lib/components/NowPlayingBand.svelte',
		anchor: 'class="title"',
		why: 'the playing song read with no gesture, on chrome present across every phone surface — needed because a playing entry renders no queue row'
	},
	{
		id: 'songRow',
		file: 'src/lib/components/SongRow.svelte',
		anchor: 'class="row ',
		why: 'search results are read from .row'
	},
	{
		id: 'addTurn',
		file: 'src/lib/components/SongRow.svelte',
		anchor: 'data-testid="song-add"',
		why: 'a ready song is queued with this button'
	},
	{
		id: 'sing',
		file: 'src/lib/components/SongRow.svelte',
		anchor: 'data-testid="song-sing"',
		why: 'a raw song has ONE action that both queues and starts the process'
	},
	{
		id: 'queueRow',
		file: 'src/lib/components/QueueRow.svelte',
		anchor: 'class="qrow',
		why: 'the rotation is read from .qrow to compare order across phones'
	},
	{
		id: 'processing',
		file: 'src/lib/components/ProcessingCard.svelte',
		anchor: '.proc',
		why: 'a processing song holds its rotation slot; .proc is a subset of .qrow, so either class proves it'
	},
	{
		id: 'emptyState',
		file: 'src/lib/components/ui/empty/empty.svelte',
		anchor: "'encore-empty'",
		why: 'the class is an Encore deviation inside a copy-in, so it is exactly the kind of thing a re-vendor drops silently'
	},
	{
		id: 'skip',
		file: 'src/lib/components/NowPlayingBand.svelte',
		anchor: 'aria-label="skip"',
		why: 'the flow advances the rotation to prove round-robin ordering'
	},

	// TV
	{
		id: 'attract',
		file: 'src/routes/tv/+page.svelte',
		anchor: 'class="attract"',
		why: 'the empty-room stage; the flow gates on THIS to know the room is fresh, not on the lobby address'
	},
	{
		id: 'attractCode',
		file: 'src/routes/tv/+page.svelte',
		anchor: 'class="jt-code"',
		why: "the attract panel's room code — the largest element on that screen, and the value every driver reads to join through the scanned path (see lib/join.mjs)"
	},
	{
		id: 'joinAddress',
		file: 'src/routes/tv/+page.svelte',
		anchor: 'class="jt-url"',
		why: 'the typed join address on the attract split panel — the flow asserts it is legible at ten feet'
	},
	{
		id: 'stageHeadline',
		file: 'src/routes/tv/+page.svelte',
		anchor: 'class="phrase-line"',
		why: 'the attract rotating phrase; the flow asserts it clears the ten-foot floor'
	},
	{
		id: 'stageBrand',
		file: 'src/routes/tv/+page.svelte',
		anchor: 'class="brand"',
		why: 'the wordmark whose inset proves stage chrome clears the overscan region'
	},
	{
		id: 'lowerThird',
		file: 'src/routes/tv/+page.svelte',
		anchor: 'class="lower-third"',
		why: 'proves the TV names who is singing once playback starts'
	},
	{
		id: 'nowSong',
		file: 'src/routes/tv/+page.svelte',
		anchor: 'class="ls-song"',
		why: 'the flow compares this before and after a skip'
	},
	{
		id: 'transientStates',
		file: 'src/routes/tv/+page.svelte',
		anchor: 'state-error',
		why: 'the three transient states must stay distinguishable, so each keeps its own class'
	},
	{
		id: 'tvSongIntro',
		file: 'src/routes/tv/+page.svelte',
		anchor: 'class="interstitial takeover state-next"',
		why: 'the song-intro card names who is up before playback; the flow reads .up-song / .up-name off it'
	},

	// guiding track (phone now-playing controls)
	{
		id: 'guidingTrack',
		file: 'src/lib/components/GuidingTrack.svelte',
		anchor: 'aria-label="Guiding track — original vocal level"',
		why: 'the flow mixes the original vocals back in through this control — a <Slider>, not a range input, though the aria-label anchoring it is deliberately unchanged'
	},

	// identity (phone header → /settings?tab=you → name / colour / leave). The header is only a LINK: a name
	// editable in two places is two save paths that can disagree.
	{
		id: 'profileOpen',
		file: 'src/routes/+page.svelte',
		anchor: 'aria-label="Your profile"',
		why: 'the flow reaches identity from the header me-button, which links to the settings You tab'
	},
	{
		id: 'profileName',
		file: 'src/routes/settings/+page.svelte',
		anchor: 'id="profile-name"',
		why: 'the flow edits the singer name in the settings You tab through this field'
	},
	{
		id: 'profileLeave',
		file: 'src/routes/settings/+page.svelte',
		anchor: 'Leave the room',
		why: 'the flow reaches the destructive leave-the-room action by this label'
	},
	{
		id: 'settingsScopes',
		file: 'src/routes/settings/+page.svelte',
		anchor: 'aria-label="Settings scope"',
		why: 'the three scope tabs are how every other settings control is reached at all'
	},

	{
		id: 'queueAway',
		file: 'src/lib/components/QueueRow.svelte',
		anchor: 'class="away"',
		why: 'the flow proves an unreachable singer is marked away so the room can decide to skip them'
	},
	{
		id: 'tvVisualizer',
		file: 'src/routes/settings/+page.svelte',
		anchor: 'id="tv-visualizer"',
		why: 'the flow selects which audio visualizer paints the TV stage'
	},
	{
		id: 'statsPage',
		file: 'src/routes/stats/+page.svelte',
		anchor: 'title="Party stats"',
		why: 'the public stats page landmark the flow lands on at /stats'
	},
	{
		id: 'metricsPage',
		file: 'src/routes/metrics/+page.svelte',
		anchor: 'title="Processing metrics"',
		why: 'the internal metrics page landmark the flow lands on at /metrics'
	},

	// Anchors the CAPTURE flow depends on. Registered because capture is a long stateful chain: a moved
	// anchor does not red usefully, it produces a plausible-looking but wrong set of frames.
	{
		id: 'qrImage',
		file: 'src/lib/tv/JoinBadge.svelte',
		anchor: 'alt="QR code to join Encore"',
		why: 'capture waits on this to know the attract screen has painted'
	},
	{
		id: 'badQr',
		file: 'src/lib/tv/JoinBadge.svelte',
		anchor: 'No external IP set',
		why: 'the misconfigured-origin frame is the first-run failure worth showing; capture drives it deliberately. The state is a one-line notice beside a QR that still renders, so this line is the anchor rather than a card headline'
	},
	{
		id: 'activeWord',
		file: 'src/lib/tv/LyricsOverlay.svelte',
		anchor: 'class:active={wi === ballWord}',
		why: 'the ONLY proof the lyrics reel is advancing rather than frozen on line one'
	},
	{
		id: 'stageBg',
		file: 'src/routes/tv/+page.svelte',
		anchor: 'class="stage-bg"',
		why: 'the stage-look frames are shot against this layer'
	},
	{
		id: 'settingJoinOrigin',
		file: 'src/routes/settings/+page.svelte',
		anchor: 'id="join-origin"',
		why: 'capture flips the advertised party address to shoot the unreachable-QR screen'
	},
	{
		id: 'settingQueueOrder',
		file: 'src/routes/settings/+page.svelte',
		anchor: 'id="queue-order"',
		why: 'the house rule picker the room-settings frame is centred on'
	},
	{
		id: 'settingTvProgress',
		file: 'src/routes/settings/+page.svelte',
		anchor: 'id="tv-progress"',
		why: 'capture shoots all four progress placements through this picker'
	},
	{
		id: 'settingTvBackground',
		file: 'src/routes/settings/+page.svelte',
		anchor: 'id="tv-background"',
		why: 'capture shoots every stage look through this picker'
	},
	{
		id: 'settingLyricsBall',
		file: 'src/routes/settings/+page.svelte',
		anchor: 'id="lyrics-ball"',
		why: 'capture shoots each marker style through this picker'
	},
	{
		id: 'settingLyricsHighlight',
		file: 'src/routes/settings/+page.svelte',
		anchor: 'id="lyrics-highlight"',
		why: 'capture shoots each highlight mode through this picker'
	},
	{
		id: 'settingLyricsFont',
		file: 'src/routes/settings/+page.svelte',
		anchor: 'id="lyrics-font"',
		why: 'capture shoots the reel in a second face through this picker'
	},
	{
		id: 'settingSyncMode',
		file: 'src/routes/settings/+page.svelte',
		anchor: 'id="sync-mode"',
		why: 'capture puts the deployment on line-sync to shoot the clamp notice, then puts it back'
	},
	{
		id: 'settingLyricsCase',
		file: 'src/routes/settings/+page.svelte',
		anchor: 'id="lyrics-case"',
		why: 'capture shoots upper-case words through this picker'
	},
	{
		id: 'adminSongRow',
		file: 'src/routes/admin/+page.svelte',
		anchor: '<Item.Root',
		why: 'the admin-delete probe reads deletable rows on /admin from the Item row root'
	},
	{
		id: 'adminDelete',
		file: 'src/routes/admin/+page.svelte',
		anchor: 'data-act="arm-delete"',
		why: 'the probe clicks the first-step Delete button to arm the confirm'
	},
	{
		id: 'adminConfirmDelete',
		file: 'src/routes/admin/+page.svelte',
		anchor: 'data-act="confirm-delete"',
		why: 'the probe waits on the second-step confirm button to shoot the confirm state'
	}
];
