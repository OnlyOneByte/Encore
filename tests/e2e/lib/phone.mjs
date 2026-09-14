/*
 * The phone's post-join step, in ONE place.
 *
 * WHY THIS FILE EXISTS. The phone's information architecture has moved three times now: `?browse=1`,
 * then a box docked on home at all times, and now a `/find` ROUTE reached from the band's magnifier.
 * Roughly twenty driver and probe call sites reach search, and this file is why the third move cost one
 * function instead of twenty edits. It has paid for itself twice, which is the argument for keeping the
 * indirection even though a single call site would read more plainly.
 *
 * Reaching search is a CLICK AND A NAVIGATION again — closer to the `?browse=1` era than to the docked
 * box, but by a different mechanism: a route, so the phone's own back gesture is the way back and the
 * surface is shareable.
 *
 * The selectors live in the contract; every driver calls this.
 */
import { SEL } from '../contract.ts';

/** Default wait, matching the drivers' own 15s ceiling for a first paint after a navigation. */
const DEFAULT_TIMEOUT = 15_000;

/**
 * From the JOINED home screen, reach the search box.
 *
 * Search is its own route now, so this waits for the band (`homeReady`), taps its magnifier, and waits
 * for the find surface's box. The band is app chrome mounted by the layout, which is why it is the
 * readiness signal rather than anything `/` itself renders.
 *
 * The name is retained (not renamed to something like `reachSearch`) so the ~20 existing call sites keep
 * working; the browse MODE it once opened is gone.
 *
 * @param {{ waitFor: (expr: string, opts?: { timeout?: number }) => Promise<unknown>,
 *           click: (selector: string) => Promise<unknown> }} page
 * @param {{ timeout?: number }} [opts]
 */
export async function openBrowseFromHome(page, { timeout = DEFAULT_TIMEOUT } = {}) {
	/** @param {string} sel */
	const has = (sel) => `document.querySelector(${JSON.stringify(sel)}) !== null`;
	// Already on the find surface? Do nothing. Cheap, and it makes the helper safe to call defensively.
	const alreadyThere = await page.waitFor(has(SEL.findBox), { timeout: 250 }).catch(() => false);
	if (alreadyThere) return;

	// The band is what says the joined app has painted — the layout mounts it on every phone surface,
	// so it is a stabler readiness signal than anything a single route renders.
	await page.waitFor(has(SEL.homeReady), { timeout });
	// Built from the contract's own accessible name rather than a second hard-coded string, so this
	// button can only be addressed by the name a screen reader announces for it.
	await page.click(`${SEL.homeReady} button[aria-label="${SEL.bandSearch.name}"]`);
	// Two distinct waits: the surface arriving, then the control on it. A driver can tell "the
	// navigation never happened" from "it happened and the box never rendered".
	await page.waitFor(has(SEL.findBox), { timeout });
	await page.waitFor(has(SEL.search), { timeout });
}

/**
 * The other direction: from a search that is showing RESULTS back to the QUEUE, which is home.
 *
 * The rotation rows, the position line and the transport are all on home — a driver that
 * searched and then counted `.qrow` was reading the results view, where the rotation is not rendered.
 * there is no browse mode to leave: the "← Queue" control (`backToQueue`) CLEARS the search,
 * and clearing it brings the queue back in place. This clicks it only when the hero is not already
 * showing (an empty box already shows the queue), so it is the mirror of `openBrowseFromHome`.
 *
 * @param {{ waitFor: (expr: string, opts?: { timeout?: number }) => Promise<unknown>,
 *           click: (selector: string) => Promise<unknown> }} page
 * @param {{ timeout?: number }} [opts]
 */
export async function returnHomeFromBrowse(page, { timeout = DEFAULT_TIMEOUT } = {}) {
	/** @param {string} sel */
	const has = (sel) => `document.querySelector(${JSON.stringify(sel)}) !== null`;
	// Already home? The hero only renders on `/`.
	const alreadyHome = await page.waitFor(has(SEL.hero), { timeout: 250 }).catch(() => false);
	if (alreadyHome) return;

	// A real navigation now, not a state clear: the header's back control is an <a href="/">, so this
	// exercises the same route change the phone's own back gesture performs.
	await page.click(SEL.backToQueue);
	await page.waitFor(has(SEL.hero), { timeout });
}

/**
 * The expression form, for a driver that polls its own condition inside one `evaluate` — p8 checks
 * "am I joined yet?" that way rather than with a `waitFor`, and it needs a JOINED test that does not
 * depend on which screen the guest is on.
 *
 * Returns a JS expression string that is true once the joined home has rendered. Use this instead of
 * testing for the search box: search is on the browse screen now, so it says "browsing", not "joined".
 */
export function joinedExpression() {
	return `location.pathname === '/' && document.querySelector(${JSON.stringify(SEL.homeReady)}) !== null`;
}
