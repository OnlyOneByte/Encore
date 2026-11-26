// #1328: a load line that waits out the 300 ms grace still reaches a screen reader. Its live region is in the
// accessibility tree, empty, from the first frame, and its words are written in as text past the grace, the pattern
// that is announced (a region that appears with its words already in it often is not). Each wait is slowed so the line
// shows, and the screen holds still (CLS 0) at 390 and 320.
import { test, expect } from '../../world/fixtures';
import type { Page } from '@playwright/test';

/** Records, per selector, when the element first existed (with its text and whether it was in the a11y tree), and
 *  when it first held `want`; plus every layout shift. From document start, every frame. */
function watch(spec: { sel: string; want: string }) {
	const w = window as unknown as {
		__line: { at?: number; text?: string; inTree?: boolean; saidAt?: number; cls: number };
	};
	w.__line = { cls: 0 };
	new PerformanceObserver((l) => {
		for (const e of l.getEntries() as unknown as { value: number }[]) w.__line.cls += e.value;
	}).observe({ type: 'layout-shift', buffered: true });
	const tick = () => {
		const el = document.querySelector(spec.sel);
		const L = w.__line;
		if (el && L.at === undefined) {
			L.at = performance.now();
			L.text = (el.textContent ?? '').trim();
			// In the tree: not hidden from it by `visibility`, `display` or `aria-hidden` on it or an ancestor.
			L.inTree = el.checkVisibility({ visibilityProperty: true }) && !el.closest('[aria-hidden="true"]');
		}
		if (el && L.saidAt === undefined && (el.textContent ?? '').trim() === spec.want) L.saidAt = performance.now();
		requestAnimationFrame(tick);
	};
	tick();
}

type Line = { at?: number; text?: string; inTree?: boolean; saidAt?: number; cls: number };
const line = (page: Page) => page.evaluate(() => (window as unknown as { __line: Line }).__line);

for (const [width, height] of [
	[390, 844],
	[320, 568]
] as const) {
	test(`"Finding the room…" is in the tree before its words, and is announced as text (${width})`, async ({
		world,
		browser
	}) => {
		const ctx = await browser.newContext({ viewport: { width, height }, baseURL: world.baseURL });
		try {
			const page = await ctx.newPage();
			await page.addInitScript(watch, { sel: 'p.confirm[role="status"]', want: 'Finding the room…' });
			// A slow room lookup, so the line has to show.
			await page.route('**/api/room-preview**', async (route) => {
				await new Promise((r) => setTimeout(r, 1_500));
				await route.continue();
			});
			await page.goto(`/?room=${world.code}`);
			await expect.poll(async () => (await line(page)).saidAt, { timeout: 5_000 }).toBeDefined();
			const l = await line(page);
			expect(l.text, 'the region mounted already holding its words').toBe('');
			expect(l.inTree, 'the region was hidden from the accessibility tree before its words').toBe(true);
			expect(l.saidAt! - l.at!, 'the words were written in before the grace').toBeGreaterThanOrEqual(250);
			// The name field still arrives, in the same box, and nothing on the screen moved.
			await expect(page.getByLabel('Your name')).toBeVisible({ timeout: 10_000 });
			expect((await line(page)).cls, 'layout shift while the room was found').toBe(0);
		} finally {
			await ctx.close();
		}
	});

	test(`"Loading the queue…" goes into the polite region as text past the grace, then away (${width})`, async ({
		world
	}) => {
		const phone = await world.openPhone(`Q${width}`);
		await phone.setViewportSize({ width, height });
		await phone.addInitScript(watch, { sel: '.sr-live[role="status"]', want: 'Loading the queue…' });
		// A slow first sync, so the skeleton has to show.
		await phone.routeWebSocket(/\/ws/, (ws) => {
			const server = ws.connectToServer();
			const opened = Date.now();
			server.onMessage((m) => {
				const wait = opened + 1_500 - Date.now();
				if (wait > 0) setTimeout(() => ws.send(m), wait);
				else ws.send(m);
			});
			ws.onMessage((m) => server.send(m));
		});
		await phone.goto('/queue');
		await expect.poll(async () => (await line(phone)).saidAt, { timeout: 5_000 }).toBeDefined();
		const l = await line(phone);
		expect(l.text, 'the polite region mounted already holding the words').toBe('');
		expect(l.inTree, 'the polite region was hidden from the accessibility tree').toBe(true);
		expect(l.saidAt! - l.at!, 'the words were written in before the grace').toBeGreaterThanOrEqual(250);
		await expect(phone.locator('.skels')).toBeVisible();
		// The sync lands: the list (here, the empty state) replaces the skeleton and the words go.
		await expect(phone.getByText('Nothing queued yet')).toBeVisible({ timeout: 10_000 });
		await expect(phone.locator('.sr-live[role="status"]')).toHaveText('');
		expect((await line(phone)).cls, 'layout shift while the queue loaded').toBe(0);
	});
}
