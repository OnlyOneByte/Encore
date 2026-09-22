/*
 * ── THE PULLED-UP SHEET MUST NOT COVER THE PAGE UNDERNEATH IT ─────────────────────────────────────
 *
 * Reported as "I can't type in the song search bar and I can't even see the cursor", which turned out to
 * be two independent defects with one symptom. This file guards the GEOMETRY half; the focus half is
 * `np-drawer-focus.test.ts`.
 *
 * Snap 1 was a flat `0.82`, so the sheet's top edge landed at 18% of the window — 162px on a 900px-tall
 * window, 126px on a 700px one. The page's own top-of-page controls do NOT shrink with the window: on
 * `/find`, `PageHeader` plus the search box ends at 159px at both heights. So the sheet cleared the box
 * by three pixels at 900 and sat on top of it at 700, and since the sheet is `position: fixed`, covering
 * is the whole of it — measured, `document.elementFromPoint` at the input's centre returned a `<span>`
 * from inside the sheet and the click was refused as intercepted.
 *
 * WHY THIS IS A UNIT SWEEP AND NOT A RENDERED ARM. A translate offset is a LAYOUT-rung claim
 *, and `NowPlayingDrawer` cannot be mounted on the rung below it at all — its own
 * `bind:clientHeight` needs a `ResizeObserver` this rung refuses to install (see the boundary arm in
 * `hero-live-controls.test.ts`). Left inline in the component, the clamp could only have been
 * guarded as a STRING. Pulled out as a pure function it is checked at every height instead, including
 * the ones nobody would think to open a browser at — which is the entire failure mode here: the flat
 * fraction was *correct at the height it was developed on*.
 */
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
 * Every window height worth sweeping, and the two REGRESSION heights are named rather than generated so
 * a red says which one broke: 900 is where the old fraction cleared the box by three pixels and 700 is
 * where it covered it. The rest walk the real range — a landscape phone through a 4K desktop — plus the
 * ceiling's own crossover at ~977px, which is the only place the rule changes which term binds.
 */
const HEIGHTS = [360, 500, 600, 667, 700, 740, 800, 844, 900, 932, 976, 977, 1000, 1100, 1400, 2160];

/**
 * The tallest top-of-page control stack any phone surface renders, measured on `/find` at both 900 and
 * 700 — `PageHeader` plus the search box, ending at 159px. This is what the headroom exists to clear, so
 * it is stated as its own number rather than folded into `OPEN_HEADROOM_PX`: the guard's claim is "the
 * sheet clears the measured stack", and the token is only one way of achieving it.
 */
const MEASURED_TOP_STACK_PX = 159;

test('the pulled-up sheet clears the page\u2019s top-of-page controls at EVERY window height', () => {
	// Not vacuous: the sweep really runs, and it really spans the two heights the defect was measured at.
	expect(HEIGHTS).toContain(900);
	expect(HEIGHTS).toContain(700);
	expect(HEIGHTS.length).toBeGreaterThanOrEqual(12);

	for (const vh of HEIGHTS) {
		const top = openSheetTopPx(vh);
		expect(top, `sheet top at vh=${vh}`).toBeGreaterThan(MEASURED_TOP_STACK_PX);
		// …and the rule it comes from, stated the way it was decided: the top edge is the headroom or the
		// ceiling's 18%, whichever is further down. Asserted as the SAME number so the two statements of
		// the rule cannot drift apart.
		expect(top, `rule at vh=${vh}`).toBeCloseTo(Math.max(OPEN_HEADROOM_PX, (1 - SNAP_OPEN_MAX) * vh), 6);
	}

	/*
	 * THE OLD BEHAVIOUR, PINNED AS THE THING THAT CHANGED. A flat `0.82` is what shipped, so the arm is
	 * only meaningful if that value would FAIL it — otherwise the clamp could be deleted and this file
	 * would stay green. At 700 the flat fraction puts the top at 126px, inside the search box's 115–159.
	 */
	expect((1 - SNAP_OPEN_MAX) * 700).toBeLessThan(MEASURED_TOP_STACK_PX);
	expect(openSheetTopPx(700)).toBeGreaterThan(MEASURED_TOP_STACK_PX);
});

test('the clamp only ever makes the sheet SHORTER, and never shorter than an expansion of the band', () => {
	for (const vh of HEIGHTS) {
		const f = openSnapFraction(vh);
		// The ceiling is a ceiling: no height may buy a sheet taller than the 82% that shipped.
		expect(f, `fraction at vh=${vh}`).toBeLessThanOrEqual(SNAP_OPEN_MAX);
		// And snap 1 stays a real EXPANSION of snap 0 — two snap points resolving to one offset makes
		// vaul's own `snapToPoint` lookup (`findIndex` over the offsets) ambiguous about where it landed.
		expect(f * vh, `open height at vh=${vh}`).toBeGreaterThan(BAND_SNAP_PX);
	}
	// On a tall window the ceiling is what binds, so nothing about the pre-clamp behaviour changed there.
	expect(openSnapFraction(2160)).toBeCloseTo(SNAP_OPEN_MAX, 6);
	// The crossover is where the terms swap, and it is the ceiling's own arithmetic rather than a tuned
	// number: below it the headroom binds, above it the fraction does.
	expect(openSheetTopPx(976)).toBeCloseTo(OPEN_HEADROOM_PX, 6);
	expect(openSheetTopPx(1000)).toBeGreaterThan(OPEN_HEADROOM_PX);
});

