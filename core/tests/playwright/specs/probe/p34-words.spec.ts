// P34 PR 4: Words only. The host sets a copy to show the words alone, bigger, with who is next and nothing else (no
// lower-third, join corner, reactions or background); a `/tv?show=words` bookmark opens as one; the TV itself always
// shows everything, and a copy that takes the seat switches to everything. `SHOT_DIR=<dir>` writes the frames.
import { test, expect } from '../../world/fixtures';
import { startFakeWorker } from '../../world/workers';
import { readySong, queueReady } from '../../world/actors';
import type { Browser, Page } from '@playwright/test';
import type { World } from '../../world/fixtures';

async function openScreen(browser: Browser, world: World, real = false, query = ''): Promise<Page> {
	const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, baseURL: world.baseURL });
	if (real) await ctx.addCookies([world.tvCookie]);
	const page = await ctx.newPage();
	await page.goto(`/tv?room=${encodeURIComponent(world.code)}${query}`);
	await page.locator('.status.on').waitFor({ state: 'attached', timeout: 15_000 });
	return page;
}
const shot = async (page: Page, name: string) => {
	if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png` });
};
type Row = { id: string; name: string; isTv: boolean; show: 'everything' | 'words' };
const rows = async (host: Page): Promise<Row[]> => (await (await host.request.get('/api/screens')).json()).screens;
const lyricPx = (p: Page) =>
	p.locator('.lyrics .row.current').evaluate((e) => parseFloat(getComputedStyle(e).fontSize));

test('Words only: the host sets it, the copy shows the words alone and who is next, and the TV never does', async ({
	browser,
	world
}) => {
	test.setTimeout(180_000);
	const worker = await startFakeWorker(world, { seconds: 60 });
	try {
		const tv = await openScreen(browser, world, true);
		const copy = await openScreen(browser, world);
		const ana = await world.openPhone('Ana');
		const theo = await world.openPhone('Theo');
		const host = await world.openPhone('Host');
		await world.becomeHost(host);
		await readySong(world, ana, 'caroline');
		await readySong(world, theo, 'bohemian');
		await queueReady(ana, 'caroline');
		await queueReady(theo, 'bohemian');
		await expect(copy.locator('.lyrics .row.current')).toBeVisible({ timeout: 30_000 });
		const tvPx = await lyricPx(tv);

		// The host's control: on each copy, not on the TV.
		await host.goto('/settings/screens');
		const [tvRow, copyRow] = await rows(host);
		expect(tvRow!.isTv).toBe(true);
		await expect(host.getByRole('radiogroup', { name: `What ${tvRow!.name} shows` })).toHaveCount(0);
		const picker = host.getByRole('radiogroup', { name: `What ${copyRow!.name} shows` });
		await expect(picker.getByRole('radio', { name: 'Everything' })).toHaveAttribute('aria-checked', 'true');
		const t0 = Date.now();
		await picker.getByRole('radio', { name: 'Words only' }).click();

		// Within a second the copy is a singer's monitor: the words, bigger, and nothing else on the stage.
		await expect(copy.locator('.lower-third')).toHaveCount(0, { timeout: 1_000 });
		console.log(`P34WORDS applied in ${Date.now() - t0} ms`);
		await expect(copy.locator('.stage-join')).toHaveCount(0);
		await expect(copy.locator('.stage-bg')).not.toHaveClass(/shown/);
		expect(await lyricPx(copy), 'the words are ~1.7x the TV').toBeGreaterThan(tvPx * 1.6);
		// Who is next, once the copy's chip has gone to sleep (they share the top-right corner).
		await expect(copy.locator('.words-next')).toHaveText(/Theo\s+is next/, { timeout: 40_000 });
		await expect(picker.getByRole('radio', { name: 'Words only' })).toHaveAttribute('aria-checked', 'true');
		// The TV is untouched.
		await expect(tv.locator('.lower-third')).toBeVisible();
		await shot(copy, 'words-1920');
		await host.setViewportSize({ width: 390, height: 844 });
		await shot(host, 'screens-words-390');
		await host.setViewportSize({ width: 320, height: 568 });
		await shot(host, 'screens-words-320');

		// The API refuses words only on the TV, and anything that is not a layout.
		const onTv = await host.request.post('/api/screens', { data: { action: 'show', id: tvRow!.id, show: 'words' } });
		expect(onTv.status()).toBe(409);
		const bad = await host.request.post('/api/screens', { data: { action: 'show', id: copyRow!.id, show: 'board' } });
		expect(bad.status()).toBe(400);
		const guest = await ana.request.post('/api/screens', { data: { action: 'show', id: copyRow!.id, show: 'words' } });
		expect(guest.status()).toBe(403);

		// A bookmarked `/tv?show=words` opens as Words only.
		const bookmarked = await openScreen(browser, world, false, '&show=words');
		await expect.poll(async () => (await rows(host)).filter((r) => r.show === 'words').length).toBe(2);
		await expect(bookmarked.locator('.lower-third')).toHaveCount(0, { timeout: 10_000 });

		// Promoted, the copy shows everything: the room's stage always shows the whole night.
		await copy.mouse.click(1918, 540);
		await copy.waitForTimeout(700);
		await copy.locator('.copy-claim').click();
		await expect(copy.locator('.lower-third')).toBeVisible({ timeout: 5_000 });
		await expect.poll(async () => (await rows(host)).find((r) => r.id === copyRow!.id)?.show).toBe('everything');
		await expect(copy.locator('.words-next')).toHaveCount(0);
	} finally {
		await worker.stop();
	}
});
