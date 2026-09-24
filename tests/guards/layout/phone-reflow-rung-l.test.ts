// guard: the SC 1.4.10 Reflow row has a RENDERED guard, and it cannot be quietly defanged. THIS FILE DOES
// NOT GUARD THE OVERFLOW — IT GUARDS THE GUARD: `/stats` overflowed a 320px viewport by 8px at 200% text
// while the declaration arm was green, because the overflow was a SUM of lengths that exist only after
// layout. The measurement is tests/e2e/probes/p15-phone-reflow.mjs, a live-server `.mjs` that cannot run
// inside `bun test`. Delete the probe, retarget it to 390px, stop doubling the root font-size, or turn its
// `process.exit(1)` into a print, and this file reds by name. Comments are blanked before matching, because
// the /stats grid fix's own comment names "320px" and "200%". See docs/GUARDS.md#phone-inventories-and-reflow.
import { test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { at, repoRoot } from '@encore/test-support';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

const CORE = repoRoot;
const PROBE_PATH = at('tests', 'e2e', 'probes', 'p15-phone-reflow.mjs');
const STATS_PATH = join(CORE, 'src', 'routes', 'stats', '+page.svelte');

test('the rung-L reflow probe exists and this guard is not vacuous', () => {
	// A renamed or deleted probe reds HERE rather than leaving every assertion below to fail-open on an empty string.
	expect(existsSync(PROBE_PATH)).toBe(true);
	expect(readFileSync(PROBE_PATH, 'utf8').length).toBeGreaterThan(3000);
});

const PROBE = stripComments(readFileSync(PROBE_PATH, 'utf8'));

test('the reflow probe measures on the LAYOUT rung, not the mount rung', () => {
	// happy-dom returns an all-zero DOMRect, so the same assertions on the mount rung are a permanent silent green.
	expect(PROBE).toMatch(/from\s*'\.\.\/driver\.mjs'/);
	expect(PROBE).toMatch(/\bconnect\b/);
	// And it must drive its own browser rather than assume one is listening.
	expect(PROBE).toMatch(/from\s*'\.\.\/lib\/chromium\.mjs'/);
	expect(PROBE).toMatch(/findChromium\s*\(/);
});

test('the reflow probe measures at the criterion\u2019s own numbers: 320 CSS px and 200% text', () => {
	// 320 is SC 1.4.10's width: a probe retargeted to 390px passes while the criterion fails.
	expect(PROBE).toMatch(/VIEWPORT_W\s*=\s*320\b/);
	// 200% of the 16px default. The ROOT FONT-SIZE is what a guest's text-size setting scales; page zoom
	// scales the viewport with it and cannot expose this class at all.
	expect(PROBE).toMatch(/SCALED_ROOT_FONT_SIZE\s*=\s*'32px'/);
	expect(PROBE).toMatch(/documentElement\.style\.fontSize/);
	// The scale must be applied to the LIVE document, and both sides of the criterion must be read.
	expect(PROBE).toMatch(/\bscrollWidth\b/);
	expect(PROBE).toMatch(/\bclientWidth\b/);
	expect(PROBE).toMatch(/scrollWidth\s*<=\s*m\.clientWidth/);
});

test('the reflow probe covers every surface, and /stats by name', () => {
	// The four surfaces are `/` (also the join surface, as home's unjoined branch), `/settings`, `/stats` and
	// browse. A probe that stopped visiting one reports a green row over an unmeasured surface.
	for (const surface of ['/settings', '/stats']) {
		expect(PROBE).toContain(`measure('${surface}', '${surface}')`);
	}
	expect(PROBE).toMatch(/measure\('\/',\s*'\/'\)/);
	// Browse needs a session, so the probe joins from inside the page; the search box is on `/` and results render in
	// place, so the surface IS `/` — searched first so the real offender renders, then measured in place (`skipNav`).
	expect(PROBE).toMatch(/measure\('browse \(joined \/, searched\)',\s*'\/',\s*\{\s*skipNav:\s*true\s*\}\)/);
	expect(PROBE).toMatch(/'\/api\/join'/);
});

test('the reflow probe FAILS on an overflow instead of merely reporting one', () => {
	// A driver that prints FAIL and exits 0 is a report, not a guard.
	expect(PROBE).toMatch(/process\.exit\(1\)/);
	// Exit 2 is reserved for "the environment could not host this" and must never be reached by a
	// measurement — never conflate 2 with 0.
	expect(PROBE).toMatch(/process\.exit\(2\)/);
	// An unbuilt tree serves pages with no app in them, which measure as a trivially clean 320.
	expect(PROBE).toMatch(/build['"],\s*['"]client/);
});

test('the browse arm is MEASURED, DISCRIMINATING, and renders its real offender', () => {
	// The browse reflow is fixed, so the surface is asserted like the other four rather than quarantined — a
	// resolved quarantine is removed, never left sitting green over a fixed defect. Its machinery must be gone,
	// and the measurement must FAIL on an overflow (the shared `measure()`, not a `measureRaw` that only reads).
	expect(PROBE).not.toMatch(/BROWSE_QUARANTINE_ISSUE/);
	expect(PROBE).not.toMatch(/browseOver/);
	expect(PROBE).not.toMatch(/measureRaw\('browse/);
	// NON-VACUITY + DISCRIMINATION. An EMPTY joined room renders no rows, so a bare browse measurement is a
	// clean 320 over an unexercised layout. The arm SEARCHES first, surfacing the canned result set whose
	// long-duration entries render the widest browse offender chip, then waits for rows and BAILS rather than
	// measures if none landed. With the fix reverted this arm reds ("over by 11px").
	expect(PROBE).toMatch(/openBrowseFromHome\(page\)/);
	expect(PROBE).toMatch(/\.fill\(SEL\.search,\s*'caroline'\)/);
	expect(PROBE).toMatch(/SEL\.songRow/);
	expect(PROBE).toMatch(/the browse search returned no rows/i);
	// Not via processing a song: that measures a chip which wraps on its own, so it never discriminated.
	expect(PROBE).not.toMatch(/\/api\/process\b|requestProcess/);
});

// The fix mechanisms as source scans: the cheap always-on floor beneath the probe. None decides whether a
// page overflows, only whether the mechanism that stopped it is still declared.

const STATS = stripComments(readFileSync(STATS_PATH, 'utf8'));

test('the /stats tile grid floors its tracks in a TYPE-RELATIVE unit, never px', () => {
	const rules = [...STATS.matchAll(/grid-template-columns:\s*([^;]+);/g)].map((m) => m[1].trim());
	// Non-vacuity: both the base rule and the phone override must be found, or the assertions below check an
	// empty list.
	expect(rules.length).toBeGreaterThanOrEqual(2);
	for (const rule of rules) {
		// A px floor is fixed while the word it holds grows with the text-size setting, so at 200% it stops
		// bounding anything; and a fixed track count (`1fr 1fr`, the shape that shipped) cannot give way.
		expect(rule).not.toMatch(/minmax\(\s*[\d.]+px/);
		expect(rule).toMatch(/repeat\(\s*auto-fit/);
		expect(rule).toMatch(/[\d.]em\b/);
		// The floor must be bounded by the row, or a floor wider than the viewport IS the overflow.
		expect(rule).toMatch(/min\(\s*100%/);
	}
});

// The KEY control renders only under live, WS-driven playback, which the self-hosting probe cannot start,
// so it is pinned here INSTEAD of measured — a statement about the harness's reach.
const APP_CSS_PATH = join(CORE, 'src', 'app.css');
const PAGE_PATH = join(CORE, 'src', 'routes', '+page.svelte');
const SONG_ROW_PATH = join(CORE, 'src', 'lib', 'components', 'SongRow.svelte');
// The transport, key row and range visualizer live in a bottom drawer the band's pull handle opens, so the
// key row's load-bearing rules are declared there rather than on the route.
const DRAWER_PATH = join(CORE, 'src', 'lib', 'components', 'NowPlayingDrawer.svelte');
const APP_CSS = stripComments(readFileSync(APP_CSS_PATH, 'utf8'));
const PAGE = stripComments(readFileSync(PAGE_PATH, 'utf8'));
const SONG_ROW = stripComments(readFileSync(SONG_ROW_PATH, 'utf8'));
const DRAWER_CSS = stripComments(readFileSync(DRAWER_PATH, 'utf8'));

test('the odd-duration chip wraps its phrase instead of forcing the row wider', () => {
	// Every other SongRow chip is a short token, so the blanket `white-space: nowrap` is fine for them — but
	// this one carries a whole phrase, and nowrap made its min-content width its FULL width (~230px at 200%),
	// so it could not shrink and pushed the browse page past 320px.
	const badge = readFileSync(join(CORE, 'src', 'lib', 'components', 'ui', 'badge', 'badge.svelte'), 'utf8');
	const wrapRule = badge.match(/\.encore-chip-wrap\s*\{([^}]*)\}/)?.[1] ?? '';
	expect(wrapRule, 'ui/badge must offer a wrapping tone').toMatch(/white-space:\s*normal/);
	expect(SONG_ROW, 'the odd-duration chip must ask for it').toMatch(/durationNote\}<Badge variant="bad" wrap>/);
});

test('the key row wraps and its ±semitone buttons can shrink at 200% text', () => {
	// `.key` is a flex row of two `flex: 1` buttons whose label is the single unbreakable word "semitone"; at
	// 200% each is ~172px, so two-up plus the label forced the row past 320px. Each rule is extracted with a
	// NAMED non-vacuity floor rather than `?? ''`, so a re-point onto the wrong file says WHICH rule it could
	// not find instead of reading as a production regression. The row must be allowed to WRAP…
	const keyRule = DRAWER_CSS.match(/\.key\s*\{([^}]*)\}/)?.[1] ?? '';
	expect(keyRule, 'the `.key` rule was not found where the key row now lives').not.toBe('');
	expect(keyRule).toMatch(/flex-wrap:\s*wrap/);
	// …and each button must free its flex minimum, or the shrink is not allowed at all: a bare `flex: 1`
	// (basis 0 but min-width auto) cannot go below the word's min-content width, which is the shape that
	// overflowed. `min-width: 0` is the load-bearing declaration. The flex ITEM is an element
	// `<Button variant="keycap">` renders and a class passed to a component is stripped in the caller, so the
	// flex behaviour lives on the `.key-cell` wrapper the drawer renders and word-breaking in the variant.
	const keyCellRule = DRAWER_CSS.match(/\.key-cell\s*\{([^}]*)\}/)?.[1] ?? '';
	expect(keyCellRule, 'the `.key-cell` rule was not found where the key row now lives').not.toBe('');
	expect(keyCellRule).toMatch(/min-width:\s*0/);
	expect(keyCellRule).toMatch(/flex:\s*1\s+1\s+40%/);
	// A single full-width button can still be narrower than "semitone", so the word itself must be able to
	// break. The base sets `whitespace-nowrap`, so the variant has to undo that as well as allow the break.
	const BUTTON = stripComments(
		readFileSync(join(CORE, 'src', 'lib', 'components', 'ui', 'button', 'button.svelte'), 'utf8')
	);
	const keycap = BUTTON.match(/keycap:\s*\n?\s*'([^']*)'/)?.[1] ?? '';
	expect(keycap, 'the `keycap` Button variant was not found').not.toBe('');
	expect(keycap).toMatch(/\[overflow-wrap:anywhere\]/);
	expect(keycap).toMatch(/whitespace-normal/);
	// …and the row is not declared in two places, where a stale copy would drift from the live one.
	expect(PAGE).not.toMatch(/\.key-cell\s*\{/);
	expect(APP_CSS).not.toMatch(/\.key-cell\s*\{/);
});