test('a height that is not a measurement yields the pre-clamp ceiling rather than a broken sheet', () => {
	/*
	 * `viewportH` is `$state(0)` in the component until `onMount` writes it, because this component is
	 * server-rendered. Every one of these would otherwise produce a fraction that is negative, zero or
	 * NaN — and a NaN snap point is the silent-failure shape this drawer has already been bitten by
	 * twice (see the component's own notes on vaul's null-unguarded `snapToPoint`).
	 */
	for (const bad of [0, -1, -900, Number.NaN, Number.POSITIVE_INFINITY]) {
		expect(openSnapFraction(bad), `fraction at vh=${bad}`).toBe(SNAP_OPEN_MAX);
	}
	// The floor covers the other end: a window too short for the headroom still gets a usable sheet
	// rather than one that inverts. No real viewport reaches it; the arm is here so a future change to
	// OPEN_HEADROOM_PX cannot quietly produce a negative fraction.
	expect(openSnapFraction(200)).toBeGreaterThan(0);
	expect(openSnapFraction(200) * 200).toBeGreaterThan(BAND_SNAP_PX);
});

/*
 * ── THE CONTENT CAP ──────────────────────────────────────────────────────────────────────────────
 *
 * Snap 1 used to be a fraction of the WINDOW whatever was inside the sheet, so with nothing playing it
 * opened to a transport row plus ~600px of empty surface on a 390x844 phone — measured: content top 176,
 * last control ending near 330. That is the first state a guest ever sees the sheet in, before anyone has
 * queued anything, and a sheet that opens to five times its content reads as a broken screen.
 *
 * The cap is a THIRD term beside the ceiling and the headroom, and these arms pin what it must not break:
 * it may only ever shorten, it may never shorten past the floor, and an unmeasured content height must
 * leave the old behaviour exactly as it was.
 */
test('the sheet never opens taller than its own content', () => {
	const vh = 844;
	// A short sheet: the band row plus an idle head and transport, plus the slack for its bottom padding.
	const shortContent = 260;
	expect(openSheetTopPx(vh, shortContent)).toBeCloseTo(vh - shortContent, 6);
	// …and that really is the case the defect was about: the uncapped sheet is far taller.
	expect(openSnapFraction(vh) * vh).toBeGreaterThan(shortContent * 2);
});

test('a full sheet is unaffected — the viewport caps still bind when the content is tall', () => {
	for (const vh of HEIGHTS) {
		// Taller than any window in the sweep, which is the playing case: head, seek row, transport, the ±
		// keycaps, the range bar and the guiding track.
		const tall = vh * 2;
		expect(openSnapFraction(vh, tall), `tall content at vh=${vh}`).toBeCloseTo(openSnapFraction(vh), 6);
	}
});

test('the content cap only ever SHORTENS the sheet, and never past the floor', () => {
	for (const vh of HEIGHTS) {
		for (const contentH of [1, 40, 120, 300, 700, 5000]) {
			const capped = openSnapFraction(vh, contentH);
			// Never taller than the uncapped answer: this is a cap, not a size.
			expect(capped, `cap at vh=${vh} content=${contentH}`).toBeLessThanOrEqual(openSnapFraction(vh) + 1e-9);
			// Never a sheet that fails to expand past the band — the ambiguous-offset hazard the floor exists
			// for, which a tiny content height can now reach where no real viewport could.
			expect(capped * vh, `floor at vh=${vh} content=${contentH}`).toBeGreaterThan(BAND_SNAP_PX);
		}
	}
});

test('an unmeasured content height changes nothing', () => {
	/*
	 * `fitH` is `$state(0)` until the first `bind:clientHeight` lands, and this component is
	 * server-rendered — so "not measured" is a real state on every first paint, not an edge case. It must
	 * resolve to the pre-cap answer rather than to a floor-height sheet.
	 */
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
	/*
	 * Snap 0 must not be re-measured, and the component records why against this version of vaul: the
	 * seat is written by a lazy `watch` that never retries, and the lookup is strict equality on the
	 * string. This arm is what stops the two values being "tidied" into the same shape — snap 1 moves,
	 * snap 0 must not, and they are deliberately not symmetrical.
	 */
	expect(SNAP_BAND).toBe(`${BAND_SNAP_PX}px`);
	expect(typeof SNAP_BAND).toBe('string');
	expect(SNAP_BAND).toBe('88px');
});
