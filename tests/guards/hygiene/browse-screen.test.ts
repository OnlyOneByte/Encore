// THE BROWSE SCREEN — the deletion is the invariant. Three readiness chips, an artist rail, a genre rail and
// two colour-coded group headings are gone, and a deletion is invisible to a behavioural suite: nothing
// imports these routes, so every mechanism below could be restored with the whole suite green. One test per
// mechanism, so a failure names which one came back.
//
// WHERE THE SCAN STOPS. Which markup and which STATE exist are syntax claims a scan can settle. The geometry
// they imply — the box reachable through a long scroll, the band at the bottom edge, nothing occluded with the
// keyboard up — is a MEASUREMENT, and `bun run gate:measured` drives the real render for it.
//
// THE SHAPE BEING PINNED: search, the library and the result groups are sections of `routes/+page.svelte`
// with the box at the TOP of the column in normal flow; the saved library is the room store's
// (`refreshLibrary`); results read DOWNWARD, best match first; and the bottom edge belongs to the band, which
// is composed inside `NowPlayingDrawer` as snap point 0 of a permanently-mounted sheet, so the layout mounts
// ONE component with no `.dock` wrapper and no open state. Six sources are therefore read, each stripped and
// floored separately, because a re-point that silently reads the wrong file asserts nothing.

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
 * One page constant, not two: the find route is merged back into home, so `HOME` is both the surface that
 * owns these mechanisms and the address they would creep back at. The drawer stays a separate subject below
 * because it is app chrome, and so IS a second address.
 */
const HOME_RAW = read('src/routes/+page.svelte');
const HOME = stripComments(HOME_RAW);
// The now-playing drawer, which took the song identity, transport and live controls off `/`. Read because it
// is app chrome on every phone surface, so it is a third address a banned mechanism could return at. It also
// mounts the BAND, as snap point 0.
const DRAWER_RAW = read('src/lib/components/NowPlayingDrawer.svelte');
const DRAWER = stripComments(DRAWER_RAW);
// The vendored drawer content: the `position: fixed; bottom: 0` that used to be `.dock` in the layout is now
// vaul's own, expressed in this file's class list, and the soft-keyboard claim below is about that element.
// A claim asserted against a file this guard does not read is not asserted at all.
const DRAWER_CONTENT_RAW = read('src/lib/components/ui/drawer/drawer-content.svelte');
const DRAWER_CONTENT = stripComments(DRAWER_CONTENT_RAW);

test('mechanism 1 — the readiness chip row is gone, and so is the state behind it', () => {
	// The row itself, by the group label every driven flow used to find it with — banned on home AND on the
	// drawer, which is on every phone surface and so is a second address for it.
	for (const [name, src] of [
		['home', HOME],
		['drawer', DRAWER]
	] as const) {
		expect(src, name).not.toContain('Filter by readiness');
		expect(src, name).not.toMatch(/class="chips"/);
		// …and the state, or the chips could be restored without re-deriving anything. `filter` was the single
		// source of the axis and the three `show*` flags gated the groups on it.
		expect(src, name).not.toMatch(/\blet filter\b/);
		expect(src, name).not.toMatch(/\bshowReady\b/);
		expect(src, name).not.toMatch(/\bshowProcessing\b/);
		expect(src, name).not.toMatch(/\bshowRaw\b/);
		// `libraryCount` as a DERIVED is gone; the identically-named PARAMETER of readyEmptyState() is not this
		// mechanism and must survive — the empty state still names how many songs the library has.
		expect(src, name).not.toMatch(/const libraryCount = \$derived/);
	}
	expect(HOME).toMatch(/libraryCount: library\.length/);
});

