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
 *   `SEL.play` — it named an `aria-label="play/pause"` nothing carries, so it would resolve against
 *     nothing while reading as though the old flow worked. The whole transport is in the bottom chrome.
 *   THE WHOLE NOW-PLAYING SHEET, banned BY VALUE, which matters more here than anywhere else above:
 *     `.band`, `.band-slot`, `.band .title`, `.disc`, `.meta-btn`, `.np-drawer`,
 *     `[data-slot='drawer-handle']`, `.np-fit`, `.more-slot a`, `.tools-body`, `.tools-note`,
 *     `.seekrow .time`, `.seekrow .track > i`, `.key-cell button`, `.key .lab`, and the hooks
 *     `bandExpand` / `bandExpandWired` / `drawerHandleOnly`. NowPlayingStrip.svelte reuses `.strip`, `.tp`,
 *     `.btn`, `.meta` and `.dot` from the old band's inner markup, so a revived `.band .title` reads as
 *     "absent" (safe) while a revived bare `.strip` RESOLVES — against the TV lobby's roster or the new
 *     chrome, depending on the surface. The successors are the `.dock`-scoped keys below.
 *   no HOOK may name NowPlayingHero.svelte — the component is deleted.
 *   `swatch(name)`, `hueSlider` — ColourPicker is deleted, so the eight-preset swatches and the hue rail they
 *     named exist nowhere. `hueSlider` is the dangerous one to revive: `input[type="range"]` now resolves ONLY
 *     against /settings' sliders, which are a different control, so a revived key would pass against the wrong
 *     element. The identity control on every surface is `colourRing`.
 *   `settingsTab(id)`, value `#tab-<id>` — the in-page settings tablist is gone (three scopes, three routes), so
 *     nothing in the app carries that id. SAFE TO REVIVE ONLY IN THE SENSE THAT IT RESOLVES AGAINST NOTHING, which
 *     is still a spec that waits forever on a page that is fine; the successor is a navigation to `/settings`,
 *     `/settings/you` or `/settings/server` followed by a wait on `SEL.setting(<a control on it>)`.
 *   key `librarySeeAll`, value `.showall-row a[href="/library"]` — it named the labelled door under the home
 *     SHELF, and the Sing tab has no shelf. THE VALUE IS THE HAZARD, which is why it is banned by value: both
 *     `.showall-row` and an `a[href="/library"]` inside one still exist on `/`, as the widen button's row and as
 *     the search-found-nothing state's way to the library — so a revived key resolves, against a control that
 *     appears only under a failed query. The phone's standing route to /library is the TabBar's Library tab.
 */

