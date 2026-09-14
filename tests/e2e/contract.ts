/*
 * THE E2E SELECTOR CONTRACT.
 *
 * One declaration of every hook the browser flow drives, imported by BOTH the flow (party.mjs) and the
 * guard (contract.test.ts) so the two can never disagree about what the UI looks like.
 *
 * WHY THIS EXISTS. The previous e2e was a detached script, and it rotted silently: it clicked a
 * `Library` tab that was deleted when search was unified around readiness, selected a colour by an
 * aria-label of `color #ff5cae` when the real label had become `violet swatch`, and read rows from
 * `.result` after the component started rendering `.row`. Three separate selector families had moved
 * and the suite stayed green the whole time, because nothing in `bun test` ever looked at the script.
 *
 * The guard is the load-bearing half. It needs no browser, so it runs everywhere `bun test` runs, on
 * every change, and it fails the moment a selector's anchor disappears from the source. The browser
 * flow proves the app actually works; the guard proves the flow is still aimed at the app.
 *
 * Each entry names the source it must exist in, so a failure says which file moved the ground.
 */

/** A hook the e2e drives, plus the source anchor proving it still exists. */
export interface Hook {
	/** What the flow calls it. */
	id: string;
	/** Source file, relative to .. */
	file: string;
	/** Substring that must appear in that file. The anchor. */
	anchor: string;
	/** Why the flow needs it — so a failure explains what breaks, not just that something moved. */
	why: string;
}