test('mechanism 1 — every group renders unconditionally, so nothing is hidden behind a chip', () => {
	// The processing group is gated on having rows and on NOTHING else — not on a filter, and not on
	// `searchActive`: whatever is being made right now shows in both views. `processingGroup`, not
	// `processingRows`: a song that is queued AND processing already has a row with a live bar, so the group
	// subtracts what the queue is drawing rather than printing a second bar. Both halves are pinned — the render
	// is gated on the group having rows, and the group is `processingRows` minus the queued ids, never a filter.
	expect(HOME).toContain('{#if processingGroup.length}');
	expect(HOME).toMatch(
		/const processingGroup = \$derived\(\s*searchActive \? processingRows : processingRows\.filter\(\(c\) => !queuedMediaIds\.has\(c\.id\)\)\s*\);/
	);
	// No group is gated on a show-flag of any kind. This is the general form of the three named bans above, so a
	// FOURTH flag under a new name reds here.
	expect(HOME).not.toMatch(/\{#if\s+show[A-Z]/);
	expect(HOME).not.toMatch(/\{#if\s+show[A-Z]/);
	// `accountedFor` subtracts BOTH groups from the shortcut lists unconditionally: with a filter, a hidden group
	// stopped accounting for its songs and they reappeared under Popular/Recently queued.
	expect(HOME).toMatch(/for \(const m of searchActive \? readyResults : library\) ids\.add\(m\.id\);/);
	expect(HOME).toMatch(/for \(const c of processingRows\) ids\.add\(c\.id\);/);
});

test('mechanisms 2+3 — the browse disclosure and both facet rails are gone from the phone', () => {
	// Banned at both addresses: the rails were markup on `/`, and the drawer inherited the hero's disclosure
	// body, which is where a facet rail would sit most plausibly now.
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
	// Not a browse MODE come back under a URL. The surface IS the browse view, so there is nothing to toggle.
	expect(HOME).not.toContain('?browse=1');
	expect(HOME).not.toMatch(/\bopenBrowse\b/);
	expect(HOME).not.toMatch(/\bbrowseToggle\b/);
});

test('mechanisms 2+3 — the phone asks the library endpoint for the whole library, unfiltered', () => {
	// The narrowing was server-side (?artist= / ?tag=), so the fetch is where a rail would have to come back
	// through: one unqualified request, no query string built from a filter. The fetch is the room link's now,
	// which is asserted rather than assumed — the surface reads `room.library` and asks for a refresh, so it
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
	// A retired guard left in the suite is indistinguishable from one that is working. Three guards share this
	// basename and colocation used to be the only thing telling them apart, so the absence is stated twice: at
	// the address the phone-page guard would occupy, and as a sweep proving it has not reappeared elsewhere.
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
	// Its sibling pins PER-ROW tag chips, which this change does not touch. Deleting any of the three under
	// cover of this ruling would be wrong.
	expect(existsSync(at('tests/guards/wiring/library-tags-page-wiring.test.ts'))).toBe(true);
	expect(existsSync(at('tests/guards/wiring/library-tag-filter-wiring.test.ts'))).toBe(true);
	expect(existsSync(at('tests/guards/subsystem-media/library-tag-filter.test.ts'))).toBe(true);
});

// mechanism 4 — the headings name WHICH LIST, in one neutral treatment.
test('mechanism 4 — the group headings name which list, and the retired colour-coded form stays gone', () => {
	// FIVE groups can be on this surface and up to three at once, with no chip row anywhere to tell them apart,
	// so each carries a name. Pinned by exact markup, because the claim is that all five share ONE neutral
	// treatment; a heading whose class drifted is the reversion this catches.
	expect(HOME).toContain('<h2 class="grouphead">Queued</h2>');
	expect(HOME).toContain('<h2 class="grouphead">Your library</h2>');
	expect(HOME).toContain('<h2 class="grouphead">Making karaoke…</h2>');
	expect(HOME).toContain('<h2 class="grouphead">Ready to sing</h2>');
	expect(HOME).toContain('<h2 class="grouphead">Needs karaoke</h2>');
	// Exactly five, all bare: the count is what makes "one treatment" falsifiable rather than decorative, since
	// a sixth heading or a variant class would have to pass through here.
	expect((HOME.match(/class="grouphead"/g) ?? []).length).toBe(5);
	// What is retired is the per-readiness, state-gated FORM: a heading carrying the readiness of its members in
	// colour says the axis twice, since SongRow already paints a chip per row.
	expect(HOME).not.toMatch(/\bshowGroupHeads\b/);
	expect(HOME).not.toMatch(/class="grouphead ok"/);
	expect(HOME).not.toMatch(/class="grouphead warn"/);
	expect(HOME).not.toContain('Processing · queue it anyway');
	// …and the `.grouphead-mark` rule those variants were the only users of goes with them — a dead CSS selector
	// left behind is exactly the residue this deletion guard exists to red on.
	expect(HOME).not.toContain('grouphead-mark');
	// The zero-query shortcut lists went with the browse mode and did not come back: an empty box shows the
	// LIBRARY, so the songs you can sing are the default content rather than a hidden third state.
	for (const [name, src] of [['home', HOME]] as const) {
		expect(src, name).not.toContain('Popular tonight');
		expect(src, name).not.toContain('Recently queued');
	}
});

test('the band owns the bottom edge and publishes the measured --dock-h; the find box docks nothing', () => {
	// ONE band, ONE measurement, both in the layout — which is what lets the band be app chrome on every phone
	// surface. Gated on `showBand` (a joined singer on a phone surface), so /tv never mounts it. What gets
	// mounted is the drawer, with the band composed inside it as snap 0; `bind:bandH={dockH}` is the hop that
	// carries the band's real rendered height back. Matched through a bounded window rather than `[^>]*` because
	// the tag's own props contain `>` (`() => goto(…)`), so a negated-class run would stop at the first arrow.
	expect(LAYOUT).toMatch(/\{#if showBand\}\s*<NowPlayingDrawer\b[\s\S]{0,200}?bind:bandH=\{dockH\}/);
	expect(LAYOUT, 'the retired fade: no class, no rule, no state named `covered`').not.toContain('covered');
	expect(LAYOUT, 'the retired positioning wrapper — vaul fixes the drawer content itself').not.toContain(
		'class="dock"'
	);
	expect(LAYOUT, 'a permanently-mounted sheet has no open state').not.toMatch(/\bdrawerOpen\b/);
	expect(LAYOUT).toMatch(/const showBand = \$derived\(isPhoneSurface && me !== null\);/);
	/*
	 * ONE MEASUREMENT AND ONE HOP: `.band-slot` inside the drawer measures itself (that height IS snap 0) and
	 * the layout takes it back exactly once. A second of either forks the geometry the measurement keeps single.
	 */
	expect(DRAWER).toMatch(/<div class="band-slot"[^>]*bind:clientHeight=\{bandH\}>/);
	expect((DRAWER.match(/bind:clientHeight=\{bandH\}/g) ?? []).length).toBe(1);
	const docks = LAYOUT.match(/bind:bandH=\{dockH\}/g) ?? [];
	expect(docks.length).toBe(1); // the one hop out of the one band row in the app
	// The band is mounted by the DRAWER, once, and as the content's FIRST child — what shows at snap 0 is the top
	// of that element, so anything above it in the tree would take the strip's place.
	expect((DRAWER.match(/<NowPlayingBand\b/g) ?? []).length).toBe(1);
	expect(DRAWER.indexOf('class="band-slot"')).toBeGreaterThan(-1);
	expect(DRAWER.indexOf('class="band-slot"')).toBeLessThan(DRAWER.indexOf('<Drawer.Header'));
	// MEASURED, published to documentElement, and torn down. The teardown is not tidiness: an inline property on
	// :root outlives its writer AND outranks a stylesheet rule, so a stale --dock-h would pad the television's
	// stage by a phone band's height — the one surface that really does unmount it.
	expect(LAYOUT).toMatch(
		/setProperty\('--dock-h', `\$\{dockH\}px`\);\s*return \(\) => \{\s*document\.documentElement\.style\.removeProperty\('--dock-h'\);/s
	);
	// ONE token, one writer. A second `--search-dock-h`, a hardcoded height or a second publisher forks it.
	for (const [name, src] of [
		['layout', LAYOUT],
		['home', HOME]
	] as const) {
		expect(src, name).not.toContain('--search-dock-h');
		expect(src, name).not.toContain('search-dock');
	}
	expect(HOME).not.toContain('bind:clientHeight');
	expect(HOME).not.toContain('bind:clientHeight');
	// …and neither does the LAYOUT any more: the measurement moved INTO the drawer, so a clientHeight binding
	// here would be a second band row measuring itself against the one that is snap 0.
	expect(LAYOUT).not.toContain('bind:clientHeight');
	/*
	 * THE BAND REALLY IS AT THE BOTTOM EDGE, or --dock-h reserves nothing. The layout declares no CSS at all —
	 * vaul's own content element is the fixed one, set in the vendored class list with the bottom offset gated on
	 * the drawer's DIRECTION, which is why the direction is part of the claim below.
	 */
	expect(DRAWER_CONTENT).toContain('data-slot="drawer-content"');
	expect(DRAWER_CONTENT).toMatch(/\bfixed\b/);
	expect(DRAWER_CONTENT).toContain('data-[vaul-drawer-direction=bottom]:bottom-0');
	expect(DRAWER_CONTENT).toContain('data-[vaul-drawer-direction=bottom]:inset-x-0');
	// The direction, sliced to the Root's own closing `>` rather than windowed: vaul's default is bottom, so the
	// claim is that the prop is ABSENT from the Root's tag. Seeking from a prop that has since been removed
	// sliced from -1 once and compared an empty string against every expectation below, silently.
	const rootStart = DRAWER.indexOf('<Drawer.Root');
	const rootTag = DRAWER.slice(rootStart, DRAWER.indexOf('>', rootStart));
	expect(DRAWER.indexOf('<Drawer.Root'), 'the sheet must still be a vaul Root').toBeGreaterThan(-1);
	expect(rootTag).toContain('snapPoints={[SNAP_BAND, SNAP_OPEN]}');
	expect(rootTag, 'the sheet must stay a BOTTOM drawer, or the bottom-0 class never applies').not.toContain(
		'direction='
	);
	// …and the drawer releases the vendored `max-h-[82dvh]` cap, which is what makes vaul's translate land the
	// band strip at the bottom edge rather than 152px above it: applied to a box shorter than the viewport, every
	// snap offset is wrong by the difference.
	expect(DRAWER).toMatch(/height: 100dvh;\s*max-height: none;/);
	// ONE env() term, on the one element that sits at that edge. Anything stacked above reads the inset THROUGH
	// --dock-h, so a second term doubles the gap on a notched phone.
	expect(BAND).toContain('padding-bottom: env(safe-area-inset-bottom, 0px);');
	expect(LAYOUT).not.toContain('safe-area-inset-bottom');
	expect(HOME).not.toContain('safe-area-inset-bottom');
	/*
	 * The drawer CONTENT carries an inset of its own and it is not a second term in the measured stack: it is an
	 * ANCESTOR of `.band-slot`, so its padding sits outside the clientHeight --dock-h is bound to. Counted, so a
	 * term cannot appear on `.band-slot` itself, where it WOULD be measured twice.
	 */
	expect((DRAWER.match(/env\(safe-area-inset-bottom/g) ?? []).length).toBe(1);
	const slotCss = DRAWER.slice(DRAWER.indexOf('.band-slot {'), DRAWER.indexOf('.band-slot :global(.band)'));
	expect(DRAWER.indexOf('.band-slot {'), '.band-slot must still be the measured band row').toBeGreaterThan(-1);
	expect(slotCss.length).toBeGreaterThan(0);
	expect(slotCss).not.toContain('env(safe-area-inset-bottom');

	// NEITHER STICKY NOR FIXED — the box is at the top of the flow and docks nothing. Sticky was tried and
	// abandoned: PageHeader is already sticky and carries the top safe-area inset, so a second sticky element
	// needs the header's RENDERED height as its offset — not a token, and an out-of-scale token makes the calc()
	// invalid, sliding the box under the title with nothing failing out loud. Pinning the ABSENCE of both stops
	// the box re-entering a competition for the viewport that the band now wins outright.
	expect(HOME).not.toMatch(/\.findbox \{[^}]*position:\s*(?:sticky|fixed)/s);
	expect(HOME).not.toContain('position: fixed');
	expect(HOME).not.toMatch(/bottom: 0;/);
	// It is the first thing inside the column, asserted by POSITION rather than adjacency: `main` carries the
	// measured `--row-h` and opens with the `{#if me}` gate that keeps the remote off the join screen, so nothing
	// can be syntactically adjacent to it.
	const column = HOME.slice(HOME.indexOf('<main'), HOME.indexOf('</main>'));
	expect(column.indexOf('class="findbox"')).toBeGreaterThan(-1);
	expect(column.indexOf('class="findbox"')).toBeLessThan(column.indexOf('class="grouphead"'));
	// …and `main`'s padding still consumes the MEASURED --dock-h, so the last row cannot bleed under the band.
	// The `+ 28px` term stays a literal because 28 is not a scale step, so nothing owns it.
	expect(HOME).toMatch(/padding:\s*var\(--space-xs\) var\(--space-3xl\) calc\(var\(--dock-h[^)]*\) \+ 28px\)/);
	// The label is a driven-flow anchor (SEL.search); renaming it hangs six probes on a timeout rather than
	// failing an assertion.
	expect(HOME).toContain('aria-label="Search a song or artist"');
});

test('the results read DOWNWARD: every result list is emitted with its best match first', () => {
	// The ranking reaches the DOM in ranking order — no reversal anywhere — which is what keeps DOM order equal
	// to visual order. A `column-reverse` container would paint the column against its DOM order and invert the
	// focus sequence with it, so the ban is part of the claim.
	expect(HOME).toMatch(/\{@const readyStack = readyResults\}/);
	expect(HOME).toMatch(/\{@const rawRows = unaccounted\(rawResults\)\}/);
	expect(HOME).not.toContain('.reverse()');
	expect(HOME).not.toContain('column-reverse');
	// The named upward stacks are gone with the layout that needed them, and so are the zero-query shortcuts.
	expect(HOME).not.toContain('processingStack');
	expect(HOME).not.toContain('popularRows');
	expect(HOME).not.toContain('recentRows');

	// Section order is the same claim at the block level: the most relevant section is FIRST, so it is the one on
	// screen when the results land — with whatever is being made right now above both. `<main` without the
	// closing bracket, because the element carries the measured `--row-h` as an attribute.
	const main = HOME.slice(HOME.indexOf('<main'), HOME.indexOf('</main>'));
	expect(main.indexOf('Making karaoke')).toBeLessThan(main.indexOf('{@const readyStack'));
	expect(main.indexOf('{@const readyStack')).toBeLessThan(main.indexOf('{@const rawRows'));
	expect(main.indexOf('>Ready to sing</h2>')).toBeLessThan(main.indexOf('>Needs karaoke</h2>'));
});

test('the top-anchored column has NO back control, because there is nowhere behind it', () => {
	/*
	 * There is no navigation to come back FROM: the field and the library are sections of `/`, so a "Back to the
	 * queue" link would point at the page it is on and a PageHeader would put a second title above home's own
	 * wordmark. The exits are the two that always existed — clearing the box, and the hardware Back. So the
	 * assertion is an ABSENCE, which is what reds if the surface is pushed onto a route again without the rest of
	 * the design following it.
	 */
	expect(HOME).not.toContain('<PageHeader');
	expect(HOME).not.toContain('Back to the queue');
	// The topbar stands in its place, and it is home's own: a wordmark, not a title with a way out.
	expect(HOME).toContain('<header class="topbar">');
	// The bottom-anchoring mechanism is banned OUTRIGHT rather than re-pointed, so the anchoring cannot revert by
	// halves: `.backrow` was both the selector `main:has(…)` matched on and the element whose auto bottom margin
	// pushed every later sibling down.
	expect(HOME).not.toContain('backrow');
	expect(HOME).not.toContain('margin-bottom: auto');
	expect(HOME).not.toContain('align-content: end');
	// The wide layout anchors the same way — an `align-content: end` grid would bottom-anchor the columns while
	// the phone column read from the top.
	expect(HOME).toMatch(/align-content: start;/);
});

test('nothing scrolls this surface: the ranking is already at the top, and the box stays reachable', () => {
	// With the best match first there is nothing to scroll TO, so the whole scroll orchestration is banned rather
	// than re-pointed: a viewport that moves under a reader who is reading is worse than the problem it solved.
	expect(HOME).not.toContain('window.scrollTo');
	expect(HOME).not.toContain('scrollIntoView');
	expect(HOME).not.toContain('scrollHeight');
	expect(HOME).not.toMatch(/\bresultShape\b/);
	// Instant, never smoothed: a scroll animation is motion no reduced-motion guest asked for, and
	// `behavior: 'smooth'` is the one way to introduce it that motion.test.ts's matcher cannot see.
	expect(HOME).not.toMatch(/behavior:\s*'smooth'/);
	// What replaces it: the box is the FIRST thing in <main>, so the top of the document already IS the top of
	// the ranking. Pinned as an ORDERING in the markup rather than as a CSS property, because that is the claim.
	const mainBody = HOME.slice(HOME.indexOf('<main'), HOME.indexOf('</main>'));
	expect(mainBody).toContain('class="findbox"');
	expect(mainBody.indexOf('class="findbox"')).toBeLessThan(mainBody.indexOf('class="grouphead"'));
	// No z-index either: a box in normal flow has nothing to sit above. The only stacked thing on a phone surface
	// is the band, and it is in the layout.
	expect(HOME).not.toMatch(/\.findbox \{[^}]*z-index/s);
});

test('the empty state that named the library count survives the chip that used to reach it', () => {
	// `readyEmptyState` is the only designed empty state on this surface (phone-inventory.test.ts detects it by
	// this copy), so deleting it with the Ready chip that used to reach it would have taken that with it. The
	// `searchActive &&` term is no longer written on the condition because the whole block lives inside the
	// searchActive branch — so the arm slices from a `{@const}` that exists ONLY in that branch, which asserts
	// the nesting rather than dropping the term.
	const results = HOME.slice(HOME.indexOf('{@const readyStack'), HOME.indexOf('</main>'));
	expect(results).toMatch(/\{#if !readyStack\.length && library\.length\}/);
	expect(results).toMatch(/readyEmptyState\(\{ searchActive, libraryCount: library\.length, query \}\)/);
	expect(results).toContain('Show all {empty.showAllCount}');
});

test('/ — no empty-state copy points at a search box above, or at a now-deleted shortcut list', () => {
	// Neither prompt can be true here: with the box at the TOP of this surface, "above" and "below" both
	// misdirect.
	expect(HOME).not.toContain('Search for a song above');
	expect(HOME).not.toContain('Search for a song in the box below');
});

test('the docked band survives the on-screen keyboard, by the one mechanism that can say so', () => {
	// The acceptance bullet is "the input remains visible and no result row is occluded with the keyboard up". A
	// `position: fixed; bottom: 0` band cannot satisfy it under the DEFAULT `resizes-visual` behaviour, where the
	// layout viewport keeps its full height and the band sits under the keyboard; `resizes-content` shrinks the
	// layout viewport instead. Pinned here because headless Chromium has no soft keyboard, so the measured gate
	// cannot check it and this scan is the only thing that does.
	const html = read('src/app.html');
	expect(html).toMatch(/name="viewport"/);
	expect(html).toContain('interactive-widget=resizes-content');
	// What it lifts is the BAND, so the fixed-to-the-bottom element is the drawer content the band sits inside,
	// or the attribute is lifting nothing. The layout declares no CSS at all now, so that element is vaul's own —
	// asserted against the vendored file rather than assumed.
	expect(DRAWER_CONTENT).toMatch(/\bfixed\b/);
	expect(DRAWER_CONTENT).toContain('data-[vaul-drawer-direction=bottom]:bottom-0');
	// …and the band really is inside that content. Ordered by index rather than by a windowed match: this file's
	// stripper BLANKS comments in place to keep line numbers, so prose between the two tags still occupies width.
	expect(DRAWER.indexOf('<Drawer.Content')).toBeGreaterThan(-1);
	expect(DRAWER.indexOf('<Drawer.Content')).toBeLessThan(DRAWER.indexOf('<div class="band-slot"'));
	expect(DRAWER).toContain('<NowPlayingBand');
	// And the box needs no lifting: it is at the TOP of the document, above the keyboard by construction. Pinning
	// the absence of sticky AND fixed stops it quietly re-docking on the strength of an attribute that would then
	// be carrying two elements' worth of work.
	expect(HOME).not.toMatch(/\.findbox \{[^}]*position:\s*(?:sticky|fixed)/s);
	expect(HOME).not.toContain('position: fixed');
});

test('this guard really read every route it claims to, and really stripped their comments', () => {
	// Every arm above is an absence, and an absence is what an empty string is full of. Six sources are read, so
	// each carries its OWN floor rather than one floor standing in for all of them.
	//
	// Two floors per file, and the SECOND is the one that does the work: `stripComments` blanks with spaces to
	// preserve line numbers, so the stripped string is always the same LENGTH as the raw one and a length check on
	// it could never catch a stripper that blanked everything. The non-whitespace count can.
	//
	// THE RAW FLOORS TRACK THE FILES, NOT THE OTHER WAY ROUND. They only have to be high enough to catch a
	// truncated or wrong read, so they are kept a wide margin under the real sizes and a prose edit in any of the
	// six does not red this arm. The CODE floors are what a stripped read has to clear, and comment edits cannot
	// move them — so a lowered raw floor is never a weakening of what is enforced.
	for (const [name, raw, stripped, rawFloor, codeFloor] of [
		['layout', LAYOUT_RAW, LAYOUT, 5000, 1800],
		['band', BAND_RAW, BAND, 8000, 2800],
		['room', ROOM_RAW, ROOM, 6000, 5000],
		['home', HOME_RAW, HOME, 22000, 17000],
		['drawer', DRAWER_RAW, DRAWER, 10000, 6000],
		['content', DRAWER_CONTENT_RAW, DRAWER_CONTENT, 2000, 1200]
	] as const) {
		expect(raw.length, `${name}: file read`).toBeGreaterThan(rawFloor);
		expect(stripped.replace(/\s+/g, '').length, `${name}: survived the stripper`).toBeGreaterThan(codeFloor);
		// The stripper must remove comments and NOTHING else — same line count, so every line number a
		// reviewer reads off a failure still points at the real file.
		expect(stripped.split('\n').length, `${name}: line numbers preserved`).toBe(raw.split('\n').length);
	}
	/*
	 * AND IT MUST REALLY STRIP — asserted against a FIXTURE rather than whichever file happens to carry a comment
	 * today. The earlier form named one PHRASE per file and required it present raw and absent stripped, which
	 * tied the guard to five particular sentences and red on a comment cleanup that changed nothing it guards.
	 * The stripper is a pure function, so the honest subject is both comment syntaxes and the code either side.
	 */
	const FIXTURE = [
		'<script lang="ts">',
		'\t// a line comment naming class="chips"',
		'\t/* a block comment naming showReady */',
		"\tconst kept = 'code';",
		'</script>',
		'<!-- a markup comment naming browse-toggle -->',
		'<div class="kept">{kept}</div>'
	].join('\n');
	const strippedFixture = stripComments(FIXTURE);
	expect(strippedFixture, 'no comment syntax may survive').not.toMatch(/\/\*|<!--|\/\//);
	for (const banned of ['class="chips"', 'showReady', 'browse-toggle'])
		expect(strippedFixture, `a ${banned} inside a comment must not survive`).not.toContain(banned);
	for (const kept of ["const kept = 'code';", '<div class="kept">{kept}</div>'])
		expect(strippedFixture, `the stripper must keep ${kept}`).toContain(kept);
	expect(strippedFixture.split('\n').length, 'line numbers preserved').toBe(FIXTURE.split('\n').length);
	// …and no comment syntax survives in any of the six real files either. Only this direction is asserted on
	// them: requiring them to CONTAIN a comment would make a prose edit anywhere in src red this guard.
	for (const [name, stripped] of [
		['layout', LAYOUT],
		['band', BAND],
		['room', ROOM],
		['home', HOME],
		['drawer', DRAWER],
		['content', DRAWER_CONTENT]
	] as const) {
		expect(stripped, `${name}: no comment syntax survived`).not.toMatch(/\/\*|<!--/);
	}
});
