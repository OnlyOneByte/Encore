// Measure the properties Tailwind's Preflight RESETS, on every element of every reachable surface, so a
// before/after answer is a diff rather than an opinion. Element identity across two runs is BY INDEX in
// document order, which holds only while the DOM is unchanged, so `tag` is recorded beside every row and
// preflight-diff.spec.ts refuses to compare runs whose tag sequence disagrees.
//
// WHAT THIS IS, HONESTLY. This is an EVIDENCE PRODUCER, not an assertion suite — the old probe's whole output
// was a JSON file (`preflight-reset-audit.mjs <outFile.json>`) that a human then fed to preflight-diff twice,
// once either side of a CSS change. Its exit code came from ONE condition: did any surface fail to be
// measured. That condition is what is asserted below, per surface, and the capture itself is attached to the
// report so the before/after workflow still has its artifact.
//
// It DOES belong in Playwright — every number here comes from `getComputedStyle` and `getBoundingClientRect`
// in a real layout engine, which is exactly what cannot be unit-tested. But by this repo's own project split
// it is closer to `shot` ("produces artifacts, CANNOT fail a build") than to `probe`, and it is filed under
// probe only because that is where its sibling lives. Flagged rather than moved.
//
// ONE TEST PER SURFACE, because a surface is independently falsifiable: a route that 500s, a gallery that was
// renamed, a session-gated page that fell back to the join screen. The old probe recorded a per-surface error
// and summed them into one exit code, which named nothing.
//
// THE 2500ms SETTLE IS GONE. It covered "fonts, the socket's first frame, and any mount-time style write
// (--dock-h etc.)" — three real conditions, so each is now waited for as a condition: `document.fonts.ready`,
// a per-surface readiness anchor, and for the socket-driven surfaces the anchor IS the socket (`.dock` on the
// phone, `.status.on` on the TV). A duration could only ever be too short or too long.
//
// RUN_TAG IS GONE TOO. It existed because several surfaces join, singer names are unique per room, and one
// long-lived server served every run — so a second run collided with the first at 409 and measured the join
// screen instead of the page. A core per test mints a fresh room, so the collision cannot happen.
//
// TWO SURFACES ARE DROPPED, NAMED: `gallery` and `gallery-wide`, both `/components`. That route is gated
// DEV-ONLY server-side (`src/routes/components/+page.server.ts` throws 404 when `!dev`) and this suite serves
// the BUILT app, so the surface does not exist in this environment at all — the capture would be of a 404
// page, reported as though the densest form surface had been measured. Dropped rather than skipped, on the
// same ruling frames.spec.ts records: a permanently-skipped test is indistinguishable from the rot it was
// meant to catch, so something that cannot be produced is absent and named here.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import type { Browser, Locator, Page } from '@playwright/test';
import type { World } from '../../world/fixtures';

// The properties Preflight writes, and nothing else — one per rule in Tailwind v4's preflight.css. A property
// NOT here is one Preflight does not touch, so a difference there is outside this probe's claim.
const PROPS = [
	'box-sizing',
	'margin-top',
	'margin-right',
	'margin-bottom',
	'margin-left',
	'padding-top',
	'padding-right',
	'padding-bottom',
	'padding-left',
	'border-top-width',
	'border-right-width',
	'border-bottom-width',
	'border-left-width',
	'border-top-style',
	'border-top-color',
	'border-radius',
	'font-size',
	'font-weight',
	'font-family',
	'line-height',
	'letter-spacing',
	'list-style-type',
	'display',
	'max-width',
	'height',
	'width',
	'color',
	'background-color',
	'appearance',
	'text-decoration-line',
	'resize',
	'vertical-align',
	'text-indent',
	'border-collapse',
	'tab-size',
	'opacity'
];

export interface ElementRow {
	i: number;
	tag: string;
	cls: string;
	/** x, y, width, height, rounded to 2dp. */
	rect: number[];
	s: Record<string, string>;
}

export interface SurfaceCapture {
	count: number;
	els: ElementRow[];
	scrollW: number;
	scrollH: number;
}

/**
 * Computed values PLUS box geometry: `box-sizing` and the margin reset do their damage as a MOVED BOX, not a
 * changed declaration, so the rects are what make "no visible change" a measurement. A TreeWalker, not a
 * universal query — this wants EVERY element, and a universal token has no anchor the contract can own.
 */
async function captureSurface(page: Page): Promise<SurfaceCapture> {
	return page.evaluate((props: string[]): SurfaceCapture => {
		const els: Element[] = [document.documentElement];
		const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
		while (walker.nextNode()) els.push(walker.currentNode as Element);
		const out: ElementRow[] = [];
		for (let i = 0; i < els.length; i++) {
			const el = els[i];
			const cs = getComputedStyle(el);
			const r = el.getBoundingClientRect();
			const s: Record<string, string> = {};
			for (const p of props) s[p] = cs.getPropertyValue(p);
			out.push({
				i,
				tag: el.tagName.toLowerCase(),
				// Svelte's scoping hash changes on any edit to the component, so it is stripped: it would
				// report every component as changed while nothing it renders moved.
				cls: (typeof el.className === 'string' ? el.className : '')
					.split(/\s+/)
					.filter((t) => t && !/^svelte-/.test(t))
					.join(' '),
				rect: [
					Math.round(r.x * 100) / 100,
					Math.round(r.y * 100) / 100,
					Math.round(r.width * 100) / 100,
					Math.round(r.height * 100) / 100
				],
				s
			});
		}
		return {
			count: els.length,
			els: out,
			scrollW: document.documentElement.scrollWidth,
			scrollH: document.documentElement.scrollHeight
		};
	}, PROPS);
}

