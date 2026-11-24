// The phone's post-join steps, in ONE place, so a move of the phone's information architecture costs this
// file and nothing else. Selectors come from the contract — see docs/E2E.md#shared-helpers.
//
// A locator waits for itself and returns immediately when the thing is already present, so no helper needs an
// "already there?" probe, and every step names the selector it is waiting on in its own failure. The ordering
// and the geometry are deliberate: those encode how the phone actually behaves.
import { expect, type Locator, type Page } from '@playwright/test';
import { SEL } from './selectors';
import type { World } from './fixtures';

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
	// The dock is chrome on every phone surface, so it is a stabler readiness signal than anything one route
	// renders. NOT the strip inside it, which renders only when the room has something to play. There is then
	// nothing to CLICK — the field is the first element in the home column, so the rest of this WAITS. Three
	// distinct waits, so a failure says which half is missing.
	await page.locator(SEL.dock).first().waitFor({ state: 'attached', timeout });
	await page.locator(SEL.findBox).first().waitFor({ state: 'attached', timeout });
	await page.locator(SEL.search).first().waitFor({ state: 'attached', timeout });
}

/**
 * Reach the LIVE CONTROLS — the guiding track, the vocal range, the key row, the clock. This replaces
 * `openNowPlaying`, which pulled a multi-snap sheet to its raised point and then measured its resting height
 * against `--dock-h` to decide whether it had got there. All of that is gone: the controls are a card at the
 * top of /queue, so "open" is a ROUTE and the question is answered by a locator rather than by geometry.
 *
 * IDEMPOTENT, like its predecessor — called from /queue it returns as soon as the card resolves.
 *
 * THE STRIP'S LINK IS PREFERRED over a bare navigation, because that is the trip a guest actually makes and it
 * exercises the one affordance the strip offers besides the transport. But the strip renders only when
 * `hasSong || canStart`, so on a drained room there is nothing to click and the fallback is the real path too:
 * the Queue tab in the dock. Either way the wait is on the card, not on the URL.
 */
export async function openQueue(page: Page, { timeout = DEFAULT_TIMEOUT }: StepOptions = {}): Promise<void> {
	await page.locator(SEL.dock).first().waitFor({ state: 'attached', timeout });
	if (new URL(page.url()).pathname !== '/queue') {
		const link = page.locator(SEL.npStripLink);
		if (await presentWithin(link)) {
			await link.first().click({ timeout });
		} else {
			await page.locator(SEL.tab).filter({ hasText: 'Queue' }).first().click({ timeout });
		}
		await page.waitForURL((url) => url.pathname === '/queue', { timeout });
	}
	// THE ROUTE'S OWN HEADING, not `SEL.queueNowCard`. The card is what most callers came for, but its absence
	// is LEGITIMATE — it renders only with a current entry — so waiting on it would make a drained room burn the
	// whole timeout before agreeing. The heading is unconditional, which makes it the "this route has painted"
	// signal; a caller whose subject is the card asserts on it with a locator that auto-waits anyway.
	await page.locator(SEL.pageHeading).first().waitFor({ state: 'attached', timeout });
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
 * "Am I joined yet?" — a PREDICATE over a locator. A predicate rather than an assertion because the callers that need it are
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
		// The dock is chrome on every phone surface, so the pathname is what makes this "joined AND on home".
		if (new URL(page.url()).pathname !== '/') return false;
		return (await page.locator(SEL.dock).count()) > 0;
	} catch {
		return false;
	}
}

/** Process a demo track through the (fake) worker and wait until the library calls it ready. Returns its title. */
export async function readySong(world: Pick<World, 'awaitDemoTrack'>, phone: Page, query: string): Promise<string> {
	const track = await world.awaitDemoTrack(query);
	const res = await phone.request.post('/api/process', { data: { mediaId: track.id } });
	if (!res.ok()) throw new Error(`/api/process refused "${track.title}": ${res.status()}`);
	await expect
		.poll(
			async () => {
				const body = (await phone.request.get('/api/library').then((r) => r.json())) as {
					library: { id: string; instrumentalRef?: string | null }[];
				};
				return body.library.some((m) => m.id === track.id && !!m.instrumentalRef);
			},
			{ timeout: 60_000, message: `"${track.title}" never reached ready` }
		)
		.toBe(true);
	return track.title;
}

/**
 * From the joined home screen, take a turn on a READY song through the real row action, then wait for the phone's
 * own acknowledgement rather than returning on the click.
 *
 * EITHER signal counts, because which one arrives depends on whether the room was idle: `inQueue` is
 * `queued.some(...)` and a turn that starts PLAYING immediately leaves `queued`, so the row's button
 * re-enables and the strip names the song instead.
 *
 * THE ROW IS THE ONE MATCHING THE QUERY, never `.first()` of the list: on a second call the previous answer is
 * still on screen when the box is filled, so the first row was the LAST song again — and its disabled button then
 * passed the acknowledgement below for a turn nobody asked for.
 */
export async function queueReady(phone: Page, query: string): Promise<void> {
	await openBrowseFromHome(phone);
	await phone.locator(SEL.search).fill(query);
	const add = phone.locator(SEL.songRow, { hasText: query }).locator(SEL.addAction).first();
	await add.click();
	await expect
		.poll(
			async () => {
				if (await add.isDisabled()) return true;
				const strip = (await phone.locator(SEL.npStripTitle).first().textContent()) ?? '';
				return strip.toLowerCase().includes(query);
			},
			{ message: `the phone never acknowledged the turn on "${query}" — no queued row and the strip never named it` }
		)
		.toBe(true);
}

/** Take a phone offline. A Chromium that already reports offline fires no `offline` event, so the app's drop cue
 *  waits out its heartbeat instead: fail on the environment, not on the cue. See docs/E2E.md#running-in-docker. */
export async function goOffline(page: Page): Promise<void> {
	expect(
		await page.evaluate(() => navigator.onLine),
		'Chromium already reports offline; docker --network none? Use --network encore-hermetic'
	).toBe(true);
	await page.context().setOffline(true);
}
