// P34 PR 4: Words only. The host sets a copy to show the words alone, bigger, with who is next and nothing else (no
// lower-third, join corner, reactions or background); a `/tv?show=words` bookmark opens as one; the TV itself always
// shows everything, and a copy that takes the seat switches to everything. `SHOT_DIR=<dir>` writes the frames.
import { test, expect } from '../../world/fixtures';
import { startFakeWorker } from '../../world/workers';
import { readySong, queueReady } from '../../world/actors';
import { putRoom } from '../../world/reactions';
import { sendPlayerCommand } from './audio-probe-support';
import type { Browser, Page } from '@playwright/test';
import type { World } from '../../world/fixtures';

async function openScreen(
	browser: Browser,
	world: World,
	real = false,
	query = '',
	viewport = { width: 1920, height: 1080 }
): Promise<Page> {
	const ctx = await browser.newContext({ viewport, baseURL: world.baseURL });
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

/** Where a screen's sung line and the next one sit, at rest: each inside the reel's box and the window, and no row
 *  sliced by either edge (a row partly in the box is a row cut in half). Null mid-glide, where rows are in motion. */
function fitOf(p: Page) {
	return p.evaluate(() => {
		const view = document.querySelector('.lyrics .viewport')?.getBoundingClientRect();
		const reel = document.querySelector('.lyrics .reel');
		const rows = [...document.querySelectorAll<HTMLElement>('.lyrics .row')];
		const cur = rows.findIndex((r) => r.classList.contains('current'));
		if (!view || !reel || cur < 0 || reel.getAnimations().length) return null;
		const box = (r: HTMLElement) => r.getBoundingClientRect();
		const top = Math.max(view.top, 0);
		const bottom = Math.min(view.bottom, innerHeight);
		const inside = (b: DOMRect) => b.top >= top - 0.5 && b.bottom <= bottom + 0.5;
		const cut = rows.findIndex((r) => {
			if (getComputedStyle(r).visibility === 'hidden') return false;
			const b = box(r);
			return b.bottom > top + 0.5 && b.top < bottom - 0.5 && !inside(b);
		});
		const sliced = cut >= 0;
		const slicedAt = sliced
			? `row ${cut - cur} by ${Math.round(Math.max(top - box(rows[cut]!).top, box(rows[cut]!).bottom - bottom))} px`
			: '';
		const next = rows[cur + 1];
		return {
			text: rows[cur]!.textContent?.trim() ?? '',
			cur: inside(box(rows[cur]!)),
			next: next ? inside(box(next)) : null,
			sliced,
			slicedAt,
			px: parseFloat(getComputedStyle(rows[cur]!).fontSize)
		};
	});
}

// The review of #1268 (M1): real-length lines at 1.7x wrapped, and the sung line was cut and the next one lost.
test('Words only fits the sung line and the next, real-length, at 1280 and 1920, at 100% and 300%, on the song offset', async ({
	browser,
	world
}) => {
	test.setTimeout(240_000);
	const worker = await startFakeWorker(world, { seconds: 60, longLyricLines: true });
	try {
		const tv = await openScreen(browser, world, true);
		const small = await openScreen(browser, world, false, '&show=words', { width: 1280, height: 720 });
		const large = await openScreen(browser, world, false, '&show=words', { width: 1920, height: 1080 });
		const ana = await world.openPhone('Ana');
		const host = await world.openPhone('Host');
		await world.becomeHost(host);
		await readySong(world, ana, 'caroline');
		const mediaId = (await world.awaitDemoTrack('caroline')).id;
		await queueReady(ana, 'caroline');
		await expect(small.locator('.lyrics .row.current')).toBeVisible({ timeout: 30_000 });
		await expect(small.locator('.lower-third')).toHaveCount(0);

		const sample = async (label: string) => {
			await sendPlayerCommand(ana, { cmd: 'restart' });
			await small.waitForTimeout(400);
			const seen: Record<
				string,
				{ cur: boolean; next: boolean | null; sliced: boolean; slicedAt: string; px: number }[]
			> = {};
			// Lines change every 0.8 s for 7 s and glide for 0.42 s: sample often, keeping the frames at rest.
			for (let i = 0; i < 40; i++) {
				for (const [name, p] of [
					['1280', small],
					['1920', large]
				] as const) {
					const f = await fitOf(p);
					if (f) (seen[name] ??= []).push(f);
				}
				await small.waitForTimeout(120);
			}
			for (const [name, fits] of Object.entries(seen)) {
				expect(fits.length, `${label} ${name}: the reel was sampled at rest`).toBeGreaterThanOrEqual(4);
				expect(fits.filter((f) => !f.cur).length, `${label} ${name}: the sung line left the view`).toBe(0);
				expect(fits.filter((f) => f.next === false).length, `${label} ${name}: the next line left the view`).toBe(0);
				expect(
					fits.filter((f) => f.next === true).length,
					`${label} ${name}: a next line was seen`
				).toBeGreaterThanOrEqual(2);
				const cuts = fits.filter((f) => f.sliced).map((f) => f.slicedAt);
				expect(cuts, `${label} ${name}: a row was sliced at an edge`).toEqual([]);
				console.log(`P34WORDSFIT ${label} ${name}: ${fits[0]!.px} px, ${fits.length} samples`);
			}
		};
		await putRoom(host, { lyricsScalePct: 100 });
		await sample('100%');
		await putRoom(host, { lyricsScalePct: 300 });
		await expect.poll(async () => (await fitOf(small))?.px ?? 0).toBeGreaterThan(0);
		await small.waitForTimeout(500);
		await sample('300%');
		if (process.env.SHOT_DIR) {
			await sendPlayerCommand(ana, { cmd: 'restart' });
			await small.waitForTimeout(1_700);
			await shot(small, 'words-long-1280-300');
			await shot(large, 'words-long-1920-300');
			await putRoom(host, { lyricsScalePct: 100 });
			await sendPlayerCommand(ana, { cmd: 'restart' });
			await small.waitForTimeout(1_700);
			await shot(small, 'words-long-1280-100');
			await shot(large, 'words-long-1920-100');
		}
		await putRoom(host, { lyricsScalePct: 100 });

		// The song's offset (Earlier, #1286) moves the words on Words only exactly as on the TV: half a second early,
		// most of a line, so a copy that ignored it would show another line much of the time.
		const nudge = await host.request.post('/api/lyrics-edit/offset', { data: { mediaId, offsetMs: -500 } });
		expect((await nudge.json()).offsetMs).toBe(-500);
		await sendPlayerCommand(ana, { cmd: 'restart' });
		await small.waitForTimeout(400);
		const sung = (p: Page) =>
			p.evaluate(() => document.querySelector('.lyrics .row.current')?.textContent?.trim() ?? '');
		let same = 0;
		let total = 0;
		for (let i = 0; i < 30; i++) {
			const [a, b] = await Promise.all([sung(tv), sung(small)]);
			if (a && b) {
				total++;
				if (a === b) same++;
			}
			await small.waitForTimeout(200);
		}
		console.log(`P34WORDSOFFSET same line ${same}/${total}`);
		expect(total).toBeGreaterThan(8);
		expect(same / total, 'Words only shows the line the TV shows, on the song offset').toBeGreaterThanOrEqual(0.85);
	} finally {
		await worker.stop();
	}
});
