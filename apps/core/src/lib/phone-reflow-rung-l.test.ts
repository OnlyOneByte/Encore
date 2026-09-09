// guard: the XR-PH-02 reflow row has a RENDERED guard, and it cannot be quietly defanged (#850).
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
// assertion — the #850 fix's own comment names "320px" and "200%" repeatedly.
import { test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// import.meta.dir === apps/core/src/lib → two levels up to apps/core, then into e2e/.
const CORE = join(import.meta.dir, '..', '..');
const PROBE_PATH = join(CORE, 'e2e', 'probes', 'p15-phone-reflow.mjs');
const STATS_PATH = join(CORE, 'src', 'routes', 'stats', '+page.svelte');

test('the rung-L reflow probe exists and this guard is not vacuous (#850)', () => {
	// A renamed or deleted probe must red HERE, with the path in the message, rather than leaving every
	// assertion below to fail-open on an empty string.
	expect(existsSync(PROBE_PATH)).toBe(true);
	expect(readFileSync(PROBE_PATH, 'utf8').length).toBeGreaterThan(3000);
});

const PROBE = stripComments(readFileSync(PROBE_PATH, 'utf8'));

test('the reflow probe measures on the LAYOUT rung, not the mount rung (#850)', () => {
	// XR-VER-02's Check: a measurement-classified entry must import the layout-rung driver. happy-dom
	// returns an all-zero DOMRect, so the same assertions on rung M are a permanent silent green.
	expect(PROBE).toMatch(/from\s*'\.\.\/cdp\.mjs'/);
	expect(PROBE).toMatch(/\bconnect\b/);
	// And it must drive its own browser rather than assume one is listening.
	expect(PROBE).toMatch(/from\s*'\.\.\/lib\/chromium\.mjs'/);
	expect(PROBE).toMatch(/findChromium\s*\(/);
});

test('the reflow probe measures at the criterion\u2019s own numbers: 320 CSS px and 200% text (#850)', () => {
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

test('the reflow probe covers every XR-PH-02 surface, and /stats by name (#850)', () => {
	// XR-PH-02's Acceptance names `/`, `/join`, `/settings`, `/stats` and the browse screen. A probe
	// that silently stopped visiting one of them would report a green row over an unmeasured surface.
	for (const surface of ['/join', '/settings', '/stats']) {
		expect(PROBE).toContain(`measure('${surface}', '${surface}')`);
	}
	expect(PROBE).toMatch(/measure\('\/',\s*'\/'\)/);
	// The browse screen needs a session, so it is reached by joining from inside the page.
	expect(PROBE).toMatch(/measureRaw\('browse \(joined \/\)',\s*'\/'\)/);
	expect(PROBE).toMatch(/'\/api\/join'/);
});

test('the reflow probe FAILS on an overflow instead of merely reporting one (#850)', () => {
	// The distinction that matters: a driver that prints FAIL and exits 0 is a report, not a guard.
	expect(PROBE).toMatch(/process\.exit\(1\)/);
	// Exit 2 is reserved for "the environment could not host this", and must never be reached by a
	// measurement. HARNESS.md: never conflate 2 with 0.
	expect(PROBE).toMatch(/process\.exit\(2\)/);
	// An unbuilt tree serves pages with no app in them, which measure as a trivially clean 320 — the
	// probe must bail on that rather than report a pass.
	expect(PROBE).toMatch(/build['"],\s*['"]client/);
});

test('the browse-screen quarantine is rot-proofed: it reds the day its issue is fixed (#850)', () => {
	// ONE surface is quarantined, and the entry is only allowed to exist because the probe asserts the
	// defect is STILL THERE. Without that arm the entry outlives its own fix and un-enforces the
	// surface forever — which is exactly how a green suite came to sit over #850.
	expect(PROBE).toMatch(/BROWSE_QUARANTINE_ISSUE\s*=\s*857\b/);
	expect(PROBE).toMatch(/browseOver\s*>\s*0/);
	// Shrink-only: exactly one quarantined surface. A second one must be argued for here, not added
	// quietly to the probe.
	expect(PROBE.match(/BROWSE_QUARANTINE_ISSUE/g)?.length).toBeGreaterThanOrEqual(2);
});

// ---------------------------------------------------------------------------------------------------
// The #850 fix itself — pinned so a regression to a type-blind floor cannot pass unnoticed between
// probe runs. This is the cheap always-on floor beneath the probe, and is NOT a substitute for it: it
// cannot decide whether the page overflows, only whether the mechanism that stopped it is still there.
// ---------------------------------------------------------------------------------------------------

const STATS = stripComments(readFileSync(STATS_PATH, 'utf8'));

test('the /stats tile grid floors its tracks in a TYPE-RELATIVE unit, never px (#850)', () => {
	const rules = [...STATS.matchAll(/grid-template-columns:\s*([^;]+);/g)].map((m) => m[1].trim());
	// Non-vacuity: both the base rule and the phone override must be found, or the assertions below
	// are checking an empty list.
	expect(rules.length).toBeGreaterThanOrEqual(2);
	for (const rule of rules) {
		// A px floor is fixed while the word it has to hold grows with the guest's text-size setting,
		// so at 200% it stops bounding anything and the row overflows instead of reflowing.
		expect(rule).not.toMatch(/minmax\(\s*[\d.]+px/);
		// A fixed track count cannot give way at all — `1fr 1fr` is the exact shape that shipped #850.
		expect(rule).toMatch(/repeat\(\s*auto-fit/);
		expect(rule).toMatch(/[\d.]em\b/);
		// And the floor must be bounded by the row, or a floor wider than the viewport becomes the
		// overflow itself — the same defect one level up.
		expect(rule).toMatch(/min\(\s*100%/);
	}
});
