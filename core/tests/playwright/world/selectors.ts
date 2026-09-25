// THE SELECTOR CONTRACT. One name per thing a spec addresses, so a renamed class is one edit here and not a
// hunt through 40 drivers. See docs/E2E.md#why-selectors-are-centralised and #anchor-discipline.
//
// Ported from tests/e2e/contract.ts. The `HOOKS` anchor registry did NOT come with it: its only consumer was
// tests/guards/hygiene/contract.test.ts, which verified each selector against the source file it was supposed
// to resolve against. That guard is gone, so the registry had no verifier left — and an unverified record of
// where a selector "should" resolve is worse than none, because it reads as a guarantee.

/*
 * RETIRED IDS AND VALUES. contract.test.ts used to red on any of these; it is deleted, so this list now
 * warns rather than enforces. Kept because the reason is durable: a revived name gets pointed at a class
 * that has come BACK on another surface, so it resolves — against the wrong thing, silently.
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
	/* ── /library ─────────────────────────────────────────────────────────────
	   The browse page. Its field FILTERS rows already in memory where `search` above FETCHES, so the two carry
	   separate aria-labels and separate keys on purpose — a test that mixed them would pass against the wrong
	   surface. See docs/FRONTEND.md#the-library-page. */
	libraryLink: 'a[aria-label="Your library"]',
	libraryFilter: 'input[aria-label="Filter your library"]',
	clearLibraryFilter: '[aria-label="Clear the filter"]',
	/** "N of M songs", the line that tells a guest this box hides rows rather than fetching them. */
	libraryCount: '.count',
	/** The labelled door under the home shelf. Present only while the shelf actually hides rows. Scoped by the
	 *  WRAPPER, because `<Button href>`'s own classes come from tailwind-variants and can be re-vendored. */
	librarySeeAll: '.showall-row a[href="/library"]',
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
	// `.encore-card`, not `.card`: the vendored Card component renders `encore-card`, so the ported `.card`
	// form resolved against NOTHING on /stats — a selector that can only ever report "absent".
	dashCard: '.encore-card',
	dashCardTable: '.encore-card table',
	dashTileNumber: '.tile .n',
	/** A comma UNION. The `:not()` arguments are EXCLUSIONS the source need not render, and `+` resolves
	 *  like `>`: both sides must exist, their relative position is not source-checkable. */
	dashChartOrBody: '.encore-card h2 + .bars, .encore-card h2 + :not(table):not(.note):not(.scroller)',

	// admin (/admin — the entry-delete surface admin-delete drives)
	adminSongRow: "[data-slot='item']",
	/** The first-step Delete button: arms the confirm, and is not itself the commit. */
	adminDelete: "[data-act='arm-delete']",
	adminConfirmDelete: "[data-act='confirm-delete']"
} as const;

/** Picked by NAME, because that is what a screen reader — and therefore a role query — sees. Never by hex. */
export const PRESET_COLOUR_NAMES = ['violet', 'pink', 'green', 'amber', 'blue', 'coral', 'purple', 'mint'] as const;
