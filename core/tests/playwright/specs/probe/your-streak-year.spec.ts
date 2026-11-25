// Proposal 29 PR 5's screens: Theo sings Sweet Caroline on two nights in a row, through the real recording path. His
// second night's cover says "2nd night in a row", and the You tab's year says 2 nights, 2 songs, and Sweet Caroline as
// his most sung. A phone in another zone asks for its own year with `?tz=`. Maya, who sang on neither night, sees no
// year and no streak of his. Frames at 390 and 320.
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, expect } from '../../world/fixtures';
import { startFakeWorker } from '../../world/workers';
import { queueReady, transportTap } from '../../world/actors';
import { serverPlayback } from './audio-probe-support';
import type { Page, TestInfo } from '@playwright/test';
import type { World } from '../../world/fixtures';

// A file-backed DB, so the first night can be moved into the past between the two.
test.use({ coreEnv: { ENCORE_EPHEMERAL: '0' } });
test.setTimeout(240_000);

const current = async (world: World) => (await serverPlayback(world.baseURL)).state.currentEntryId;

async function readySong(world: World, phone: Page, query: string): Promise<void> {
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
}

/** One song, sung and skipped through, so it lands in the singer's night. */
async function singOne(world: World, phone: Page) {
	await queueReady(phone, 'caroline');
	await expect.poll(() => current(world), { timeout: 30_000 }).not.toBeNull();
	await transportTap(phone, 'skip');
	await expect.poll(() => current(world), { timeout: 15_000 }).toBeNull();
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
	await page.waitForFunction(() =>
		document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity)
	);
	await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

test('Theo’s streak on his cover and his year on the You tab, his alone, in his phone’s zone', async ({
	world,
	browser
}, testInfo) => {
	const worker = await startFakeWorker(world);
	try {
		const theo = await world.openPhone('Theo');
		const maya = await world.openPhone('Maya');
		await readySong(world, theo, 'caroline');
		const tv = await world.openTv();
		await singOne(world, theo);
		await tv.close();

		// Night one moves 7 hours back, past the 6-hour gap, so the next song starts night two.
		await world.core.restart(() => {
			const db = new DatabaseSync(join(world.core.dataDir, 'encore.sqlite'));
			try {
				const h7 = 7 * 3_600_000;
				expect(db.prepare('SELECT count(*) AS n FROM nights').get()).toEqual({ n: 1 });
				db.prepare('UPDATE nights SET started_at = started_at - ?, ended_at = ended_at - ?').run(h7, h7);
				db.prepare('UPDATE performances SET started_at = started_at - ?, ended_at = ended_at - ?').run(h7, h7);
			} finally {
				db.close();
			}
		});
		const tv2 = await world.openTv();
		await theo.reload();
		await singOne(world, theo);
		await tv2.close();

		// The You tab: two nights, and the year above them.
		await theo.goto('/settings/you');
		const card = theo.locator('#nights');
		await expect(card.getByRole('link', { name: /1 song/ })).toHaveCount(2);
		const year = card.locator('#your-year');
		await expect(year).toContainText(`Your ${new Date().getFullYear()}`);
		await expect(year).toContainText('2 nights · 2 songs');
		await expect(year).toContainText(/Most sung: .*caroline.*, 2 times/i);
		await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		await shot(theo, testInfo, 'you-year-390');
		await theo.setViewportSize({ width: 320, height: 568 });
		await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		await shot(theo, testInfo, 'you-year-320');
		await theo.setViewportSize({ width: 390, height: 844 });

		// The newest night's cover: the streak, and only on it; the first night is no streak.
		await card.getByRole('link').first().click();
		const cover = theo.locator('[data-slide="cover"]');
		await expect(cover).toContainText('1 song');
		await expect(cover).toContainText('2nd night in a row');
		await shot(theo, testInfo, 'night-streak-390');
		await theo.setViewportSize({ width: 320, height: 568 });
		await shot(theo, testInfo, 'night-streak-320');
		await theo.setViewportSize({ width: 390, height: 844 });
		await theo.goto('/settings/you');
		await card.getByRole('link').last().click();
		await expect(cover).toContainText('1 song');
		await expect(cover).not.toContainText('in a row');

		// The same phone in another zone asks for its own year, and gets the same two nights.
		const far = await browser.newContext({
			baseURL: world.baseURL,
			viewport: { width: 390, height: 844 },
			timezoneId: 'Pacific/Kiritimati'
		});
		try {
			await far.addCookies(await theo.context().cookies());
			const page = await far.newPage();
			const asked = page.waitForRequest((r) => r.url().includes('/api/me/nights?tz=Pacific%2FKiritimati'));
			await page.goto('/settings/you');
			await asked;
			await expect(page.locator('#your-year')).toContainText('2 nights · 2 songs');
		} finally {
			await far.close();
		}

		// Maya sang nothing: no year, no nights, and Theo's numbers nowhere.
		await maya.goto('/settings/you');
		await expect(maya.locator('#nights')).toContainText('Sing a song and your night shows up here.');
		await expect(maya.locator('#your-year')).toHaveCount(0);
		const api = (await maya.request.get('/api/me/nights').then((r) => r.json())) as {
			year: { nights: number; songs: number; mostSung: unknown };
		};
		expect(api.year).toMatchObject({ nights: 0, songs: 0, mostSung: null });

		// Delete my history takes the year with the list.
		await theo.goto('/settings/you');
		await card.getByRole('button', { name: 'Delete my history' }).click();
		await theo.getByRole('button', { name: 'Yes, delete it' }).click();
		await expect(card).toContainText('Sing a song and your night shows up here.');
		await expect(year).toHaveCount(0);
	} finally {
		await worker.stop();
	}
});
