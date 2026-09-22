/*
 * The phone's post-join step, in ONE place.
 *
 * WHY THIS FILE EXISTS. The phone's information architecture has moved FOUR times now: `?browse=1`, then a
 * box docked on home at all times, then a `/find` ROUTE reached from the band's magnifier, and now a field
 * at the top of home with the library beneath the queue. Roughly twenty driver and probe call sites reach
 * search, and this file is why each move cost one function instead of twenty edits. It has paid for itself
 * three times, which is the argument for keeping the indirection even though a single call site would read
 * more plainly.
 *
 * Reaching search is NEITHER a click nor a navigation now: the field is on the joined home screen, so the
 * helper's job is to establish that it is there. The magnifier tap survives for the surfaces where it is
 * not (a pushed page), where it both navigates home and focuses the field.
 *
 * The selectors live in the contract; every driver calls this.
 */
import { SEL } from '../contract.ts';

/** Default wait, matching the drivers' own 15s ceiling for a first paint after a navigation. */
const DEFAULT_TIMEOUT = 15_000;

/**
 * From the JOINED home screen, reach the search box.
 *
 * THREE PLACEMENTS, ONE HELPER, and that is the whole reason this function exists. The box has been docked
 * at the bottom of `/`, then the `/find` route reached by tapping the band's magnifier, and since
 * 2026-09-22 a field at the TOP of `/` again. Every driver goes through here, so each move cost this file
 * and nothing else — the name is retained (not renamed to something like `reachSearch`) so the ~20 call
 * sites keep working, and the browse MODE it once opened is long gone.
 *
 * On home the field is already rendered for a joined singer, so the early return below IS the common path
 * now: the helper's job is "the field is reachable and present", which it already is. The magnifier tap is
 * kept for the case the box is not there yet — a driver that calls this before the joined home has painted,
 * or from a pushed surface, where tapping the band's magnifier navigates home and focuses the field.
 *
 * @param {{ waitFor: (expr: string, opts?: { timeout?: number }) => Promise<unknown>,
 *           click: (selector: string) => Promise<unknown> }} page
 * @param {{ timeout?: number }} [opts]
 */
export async function openBrowseFromHome(page, { timeout = DEFAULT_TIMEOUT } = {}) {
	/** @param {string} sel */
	const has = (sel) => `document.querySelector(${JSON.stringify(sel)}) !== null`;
	// Field already on screen? Do nothing. Cheap, and it makes the helper safe to call defensively.
	const alreadyThere = await page.waitFor(has(SEL.findBox), { timeout: 250 }).catch(() => false);
	if (alreadyThere) return;

	// The band is what says the joined app has painted — the layout mounts it on every phone surface,
	// so it is a stabler readiness signal than anything a single route renders.
	await page.waitFor(has(SEL.homeReady), { timeout });
	/*
	 * NOTHING TO CLICK ANY MORE. This tapped the band's magnifier, which navigated (`?browse=1`, then
	 * `/find`) or focused the field; the magnifier was deleted with the merge (2026-09-22) because the field
	 * is the FIRST element in the home column. So the helper waits rather than acts: a driver on `/` has the
	 * field already, and a driver anywhere else has to get to `/` the way a guest does, which its own flow
	 * already knows how to do (every caller joins and lands there).
	 *
	 * Two distinct waits, kept: the box arriving, then the field inside it. A driver can tell "home never
	 * painted" from "it painted and the field is missing".
	 */
	await page.waitFor(has(SEL.findBox), { timeout });
	await page.waitFor(has(SEL.search), { timeout });
}