export const SEL = {
	// join
	nameInput: 'input[placeholder^="e.g."]',
	/** One `role="slider"` over 48 stops: a driver picks with `Home`/`End`/arrows, there is nothing to click. */
	colourRing: '.colour-ring',
	/** "Your color <name> · change": opens the ring's dialog on the join screen. */
	colourChange: '.join-card button.colour',
	/** The join screen's one Spotlight card, holding the code and then the name. */
	joinCard: '.join-card',
	submit: /Start singing/,
	/** How p8 tells a duplicate-name rejection from a clean join: both leave the form sitting there. */
	joinError: '.err[role=alert]',
	/* The join gate's three LAYOUT boxes, addressed by class because a layout box owes a user no aria contract
	   and because these are the exact classes JoinLanding's own placement rules (and its two `:has()` selectors)
	   key on — see docs/FRONTEND.md#the-join-screen. `joinHead` is the reserved brand band, `joinColumn` the
	   column the card sits in, both present on either pane. */
	joinHead: '.join-head',
	joinColumn: '.join-main',
	/** The CTA by its SLOT, not by `submit` above: that key is the accessible name `Start singing`, which exists
	 *  only on the identity pane. A bare `/` or `/library` lands on the CODE pane, where the same button reads
	 *  `Continue` — or `Checking the code…` while a preview is in flight — so a name query finds nothing there. */
	joinCta: '.submit-slot button',

	// phone remote
	/* ── the bottom chrome (+layout.svelte → NowPlayingStrip.svelte · TabBar.svelte) ───────────────────────
	   ONE key for the readiness anchor AND the row `--dock-h` is bound from, where there used to be two
	   (`homeReady: '.band'`, `dockRow: '.band-slot'`): after the rebuild they are the same element, and two
	   names for one thing in a contract whose purpose is one-name-per-thing is a lie waiting to rot.
	   THE `np*` KEYS ARE ALL SCOPED UNDER `.dock`, and that is correctness rather than tidiness: the strip reuses
	   the old band's inner class names, and `.strip` / `.strip .person` are ALREADY taken further down by the
	   TV lobby's roster. An unscoped `npStrip: '.strip'` would resolve against the wrong element on /tv.
	   THE THREE TAB KEYS ARE DELIBERATELY NOT, which is the one asymmetry here and it is load-bearing both ways.
	   `.tabs` is declared in exactly one file (TabBar.svelte), so it needs no scope to be unambiguous — but the
	   reason it must not HAVE one is that `/components` renders four `<TabBar>` frames and is in `NOT_PHONE`, so
	   it has no `.dock` at all: `.dock .tabs` would resolve ZERO on the one surface that shows every tab state.
	   The cost is that on `/components` these three match four elements, so a driver there must pick a frame
	   first; on a phone surface each matches exactly one. */
	/** The post-join readiness signal — but chrome on EVERY phone surface, so a caller that also needs "and
	 *  on home" must pair it with `location.pathname === '/'`. Absent on the join screen (the layout gates the
	 *  dock on a joined singer), which is what makes it a join signal, and SOUNDER than the `.band` it replaced
	 *  because it does not depend on a song existing.
	 *  IT CARRIES NO BORDER AND NO PADDING, so its `clientHeight` and its `getBoundingClientRect().height` agree
	 *  and either may be compared to `--dock-h`. ONE HEIGHT since proposal 13, strip + tab bar, measured 93 at
	 *  390x844 and 320 in every room state (idle, queued, playing, cheering, offline).
	 *  It mounts after the room's first sync, whole, so it is a sounder join signal than before, not a weaker one. */
	dock: '.dock',
	/** The tab's grey rows while the link has no answer from /api/me yet (`RoomPending.svelte`). */
	roomPending: '[data-room-pending]',
	/** The one line a phone shows when /api/me has gone unanswered past UNREACHABLE_AFTER_MS. */
	unreachable: "Can't reach the party",
	/** THE SAFE-AREA ELEMENT, and it needs its own key: the tab bar is the app's bottom-most element and the
	 *  sole declarer of `padding-block-end: env(safe-area-inset-bottom)`. Measured padding-bottom 0px on both
	 *  `.dock` and `.dock .strip` at inset 0, so a probe pointed at either of those reports a composed term as
	 *  missing at every inset. */
	tabBar: '.tabs',
	/** The three tabs — Sing, Queue, Library — in source order. `/settings`, `/stats`, `/metrics` and `/admin`
	 *  are deliberately not among them. */
	tab: '.tabs .tab',
	/** The lit tab, by the accessible half of the pair: `aria-current="page"` and a `.current` class are both
	 *  set, and exactly one tab carries them — none on `/song/[mediaId]`, which is a push from any tab. */
	tabCurrent: '.tabs [aria-current="page"]',
	/** THE STRIP RENDERS ON EVERY JOINED PHONE SURFACE (proposal 13). An idle room reads `npStripIdle` and has NO
	 *  transport: the old band put a disabled Play, the brightest thing on screen, beside that copy. */
	npStrip: '.dock .strip',
	/** "Nothing playing": nothing current and nothing queued. */
	npStripIdle: '.dock .strip .idle',
	/** "Reconnecting…", in the title slot while the link is down. */
	npStripOffline: '.dock .strip .offline',
	/** "What is playing", present with no gesture — and a PLAYING entry renders no `.qrow` at all, so this is
	 *  the only place on the phone the current title is spelled outside /queue. Rendered only on the `hasSong`
	 *  branch: with a queue but nothing playing the strip shows `npStripWho` alone. */
	npStripTitle: '.dock .strip .song',
	/** The Cheer key, first in the transport. Always in its slot while a song is on; `.resting` (hidden and inert)
	 *  on the singer's own phone and with reactions off. */
	npCheerKey: '.dock .strip .cheer-key',
	/** The cheer tray: the strip's own row, swapped in by the Cheer key. Four reactions and ✕. */
	npCheers: '.dock .cheers',
	npCheer: '.dock .cheers .cheer',
	npCheersClose: '.dock .cheers .close',
	/** The singer's name, on the `hasSong` branch. */
	npStripWho: '.dock .strip .who',
	/** With a queue but nothing playing: "Ready when you are", "Making karaoke…", or why no karaoke is coming. */
	npStripStatus: '.dock .strip .status',
	/** THE TRANSPORT IS ON /queue's Now card since redesign step 4 (`transportTap` in actors.ts gets there).
	 *  Play/pause is its one filled key; with nothing playing, the only Play is the strip's (`npStripPlay`). */
	npPlayPause: '.now-tp .tp-btn.primary, .dock .strip .btn.play',
	/** THREE buttons, in source order: restart, play/pause, skip. */
	npTransport: '.now-tp .tp-btn',
	/** "Ready when you are" with nothing playing: the strip's one transport key, in the Cheer key's slot. */
	npStripPlay: '.dock .strip .btn.play',
	/** What the dock must never carry again: pause, restart or skip in the strip. The heart saves a song; it is not one. */
	dockTransport: '.dock .strip .tp .btn:not(.cheer-key, .play, .heart)',
	/** The now-line with something in the rotation: who is singing, or what the queue waits on. */
	npStripLive: '.dock .strip .who, .dock .strip .status',
	/** The whole metadata block is the link to /queue, so the target is the width the transport leaves. */
	npStripLink: '.dock .strip a[href="/queue"]',
	/* ── /queue ───────────────────────────────────────────────────────────────
	   A compact Now row for the room, then YOUR card, then the list (redesign step 5). */
	/** The now-playing row: song, singer, clock and transport. Rendered only with a current entry. */
	queueNowCard: '.now',
	/** The playing song's key and guide as one line, on every phone. */
	queueNowTune: '.now [data-now-tune]',
	/** YOUR card: "You're next" while the song before yours plays, then "You're up" (`.deck.up`) while yours does,
	 *  one element. The singer's key and guide live here, never on the Now row. */
	queueMyCard: '.deck',
	/** Guide as Off / Low / Full (GuideSegments). */
	guideSegments: '[role="radiogroup"]',
	queueElapsed: '.clock .elapsed',
	queueRemain: '.clock .remain',
	/** The remove button on a QueueRow or ProcessingCard, by test id: its accessible name carries the song title
	 *  (`removeTurnName`), so it is no longer one string. The only way to drive the dock from the
	 *  strip-PRESENT state back to ABSENT, which is half of the measured gate's cross-state claim: measured exactly
	 *  one on /queue with one entry, and clicking it drops --dock-h from 91px to 46px at 390x844. */
	queueRemove: '[data-testid="queue-remove"]',
	/** The drag handle, by the `data-grip` attribute the route publishes the ENTRY ID into — the same attribute
	 *  `focusGrip` re-finds a moved row by, so it is a contract and not a convenience. BOTH row kinds carry it:
	 *  the cooking card went without one for the whole life of the three-tab rebuild (the route passed
	 *  `reorderable`, which is not the handle's gate), so a count scoped under `.proc` is the claim. */
	queueGrip: '[data-grip]',
	/** The route's ONE polite region, shared by the queue's own news and the reorder results. Read for its TEXT:
	 *  it is empty on a cold load by design — the first synced list is a baseline, not news. */
	queueLive: '.sr-live',
	/** The measured gate reads its padding-bottom to prove the docked row is RESERVED, not overlapping. */
	mainColumn: 'main',
	/** GuidingTrack's root. `.gt.disabled` is the unavailable state, and it dims BY TOKEN — the component's own
	 *  rule moves `.gt-val`'s colour to `--ink-dim` and declares no opacity at all, which is FRONTEND.md's rule
	 *  about never flattening a subtree that holds text. This key named an opacity that is not there. */
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
	/* WHERE `search` looks has no control on screen (proposal 21): a spec narrows by loading the Sing tab as
	   `/?source=local`. A spec that needs a query to match NOTHING, or the seeded fixture as the first row, must
	   do that first — the default reaches YouTube Music, which fuzzy-matches, so no string is reliably empty. */
	/** Empties the query, which lands the Sing tab on its idle state. It no longer restores a queue-and-library
	 *  view — those are tabs — so a spec asserting rows after a clear is asserting the old architecture. */
	clearSearch: '[aria-label="Clear the search"]',
	/* ── /library ─────────────────────────────────────────────────────────────
	   The browse page. Its field FILTERS rows already in memory where `search` above FETCHES, so the two carry
	   separate aria-labels and separate keys on purpose — a test that mixed them would pass against the wrong
	   surface. See docs/FRONTEND.md#the-library-page. */
	/** The phone's route to /library, which is the TabBar and nothing else now. It used to be an icon door beside
	 *  the home search field (`a[aria-label="Your library"]`), deleted with the shelf it labelled — that value
	 *  resolves nowhere today, so a spec still spelling it would only ever report "absent". Scoped by the nav's
	 *  accessible name, because `a[href="/library"]` alone also matches the one inside `/`'s no-results state. */
	libraryLink: 'nav[aria-label="Sections"] a[href="/library"]',
	libraryFilter: 'input[aria-label="Filter your library"]',
	/** WHAT TO ARRIVE ON, because `libraryFilter` is no longer on every arm of this route: the field is hidden once
	 *  the library is PROVEN empty (a filter over zero rows is dead chrome), so a core with nothing processed settles
	 *  on the empty box. Waiting on the field alone there is a RACE rather than a clean failure, which is the worse
	 *  outcome of the two — it attaches only if the poll lands inside the brief `!libraryLoaded` window where the
	 *  field is still mounted beside the skeleton. Driven against a 0-ready core, five arrivals each: the field alone
	 *  attached 2/5 and timed out 3/5; this union attached 5/5. Either branch satisfies it, so it says "/library has
	 *  finished deciding what it is" without asserting which arm answered. */
	libraryReady: 'input[aria-label="Filter your library"], .lib-empty',
	clearLibraryFilter: '[aria-label="Clear the filter"]',
	/** "N of M songs", the line that tells a guest this box hides rows rather than fetching them. */
	libraryCount: '.count',
	songRow: '.row',
	songTitle: '.row .t',
	addTurn: '.row [data-testid="song-add"]',
	sing: '.row [data-testid="song-sing"]',
	queueRow: '.qrow',
	queueTitle: '.qrow .t',
	/** ProcessingCard renders `class="qrow proc …"`, so `.proc` is a SUBSET of `.qrow`: fine for existence,
	 *  but `queued + processing` double-counts and is never an exact total. ALSO A SUPERSET of the two kinds
	 *  below — `.proc` alone cannot tell a cooking turn from a stranded one. */
	processing: '.proc',
	/** A DEAD TURN: queued, no karaoke, and nothing in flight that could produce any — `queueCardKind`'s
	 *  `stalled`. ITS OWN SELECTOR, never a reuse of `.failed`, because the two make different claims: failed is a
	 *  process that ran and died (--danger), stalled is a turn no process exists for (--warn). An assertion that
	 *  accepted either would pass on the bug this card was added to make visible. */
	stalledTurn: '.qrow.proc.stalled',
	/** A process that RAN AND DIED, from a live `media:status` failure. */
	failedTurn: '.qrow.proc.failed',
	/** The stalled card's retry — the only control in the tree that can recover a stranded turn without searching
	 *  for the song again. Scoped to the card, unlike `singAction`. */
	retryKaraoke: '.qrow.proc.stalled [data-testid="card-retry"]',
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

	// transport, on /queue's Now card: drive it with `transportTap` (actors.ts), which opens /queue first.
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
	/** The right-gutter lane reactions rise in, and one rising disc. */
	tvReactionLane: '.reaction-lane',
	tvReaction: '.reaction-lane .reaction',
	nowSong: '.ls-song',
	nowName: '.ls-name',
	stateNext: '.state-next',
	/** The takeover layer while a card is UP. A card stays mounted under the layer for its exit fade, so `.state-*`
	 *  alone also matches a card on its way out. */
	takeoverShown: '.takeover-layer.shown',
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
	upLabel: '.up-label',
	upName: '.up-name',
	upSong: '.up-song',
	/** Scoped forms — p10 measures these nested under .lower-third. */
	nowNameScoped: '.lower-third .ls-name',
	nowSongScoped: '.lower-third .ls-song',
	/** Lyrics overlay internals. `.reel` scrolls, `.viewport` clips it, `.row`/`.row.current` are the
	 *  lines, `.lyrics.unverified` flags ASR-only text (the amber tint, the TV's only word-free sign of a guess),
	 *  `.ball` is the bouncing dot. */
	lyrics: '.lyrics',
	lyricsReel: '.lyrics .reel',
	lyricsViewport: '.lyrics .viewport',
	lyricsRow: '.lyrics .row',
	lyricsRowCurrent: '.lyrics .row.current',
	lyricsUnverified: '.lyrics.unverified',
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
	/* ── the key row (/queue's now-playing card) ──────────────────────────────
	   Both keys keep their names, because a keycap is still a keycap — only the markup around them moved. */
	/** Wrapper plus tag, so both keycaps are addressed without depending on a class a `<Button
	 *  variant="keycap">` would have to carry for the test's benefit. Two of them, in source order: Lower by
	 *  one semitone, then Raise. */
	keyBtn: '.keys button',
	/** "Key", the row's own label. SCOPED BY THE ROW, because the label itself is app.css's shared
	 *  `.control-label` and that class is global — on /queue the key row is its only carrier, but `.ctl` says so
	 *  rather than relying on it. NOT uppercased by CSS the way the sheet's `.key .lab` was — see the note on
	 *  `readKeyLabel` in p3-key-shift.spec.ts. */
	keyLabel: '.ctl .control-label',
	/** p10 measures its width to catch a capped grid leaving a void. */
	appShell: '.app-shell',
	/** By ALT TEXT: what a user is promised moves far less often than the class beside it. */
	qrImage: 'img[alt="QR code to join Encore"]',
	activeWord: '.lyrics .word.active',

	// settings
	/** By id, because a settings page has many controls with similar visible labels ("Off" appears in four
	 *  different pickers). It resolves a settings CARD too, since each of the ten carries an id of its own.
	 *
	 *  `SEL.settingsTab` ('#tab-<scope>') RETIRED WITH THE IN-PAGE TABLIST: the three scopes are three ROUTES now, so
	 *  a spec navigates to `/settings`, `/settings/you` or `/settings/server` and waits on a control rather than
	 *  clicking a trigger. Its own comment claimed `contract.test.ts` asserted its format; no such assertion existed
	 *  in the tree. */
	setting: (id: string) => `#${id}`,
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
