// P34 PR 5: the Up next board. The host sets a copy to Up next, and mid-song it shows who is singing, the next turns in
// their colours and a big QR with the room code, and never the words; the TV itself always shows everything, and a
// copy that takes the seat switches to everything. `SHOT_DIR=<dir>` writes the frames.
import { test, expect } from '../../world/fixtures';
import { startFakeWorker } from '../../world/workers';
import { readySong, queueReady } from '../../world/actors';
import type { Browser, Page } from '@playwright/test';
import type { World } from '../../world/fixtures';

async function openScreen(browser: Browser, world: World, real = false, w = 1920, h = 1080, q = ''): Promise<Page> {
	const ctx = await browser.newContext({ viewport: { width: w, height: h }, baseURL: world.baseURL });
	if (real) await ctx.addCookies([world.tvCookie]);
	const page = await ctx.newPage();
	await page.goto(`/tv?room=${encodeURIComponent(world.code)}${q}`);
	await page.locator('.status.on').waitFor({ state: 'attached', timeout: 15_000 });
	return page;
}
const shot = async (page: Page, name: string) => {
	if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png` });
};
type Row = { id: string; name: string; isTv: boolean; show: string };
const rows = async (host: Page): Promise<Row[]> => (await (await host.request.get('/api/screens')).json()).screens;

test('Up next: the host sets it, and the copy shows who sings, the next turns and the QR, never the words', async ({
	browser,
	world
}) => {
	test.setTimeout(180_000);
	const worker = await startFakeWorker(world, { seconds: 60 });
	try {
		const tv = await openScreen(browser, world, true);
		const copy = await openScreen(browser, world);
		const phoneCopy = await openScreen(browser, world, false, 390, 844);
		const ana = await world.openPhone('Ana');
		const theo = await world.openPhone('Theo');
		const bo = await world.openPhone('Bo');
		const host = await world.openPhone('Host');
		await world.becomeHost(host);
		await readySong(world, ana, 'caroline');
		await readySong(world, theo, 'bohemian');
		await readySong(world, bo, 'believin');
		await queueReady(ana, 'caroline');
		await queueReady(theo, 'bohemian');
		await queueReady(bo, 'believin');
		await expect(copy.locator('.lower-third')).toContainText(/Ana/, { timeout: 30_000 });

		// The host's control has three choices on each copy.
		await host.goto('/settings/screens');
		const all = await rows(host);
		const copyRow = all.find((r) => !r.isTv && r.name === 'Screen 2')!;
		const phoneRow = all.find((r) => !r.isTv && r.name === 'Screen 3')!;
		const picker = host.getByRole('radiogroup', { name: `What ${copyRow.name} shows` });
		await expect(picker.getByRole('radio')).toHaveText(['Everything', 'Words only', 'Up next']);
		const t0 = Date.now();
		await picker.getByRole('radio', { name: 'Up next' }).click();

		// Within a second: the board, and none of the stage.
		const board = copy.locator('.board');
		await expect(board).toBeVisible({ timeout: 1_000 });
		console.log(`P34BOARD applied in ${Date.now() - t0} ms`);
		await expect(copy.locator('.lyrics')).toHaveCount(0);
		await expect(copy.locator('.lower-third')).toHaveCount(0);
		await expect(copy.locator('.stage-join')).toHaveCount(0);
		await expect(copy.locator('.stage-bg')).not.toHaveClass(/shown/);
		await expect(board.locator('.now')).toContainText(/^Ana - \S/);
		await expect(board.locator('li b')).toHaveText(['Theo', 'Bo']);
		await expect(board.locator('img.qr')).toBeVisible();
		await expect(board.locator('.code')).toHaveText(world.code);
		await expect(picker.getByRole('radio', { name: 'Up next' })).toHaveAttribute('aria-checked', 'true');
		// The TV is untouched.
		await expect(tv.locator('.lower-third')).toBeVisible();
		await expect(tv.locator('.board')).toHaveCount(0);
		await shot(copy, 'board-1920');

		// A phone-shaped copy stacks the QR under the turns.
		await host.request.post('/api/screens', { data: { action: 'show', id: phoneRow.id, show: 'board' } });
		await expect(phoneCopy.locator('.board')).toBeVisible({ timeout: 5_000 });
		const qr = (await phoneCopy.locator('img.qr').boundingBox())!;
		const list = (await phoneCopy.locator('.board ol').boundingBox())!;
		expect(qr.y, 'the QR is under the turns on a phone').toBeGreaterThan(list.y + list.height - 1);
		expect(qr.x + qr.width).toBeLessThanOrEqual(390);
		await shot(phoneCopy, 'board-390');
		// The page's poll shows the change it did not make.
		await expect(
			host.getByRole('radiogroup', { name: `What ${phoneRow.name} shows` }).getByRole('radio', { name: 'Up next' })
		).toHaveAttribute('aria-checked', 'true', { timeout: 5_000 });
		await host.setViewportSize({ width: 390, height: 844 });
		await shot(host, 'screens-board-390');
		await host.setViewportSize({ width: 320, height: 568 });
		await shot(host, 'screens-board-320');
		// At 320 every choice is a 44 px tap whose label keeps one line inside the control (in a Spotlight, too narrow
		// for three across, they stack).
		const fit = await picker.evaluate((g) => {
			const bs = [...g.querySelectorAll('button')];
			const box = g.getBoundingClientRect();
			return {
				tops: new Set(bs.map((b) => Math.round(b.getBoundingClientRect().top))).size,
				minH: Math.min(...bs.map((b) => b.getBoundingClientRect().height)),
				labelLines: Math.max(...bs.map((b) => b.querySelector('span')!.getClientRects().length)),
				inside: bs.every((b) => b.getBoundingClientRect().right <= box.right + 0.5)
			};
		});
		console.log(`P34BOARD 320 picker rows: ${fit.tops}`);
		expect({ labelLines: fit.labelLines, inside: fit.inside }).toEqual({ labelLines: 1, inside: true });
		expect(fit.minH).toBeGreaterThanOrEqual(44);

		// The TV refuses it.
		const tvId = all.find((r) => r.isTv)!.id;
		const onTv = await host.request.post('/api/screens', { data: { action: 'show', id: tvId, show: 'board' } });
		expect(onTv.status()).toBe(409);
		// A bookmarked `/tv?show=board` opens as the board.
		const bookmarked = await openScreen(browser, world, false, 1920, 1080, '&show=board');
		await expect(bookmarked.locator('.board')).toBeVisible({ timeout: 10_000 });

		// Promoted, the copy shows everything.
		await copy.mouse.click(1918, 540);
		await copy.waitForTimeout(700);
		await copy.locator('.copy-claim').click();
		await expect(copy.locator('.lower-third')).toBeVisible({ timeout: 5_000 });
		await expect(copy.locator('.board')).toHaveCount(0);
		await expect.poll(async () => (await rows(host)).find((r) => r.id === copyRow.id)?.show).toBe('everything');
	} finally {
		await worker.stop();
	}
});
