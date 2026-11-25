// THE DOCK'S ONE PLAY (redesign step 4). Pause, restart and skip live on Queue's Now card, so the only transport
// key left in the dock is Play, for a room with nothing playing and a song that can start. The server starts the
// next song itself on any queue change, so the probe reaches that room the way a real one does: a reboot whose saved
// room names a playing entry that is gone, which boot heals to idle with a ready queue (state/store.ts `hydrate`).
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { queueReady, readySong } from '../../world/actors';

// A file-backed DB, so the queue survives the reboot.
test.use({ coreEnv: { ENCORE_EPHEMERAL: '0' } });

test('idle with a ready song: the dock offers Play alone in the Cheer key slot, and Play starts it', async ({
	world
}, testInfo) => {
	test.setTimeout(120_000);
	const worker = await startFakeWorker(world);
	const maya = await world.openPhone('Maya');
	try {
		await readySong(world, maya, 'caroline');
		await readySong(world, maya, 'believin');
	} finally {
		await worker.stop();
	}
	await queueReady(maya, 'caroline');
	await queueReady(maya, 'believin');
	await expect(maya.locator(SEL.npStripTitle)).toContainText(/caroline/i, { timeout: 20_000 });
	const playingDock = await maya.locator(SEL.dock).boundingBox();

	await world.core.restart(() => {
		const db = new DatabaseSync(join(world.core.dataDir, 'encore.sqlite'));
		try {
			expect(db.prepare(`SELECT count(*) AS n FROM queue_entries WHERE status = 'queued'`).get()).toEqual({ n: 1 });
			db.prepare(`DELETE FROM queue_entries WHERE status = 'playing'`).run();
		} finally {
			db.close();
		}
	});
	await maya.reload();

	await expect(maya.locator(SEL.npStripStatus)).toHaveText('Ready when you are', { timeout: 20_000 });
	// Play alone where the Cheer key sits: no pause, restart or skip, and no Cheer key with no song to cheer.
	await expect(maya.locator(SEL.npStripPlay)).toHaveCount(1);
	await expect(maya.locator('.dock .strip .tp .btn')).toHaveCount(1);
	await expect(maya.locator(SEL.dockTransport)).toHaveCount(0);
	await expect(maya.locator(SEL.npStripPlay)).toHaveAccessibleName('Play');
	expect(await maya.locator(SEL.dock).boundingBox(), 'the dock is the height it was with a song').toEqual(playingDock);
	for (const width of [390, 320]) {
		await maya.setViewportSize({ width, height: 844 });
		await maya.waitForTimeout(300);
		await maya.screenshot({ path: testInfo.outputPath(`dock-idle-play-${width}.png`) });
	}

	await maya.locator(SEL.npStripPlay).click();
	await expect(maya.locator(SEL.npStripTitle)).toContainText(/believin/i, { timeout: 10_000 });
	await expect(maya.locator(SEL.npStripPlay)).toHaveCount(0);
});
