// P34 PR 3: the host's Screens page lists every /tv open in the room, the TV first. The host names a screen, makes
// one the TV between songs (mid-song a screen becomes the TV only when tapped on it), and removes one, which then says
// so and can be opened again. A copy's row says how far it runs from the TV. Guests get 403, and a room holds at
// most MAX_TV_SCREENS screens. `SHOT_DIR=<dir>` writes the page at 390 and 320 and a removed screen at 1920.
import { test, expect } from '../../world/fixtures';
import { startFakeWorker } from '../../world/workers';
import { readySong, queueReady } from '../../world/actors';
import { MAX_TV_SCREENS, TV_FULL_CLOSE_CODE } from '../../../../src/lib/contract';
import { MAX_COOKIELESS_SCREENS } from '../../../../src/lib/server/rooms/tv-screens';
import type { Browser, Page } from '@playwright/test';
import type { World } from '../../world/fixtures';

/** A /tv on its own context. `real` carries the world's seat cookie; any other gets its own from GET /tv. */
async function openScreen(browser: Browser, world: World, real = false, w = 1920, h = 1080): Promise<Page> {
	const ctx = await browser.newContext({ viewport: { width: w, height: h }, baseURL: world.baseURL });
	if (real) await ctx.addCookies([world.tvCookie]);
	const page = await ctx.newPage();
	await page.goto(`/tv?room=${encodeURIComponent(world.code)}`);
	await page.locator('.status.on').waitFor({ state: 'attached', timeout: 15_000 });
	return page;
}
const shot = async (page: Page, name: string) => {
	if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png` });
};
type Row = { id: string; name: string; isTv: boolean; driftMs: number | null; isNew: boolean; canBeTv: boolean };
const rows = async (host: Page): Promise<Row[]> => (await (await host.request.get('/api/screens')).json()).screens;
const row = (host: Page, name: string) => host.locator('section', { hasText: name }).first();

test('the host sees, names, swaps and removes the screens, and a guest cannot', async ({ browser, world }) => {
	test.setTimeout(180_000);
	const worker = await startFakeWorker(world, { seconds: 60 });
	try {
		const tv = await openScreen(browser, world, true);
		const a = await openScreen(browser, world);
		const b = await openScreen(browser, world);
		const ana = await world.openPhone('Ana');
		const guest = await world.openPhone('Bo');
		const host = await world.openPhone('Host');
		await world.becomeHost(host);

		// A guest is refused both ways.
		expect((await guest.request.get('/api/screens')).status()).toBe(403);
		const denied = await guest.request.post('/api/screens', { data: { action: 'remove', id: 'x' } });
		expect(denied.status()).toBe(403);

		await host.goto('/settings/screens');
		await expect(host.locator('h2', { hasText: 'Screen' })).toHaveCount(3, { timeout: 10_000 });
		const [first, ...copies] = await rows(host);
		expect(first).toMatchObject({ isTv: true, name: 'Screen 1' });
		expect(copies.map((c) => c.name)).toEqual(['Screen 2', 'Screen 3']);
		await expect(host.getByText('The TV · sound')).toBeVisible();
		// The two copies just opened: each is a Spotlight until named.
		await expect(host.locator('[data-moment="idle"]')).toHaveCount(2);
		await expect(host.getByText(/To add a screen, open .+\/tv on it\./)).toBeVisible();

		// Between songs the host can hand the seat to a copy, and back.
		await row(host, 'Screen 2').getByRole('button', { name: 'Make this the TV' }).click();
		await expect.poll(async () => (await rows(host))[0]!.name).toBe('Screen 2');
		await expect(tv.locator('.copy-chip')).toBeAttached();
		await expect(a.locator('.copy-chip')).toHaveCount(0);
		await row(host, 'Screen 1').getByRole('button', { name: 'Make this the TV' }).click();
		await expect.poll(async () => (await rows(host))[0]!.name).toBe('Screen 1');

		// A name sticks to the screen through a reload.
		await row(host, 'Screen 3').getByRole('button', { name: 'Rename' }).click();
		await host.getByLabel('Name for Screen 3').fill('  Kitchen  ');
		await host.getByRole('button', { name: 'Save' }).click();
		await expect(host.locator('h2', { hasText: 'Kitchen' })).toBeVisible();
		await b.reload();
		await expect.poll(async () => (await rows(host)).map((r) => r.name)).toContain('Kitchen');

		// Mid-song: copies report their drift, and the seat moves only by a tap on the screen itself.
		await readySong(world, ana, 'caroline');
		// At the edge: in the lobby a copy's "Make this the TV" sits mid-screen, in the QR's place.
		for (const p of [tv, a, b]) await p.mouse.click(1918, 540);
		await queueReady(ana, 'caroline');
		await expect(row(host, 'Kitchen').getByText(/Quiet · (\d+ ms (behind|ahead)|in step)/)).toBeVisible({
			timeout: 30_000
		});
		await expect(row(host, 'Screen 2').getByRole('button', { name: 'Make this the TV' })).toBeDisabled();
		await expect(
			host.getByText('While a song is on, a screen becomes the TV only when someone taps it there.')
		).toBeVisible();
		const midSong = await host.request.post('/api/screens', { data: { action: 'tv', id: copies[0]!.id } });
		expect(midSong.status()).toBe(409);
		expect((await midSong.json()).reason).toBe('mid-song');
		for (const [w, h] of [
			[390, 844],
			[320, 568]
		]) {
			await host.setViewportSize({ width: w, height: h });
			await host.evaluate(() => window.scrollTo(0, 0));
			await shot(host, `screens-${w}`);
			await host.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
			await shot(host, `screens-${w}-end`);
		}

		// The TV cannot be removed; a copy can, says so, and comes back as a new screen when opened again.
		const tvRemove = await host.request.post('/api/screens', { data: { action: 'remove', id: first!.id } });
		expect(tvRemove.status()).toBe(409);
		await row(host, 'Kitchen').getByRole('button', { name: 'Remove' }).click();
		await expect(b.locator('.shut-line')).toHaveText('This screen was removed', { timeout: 5_000 });
		await expect(b.locator('p.vh[role="status"]')).toHaveText('This screen was removed');
		await expect(host.getByText(/Kitchen was removed/)).toBeVisible();
		await expect.poll(async () => (await rows(host)).map((r) => r.name)).not.toContain('Kitchen');
		// It stays down: no redial brings it back on its own.
		await b.waitForTimeout(2_000);
		expect((await rows(host)).length).toBe(2);
		await shot(b, 'removed-1920');
		await b.getByRole('button', { name: 'Open again' }).click();
		await expect.poll(async () => (await rows(host)).filter((r) => r.isNew).map((r) => r.name)).toContain('Screen 3');
		await expect(tv.locator('.lower-third')).toContainText(/Ana/);

		// One screen too many is turned away and says so; the TV itself always gets back in.
		const more: Page[] = [];
		while ((await rows(host)).length < MAX_TV_SCREENS) more.push(await openScreen(browser, world));
		const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, baseURL: world.baseURL });
		const extra = await ctx.newPage();
		await extra.goto(`/tv?room=${encodeURIComponent(world.code)}`);
		await expect(extra.locator('.shut-line')).toHaveText('This room has all the screens it can show', {
			timeout: 10_000
		});
		expect((await rows(host)).length).toBe(MAX_TV_SCREENS);
		await tv.reload();
		await expect(tv.locator('.lower-third')).toContainText(/Ana/, { timeout: 15_000 });
		await expect(tv.locator('.shut-out')).toHaveCount(0);
		await expect.poll(async () => (await rows(host))[0]!.isTv).toBe(true);
	} finally {
		await worker.stop();
	}
});

/** A cookieless role=tv socket from a script: no Origin, no cookie. Resolves with its close code, if any. */
function rawTv(world: World) {
	const ws = new WebSocket(`${world.baseURL.replace(/^http/, 'ws')}/ws?role=tv&room=${encodeURIComponent(world.code)}`);
	// A refused socket opens first and is closed at once (the cap runs in the server's `open`), so "open" means it
	// was still open a second later.
	const opened = new Promise<'open'>((r) => ws.addEventListener('open', () => setTimeout(() => r('open'), 1_000)));
	const closed = new Promise<number>((r) => ws.addEventListener('close', (e) => r(e.code)));
	return { ws, outcome: Promise.race([opened, closed]) };
}

// The review of #1204: a script fills the room with cookieless sockets, the TV is off past the seat wait (the seat goes
// free), and the TV comes back. It must get in and take the seat.
test('cookieless sockets cannot fill the room against the TV, even after its seat has lapsed', async ({
	browser,
	world
}) => {
	test.setTimeout(180_000);
	const tv = await openScreen(browser, world, true);
	const host = await world.openPhone('Host');
	await world.becomeHost(host);
	const socks = [];
	for (let i = 0; i < MAX_TV_SCREENS; i++) socks.push(rawTv(world));
	const outcomes = await Promise.all(socks.map((s) => s.outcome));
	// They fill their own pool and no more: the rest are turned away as one too many.
	expect(outcomes.filter((o) => o === 'open')).toHaveLength(MAX_COOKIELESS_SCREENS);
	expect(outcomes.filter((o) => o === TV_FULL_CLOSE_CODE)).toHaveLength(MAX_TV_SCREENS - MAX_COOKIELESS_SCREENS);
	await tv.context().close();
	await host.waitForTimeout(1_000);
	const topUp = rawTv(world);
	socks.push(topUp);
	expect(await topUp.outcome).toBe(TV_FULL_CLOSE_CODE);
	// Past the seat's wait (TV_SEAT_SLOW_BOOT_MS, 60 s): the seat is free now.
	await host.waitForTimeout(70_000);
	const back = await openScreen(browser, world, true);
	await expect(back.locator('.shut-out')).toHaveCount(0);
	await expect.poll(async () => (await rows(host)).find((r) => r.isTv)?.canBeTv ?? false).toBe(true);
	await expect(back.locator('.copy-chip')).toHaveCount(0);
	for (const s of socks) s.ws.close();
});

/** One cold load of the Screens page, as the host: its layout shift (excluding input-led shifts) and when the
 *  first row was in the DOM, in ms from navigation start. */
async function coldLoad(browser: Browser, world: World, host: Page, cpu: number) {
	const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL: world.baseURL });
	await ctx.addCookies(await host.context().cookies());
	const page = await ctx.newPage();
	await page.addInitScript(() => {
		const w = window as unknown as { __cls: number; __firstRow: number | null };
		w.__cls = 0;
		w.__firstRow = null;
		new PerformanceObserver((l) => {
			for (const e of l.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[])
				if (!e.hadRecentInput) w.__cls += e.value;
		}).observe({ type: 'layout-shift', buffered: true });
		new MutationObserver((_, mo) => {
			if (document.querySelector('main section h2, main [data-moment] h2')) {
				w.__firstRow = performance.now();
				mo.disconnect();
			}
		}).observe(document, { subtree: true, childList: true });
	});
	if (cpu > 1) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: cpu });
	await page.goto('/settings/screens');
	await expect(page.locator('main h2').first()).toBeVisible();
	await page.waitForTimeout(2_500);
	const m = await page.evaluate(() => {
		const w = window as unknown as { __cls: number; __firstRow: number | null };
		return { cls: w.__cls, firstRowMs: w.__firstRow };
	});
	await ctx.close();
	return m;
}

test('the Screens page arrives with its list: no layout shift on 8 cold loads', async ({ browser, world }) => {
	test.setTimeout(180_000);
	await openScreen(browser, world, true);
	await openScreen(browser, world);
	const host = await world.openPhone('Host');
	await world.becomeHost(host);
	const runs: { cpu: number; cls: number; firstRowMs: number | null }[] = [];
	for (const cpu of [1, 1, 1, 1, 4, 4, 4, 4]) runs.push({ cpu, ...(await coldLoad(browser, world, host, cpu)) });
	console.log(
		'P34SCREENSLOAD ' + JSON.stringify(runs.map((r) => ({ ...r, firstRowMs: Math.round(r.firstRowMs ?? -1) })))
	);
	for (const r of runs) expect(r.cls, `CLS on a cold load at ${r.cpu}x`).toBe(0);
});