/**
 * Open the NOW-PLAYING DRAWER, which is where the full transport lives.
 *
 * WHY DRIVERS NEED THIS. `restart` and `skip` exist in exactly one place on the phone now — the drawer —
 * and `play/pause` exists there too, beside the band's own one-tap disc. Before the redesign all three
 * sat on the hero, unconditionally rendered on home, so a driver could click them the moment it joined.
 * Six drivers did exactly that and would now time out waiting for a label inside a closed drawer.
 *
 * It is IDEMPOTENT, so a driver may call it defensively before each transport interaction rather than
 * tracking whether the drawer is still up (the drawer stays open across a skip, but nothing in the
 * contract promises that, and a driver should not depend on it).
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
	 * PULLED UP IS A HEIGHT, NOT A PRESENCE. This used to decide "already open" with
	 * `querySelector(npDrawer) !== null`, which was sound while vaul destroyed the content on close.
	 * The sheet is permanently mounted now, so that read is TRUE at both snap points and the helper
	 * would return without opening anything. What distinguishes them is where the sheet's top edge is.
	 *
	 * MEASURED AGAINST THE COLLAPSED REST POSITION, NOT AGAINST HALF THE VIEWPORT. Half was chosen as
	 * "the midpoint between the two snap points", which stopped being a midpoint when snap 1 gained a
	 * CONTENT cap: a sheet with nothing playing is a head and a transport row, so it now opens to about
	 * 230px and its top lands around 72% down an 844px phone — open, and nowhere near half. The party flow
	 * timed out here on exactly that, which is the helper being stale rather than the sheet being shut.
	 *
	 * So the test is relative to where the sheet RESTS: collapsed, its top sits `--dock-h` off the bottom;
	 * raised, it must have risen by at least another band's height. `--dock-h` is read live from the
	 * document rather than restated, so this cannot drift from the token the layout publishes.
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
	/*
	 * CLICKED, not dragged — and this reverses what this helper used to say.
	 *
	 * It read: "the band's pull-handle button is retired: the one way to snap 1 is vaul's own handle, and
	 * `handleOnly` restricts dragging to it. A click does nothing at all here." That was true, and it was
	 * also the shape of a real defect — vaul's handle is a `<div aria-hidden="true">` with no tabindex, so
	 * while it was the only affordance the sheet could not be raised by a keyboard or announced to a
	 * screen reader. The band carries a real expand button again (`SEL.bandOpen`, its metadata block), so
	 * a click is both available and the more faithful drive: it is the affordance a guest who cannot drag
	 * actually uses, and it cannot under-shoot a snap threshold the way a synthetic 520px drag can.
	 *
	 * The DRAG still works and is still vaul's (`handleOnly` is untouched); it is simply not what this
	 * helper needs to exercise, and a flow specifically testing the gesture should drive it explicitly.
	 */
	await page.waitFor(`document.querySelector(${JSON.stringify(SEL.bandOpen)}) !== null`, { timeout });
	await page.click(SEL.bandOpen);
	await page.waitFor(pulledUp, { timeout });
}

/**
 * The other direction: from a search that is showing RESULTS back to the QUEUE.
 *
 * A driver that searched and then counted `.qrow` was reading the results view, where the rotation is not
 * rendered — the queue gives way to the results under one switch, the query.
 *
 * SO THE WAY BACK IS TO CLEAR THE BOX, not to navigate. That is what it was under the docked box, it became
 * a real `<a href="/">` while search was its own route, and the merge (2026-09-22) returns it: the results
 * are a section of the page the driver is already on, so there is nothing to navigate away from. A driver
 * that is on a PUSHED surface (a song page, settings) is a different case and still clicks the header's
 * back link — both are handled below, in that order.
 *
 * @param {{ waitFor: (expr: string, opts?: { timeout?: number }) => Promise<unknown>,
 *           click: (selector: string) => Promise<unknown> }} page
 * @param {{ timeout?: number }} [opts]
 */
export async function returnHomeFromBrowse(page, { timeout = DEFAULT_TIMEOUT } = {}) {
	/** @param {string} sel */
	const has = (sel) => `document.querySelector(${JSON.stringify(sel)}) !== null`;
	/*
	 * ON HOME ALREADY? Asked of the ROUTE, not of a selector, and that is the honest form: every structural
	 * anchor on this page — `main`, `.grouphead`, the band — is on the other phone surfaces too, because the
	 * band is app chrome. The pathname is the one thing that distinguishes them.
	 *
	 * Being on `/` is not the end of it, though: the query is what decides whether the rotation is rendered,
	 * so a driver on home with results up still has to clear the box.
	 */
	const alreadyHome = await page.waitFor(`location.pathname === '/'`, { timeout: 250 }).catch(() => false);
	if (!alreadyHome) {
		// A pushed surface: the header's back control is a real <a href="/">, so this exercises the same
		// route change the phone's own back gesture performs.
		await page.click(SEL.backToQueue);
		await page.waitFor(`location.pathname === '/'`, { timeout });
	}
	// The clear control renders ONLY while a query is up, so its presence is the question "are results
	// showing" asked of the DOM — and clicking it restores the queue in place, with no navigation.
	const searching = await page.waitFor(has(SEL.clearSearch), { timeout: 250 }).catch(() => false);
	if (searching) await page.click(SEL.clearSearch);
	// …and the rotation heading, so a driver that continues can count rows rather than racing the paint.
	await page.waitFor(has(SEL.mainColumn), { timeout });
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
