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
	/** Source file, relative to apps/core. */
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

	// ── phone remote ──────────────────────────────────────────────────────
	search: 'input[aria-label="Search a song or artist"]',
	songRow: '.row',
	songTitle: '.row .t',
	addTurn: '.row .add',
	sing: '.row .sing',
	queueRow: '.qrow',
	queueTitle: '.qrow .t',
	/*
	 * A song cooking in the rotation. ProcessingCard renders `class="qrow proc ..."`, so `.proc` is a
	 * SUBSET of `.qrow`, not a sibling of it — the flow's `queued + processing > 0` therefore
	 * double-counts a cooking card. Harmless for an existence check, and named here so nobody later
	 * reads an exact total off the pair.
	 */
	processing: '.proc',
	browseToggle: '.browse-toggle',
	/*
	 * Bare remote-list handles the probes read directly (not scoped under .row like addTurn/sing/songTitle
	 * above): p3/p8/p10 query `.add`, `.sing`, `.t` on their own to check an action or a title exists at all,
	 * and p8/p12 read the presence and empty-state chrome. Named here so those reads come through the
	 * contract instead of being spelled out per probe (#494, migrated from KNOWN_OFFENDERS).
	 */
	addAction: '.add',
	singAction: '.sing',
	/** "queued or ready" in one query — p8 asks whether a row offers EITHER queue action; a comma
	 *  union, so one branch resolving is enough. */
	addOrSing: '.add,.sing',
	rowTitle: '.t',
	empty: '.empty',
	away: '.away',
	isLabel: '.is-label',
	strip: '.strip',
	stripPerson: '.strip .person',

	// ── the pull-up queue sheet (capture drives the transport through it) ──
	/** The sheet surface; `.open` on it is what says the pull-up actually pulled up. */
	sheet: '.sheet',
	/** The grab handle. ArrowUp on it is the documented open gesture, and where the transport lives. */
	peek: '.peek',

	// ── transport (in the queue sheet's peek) ─────────────────────────────
	play: { role: 'button' as const, name: 'play/pause' },
	skip: { role: 'button' as const, name: 'skip' },
	restart: { role: 'button' as const, name: 'restart' },

	// ── TV ────────────────────────────────────────────────────────────────
	/*
	 * THE EMPTY-ROOM STAGE, and the three things asserted on it.
	 *
	 * `.attract` is the state itself. It is what "the room is empty" should have been keyed on all
	 * along: the flow used to wait for `.url`, which is the LOBBY's typed address (TvLobby.svelte) and
	 * therefore appears only once somebody HAS joined. The gate was inverted — it could not pass on the
	 * fresh empty room it demanded, and its failure message blamed leftover guests for the one
	 * condition that would have satisfied it.
	 *
	 * The attract screen's own address is `.idle-url` and its instruction is `.idle-head`, and BOTH
	 * live behind the reachable-origin branch: when the advertised address is loopback or a bare
	 * hostname the TV replaces the QR block with `.badqr` (correctly — a QR to an unroutable address is
	 * a working-looking dead end). So `.badqr` is part of the contract too, because it is how the flow
	 * tells "the origin is not routable" apart from "someone already joined" instead of reporting one
	 * as the other.
	 */
	/** The TV's socket indicator. `.on` appears when the WebSocket opens, which is the only barrier the
	 *  flow has before the room state it renders can be believed. */
	tvConnected: '.status.on',
	attract: '.attract',
	joinAddress: '.idle-url',
	stageHeadline: '.idle-head',
	/** The wordmark whose inset proves stage chrome clears the overscan region. */
	stageBrand: '.brand',
	badQr: '.badqr',
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
	 * TV STAGE STRUCTURE the timing/scaling probes read (#494, migrated from KNOWN_OFFENDERS).
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
	 * LYRICS OVERLAY internals the lyrics probe reads (#494). `.lyrics` is the overlay; `.reel` scrolls,
	 * `.viewport` clips it, `.row`/`.row.current` are the lines, `.lyrics.unverified` flags ASR-only text,
	 * `.ls-asr` is the "transcribed" badge, `.ball` is the bouncing dot. `activeWord` (below) is the word
	 * the ball sits on.
	 */
	lyrics: '.lyrics',
	lyricsReel: '.lyrics .reel',
	lyricsViewport: '.lyrics .viewport',
	lyricsRow: '.lyrics .row',
	lyricsRowCurrent: '.lyrics .row.current',
	lyricsUnverified: '.lyrics.unverified',
	lsAsr: '.ls-asr',
	ball: '.ball',
	/** The full-screen tap-to-start affordance the autoplay-block probe checks for (#64/#494). */
	autoplayHint: '.autoplay-hint',
	/*
	 * LOBBY strip the overlap probe reads (#494). `.strip` is the joined-singers ribbon, `.person` a
	 * chip in it (`.more` the "+N" overflow chip), `.url` the lobby's typed join address. Scoped forms
	 * are what lobby-overlap.mjs queries.
	 */
	lobbyUrl: '.lobby .url',
	lobbyStrip: '.lobby .strip',
	lobbyStripPerson: '.lobby .strip .person',
	lobbyStripPersonMore: '.lobby .strip .person.more',
	lobbyAddress: '.url',
	/* KEY-SHIFT control the transpose probe reads (#494): the +/- buttons and the current-key label. */
	keyBtn: '.key .key-btn',
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
	]
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
		file: 'src/routes/join/+page.svelte',
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
		file: 'src/routes/join/+page.svelte',
		anchor: 'Start singing',
		why: 'the flow submits the join form by this label'
	},

	// phone remote
	{
		id: 'search',
		file: 'src/routes/+page.svelte',
		anchor: 'aria-label="Search a song or artist"',
		why: 'the flow searches the library through this field'
	},
	{
		id: 'readinessChips',
		file: 'src/routes/+page.svelte',
		anchor: 'aria-label="Filter by readiness"',
		why: 'readiness is the organising axis; there is deliberately no source switch to click'
	},
	{
		id: 'browseToggle',
		file: 'src/routes/+page.svelte',
		anchor: 'class="browse-toggle"',
		why: 'browse is behind a disclosure now, so facets are not clickable until it is opened'
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
		why: 'a raw song has ONE action that both queues and starts the cook'
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
		why: 'a cooking song holds its rotation slot; .proc is a subset of .qrow, so either class proves it'
	},
	{
		id: 'sheetSurface',
		file: 'src/lib/components/QueueSheet.svelte',
		anchor: 'class="sheet-surface sheet"',
		why: 'capture waits for .sheet.open to know the pull-up actually opened before it shoots it'
	},
	{
		id: 'peekHandle',
		file: 'src/lib/components/QueueSheet.svelte',
		anchor: 'class="peek"',
		why: 'the grab handle capture sends ArrowUp to; the transport lives inside it'
	},

	// transport
	{
		id: 'play',
		file: 'src/routes/+page.svelte',
		anchor: 'aria-label="play/pause"',
		why: 'the flow starts playback through the real control, not a synthetic socket message'
	},
	{
		id: 'skip',
		file: 'src/routes/+page.svelte',
		anchor: 'aria-label="skip"',
		why: 'the flow advances the rotation to prove round-robin ordering'
	},
	{
		id: 'queuePeek',
		file: 'src/lib/components/QueueSheet.svelte',
		anchor: 'aria-expanded={open}',
		why: 'the transport lives in the sheet peek; the flow must know the sheet is reachable'
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
		anchor: 'class="idle-url"',
		why: 'the typed join address on attract — the flow asserts it is legible at ten feet'
	},
	{
		id: 'stageHeadline',
		file: 'src/routes/tv/+page.svelte',
		anchor: 'class="idle-head"',
		why: 'the attract instruction; the flow asserts it clears the ten-foot floor'
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
		anchor: 'class="interstitial state-next"',
		why: 'the song-intro card names who is up before playback; the flow reads .up-song / .up-name off it'
	},

	// guiding track (phone now-playing sheet body)
	{
		id: 'guidingTrack',
		file: 'src/lib/components/GuidingTrack.svelte',
		anchor: 'aria-label="Guiding track — original vocal level"',
		why: 'the flow mixes the original vocals back in through this range input'
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
		anchor: '<h1>Party stats</h1>',
		why: 'the public stats page landmark the flow lands on at /stats'
	},
	{
		id: 'metricsPage',
		file: 'src/routes/metrics/+page.svelte',
		anchor: '<h1>Processing metrics</h1>',
		why: 'the internal metrics page landmark the flow lands on at /metrics'
	},

	/*
	 * Anchors the CAPTURE flow depends on (apps/core/e2e/capture.mjs).
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
	}
];
