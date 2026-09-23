// THE PULLED-UP SHEET MUST NOT COVER THE PAGE UNDERNEATH IT — the geometry half; the focus half is
// `np-drawer-focus.test.ts`.
//
// A flat `0.82` snap puts the top edge at 18% of the window: 162px at 900 tall, 126px at 700. The page's top-of-page
// controls do NOT shrink with the window (top bar plus search box ends at 159px at both), so a flat fraction clears the
// box by 3px at 900 and covers it at 700 — and the sheet is `position: fixed`, so covering means the click is refused
// as intercepted.
//
// A SWEEP over a pure function rather than a rendered arm, because the flat fraction was correct at the height it was
// developed on: every height is checked, including ones nobody would open a browser at. `NowPlayingDrawer` cannot be
// mounted on this rung anyway — its `bind:clientHeight` needs a `ResizeObserver` the rung refuses to install.
import { expect, test } from 'bun:test';
import {
	BAND_SNAP_PX,
	OPEN_HEADROOM_PX,
	SNAP_BAND,
	SNAP_OPEN_MAX,
	openSheetTopPx,
	openSnapFraction
} from '$lib/sheet-snap';

/**
 * The two REGRESSION heights are NAMED rather than generated, so a red says which broke: 900 cleared the box by 3px, 700
 * covered it. The rest walk a landscape phone to a 4K desktop, plus the ~977px crossover where the binding term changes.
 */
const HEIGHTS = [360, 500, 600, 667, 700, 740, 800, 844, 900, 932, 976, 977, 1000, 1100, 1400, 2160];

/**
 * The tallest top-of-page control stack any phone surface renders — `PageHeader` plus the search box, ending at 159px.
 * Its own number rather than folded into `OPEN_HEADROOM_PX`: the claim is "the sheet clears the measured stack".
 */
const MEASURED_TOP_STACK_PX = 159;

test('the pulled-up sheet clears the page\u2019s top-of-page controls at EVERY window height', () => {
	// Non-vacuity: the sweep runs, and spans the two heights the defect was measured at.
	expect(HEIGHTS).toContain(900);
	expect(HEIGHTS).toContain(700);
	expect(HEIGHTS.length).toBeGreaterThanOrEqual(12);

	for (const vh of HEIGHTS) {
		const top = openSheetTopPx(vh);
		expect(top, `sheet top at vh=${vh}`).toBeGreaterThan(MEASURED_TOP_STACK_PX);
		// The rule: the top edge is the headroom or the ceiling's 18%, whichever is further down — asserted as the SAME
		// number so the two statements of it cannot drift apart.
		expect(top, `rule at vh=${vh}`).toBeCloseTo(Math.max(OPEN_HEADROOM_PX, (1 - SNAP_OPEN_MAX) * vh), 6);
	}

	// Only meaningful if a flat `0.82` would FAIL it, or the clamp could be deleted and this file stay green: at 700 a
	// flat fraction puts the top at 126px, inside the box's 115–159.
	expect((1 - SNAP_OPEN_MAX) * 700).toBeLessThan(MEASURED_TOP_STACK_PX);
	expect(openSheetTopPx(700)).toBeGreaterThan(MEASURED_TOP_STACK_PX);
});

test('the clamp only ever makes the sheet SHORTER, and never shorter than an expansion of the band', () => {
	for (const vh of HEIGHTS) {
		const f = openSnapFraction(vh);
		// The ceiling is a ceiling: no height may buy a sheet taller than the 82% that shipped.
		expect(f, `fraction at vh=${vh}`).toBeLessThanOrEqual(SNAP_OPEN_MAX);
		// snap 1 stays a real EXPANSION of snap 0: two snap points resolving to one offset make vaul's `snapToPoint`
		// lookup (a findIndex over the offsets) ambiguous about where it landed.
		expect(f * vh, `open height at vh=${vh}`).toBeGreaterThan(BAND_SNAP_PX);
	}
	// On a tall window the ceiling binds, so the clamp is a no-op there.
	expect(openSnapFraction(2160)).toBeCloseTo(SNAP_OPEN_MAX, 6);
	// The crossover is the ceiling's own arithmetic, not a tuned number: below it the headroom binds, above it the
	// fraction does.
	expect(openSheetTopPx(976)).toBeCloseTo(OPEN_HEADROOM_PX, 6);
	expect(openSheetTopPx(1000)).toBeGreaterThan(OPEN_HEADROOM_PX);
});

