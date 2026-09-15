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
	 * HOME IS THE QUEUE (direction A) AND NOTHING ELSE. The phone-remote rebuild took search OFF home:
	 * `NowPlayingBand` is the bottom-most app chrome on every phone surface, it owns that edge, and its
	 * magnifier (`bandSearch`) NAVIGATES to the `/find` route. `/` renders the rotation only.
	 *
	 * AMENDED (the sheet merge). That paragraph used to say the band "is mounted by
	 * `src/routes/+layout.svelte` inside a `.dock` wrapper", and neither half is true now. The band and
	 * the separate now-playing drawer were MERGED into one permanently-mounted vaul sheet: the layout
	 * mounts only `<NowPlayingDrawer>`, that component composes `<NowPlayingBand>` as the first child of
	 * the sheet's content, and vaul fixes the content to the bottom edge — there is no `.dock`.
	 *
	 * NOTHING ABOUT THIS SELECTOR CHANGED, which is why it is amended rather than re-pointed: `.band` is
	 * still rendered, still present on every phone surface a joined singer sees, and still the element
	 * `--dock-h` is measured from. What moved is WHO POSITIONS IT, and that is why `bandMounted` below
	 * follows the mount into the drawer instead of staying on the layout.
	 *
	 * WHAT REVERSED, ON THE RECORD, because this block used to argue the opposite. The 2026-09-09
	 * correction docked the box at the bottom of home at all times: search IS the add affordance, so no
	 * push, no browse MODE, no `?browse=1`, and results expanding upward IN PLACE because there was
	 * nowhere to back out to. Two of those premises stopped holding. The band took the thumb zone, so
	 * two surfaces were fighting for one edge; and an empty box now shows the LIBRARY rather than the
	 * queue, which makes it a screen of its own rather than a state of home. So there IS a navigation to
	 * search again and it is a ROUTE — the phone's own back gesture works, the surface is shareable, and
	 * typing does not re-render the queue under a keyboard.
	 *
	 * WHAT DID NOT COME BACK, so the retirements below are not contradicted by that reversal: there is
	 * no browse TOGGLE. `openBrowse`, `browseToggle` and `readyChip` were CONTROLS that revealed or
	 * filtered a list in place, and `/find` needs none of them because the SURFACE is the browse view —
	 * you go there instead of switching something on. A returning surface is not a returning control, so
	 * all three stay retired for the reason each was retired for.
	 *
	 * `homeReady` is the post-join readiness check and is now the BAND, which the layout mounts exactly
	 * when a singer is joined (`showBand = isPhoneSurface && me !== null`) — so it answers "joined",
	 * which is what both call sites actually ask. Both of them AND `location.pathname === '/'`
	 * themselves (`joinedExpression()` in lib/phone.mjs, and p8-presence's inline poll), so the HOME
	 * half of the claim is carried by the caller rather than by this selector, which is present on every
	 * phone surface.
	 *
	 * THE DRIVER MIGRATION IS NOT DONE, and saying so is the point of writing it here rather than
	 * discovering it in a browser: `openBrowseFromHome()` in `tests/e2e/lib/phone.mjs` still waits for
	 * `search` on `/` with no navigation, so every flow that reaches search through it will now time
	 * out until that ONE helper taps `bandSearch` and waits for `/find` — which is exactly why the
	 * sequence was put in one place. That helper is outside this change's scope; the contract records
	 * what the app IS, and the guard is what keeps reporting the gap until the helper follows.
	 *
	 * RETIRED: `openBrowse` was `.cta-dock .cta`, the `+ Add a turn` button that pushed `?browse=1`
	 * to reveal the search box. The owner correction docked the box permanently and deleted the button, so the anchor is
	 * absent from every source — an anchor guard for markup nobody renders reports a permanent failure,
	 * not an invariant. It does NOT return with the `/find` route: `bandSearch` navigates to a surface
	 * rather than revealing one in place, and it is a permanent piece of app chrome rather than a
	 * button that appears to open a mode.
	 */
	homeReady: '.band',
	/**
	 * The scrolling content column. The measured gate reads its padding-bottom to prove the docked band
	 * is RESERVED rather than overlapping the list (XR-PH-12), which is a geometry claim about this
	 * element and so cannot be spelled out at the call site.
	 */
	mainColumn: 'main',
	/*
	 * RETIRED: `hero` was `.hero` and `heroTitle` was `.hero .song` — NowPlayingHero.svelte, the card that
	 * opened joined home. The component is DELETED. Everything it held (song identity, the seek row, the
	 * transport, the live controls) moved into `NowPlayingDrawer`, a bottom drawer the layout mounts and the
	 * band's pull handle opens; home is the queue and nothing else.
	 *
	 * `hero` IS THE DANGEROUS ONE, and it is why this is a retirement and not a re-point. `.hero` STILL
	 * RESOLVES — lib/tv/JoinBadge.svelte renders `class="hero"` on the attract screen's join panel — so
	 * the every-SEL-resolves guard would have stayed GREEN over a phone-remote selector pointing at the
	 * TELEVISION. That is the same silent mis-resolution that left `.chip` matching the phone's chip
	 * BUTTONS instead of a SongRow badge across two migrations, and it only surfaced when the wrong target
	 * happened to disappear too. A selector resolving against the wrong surface is worse than one that
	 * reds, so contract.test.ts now pins the absence rather than trusting it.
	 *
	 * THE TWO CLAIMS SPLIT, and neither successor is "the hero at a new address":
	 *   • "the joined home rendered" was always really "this singer is joined", and `homeReady` — the band,
	 *     which the layout mounts on exactly that condition — already answers it with no gesture.
	 *   • "where the transport lives" is the drawer, `npDrawer` below.
	 *
	 * AMENDED (the sheet merge). That second bullet used to read: "It is CLOSED by default and vaul does
	 * not render its content at all until it opens, so that half now takes a tap on `bandExpand` to
	 * reach: a state a driver has to CREATE, where the hero was simply there." Every clause of it is now
	 * false. The sheet is PERMANENTLY MOUNTED, so its content is rendered at all times and CAN be waited
	 * on cold; there is no `bandExpand` at all (retired below); and what a driver has to create is no
	 * longer existence but HEIGHT — `activeSnapPoint` at `0.82` rather than the collapsed `'80px'`.
	 *
	 * The hero comparison survives in a weaker and more dangerous form, so it is restated rather than
	 * dropped: the transport is MOUNTED exactly as the hero's was, but it sits below the fold while the
	 * sheet is collapsed. So a PRESENCE read passes without the gesture and a GEOMETRY read does not —
	 * the failure is now a wrong measurement rather than a timeout, which is the harder one to notice.
	 *
	 * `heroTitle`'s reason survives whole — the PLAYING entry is not a `.qrow` (its status is 'playing',
	 * which `queued` filters out), so a flow asking "is my song in the rotation?" must read the playing
	 * title somewhere or it counts zero for the very first song of the night. It has TWO successors, on
	 * purpose: `bandTitle` states it permanently on every phone surface, and `npSong` states it inside the
	 * drawer. It is not re-pointed under its old name because `heroTitle` names a PLACE that no longer
	 * exists — the same rule that made `searchDock` become `findBox` rather than move.
	 *
	 * THE DRIVER MIGRATION IS NOT DONE, and recording it is the point of writing it here rather than
	 * discovering it in a browser. `SEL.hero` is read by lib/phone.mjs, probes/p16-hero-live-controls.mjs
	 * and shoot-913.mjs; `SEL.heroTitle` by party.mjs, probes/p4-transport.mjs and p16. Those reads now
	 * address nothing and must become `homeReady`/`npDrawer` and `bandTitle`/`npSong` — and p16 must PULL
	 * THE SHEET UP (`activeSnapPoint` to `0.82`) before MEASURING any of the controls, which it never had
	 * to do for a hero. Note what the merge changed about that requirement: the controls are mounted at
	 * all times now, so a p16 presence read passes while the sheet is collapsed and only a geometry read
	 * fails — a wrong number rather than a timeout. Those files are
	 * outside this change's scope; the contract records what the app IS, and the guard keeps reporting the
	 * gap until the drivers follow.
	 *
	 * WHICH GATE REPORTS IT, precisely, because two of the six drivers are invisible to the loudest one:
	 * `bun run typecheck:e2e` fails on a retired key (6 errors across measured-design.mjs's importer chain
	 * into lib/phone.mjs, party.mjs and p4-transport.mjs). That is the SAME already-accepted red the last
	 * retirement left — `searchDock` has been failing that gate with 3 errors since the band took the
	 * bottom edge — so this is a known shape rather than a new one. But p16-hero-live-controls.mjs and
	 * shoot-913.mjs are not in tests/tsconfig.e2e.json's `include`, so their reads fail SILENTLY at
	 * runtime (`document.querySelector(undefined)` matches nothing) and only this record says so.
	 */
	/*
	 * RETIRED: `toolsToggle` (`.tools-toggle`) and `toolsPeek` (`.tools-peek`) — the hero's live-controls
	 * DISCLOSURE. The toggle was a Collapsible trigger whose `aria-expanded` told a driver the panel was
	 * open; the peek was the collapsed summary line beside it, which had to NOT carry the explanation.
	 * Neither class exists in any source, and an anchor guard for markup nobody renders reports a permanent
	 * failure rather than an invariant.
	 *
	 * The drawer REPLACED the disclosure; it did not move it. Opening the drawer is the one act of
	 * revealing, so there is no collapsed state, no summary to keep a sentence out of, and nothing for a
	 * second level of disclosure to do. Nothing returns in their place: "is the panel open?" became "how
	 * high is the sheet?", which is `activeSnapPoint` — NOT `npDrawer`, and see that entry for why. p16's
	 * `toolsOpen` (aria-expanded) and its peek-text assertion therefore have no successors: the states they
	 * told apart no longer exist.
	 *
	 * AMENDED (the sheet merge). The sentence above used to end: "which `npDrawer` answers BY PRESENCE —
	 * vaul portals the content on open and destroys it on close, so the element existing IS the open state
	 * and there is no attribute to read." That was true of a drawer that opened and closed and is false of
	 * a permanently-mounted one. `.np-drawer` is present at ALL times, so reading its presence as the open
	 * state now answers "yes" forever — a check that cannot fail, which is worse than one that reds.
	 *
	 * `toolsBody` and `toolsNote` are NOT retired with them — both class names survived into the drawer.
	 * See the drawer block below for the deliberate call on each, and for what changed about the body's
	 * reason.
	 */
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
	/**
	 * Back to the queue from the find surface. It NAVIGATES now — a real `<a href="/">` that
	 * `PageHeader` renders inside its `.back-slot` wrapper, requested by `/find` as
	 * `back={{ href: '/', label: 'Back to the queue' }}` — rather than clearing a query in place.
	 *
	 * RE-ANCHORED from `[data-testid="back-to-queue"]`, a test-only hook on the retired in-place
	 * "← Queue" control that called `clearSearch()`. Home renders neither that control nor a search box
	 * to clear, so the old anchor could only report a permanent failure. The behaviour it stood for did
	 * not die, it changed KIND: `/find` is a route, so the way back is the route's own back affordance
	 * and the phone's back gesture now does the same thing rather than leaving the room.
	 *
	 * Addressed by the page-rendered wrapper plus the tag rather than by a class on the control: the
	 * control is a `<Button href>`, whose classes belong to the component and can be re-vendored.
	 * `.back-slot` is the part that pins THIS control; the `a` part resolves as "this tag is rendered
	 * somewhere" (see selectorResolves — a source scan cannot see co-location).
	 *
	 * AMENDED: the sentence that followed said "`returnHomeFromBrowse()` in lib/phone.mjs still works
	 * unchanged: it clicks this, then waits for `hero`, which renders on `/` once the navigation lands."
	 * There is no hero — home is the queue only. The CLICK still works; the WAIT has to change, and not to
	 * `homeReady`: the band is app chrome on every phone surface including `/find`, so its presence cannot
	 * prove the navigation landed. `queueRow`/`mainColumn` — or the pathname itself, which the helper's
	 * siblings already read — is what says the flow is back on `/`. Recorded here rather than fixed there
	 * because lib/phone.mjs is outside this change's scope.
	 */
	backToQueue: '.back-slot a',
	/** The search field itself. On `/find` since the band took the bottom edge — it was on `/` when the
	 *  box was docked there, and the aria-label is deliberately unchanged so only the FILE moved. */
	search: 'input[aria-label="Search a song or artist"]',
	/*
	 * RETIRED: `searchDock` was `.search-dock`, the search band docked at the bottom of home. It had two
	 * jobs and both moved: it published `--dock-h`, and it was what the measured band gate read the band
	 * contract off. `NowPlayingBand` owns the bottom edge now, carries the only
	 * env(safe-area-inset-bottom) term in the stack, and is what `--dock-h` is measured from (since the
	 * sheet merge, the drawer's `.band-slot` holds the band and the layout binds its clientHeight through
	 * the drawer's `bandH` prop; it used to be a `.dock` wrapper in src/routes/+layout.svelte). No source
	 * renders a docked search band, so the anchor could only resolve red.
	 *
	 * Its successor is `findBox` below, and it is a NEW entry rather than a re-anchor on purpose:
	 * "docked in the thumb zone, publishing the measured band height" was the whole claim the old name
	 * made, and the find box is sticky at the TOP of its own route and publishes nothing. Re-pointing
	 * the name would have left a selector called `searchDock` at an element that is not a dock.
	 */
	/** The find surface's search box: the sticky wrapper holding the mark, the field, the searching
	 *  spinner and the clear control. */
	findBox: '.findbox',
	/** The find box's clear control — empties the query and returns the surface to the library view.
	 *  (The retired `backToQueue` testid used to be the control that cleared a search; clearing and
	 *  leaving are two different acts now, and this is the clearing one.) */
	clearSearch: '[aria-label="Clear the search"]',
	songRow: '.row',
	songTitle: '.row .t',
	addTurn: '.row [data-testid="song-add"]',
	sing: '.row [data-testid="song-sing"]',
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
	 * above): p3/p8/p10 query the row actions and `.t` on their own to check an action or a title exists at all,
	 * and p8/p12 read the presence and empty-state chrome. Named here so those reads come through the
	 * contract instead of being spelled out per probe (migrated from KNOWN_OFFENDERS).
	 */
	addAction: '[data-testid="song-add"]',
	singAction: '[data-testid="song-sing"]',
	/** "queued or ready" in one query — p8 asks whether a row offers EITHER queue action; a comma
	 *  union, so one branch resolving is enough. */
	addOrSing: '[data-testid="song-add"],[data-testid="song-sing"]',
	rowTitle: '.t',
	/*
	 * The empty-state line — an empty rotation on `/`, and a query that matched nothing on `/find`.
	 *
	 * RE-ANCHORED to `.encore-empty`; `.empty` is gone. The empty state is `<Empty.Root>` now, and
	 * ui/empty/empty.svelte keeps the registry's Root/Header/Description structure while carrying Encore's
	 * appearance under its own base class — the old `.empty` rule (dim ink, `--space-2xs` inline padding,
	 * `--ph-text-md`) moved there verbatim, which is why the copy the drivers read is unchanged. Same defect
	 * shape as the `.chip` → `.encore-chip` re-anchor above: a primitive adoption took the hand-rolled class
	 * with it and left the contract pointing at nothing. This one is NOT part of the hero move; it was
	 * already red on this branch and is fixed here because it is this file's own broken anchor.
	 *
	 * NOT `[data-slot='empty']`, though the same element carries that too. The resolver's attribute anchor is
	 * a PREFIX substring (`data-slot="empty`), and the family ships `empty-title`, `empty-header`,
	 * `empty-description`, `empty-content` and `empty-icon` — so that spelling would keep resolving after
	 * Root itself was deleted, off a sub-slot no driver reads. `classPresent` matches an EXACT token, which
	 * makes the class the stronger anchor here; it is the same tightening G2 pinned when `.b` was resolving
	 * off the `badqr-b` fragment.
	 */
	empty: '.encore-empty',
	/*
	 * RETIRED: `readyChip` was `.chips button.ok`, the Ready readiness filter chip. Direction B
	 * deleted the readiness chip row — one of the four concurrent filter mechanisms — so the anchor no
	 * longer exists in any source and the entry could only resolve vacuously or red. p12-search reached
	 * `readyEmptyState` by clicking it; it now reaches the same copy by typing a non-matching query,
	 * which is the condition that empty state was always really about. `browseToggle` ('.browse-toggle')
	 * went with the same diff and for the same reason: the disclosure it opened is gone.
	 *
	 * NEITHER RETURNS WITH `/find`, and the distinction is worth stating because that route looks like
	 * the browse view coming back. What returned is a SURFACE, not a control: `/find` opens with the
	 * library already listed, so there is nothing to reveal (no toggle) and nothing to filter down to
	 * (no readiness chip) — readiness is a per-row fact the rows state themselves, and narrowing is done
	 * by typing. A chip or a disclosure reappearing here would be re-adding a filter mechanism direction
	 * B removed, which is why these records stand rather than being reversed with the surface.
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

	// ── the now-playing band (app chrome: +layout.svelte → NowPlayingBand.svelte) ──────────────
	/*
	 * The band's two controls. It is the bottom-most app chrome on EVERY phone surface, so unlike
	 * anything above these are reachable wherever a driver happens to be — which is what makes the
	 * magnifier the entry point search now has.
	 *
	 * `bandSearch` NAVIGATES to `/find`; it is not a toggle and not a mode. That is the difference
	 * between it and the retired `openBrowse` (see the retirement note above), and it is why the band's
	 * arrival did not resurrect that entry.
	 *
	 * `bandTransport` is addressed by CLASS, not by role/name, and deliberately: the disc names itself
	 * `aria-label={isPlaying ? 'Pause' : 'Play'}` — an EXPRESSION — so neither `aria-label="Play"` nor
	 * `aria-label="Pause"` exists as source text, and a `{role, name}` entry here could not resolve
	 * (the guard resolves that shape by grepping for the literal attribute). The HOOK below anchors the
	 * expression itself instead, so the pair of labels cannot be renamed unnoticed.
	 *
	 * NOT the same control as `play` further down: that is the DRAWER's `aria-label="play/pause"`. Two
	 * transports still exist on two surfaces, and conflating them is how a driver ends up asserting one
	 * surface's state against a tap on the other — but the surfaces changed twice. It used to be the band
	 * versus the HERO, both on `/` and both always present; then the band (always) versus the drawer (only
	 * while open); and after the merge BOTH are always mounted, because they are the same permanently-
	 * mounted sheet at two heights. So presence can no longer tell them apart at all and only the SCOPE
	 * can: this one is inside `.band`, `play` is inside `.np-drawer` past the fold. The band's disc is
	 * still the only transport a flow can tap without first pulling the sheet up.
	 */
	bandSearch: { role: 'button' as const, name: 'Search for a song' },
	bandTransport: '.disc',
	/*
	 * RETIRED: `bandExpand` was `.band .handle` — the band's pull handle, and the way into the drawer while
	 * the band and the drawer were two surfaces. The merge made them one permanently-mounted sheet, so
	 * there is nothing to open: `[data-slot='drawer-handle']` (`drawerHandle` below) is the ONLY handle in
	 * the app now, and it is both the way IN (drag up to snap `0.82`) and the drag surface once there.
	 *
	 * THIS IS THE `hero` SHAPE, NOT AN ORDINARY RETIREMENT, and that is why it must be pinned rather than
	 * merely deleted. `.band .handle` STILL RESOLVES: `NowPlayingBand.svelte` is UNCHANGED and still
	 * declares `<button class="handle">` — inside `{#if onexpand}`. What changed is that NO call site
	 * hands the band an `onexpand` any more (the layout's wiring went with `drawerOpen`, and the five
	 * bands in /components never passed one), so the branch is never entered and the button never renders
	 * ANYWHERE. A selector that greps green against a component branch the app cannot reach is exactly the
	 * silent mis-resolution `.hero` and `.chip` each cost a migration to find, so contract.test.ts pins
	 * the absence — and pins the gate itself, so re-wiring an `onexpand` reds and forces this record to be
	 * revisited rather than quietly reviving a dead selector.
	 *
	 * ITS CLAIM DID NOT SURVIVE UNDER A NEW ADDRESS, which is why `drawerHandle` is not simply
	 * "bandExpand at a new selector". `bandExpand` meant "the button that OPENS a closed surface" — a
	 * click, on a control that existed only because a drawer was wired. `drawerHandle` is a DRAG surface
	 * on a sheet that is already mounted, and its own entry already records why losing it is silent. The
	 * two are different kinds of affordance, which is the same test `searchDock` → `findBox` applied.
	 *
	 * THE DRIVER MIGRATION IS NOT DONE, AND IT TAKES A GREEN GATE RED — recorded here, precisely, because
	 * that is worse than the earlier retirements and must not be discovered later. Unlike `searchDock` and
	 * the hero family, whose importers have since been cleaned up, `bun run typecheck:e2e` was CLEAN before
	 * this retirement and now reports 2 errors, both in `tests/e2e/lib/phone.mjs` (lines 80-81, in
	 * `openNowPlaying()`), which is outside this change's scope to edit.
	 *
	 * WHAT THAT HELPER MUST BECOME, so the fix is not re-derived from scratch. `openNowPlaying()` currently
	 * (a) short-circuits if `npDrawer` is already present, (b) waits for `homeReady`, (c) waits for and
	 * CLICKS `bandExpand`, (d) waits for `npDrawer`. Steps (a) and (d) are now no-ops that always pass —
	 * `.np-drawer` is permanently mounted — and (c) waits forever on a button the app cannot render. The
	 * successor is a DRAG on `drawerHandle`, and the thing to wait on afterwards is the sheet's HEIGHT, not
	 * its existence: `activeSnapPoint` at `0.82` rather than the collapsed `'80px'`. A rewrite that keeps
	 * waiting on presence will pass instantly against a collapsed sheet and hand every later read a hidden
	 * element.
	 *
	 * AND TWO READS THAT FAIL SILENTLY INSTEAD, because they are not in tests/tsconfig.e2e.json's
	 * `include`: `probes/p16-hero-live-controls.mjs` reads `SEL.bandExpand` three times (its interpolated
	 * `bandExpand` key, its `bandHandlePresent` probe, and a conditional click). Those become
	 * `querySelector(undefined)`, which matches nothing and reports "no handle" as a finding rather than as
	 * a broken read. Only this record says so.
	 */
	/*
	 * The playing song's title on the band, and the default successor to the retired `heroTitle` (see that
	 * record above). Reach for this one first: the band is present on every phone surface whenever a singer
	 * is joined, so it answers "what is playing / is my song up?" with no gesture, where the drawer's
	 * `npSong` is below the fold until the sheet is pulled up (`activeSnapPoint` `0.82`) — mounted, so a
	 * presence read passes, but not on screen, so anything measured off it is measured off a hidden
	 * element. The rotation reads need it because a playing entry renders no `.qrow` at all.
	 */
	bandTitle: '.band .title',

	// ── the now-playing sheet (app chrome: +layout.svelte → NowPlayingDrawer.svelte → NowPlayingBand) ──
	/*
	 * WHERE THE HERO WENT. The drawer carries everything NowPlayingHero did — song identity, the seek row,
	 * the transport, the live controls — and since the merge it carries the BAND too, as snap point 0.
	 *
	 * PRESENCE NO LONGER MEANS OPEN. This is the one fact every driver has to respect, and it INVERTED:
	 * the sheet is PERMANENTLY MOUNTED (`dismissible={false}` with a fixed `open`), so `.np-drawer` and
	 * `[data-slot="drawer-content"]` are present at ALL times and everything in this block can be waited
	 * on cold. The state that distinguishes collapsed from pulled up is `activeSnapPoint`, a bindable prop
	 * whose values are the vaul snap VALUES — `'80px'` (collapsed: only the band strip is above the fold)
	 * and `0.82` (pulled up). Not an index, and not a boolean.
	 *
	 * SO THE FAILURE MODE INVERTED WITH IT, which is the part worth writing down. This block used to say
	 * "nothing in this block can be waited on cold. Tap `bandExpand` first; a timeout here without that
	 * tap is the drawer being shut, not the app being broken." A driver that still reasons that way now
	 * gets the opposite trouble: no timeout, ever. Its wait succeeds against a collapsed sheet whose
	 * content sits below the fold, so an existence check passes with nothing on screen and any geometry,
	 * contrast or visibility read taken there is measured off a hidden element and reported as fact. A
	 * read that cannot time out is not a read that cannot be wrong.
	 *
	 * `npDrawer` is addressed by Encore's OWN class rather than by the vendored `data-slot='drawer-content'`
	 * the same element also carries — the opposite of the choice `slider` makes, and for a reason that does
	 * not contradict it. shadcn's data-slot is the sturdier NAME, but it is not a UNIQUE one: it says "a
	 * drawer's content", and any second drawer in the app carries it identically, where `.np-drawer` says
	 * THIS drawer. Both halves are pinned as HOOKS, in the two files they live in.
	 *
	 * IT IS STILL A SELECTOR WORTH KEEPING, even though what it proves shrank. It answers "the now-playing
	 * surface is mounted", which is a real claim — the layout only mounts it for a joined singer on a phone
	 * surface (`showBand`) — and it is the SCOPE every entry below is written against. What it must never
	 * again be read as is the open/closed signal.
	 */
	npDrawer: '.np-drawer',
	/** The playing song's title inside the drawer — `heroTitle`'s other successor, scoped to the drawer so
	 *  it cannot be confused with the band's copy of the same fact. Mounted at all times since the merge,
	 *  so prefer `bandTitle` for a bare "what is playing" read: this one is only ON SCREEN once the sheet
	 *  is at `0.82`. */
	npSong: '.np-drawer .np-song',
	/*
	 * The sheet's DRAG handle — and since the merge, the ONLY handle in the app, doing both jobs: it is the
	 * way IN (drag up from the collapsed band to snap `0.82`) and the drag surface once there. It replaced
	 * the band's retired pull handle (see the `bandExpand` record above) rather than joining it.
	 *
	 * Addressed by the `data-slot` the vendored component maintains.
	 *
	 * It is the only drag surface in the drawer: the Root sets `handleOnly` because the body is sliders, and
	 * a drag-to-dismiss surface under a slider thumb is the gesture collision XR-PH-15 bans. That makes its
	 * absence a silent failure rather than a cosmetic one — with no element carrying vaul's handle attribute
	 * the drawer cannot be dragged AT ALL and nothing warns, which is precisely what shadcn's copy-in did
	 * with a decorative div and why drawer-handle.svelte exists. The merge RAISED that stake: the same
	 * silent loss now also means the sheet can never leave the band height, so the transport and every live
	 * control become unreachable rather than merely awkward.
	 */
	drawerHandle: "[data-slot='drawer-handle']",
	/*
	 * THE DRAWER'S ONLY HEADER AFFORDANCE — the "\u00b7\u00b7\u00b7" that opens /song/[mediaId].
	 *
	 * Addressed as the ANCHOR inside the slot rather than as the slot, because the anchor is the claim:
	 * it is a real `<a href>` so back is the browser's own back and the route stays shareable, which a
	 * history.back() button gives up. A driver reading the slot would pass over a button.
	 *
	 * It renders only with a playing song, so a driver must open the drawer on one — its absence with
	 * nothing playing is correct, not a missing hook.
	 */
	songDoor: '.more-slot a',
	/*
	 * RE-POINTED, NOT RETIRED — and this is the call the move actually turned on, because BOTH class names
	 * survived into the drawer. A wrong decision here does not go red; it leaves a selector quietly
	 * resolving to something it was not written for.
	 *
	 * `toolsNote` is unambiguous: same class, same sentence, same claim, new file. XR-PH-15 IS this sentence
	 * ("No isolated vocals for this song…"); it is still rendered AHEAD of the control it explains, still
	 * un-dimmed by any ancestor `opacity` (XR-PH-03), and still present exactly when something is owed and
	 * absent when nothing is. Only the file moved, so the hook moved with it.
	 *
	 * `toolsBody` needed deciding. Its recorded reason was disclosure-relative — "the explanation must sit
	 * inside the body, which is what keeps it out of the collapsed summary" — and there is no summary any
	 * more, so half that sentence is dead. It is re-pointed anyway, because a hook's identity is its SUBJECT
	 * and the subject moved intact: the same element, wearing the same class, holding the same children (the
	 * note, GuidingTrack, the key head and its ±keycaps, the range, the lyrics reselect). What changed is
	 * its CONDITION, and that is the amendment on the record: `.tools-body` used to mean "the disclosure is
	 * open", then "the drawer is open AND a song is playing", and after the merge it means ONLY "a song is
	 * playing" — its `{#if hasSong}` gate is the whole of it, because the sheet it lives in is mounted
	 * unconditionally. A driver must NOT read it as an open/closed signal, and — the trap the merge added —
	 * must not read it as a pulled-up signal either: it is present while the sheet is collapsed, just below
	 * the fold. `activeSnapPoint` is the only thing that says which height the sheet is at, and `npDrawer`
	 * is not that signal either (see its entry).
	 *
	 * The opposite call would have been retire-and-add-fresh, which is what `searchDock` → `findBox` did.
	 * That was right there because the NAME carried the dead claim — "docked, publishing the measured
	 * height" — and nothing about the successor was docked. Here the name says "the body of the tools", the
	 * element is still the body of the tools, and only a clause of the reason lapsed.
	 */
	toolsBody: '.tools-body',
	toolsNote: '.tools-note',

	// ── transport (in the now-playing SHEET since the hero was deleted) ────
	// The SELECTORS are unchanged — same three aria-labels, same three controls — so the only thing that
	// moved is which file to look in. The gesture requirement changed shape with the merge: these are
	// MOUNTED at all times now, so a click no longer needs the sheet opened first, but they are below the
	// fold while it is collapsed, and a real tap has to land on a visible element. Pull the sheet up
	// (`activeSnapPoint` `0.82`) before driving them; use the band's own disc (`bandTransport`) for the
	// play/pause a flow wants without a gesture.
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
		file: 'src/routes/find/+page.svelte',
		anchor: 'aria-label="Search a song or artist"',
		why: 'the flow searches the library through this field, which moved to the /find route when the band took the bottom edge — the label is unchanged, so only the FILE moved'
	},
	{
		id: 'songDoor',
		file: 'src/lib/components/NowPlayingDrawer.svelte',
		anchor: 'class="more-slot"',
		why: 'the \u00b7\u00b7\u00b7 door to /song/[mediaId]; SEL.songDoor addresses the anchor INSIDE this slot, because being a real <a href> is the property that matters'
	},
	{
		id: 'findBox',
		file: 'src/routes/find/+page.svelte',
		anchor: 'class="findbox"',
		why: 'the box the field sits in, sticky at the TOP of /find — the successor to the retired docked search band'
	},
	{
		id: 'mainColumn',
		file: 'src/routes/+page.svelte',
		anchor: '<main>',
		why: 'the gate measures this column reserving the docked band, so the element itself is load-bearing'
	},
	/*
	 * RETIRED: the `hero` hook (anchor `class="hero card"`) and the `heroTitle` hook (anchor
	 * `class="song"`), both in src/lib/components/NowPlayingHero.svelte — a file that no longer exists, so
	 * the file-existence test is what reported them rather than the anchor test.
	 *
	 * See the SEL retirement record for the two things that make these retirements rather than re-points:
	 * `.hero` STILL RESOLVES (against the TV's JoinBadge), so a re-point at the drawer would have been
	 * green and aimed at the television; and `heroTitle` names a place that is gone, so its surviving claim
	 * went to `bandTitle` + `npSong` instead of moving under the old name.
	 *
	 * RETIRED WITH THEM: the `toolsToggle` hook (anchor `class="tools-toggle"`) and the `toolsPeek` hook
	 * (anchor `class="tools-peek"`). The drawer replaced that disclosure rather than moving it, so neither
	 * class exists anywhere and neither has a successor — opening the drawer is the whole of the reveal.
	 *
	 * `toolsBody` and `toolsNote` moved rather than died; their entries are below, under the drawer.
	 */
	{
		id: 'npDrawer',
		file: 'src/lib/components/NowPlayingDrawer.svelte',
		anchor: 'class="np-drawer"',
		why: 'the surface the hero became — song, seek row, transport and live controls, pulled up from the band instead of rendered at the top of home'
	},
	{
		id: 'drawerMounted',
		file: 'src/routes/+layout.svelte',
		anchor: '<NowPlayingDrawer',
		why: 'npDrawer can only resolve because the LAYOUT mounts the sheet; the component rendering the class is not the same claim as the app showing it. Since the merge this is the TOP of a two-link chain (layout → drawer → band), and `bandMounted` is its other link — the layout mounts nothing else, so if this anchor goes the band goes with it'
	},
	{
		id: 'npSong',
		file: 'src/lib/components/NowPlayingDrawer.svelte',
		anchor: 'class="np-song"',
		why: "the playing song's title inside the drawer — one of the two successors to the retired heroTitle, for a flow that has already opened it"
	},
	{
		id: 'drawerHandle',
		file: 'src/lib/components/ui/drawer/drawer-handle.svelte',
		anchor: 'data-slot="drawer-handle"',
		why: 'handleOnly restricts dragging TO this element, so losing it makes the drawer silently undraggable rather than merely unadorned — shadcn ships a decorative div in its place, which is the trap this file exists to avoid'
	},
	{
		id: 'toolsBody',
		file: 'src/lib/components/NowPlayingDrawer.svelte',
		anchor: 'class="tools-body"',
		why: 'the same live-controls body, re-pointed with the move: it now means the drawer is open AND a song is playing, rather than a disclosure having been revealed'
	},
	{
		id: 'toolsNote',
		file: 'src/lib/components/NowPlayingDrawer.svelte',
		anchor: 'class="tools-note"',
		why: 'XR-PH-15 IS this sentence; p16 asserts its presence for a dead control and its absence for a live one — unchanged by the move except for the file'
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
		file: 'src/routes/find/+page.svelte',
		anchor: "back={{ href: '/', label: 'Back to the queue' }}",
		why: 'the find surface must OFFER a way back to the queue; this is the route asking PageHeader for one'
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
	/*
	 * RE-POINTED, NOT RETIRED: `bandMounted`'s anchor `<NowPlayingBand` moved out of
	 * `src/routes/+layout.svelte` and into `src/lib/components/NowPlayingDrawer.svelte`. The CLAIM is
	 * unchanged and is why the name stays — `homeReady` (`.band`) resolves against a component, and a
	 * component rendering a class is not the same thing as the app rendering the component, so the mount
	 * itself has to be pinned somewhere. Only the file moved, exactly as `search` did when it moved to
	 * `/find`: the band is composed as snap point 0 of the sheet instead of being a fixed sibling of it.
	 *
	 * IT IS NOW HALF A CHAIN, and that is a strengthening rather than a dilution. `drawerMounted` pins
	 * layout → drawer and this pins drawer → band; both must hold for `.band` to reach a phone, and each
	 * fails at the file that broke. Neither could catch the other's break: dropping `<NowPlayingBand` from
	 * the drawer leaves the layout's mount perfectly intact.
	 *
	 * NOT SATISFIED BY THE LAYOUT'S IMPORT. `+layout.svelte` still carries
	 * `import NowPlayingBand from '$lib/components/NowPlayingBand.svelte'` with no remaining call site —
	 * dead after the merge, and outside this file's scope to remove. The anchor is deliberately `<`-
	 * prefixed, so an import cannot satisfy it and the hook keys on the band being RENDERED.
	 */
	{
		id: 'bandMounted',
		file: 'src/lib/components/NowPlayingDrawer.svelte',
		anchor: '<NowPlayingBand',
		why: 'homeReady only holds because the sheet COMPOSES the band as its snap-0 content on every phone surface; the component rendering the class is not the same claim as the app showing it'
	},
	{
		id: 'bandSearch',
		file: 'src/lib/components/NowPlayingBand.svelte',
		anchor: 'aria-label="Search for a song"',
		why: 'the ONLY way to reach search now — the magnifier navigates to /find, which is what replaced the docked box'
	},
	{
		id: 'bandTransport',
		file: 'src/lib/components/NowPlayingBand.svelte',
		anchor: "aria-label={isPlaying ? 'Pause' : 'Play'}",
		why: "the band's transport disc; anchored on the EXPRESSION because that is the only source text either label has, and SEL.bandTransport can only address it by class"
	},
	/*
	 * RETIRED: the `bandExpand` hook (anchor `aria-label={hasSong ? 'Open now playing' : 'Open the player'}`
	 * in NowPlayingBand.svelte) and the `bandExpandWired` hook (anchor `onexpand={() => (drawerOpen = true)}`
	 * in +layout.svelte). The band and the drawer were MERGED into one permanently-mounted sheet, so there
	 * is no closed surface for a pull handle to open. `drawerHandle` is the only handle in the app now.
	 *
	 * THE TWO WERE RETIRED BY DIFFERENT GATES, and the asymmetry is the whole lesson of this pair, so it is
	 * recorded rather than smoothed over. `bandExpandWired` went RED on the anchor check the moment the
	 * layout's wiring was deleted with `drawerOpen` — a loud, immediate failure at the right file.
	 * `bandExpand` did NOT and could not: `NowPlayingBand.svelte` is UNCHANGED, so its aria-label
	 * expression is still there, still greppable, still green. The claim died while the anchor lived.
	 *
	 * WHICH IS EXACTLY WHY THE PAIR EXISTED. The record on the retired `bandExpand` SEL entry says the
	 * button is gated on `{#if onexpand}`; the WIRING hook was the half that proved somebody passed one.
	 * Deleting the wiring hook alone would therefore have left a component-level hook asserting a control
	 * the app cannot render — the `.hero` shape again, arrived at by removing a guard instead of by moving
	 * a class. So both go, and contract.test.ts pins the gate itself (the prop and its `{#if}`) plus the
	 * absence of any `onexpand=` call site: re-wiring one reds and sends a reader back to this record.
	 *
	 * `bandExpandWired`'s claim did not simply vanish — it CHANGED KIND, and its successor is
	 * `drawerHandleOnly` below rather than a re-anchor of the name. "The app hands the band an action, so
	 * its labelled button does something" became "the app restricts dragging TO the handle, so the sheet's
	 * body of sliders is not also a drag surface". Same shape of claim (a component's affordance is only
	 * real because the app configured it), different affordance, so a new entry rather than a moved one —
	 * the `searchDock` → `findBox` rule.
	 */
	{
		id: 'drawerHandleOnly',
		file: 'src/lib/components/NowPlayingDrawer.svelte',
		anchor: 'handleOnly',
		why: "drawerHandle only means anything because the Root RESTRICTS dragging to it; drop this prop and vaul drags from anywhere in a body made of sliders (XR-PH-15), which is a gesture collision rather than a missing element — the successor to the retired bandExpandWired, and the same claim shape: the component renders the handle, the app decides it is the only one"
	},
	{
		id: 'bandTitle',
		file: 'src/lib/components/NowPlayingBand.svelte',
		anchor: 'class="title"',
		why: 'the playing song read with no gesture, on chrome present across every phone surface — the default successor to the retired heroTitle, because a playing entry renders no queue row'
	},
	/*
	 * RETIRED: the `searchDock` hook (anchor `class="search-dock"`). The band owns the bottom edge and
	 * publishes `--dock-h`, so no source renders a docked search band and the anchor could only report a
	 * permanent failure. `findBox` above is the successor — the same box, sticky at the top of `/find`,
	 * which is a different claim and so a different entry (see the SEL retirement note for why the name
	 * was not simply re-pointed).
	 */
	/*
	 * RETIRED: the `openBrowse` hook (anchor `class="cta" onclick={openBrowse}`). The owner correction docked the
	 * search box permanently and deleted the `+ Add a turn` button that used to push `?browse=1`, so the
	 * anchor is absent from every source — an anchor guard for markup nobody renders reports a permanent
	 * failure, not an invariant.
	 *
	 * AMENDED: the sentence that followed said "the search box is now reached with no click; `homeReady`
	 * above is the band that proves the joined home rendered", and neither half is true any more. Search
	 * is reached by TAPPING `bandSearch` and navigating to `/find`, and `homeReady` is the now-playing
	 * band rather than a search band. The retirement itself stands: what came back is a browse SURFACE,
	 * not the control that used to reveal one — `bandSearch` is permanent chrome that goes somewhere,
	 * where `openBrowse` was a button that appeared in order to open a mode in place.
	 */
	/*
	 * RETIRED: the `readinessChips` hook (anchor `aria-label="Filter by readiness"`) and the
	 * `browseToggle` hook (anchor `class="browse-toggle"`). Direction B deleted the readiness chip row
	 * and the browse disclosure outright, so both anchors are absent from every source — an anchor
	 * guard for markup nobody renders reports a permanent failure, not an invariant.
	 *
	 * AMENDED: what replaced them was `searchDock`, and that entry is retired too (see its note above).
	 * The successor is `findBox` — on `/find`, where an empty query lists the library outright. So there
	 * is still exactly ONE way to narrow the list and it is still typing; the route did not bring a chip
	 * or a disclosure back with it, and re-adding either would restore a filter mechanism direction B
	 * deliberately removed.
	 */
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
		why: 'SEL.empty was re-anchored here from the deleted `.empty`; the class is an Encore deviation inside a copy-in, so it is exactly the kind of thing a re-vendor drops silently'
	},
	// transport — in the now-playing SHEET since NowPlayingHero.svelte was deleted. The SELECTORS are
	// unchanged (same aria-labels on the same three controls); only which file to look in moved. Since the
	// merge the sheet is mounted at all times, so these resolve and exist without a gesture — but they are
	// below the fold until it is pulled up to `0.82`, so a tap or a measurement still needs the drag.
	{
		id: 'play',
		file: 'src/lib/components/NowPlayingDrawer.svelte',
		anchor: 'aria-label="play/pause"',
		why: 'the flow starts playback through the real control, not a synthetic socket message'
	},
	{
		id: 'skip',
		file: 'src/lib/components/NowPlayingDrawer.svelte',
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
