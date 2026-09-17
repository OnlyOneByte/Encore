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
 * Slack added to a measured content height before it is used as a cap.
 *
 * The sheet's own bottom padding is `env(safe-area-inset-bottom) + var(--space-lg)` — 12px on a laptop,
 * up to ~46px on a notched phone — and it is applied to the content box rather than to the block whose
 * height is measured, so a cap taken from that measurement alone would sit UNDER the sheet's own padding
 * and clip the last control. This is deliberately generous: over-reserving leaves a little empty surface
 * at the bottom of a short sheet, under-reserving hides a button, and those are not the same mistake.
 */
export const OPEN_CONTENT_SLACK_PX = 56;

/**
 * Snap point 1 — the pulled-up sheet — as the fraction of `viewportH` vaul multiplies out.
 *
 * Read it as a TOP EDGE, which is the way the rule was decided: the sheet's top lands at
 * `max(OPEN_HEADROOM_PX, (1 - SNAP_OPEN_MAX) * viewportH)`. Below roughly 977px tall the headroom wins
 * and the sheet stops short; above it the ceiling wins and nothing about the old behaviour changes.
 *
 * ── AND IT NEVER EXCEEDS ITS OWN CONTENT (`contentH`) ─────────────────────────────────────────────
 *
 * `contentH` is the sheet's natural height — what its children actually occupy — and it is a THIRD cap
 * rather than a replacement for either of the others. Without it the sheet always opened to the same
 * fraction of the window whatever was inside it, and with nothing playing that is a transport row and
 * ~600px of empty surface on a 844px phone: measured at 390x844, content top 176 with the last control
 * ending around 330. A sheet that opens to five times its content reads as a broken screen, and it is the
 * state a guest sees FIRST, before anyone has queued anything.
 *
 * When a song is playing the body carries the head, the seek row, the transport, the ± keycaps, the range
 * bar and the guiding track, so this term is larger than the fraction and the ceiling binds exactly as
 * before. The cap only bites on the short sheet, which is the case that was wrong.
 *
 * Omitted (or non-finite, or non-positive) means "not measured yet", and then the two viewport caps decide
 * alone — the behaviour this function had before the term existed. That is the honest answer for the first
 * paint and for the server, where no child has a height.
 *
 * THE FLOOR (`2 * BAND_SNAP_PX`) is degenerate-window insurance rather than a design position, and it also
 * protects the new term: a sheet may not be capped SHORTER than twice the band it expands from. Below
 * ~336px tall the headroom term asks for the same thing, and two snap points resolving to one offset makes
 * vaul's own `snapToPoint` lookup — `findIndex` over the offsets — ambiguous about which point it just
 * landed on. No real viewport reaches it; a nearly-empty sheet now can, which is why the floor is applied
 * after the cap rather than before.
 *
 * A non-finite or non-positive height (server-side, or before the first measurement) has no answer, so
 * it returns the ceiling: the value snap 1 had before this clamp existed.
 */
export function openSnapFraction(viewportH: number, contentH?: number): number {
	if (!Number.isFinite(viewportH) || viewportH <= 0) return SNAP_OPEN_MAX;
	const measured = Number.isFinite(contentH) && (contentH as number) > 0 ? (contentH as number) : Infinity;
	const openPx = Math.max(
		Math.min(SNAP_OPEN_MAX * viewportH, viewportH - OPEN_HEADROOM_PX, measured),
		2 * BAND_SNAP_PX
	);
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
export function openSheetTopPx(viewportH: number, contentH?: number): number {
	return viewportH - openSnapFraction(viewportH, contentH) * viewportH;
}