test('a height that is not a measurement yields the pre-clamp ceiling rather than a broken sheet', () => {
	// `viewportH` is `$state(0)` until `onMount` writes it and the component is server-rendered, so these inputs are
	// real. Each would otherwise yield a negative, zero or NaN fraction, and a NaN snap point is a SILENT failure
	// through vaul's null-unguarded `snapToPoint`.
	for (const bad of [0, -1, -900, Number.NaN, Number.POSITIVE_INFINITY]) {
		expect(openSnapFraction(bad), `fraction at vh=${bad}`).toBe(SNAP_OPEN_MAX);
	}
	// The floor covers the other end: a window too short for the headroom gets a usable sheet, not an inverted one. No
	// real viewport reaches it — the arm exists so a change to OPEN_HEADROOM_PX cannot quietly go negative.
	expect(openSnapFraction(200)).toBeGreaterThan(0);
	expect(openSnapFraction(200) * 200).toBeGreaterThan(BAND_SNAP_PX);
});

// THE CONTENT CAP — a THIRD term beside the ceiling and the headroom. A snap that is a fraction of the WINDOW
// regardless of content opens to a transport row plus ~600px of empty surface on a 390x844 phone, which is the first
// state a guest sees before anything is queued and reads as a broken screen.
//
// The cap may only ever SHORTEN, never past the floor, and an unmeasured content height must leave the uncapped answer
// untouched.
test('the sheet never opens taller than its own content', () => {
	const vh = 844;
	// A short sheet: band row, idle head, transport, plus slack for its bottom padding.
	const shortContent = 260;
	expect(openSheetTopPx(vh, shortContent)).toBeCloseTo(vh - shortContent, 6);
	// Non-vacuity: the uncapped sheet really is far taller.
	expect(openSnapFraction(vh) * vh).toBeGreaterThan(shortContent * 2);
});

test('a full sheet is unaffected — the viewport caps still bind when the content is tall', () => {
	for (const vh of HEIGHTS) {
		// Taller than any window in the sweep — the playing case: head, seek row, transport, ± keycaps, range, guide.
		const tall = vh * 2;
		expect(openSnapFraction(vh, tall), `tall content at vh=${vh}`).toBeCloseTo(openSnapFraction(vh), 6);
	}
});

test('the content cap only ever SHORTENS the sheet, and never past the floor', () => {
	for (const vh of HEIGHTS) {
		for (const contentH of [1, 40, 120, 300, 700, 5000]) {
			const capped = openSnapFraction(vh, contentH);
			// Never taller than the uncapped answer — a cap, not a size.
			expect(capped, `cap at vh=${vh} content=${contentH}`).toBeLessThanOrEqual(openSnapFraction(vh) + 1e-9);
			// Never a sheet that fails to expand past the band: a tiny content height reaches the ambiguous-offset hazard
			// where no real viewport could.
			expect(capped * vh, `floor at vh=${vh} content=${contentH}`).toBeGreaterThan(BAND_SNAP_PX);
		}
	}
});

test('an unmeasured content height changes nothing', () => {
	// `fitH` is `$state(0)` until the first `bind:clientHeight` lands and the component is server-rendered, so "not
	// measured" happens on every first paint. It must resolve to the pre-cap answer, not a floor-height sheet.
	for (const vh of HEIGHTS) {
		for (const unmeasured of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(openSnapFraction(vh, unmeasured as number | undefined), `vh=${vh} content=${unmeasured}`).toBeCloseTo(
				openSnapFraction(vh),
				6
			);
		}
	}
});

test('snap 0 is still a CONSTANT px string, which is the correctness requirement snap 1 is not', () => {
	// Snap 0 must NOT be re-measured: vaul writes the seat from a lazy `watch` that never retries and looks it up by
	// strict string equality. The two are deliberately asymmetrical — snap 1 moves, snap 0 does not — so they must not
	// be "tidied" into the same shape.
	expect(SNAP_BAND).toBe(`${BAND_SNAP_PX}px`);
	expect(typeof SNAP_BAND).toBe('string');
	expect(SNAP_BAND).toBe('88px');
});
