// guard: the XR-PH-02 reflow row has a RENDERED guard, and it cannot be quietly defanged.
//
// THE BUG THIS EXISTS FOR. `/stats` overflowed a 320px viewport by 8px at 200% text scale — an SC
// 1.4.10 Reflow failure — while `phone-inventory.test.ts`'s XR-PH-02 arm was green. That arm was not
// broken: it flags a single DECLARATION wider than 320px, and this overflow was a SUM (two grid tracks
// plus two cards' padding, against a word that cannot wrap once type doubles). The addends are resolved
// lengths that exist only after layout, so no scan over declarations can add them up. `docs/ux/02-phone.md`
// says as much in XR-PH-02's own Check row: "Rendered-DOM or driven-browser measurement. **Not a source
// scan** — both halves are geometry."
//
// SO WHY IS *THIS* FILE A SOURCE SCAN. Because it does not guard the overflow — it guards the GUARD.
// The overflow is measured by `apps/core/e2e/probes/p15-phone-reflow.mjs`, a real rung-L driver: private
// Chromium, real server, `documentElement.scrollWidth` vs `clientWidth`, exit 1 on a failure. That
// probe cannot run inside `bun test` — every e2e driver in this repo is a live-server `.mjs` invoked by
// nothing in the suite, and making the root gate depend on a built UI and a user-level Chromium cache
// is a wider change than this row needs. What a scan CAN decide is whether the measuring guard still
// exists, still measures on the layout rung, still measures at the criterion's numbers, and still
// fails. Delete the probe, drop its viewport to 390px, stop doubling the root font-size, or turn its
// `process.exit(1)` into a print, and this file reds by name. Precedent for the split:
// `src/server/realtime/e2e-real-gesture-verb.test.ts` and `src/lib/tv/autoplay-recovery.test.ts`, both
// of which pin a rendered driver from inside the suite.
//
// Comments are blanked before matching, so prose describing a number can neither satisfy nor trip an
// assertion — the /stats grid fix's own comment names "320px" and "200%" repeatedly.
import { test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appCore } from '@encore/test-support';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// apps/core, anchored at the repo root rather than counted up from this file's own location.
const CORE = appCore;
const PROBE_PATH = join(CORE, 'e2e', 'probes', 'p15-phone-reflow.mjs');
const STATS_PATH = join(CORE, 'src', 'routes', 'stats', '+page.svelte');

test('the rung-L reflow probe exists and this guard is not vacuous', () => {
	// A renamed or deleted probe must red HERE, with the path in the message, rather than leaving every
	// assertion below to fail-open on an empty string.
	expect(existsSync(PROBE_PATH)).toBe(true);
	expect(readFileSync(PROBE_PATH, 'utf8').length).toBeGreaterThan(3000);
});

const PROBE = stripComments(readFileSync(PROBE_PATH, 'utf8'));

