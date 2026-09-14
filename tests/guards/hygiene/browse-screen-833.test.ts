// THE BROWSE SCREEN, DIRECTION B — the deletion is the invariant.
//
// WHY A SOURCE SCAN, AND WHERE IT STOPS. What direction B changes on this screen is which markup and
// which state EXIST: three readiness chips, an artist rail, a genre rail and two group headings are
// gone, and a docked search box with an upward-stacked result list is in their place. That is a set of
// syntax claims about `routes/+page.svelte`, and syntax claims are what a scan can settle. The
// geometry those claims imply — the box really sitting in the thumb zone, the stack really growing
// upward, nothing occluded with the keyboard up — is a MEASUREMENT and is not asserted here (XR-PH-21);
// `bun run gate:measured` drives the real render for that.
//
// The shape matters: a deletion is invisible to a behavioural suite. Nothing imports this route, so
// every mechanism below could be restored with the whole suite green. These are the assertions that
// RED when one comes back, one test per mechanism so a failure names which one.
//
// RETIREMENT RECORDED HERE (XR-VER-07). `routes/library-tag-filter-wiring.test.ts` is DELETED by this
// change, not weakened. It pinned five render seams of the tag filter — `facets.tags` state, a
// `browseFilter` that could hold a tag, `setBrowse('tag', …)`, the `?tag=` query and the tag rail
// itself — every one of which is a mechanism direction B removes. Its premise was "the tag filter is
// wired through the phone page"; the ruling is that the phone page has no tag filter. The SERVER half
// of is untouched and still guarded (`server/media/library-tag-filter.test.ts`,
// `routes/api/library/library-tag-filter-wiring.test.ts`), which is why only one of the three
// similarly-named files retires. The absence is pinned below so it cannot creep back in unnoticed.

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
const RAW = read('src/routes/+page.svelte');
const PAGE = stripComments(RAW);

// ── mechanism 1: the three readiness chips ───────────────────────────────────────────────────────
test('mechanism 1 — the readiness chip row is gone, and so is the state behind it', () => {
	// The row itself, by the group label every driven flow used to find it with.
	expect(PAGE).not.toContain('Filter by readiness');
	expect(PAGE).not.toMatch(/class="chips"/);
	// …and the state, or the chips could be restored without re-deriving anything. `filter` was the
	// single source of the axis; `showReady`/`showProcessing`/`showRaw` gated the three groups on it, and
	// `libraryCount` existed only to put a number on the Ready chip.
	expect(PAGE).not.toMatch(/\blet filter\b/);
	expect(PAGE).not.toMatch(/\bshowReady\b/);
	expect(PAGE).not.toMatch(/\bshowProcessing\b/);
	expect(PAGE).not.toMatch(/\bshowRaw\b/);
	// `libraryCount` as a DERIVED is gone; the identically-named PARAMETER of readyEmptyState() is not
	// this mechanism and must survive — the empty state below still names how many songs the library has.
	expect(PAGE).not.toMatch(/const libraryCount = \$derived/);
	expect(PAGE).toMatch(/libraryCount: library\.length/);
});

test('mechanism 1 — every group renders unconditionally, so nothing is hidden behind a chip', () => {
	// The ready and processing groups are gated on `searchActive` and on having rows — never on a
	// filter. This is the arm that fails if a "quick" reinstatement re-adds a gate without the chips.
	expect(PAGE).toContain('{#if searchActive && processingRows.length}');
	// `accountedFor` subtracts BOTH groups from the shortcut lists unconditionally: with a filter, a
	// hidden group stopped accounting for its songs and they reappeared under Popular/Recently queued.
	expect(PAGE).toMatch(/for \(const m of searchActive \? readyResults : library\) ids\.add\(m\.id\);/);
	expect(PAGE).toMatch(/for \(const c of processingRows\) ids\.add\(c\.id\);/);
});

// ── mechanisms 2 and 3: the artist rail and the genre/tag rail ───────────────────────────────────
test('mechanisms 2+3 — the browse disclosure and both facet rails are gone from the phone', () => {
	expect(PAGE).not.toContain('browse-toggle');
	expect(PAGE).not.toContain('Browse by artist');
	expect(PAGE).not.toContain('Browse by tag');
	expect(PAGE).not.toContain('Browse by genre'); // an earlier change's ruling still holds; this does not revive it
	expect(PAGE).not.toMatch(/\bbrowseFilter\b/);
	expect(PAGE).not.toMatch(/\bbrowseOpen\b/);
	expect(PAGE).not.toMatch(/\bsetBrowse\b/);
	expect(PAGE).not.toMatch(/\bfacets\b/);
});

