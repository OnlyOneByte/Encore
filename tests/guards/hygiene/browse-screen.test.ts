// THE BROWSE SCREEN, DIRECTION B — the deletion is the invariant.
//
// WHY A SOURCE SCAN, AND WHERE IT STOPS. What direction B changes on this screen is which markup and
// which state EXIST: three readiness chips, an artist rail, a genre rail and two colour-coded group
// headings are gone. That is a set of syntax claims, and syntax claims are what a scan can settle. The
// geometry those claims imply — the box really reachable through a long scroll, the band really sitting
// at the bottom edge, nothing occluded with the keyboard up — is a MEASUREMENT and is not asserted here
//; `bun run gate:measured` drives the real render for that.
//
// The shape matters: a deletion is invisible to a behavioural suite. Nothing imports these routes, so
// every mechanism below could be restored with the whole suite green. These are the assertions that
// RED when one comes back, one test per mechanism so a failure names which one.
//
// WHERE THE SUBJECT LIVES NOW. The browse screen was a MODE of the queue route; the phone-remote rebuild
// made it a route of its own (`src/routes/find/+page.svelte`) and hoisted the state it read out of the page;
// the merge (2026-09-22) brought the surface back to the queue route, as a section of it rather than a mode.
// Net of both moves:
//
//   * the surface itself:      `src/routes/+page.svelte`  ->  (via /find) -> `src/routes/+page.svelte`
//   * the saved library:       page-local `loadLibrary`   ->  `src/lib/stores/room.ts` (`refreshLibrary`)
//   * the bottom-edge band:    page-local `.search-dock`  ->  `src/routes/+layout.svelte` -> the drawer
//
// So this guard reads FOUR sources rather than one. Each is stripped and floored separately (see the
// non-vacuity arm), because a re-point that silently reads the wrong file asserts nothing.
//
// RETIREMENT RECORDED HERE. `routes/library-tag-filter-wiring.test.ts` is DELETED by this
// change, not weakened. It pinned five render seams of the tag filter — `facets.tags` state, a
// `browseFilter` that could hold a tag, `setBrowse('tag', …)`, the `?tag=` query and the tag rail
// itself — every one of which is a mechanism direction B removes. Its premise was "the tag filter is
// wired through the phone page"; the ruling is that the phone page has no tag filter. The SERVER half
// of is untouched and still guarded (`server/media/library-tag-filter.test.ts`,
// `routes/api/library/library-tag-filter-wiring.test.ts`), which is why only one of the three
// similarly-named files retires. The absence is pinned below so it cannot creep back in unnoticed.
//
// ── REVERSALS RECORDED HERE (a retired requirement is recorded, never vanished) ────
//
// Five arms of this guard pinned a LAYOUT ruling that the phone-remote rebuild reversed on purpose.
// None of the five is deleted; each is rewritten to assert the decision that replaced it, and the
// old claim is written down here so a reader can see what was traded away and why.
//
//  R1. "search is a docked band in the thumb zone, publishing the measured --dock-h".
//      WAS: a `.search-dock` fixed to the bottom of `/`, gated on `{#if me}`, whose `bind:clientHeight`
//      published --dock-h — the sole band on the route, so one measurement reserved the only band there
//      was. NOW: `NowPlayingBand` owns that edge as app chrome on EVERY phone surface, mounted in
//      `+layout.svelte` inside a `.dock` wrapper that publishes --dock-h. Two things cannot fight for
//      one edge, and the band is the one that must always be there — so the box moved to the TOP of
//      /find and docks nothing at all. The measurement claim survives verbatim; only its
//      OWNER moved, and it is now pinned in the layout, one publisher for the whole app. Restated as:
//      "the band owns the bottom edge and publishes the measured --dock-h; the find box docks
//      the top and reserves the band in flow".
//
//  R2. "the results stack UPWARD: every result list is emitted with its best match last".
//      WAS: three `[...list].reverse()` stacks and a section order of raw -> processing -> ready, so the
//      top-ranked row sat beside the thumb, above a box docked at the bottom. That ordering was a
//      consequence of R1's docked box and nothing else. NOW the surface reads DOWNWARD from a page
//      header, so the best match comes FIRST: no `.reverse()` anywhere, and the section order is ready
//      before needs-karaoke. The `column-reverse` ban is KEPT unchanged and now does more work than it
//      did: DOM order must still equal visual order, and a reversing container is the one
//      way to break that without touching the markup order this arm reads.
//
//  R3. "the bottom-anchored column reserves the top for the back control".
//      WAS: `main:has(> .backrow)` as a flex column with `margin-bottom: auto` on the back control, so
//      one line of content sat beside the thumb rather than at the top of an empty screen, plus an
//      `align-content: end` grid arm for the wide layout. NOW /find is TOP-anchored: the back control
//      is `PageHeader`'s (`back={{ href: '/', … }}`), which is a real `<a href>` rather than a route-local
//      row, and the wide layout is `align-content: start`. The `.backrow` mechanism is banned outright
//      below, so the anchoring cannot revert by halves.
//
//  R4. "a stack that grows upward is scrolled to, instantly and only when the set changes".
//      WAS: a `resultShape` derived plus `window.scrollTo({ top: scrollHeight })`, needed only because
//      bottom-anchored content longer than the viewport starts at the far end of the ranking. With the
//      ranking reading downward from the top there is nothing to scroll TO, so the whole mechanism is
//      banned rather than re-pointed — the replacement is a box in normal flow, reachable by a flick
//      through a long scroll without moving the viewport under the reader. The `behavior: 'smooth'` ban
//      is KEPT: a scroll animation is still motion no reduced-motion guest asked for, and it is still
//      the one way to introduce it that motion.test.ts's matcher cannot see.
//
//  R5. "the docked box survives the on-screen keyboard, by the one mechanism that can say so".
//      The `interactive-widget=resizes-content` claim is UNCHANGED and still pinned — but its SUBJECT
//      moved with R1. It no longer lifts the search box (which sits at the top of the flow, above the
//      keyboard by construction); it lifts the BAND, which is the `position: fixed; bottom: 0` element
//      now. Still unverifiable by the measured gate — headless Chromium has no soft keyboard — so this
//      scan remains the only thing that checks it. NOTE for a source owner: `src/app.html`'s own comment
//      still explains the attribute in terms of "the search box a guest is typing into", which is stale
//      prose describing R1's world. This guard does not edit source; flagged, not fixed.
//
//  R6. mechanism 4, PARTIALLY reversed. WAS: the readiness group headings are gone, because they
//      restated in prose the chip directly above them and SongRow already paints a readiness chip per
//      row. The duplication that ruling was about was heading-vs-CHIP-ROW, and the chip row is still
//      gone. /find renders up to three groups at once with no chips anywhere, so each group needs a
//      name to be tellable from its neighbours — and the headings are back for that reason. What stays
//      retired is the colour-coded, state-gated FORM of them: `showGroupHeads`, `.grouphead ok` /
//      `.grouphead warn`, the `.grouphead-mark` rule, and the "Processing · queue it anyway" wording.
//      One neutral `.grouphead` treatment, four headings, no per-readiness variants. Restated as:
//      "the group headings name WHICH LIST, in one neutral treatment — never the readiness of their
//      members". A reader who thinks "Ready to sing" over ready-chipped rows is still the banned
//      duplication should reopen the ruling, not weaken this arm: it pins what the source does today.
//
//  R7. THE FIFTH SOURCE, and why `/`'s own floor came DOWN. Nothing about a browse mechanism changed
//      here — what changed is that `/` is now QUEUE-ONLY. `NowPlayingHero` is deleted and the song
//      identity, transport and live singing controls moved into `NowPlayingDrawer`, mounted in
//      `+layout.svelte` and opened by the band's pull handle. `/` went from ~1520 lines to ~1070, so its
//      non-vacuity floor fired.
//
//      That floor is a FINDING, not a number to adjust (`tests/guards/meta/non-vacuity-floors.test.ts`
//      states the doctrine), and the accepted resolution here is (b) RE-ANCHOR: follow the surface. So
//      the drawer is read as a FIFTH source, carries its own two floors, and is added to the ban loops
//      the queue route already appears in — it is app chrome on EVERY phone surface now, which makes it
//      the newest place a readiness chip row or a facet rail could come back WITHOUT touching `/` or
//      /find. `/`'s floors are then set to what a queue-only route genuinely supports. The code this
//      guard examines therefore goes UP, not down; the floor's job — proving `read()` really landed on
//      the file and the stripper did not blank it — is unchanged at every one of the five addresses.
//
//  R8. THE BAND AND THE DRAWER ARE ONE SURFACE NOW, which reverses the two-element arrangement R1 and R7
//      are both written about. `NowPlayingBand` is COMPOSED inside `NowPlayingDrawer` as the first child
//      of its content (`.band-slot`), and that element is snap point 0 of a permanently-mounted vaul
//      sheet. So `+layout.svelte` mounts ONE component inside `{#if showBand}`, there is no `.dock`
//      wrapper, no `drawerOpen`, and no `onexpand` callback between the two. What forced it is a gesture:
//      an outside element can START a pointer gesture but cannot hand the in-flight pointer to vaul, so
//      the old band's handle advertised a drag it could only answer with a jump.
//
//      R1's MEASUREMENT CLAIM SURVIVES VERBATIM, in two named steps rather than one binding: `.band-slot`
//      measures itself with `bind:clientHeight={bandH}` (that height IS snap 0), the layout takes it back
//      with `bind:bandH={dockH}`, and the layout alone writes `--dock-h` and removes it on teardown. One
//      measurement, one publisher, both counted below.
//
//      R5's SUBJECT MOVES ONE ADDRESS FURTHER. The `position: fixed; bottom: 0` element the soft-keyboard
//      attribute lifts is no longer a rule this repo writes at all — vaul's own content element carries
//      it, through the vendored `ui/drawer/drawer-content.svelte` class list (`fixed` plus
//      `data-[vaul-drawer-direction=bottom]:bottom-0`). That file is therefore read as a SIXTH source,
//      with its own floor, because a claim asserted against a file this guard does not read is not
//      asserted at all.
//
//      THE `class:covered={drawerOpen}` FADE IS RETIRED, and it is the one mechanism here that loses
//      assertions outright rather than moving. It existed only because two surfaces of the same colour
//      with matching top edges had to step out from under each other for the length of the open; one
//      surface at two heights has nothing to hide. Its `opacity`-never-`visibility` rider is DELETED as
//      vacuous — see the deletion note at the arm that carried it.