/** How the flow addresses each hook at runtime. */
export const SEL = {
	// ── join ──────────────────────────────────────────────────────────────
	nameInput: 'input[placeholder^="e.g."]',
	/** Presets are a radiogroup; the accessible name is the colour's NAME, not its hex. */
	/*
	 * The preset swatch, addressed by the radio's accessible name.
	 *
	 * That name is the BARE colour name ("pink"), not "pink swatch": the element already has
	 * role=radio, so announcing "swatch" was noise a screen reader had to sit through on all eight.
	 * This helper is where the format lives, and it has now drifted in BOTH directions -- the header
	 * note above records the driver still asking for `color #ff5cae` after the label became
	 * "violet swatch", and then this file asking for "violet swatch" after the label became "violet".
	 * The name LIST is asserted against the component in contract.test.ts; so is this FORMAT, because
	 * matching lists cannot tell you the wrapper around each entry is still right.
	 */
	swatch: (colourName: string) => ({ role: 'radio' as const, name: colourName }),
	hueSlider: 'input[type="range"]',
	submit: /Start singing/,
	/*
	 * The join-page error announcement: `<div class="err" role="alert">` (lib/components/JoinLanding.svelte).
	 * A class + UNQUOTED attribute compound the p8-presence probe reads to tell a duplicate-name
	 * rejection (form sits on /join with this alert) from a clean join (lands on / with the search box).
	 * Migrated here from KNOWN_OFFENDERS as Group B of the per-driver SEL split.
	 */
	joinError: '.err[role=alert]',

	// ── phone remote ──────────────────────────────────────────────────────
	/*
	 * HOME IS THE QUEUE (direction A), and since the 2026-09-09 owner correction the SEARCH
	 * BOX IS DOCKED AT THE BOTTOM OF IT AT ALL TIMES for a joined singer — it is the add affordance, so
	 * there is no `+ Add a turn` push and no browse mode. Typing expands results upward IN PLACE.
	 *
	 * `homeReady` is the docked search band, which exists as soon as the joined home has rendered, so it
	 * is the post-join readiness check — and because the search box lives inside it, reaching `search` no
	 * longer needs a click. `openBrowseFromHome()` in `lib/phone.mjs` therefore just waits for the box;
	 * it is kept (rather than removed from 20 call sites) so a future IA change has one place to edit.
	 *
	 * RETIRED: `openBrowse` was `.cta-dock .cta`, the `+ Add a turn` button that pushed `?browse=1`
	 * to reveal the search box. The owner correction docked the box permanently and deleted the button, so the anchor is
	 * absent from every source — an anchor guard for markup nobody renders reports a permanent failure,
	 * not an invariant. The search box (`search` below) is now reached with no click.
	 */
	homeReady: '.search-dock',
	/**
	 * The scrolling content column. The measured gate reads its padding-bottom to prove the docked band
	 * is RESERVED rather than overlapping the list (XR-PH-12), which is a geometry claim about this
	 * element and so cannot be spelled out at the call site.
	 */
	mainColumn: 'main',
	/** The now-playing hero — the joined home's own surface, and where the transport lives under direction A. */
	hero: '.hero',
	/**
	 * The playing song's TITLE on the hero. Load-bearing for the rotation checks: the PLAYING entry is
	 * not a `.qrow` (its status is 'playing', which `queued` filters out), so a flow asking "is my song
	 * in the rotation?" has to read the hero as well as the rows, or it reads zero for the very first
	 * song of the night.
	 */
	heroTitle: '.hero .song',

	/*
	 * The hero's LIVE-CONTROLS disclosure and the guiding track inside it (XR-PH-15/XR-PH-03).
	 * Added when those claims moved from the mount rung to p16: GuidingTrack's control is
	 * Bits UI's slider now, which needs a real layout engine to exist, so `bun test` could no longer
	 * mount the hero at all.
	 */
	/** The disclosure's toggle; `aria-expanded` on it is how a driver knows the panel is open. */
	toolsToggle: '.tools-toggle',
	/** The disclosure BODY. The explanation lives here, never in the collapsed summary. */
	toolsBody: '.tools-body',
	/** The sentence explaining a control that cannot work. Absent when nothing is owed. */
	toolsNote: '.tools-note',
	/** The collapsed summary's peek text, which must NOT carry the explanation. */
	toolsPeek: '.tools-peek',
	/** GuidingTrack's root; `.gt.disabled` is the subtree dimmed with opacity — XR-PH-03's subject. */
	guidingTrackRoot: '.gt',
	/** Its readout, which reads 'Off' rather than a live-looking number when the track is dead. */
	guideReadout: '.gt-val',
	/**
	 * The vendored slider's root, by shadcn's OWN `data-slot` rather than an Encore class. That
	 * choice is the point: a class in a copied-in component belongs to the component and a re-vendor
	 * may rename it, while `data-slot` is the contract shadcn itself maintains.
	 *
	 * Note it is NOT `input[type="range"]` — see `hueSlider`, which still is one. GuidingTrack's
	 * control stopped being a native range when it moved to the vendored <Slider>; the colour picker's hue rail did not.
	 */
	slider: "[data-slot='slider']",
	/** Back to the queue from the results view — it CLEARS the search. Renders only while a query
	 *  is present; with an empty box the queue is already showing. The phone's own Back gesture at the
	 *  empty-box home leaves the room, as it always has under direction A. */
	backToQueue: '[data-testid="back-to-queue"]',
	search: 'input[aria-label="Search a song or artist"]',
	/**
	 * The docked search band (the SOLE home band, now that the readiness chips and the browse disclosure are gone). Search is bottom-anchored in the
	 * thumb zone and the results stack upward from it, so this band — not the search box's own wrapper —
	 * is what publishes `--dock-h` and what the measured gate reads the band contract off. It is docked
	 * on home for a joined singer at all times, so it is also `homeReady` (same selector, semantic alias
	 * for the post-join readiness signal).
	 */
	searchDock: '.search-dock',
	songRow: '.row',
	songTitle: '.row .t',
	addTurn: '.row .add',
	sing: '.row .sing',
	queueRow: '.qrow',
	queueTitle: '.qrow .t',
	/*
	 * A song processing in the rotation. ProcessingCard renders `class="qrow proc ..."`, so `.proc` is a
	 * SUBSET of `.qrow`, not a sibling of it — the flow's `queued + processing > 0` therefore
	 * double-counts a processing card. Harmless for an existence check, and named here so nobody later
	 * reads an exact total off the pair.
	 */
	processing: '.proc',
	/*
	 * Bare remote-list handles the probes read directly (not scoped under .row like addTurn/sing/songTitle
	 * above): p3/p8/p10 query `.add`, `.sing`, `.t` on their own to check an action or a title exists at all,
	 * and p8/p12 read the presence and empty-state chrome. Named here so those reads come through the
	 * contract instead of being spelled out per probe (migrated from KNOWN_OFFENDERS).
	 */
	addAction: '.add',
	singAction: '.sing',
	/** "queued or ready" in one query — p8 asks whether a row offers EITHER queue action; a comma
	 *  union, so one branch resolving is enough. */
	addOrSing: '.add,.sing',
	rowTitle: '.t',
	empty: '.empty',
	/*
	 * RETIRED: `readyChip` was `.chips button.ok`, the Ready readiness filter chip. Direction B
	 * deleted the readiness chip row — one of the four concurrent filter mechanisms — so the anchor no
	 * longer exists in any source and the entry could only resolve vacuously or red. p12-search reached
	 * `readyEmptyState` by clicking it; it now reaches the same copy by typing a non-matching query,
	 * which is the condition that empty state was always really about. `browseToggle` ('.browse-toggle')
	 * went with the same diff and for the same reason: the disclosure it opened is gone.
	 */
	/** A SongRow status/kind chip — the SCALING probe (p10) contrast-checks its text on the remote.
	 *  Migrated from KNOWN_OFFENDERS (Group E).
	 *
	 *  RE-ANCHORED to `.encore-chip`, which is what the control actually carries. `<Badge>` owns these
	 *  chips and its base class is `encore-chip`, so `.chip` never matched a SongRow chip after that
	 *  migration — it was resolving against the phone home's chip BUTTONS instead, which are a different
	 *  control and are now `<Button>`. The mis-anchor only surfaced when those buttons migrated and the
	 *  selector suddenly matched nothing at all. */
	chip: '.encore-chip',
	away: '.away',
	/* Attract-only markup used as a freshness gate by p8: the fixed `Karaoke` label on the split attract
	   panel (the old `.is-label` "Nobody here yet" strip was removed with the previous attract design). */
	isLabel: '.phrase-kick',
	strip: '.strip',
	stripPerson: '.strip .person',

	// ── transport (on the now-playing hero under direction A) ─────────────
	play: { role: 'button' as const, name: 'play/pause' },
	skip: { role: 'button' as const, name: 'skip' },
	restart: { role: 'button' as const, name: 'restart' },

	// ── TV ────────────────────────────────────────────────────────────────
	/*
	 * THE EMPTY-ROOM STAGE, and the three things asserted on it.
	 *
	 * `.attract` is the state itself (the split attract panel). It is what "the room is empty" is
	 * keyed on: the flow used to wait for `.url`, which is the LOBBY's typed address (TvLobby.svelte)
	 * and therefore appears only once somebody HAS joined. The gate was inverted — it could not pass on
	 * the fresh empty room it demanded.
	 *
	 * The attract screen's own typed address is `.jt-url` (in the right join panel) and its read-once
	 * headline is `.phrase-line` (the rotating phrase). BOTH the QR and the typed lines live behind the
	 * reachable-origin branch: when the advertised address is loopback or a bare hostname the TV
	 * replaces the QR block with `.badqr` (correctly — a QR to an unroutable address is a
	 * working-looking dead end). So `.badqr` is part of the contract too, because it is how the flow
	 * tells "the origin is not routable" apart from "someone already joined".
	 */
	/** The TV's socket indicator. `.on` appears when the WebSocket opens, which is the only barrier the
	 *  flow has before the room state it renders can be believed. */
	tvConnected: '.status.on',
	attract: '.attract',
	joinAddress: '.jt-url',
	stageHeadline: '.phrase-line',
	/** The wordmark whose inset proves stage chrome clears the overscan region. */
	stageBrand: '.brand',
	badQr: '.badqr',
	/*
	 * The `.badqr` operator-notice card's own text lines the SCALING probe (p10) contrast-checks —
	 * migrated from KNOWN_OFFENDERS (Group E of the per-driver split).
	 * All three are children of `.badqr` in src/lib/tv/JoinBadge.svelte: `.badqr-t` is the
	 * "Join QR unavailable" title, `.badqr-b` the body paragraph, `.badqr-fix` the fix hint. p10 reads
	 * them for existence/geometry/contrast, never clicks them.
	 */
	badQrTitle: '.badqr-t',
	badQrBody: '.badqr-b',
	badQrFix: '.badqr-fix',
	/** The TV's master/guide media elements. An <audio> carries the instrumental, so a bare `video`
	 *  selector read -1 forever and every playing frame in the gallery was silently skipped. */
	mediaEl: 'video, audio',
	/** A page's landmark heading — capture waits on it to know a route has painted. */
	pageHeading: 'h1',
	/** Everything rendered, for an assertion about whether a screen says ANYTHING at all. */
	pageBody: 'body',
	lowerThird: '.lower-third',
	nowSong: '.ls-song',
	nowName: '.ls-name',
	stateNext: '.state-next',
	stateError: '.state-error',
	stateWaiting: '.state-waiting',
	/** The three transient TV states as one union — p8 asks "is the stage in any non-playing state?" in a
	 *  single query; the resolver treats a comma list as a union, so one branch existing is enough. */
	anyTransientState: '.state-error, .state-waiting, .state-next',
	/*
	 * TV STAGE STRUCTURE the timing/scaling probes read (migrated from KNOWN_OFFENDERS).
	 *
	 * `.tv` is the stage root; `.lobby` is the joined-but-not-playing screen (distinct from `.attract`,
	 * the empty room); `.interstitial` is the between-songs card. `.slot` is a rotation media slot and
	 * `.slot.visible` the one currently on screen. `.up-*` are the "up next" label/name/song lines the
	 * gapless probe measures. All are read for existence/geometry, never clicked.
	 */
	tvRoot: '.tv',
	lobby: '.lobby',
	interstitial: '.interstitial',
	slot: '.slot',
	slotVisible: '.slot.visible',
	/** The master audio element inside the visible slot — the audible stage master (p4 scopes past the
	 *  pre-warm slot's paused <audio>). A descendant selector ending in a bare tag; the resolver models
	 *  the `.slot.visible` class-compound part and the `audio` tag part. */
	slotVisibleAudio: '.slot.visible audio',
	/** The transport's elapsed-time readout inside the seek row (p4 reads its text). */
	seekTime: '.seekrow .time',
	/** The seek-row fill bar's inner element — p4 reads its scaleX transform for a fractional progress
	 *  check. A `>` child combinator into a bare tag; the resolver models the `.seekrow .track`
	 *  class-compound parts and the `i` tag part. */
	seekFill: '.seekrow .track > i',
	upLabel: '.up-label',
	upName: '.up-name',
	upSong: '.up-song',
	/** The lower-third's own name/song lines, scoped — p10 measures these nested under .lower-third. */
	nowNameScoped: '.lower-third .ls-name',
	nowSongScoped: '.lower-third .ls-song',
	/*
	 * LYRICS OVERLAY internals the lyrics probe reads. `.lyrics` is the overlay; `.reel` scrolls,
	 * `.viewport` clips it, `.row`/`.row.current` are the lines, `.lyrics.unverified` flags ASR-only text,
	 * `.ls-source` is the provenance badge naming the lyrics source (`.ls-asr` = its amber guess variant),
	 * `.ball` is the bouncing dot. `activeWord` (below) is the word
	 * the ball sits on.
	 */
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
	/*
	 * LOBBY strip the overlap probe reads. `.strip` is the joined-singers ribbon, `.person` a
	 * chip in it, `.url` the lobby's typed join address. Scoped forms are what lobby-overlap.mjs queries.
	 * The "+N more" overflow chip is RETIRED (XR-TV-14): the lobby now shows every guest with no
	 * truncation, so there is no overflow chip and no `.person.more` anchor.
	 */
	lobbyUrl: '.lobby .url',
	lobbyStrip: '.lobby .strip',
	lobbyStripPerson: '.lobby .strip .person',
	lobbyAddress: '.url',
	/* The bottom-right fullscreen control. It is position:absolute above the lobby roster strip,
	   so the roster must not paint a chip UNDER it (XR-TV-14) — the measured gate and lobby-overlap
	   probe sweep the roster against this. */
	fsBtn: '.fs-btn',
	/* KEY-SHIFT control the transpose probe reads: the +/- buttons and the current-key label.
	   RE-ANCHORED from `.key .key-btn` when the pair became `<Button variant="keycap">`. The class went
	   with the hand-rolled rule; `.key-cell` is the page-rendered wrapper that survives, and the tag is
	   what the component renders, so this addresses the same two controls without depending on a class
	   the component would have to carry for the test's benefit. */
	keyBtn: '.key-cell button',
	keyLabel: '.key .lab',
	/* The remote's app shell (p10 measures its width to catch a capped grid leaving a void). */
	appShell: '.app-shell',
	/*
	 * The join QR, addressed by the ALT TEXT rather than a class.
	 *
	 * capture.mjs used to wait for `.url` to decide the attract screen had painted. That class no
	 * longer exists — the short address is `.u` inside `.hero`/`.corner` — so the very first step of a
	 * capture run timed out and took all 40-odd frames with it. The alt text is what a user is
	 * promised, so it moves far less often than the presentational class beside it, and anchoring here
	 * means `bun test` reports the move instead of a capture run discovering it.
	 */
	qrImage: 'img[alt="QR code to join Encore"]',
	/** The word the ball is currently sitting on — proof the reel is MOVING, not merely rendered. */
	activeWord: '.lyrics .word.active',

	// ── settings (capture drives the room variants through these) ──────────
	/*
	 * Every room/global control the capture flips, by id. Addressed by id because these are real
	 * <select>/<input> elements with stable ids, and because a settings page has many controls whose
	 * visible labels are similar ("Off" appears in four different pickers).
	 */
	setting: (id: string) => `#${id}`,
	/**
	 * A settings SCOPE tab, by id. Capture drives the real tab rather than navigating to `?tab=`, so
	 * the control that gates every setting below it is exercised too. The ids are template-interpolated
	 * in the source (`id="tab-{t.id}"`), so there is no `id="tab-you"` to grep for and no id list is
	 * kept here — a hand-kept copy of the page's `TABS` registry is exactly the duplicated vocabulary
	 * this repo keeps getting wrong. What is asserted instead is this helper's FORMAT against the
	 * page's own interpolated attribute; see contract.test.ts.
	 */
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

	// ── dashboards (the stats/metrics /stats page the p11 probe reads) ─────
	/*
	 * The /stats dashboard's card/tile/chart hooks the p11-dashboards probe reads. Migrated here from
	 * KNOWN_OFFENDERS as Group D of the per-driver SEL split — the ENGINE-HEAVY
	 * group, because `dashChartOrBody` uses shapes the resolver could not model on base: the `+`
	 * adjacent-sibling combinator and a `:not()` exclusion chain. The resolver now models both (see
	 * selectorResolves in contract.test.ts), so all four resolve against the /stats page's own markup.
	 */
	/** A dashboard card — `<div class="card">` / `<div class="card tile …">` (routes/stats/+page.svelte). */
	dashCard: '.card',
	/** A table inside a dashboard card — the step/stage timing tables the probe pulls text from. */
	dashCardTable: '.card table',
	/** A stat tile's headline number — `<span class="n">` inside a `.card.tile` (routes/stats/+page.svelte). */
	dashTileNumber: '.tile .n',
	/*
	 * The chart element a card's <h2> heads: `.card h2 + .bars` (the <Bars> chart's `<ol class="bars">`),
	 * or the same slot as anything-but-a-table/note/scroller — `.card h2 + :not(table):not(.note):not(.scroller)`.
	 * A comma UNION so one branch resolving is enough; the first branch's `.card`/`h2`/`.bars` parts
	 * carry it. The `:not()` arguments are EXCLUSIONS the source need not render (see the resolver's
	 * `:not()` branch), and the `+` sibling combinator resolves like `>`/descendant — both sides must
	 * exist, their relative position is not source-checkable.
	 */
	dashChartOrBody: '.card h2 + .bars, .card h2 + :not(table):not(.note):not(.scroller)',
	// ── admin dashboard (/admin — the an earlier change entry-delete surface the admin-delete probe drives) ──
	/*
	 * RE-POINTED BY THE PRIMITIVE-ADOPTION PASS. These three were `.song-row`, `.delete` and `.confirm .danger` — classes
	 * on a hand-rolled <li> and three hand-rolled buttons. The row is Item.Root/Content/Actions and the
	 * controls are Button variants now, so the classes are gone along with 13 CSS rules and all seven of
	 * this page's hardcoded colours. The anchors moved to things that describe the CONTROL rather than its
	 * styling: the row keys on Item's own `data-slot`, and the two destructive steps key on the per-song
	 * `aria-label` added in the same change (they had none, so AT announced "Delete, button" N times with
	 * nothing to tell the rows apart). A styling class is a poor test handle — that is what left an
	 * orphaned `.chip` in LyricsReselect — and an aria-label cannot be deleted without a real a11y
	 * regression, which makes it the sturdier contract.
	 */
	/** A deletable song row on /admin: <Item.Root> (routes/admin/+page.svelte). */
	adminSongRow: "[data-slot='item']",
	/** The first-step Delete button on an admin song row — arms the confirm. */
	adminDelete: "[data-act='arm-delete']",
	/** The second-step confirm button: the destructive commit, distinct from the Delete arm. */
	adminConfirmDelete: "[data-act='confirm-delete']"
} as const;

