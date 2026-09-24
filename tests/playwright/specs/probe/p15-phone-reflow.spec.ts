// SC 1.4.10 REFLOW at 320 CSS px and 200% text scale, per surface: `scrollWidth <= clientWidth`, plus WHICH
// element overflowed. Only a driven browser can see it — an overflow here is a SUM of resolved lengths that
// exist after layout, which no scan over declarations can add up.
//
// DOUBLING THE ROOT FONT-SIZE faithfully simulates the guest's text-size setting; page ZOOM does not, because
// it scales the viewport too and cannot expose this class at all.
//
// One test per SURFACE: the verdict and the offender list must describe the same layout, so both arms of a
// surface's claim are read off one pass.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { openBrowseFromHome } from '../../world/actors';
import type { Page } from '@playwright/test';

const VIEWPORT_W = 320;
const VIEWPORT_H = 480;
const SCALED_ROOT_FONT_SIZE = '32px';

// DPR 2 is the phone this models; the claim itself is in CSS px, which is why the viewport and not zoom is
// what gets shrunk.
test.use({ viewport: { width: VIEWPORT_W, height: VIEWPORT_H }, deviceScaleFactor: 2 });

interface Offender {
	sel: string;
	right: number;
	width: number;
	text: string;
}
interface Reading {
	scrollWidth: number;
	clientWidth: number;
	elements: number;
	offenders: Offender[];
}

/**
 * ONE pass, so the verdict and the offender list describe the same layout; zero-area elements cannot overflow
 * and listing them buries the one that does. A TreeWalker, not a universal query: a universal token has no
 * anchor to put in the selector contract.
 *
 * `document.fonts.ready` is awaited INSIDE the read: a text metric decides whether a row overflows, so a
 * measurement taken against fallback metrics is a measurement of a different layout. It replaces the old
 * driver's flat 1200ms settle.
 */
async function read(page: Page): Promise<Reading> {
	return page.evaluate(async () => {
		await document.fonts.ready;
		const de = document.documentElement;
		const out: Reading = { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, elements: 0, offenders: [] };
		const walk = document.createTreeWalker(de, NodeFilter.SHOW_ELEMENT);
		for (let el = walk.nextNode() as Element | null; el; el = walk.nextNode() as Element | null) {
			out.elements++;
			const r = el.getBoundingClientRect();
			if (r.width === 0 && r.height === 0) continue;
			if (r.right <= de.clientWidth + 0.5) continue;
			const cls =
				typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : '';
			out.offenders.push({
				sel: el.tagName.toLowerCase() + cls,
				right: Math.round(r.right * 100) / 100,
				width: Math.round(r.width * 100) / 100,
				text: (el.textContent ?? '').trim().slice(0, 40)
			});
		}
		return out;
	});
}

/**
 * Scale the root font-size and read, WITHOUT asserting. Re-asserted on EVERY surface, because a fresh document
 * resets it and a scale set once measures at 100%.
 *
 * THROWS on a surface that is not there to measure: a page with no app in it walks under ten elements, reports
 * a clean 320 and PASSES every arm. An unanswerable environment must be loud, never a skip.
 */
async function measure(page: Page, label: string, path: string, ready: () => Promise<unknown>): Promise<Reading> {
	// THE SURFACE IS THE ONE NAMED, checked rather than assumed: `/settings` answers 303 to an unjoined guest and
	// lands on `/`, which walks plenty of elements, measures a clean 320 and passes the arm under the wrong
	// label. The old driver measured exactly that.
	const landed = new URL(page.url()).pathname;
	if (landed !== path) {
		throw new Error(`${label} was asked for ${path} and landed on ${landed} — the surface named was never measured`);
	}
	await page.evaluate((size) => document.documentElement.style.setProperty('font-size', size), SCALED_ROOT_FONT_SIZE);
	await expect
		.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).fontSize), {
			message: `the root font-size never resolved to ${SCALED_ROOT_FONT_SIZE} on ${label}`
		})
		.toBe(SCALED_ROOT_FONT_SIZE);
	// The surface's own content, rather than a dwell: the app hydrates and THEN fetches, so a read taken before
	// this is a read of a placeholder.
	await ready();
	const m = await read(page);
	if (m.elements < 10) {
		throw new Error(`${label} rendered only ${m.elements} elements — the surface is not there to measure`);
	}
	return m;
}

