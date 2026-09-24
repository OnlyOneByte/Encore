/*
 * WHERE THE NOW-PLAYING SHEET'S SNAP POINTS COME FROM. A snap point is not a size: vaul turns each into a translate
 * of (container height − snap height), so it is where the sheet's TOP EDGE lands, backwards. The arithmetic lives
 * here because it is the half that can be wrong and the drawer cannot be mounted to check it (its size binding needs
 * a ResizeObserver the mount rung refuses). See docs/FRONTEND.md#shared-components.
 */

/**
 * The collapsed band strip's height, and therefore snap point 0. A CONSTANT as a correctness requirement — a
 * re-measured snap 0 breaks silently against this version of vaul. It reaches the stylesheet as `--snap-band`, and
 * `.band-slot` clips at exactly this height, so the strip's own padding and this number move together.
 */
export const BAND_SNAP_PX = 88;

/** Snap 0 in the form vaul wants: a px string, which it parses rather than scaling by the viewport. */
export const SNAP_BAND = `${BAND_SNAP_PX}px`;

/** The most of the window the pulled-up sheet may take — a CEILING on snap 1, not its value. */
export const SNAP_OPEN_MAX = 0.82;

/**
 * How much of the window's top the pulled-up sheet must leave alone: the measured top stack plus a gap. A px count
 * rather than a spacing token, because this is arithmetic on vaul's snap value and never reaches CSS.
 */
export const OPEN_HEADROOM_PX = 176;

/**
 * Slack added to a measured content height before it is used as a cap: the sheet's bottom padding is applied to the
 * content BOX rather than to the block whose height is measured, so a cap from that measurement alone clips the last
 * control. Deliberately generous — over-reserving leaves empty surface, under-reserving hides a button.
 */
export const OPEN_CONTENT_SLACK_PX = 56;

/**
 * Snap point 1 as the fraction of `viewportH` vaul multiplies out. Read it as a TOP EDGE: the smaller window lets
 * the headroom win and the sheet stops short, the taller one lets the ceiling win. `contentH` IS A THIRD CAP, not a
 * replacement for either — without it an idle room's sheet is a transport row above hundreds of pixels of empty
 * surface. Omitted or non-positive means "not measured yet". THE FLOOR is applied AFTER the cap, and that order
 * matters: two snap points resolving to one offset makes vaul's own index lookup ambiguous.
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
 * Where the sheet's top edge lands at snap 1, in px — the same number `openSnapFraction` encodes, stated the way it
 * is judged. Exported because a caller that re-derived it would be re-implementing vaul's translate.
 */
export function openSheetTopPx(viewportH: number, contentH?: number): number {
	return viewportH - openSnapFraction(viewportH, contentH) * viewportH;
}