import { test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { at, filesUnder, read, relative } from '@encore/test-support';

/*
 * Comments are stripped for the ABSENCE arms and kept for the presence arms. A deletion guard that
 * reads raw source reds on its own explanatory prose — this file's own comments name every mechanism
 * it bans — so the bans read stripped source, which is also what makes "restored inside a comment"
 * legitimately pass: a commented-out rail renders nothing.
 */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src
		.replace(/<!--[\s\S]*?-->/g, blank)
		.replace(/\/\*[\s\S]*?\*\//g, blank)
		.replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

// The band, its dock, and the single --dock-h publisher.
const LAYOUT_RAW = read('src/routes/+layout.svelte');
const LAYOUT = stripComments(LAYOUT_RAW);
const BAND_RAW = read('src/lib/components/NowPlayingBand.svelte');
const BAND = stripComments(BAND_RAW);
// The saved library, hoisted out of the page.
const ROOM_RAW = read('src/lib/stores/room.ts');
const ROOM = stripComments(ROOM_RAW);
/*
 * THE BROWSE SURFACE AND THE QUEUE ARE ONE FILE AGAIN (2026-09-22), which is why there is one page
 * constant here and not two.
 *
 * This guard was written against `routes/+page.svelte`, re-pointed at `routes/find/+page.svelte` when
 * search became its own route, and read BOTH from then on — the new address for the presence arms, the old
 * one as the second half of every "did not creep back" ban. The find route is now merged into home: the
 * search field, the library and the result groups are sections of `/`, under the queue's own heading. So
 * `HOME` is gone and every arm reads `HOME`, which is both the surface that owns the mechanisms and the
 * address they would creep back at. The bans lose nothing by collapsing — there is no second route left
 * for a rail to return on — and the drawer stays a separate subject below, because it is app chrome and so
 * IS a second address.
 */
const HOME_RAW = read('src/routes/+page.svelte');
const HOME = stripComments(HOME_RAW);
// R7: the now-playing drawer, which took the song identity, transport and live controls off `/`. Read
// because it is app chrome on every phone surface now, so it is a third address a banned mechanism could
// return at without touching either route. R8: it also mounts the BAND, as snap point 0.
const DRAWER_RAW = read('src/lib/components/NowPlayingDrawer.svelte');
const DRAWER = stripComments(DRAWER_RAW);
// R8: the vendored drawer content. Read because the `position: fixed; bottom: 0` that used to be `.dock`
// in the layout is now vaul's own, expressed in this file's class list — and R5's soft-keyboard claim is
// about that element. A claim asserted against a file this guard does not read is not asserted at all.
const DRAWER_CONTENT_RAW = read('src/lib/components/ui/drawer/drawer-content.svelte');
const DRAWER_CONTENT = stripComments(DRAWER_CONTENT_RAW);

// ── mechanism 1: the three readiness chips ───────────────────────────────────────────────────────
test('mechanism 1 — the readiness chip row is gone, and so is the state behind it', () => {
	// The row itself, by the group label every driven flow used to find it with. Banned on BOTH the new
	// surface and the old one: the chips could come back either at their old address or at the new one.
	// R7 adds the drawer, which is on every phone surface now and so is a third address for them.
	for (const [name, src] of [
		['home', HOME],
		['drawer', DRAWER]
	] as const) {
		expect(src, name).not.toContain('Filter by readiness');
		expect(src, name).not.toMatch(/class="chips"/);
		// …and the state, or the chips could be restored without re-deriving anything. `filter` was the
		// single source of the axis; `showReady`/`showProcessing`/`showRaw` gated the three groups on it, and
		// `libraryCount` existed only to put a number on the Ready chip.
		expect(src, name).not.toMatch(/\blet filter\b/);
		expect(src, name).not.toMatch(/\bshowReady\b/);
		expect(src, name).not.toMatch(/\bshowProcessing\b/);
		expect(src, name).not.toMatch(/\bshowRaw\b/);
		// `libraryCount` as a DERIVED is gone; the identically-named PARAMETER of readyEmptyState() is not
		// this mechanism and must survive — the empty state below still names how many songs the library has.
		expect(src, name).not.toMatch(/const libraryCount = \$derived/);
	}
	expect(HOME).toMatch(/libraryCount: library\.length/);
});

test('mechanism 1 — every group renders unconditionally, so nothing is hidden behind a chip', () => {
	// The processing group is gated on having rows and on NOTHING else — not on a filter, and (unlike the
	// docked-box version) not on `searchActive` either: whatever is being made right now shows in both the
	// library view and the results view. That is a strictly wider claim than the arm it replaces, and it is
	// what fails if a "quick" reinstatement re-adds a gate without the chips.
	//
	// `processingGroup`, NOT `processingRows`, since the merge (2026-09-22) — and the difference is not a
	// gate. The queue is on this surface again, and a song that is queued AND processing already has a row
	// with a live bar on it, so the group subtracts what the queue is drawing rather than printing a second
	// bar for one job. Both halves are pinned: the render is gated on the group having rows, and the group
	// is `processingRows` minus the queued ids — never minus a filter.
	expect(HOME).toContain('{#if processingGroup.length}');
	expect(HOME).toMatch(
		/const processingGroup = \$derived\(\s*searchActive \? processingRows : processingRows\.filter\(\(c\) => !queuedMediaIds\.has\(c\.id\)\)\s*\);/
	);
	// No group is gated on a show-flag of any kind, on either surface. This is the general form of the ban
	// the three named flags above cover, so a FOURTH flag under a new name reds here.
	expect(HOME).not.toMatch(/\{#if\s+show[A-Z]/);
	expect(HOME).not.toMatch(/\{#if\s+show[A-Z]/);
	// `accountedFor` subtracts BOTH groups from the shortcut lists unconditionally: with a filter, a
	// hidden group stopped accounting for its songs and they reappeared under Popular/Recently queued.
	expect(HOME).toMatch(/for \(const m of searchActive \? readyResults : library\) ids\.add\(m\.id\);/);
	expect(HOME).toMatch(/for \(const c of processingRows\) ids\.add\(c\.id\);/);
});

// ── mechanisms 2 and 3: the artist rail and the genre/tag rail ───────────────────────────────────
test('mechanisms 2+3 — the browse disclosure and both facet rails are gone from the phone', () => {
	// Banned at both addresses. The rails were markup on `/`; the surface that would host them today is
	// /find, so a scan of only one of the two would miss a reinstatement at the other. R7 adds the drawer:
	// it inherited the hero's disclosure body, which is where a facet rail would sit most plausibly now.
	for (const [name, src] of [
		['home', HOME],
		['drawer', DRAWER]
	] as const) {
		expect(src, name).not.toContain('browse-toggle');
		expect(src, name).not.toContain('Browse by artist');
		expect(src, name).not.toContain('Browse by tag');
		expect(src, name).not.toContain('Browse by genre'); // an earlier ruling still holds; this does not revive it
		expect(src, name).not.toMatch(/\bbrowseFilter\b/);
		expect(src, name).not.toMatch(/\bbrowseOpen\b/);
		expect(src, name).not.toMatch(/\bsetBrowse\b/);
		expect(src, name).not.toMatch(/\bfacets\b/);
	}
	// The route is NOT a browse MODE come back under a URL: no `?browse=1`, and no toggle into it. The
	// surface IS the browse view, reached by navigation, so there is nothing to toggle.
	expect(HOME).not.toContain('?browse=1');
	expect(HOME).not.toMatch(/\bopenBrowse\b/);
	expect(HOME).not.toMatch(/\bbrowseToggle\b/);
});

test('mechanisms 2+3 — the phone asks the library endpoint for the whole library, unfiltered', () => {
	// The narrowing was server-side (?artist= / ?tag=), so the fetch is where a rail would have to come
	// back through. One unqualified request, no query string built from a filter.
	//
	// RE-POINTED: the fetch is the room link's now, not the page's. That move is itself load-bearing and
	// is asserted rather than assumed — the surface reads `room.library` and asks for a refresh, so it
	// cannot reintroduce a narrowed request of its own.
	expect(ROOM).toMatch(/fetch\('\/api\/library'\)/);
	expect(HOME).not.toContain('/api/library');
	expect(HOME).toContain('library = room.library;');
	expect(HOME).toContain('room.refreshLibrary()');
	for (const [name, src] of [
		['room', ROOM],
		['home', HOME]
	] as const) {
		expect(src, name).not.toMatch(/\?artist=/);
		expect(src, name).not.toMatch(/\?tag=/);
	}
});

test('the retired tag-filter wiring guard is deleted, and its server sibling is not', () => {
	// A retired guard left in the suite is indistinguishable from one that is working.
	//
	// The three paths below MOVED in the test reorganisation and are now named from the repo root, which
	// is also what makes this arm honest: the retirement claim is about one guard among three that share
	// a name, and colocation used to be the only thing telling them apart. It no longer is, so the
	// absence is stated twice — at the address the phone-page guard would occupy, and as a sweep proving
	// it has not reappeared at any OTHER address under tests/.
	const RETIRED = 'tests/unit/routes/library-tag-filter-wiring.test.ts';
	expect(existsSync(at(RETIRED))).toBe(false);
	const sameName = filesUnder('tests', ['.test.ts'])
		.map((f) => relative(f))
		.filter((r) => r.endsWith('library-tag-filter-wiring.test.ts'));
	expect(
		sameName,
		'exactly one guard may carry this basename — the API half. A second one is the retired phone-page ' +
			'guard come back under a new address, which is what this ruling forbids.'
	).toEqual(['tests/guards/wiring/library-tag-filter-wiring.test.ts']);
	// Its sibling pins PER-ROW tag chips, which this change does not touch, and the server halves
	// of still hold. Deleting any of the three under cover of this ruling would be wrong.
	expect(existsSync(at('tests/guards/wiring/library-tags-page-wiring.test.ts'))).toBe(true);
	expect(existsSync(at('tests/guards/wiring/library-tag-filter-wiring.test.ts'))).toBe(true);
	expect(existsSync(at('tests/guards/subsystem-media/library-tag-filter.test.ts'))).toBe(true);
});

// ── mechanism 4 (REVERSED — see R6): the headings name WHICH LIST, in one neutral treatment ──────
test('mechanism 4 — the group headings name which list, and the retired colour-coded form stays gone', () => {
	// FIVE groups can be on this surface — four, until the merge added the QUEUE to the same column
	// (2026-09-22) — and up to three of them at once, with no chip row anywhere to tell them apart, so each
	// carries a name. Pinned by exact markup, because the claim is that all five share ONE neutral
	// treatment; a heading whose class drifted is the reversion this arm catches.
	expect(HOME).toContain('<h2 class="grouphead">Queued</h2>');
	expect(HOME).toContain('<h2 class="grouphead">Your library</h2>');
	expect(HOME).toContain('<h2 class="grouphead">Making karaoke…</h2>');
	expect(HOME).toContain('<h2 class="grouphead">Ready to sing</h2>');
	expect(HOME).toContain('<h2 class="grouphead">Needs karaoke</h2>');
	// Exactly five, all bare: the count is what makes "one treatment" falsifiable rather than decorative,
	// since a sixth heading or a variant class would have to pass through here.
	expect((HOME.match(/class="grouphead"/g) ?? []).length).toBe(5);
	// What mechanism 4 really retired: the per-readiness, state-gated FORM. A heading that carries the
	// readiness of its members in colour says the axis twice — SongRow already paints a chip per row —
	// and `showGroupHeads` was the flag that decided when to.
	expect(HOME).not.toMatch(/\bshowGroupHeads\b/);
	expect(HOME).not.toMatch(/class="grouphead ok"/);
	expect(HOME).not.toMatch(/class="grouphead warn"/);
	expect(HOME).not.toContain('Processing · queue it anyway');
	// …and the `.grouphead-mark` rule those variants were the only users of goes with them — a dead CSS
	// selector left behind is exactly the residue this deletion guard exists to red on.
	expect(HOME).not.toContain('grouphead-mark');
	// The zero-query shortcut lists (Popular tonight / Recently queued) were dropped with the browse
	// mode and did NOT come back with the route: an empty box shows the LIBRARY now, which is the whole
	// design idea — the songs you can sing are the default content rather than a hidden third state.
	for (const [name, src] of [['home', HOME]] as const) {
		expect(src, name).not.toContain('Popular tonight');
		expect(src, name).not.toContain('Recently queued');
	}
});

// ── what replaced them: a band at the bottom, a box at the top of the flow, one list reading down ──
test('the band owns the bottom edge and publishes the measured --dock-h; the find box docks nothing', () => {
	// R1. ONE band, ONE measurement, and both now live in the layout — which is what lets the band be app
	// chrome on every phone surface instead of a home-screen element. Gated on `showBand` (a joined singer
	// on a phone surface), so /tv never mounts it and never opens a `role=phone` socket.
	//
	// R8. It is ONE component that gets mounted there now: the drawer, with the band composed inside it as
	// snap point 0. `bind:bandH={dockH}` is the hop that carries the band's real rendered height back to
	// the layout. Matched through a bounded window rather than `[^>]*`, because the tag's own props contain
	// `>` (`() => goto(…)`) and a negated-class run would stop at the first arrow instead of the tag's end.
	expect(LAYOUT).toMatch(/\{#if showBand\}\s*<NowPlayingDrawer\b[\s\S]{0,200}?bind:bandH=\{dockH\}/);
	/*
	 * RETIRED (R8) — two positive arms, recorded here because the mechanism is GONE rather than moved:
	 *
	 *     expect(LAYOUT).toMatch(/class:covered=\{drawerOpen\}/);
	 *     expect(LAYOUT).toMatch(/\.dock\.covered \{\s*opacity: 0;/);
	 *
	 * They pinned the fade that took the band out from under the opening drawer. The defect was real —
	 * both surfaces were `--card` with a 1px top border and a matching top radius, so a sheet rising over
	 * the band showed two identical top edges and read as a second copy of the panel arriving rather than
	 * as the panel growing. With one surface at two heights there is no second edge, nothing to step out
	 * from under, and no open/closed state to drive a fade from.
	 *
	 * DELETED AS VACUOUS, not left green — the rider that travelled with them:
	 *
	 *     expect(LAYOUT).not.toMatch(/\.dock\.covered \{[^}]*visibility/s);
	 *
	 * WHAT IT PROTECTED: the fade had to be `opacity`, never `visibility` and never a height change. The
	 * band stayed in the layout while the drawer was open, so --dock-h must not move or every scrolling
	 * column reflows behind it; `visibility: hidden` would also have cut the cross-fade to a pop.
	 * WHY IT IS DELETED RATHER THAN RE-POINTED: there is no `.dock.covered` rule left for a negative to
	 * examine, so it passes while looking at nothing — enforcement in appearance only, which is exactly
	 * what this file's own header calls out about absences. And the rule has no successor to re-point at:
	 * no fade means no property to insist on, so nothing can regress into `visibility`. The bans below
	 * carry what remains of the claim, which is that the two-surface arrangement must not come back.
	 */
	expect(LAYOUT, 'the retired fade: no class, no rule, no state named `covered`').not.toContain('covered');
	expect(LAYOUT, 'the retired positioning wrapper — vaul fixes the drawer content itself').not.toContain(
		'class="dock"'
	);
	expect(LAYOUT, 'a permanently-mounted sheet has no open state').not.toMatch(/\bdrawerOpen\b/);
	expect(LAYOUT).toMatch(/const showBand = \$derived\(isPhoneSurface && me !== null\);/);
	/*
	 * ONE MEASUREMENT AND ONE HOP, which is R1's single-publisher count RE-EXPRESSED against the new idiom
	 * rather than dropped: `.band-slot` inside the drawer measures itself (that height IS snap 0), and the
	 * layout takes it back exactly once. A second of either forks the geometry the measurement exists to
	 * keep single.
	 */
	expect(DRAWER).toMatch(/<div class="band-slot"[^>]*bind:clientHeight=\{bandH\}>/);
	expect((DRAWER.match(/bind:clientHeight=\{bandH\}/g) ?? []).length).toBe(1);
	const docks = LAYOUT.match(/bind:bandH=\{dockH\}/g) ?? [];
	expect(docks.length).toBe(1); // the one hop out of the one band row in the app
	// The band is mounted by the DRAWER, once, and as the content's FIRST child — what shows at snap 0 is
	// the top of that element, so anything above it in the tree would take the strip's place.
	expect((DRAWER.match(/<NowPlayingBand\b/g) ?? []).length).toBe(1);
	expect(DRAWER.indexOf('class="band-slot"')).toBeGreaterThan(-1);
	expect(DRAWER.indexOf('class="band-slot"')).toBeLessThan(DRAWER.indexOf('<Drawer.Header'));
	// MEASURED, published to documentElement, and torn down. The teardown is not tidiness: an inline
	// property on :root outlives its writer AND outranks a stylesheet rule, so a stale --dock-h would pad
	// the television's stage by a phone band's height (the one surface that really does unmount it).
	expect(LAYOUT).toMatch(
		/setProperty\('--dock-h', `\$\{dockH\}px`\);\s*return \(\) => \{\s*document\.documentElement\.style\.removeProperty\('--dock-h'\);/s
	);
	// ONE token, and one writer for it. A second `--search-dock-h`, a hardcoded height, or a second
	// publisher forks the geometry the measurement exists to keep single.
	for (const [name, src] of [
		['layout', LAYOUT],
		['home', HOME]
	] as const) {
		expect(src, name).not.toContain('--search-dock-h');
		expect(src, name).not.toContain('search-dock');
	}
	expect(HOME).not.toContain('bind:clientHeight');
	expect(HOME).not.toContain('bind:clientHeight');
	// R8: and neither does the LAYOUT any more — the measurement moved INTO the drawer, so a clientHeight
	// binding here would be a second band row measuring itself against the one that is snap 0.
	expect(LAYOUT).not.toContain('bind:clientHeight');
	/*
	 * THE BAND REALLY IS AT THE BOTTOM EDGE, or --dock-h reserves nothing — RE-POINTED (R8) at the element
	 * that carries it. This was `.dock { position: fixed; bottom: 0 }`, a rule in `+layout.svelte`; the
	 * layout declares no CSS at all now, because vaul's own content element is the fixed one. The vendored
	 * `ui/drawer/drawer-content.svelte` sets it in a Tailwind class list, with the bottom offset gated on
	 * the drawer's DIRECTION — so the direction is part of the claim: a `direction` prop on the Root other
	 * than the default would leave the sheet fixed to some other edge with the band still inside it.
	 */
	expect(DRAWER_CONTENT).toContain('data-slot="drawer-content"');
	expect(DRAWER_CONTENT).toMatch(/\bfixed\b/);
	expect(DRAWER_CONTENT).toContain('data-[vaul-drawer-direction=bottom]:bottom-0');
	expect(DRAWER_CONTENT).toContain('data-[vaul-drawer-direction=bottom]:inset-x-0');
	// The direction is part of the claim, and it is sliced rather than windowed: the bottom offset above is
	// gated on `data-vaul-drawer-direction=bottom`, so a `direction` prop on the Root would leave the sheet
	// fixed to some other edge with the band still inside it. vaul's default is bottom, so the assertion is
	// that the prop is ABSENT from the Root's own tag — not merely absent from a fixed-width window of it.
	// Sliced to the Root's own closing `>`. This used to seek from the index of `handleOnly` — a prop that is
	// gone (the band row is the drag surface now; see the Root's note) — which sliced from -1 and compared an
	// empty string against every expectation below, silently.
	const rootStart = DRAWER.indexOf('<Drawer.Root');
	const rootTag = DRAWER.slice(rootStart, DRAWER.indexOf('>', rootStart));
	expect(DRAWER.indexOf('<Drawer.Root'), 'the sheet must still be a vaul Root').toBeGreaterThan(-1);
	expect(rootTag).toContain('snapPoints={[SNAP_BAND, SNAP_OPEN]}');
	expect(rootTag, 'the sheet must stay a BOTTOM drawer, or the bottom-0 class never applies').not.toContain(
		'direction='
	);
	// …and the drawer releases the vendored `max-h-[82dvh]` cap, which is what makes vaul's translate land
	// the band strip at the bottom edge rather than 152px above it. Without this the whole snap arithmetic
	// is applied to a box shorter than the viewport and every offset is wrong by the difference.
	expect(DRAWER).toMatch(/height: 100dvh;\s*max-height: none;/);
	// ONE env() term, on the one element that actually sits at that edge. Anything stacked above reads the
	// inset THROUGH --dock-h, so a second term doubles the gap on a notched phone.
	expect(BAND).toContain('padding-bottom: env(safe-area-inset-bottom, 0px);');
	expect(LAYOUT).not.toContain('safe-area-inset-bottom');
	expect(HOME).not.toContain('safe-area-inset-bottom');
	/*
	 * The drawer CONTENT carries an inset of its own, and it is not a second term in the measured stack: it
	 * is an ANCESTOR of `.band-slot`, so its padding sits outside the clientHeight --dock-h is bound to,
	 * and it is the bottom-most element only while the sheet is pulled up — which is when the band is not.
	 * Counted, so a term cannot appear on `.band-slot` itself (where it WOULD be measured, twice).
	 */
	expect((DRAWER.match(/env\(safe-area-inset-bottom/g) ?? []).length).toBe(1);
	const slotCss = DRAWER.slice(DRAWER.indexOf('.band-slot {'), DRAWER.indexOf('.band-slot :global(.band)'));
	expect(DRAWER.indexOf('.band-slot {'), '.band-slot must still be the measured band row').toBeGreaterThan(-1);
	expect(slotCss.length).toBeGreaterThan(0);
	expect(slotCss).not.toContain('env(safe-area-inset-bottom');

	// THE BOX IS AT THE TOP AND STICKY, not docked — the reversal itself. Sticky rather than fixed so it
	// survives a long scroll through the library without pinning a SECOND fixed element to the viewport,
	// which is the stack this route exists to unwind.
	// NEITHER STICKY NOR FIXED. Sticky was tried and abandoned: PageHeader is already sticky and carries
	// the top safe-area inset, so a second sticky element needs the header's RENDERED height as its
	// offset — not a token, and the first attempt reached past the end of the spacing scale, which makes
	// the calc() invalid and slides the box under the title with nothing failing out loud. Pinning the
	// ABSENCE of both is the stronger claim: it stops the box re-entering a competition for the viewport
	// that the band now wins outright.
	expect(HOME).not.toMatch(/\.findbox \{[^}]*position:\s*(?:sticky|fixed)/s);
	expect(HOME).not.toContain('position: fixed');
	expect(HOME).not.toMatch(/bottom: 0;/);
	// It is the first thing inside the column, above every group — asserted by POSITION rather than by
	// adjacency since the merge (2026-09-22): `main` carries the measured `--row-h` and opens with the
	// `{#if me}` gate that keeps the whole remote off the join screen, so nothing can be syntactically
	// adjacent to it. What the claim needs is the ordering, and that is what this reads.
	const column = HOME.slice(HOME.indexOf('<main'), HOME.indexOf('</main>'));
	expect(column.indexOf('class="findbox"')).toBeGreaterThan(-1);
	expect(column.indexOf('class="findbox"')).toBeLessThan(column.indexOf('class="grouphead"'));
	// …and `main`'s padding still consumes the MEASURED --dock-h, so the last row cannot bleed under the
	// band. Same claim as before the move, read off the same token; the `+ 28px` term stays a literal
	// because 28 is not a scale step, so nothing owns it and there is nothing to name it.
	expect(HOME).toMatch(/padding:\s*var\(--space-xs\) var\(--space-3xl\) calc\(var\(--dock-h[^)]*\) \+ 28px\)/);
	// The label is a driven-flow anchor (SEL.search); renaming it hangs six probes on a timeout rather
	// than failing an assertion, so the move must not have taken it with it.
	expect(HOME).toContain('aria-label="Search a song or artist"');
});

test('the results read DOWNWARD: every result list is emitted with its best match first', () => {
	// R2. The ranking reaches the DOM in ranking order — no reversal anywhere — which is what keeps DOM
	// order equal to visual order now that the column reads from a header downward. A
	// `column-reverse` container would paint the column against its DOM order and invert the focus
	// sequence with it, so the ban is part of the claim and is kept from the arm this replaces.
	expect(HOME).toMatch(/\{@const readyStack = readyResults\}/);
	expect(HOME).toMatch(/\{@const rawRows = unaccounted\(rawResults\)\}/);
	expect(HOME).not.toContain('.reverse()');
	expect(HOME).not.toContain('column-reverse');
	// The named upward stacks are gone with the layout that needed them, and so are the zero-query
	// shortcut stacks that were dropped with the browse mode.
	expect(HOME).not.toContain('processingStack');
	expect(HOME).not.toContain('popularRows');
	expect(HOME).not.toContain('recentRows');

	// Section order is the same claim at the block level: the most relevant section is the FIRST one, so
	// it is the one on screen when the results land. Ready first, then what still needs karaoke — with
	// whatever is being made right now above both, since that is the thing most likely to be asked about.
	// `<main` without the closing bracket: the element carries the measured `--row-h` as an attribute.
	const main = HOME.slice(HOME.indexOf('<main'), HOME.indexOf('</main>'));
	expect(main.indexOf('Making karaoke')).toBeLessThan(main.indexOf('{@const readyStack'));
	expect(main.indexOf('{@const readyStack')).toBeLessThan(main.indexOf('{@const rawRows'));
	expect(main.indexOf('>Ready to sing</h2>')).toBeLessThan(main.indexOf('>Needs karaoke</h2>'));
});

test('the top-anchored column has NO back control, because there is nowhere behind it', () => {
	/*
	 * R3, REVERSED AND RECORDED (2026-09-22). It read: "the back affordance is the shared header's rather
	 * than a row this route draws for itself" — `<PageHeader title="Find a song" back={{ href: '/' }} />`,
	 * one way back on every non-/tv page, a real `<a href>` so the browser's own back works and a PWA with
	 * no back gesture still has an exit. That was right for a surface you NAVIGATED to.
	 *
	 * There is no such navigation now: the field and the library are sections of `/`, so this surface has no
	 * behind. A "Back to the queue" link would point at the page it is on, and a PageHeader would put a
	 * second title above home's own wordmark. The exits are the two that always existed — clearing the box
	 * to get the queue back, and the hardware Back, which at home means leave the room.
	 *
	 * So the assertion INVERTS rather than being deleted: no PageHeader on this route, and specifically not
	 * the one this arm used to require, which is what would red if the surface were pushed onto a route
	 * again without the rest of the design following it.
	 */
	expect(HOME).not.toContain('<PageHeader');
	expect(HOME).not.toContain('Back to the queue');
	// The topbar is what stands in its place, and it is home's own: a wordmark, not a title with a way out.
	expect(HOME).toContain('<header class="topbar">');
	// The bottom-anchoring mechanism is banned OUTRIGHT rather than re-pointed, so the anchoring cannot
	// revert by halves: `.backrow` was both the selector `main:has(…)` matched on and the element whose
	// auto bottom margin pushed every later sibling down.
	expect(HOME).not.toContain('backrow');
	expect(HOME).not.toContain('margin-bottom: auto');
	expect(HOME).not.toContain('align-content: end');
	// The wide layout anchors the same way — an `align-content: end` grid would bottom-anchor the columns
	// while the phone column read from the top.
	expect(HOME).toMatch(/align-content: start;/);
});

test('nothing scrolls this surface: the ranking is already at the top, and the box stays reachable', () => {
	// R4. With the best match first there is nothing to scroll TO, so the whole scroll orchestration is
	// banned rather than re-pointed — a viewport that moves under a reader who is reading is worse than
	// the problem it was solving.
	expect(HOME).not.toContain('window.scrollTo');
	expect(HOME).not.toContain('scrollIntoView');
	expect(HOME).not.toContain('scrollHeight');
	expect(HOME).not.toMatch(/\bresultShape\b/);
	// Instant, never smoothed — KEPT from the arm this replaces, and now a floor rather than a rider: a
	// scroll animation is motion no reduced-motion guest asked for, and `behavior: 'smooth'` is the one
	// way to introduce it that motion.test.ts's matcher cannot see.
	expect(HOME).not.toMatch(/behavior:\s*'smooth'/);
	// What replaces it: the box is the FIRST thing in <main>, so the top of the document already IS the
	// top of the ranking and there is nothing to scroll to. Pinned as an ORDERING in the markup rather
	// than as a CSS property, because an ordering is the actual claim.
	const mainBody = HOME.slice(HOME.indexOf('<main'), HOME.indexOf('</main>'));
	expect(mainBody).toContain('class="findbox"');
	expect(mainBody.indexOf('class="findbox"')).toBeLessThan(mainBody.indexOf('class="grouphead"'));
	// No z-index either: a box in normal flow has nothing to sit above. The only stacked thing on a
	// phone surface is the band, and it is in the layout.
	expect(HOME).not.toMatch(/\.findbox \{[^}]*z-index/s);
});

test('the empty state that named the library count survives the chip that used to reach it', () => {
	// `readyEmptyState` said "None of your N karaoke songs match X" plus a way back. It was the Ready
	// CHIP's empty state; the chip is gone and the condition it was really about — a query the ready
	// library cannot answer — is now stated directly. Deleting it instead would have taken the only
	// designed empty state on this surface with it (phone-inventory.test.ts detects it by this copy).
	//
	// RE-POINTED, at the same strength: the `searchActive &&` term is no longer written on the condition
	// because the whole block now lives inside the searchActive branch — so the arm reads the block by
	// slicing from a `{@const}` that exists ONLY in that branch, which asserts the nesting rather than
	// dropping the term.
	const results = HOME.slice(HOME.indexOf('{@const readyStack'), HOME.indexOf('</main>'));
	expect(results).toMatch(/\{#if !readyStack\.length && library\.length\}/);
	expect(results).toMatch(/readyEmptyState\(\{ searchActive, libraryCount: library\.length, query \}\)/);
	expect(results).toContain('Show all {empty.showAllCount}');
});

test('/ — no empty-state copy points at a search box above, or at a now-deleted shortcut list', () => {
	// `/` is queue-only: there is no box on it at all, in either direction, so neither prompt can be true
	// there. On /find "Search for a song above" IS true — the box is at the top — which is exactly why
	// this ban stays scoped to the queue route rather than being widened to both.
	expect(HOME).not.toContain('Search for a song above');
	expect(HOME).not.toContain('Search for a song in the box below');
});

test('the docked band survives the on-screen keyboard, by the one mechanism that can say so', () => {
	// R5. The acceptance bullet is "the input remains visible and no result row is occluded with the
	// keyboard up". A `position: fixed; bottom: 0` band cannot satisfy it under the DEFAULT viewport
	// behaviour (`resizes-visual`): the layout viewport keeps its full height, so the band sits under the
	// keyboard. `interactive-widget=resizes-content` shrinks the layout viewport instead, which is what
	// lifts the dock. Pinned here because it is a one-attribute claim that reads as cosmetic and is not:
	// the gate cannot check it (headless Chromium has no soft keyboard), so this scan is the only thing
	// that does.
	const html = read('src/app.html');
	expect(html).toMatch(/name="viewport"/);
	expect(html).toContain('interactive-widget=resizes-content');
	// What it lifts is the BAND now, not the search box — so the fixed-to-the-bottom element the attribute
	// exists for is the drawer content the band sits inside, or the attribute is lifting nothing.
	//
	// RE-POINTED ONE ADDRESS FURTHER (R8), at the same strength. This read `.dock { position: fixed;
	// bottom: 0 }` in `+layout.svelte`. The band is snap point 0 of the drawer now and the layout declares
	// no CSS at all, so the fixed element is vaul's own content — set in the vendored
	// `ui/drawer/drawer-content.svelte` class list, with the bottom offset gated on the drawer's direction.
	// Asserted against that file rather than assumed, because R5 is a one-attribute claim that reads as
	// cosmetic and is not: the measured gate cannot check it, so this scan is the only thing that does.
	expect(DRAWER_CONTENT).toMatch(/\bfixed\b/);
	expect(DRAWER_CONTENT).toContain('data-[vaul-drawer-direction=bottom]:bottom-0');
	// …and the band really is inside that content, or the lifted element is not the one with the band in it.
	// Ordered by index rather than by a windowed match: this file's stripper BLANKS comments in place to
	// keep line numbers, so the (long) rationale between the two tags still occupies its own width.
	expect(DRAWER.indexOf('<Drawer.Content')).toBeGreaterThan(-1);
	expect(DRAWER.indexOf('<Drawer.Content')).toBeLessThan(DRAWER.indexOf('<div class="band-slot"'));
	expect(DRAWER).toContain('<NowPlayingBand');
	// And the box needs no lifting: it is at the TOP of the document, above the keyboard by construction
	// the second half of the reversal, and asserting it is what stops the box quietly re-docking on the
	// strength of an attribute that would then be carrying two elements' worth of work.
	// NEITHER STICKY NOR FIXED. Sticky was tried and abandoned: PageHeader is already sticky and carries
	// the top safe-area inset, so a second sticky element needs the header's RENDERED height as its
	// offset — not a token, and the first attempt reached past the end of the spacing scale, which makes
	// the calc() invalid and slides the box under the title with nothing failing out loud. Pinning the
	// ABSENCE of both is the stronger claim: it stops the box re-entering a competition for the viewport
	// that the band now wins outright.
	expect(HOME).not.toMatch(/\.findbox \{[^}]*position:\s*(?:sticky|fixed)/s);
	expect(HOME).not.toContain('position: fixed');
});

// ── non-vacuity ─────────────────────────────────────────────────────────────────────────────────
test('this guard really read every route it claims to, and really stripped their comments', () => {
	// Every arm above is an absence, and an absence is what an empty string is full of. FIVE sources are
	// now read instead of one, and a re-point that lands on the wrong file would pass every ban silently —
	// so each source carries its own floor, named, rather than one floor standing in for all of them.
	//
	// Two floors per file, and the SECOND is the one that does the work. `stripComments` blanks with
	// spaces to preserve line numbers, so the stripped string is always the same LENGTH as the raw one —
	// which means a length check on the stripped text is the raw check restated and could never catch a
	// stripper that blanked everything. The non-whitespace count can.
	//
	// R7: `home`'s pair is RE-ANCHORED downward (40000/18000 -> 34000/11000) and `drawer` is added with
	// its own. `/` is queue-only now — the hero's ~450 lines of song identity, transport and live controls
	// left for `NowPlayingDrawer` — so 18000 was floored against a surface that no longer exists. This is
	// resolution (b) of the floor doctrine, not a lowered number: the code that left `/` is read here
	// under `drawer`, is subject to the same bans (mechanisms 1 and 2+3 above), and the total this guard
	// examines is LARGER than before. Each floor keeps roughly the same margin under its file's real size
	// as the three untouched entries do, so all five stay sensitive to a wrong read for the same reason.
	//
	// R8 ADDS A SIXTH ENTRY and lowers nothing. `content` is the vendored `ui/drawer/drawer-content.svelte`,
	// which is where the `position: fixed; bottom: 0` that used to be `.dock` in the layout now lives. It
	// is a small file, so its floors are proportionally smaller — the point of a floor is that it is
	// sensitive to THIS file being mis-read, not that every file scores the same number.
	//
	// THE MERGE COLLAPSES TWO ENTRIES INTO ONE and RAISES the survivor. `find` and `home` were separate
	// files with separate floors; they are one file, and it is bigger than either was (the search block, the
	// library groups and the result groups all landed in the page that already held the queue). So the pair
	// moves UP (34000/11000 -> 60000/17000) rather than the two being averaged: a floor's job is to be
	// sensitive to THIS file being mis-read, and a floor set for the smaller of two merged files would sit
	// far enough below the real size to pass against a truncated read.
	for (const [name, raw, stripped, rawFloor, codeFloor] of [
		['layout', LAYOUT_RAW, LAYOUT, 5000, 1800],
		['band', BAND_RAW, BAND, 9000, 2800],
		['room', ROOM_RAW, ROOM, 12000, 5000],
		['home', HOME_RAW, HOME, 60000, 17000],
		['drawer', DRAWER_RAW, DRAWER, 12000, 6000],
		['content', DRAWER_CONTENT_RAW, DRAWER_CONTENT, 2500, 1200]
	] as const) {
		expect(raw.length, `${name}: file read`).toBeGreaterThan(rawFloor);
		expect(stripped.replace(/\s+/g, '').length, `${name}: survived the stripper`).toBeGreaterThan(codeFloor);
		// The stripper must remove comments and NOTHING else — same line count, so every line number a
		// reviewer reads off a failure still points at the real file.
		expect(stripped.split('\n').length, `${name}: line numbers preserved`).toBe(raw.split('\n').length);
	}
	// And it must really strip. Each source explains its part of this change where it happened, so their
	// comments name the very mechanisms the arms above ban — a no-op stripper would red every one of them.
	// One proof per reversal that has prose to prove it against:
	//   home   names the deleted chip state       (mechanism 1)
	//          …and the retired upward stacking   (R2) — both proofs read the one page now
	//   layout names the retired `.search-dock`   (R1)
	//   drawer names the retired nested disclosure the range sat behind (R7)
	//   content names the decorative-handle defect the copy-in shipped (R8)
	expect(HOME_RAW).toContain('`showReady`/`showProcessing`/`showRaw`');
	expect(HOME).not.toContain('`showReady`/`showProcessing`/`showRaw`');
	// Short enough to survive a comment re-wrap: a proof phrase long enough to span a line break is a
	// proof that reds on `bun run format` rather than on a broken stripper.
	expect(HOME_RAW).toContain('stacked them upward');
	expect(HOME).not.toContain('stacked them upward');
	expect(LAYOUT_RAW).toContain('`.search-dock` in the route');
	expect(LAYOUT).not.toContain('`.search-dock` in the route');
	expect(DRAWER_RAW).toContain('behind a nested "Vocal range" Collapsible');
	expect(DRAWER).not.toContain('behind a nested "Vocal range" Collapsible');
	expect(DRAWER_CONTENT_RAW).toContain('shadcn renders a DECORATIVE div');
	expect(DRAWER_CONTENT).not.toContain('shadcn renders a DECORATIVE div');
});