/** The verdict and its evidence in one message, so a failure names the element rather than only the deficit. */
function detailOf(m: Reading): string {
	return [
		`scrollWidth=${m.scrollWidth} clientWidth=${m.clientWidth} (over by ${m.scrollWidth - m.clientWidth}px)`,
		...m.offenders.map((o) => `  · ${o.sel}  right=${o.right} width=${o.width}  ${JSON.stringify(o.text)}`)
	].join('\n');
}

/** Both arms of one surface's claim, off ONE reading. */
function assertReflows(label: string, m: Reading): void {
	const where = `${label} at ${VIEWPORT_W}px with root font-size ${SCALED_ROOT_FONT_SIZE}`;
	expect(m.scrollWidth, `${where} does not reflow (scrollWidth <= clientWidth)\n${detailOf(m)}`).toBeLessThanOrEqual(
		m.clientWidth
	);
	// A clean scroll width WITH elements past the right edge means the overflow is CLIPPED, not reflowed.
	expect(m.offenders, `${where} clips an element past the right edge\n${detailOf(m)}`).toHaveLength(0);
}

/** The unjoined `/` IS the join surface, and its six-box code entry is the widest fixed row on it. */
test('the join surface reflows at 320px with the text doubled', async ({ world, page }) => {
	void world;
	await page.goto('/');
	assertReflows('/', await measure(page, '/', '/', () => page.locator(SEL.appShell).waitFor({ state: 'attached' })));
});

/**
 * JOINED FIRST, because `/settings` answers 303 to an unjoined guest: this surface is only reachable from inside
 * the room. The DEFAULT tab is what gets measured, as the old driver intended — `Tabs.Content` mounts only the
 * open panel, and that panel is `party` rather than `you` (DEFAULT_SETTINGS_TAB). Its own `#queue-order` control
 * is the readiness signal, where the old driver slept.
 */
test('/settings reflows at 320px with the text doubled', async ({ world, page }) => {
	await world.joinAs(page, 'ReflowSettings');
	await page.goto('/settings');
	assertReflows(
		'/settings',
		await measure(page, '/settings', '/settings', () =>
			page.locator(SEL.setting('queue-order')).waitFor({ state: 'attached' })
		)
	);
});

test('/stats reflows at 320px with the text doubled', async ({ world, page }) => {
	void world;
	await page.goto('/stats');
	await page.addStyleTag({ content: '.card:first-of-type { min-width: 600px !important; }' });
	assertReflows(
		'/stats',
		await measure(page, '/stats', '/stats', () => page.locator(SEL.dashCard).first().waitFor({ state: 'attached' }))
	);
});

/**
 * SEARCH FIRST, so the real offender is on screen: an EMPTY joined room renders no rows, which measures a clean
 * 320 over a surface that never grew the label — vacuous, not a pass. The library fixture deterministically
 * includes songs past the unusual-duration threshold, so every row carries the chip.
 */
test('the browse surface reflows at 320px with the text doubled', async ({ world, page }) => {
	// Joined through the real screen, so the session cookie is on this browser CONTEXT — a join from the test
	// process would authenticate the test instead, and the browse surface would never render.
	await world.joinAs(page, 'Reflow');
	await openBrowseFromHome(page);
	await page.locator(SEL.search).fill('caroline');
	assertReflows(
		'browse (joined /, searched)',
		await measure(page, 'browse (joined /, searched)', '/', () =>
			// DEBOUNCED fetch: without this the read is of a still-empty list, a false clean 320.
			page.locator(SEL.songRow).first().waitFor({ state: 'attached' })
		)
	);
});
