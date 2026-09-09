/*
 * The phone's post-join step, in ONE place.
 *
 * WHY THIS FILE EXISTS. Direction A (#832) made the room's queue the home screen; the 2026-09-09 owner
 * correction (#902) then docked the search box at the bottom of it AT ALL TIMES and deleted the
 * `+ Add a turn` push. So the search box is on `/` again — but fifteen driver and probe call sites had
 * baked in the intermediate `?browse=1` assumption, and rather than edit all of them twice, the
 * sequence lives here: reaching the search box is now just waiting for it, no click. The next IA change
 * edits this one function, not fifteen call sites.
 *
 * The selectors live in the contract; every driver calls this.
 */
import { SEL } from '../contract.ts';

/** Default wait, matching the drivers' own 15s ceiling for a first paint after a navigation. */
const DEFAULT_TIMEOUT = 15_000;

/**
 * From the JOINED home screen, reach the search box.
 *
 * Since #902 the box is docked on home unconditionally, so there is nothing to click and no navigation:
 * this waits for the joined home to render (`homeReady`, the docked band) and then for the box itself
 * (`search`). The two waits are kept distinct so a driver can tell "home never rendered" from "the box
 * never appeared", even though today the band and the box arrive together.
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
	// Already showing the box? Do nothing. Cheap, and it makes the helper safe to call defensively.
	const alreadyThere = await page.waitFor(has(SEL.search), { timeout: 250 }).catch(() => false);
	if (alreadyThere) return;

	await page.waitFor(has(SEL.homeReady), { timeout });
	await page.waitFor(has(SEL.search), { timeout });
}

/**
 * The other direction: from a search that is showing RESULTS back to the QUEUE, which is home.
 *
 * The rotation rows, the position line and the transport are all on home since #832 — a driver that
 * searched and then counted `.qrow` was reading the results view, where the rotation is not rendered.
 * Since #902 there is no browse mode to leave: the "← Queue" control (`backToQueue`) CLEARS the search,
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
	// Already home? The hero only renders there (i.e. with an empty box).
	const alreadyHome = await page.waitFor(has(SEL.hero), { timeout: 250 }).catch(() => false);
	if (alreadyHome) return;

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
