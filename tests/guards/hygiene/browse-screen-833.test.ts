// THE BROWSE SCREEN, DIRECTION B — the deletion is the invariant.
//
// WHY A SOURCE SCAN, AND WHERE IT STOPS. What direction B changes on this screen is which markup and
// which state EXIST: three readiness chips, an artist rail, a genre rail and two colour-coded group
// headings are gone. That is a set of syntax claims, and syntax claims are what a scan can settle. The
// geometry those claims imply — the box really reachable through a long scroll, the band really sitting
// at the bottom edge, nothing occluded with the keyboard up — is a MEASUREMENT and is not asserted here
// (XR-PH-21); `bun run gate:measured` drives the real render for that.
//
// The shape matters: a deletion is invisible to a behavioural suite. Nothing imports these routes, so
// every mechanism below could be restored with the whole suite green. These are the assertions that
// RED when one comes back, one test per mechanism so a failure names which one.
//
// WHERE THE SUBJECT LIVES NOW (the phone-remote rebuild). The browse screen is no longer a MODE of the
// queue route — it is its own route, and the state it read was hoisted out of the page:
//
//   * the surface itself:      `src/routes/+page.svelte`  ->  `src/routes/find/+page.svelte`
//   * the saved library:       page-local `loadLibrary`   ->  `src/lib/stores/room.ts` (`refreshLibrary`)
//   * the bottom-edge band:    page-local `.search-dock`  ->  `src/routes/+layout.svelte` (`.dock`)
//
// So this guard reads FOUR sources rather than one. Each is stripped and floored separately (see the
// non-vacuity arm), because a re-point that silently reads the wrong file asserts nothing.
//
// RETIREMENT RECORDED HERE (XR-VER-07). `routes/library-tag-filter-wiring.test.ts` is DELETED by this
// change, not weakened. It pinned five render seams of the tag filter — `facets.tags` state, a
// `browseFilter` that could hold a tag, `setBrowse('tag', …)`, the `?tag=` query and the tag rail
// itself — every one of which is a mechanism direction B removes. Its premise was "the tag filter is
// wired through the phone page"; the ruling is that the phone page has no tag filter. The SERVER half
// of is untouched and still guarded (`server/media/library-tag-filter.test.ts`,
// `routes/api/library/library-tag-filter-wiring.test.ts`), which is why only one of the three
// similarly-named files retires. The absence is pinned below so it cannot creep back in unnoticed.
//
// ── REVERSALS RECORDED HERE (XR-VER-07 again: a retired requirement is recorded, never vanished) ────
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
//      did: DOM order must still equal visual order (XR-PH-12), and a reversing container is the one
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

// The browse surface itself — every arm that used to read `routes/+page.svelte` reads THIS now.
const FIND_RAW = read('src/routes/find/+page.svelte');
const FIND = stripComments(FIND_RAW);
// The band, its dock, and the single --dock-h publisher.
const LAYOUT_RAW = read('src/routes/+layout.svelte');
const LAYOUT = stripComments(LAYOUT_RAW);
const BAND_RAW = read('src/lib/components/NowPlayingBand.svelte');
const BAND = stripComments(BAND_RAW);
// The saved library, hoisted out of the page.
const ROOM_RAW = read('src/lib/stores/room.ts');
const ROOM = stripComments(ROOM_RAW);
// The queue route. Still read, for the arms that are about `/` rather than about the browse surface —
// and as the second half of every "did not creep back" ban, since `/` is where these mechanisms lived.
const HOME_RAW = read('src/routes/+page.svelte');
const HOME = stripComments(HOME_RAW);

