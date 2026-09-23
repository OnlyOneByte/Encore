/*
 * The phone's post-join steps, in ONE place — ~20 driver call sites reach search and the transport through
 * these four helpers, so a move of the phone's information architecture costs this file and nothing else.
 * Selectors come from the contract. See docs/E2E.md#shared-helpers.
 */
import { SEL } from '../contract.ts';

/** Default wait, matching the drivers' own 15s ceiling for a first paint after a navigation. */
const DEFAULT_TIMEOUT = 15_000;

/**
 * From the JOINED home screen, reach the search box. The name is kept (rather than something like
 * `reachSearch`) so the ~20 call sites keep working; the browse MODE it once opened is long gone.
 *
 * @param {{ waitFor: (expr: string, opts?: { timeout?: number }) => Promise<unknown>,
 *           click: (selector: string) => Promise<unknown> }} page
 * @param {{ timeout?: number }} [opts]
 */
export async function openBrowseFromHome(page, { timeout = DEFAULT_TIMEOUT } = {}) {
	/** @param {string} sel */
	const has = (sel) => `document.querySelector(${JSON.stringify(sel)}) !== null`;
	// Field already on screen? Do nothing — cheap, and it makes the helper safe to call defensively.
	const alreadyThere = await page.waitFor(has(SEL.findBox), { timeout: 250 }).catch(() => false);
	if (alreadyThere) return;

	// The band says the joined app has painted — the layout mounts it on every phone surface, so it is a
	// stabler readiness signal than anything a single route renders.
	await page.waitFor(has(SEL.homeReady), { timeout });
	// There is nothing to click: the field is the first element in the home column, so this WAITS rather
	// than acts, and a driver elsewhere has to reach `/` the way a guest does. Two distinct waits, so a
	// driver can tell "home never painted" from "it painted and the field is missing".
	await page.waitFor(has(SEL.findBox), { timeout });
	await page.waitFor(has(SEL.search), { timeout });
}

/**
 * Pull the NOW-PLAYING sheet up to its raised snap point, where anything measured off its contents is on
 * screen rather than below the fold.
 *
 * IDEMPOTENT, so a driver may call it defensively before each interaction rather than tracking whether the
 * sheet is still up — it stays up across a skip, but nothing in the contract promises that.
 *
 * @param {{ waitFor: (expr: string, opts?: { timeout?: number }) => Promise<unknown>,
 *           click: (selector: string) => Promise<unknown>,
 *           evaluate: (expr: string) => Promise<any>,
 *           drag: (x1: number, y1: number, x2: number, y2: number,
 *                  opts?: { steps?: number, settle?: number }) => Promise<unknown> }} page
 * @param {{ timeout?: number }} [opts]
 */
export async function openNowPlaying(page, { timeout = DEFAULT_TIMEOUT } = {}) {
	/*
	 * PULLED UP IS A HEIGHT, NOT A PRESENCE: the sheet is permanently mounted, so `querySelector(npDrawer)`
	 * is true at both snap points. See docs/E2E.md#presence-is-not-visibility.
	 *
	 * Measured against where the sheet RESTS, never against half the viewport: snap 1 is CONTENT-capped, so
	 * with nothing playing it opens to a head plus a transport row — about 72% down an 844px phone, open and
	 * nowhere near half. Collapsed, its top sits `--dock-h` off the bottom; raised, it must have risen by at
	 * least another band's height. `--dock-h` is read live so this cannot drift from the published token.
	 */
	const pulledUp = `(() => {
		const e = document.querySelector(${JSON.stringify(SEL.npDrawer)});
		if (!e) return false;
		const dock = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dock-h')) || 80;
		return e.getBoundingClientRect().top < window.innerHeight - dock * 2;
	})()`;
	if (await page.waitFor(pulledUp, { timeout: 250 }).catch(() => false)) return;

	// The band is app chrome, so it is present on whichever phone surface the driver is on.
	await page.waitFor(`document.querySelector(${JSON.stringify(SEL.homeReady)}) !== null`, { timeout });
	// CLICKED, not dragged: `SEL.bandOpen` is the affordance a guest who cannot drag uses, and it cannot
	// under-shoot a snap threshold the way a synthetic drag can. A flow whose subject IS the gesture should
	// drive the drag explicitly — see docs/E2E.md#gestures.
	await page.waitFor(`document.querySelector(${JSON.stringify(SEL.bandOpen)}) !== null`, { timeout });
	await page.click(SEL.bandOpen);
	await page.waitFor(pulledUp, { timeout });
}

/**
 * From a search that is showing RESULTS back to the QUEUE. A driver that searched and then counted `.qrow`
 * was reading the results view, where the rotation is NOT rendered — the query is the one switch between
 * them, so the way back is to clear the box rather than to navigate. A driver on a PUSHED surface (a song
 * page, settings) is the other case and clicks the header's back link; both are handled, in that order.
 *
 * @param {{ waitFor: (expr: string, opts?: { timeout?: number }) => Promise<unknown>,
 *           click: (selector: string) => Promise<unknown> }} page
 * @param {{ timeout?: number }} [opts]
 */
export async function returnHomeFromBrowse(page, { timeout = DEFAULT_TIMEOUT } = {}) {
	/** @param {string} sel */
	const has = (sel) => `document.querySelector(${JSON.stringify(sel)}) !== null`;
	// ON HOME ALREADY? Asked of the ROUTE, because every structural anchor on this page is on the other
	// phone surfaces too — the pathname is the only thing that distinguishes them. Being on `/` is not
	// enough: the query decides whether the rotation is rendered, so results still have to be cleared.
	const alreadyHome = await page.waitFor(`location.pathname === '/'`, { timeout: 250 }).catch(() => false);
	if (!alreadyHome) {
		// A pushed surface: the header's back control is a real <a href="/">, so this exercises the same
		// route change the phone's own back gesture performs.
		await page.click(SEL.backToQueue);
		await page.waitFor(`location.pathname === '/'`, { timeout });
	}
	// The clear control renders ONLY while a query is up, so its presence IS "are results showing" — and
	// clicking it restores the queue in place, with no navigation.
	const searching = await page.waitFor(has(SEL.clearSearch), { timeout: 250 }).catch(() => false);
	if (searching) await page.click(SEL.clearSearch);
	// …then the column, so a driver that continues counts rows rather than racing the paint.
	await page.waitFor(has(SEL.mainColumn), { timeout });
}

/**
 * The expression form of "am I joined yet?", for a driver that polls its own condition inside one
 * `evaluate` (p8 does). Use this rather than testing for the search box, which only says which screen the
 * guest is on.
 */
export function joinedExpression() {
	return `location.pathname === '/' && document.querySelector(${JSON.stringify(SEL.homeReady)}) !== null`;
}
