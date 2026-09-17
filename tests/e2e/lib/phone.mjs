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
	/*
	 * Already home? Asked of the ROUTE, not of a selector, and that is the honest form now. It used to
	 * wait for `SEL.hero`, which worked because the hero rendered on `/` and nowhere else. The hero is
	 * gone (the drawer replaced it, mounted by the layout), and every remaining structural anchor on
	 * home — `main`, `.grouphead`, the band — is on `/find` too, because the band is app chrome. The one
	 * thing that distinguishes the two surfaces is which one you are on.
	 */
	const alreadyHome = await page.waitFor(`location.pathname === '/'`, { timeout: 250 }).catch(() => false);
	if (alreadyHome) return;

	// A real navigation now, not a state clear: the header's back control is an <a href="/">, so this
	// exercises the same route change the phone's own back gesture performs.
	await page.click(SEL.backToQueue);
	await page.waitFor(`location.pathname === '/'`, { timeout });
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
