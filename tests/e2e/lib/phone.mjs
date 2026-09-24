/*
 * The phone's post-join steps, in ONE place, so a move of the phone's information architecture costs this
 * file and nothing else. Selectors come from the contract. See docs/E2E.md#shared-helpers.
 */
import { SEL } from '../contract.ts';

/** Matching the drivers' own 15s ceiling for a first paint after a navigation. */
const DEFAULT_TIMEOUT = 15_000;

/**
 * From the JOINED home screen, reach the search box.
 *
 * @param {{ waitFor: (expr: string, opts?: { timeout?: number }) => Promise<unknown>,
 *           click: (selector: string) => Promise<unknown> }} page
 * @param {{ timeout?: number }} [opts]
 */
export async function openBrowseFromHome(page, { timeout = DEFAULT_TIMEOUT } = {}) {
	/** @param {string} sel */
	const has = (sel) => `document.querySelector(${JSON.stringify(sel)}) !== null`;
	// Already on screen? Do nothing — which makes the helper safe to call defensively.
	const alreadyThere = await page.waitFor(has(SEL.findBox), { timeout: 250 }).catch(() => false);
	if (alreadyThere) return;

	// The band is chrome on every phone surface, so it is a stabler readiness signal than anything one
	// route renders. There is then nothing to CLICK — the field is the first element in the home column, so
	// the rest of this WAITS. Three distinct waits, so a driver can tell which half is missing.
	await page.waitFor(has(SEL.homeReady), { timeout });
	await page.waitFor(has(SEL.findBox), { timeout });
	await page.waitFor(has(SEL.search), { timeout });
}

/**
 * Pull the NOW-PLAYING sheet up to its raised snap point, so anything measured off its contents is on
 * screen. IDEMPOTENT: it stays up across a skip, but nothing in the contract promises that, so a driver
 * may call this defensively rather than tracking the state.
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
	 * PULLED UP IS A HEIGHT, NOT A PRESENCE — docs/E2E.md#presence-is-not-visibility. Measured against where
	 * the sheet RESTS, never half the viewport: snap 1 is CONTENT-capped, so with nothing playing it opens to
	 * about 72% down an 844px phone. Collapsed its top sits `--dock-h` off the bottom; raised it must have
	 * risen by another band's height. `--dock-h` is read live, so this cannot drift from the token.
	 */
	const pulledUp = `(() => {
		const e = document.querySelector(${JSON.stringify(SEL.npDrawer)});
		if (!e) return false;
		const dock = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dock-h')) || 80;
		return e.getBoundingClientRect().top < window.innerHeight - dock * 2;
	})()`;
	if (await page.waitFor(pulledUp, { timeout: 250 }).catch(() => false)) return;

	await page.waitFor(`document.querySelector(${JSON.stringify(SEL.homeReady)}) !== null`, { timeout });
	// CLICKED, not dragged: `SEL.bandOpen` is the affordance a guest who cannot drag uses, and it cannot
	// under-shoot a snap threshold the way a synthetic drag can. A flow whose subject IS the gesture drives
	// the drag itself — docs/E2E.md#gestures.
	await page.waitFor(`document.querySelector(${JSON.stringify(SEL.bandOpen)}) !== null`, { timeout });
	await page.click(SEL.bandOpen);
	await page.waitFor(pulledUp, { timeout });
}

/**
 * From a search showing RESULTS back to the QUEUE. The rotation is NOT rendered in the results view, and
 * the query is the one switch between them, so the way back is to CLEAR the box rather than to navigate. A
 * driver on a PUSHED surface (a song page, settings) clicks the header's back link instead; both are
 * handled, in that order.
 *
 * @param {{ waitFor: (expr: string, opts?: { timeout?: number }) => Promise<unknown>,
 *           click: (selector: string) => Promise<unknown> }} page
 * @param {{ timeout?: number }} [opts]
 */
export async function returnHomeFromBrowse(page, { timeout = DEFAULT_TIMEOUT } = {}) {
	/** @param {string} sel */
	const has = (sel) => `document.querySelector(${JSON.stringify(sel)}) !== null`;
	// Asked of the ROUTE: every structural anchor here is on the other phone surfaces too, so the pathname
	// is the only thing that distinguishes them. And `/` alone is not enough — the query decides whether the
	// rotation is rendered, so results still have to be cleared.
	const alreadyHome = await page.waitFor(`location.pathname === '/'`, { timeout: 250 }).catch(() => false);
	if (!alreadyHome) {
		// A real `<a href="/">`, so this exercises the same route change the phone's back gesture performs.
		await page.click(SEL.backToQueue);
		await page.waitFor(`location.pathname === '/'`, { timeout });
	}
	// The clear control renders ONLY while a query is up, so its presence IS "are results showing".
	const searching = await page.waitFor(has(SEL.clearSearch), { timeout: 250 }).catch(() => false);
	if (searching) await page.click(SEL.clearSearch);
	// …then the column, so a driver that continues counts rows rather than racing the paint.
	await page.waitFor(has(SEL.mainColumn), { timeout });
}

/**
 * "Am I joined yet?" as an expression, for a driver polling its own condition inside one `evaluate` (p8).
 * Use this rather than the search box, which only says which screen the guest is on.
 */
export function joinedExpression() {
	return `location.pathname === '/' && document.querySelector(${JSON.stringify(SEL.homeReady)}) !== null`;
}
