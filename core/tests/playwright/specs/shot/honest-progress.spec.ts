// HONEST PROGRESS, driven for real: one song is made first so the room has history, then Maya sings a second one
// and her /queue card shows the bar moving with the percentage the worker reports and the time left that core
// works out from that history. The fake worker interleaves a timer keepalive's `pct: 0` between its real figures,
// the frame order that once ran the bar back every 10 s. Frames go to HONEST_PROGRESS_OUT (or the test's output
// dir): the phone at 390x844 and 320x700, the TV at 1920x1080, `bar-NNN.png` every 250 ms while the song cooks
// (the motion GIF is made from them), and the overdue card.
//
// The fixture tracks are 8 seconds long and the fake worker is quick, so the time left reads "under a minute".
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome, openQueue } from '../../world/actors';
import type { Page } from '@playwright/test';
import type { World } from '../../world/fixtures';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** One song made end to end, quickly, so the next one has a history to be timed against. */
async function makeHistory(world: World): Promise<void> {
	const quick = await startFakeWorker(world, { workerId: 'box', slowMs: 150, ranAsAsked: true });
	const theo = await world.openPhone('Theo');
	const first = await world.awaitDemoTrack('believin');
	expect((await theo.request.post('/api/process', { data: { mediaId: first.id } })).ok()).toBe(true);
	await expect
		.poll(
			async () => {
				const body = (await theo.request.get('/api/library').then((r) => r.json())) as {
					library: { id: string; lyricsRef?: string | null; instrumentalRef?: string | null }[];
				};
				return body.library.some((m) => m.id === first.id && !!m.instrumentalRef && !!m.lyricsRef);
			},
			{ timeout: 60_000, message: 'the history song never finished' }
		)
		.toBe(true);
	await quick.stop();
}

async function sing(maya: Page, world: World, query: string): Promise<void> {
	await world.awaitDemoTrack(query);
	await openBrowseFromHome(maya);
	await maya.locator(SEL.search).fill(query);
	await maya
		.locator(SEL.songRow)
		.filter({ hasText: new RegExp(query, 'i') })
		.locator(SEL.singAction)
		.first()
		.click();
	await openQueue(maya);
}

const outDir = (fallback: string): string => {
	const out = process.env.HONEST_PROGRESS_OUT ?? fallback;
	mkdirSync(out, { recursive: true });
	return out;
};

test('the processing card: a real percentage and the time left', async ({ world }, testInfo) => {
	test.setTimeout(180_000);
	const out = outDir(testInfo.outputDir);
	await makeHistory(world);

	const slow = await startFakeWorker(world, { workerId: 'box', slowMs: 3_000, keepaliveMs: 250, ranAsAsked: true });
	try {
		const maya = await world.openPhone('Maya');
		const tv = await world.openTv();
		await sing(maya, world, 'caroline');

		const card = maya.locator(SEL.processing).first();
		await expect(card).toContainText(/\d+% · under a minute/, { timeout: 30_000 });
		await maya.screenshot({ path: join(out, 'phone-390-processing.png') });
		await maya.setViewportSize({ width: 320, height: 700 });
		await card.screenshot({ path: join(out, 'card-320-processing.png') });
		await maya.setViewportSize({ width: 390, height: 844 });
		await tv.screenshot({ path: join(out, 'tv-while-processing.png') });
		// Until the song is ready and the card becomes a plain row.
		for (let i = 0; i < 200 && (await card.count()) > 0; i++) {
			await card
				.screenshot({ path: join(out, `bar-${String(i).padStart(3, '0')}.png`), timeout: 1_000 })
				.catch(() => {});
			await maya.waitForTimeout(250);
		}
	} finally {
		await slow.stop();
	}
});

test('a song well past its time says so, instead of "under a minute" for as long as it runs', async ({
	world
}, testInfo) => {
	// The history makes a separation take well under a second, so "overdue" is that plus the minute's grace.
	test.setTimeout(240_000);
	const out = outDir(testInfo.outputDir);
	await makeHistory(world);

	const slow = await startFakeWorker(world, { workerId: 'box', hang: 'stems', keepaliveMs: 2_000, ranAsAsked: true });
	try {
		const maya = await world.openPhone('Maya');
		const tv = await world.openTv();
		await sing(maya, world, 'caroline');
		const card = maya.locator(SEL.processing).first();
		const lobby = tv.locator(SEL.lobby);
		await expect(card).toContainText('under a minute', { timeout: 30_000 });
		await expect(lobby).toContainText('this takes a minute');
		await expect(card).toContainText('Taking longer than usual', { timeout: 120_000 });
		// The TV says the same thing, not "this takes a minute" while the phone says otherwise.
		await expect(lobby).toContainText('taking longer than usual', { timeout: 15_000 });
		await expect(lobby).not.toContainText('this takes a minute');
		await maya.screenshot({ path: join(out, 'phone-390-overdue.png') });
		await tv.screenshot({ path: join(out, 'tv-overdue.png') });
		await maya.setViewportSize({ width: 320, height: 700 });
		await card.screenshot({ path: join(out, 'card-320-overdue.png') });
	} finally {
		await slow.stop();
	}
});
