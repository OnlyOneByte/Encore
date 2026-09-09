/*
 * The phone's post-join step, in ONE place.
 *
 * WHY THIS FILE EXISTS. Direction A (#832) made the room's queue the home screen and put searching
 * behind a primary button, so the search box is no longer on `/`. Fifteen driver and probe call sites
 * had the old assumption baked in — `waitFor(SEL.search)` immediately after joining — and every one of
 * them now times out at its first step. Fixing that by hand fifteen times is how they drift apart: the
 * next IA change would have to find all fifteen again, and the driven probes are this repo's only
 * rendered-behaviour guards, so a dozen of them failing to reach step one is a guard that never fires.
 *
 * So the sequence lives here, the selectors live in the contract, and every driver calls this.
 */
import { SEL } from '../contract.ts';

/** Default wait, matching the drivers' own 15s ceiling for a first paint after a navigation. */
const DEFAULT_TIMEOUT = 15_000;

/**
 * From the JOINED home screen, reach the browse screen and wait for the search box.
 *
 * Three steps, in order, because each one can fail differently and a driver needs to know which:
 * home rendered (the docked band exists), the push happened (the button was clicked), the browse
 * screen is up (the search box exists). A single combined wait would report "search never appeared"
 * for all three causes.
 *
 * Idempotent-ish by design: when the search box is ALREADY on screen — the caller is on `?browse=1`
 * already, or came back to it — this returns immediately without navigating, so a probe that calls it
 * twice does not bounce the guest between screens.
 *
 * @param {{ waitFor: (expr: string, opts?: { timeout?: number }) => Promise<unknown>,
 *           click: (selector: string) => Promise<unknown> }} page
 * @param {{ timeout?: number }} [opts]
 */
export async function openBrowseFromHome(page, { timeout = DEFAULT_TIMEOUT } = {}) {
	/** @param {string} sel */
	const has = (sel) => `document.querySelector(${JSON.stringify(sel)}) !== null`;
	// Already there? Do nothing. Cheap, and it makes the helper safe to call defensively.
	const alreadyBrowsing = await page.waitFor(has(SEL.search), { timeout: 250 }).catch(() => false);
	if (alreadyBrowsing) return;

	await page.waitFor(has(SEL.homeReady), { timeout });
	await page.click(SEL.openBrowse);
	await page.waitFor(has(SEL.search), { timeout });
}

/**
 * The other direction: from the browse screen back to the QUEUE, which is home.
 *
 * The rotation rows, the position line and the transport are all on home since #832 — a driver that
 * queued a song from the browse screen and then counted `.qrow` was reading the browse screen, where
 * the rotation is not rendered. So this is the mirror of `openBrowseFromHome` and the two together are
 * the whole IA change as far as a driver is concerned.
 *
 * @param {{ waitFor: (expr: string, opts?: { timeout?: number }) => Promise<unknown>,
 *           click: (selector: string) => Promise<unknown> }} page
 * @param {{ timeout?: number }} [opts]
 */
export async function returnHomeFromBrowse(page, { timeout = DEFAULT_TIMEOUT } = {}) {
	/** @param {string} sel */
	const has = (sel) => `document.querySelector(${JSON.stringify(sel)}) !== null`;
	// Already home? The hero only renders there.
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
