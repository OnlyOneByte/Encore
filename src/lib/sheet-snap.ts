/*
 * WHERE THE NOW-PLAYING SHEET'S SNAP POINTS COME FROM.
 *
 * `NowPlayingDrawer` is one vaul drawer at two heights: snap 0 is the collapsed band strip, snap 1 is
 * the sheet pulled up. vaul turns each snap point into a translate of `containerHeight - snapHeight`,
 * so a snap point is not a size — it is where the sheet's TOP EDGE lands, expressed backwards.
 *
 * IT LIVES HERE RATHER THAN IN THE COMPONENT BECAUSE IT IS THE PART THAT CAN BE WRONG. Snap 1 used to
 * be a flat `0.82` and the defect it caused was purely arithmetic: 18% of the window is 162px on a
 * 900px-tall one and 126px on a 700px one, while the page's own top-of-page controls do not shrink with
 * the window (on `/find` the search box sits at 115–159px at both heights). So the sheet cleared the box
 * by three pixels at 900 and covered it at 700 — `document.elementFromPoint` at the input's centre
 * returned a `<span>` from inside the sheet, and the click never reached the input.
 *
 * A rendered offset is a LAYOUT-rung claim (XR-VER-01) and cannot be measured on the mount rung — the
 * drawer cannot even mount there, because its own `bind:clientHeight` needs a `ResizeObserver` the rung
 * refuses to install. Pulling the arithmetic out as a pure function moves the half that decides whether
 * the bug is fixed onto a rung that CAN sweep every viewport height, instead of leaving it as a formula
 * a source-scanning guard could only match as a string.
 */

/**
 * The collapsed band strip's height, and therefore snap point 0.
 *
 * A CONSTANT, and that is a correctness requirement rather than a simplification — see the component,
 * which records both mechanisms in this version of vaul that a re-measured snap 0 breaks silently. It
 * reaches the stylesheet as `--snap-band` so the rendered strip and the snap point cannot drift.
 */
export const BAND_SNAP_PX = 80;

/** Snap 0 in the form vaul wants: a px string, which it parses rather than scaling by the viewport. */
export const SNAP_BAND = `${BAND_SNAP_PX}px`;

/**
 * The most of the window the pulled-up sheet may ever take — a CEILING on snap 1, not its value.
 *
 * This was snap 1 outright. It survives as the ceiling because on a tall window it is the binding
 * constraint and the sheet should not grow without limit: 18% of a 1400px window is 252px of headroom,
 * comfortably more than any page's top controls need.
 */
export const SNAP_OPEN_MAX = 0.82;

/**
 * How much of the window's top the pulled-up sheet must leave alone.
 *
 * THE MEASURED TOP STACK PLUS A GAP, not a guess: `PageHeader` plus `/find`'s search box ends at 159px,
 * and 176px is the next multiple of `--tap` (44px) above it, so the sheet's top edge clears the box by
 * 17px instead of kissing it. A px count rather than a spacing token because this is arithmetic on
 * vaul's snap value and never reaches CSS.
 */
export const OPEN_HEADROOM_PX = 176;

/**
 * Snap point 1 — the pulled-up sheet — as the fraction of `viewportH` vaul multiplies out.
 *
 * Read it as a TOP EDGE, which is the way the rule was decided: the sheet's top lands at
 * `max(OPEN_HEADROOM_PX, (1 - SNAP_OPEN_MAX) * viewportH)`. Below roughly 977px tall the headroom wins
 * and the sheet stops short; above it the ceiling wins and nothing about the old behaviour changes.
 *
 * THE FLOOR (`2 * BAND_SNAP_PX`) is degenerate-window insurance rather than a design position. Below
 * ~336px tall the headroom term would ask for a sheet SHORTER than the band it expands from, and two
 * snap points resolving to one offset makes vaul's own `snapToPoint` lookup — `findIndex` over the
 * offsets — ambiguous about which point it just landed on. No real viewport reaches it.
 *
 * A non-finite or non-positive height (server-side, or before the first measurement) has no answer, so
 * it returns the ceiling: the value snap 1 had before this clamp existed.
 */
export function openSnapFraction(viewportH: number): number {
	if (!Number.isFinite(viewportH) || viewportH <= 0) return SNAP_OPEN_MAX;
	const openPx = Math.max(Math.min(SNAP_OPEN_MAX * viewportH, viewportH - OPEN_HEADROOM_PX), 2 * BAND_SNAP_PX);
	return openPx / viewportH;
}

/**
 * Where the sheet's top edge lands at snap 1, in px from the top of the window.
 *
 * The same number `openSnapFraction` encodes, stated the way it is judged — which is what every
 * assertion about "the sheet must not cover the page's top controls" actually wants to read. Exported
 * because a guard that re-derived `vh - fraction * vh` for itself would be re-implementing vaul's
 * translate rather than checking the rule.
 */
export function openSheetTopPx(viewportH: number): number {
	return viewportH - openSnapFraction(viewportH) * viewportH;
}
