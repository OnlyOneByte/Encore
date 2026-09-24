// The phone's post-join steps, in ONE place, so a move of the phone's information architecture costs this
// file and nothing else. Selectors come from the contract — see docs/E2E.md#shared-helpers.
//
// Ported from tests/e2e/lib/phone.mjs. The old driver had no auto-waiting, so each helper was a sequence of
// `waitFor('<js expression string>')` calls with a hand-rolled 250ms "already there?" probe in front. Here a
// locator waits for itself and returns immediately when the thing is already present, so the probes are gone
// and every step names the selector it is waiting on in its own failure. What is NOT gone is the ordering and
// the geometry: those encode how the phone actually behaves.
import { expect, type Locator, type Page } from '@playwright/test';
import { SEL } from './selectors';

/** The suite's own `expect.timeout` (playwright.config.ts), so a helper's ceiling and an assertion's agree. */
const DEFAULT_TIMEOUT = 15_000;

/**
 * A BOUNDED wait, where every other wait here is unbounded. Used only where ABSENCE is a legitimate answer —
 * "is a search showing?", "is the sheet already up?" — because an auto-waiting locator asked a question whose
 * normal answer is "no" would burn the whole timeout before agreeing.
 */
const ABSENCE_GRACE_MS = 250;

export interface StepOptions {
	timeout?: number;
}

/** True when the locator is attached within the grace, false when it is not and false on a navigation that
 *  destroyed the context mid-question. */
async function presentWithin(locator: Locator, timeout = ABSENCE_GRACE_MS): Promise<boolean> {
	return locator
		.first()
		.waitFor({ state: 'attached', timeout })
		.then(() => true)
		.catch(() => false);
}

/**
 * From the JOINED home screen, reach the search box. Idempotent: called when the box is already up it returns
 * as soon as the locators resolve.
 */
export async function openBrowseFromHome(page: Page, { timeout = DEFAULT_TIMEOUT }: StepOptions = {}): Promise<void> {
	// The band is chrome on every phone surface, so it is a stabler readiness signal than anything one route
	// renders. There is then nothing to CLICK — the field is the first element in the home column, so the rest
	// of this WAITS. Three distinct waits, so a failure says which half is missing.
	await page.locator(SEL.homeReady).first().waitFor({ state: 'attached', timeout });
	await page.locator(SEL.findBox).first().waitFor({ state: 'attached', timeout });
	await page.locator(SEL.search).first().waitFor({ state: 'attached', timeout });
}

/**
 * PULLED UP IS A HEIGHT, NOT A PRESENCE — docs/E2E.md#presence-is-not-visibility. Measured against where the
 * sheet RESTS, never half the viewport: snap 1 is CONTENT-capped, so with nothing playing it opens to about
 * 72% down an 844px phone. Collapsed its top sits `--dock-h` off the bottom; raised it must have risen by
 * another band's height. `--dock-h` is read live, so this cannot drift from the token.
 *
 * Stays an `evaluate` rather than becoming a locator assertion because the question is a RELATION between
 * three measurements — the sheet's top, the viewport and a live CSS custom property — which no locator state
 * expresses.
 */
async function isPulledUp(page: Page): Promise<boolean> {
	return page
		.evaluate((npDrawer) => {
			const e = document.querySelector(npDrawer);
			if (!e) return false;
			const dock = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dock-h')) || 80;
			return e.getBoundingClientRect().top < window.innerHeight - dock * 2;
		}, SEL.npDrawer)
		.catch(() => false); // a navigation destroyed the context mid-measurement
}

/**
 * Pull the NOW-PLAYING sheet up to its raised snap point, so anything measured off its contents is on screen.
 * IDEMPOTENT: it stays up across a skip, but nothing in the contract promises that, so a spec may call this
 * defensively rather than tracking the state.
 */
export async function openNowPlaying(page: Page, { timeout = DEFAULT_TIMEOUT }: StepOptions = {}): Promise<void> {
	if (await isPulledUp(page)) return;

	await page.locator(SEL.homeReady).first().waitFor({ state: 'attached', timeout });
	// CLICKED, not dragged: `SEL.bandOpen` is the affordance a guest who cannot drag uses, and it cannot
	// under-shoot a snap threshold the way a synthetic drag can. A spec whose subject IS the gesture drives the
	// drag itself — docs/E2E.md#gestures.
	await page.locator(SEL.bandOpen).first().click({ timeout });
	await expect
		.poll(() => isPulledUp(page), {
			timeout,
			message: `the now-playing sheet never rose past its collapsed rest height after clicking ${SEL.bandOpen}`
		})
		.toBe(true);
}

/**
 * From a search showing RESULTS back to the QUEUE. The rotation is NOT rendered in the results view, and the
 * query is the one switch between them, so the way back is to CLEAR the box rather than to navigate. A spec on
 * a PUSHED surface (a song page, settings) clicks the header's back link instead; both are handled, in that
 * order.
 */
export async function returnHomeFromBrowse(page: Page, { timeout = DEFAULT_TIMEOUT }: StepOptions = {}): Promise<void> {
	// Asked of the ROUTE: every structural anchor here is on the other phone surfaces too, so the pathname is
	// the only thing that distinguishes them. And `/` alone is not enough — the query decides whether the
	// rotation is rendered, so results still have to be cleared.
	const onHome = () => new URL(page.url()).pathname === '/';
	if (!onHome()) {
		// A real `<a href="/">`, so this exercises the same route change the phone's back gesture performs.
		await page.locator(SEL.backToQueue).first().click({ timeout });
		await page.waitForURL((url) => url.pathname === '/', { timeout });
	}
	// The clear control renders ONLY while a query is up, so its presence IS "are results showing".
	if (await presentWithin(page.locator(SEL.clearSearch))) {
		await page.locator(SEL.clearSearch).first().click({ timeout });
	}
	// …then the column, so a spec that continues counts rows rather than racing the paint.
	await page.locator(SEL.mainColumn).first().waitFor({ state: 'attached', timeout });
}

/**
 * "Am I joined yet?" — a PREDICATE over a locator, where the old driver returned a JS expression string for it
 * to poll inside one `evaluate`. A predicate rather than an assertion because the callers that need it are
 * watching a condition COME BACK (a reconnect, a reload) and want to poll it themselves:
 *
 *     await expect.poll(() => isJoined(phone), { timeout: 20_000 }).toBe(true);
 *
 * Use this rather than the search box, which only says which screen the guest is on.
 *
 * Never throws: a reload in flight destroys the execution context, and an exception there would end the poll
 * that was waiting for exactly that reload to finish.
 */
export async function isJoined(page: Page): Promise<boolean> {
	try {
		// The band is chrome on every phone surface, so the pathname is what makes this "joined AND on home".
		if (new URL(page.url()).pathname !== '/') return false;
		return (await page.locator(SEL.homeReady).count()) > 0;
	} catch {
		return false;
	}
}