// ── mechanism 1: the three readiness chips ───────────────────────────────────────────────────────
test('mechanism 1 — the readiness chip row is gone, and so is the state behind it', () => {
	// The row itself, by the group label every driven flow used to find it with. Banned on BOTH the new
	// surface and the old one: the chips could come back either at their old address or at the new one.
	for (const [name, src] of [
		['find', FIND],
		['home', HOME]
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
	expect(FIND).toMatch(/libraryCount: library\.length/);
});

test('mechanism 1 — every group renders unconditionally, so nothing is hidden behind a chip', () => {
	// The processing group is gated on having rows and on NOTHING else — not on a filter, and (unlike the
	// docked-box version) not on `searchActive` either: whatever is being made right now shows in both the
	// library view and the results view. That is a strictly wider claim than the arm it replaces, and it is
	// what fails if a "quick" reinstatement re-adds a gate without the chips.
	expect(FIND).toContain('{#if processingRows.length}');
	// No group is gated on a show-flag of any kind, on either surface. This is the general form of the ban
	// the three named flags above cover, so a FOURTH flag under a new name reds here.
	expect(FIND).not.toMatch(/\{#if\s+show[A-Z]/);
	expect(HOME).not.toMatch(/\{#if\s+show[A-Z]/);
	// `accountedFor` subtracts BOTH groups from the shortcut lists unconditionally: with a filter, a
	// hidden group stopped accounting for its songs and they reappeared under Popular/Recently queued.
	expect(FIND).toMatch(/for \(const m of searchActive \? readyResults : library\) ids\.add\(m\.id\);/);
	expect(FIND).toMatch(/for \(const c of processingRows\) ids\.add\(c\.id\);/);
});

// ── mechanisms 2 and 3: the artist rail and the genre/tag rail ───────────────────────────────────
test('mechanisms 2+3 — the browse disclosure and both facet rails are gone from the phone', () => {
	// Banned at both addresses. The rails were markup on `/`; the surface that would host them today is
	// /find, so a scan of only one of the two would miss a reinstatement at the other.
	for (const [name, src] of [
		['find', FIND],
		['home', HOME]
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
	expect(FIND).not.toContain('?browse=1');
	expect(FIND).not.toMatch(/\bopenBrowse\b/);
	expect(FIND).not.toMatch(/\bbrowseToggle\b/);
});

test('mechanisms 2+3 — the phone asks the library endpoint for the whole library, unfiltered', () => {
	// The narrowing was server-side (?artist= / ?tag=), so the fetch is where a rail would have to come
	// back through. One unqualified request, no query string built from a filter.
	//
	// RE-POINTED: the fetch is the room link's now, not the page's. That move is itself load-bearing and
	// is asserted rather than assumed — the surface reads `room.library` and asks for a refresh, so it
	// cannot reintroduce a narrowed request of its own.
	expect(ROOM).toMatch(/fetch\('\/api\/library'\)/);
	expect(FIND).not.toContain('/api/library');
	expect(FIND).toContain('library = room.library;');
	expect(FIND).toContain('room.refreshLibrary()');
	for (const [name, src] of [
		['room', ROOM],
		['find', FIND],
		['home', HOME]
	] as const) {
		expect(src, name).not.toMatch(/\?artist=/);
		expect(src, name).not.toMatch(/\?tag=/);
	}
});

test('the retired tag-filter wiring guard is deleted, and its server sibling is not', () => {
	// A retired guard left in the suite is indistinguishable from one that is working (XR-VER-07).
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
	// FOUR groups can be on this surface, and up to three of them at once, with no chip row anywhere to
	// tell them apart — so each carries a name. Pinned by exact markup, because the claim is that all
	// four share ONE neutral treatment; a heading whose class drifted is the reversion this arm catches.
	expect(FIND).toContain('<h2 class="grouphead">Ready to sing · your library</h2>');
	expect(FIND).toContain('<h2 class="grouphead">Making karaoke…</h2>');
	expect(FIND).toContain('<h2 class="grouphead">Ready to sing</h2>');
	expect(FIND).toContain('<h2 class="grouphead">Needs karaoke · has vocals</h2>');
	// Exactly four, all bare: the count is what makes "one treatment" falsifiable rather than decorative,
	// since a fifth heading or a variant class would have to pass through here.
	expect((FIND.match(/class="grouphead"/g) ?? []).length).toBe(4);
	// What mechanism 4 really retired: the per-readiness, state-gated FORM. A heading that carries the
	// readiness of its members in colour says the axis twice — SongRow already paints a chip per row —
	// and `showGroupHeads` was the flag that decided when to.
	expect(FIND).not.toMatch(/\bshowGroupHeads\b/);
	expect(FIND).not.toMatch(/class="grouphead ok"/);
	expect(FIND).not.toMatch(/class="grouphead warn"/);
	expect(FIND).not.toContain('Processing · queue it anyway');
	// …and the `.grouphead-mark` rule those variants were the only users of goes with them — a dead CSS
	// selector left behind is exactly the residue this deletion guard exists to red on.
	expect(FIND).not.toContain('grouphead-mark');
	// The zero-query shortcut lists (Popular tonight / Recently queued) were dropped with the browse
	// mode and did NOT come back with the route: an empty box shows the LIBRARY now, which is the whole
	// design idea — the songs you can sing are the default content rather than a hidden third state.
	for (const [name, src] of [
		['find', FIND],
		['home', HOME]
	] as const) {
		expect(src, name).not.toContain('Popular tonight');
		expect(src, name).not.toContain('Recently queued');
	}
});

// ── what replaced them: a band at the bottom, a box at the top of the flow, one list reading down ──
test('the band owns the bottom edge and publishes the measured --dock-h; the find box docks nothing', () => {
	// R1. ONE band, ONE measurement, and both now live in the layout — which is what lets the band be app
	// chrome on every phone surface instead of a home-screen element. Gated on `showBand` (a joined singer
	// on a phone surface), so /tv never mounts it and never opens a `role=phone` socket.
	expect(LAYOUT).toMatch(/\{#if showBand\}\s*<div class="dock" bind:clientHeight=\{dockH\}>/);
	expect(LAYOUT).toMatch(/const showBand = \$derived\(isPhoneSurface && me !== null\);/);
	const docks = LAYOUT.match(/bind:clientHeight=\{dockH\}/g) ?? [];
	expect(docks.length).toBe(1); // the band's dock, the only fixed band in the app
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
		['find', FIND],
		['home', HOME]
	] as const) {
		expect(src, name).not.toContain('--search-dock-h');
		expect(src, name).not.toContain('search-dock');
	}
	expect(FIND).not.toContain('bind:clientHeight');
	expect(HOME).not.toContain('bind:clientHeight');
	// The dock really is at the bottom edge, or --dock-h reserves nothing.
	expect(LAYOUT).toMatch(/\.dock \{[^}]*position: fixed;[^}]*bottom: 0;/s);
	// ONE env() term, on the one element that actually sits at that edge. Anything stacked above reads the
	// inset THROUGH --dock-h, so a second term doubles the gap on a notched phone.
	expect(BAND).toContain('padding-bottom: env(safe-area-inset-bottom, 0px);');
	expect(LAYOUT).not.toContain('safe-area-inset-bottom');
	expect(FIND).not.toContain('safe-area-inset-bottom');

	// THE BOX IS AT THE TOP AND STICKY, not docked — the reversal itself. Sticky rather than fixed so it
	// survives a long scroll through the library without pinning a SECOND fixed element to the viewport,
	// which is the stack this route exists to unwind.
	// NEITHER STICKY NOR FIXED. Sticky was tried and abandoned: PageHeader is already sticky and carries
	// the top safe-area inset, so a second sticky element needs the header's RENDERED height as its
	// offset — not a token, and the first attempt reached past the end of the spacing scale, which makes
	// the calc() invalid and slides the box under the title with nothing failing out loud. Pinning the
	// ABSENCE of both is the stronger claim: it stops the box re-entering a competition for the viewport
	// that the band now wins outright.
	expect(FIND).not.toMatch(/\.findbox \{[^}]*position:\s*(?:sticky|fixed)/s);
	expect(FIND).not.toContain('position: fixed');
	expect(FIND).not.toMatch(/bottom: 0;/);
	// It is the first thing inside the column, above every group.
	expect(FIND).toMatch(/<main>\s*<div class="findbox">/);
	// …and `main`'s padding still consumes the MEASURED --dock-h, so the last row cannot bleed under the
	// band. Same claim as before the move, read off the same token; the `+ 28px` term stays a literal
	// because 28 is not a scale step, so nothing owns it and there is nothing to name it.
	expect(FIND).toMatch(/padding:\s*var\(--space-xs\) var\(--space-3xl\) calc\(var\(--dock-h[^)]*\) \+ 28px\)/);
	// The label is a driven-flow anchor (SEL.search); renaming it hangs six probes on a timeout rather
	// than failing an assertion, so the move must not have taken it with it.
	expect(FIND).toContain('aria-label="Search a song or artist"');
});

test('the results read DOWNWARD: every result list is emitted with its best match first', () => {
	// R2. The ranking reaches the DOM in ranking order — no reversal anywhere — which is what keeps DOM
	// order equal to visual order (XR-PH-12) now that the column reads from a header downward. A
	// `column-reverse` container would paint the column against its DOM order and invert the focus
	// sequence with it, so the ban is part of the claim and is kept from the arm this replaces.
	expect(FIND).toMatch(/\{@const readyStack = readyResults\}/);
	expect(FIND).toMatch(/\{@const rawRows = unaccounted\(rawResults\)\}/);
	expect(FIND).not.toContain('.reverse()');
	expect(FIND).not.toContain('column-reverse');
	// The named upward stacks are gone with the layout that needed them, and so are the zero-query
	// shortcut stacks that were dropped with the browse mode.
	expect(FIND).not.toContain('processingStack');
	expect(FIND).not.toContain('popularRows');
	expect(FIND).not.toContain('recentRows');

	// Section order is the same claim at the block level: the most relevant section is the FIRST one, so
	// it is the one on screen when the results land. Ready first, then what still needs karaoke — with
	// whatever is being made right now above both, since that is the thing most likely to be asked about.
	const main = FIND.slice(FIND.indexOf('<main>'), FIND.indexOf('</main>'));
	expect(main.indexOf('Making karaoke')).toBeLessThan(main.indexOf('{@const readyStack'));
	expect(main.indexOf('{@const readyStack')).toBeLessThan(main.indexOf('{@const rawRows'));
	expect(main.indexOf('>Ready to sing</h2>')).toBeLessThan(main.indexOf('Needs karaoke · has vocals'));
});

test('the top-anchored column takes its back control from the page header', () => {
	// R3. Top-anchored, and the back affordance is the shared header's rather than a row this route draws
	// for itself: one way back on every non-/tv page, and a real `<a href>` so the browser's own back
	// works, the route stays shareable, and a home-screen PWA with no back gesture still has an exit.
	expect(FIND).toContain(`<PageHeader title="Find a song" icon="search" back={{ href: '/', label: 'Back to the queue' }} />`);
	expect(FIND.indexOf('<PageHeader')).toBeLessThan(FIND.indexOf('<main>'));
	// The bottom-anchoring mechanism is banned OUTRIGHT rather than re-pointed, so the anchoring cannot
	// revert by halves: `.backrow` was both the selector `main:has(…)` matched on and the element whose
	// auto bottom margin pushed every later sibling down.
	expect(FIND).not.toContain('backrow');
	expect(FIND).not.toContain('margin-bottom: auto');
	expect(FIND).not.toContain('align-content: end');
	// The wide layout anchors the same way — an `align-content: end` grid would bottom-anchor the columns
	// while the phone column read from the top.
	expect(FIND).toMatch(/align-content: start;/);
});

test('nothing scrolls this surface: the ranking is already at the top, and the box stays reachable', () => {
	// R4. With the best match first there is nothing to scroll TO, so the whole scroll orchestration is
	// banned rather than re-pointed — a viewport that moves under a reader who is reading is worse than
	// the problem it was solving.
	expect(FIND).not.toContain('window.scrollTo');
	expect(FIND).not.toContain('scrollIntoView');
	expect(FIND).not.toContain('scrollHeight');
	expect(FIND).not.toMatch(/\bresultShape\b/);
	// Instant, never smoothed — KEPT from the arm this replaces, and now a floor rather than a rider: a
	// scroll animation is motion no reduced-motion guest asked for, and `behavior: 'smooth'` is the one
	// way to introduce it that motion.test.ts's matcher cannot see.
	expect(FIND).not.toMatch(/behavior:\s*'smooth'/);
	// What replaces it: the box is the FIRST thing in <main>, so the top of the document already IS the
	// top of the ranking and there is nothing to scroll to. Pinned as an ORDERING in the markup rather
	// than as a CSS property, because an ordering is the actual claim.
	const mainBody = FIND.slice(FIND.indexOf('<main>'), FIND.indexOf('</main>'));
	expect(mainBody).toContain('class="findbox"');
	expect(mainBody.indexOf('class="findbox"')).toBeLessThan(mainBody.indexOf('class="grouphead"'));
	// No z-index either: a box in normal flow has nothing to sit above. The only stacked thing on a
	// phone surface is the band, and it is in the layout.
	expect(FIND).not.toMatch(/\.findbox \{[^}]*z-index/s);
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
	const results = FIND.slice(FIND.indexOf('{@const readyStack'), FIND.indexOf('</main>'));
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
	// exists for is the layout's dock, or the attribute is lifting nothing.
	expect(LAYOUT).toMatch(/\.dock \{[^}]*position: fixed;[^}]*bottom: 0;/s);
	// And the box needs no lifting: it is at the TOP of the document, above the keyboard by construction
	// the second half of the reversal, and asserting it is what stops the box quietly re-docking on the
	// strength of an attribute that would then be carrying two elements' worth of work.
	// NEITHER STICKY NOR FIXED. Sticky was tried and abandoned: PageHeader is already sticky and carries
	// the top safe-area inset, so a second sticky element needs the header's RENDERED height as its
	// offset — not a token, and the first attempt reached past the end of the spacing scale, which makes
	// the calc() invalid and slides the box under the title with nothing failing out loud. Pinning the
	// ABSENCE of both is the stronger claim: it stops the box re-entering a competition for the viewport
	// that the band now wins outright.
	expect(FIND).not.toMatch(/\.findbox \{[^}]*position:\s*(?:sticky|fixed)/s);
	expect(FIND).not.toContain('position: fixed');
});

// ── non-vacuity ─────────────────────────────────────────────────────────────────────────────────
test('this guard really read every route it claims to, and really stripped their comments', () => {
	// Every arm above is an absence, and an absence is what an empty string is full of. Four sources are
	// now read instead of one, and a re-point that lands on the wrong file would pass every ban silently —
	// so each source carries its own floor, named, rather than one floor standing in for all of them.
	//
	// Two floors per file, and the SECOND is the one that does the work. `stripComments` blanks with
	// spaces to preserve line numbers, so the stripped string is always the same LENGTH as the raw one —
	// which means a length check on the stripped text is the raw check restated and could never catch a
	// stripper that blanked everything. The non-whitespace count can.
	for (const [name, raw, stripped, rawFloor, codeFloor] of [
		['find', FIND_RAW, FIND, 12000, 7000],
		['layout', LAYOUT_RAW, LAYOUT, 5000, 1800],
		['band', BAND_RAW, BAND, 9000, 2800],
		['room', ROOM_RAW, ROOM, 12000, 5000],
		['home', HOME_RAW, HOME, 40000, 18000]
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
	//   find   names the retired upward stacking  (R2)
	//   layout names the retired `.search-dock`   (R1)
	expect(HOME_RAW).toContain('`showReady`/`showProcessing`/`showRaw`');
	expect(HOME).not.toContain('`showReady`/`showProcessing`/`showRaw`');
	expect(FIND_RAW).toContain('results expand upward IN PLACE');
	expect(FIND).not.toContain('results expand upward IN PLACE');
	expect(LAYOUT_RAW).toContain('`.search-dock` in the route');
	expect(LAYOUT).not.toContain('`.search-dock` in the route');
});
