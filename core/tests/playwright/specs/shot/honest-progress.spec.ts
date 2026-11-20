// HONEST PROGRESS, driven for real: one song is made first so this box has history, then Maya sings a second one
// and her /queue card shows the bar moving with the percentage the worker reports and the time left that core
// works out from that history. Frames go to HONEST_PROGRESS_OUT (or the test's output dir): the phone at 390x844
// in both colour schemes, the TV at 1920x1080, and `bar-NNN.png`, one frame every 250 ms of the card while the
// song cooks, which is what the motion GIF is made from.
//
// The fixture tracks are 8 seconds long and the fake worker is quick, so the time left reads "under a minute".
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome, openQueue } from '../../world/actors';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

test('the processing card: a real percentage and the time left', async ({ world }, testInfo) => {
	test.setTimeout(180_000);
	const out = process.env.HONEST_PROGRESS_OUT ?? testInfo.outputDir;
	mkdirSync(out, { recursive: true });

	// The history: one song made end to end, quickly. One worker id for both runs: the ETA reads THIS box's history.
	const quick = await startFakeWorker(world, { workerId: 'box', slowMs: 150 });
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

	// The song being watched, slowly enough to see the bar move.
	const slow = await startFakeWorker(world, { workerId: 'box', slowMs: 3_000 });
	try {
		const maya = await world.openPhone('Maya');
		const tv = await world.openTv();
		await world.awaitDemoTrack('caroline');
		await openBrowseFromHome(maya);
		await maya.locator(SEL.search).fill('caroline');
		await maya
			.locator(SEL.songRow)
			.filter({ hasText: /caroline/i })
			.locator(SEL.singAction)
			.first()
			.click();
		await openQueue(maya);

		const card = maya.locator(SEL.processing).first();
		await expect(card).toContainText(/\d+% · under a minute/, { timeout: 30_000 });
		for (const scheme of ['dark', 'light'] as const) {
			await maya.emulateMedia({ colorScheme: scheme });
			await maya.screenshot({ path: join(out, `phone-processing-${scheme}.png`) });
		}
		await maya.emulateMedia({ colorScheme: 'dark' });
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
