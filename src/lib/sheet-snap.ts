/*
 * WHERE THE NOW-PLAYING SHEET'S SNAP POINTS COME FROM. A snap point is not a size: vaul turns each into a
 * translate of (container height − snap height), so it is where the sheet's TOP EDGE lands, backwards.
 *
 * THE ARITHMETIC LIVES HERE RATHER THAN IN THE COMPONENT because it is the half that can be wrong, and a
 * rendered offset is a layout-rung claim the drawer cannot even be mounted to check (its size binding needs
 * a ResizeObserver the mount rung refuses to install). As pure functions the rules can be swept across
 * every viewport height instead of matched as a string by a source scan.
 * See docs/FRONTEND.md#shared-components.
 */

/**
 * The collapsed band strip's height, and therefore snap point 0.
 *
 * A CONSTANT as a correctness requirement — a re-measured snap 0 breaks silently against this version of
 * vaul; the component records both mechanisms. It reaches the stylesheet as `--snap-band`, so the rendered
 * strip and the snap point cannot drift.
 *
 * `.band-slot` clips at exactly this height, so the strip's own padding and this number move together or the
 * control row clips. It is also what the layout publishes as --dock-h, so every scrolling column reserves it.
 */
export const BAND_SNAP_PX = 88;

/** Snap 0 in the form vaul wants: a px string, which it parses rather than scaling by the viewport. */
export const SNAP_BAND = `${BAND_SNAP_PX}px`;

/** The most of the window the pulled-up sheet may take — a CEILING on snap 1, not its value. */
export const SNAP_OPEN_MAX = 0.82;

/**
 * How much of the window's top the pulled-up sheet must leave alone: the measured top stack plus a gap, so
 * the sheet's top edge clears the tallest page's search box rather than kissing it. A px count rather than a
 * spacing token because this is arithmetic on vaul's snap value and never reaches CSS.
 */
export const OPEN_HEADROOM_PX = 176;

/**
 * Slack added to a measured content height before it is used as a cap. The sheet's bottom padding is applied
 * to the content BOX rather than to the block whose height is measured, so a cap taken from that measurement
 * alone sits under the padding and clips the last control. Deliberately generous: over-reserving leaves a
 * little empty surface, under-reserving hides a button, and those are not the same mistake.
 */
export const OPEN_CONTENT_SLACK_PX = 56;

/**
 * Snap point 1 as the fraction of `viewportH` vaul multiplies out. Read it as a TOP EDGE, which is how the
 * rule was decided — the smaller window lets the headroom win and the sheet stops short; the taller one lets
 * the ceiling win.
 *
 * `contentH` IS A THIRD CAP, not a replacement for either: without it the sheet opens to the same fraction
 * of the window whatever is inside it, which on an idle room is a transport row above several hundred pixels
 * of empty surface — and that is the state a guest sees FIRST. Omitted or non-positive means "not measured
 * yet", and then the two viewport caps decide alone, which is the honest answer for the first paint.
 *
 * THE FLOOR is applied AFTER the cap, and that order matters: two snap points resolving to one offset makes
 * vaul's own index lookup ambiguous about which point it just landed on, and only a nearly-empty sheet can
 * get there. A non-finite or non-positive viewport has no answer, so it returns the ceiling.
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
 * Where the sheet's top edge lands at snap 1, in px — the same number `openSnapFraction` encodes, stated the
 * way it is judged. Exported because a caller that re-derived it would be re-implementing vaul's translate
 * rather than checking the rule.
 */
export function openSheetTopPx(viewportH: number, contentH?: number): number {
	return viewportH - openSnapFraction(viewportH, contentH) * viewportH;
}