test('mechanisms 2+3 — the phone asks the library endpoint for the whole library, unfiltered', () => {
	// The narrowing was server-side (?artist= / ?tag=), so the fetch is where a rail would have to come
	// back through. One unqualified request, no query string built from a filter.
	expect(PAGE).toMatch(/fetch\('\/api\/library'\)/);
	expect(PAGE).not.toMatch(/\?artist=/);
	expect(PAGE).not.toMatch(/\?tag=/);
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

// ── mechanism 4: the group headings that re-announced the readiness axis ─────────────────────────
test('mechanism 4 — the readiness group headings are gone; the rows say it themselves', () => {
	// These two restated, in prose, the chip directly above them. SongRow paints a readiness chip per
	// row, so the axis is still visible — it is just not announced twice.
	expect(PAGE).not.toContain('Ready to sing');
	expect(PAGE).not.toContain('Processing · queue it anyway');
	expect(PAGE).not.toMatch(/\bshowGroupHeads\b/);
	expect(PAGE).not.toMatch(/class="grouphead ok"/);
	expect(PAGE).not.toMatch(/class="grouphead warn"/);
	// The heading that survives labels a DIFFERENT axis (what the list is), not the readiness of its
	// members — so it is not duplication and is deliberately kept.
	expect(PAGE).toContain('Needs karaoke · has vocals');
	// The zero-query shortcut lists (Popular tonight / Recently queued) were dropped with the browse
	// mode: an empty box shows the live QUEUE now, so their headings are gone from this route.
	expect(PAGE).not.toContain('Popular tonight');
	expect(PAGE).not.toContain('Recently queued');
	// …and the `.grouphead-mark` rule they were the only users of goes with them — a dead CSS selector
	// left behind is exactly the residue this deletion guard exists to red on (svelte-check would warn).
	expect(PAGE).not.toContain('grouphead-mark');
});

// ── what replaced them: one docked box, one stack, growing upward ────────────────────────────────
test('search is a docked band in the thumb zone, publishing the measured --dock-h', () => {
	// After </main>, so it sits below the content it docks under and the tab sequence follows the visual
	// order (XR-PH-12). Since it is gated on `{#if me}` — docked for a joined singer at all times,
	// the sole band on this route.
	expect(PAGE.indexOf('class="search-dock"')).toBeGreaterThan(PAGE.indexOf('</main>'));
	expect(PAGE).toMatch(/\{#if me\}\s*<div class="search-dock" bind:clientHeight=\{dockH\}>/);
	// ONE token, measured, and now ONE band (the `+ Add a turn` CTA that used to be home's band is gone,
	// ). A second `--search-dock-h`, or a hardcoded height, forks the geometry the measurement exists
	// to keep single — and `main`'s padding, `--undo-dock` and `--error-dock` all read this one.
	expect(PAGE).not.toContain('--search-dock-h');
	const docks = PAGE.match(/bind:clientHeight=\{dockH\}/g) ?? [];
	expect(docks.length).toBe(1); // the search dock, the only fixed band on this route since an earlier change
	// Re-anchored by: `6px`/`18px` are now `var(--space-xs)`/`var(--space-3xl)`, the same two values
	// read from the spacing scale in app.css. The claim is unchanged — main's padding is what consumes the
	// measured --dock-h — so only its spelling moves. The `+ 28px` term stays a literal: 28 is not a scale
	// step, so nothing owns it and there is nothing to name it.
	expect(PAGE).toMatch(/padding:\s*var\(--space-xs\) var\(--space-3xl\) calc\(var\(--dock-h[^)]*\) \+ 28px\)/);
	// The label is a driven-flow anchor (SEL.search); renaming it hangs six probes on a timeout rather
	// than failing an assertion, so the move must not have taken it with it.
	expect(PAGE).toContain('aria-label="Search a song or artist"');
});

test('the results stack UPWARD: every result list is emitted with its best match last', () => {
	// The ranking is reversed in the DOM, which is what keeps DOM order equal to visual order
	// (XR-PH-12). A `column-reverse` container would paint the column against its DOM order and invert
	// the focus sequence with it, so the ban is part of the claim.
	expect(PAGE).toMatch(/\{@const readyStack = \[\.\.\.readyResults\]\.reverse\(\)\}/);
	expect(PAGE).toMatch(/\{@const processingStack = \[\.\.\.processingRows\]\.reverse\(\)\}/);
	expect(PAGE).toMatch(/\{@const rawRows = unaccounted\(rawResults\)\.reverse\(\)\}/);
	// The zero-query shortcut stacks (popularRows / recentRows) were dropped with the browse mode.
	expect(PAGE).not.toContain('popularRows');
	expect(PAGE).not.toContain('recentRows');
	expect(PAGE).not.toContain('column-reverse');

	// Section order is the same claim at the block level: the most relevant section is the LAST one, so
	// it is the one beside the thumb. Ready is nearest, then processing, then what still needs karaoke.
	const main = PAGE.slice(PAGE.indexOf('<main>'), PAGE.indexOf('</main>'));
	expect(main.indexOf('rawRows')).toBeLessThan(main.indexOf('processingStack'));
	expect(main.indexOf('processingStack')).toBeLessThan(main.indexOf('readyStack'));
});

test('the bottom-anchored column reserves the top for the back control', () => {
	// Bottom-anchored, or one line of content sits at the top of an empty screen instead of beside the
	// thumb. The MECHANISM is the auto bottom margin on the back control: in a flex column it both keeps
	// that control at the top and pushes every later sibling to the bottom. A `justify-content: flex-end`
	// beside it was measured to change nothing (the selector only matches when the back control is
	// present, so the two always co-occur), so it is deliberately absent — this pins the declaration a
	// revert can actually falsify.
	expect(PAGE).toMatch(/main:has\(> \.backrow\) \{\s*display: flex;\s*flex-direction: column;\s*\}/);
	expect(PAGE).toMatch(/main:has\(> \.backrow\) > \.backrow \{\s*margin-bottom: auto;/);
	// The wide layout keeps its columns and needs its own anchoring: an auto margin on a GRID item
	// aligns that item in its own area and does not push its siblings.
	expect(PAGE).toMatch(/main:has\(> \.backrow\) \{\s*display: grid;\s*align-content: end;/);
});

test('a stack that grows upward is scrolled to, instantly and only when the set changes', () => {
	// Bottom-anchored content longer than the viewport starts at its TOP, which is the far end of the
	// ranking: without this the best match renders below the fold. Keyed on the shape of the rendered
	// set, so scrolling up to read further is not fought on every frame.
	expect(PAGE).toMatch(/const resultShape = \$derived\(/);
	expect(PAGE).toMatch(
		/if \(!resultShape\) return;\s*window\.scrollTo\(\{ top: document\.documentElement\.scrollHeight \}\);/
	);
	// Instant, never smoothed: a scroll animation is motion no reduced-motion guest asked for, and
	// `behavior: 'smooth'` is the one way to introduce it that motion.test.ts's matcher cannot see.
	expect(PAGE).not.toMatch(/behavior:\s*'smooth'/);
});

test('the empty state that named the library count survives the chip that used to reach it', () => {
	// `readyEmptyState` said "None of your N karaoke songs match X" plus a way back. It was the Ready
	// CHIP's empty state; the chip is gone and the condition it was really about — a query the ready
	// library cannot answer — is now stated directly. Deleting it instead would have taken the only
	// designed empty state on this route with it (phone-inventory.test.ts detects `/` × empty by it).
	expect(PAGE).toMatch(/\{#if searchActive && !readyStack\.length && library\.length\}/);
	expect(PAGE).toMatch(/readyEmptyState\(\{ searchActive, libraryCount: library\.length, query \}\)/);
	expect(PAGE).toContain('Show all {empty.showAllCount}');
});

test('/ — no empty-state copy points at a search box above, or at a now-deleted shortcut list', () => {
	// The box moved to the bottom, so "Search for a song above" became false. then dropped
	// the empty-box shortcut list entirely — an empty box shows the live queue — so its "in the box
	// below" prompt is gone too: neither direction is stated any more.
	expect(PAGE).not.toContain('Search for a song above');
	expect(PAGE).not.toContain('Search for a song in the box below');
});

test('the docked box survives the on-screen keyboard, by the one mechanism that can say so', () => {
	// The acceptance bullet is "the input remains visible and no result row is occluded with the keyboard
	// up". A `position: fixed; bottom: 0` band cannot satisfy it under the DEFAULT viewport behaviour
	// (`resizes-visual`): the layout viewport keeps its full height, so the band sits under the keyboard.
	// `interactive-widget=resizes-content` shrinks the layout viewport instead, which is what lifts the
	// dock. Pinned here because it is a one-attribute claim that reads as cosmetic and is not: the gate
	// cannot check it (headless Chromium has no soft keyboard), so this scan is the only thing that does.
	const html = read('src/app.html');
	expect(html).toMatch(/name="viewport"/);
	expect(html).toContain('interactive-widget=resizes-content');
	// And the band really is fixed to the bottom, or the attribute is lifting nothing.
	expect(PAGE).toMatch(/\.search-dock \{[^}]*position: fixed;[^}]*bottom: 0;/s);
});

// ── non-vacuity ─────────────────────────────────────────────────────────────────────────────────
test('this guard really read the route, and really stripped its comments', () => {
	// Every arm above is an absence, and an absence is what an empty string is full of. Two floors: the
	// file was read, and the stripper did not blank it.
	expect(RAW.length).toBeGreaterThan(40000);
	expect(PAGE.length).toBeGreaterThan(20000);
	// The stripper must remove comments and NOTHING else — same line count, so every line number a
	// reviewer reads off a failure still points at the real file.
	expect(PAGE.split('\n').length).toBe(RAW.split('\n').length);
	// And it must really strip: the route explains this deletion where it happened, so its comments name
	// the very mechanisms the arms above ban. A no-op stripper would red every one of them.
	expect(RAW).toContain('DELETED HERE (direction B)');
	expect(PAGE).not.toContain('DELETED HERE (direction B)');
});
