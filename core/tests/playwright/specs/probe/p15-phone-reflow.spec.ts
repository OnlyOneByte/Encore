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
import { openBrowseFromHome, openQueue, queueReady, readySong } from '../../world/actors';
import { startFakeWorker } from '../../world/workers';
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
	spills: Offender[];
}

/**
 * ONE pass, so the verdict and the offender list describe the same layout; zero-area elements cannot overflow
 * and listing them buries the one that does. A TreeWalker, not a universal query: a universal token has no
 * anchor to put in the selector contract.
 *
 * `document.fonts.ready` is awaited INSIDE the read: a text metric decides whether a row overflows, so a
 * measurement taken against fallback metrics is a measurement of a different layout. It replaces the old
 * driver's flat 1200ms settle.
 *
 * `spills` is the third arm: an element inside a Button that pokes out of the Button's own box. A centred row
 * whose min-content is wider than its box splits the excess either side, so the page can measure a clean 320
 * while the icon hangs off the left border and the Badge off the right one.
 *
 * The Button is found by its own `group/button` class, NOT `data-slot="button"`: a Button rendered through a
 * bits-ui `child` snippet takes the primitive's spread props, and those overwrite `data-slot` (the `/settings/server`
 * `Advanced` trigger reads `collapsible-trigger`), so a data-slot match never saw that row.
 */