test('the reflow probe measures on the LAYOUT rung, not the mount rung', () => {
	// XR-VER-02's Check: a measurement-classified entry must import the layout-rung driver. happy-dom
	// returns an all-zero DOMRect, so the same assertions on rung M are a permanent silent green.
	expect(PROBE).toMatch(/from\s*'\.\.\/cdp\.mjs'/);
	expect(PROBE).toMatch(/\bconnect\b/);
	// And it must drive its own browser rather than assume one is listening.
	expect(PROBE).toMatch(/from\s*'\.\.\/lib\/chromium\.mjs'/);
	expect(PROBE).toMatch(/findChromium\s*\(/);
});

test('the reflow probe measures at the criterion\u2019s own numbers: 320 CSS px and 200% text', () => {
	// 320 is SC 1.4.10's width. A probe quietly retargeted to 390px would pass while the criterion
	// failed, which is the whole defect class this row exists for.
	expect(PROBE).toMatch(/VIEWPORT_W\s*=\s*320\b/);
	// 200% of the 16px default. The root font-size is what a guest's text-size setting scales; page
	// zoom scales the viewport with it and cannot expose this class at all.
	expect(PROBE).toMatch(/SCALED_ROOT_FONT_SIZE\s*=\s*'32px'/);
	expect(PROBE).toMatch(/documentElement\.style\.fontSize/);
	// The scale must be applied to the LIVE document, and both sides of the criterion must be read.
	expect(PROBE).toMatch(/\bscrollWidth\b/);
	expect(PROBE).toMatch(/\bclientWidth\b/);
	expect(PROBE).toMatch(/scrollWidth\s*<=\s*m\.clientWidth/);
});

test('the reflow probe covers every XR-PH-02 surface, and /stats by name', () => {
	// XR-PH-02's Acceptance named `/`, `/join`, `/settings`, `/stats` and the browse screen. `/join` was
	// retired (Q2-A) into the unjoined branch of `/`, so `measure('/', '/')` now IS the join
	// surface — the four named surfaces are `/`, `/settings`, `/stats` and browse. A probe that silently
	// stopped visiting one would report a green row over an unmeasured surface.
	for (const surface of ['/settings', '/stats']) {
		expect(PROBE).toContain(`measure('${surface}', '${surface}')`);
	}
	expect(PROBE).toMatch(/measure\('\/',\s*'\/'\)/);
	// The browse/results screen needs a session, so the probe joins from inside the page and then
	// measures it like the other four (the browse reflow is fixed; it was quarantined here until the fix landed). Since
	// the search box is docked on `/` and results render in place, so the surface IS `/` — SEARCHED
	// first so the real offender renders (see the non-vacuity test below), then measured in place
	// (`skipNav`). The old `?browse=1` mode is gone.
	expect(PROBE).toMatch(/measure\('browse \(joined \/, searched\)',\s*'\/',\s*\{\s*skipNav:\s*true\s*\}\)/);
	expect(PROBE).toMatch(/'\/api\/join'/);
});

test('the reflow probe FAILS on an overflow instead of merely reporting one', () => {
	// The distinction that matters: a driver that prints FAIL and exits 0 is a report, not a guard.
	expect(PROBE).toMatch(/process\.exit\(1\)/);
	// Exit 2 is reserved for "the environment could not host this", and must never be reached by a
	// measurement. HARNESS.md: never conflate 2 with 0.
	expect(PROBE).toMatch(/process\.exit\(2\)/);
	// An unbuilt tree serves pages with no app in them, which measure as a trivially clean 320 — the
	// probe must bail on that rather than report a pass.
	expect(PROBE).toMatch(/build['"],\s*['"]client/);
});

test('the browse arm is MEASURED, DISCRIMINATING, and renders its real offender', () => {
	// The browse-screen reflow is fixed, so the surface is now asserted like the other four rather
	// than recorded as a known overflow. The quarantine that used to live here reddened the day the fix
	// landed (its arm asserted the surface STILL overflowed) and was deleted, per XR-VER-06/07 — a
	// resolved quarantine is removed, never left to sit green over a fixed defect. Its machinery must be
	// gone: no residual constant, and no "still overflows" arm that would re-quarantine the surface.
	expect(PROBE).not.toMatch(/BROWSE_QUARANTINE_ISSUE/);
	expect(PROBE).not.toMatch(/browseOver/);
	// The browse measurement must FAIL on an overflow like the others — proven by the shared `measure()`
	// call asserted above, not a `measureRaw` that reads without asserting.
	expect(PROBE).not.toMatch(/measureRaw\('browse/);
	// NON-VACUITY + DISCRIMINATION (XR-VER-05). An EMPTY joined room renders no rows, so a bare browse
	// measurement is a clean 320 over an unexercised layout — a green guard insensitive to the fix, which
	// is exactly why the first version of this arm was rejected. So the arm SEARCHES the browse screen
	// first — via the shared `openBrowseFromHome` step and a `fill` of the contract's `SEL.search`
	// hook — which surfaces the canned result set whose long-duration entries render the odd-duration
	// chip, the widest browse-reflow offender. It then waits for the rows to land (`SEL.songRow`) and bails rather
	// than measures if none did, so an empty read can never masquerade as a pass. With the fix reverted
	// this arm reds ("over by 11px"); with it, green.
	expect(PROBE).toMatch(/openBrowseFromHome\(page\)/);
	expect(PROBE).toMatch(/\.fill\(SEL\.search,\s*'caroline'\)/);
	expect(PROBE).toMatch(/SEL\.songRow/);
	expect(PROBE).toMatch(/the browse search returned no rows/);
	// It must NOT depend on cooking a song: the earlier cooking-seed approach measured a chip that
	// wraps on its own, so it never overflowed and never discriminated.
	expect(PROBE).not.toMatch(/make-karaoke/);
});

// ---------------------------------------------------------------------------------------------------
// The /stats grid fix itself — pinned so a regression to a type-blind floor cannot pass unnoticed between
// probe runs. This is the cheap always-on floor beneath the probe, and is NOT a substitute for it: it
// cannot decide whether the page overflows, only whether the mechanism that stopped it is still there.
// ---------------------------------------------------------------------------------------------------

const STATS = stripComments(readFileSync(STATS_PATH, 'utf8'));

test('the /stats tile grid floors its tracks in a TYPE-RELATIVE unit, never px', () => {
	const rules = [...STATS.matchAll(/grid-template-columns:\s*([^;]+);/g)].map((m) => m[1].trim());
	// Non-vacuity: both the base rule and the phone override must be found, or the assertions below
	// are checking an empty list.
	expect(rules.length).toBeGreaterThanOrEqual(2);
	for (const rule of rules) {
		// A px floor is fixed while the word it has to hold grows with the guest's text-size setting,
		// so at 200% it stops bounding anything and the row overflows instead of reflowing.
		expect(rule).not.toMatch(/minmax\(\s*[\d.]+px/);
		// A fixed track count cannot give way at all — `1fr 1fr` is the exact shape that shipped the overflow.
		expect(rule).toMatch(/repeat\(\s*auto-fit/);
		expect(rule).toMatch(/[\d.]em\b/);
		// And the floor must be bounded by the row, or a floor wider than the viewport becomes the
		// overflow itself — the same defect one level up.
		expect(rule).toMatch(/min\(\s*100%/);
	}
});

// ---------------------------------------------------------------------------------------------------
// The browse-reflow fix mechanisms, pinned as source scans. The browse arm above DRIVES and MEASURES the
// odd-duration chip offender live and reds without its fix, so that one is not honour-system — the
// scan here is its cheap always-on companion. The KEY control, by contrast, only manifests with a
// now-playing song (it renders in the now-playing controls under live, WS-driven playback), which the
// self-hosting probe cannot start; per the reviewer's accepted
// alternative, this is the clear statement that the harness cannot reach that offender plus the
// source-scan assertion that stands in for the live measurement. None of these decides whether the
// page overflows — each decides whether the mechanism that stopped it is still declared.
// ---------------------------------------------------------------------------------------------------

const APP_CSS_PATH = join(CORE, 'src', 'app.css');
const PAGE_PATH = join(CORE, 'src', 'routes', '+page.svelte');
const SONG_ROW_PATH = join(CORE, 'src', 'lib', 'components', 'SongRow.svelte');
const APP_CSS = stripComments(readFileSync(APP_CSS_PATH, 'utf8'));
const PAGE = stripComments(readFileSync(PAGE_PATH, 'utf8'));
const SONG_ROW = stripComments(readFileSync(SONG_ROW_PATH, 'utf8'));

test('the odd-duration chip wraps its phrase instead of forcing the row wider', () => {
	// The offender the browse arm above measures. Every other SongRow chip is a short token, so `.chip`'s
	// blanket `white-space: nowrap` is fine for them — but this one carries a whole phrase ("Longer than a
	// song"), and nowrap made its min-content width its FULL width (~230px at 200%), so it could not shrink
	// and pushed the browse page past 320px. It must be allowed to wrap, like `.chip.state` already is.
	/*
	 * S6: the chip is <Badge> now, so the claim reads in two places instead of one rule. The
	 * component must OFFER a wrapping tone, and this row must ASK for it on the phrase-carrying chip —
	 * a component that can wrap is useless if the call site does not opt in, and an opt-in is useless if
	 * the component ignores it. Checking both is what the single `.chip.odd-dur` rule used to do.
	 */
	const badge = readFileSync(join(CORE, 'src', 'lib', 'components', 'ui', 'badge', 'badge.svelte'), 'utf8');
	const wrapRule = badge.match(/\.encore-chip-wrap\s*\{([^}]*)\}/)?.[1] ?? '';
	expect(wrapRule, 'ui/badge must offer a wrapping tone').toMatch(/white-space:\s*normal/);
	expect(SONG_ROW, 'the odd-duration chip must ask for it').toMatch(/durationNote\}<Badge variant="bad" wrap>/);
});

/*
 * RETIRED WITH THE DRAWER SURFACE — `the queue sheet floors its own reflow: its children can shrink below their
 * content`. It asserted `.sheet-surface > * { min-width: 0 }` in app.css, and that rule was
 * deleted with the drawer surface it dressed.
 *
 * XR-VER-06 record. (a) The invariant: a `left:0; right:0` fixed box only honours min(max-width,
 * viewport) while its flex children CAN shrink to it — a flex child's automatic minimum is its
 * min-content width, so an unbreakable control label at 200% text sized the sheet by content it could
 * not shrink below (436px inside a 320px viewport, SC 1.4.10). (b) What left scope: `.sheet-surface`
 * and its children, the only box the rule ever applied to. (c) What covers the survivors: NOTHING
 * asserts this on the docked band, DELIBERATELY. `.cta-dock` / `.search-dock` are a flex row holding
 * ONE 44px control, not a column of unbreakable control labels, and neither declares `min-width: 0` —
 * so re-pointing this scan at them would assert a declaration that does not exist and demand
 * production CSS for a defect nobody has measured. The band's reflow is instead covered where it is
 * real: the rung-L probe arms above measure the live pages at 320 CSS px and 200% text and FAIL on an
 * overflow, which is the check that would catch it. If a future band grows a multi-control column,
 * re-add a floor for that band rather than reviving this one.
 */

test('the key row wraps and its ±semitone buttons can shrink at 200% text', () => {
	// The now-playing key control, named in the issue's offender list. It renders only under live
	// playback, which the probe cannot start — so it is pinned here rather than measured. `.key` is a
	// flex row of two `flex: 1` buttons whose label is the single unbreakable word "semitone"; at 200%
	// each is ~172px, so two-up plus the label forced the row — and the column around it — past 320px.
	// The row must be allowed to WRAP…
	const keyRule = APP_CSS.match(/\.key\s*\{([^}]*)\}/)?.[1] ?? PAGE.match(/\.key\s*\{([^}]*)\}/)?.[1] ?? '';
	expect(keyRule).toMatch(/flex-wrap:\s*wrap/);
	// …and each button must free its flex minimum so the shrink is allowed at all. A bare `flex: 1`
	// (basis 0 but min-width:auto) cannot go below the word's min-content width — the exact shape that
	// overflowed. `min-width: 0` is the load-bearing declaration.
	const keyBtnRule = PAGE.match(/\.key button\s*\{([^}]*)\}/)?.[1] ?? '';
	expect(keyBtnRule).toMatch(/min-width:\s*0/);
	// A single full-width button can still be narrower than "semitone", so the word itself must be able
	// to break — otherwise a one-per-row wrap still overflows by the width of the word minus the button.
	const keyBtnClassRule = PAGE.match(/\.key-btn\s*\{([^}]*)\}/)?.[1] ?? '';
	expect(keyBtnClassRule).toMatch(/overflow-wrap:\s*anywhere/);
});