/**
 * Colour names the join picker exposes as accessible labels. The flow picks by name because that is
 * what a screen reader — and therefore a role-based query — actually sees. The hex is deliberately not
 * used: it was the thing that rotted.
 */
export const PRESET_COLOUR_NAMES = ['violet', 'pink', 'green', 'amber', 'blue', 'coral', 'purple', 'mint'] as const;

export const HOOKS: Hook[] = [
	// join (the colour picker itself is a shared component — see ColourPicker.svelte)
	{
		id: 'nameInput',
		file: 'src/lib/components/JoinLanding.svelte',
		anchor: 'placeholder="e.g. Maya"',
		why: 'the flow types a singer name here'
	},
	{
		id: 'swatchRadiogroup',
		file: 'src/lib/components/ColourPicker.svelte',
		anchor: 'aria-label={colorName(c)}',
		why: 'presets are selected by accessible name; the old flow used a hex and broke'
	},
	{
		id: 'colourNames',
		file: 'src/lib/components/ColourPicker.svelte',
		anchor: "'violet', 'pink', 'green', 'amber', 'blue', 'coral', 'purple', 'mint'",
		why: 'PRESET_COLOUR_NAMES here must match the names the picker announces'
	},
	{
		id: 'hueSlider',
		file: 'src/lib/components/ColourPicker.svelte',
		anchor: 'aria-label="Pick your own color by hue"',
		why: 'the flow proves a wheel hue survives the round trip, not just a preset'
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
		why: 'the flow searches the library through this field, on the browse screen since direction A moved it there'
	},
	{
		id: 'mainColumn',
		file: 'src/routes/+page.svelte',
		anchor: '<main>',
		why: 'the gate measures this column reserving the docked band, so the element itself is load-bearing'
	},
	{
		id: 'hero',
		file: 'src/lib/components/NowPlayingHero.svelte',
		anchor: 'class="hero card"',
		why: 'the rotation and the transport are read off the joined home, whose hero is what says it rendered'
	},
	{
		id: 'heroTitle',
		file: 'src/lib/components/NowPlayingHero.svelte',
		anchor: 'class="song"',
		why: 'the playing song is read off the hero, because a playing entry renders no queue row'
	},
	{
		id: 'toolsToggle',
		file: 'src/lib/components/NowPlayingHero.svelte',
		anchor: 'class="tools-toggle"',
		why: 'p16 opens the live-controls disclosure through it and reads aria-expanded to know it is open'
	},
	{
		id: 'toolsBody',
		file: 'src/lib/components/NowPlayingHero.svelte',
		anchor: 'class="tools-body"',
		why: 'the explanation must sit inside the body, which is what keeps it out of the collapsed summary'
	},
	{
		id: 'toolsNote',
		file: 'src/lib/components/NowPlayingHero.svelte',
		anchor: 'class="tools-note"',
		why: 'XR-PH-15 IS this sentence; p16 asserts its presence for a dead control and its absence for a live one'
	},
	{
		id: 'toolsPeek',
		file: 'src/lib/components/NowPlayingHero.svelte',
		anchor: 'class="tools-peek"',
		why: 'the summary must not shout the explanation at a singer who has not opened the panel'
	},
	{
		id: 'guidingTrackRoot',
		file: 'src/lib/components/GuidingTrack.svelte',
		anchor: 'class:disabled={!available}',
		why: 'XR-PH-03 is a containment question about THIS dimmed subtree, so the dimming is the anchor'
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
		why: 'the vendored slider is addressed by shadcn own data-slot, which survives a re-vendor'
	},
	{
		id: 'backToQueue',
		file: 'src/routes/+page.svelte',
		anchor: 'data-testid="back-to-queue" onclick={clearSearch}',
		why: 'a driver that queued a song returns to the queue through this control, which now clears the search'
	},
	{
		id: 'homeReady',
		file: 'src/routes/+page.svelte',
		anchor: 'class="search-dock"',
		why: 'the docked search band is what says the joined home has rendered, and it is present in both the queue and results views'
	},
	/*
	 * RETIRED: the `openBrowse` hook (anchor `class="cta" onclick={openBrowse}`). The owner correction docked the
	 * search box permanently and deleted the `+ Add a turn` button that used to push `?browse=1`, so the
	 * anchor is absent from every source — an anchor guard for markup nobody renders reports a permanent
	 * failure, not an invariant. The search box is now reached with no click; `homeReady` above is the
	 * band that proves the joined home rendered.
	 */
	/*
	 * RETIRED: the `readinessChips` hook (anchor `aria-label="Filter by readiness"`) and the
	 * `browseToggle` hook (anchor `class="browse-toggle"`). Direction B deleted the readiness chip row
	 * and the browse disclosure outright, so both anchors are absent from every source — an anchor
	 * guard for markup nobody renders reports a permanent failure, not an invariant. What replaced them
	 * is `searchDock` below: with those four mechanisms gone, the docked search box is the only control
	 * a driven flow needs to narrow the library, so it is the one anchor worth pinning.
	 */
	{
		id: 'searchDock',
		file: 'src/routes/+page.svelte',
		anchor: 'class="search-dock"',
		why: 'search is bottom-anchored in the thumb zone and is the ONLY way to narrow the list since direction B deleted the filter chips'
	},
	{
		id: 'songRow',
		file: 'src/lib/components/SongRow.svelte',
		// Anchored on `class="row ` WITHOUT a closing quote: the flow queries `.row`, and the class list
		// beside it is presentational and will keep changing (it just gained the shared `list-row`
		// primitive, which broke a full-string anchor while `.row` itself never moved). The open-ended
		// form still proves the element the flow drives exists, without pinning the classes next to it.
		anchor: 'class="row ',
		why: 'search results are read from .row — the old flow read .result and found nothing'
	},
	{
		id: 'addTurn',
		file: 'src/lib/components/SongRow.svelte',
		anchor: 'class="add"',
		why: 'a ready song is queued with this button'
	},
	{
		id: 'sing',
		file: 'src/lib/components/SongRow.svelte',
		anchor: 'class="sing"',
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
	// transport — on the now-playing HERO under direction A. The SELECTORS are unchanged (same
	// aria-labels), so the driven flow is untouched; only which file to look in moved.
	{
		id: 'play',
		file: 'src/lib/components/NowPlayingHero.svelte',
		anchor: 'aria-label="play/pause"',
		why: 'the flow starts playback through the real control, not a synthetic socket message'
	},
	{
		id: 'skip',
		file: 'src/lib/components/NowPlayingHero.svelte',
		anchor: 'aria-label="skip"',
		why: 'the flow advances the rotation to prove round-robin ordering'
	},

	// TV
	/*
	 * The attract screen and the two pieces of type the flow measures on it, anchored to the FILE and
	 * not merely to the class. That distinction is the whole lesson of the `.url` rot: `.brand` is
	 * rendered by BOTH tv/+page.svelte and TvLobby.svelte, so a check that only asks "does any source
	 * carry this class" stays green when the attract screen loses it and the lobby keeps it — which is
	 * the exact shape of the bug that made the flow assert the lobby's address against the empty room.
	 */
	{
		id: 'attract',
		file: 'src/routes/tv/+page.svelte',
		anchor: 'class="attract"',
		why: 'the empty-room stage; the flow gates on THIS to know the room is fresh, not on the lobby address'
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
		why: 'the flow mixes the original vocals back in through this control — a <Slider> since the shadcn vendoring, not a range input, though the aria-label anchoring it is deliberately unchanged'
	},

	// per-song stage background hook removed: the stage look now lives only in room settings, so the
	// phone route no longer renders a .bg-pick override control for the contract to anchor to.

	// identity (phone header → /settings?tab=you → name / colour / leave)
	//
	// These three used to anchor into ProfileSheet.svelte. That sheet was retired when the settings page
	// was split into You / Party / Server scopes: a name editable in two places is two save paths that
	// can disagree, so the sheet's contents moved onto the You tab and the header button became a link
	// to it. The hooks follow the controls.
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

	// away / presence indicator (queue row)
	{
		id: 'queueAway',
		file: 'src/lib/components/QueueRow.svelte',
		anchor: 'class="away"',
		why: 'the flow proves an unreachable singer is marked away so the room can decide to skip them'
	},

	// TV visualizer picker (settings)
	{
		id: 'tvVisualizer',
		file: 'src/routes/settings/+page.svelte',
		anchor: 'id="tv-visualizer"',
		why: 'the flow selects which audio visualizer paints the TV stage'
	},

	// stats + metrics pages
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

	/*
	 * Anchors the CAPTURE flow depends on (tests/e2e/capture.mjs).
	 *
	 * Registered here for the same reason as everything above: capture is a long stateful chain, and
	 * when an anchor moves the run does not go red in a useful way — it produces a plausible-looking
	 * but wrong set of frames, or dies on step one. `.url` moving is precisely what happened.
	 */
	{
		id: 'qrImage',
		file: 'src/lib/tv/JoinBadge.svelte',
		anchor: 'alt="QR code to join Encore"',
		why: 'capture waits on this to know the attract screen has painted; `.url` rotted and broke the run'
	},
	{
		id: 'badQr',
		file: 'src/lib/tv/JoinBadge.svelte',
		anchor: 'Join QR unavailable',
		why: 'the misconfigured-origin frame is the first-run failure worth showing; capture drives it deliberately'
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