async function read(page: Page): Promise<Reading> {
	return page.evaluate(async () => {
		await document.fonts.ready;
		const de = document.documentElement;
		const out: Reading = {
			scrollWidth: de.scrollWidth,
			clientWidth: de.clientWidth,
			elements: 0,
			offenders: [],
			spills: []
		};
		// Two classes at most: a Button carries ~40 utilities, and its whole list buries the one line that matters.
		const describe = (el: Element, r: DOMRect, text: Node | null = null) => {
			const cls =
				typeof el.className === 'string' && el.className.trim()
					? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
					: '';
			const tag = el.tagName.toLowerCase() + cls;
			return {
				sel: text ? `#text in ${tag}` : tag,
				right: Math.round(r.right * 100) / 100,
				width: Math.round(r.width * 100) / 100,
				text: ((text ?? el).textContent ?? '').trim().slice(0, 40)
			};
		};
		// The spill line carries the LEFT edge as well: a centred row overhangs both sides.
		const spill = (el: Element, r: DOMRect, text: Node | null) => {
			const d = describe(el, r, text);
			return { ...d, sel: `${d.sel}  left=${Math.round(r.left * 100) / 100}` };
		};
		// Text nodes too, for the spill arm only: a Button's bare label is a text node, and it is what spills when the
		// label cannot wrap. A Range measures it; the node is reported by its parent element.
		const walk = document.createTreeWalker(de, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
		const range = document.createRange();
		for (let n = walk.nextNode(); n; n = walk.nextNode()) {
			const isText = n.nodeType === Node.TEXT_NODE;
			const el = isText ? n.parentElement : (n as Element);
			if (!el || (isText && !n.textContent?.trim())) continue;
			let r: DOMRect;
			if (isText) {
				range.selectNodeContents(n);
				r = range.getBoundingClientRect();
			} else {
				out.elements++;
				r = el.getBoundingClientRect();
			}
			if (r.width === 0 && r.height === 0) continue;
			if (!isText && r.right > de.clientWidth + 0.5) out.offenders.push(describe(el, r));
			const box = (isText ? el : el.parentElement)?.closest('.group\\/button')?.getBoundingClientRect();
			if (box && (r.left < box.left - 0.5 || r.right > box.right + 0.5))
				out.spills.push(spill(el, r, isText ? n : null));
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
		...m.offenders.map((o) => `  · ${o.sel}  right=${o.right} width=${o.width}  ${JSON.stringify(o.text)}`),
		...m.spills.map((o) => `  ⇹ ${o.sel}  right=${o.right} width=${o.width}  ${JSON.stringify(o.text)}`)
	].join('\n');
}

/** All three arms of one surface's claim, off ONE reading. */
function assertReflows(label: string, m: Reading): void {
	const where = `${label} at ${VIEWPORT_W}px with root font-size ${SCALED_ROOT_FONT_SIZE}`;
	expect(m.scrollWidth, `${where} does not reflow (scrollWidth <= clientWidth)\n${detailOf(m)}`).toBeLessThanOrEqual(
		m.clientWidth
	);
	// A clean scroll width WITH elements past the right edge means the overflow is CLIPPED, not reflowed.
	expect(m.offenders, `${where} clips an element past the right edge\n${detailOf(m)}`).toHaveLength(0);
	expect(m.spills, `${where} spills an element out of its Button's box (⇹)\n${detailOf(m)}`).toHaveLength(0);
}

/** The unjoined `/` IS the join surface, and its six-box code entry is the widest fixed row on it. */
test('the join surface reflows at 320px with the text doubled', async ({ world, page }) => {
	void world;
	await page.goto('/');
	assertReflows('/', await measure(page, '/', '/', () => page.locator(SEL.appShell).waitFor({ state: 'attached' })));
});

/**
 * JOINED FIRST, because `/settings` answers 303 to an unjoined guest: this surface is only reachable from inside
 * the room. What gets measured is the ROOM SCOPE, which is what `/settings` resolves to now that the three scopes
 * are three routes — the deepest of the three and the one the gear opens, so it is still the worst case this claim
 * has to hold for. Its own `#queue-order` control is the readiness signal, where the old driver slept.
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

/**
 * THE YOU SCOPE, because a surface this claim does not visit is a surface it says nothing about — and that is not
 * hypothetical here: the room scope's door into the machine scope carried a second `Badge` for one build, and the
 * test above caught it overflowing by 9px. You was never measured at 320px before the settings split, because it
 * lived on a `Tabs.Content` the driver never opened; it carries the colour ring and the destructive confirm.
 *
 * THE NAME IS EDITED FIRST, because `Save and close` renders only while the draft is dirty: a clean arrival
 * measures a page without its one block row.
 */
test('/settings/you reflows at 320px with the text doubled', async ({ world, page }) => {
	await world.joinAs(page, 'ReflowYou');
	await page.goto('/settings/you');
	await page.locator(SEL.setting('profile-name')).fill('ReflowYou2');
	assertReflows(
		'/settings/you',
		await measure(page, '/settings/you', '/settings/you', () =>
			page.getByRole('button', { name: 'Save and close' }).waitFor({ state: 'visible' })
		)
	);
});

/**
 * THE MACHINE SCOPE, so all three settings routes are measured. Its `Advanced` trigger and `Processing metrics ·
 * internal` out-link are `size="block"` rows with a trailing note or Badge — the same shape as the room scope's
 * `Party stats · safe to share` door, whose Badge overhung its own box while the Button base's nowrap applied to
 * `block`.
 */
test('/settings/server reflows at 320px with the text doubled', async ({ world, page }) => {
	await world.joinAs(page, 'ReflowServer');
	await page.goto('/settings/server');
	assertReflows(
		'/settings/server',
		await measure(page, '/settings/server', '/settings/server', () =>
			page.locator(SEL.setting('engine')).waitFor({ state: 'attached' })
		)
	);
});

/**
 * THE ON DECK CARD, because its `Not yet — let Ana go first` row is the one `size="block"` label with no Badge to
 * move: only `whitespace-normal` can fold it, and without that it ran ~106px past the page. The card renders only
 * for the singer up next, so the room is driven the way `shot/on-deck.spec.ts` drives it: three phones, a fake
 * worker so the songs are ready, Theo singing, Maya next, Ana behind her.
 */
test('the On deck card reflows at 320px with the text doubled', async ({ world }) => {
	const worker = await startFakeWorker(world);
	try {
		const theo = await world.openPhone('Theo');
		const maya = await world.openPhone('Maya', { stop: 'End' });
		const ana = await world.openPhone('Ana');
		await readySong(world, theo, 'believin');
		await readySong(world, theo, 'caroline');
		await readySong(world, theo, 'prayer');
		await queueReady(theo, 'believin');
		await expect(theo.locator(SEL.npStripTitle)).toBeAttached();
		await queueReady(maya, 'caroline');
		await queueReady(ana, 'prayer');

		await maya.setViewportSize({ width: VIEWPORT_W, height: VIEWPORT_H });
		await openQueue(maya);
		const notYet = maya.locator('section[aria-label="On deck"]').getByRole('button', { name: /^Not yet/ });
		assertReflows(
			'/queue (On deck)',
			await measure(maya, '/queue (On deck)', '/queue', () => notYet.waitFor({ state: 'visible' }))
		);
	} finally {
		await worker.stop();
	}
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