interface Viewport {
	width: number;
	height: number;
}
const PHONE: Viewport = { width: 430, height: 860 };
const TV: Viewport = { width: 1920, height: 1080 };

interface Surface {
	name: string;
	url: string;
	vp: Viewport;
	/** A joined session, for the surfaces that redirect an anonymous visitor to the join gate. */
	join?: boolean;
	/** The condition that says this surface has PAINTED — never a duration. */
	ready(page: Page): Locator;
}

/**
 * Reachable by URL alone — no driving, no state machine — because two runs must produce the SAME population,
 * and a driven flow is where run-to-run divergence enters. `join: true` earns its one driven step because
 * `/settings` is the densest FORM surface and Preflight's form-control block is the half most likely to do
 * visible damage.
 */
const SURFACES: Surface[] = [
	{
		name: 'phone-home',
		url: '/',
		vp: PHONE,
		join: true,
		// The dock is chrome the joined home renders and the join screen does not, so it is both the readiness
		// signal and the proof the session took. NOT the strip inside it, which renders only when the room has
		// something to play — a virgin room here has nothing.
		ready: (page) => page.locator(SEL.dock)
	},
	{ name: 'phone-join', url: '/', vp: PHONE, ready: (page) => page.locator(SEL.pageHeading) },
	{
		name: 'settings',
		url: '/settings',
		vp: PHONE,
		join: true,
		// `/settings` IS the room scope — there is no tablist to wait on any more — so the readiness signal is the
		// first control of its first card, which is also what p15 waits on.
		ready: (page) => page.locator(SEL.setting('queue-order'))
	},
	// /stats loads in `+page.ts`, so the tiles ship with the document; one of them is still the ready signal,
	// it just marks hydration rather than a landed fetch.
	{ name: 'stats', url: '/stats', vp: PHONE, ready: (page) => page.locator(SEL.dashTileNumber).first() },
	// The whole page body is keyed on the fetched payload (`{#if !metrics} Loading… {:else}`), so the absence
	// of that word is precisely "the fetch landed".
	{ name: 'metrics', url: '/metrics', vp: PHONE, ready: (page) => page.getByText('Loading…') },
	{ name: 'tv', url: '/tv', vp: TV, ready: (page) => page.locator(SEL.tvConnected) }
];

/** `metrics` waits for a word to LEAVE; every other surface waits for its anchor to arrive. */
const WAITS_FOR_ABSENCE = new Set(['metrics']);

async function openSurface(surface: Surface, browser: Browser, world: World): Promise<Page> {
	if (!surface.join) {
		const context = await browser.newContext({ baseURL: world.baseURL, viewport: surface.vp });
		const page = await context.newPage();
		// /metrics is the host's, and every settings control is live only for the host.
		await world.becomeHost(page);
		return page;
	}
	// Joined through the real screen, then resized: the name is the surface's, so two joining surfaces in the
	// same room could not collide even if they shared one.
	const page = await world.openPhone(`Pf${surface.name.replace(/[^a-z]/gi, '')}`);
	await world.becomeHost(page);
	await page.setViewportSize(surface.vp);
	return page;
}

for (const surface of SURFACES) {
	test(`${surface.name} renders and every element's Preflight-reset properties are measurable`, async ({
		browser,
		world
	}, testInfo) => {
		const page = await openSurface(surface, browser, world);
		const response = await page.goto(surface.url);
		expect(
			response?.status() ?? 200,
			`${surface.name} (${surface.url}) did not serve — the surface cannot be measured at all`
		).toBeLessThan(400);

		if (WAITS_FOR_ABSENCE.has(surface.name)) await expect(surface.ready(page)).toHaveCount(0);
		else await expect(surface.ready(page).first()).toBeVisible();

		// A session-gated surface must never be measured as the join landing it fell back to. The old probe
		// threw here and counted it as a failed surface; this is the same condition, named.
		if (surface.join) {
			expect(
				new URL(page.url()).pathname,
				`${surface.name}: the join did not take, so ${surface.url} fell back to the join gate and the ` +
					`measurement would be of the wrong page`
			).toBe(surface.url);
		}

		// A webfont still swapping changes `font-family` and every box it sizes, which is half the property
		// list. A real condition, where the old probe's 2500ms was a guess at it.
		await page.evaluate(() => document.fonts.ready.then(() => true));

		const shot = await captureSurface(page);
		await testInfo.attach(`${surface.name}.json`, {
			body: JSON.stringify({ surface: surface.name, url: surface.url, vp: surface.vp, ...shot }, null, '\t'),
			contentType: 'application/json'
		});

		// The TreeWalker is seeded with documentElement, so a capture that does not start at <html> did not
		// walk the document it was pointed at.
		expect(shot.count, `${surface.name}: nothing was measured`).toBeGreaterThan(0);
		expect(shot.els[0]?.tag, `${surface.name}: the capture does not start at the document element`).toBe('html');
	});
}
