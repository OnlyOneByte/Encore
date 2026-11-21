// P22 — A HUNG JOB BECOMES A FAILED SONG. A worker that accepts the stems job, reports once and then goes quiet
// with its socket open is what the real worker does once its keepalive ceiling has passed on a step nothing
// could kill (worker/encore_worker/transport/client.py `keepalive`). The fake is JavaScript, so this proves core
// and the screens; the Python watchdog and ceiling are proven by the worker's own unit tests.
//
// THE CLOCK IS CORE'S OWN. Nothing is shortened: each attempt waits out the 30s progress lease plus a 3s reaper
// tick, and the job has 3 attempts (jobs/repository.ts), so the song reads failed after about 100s. Before the
// ceiling existed the worker's timer refreshed that lease forever and the song said "Making karaoke…" all night.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome, openQueue } from '../../world/actors';
import { WebSocket } from 'ws';

/** 3 attempts × (30s lease + 3s reaper tick), the redispatches between them, and margin for a loaded box. */
const FAILED_WITHIN_MS = 150_000;

test('a worker that goes quiet mid-separation leaves a failed song, not an endless "Making karaoke…"', async ({
	world
}) => {
	test.setTimeout(FAILED_WITHIN_MS + 60_000);
	// `fetch:ytdlp` is what a YouTube source routes as; the fake fetch writes a tone, then stems hangs.
	const worker = await startFakeWorker(world, { hang: 'stems', capabilities: ['fetch:ytdlp', 'stems', 'align'] });
	const statuses: string[] = [];
	const ws = new WebSocket(`${world.baseURL.replace(/^http/, 'ws')}/ws?role=phone`);
	await new Promise<void>((resolve, reject) => {
		ws.once('open', () => resolve());
		ws.once('error', (err) => reject(err));
	});
	ws.on('message', (raw: Buffer | string) => {
		const m = JSON.parse(String(raw)) as { type?: string; status?: string };
		if (m.type === 'media:status') statuses.push(String(m.status));
	});
	try {
		const maya = await world.openPhone('Maya');
		await openBrowseFromHome(maya);
		await maya.locator(SEL.search).fill('sweet caroline');
		await maya
			.locator(SEL.songRow)
			.filter({ hasText: /caroline/i })
			.locator(SEL.singAction)
			.first()
			.click();

		await expect
			.poll(() => statuses.includes('failed'), {
				timeout: FAILED_WITHIN_MS,
				intervals: [1_000],
				message: `the hung job never failed; saw [${statuses.join(' → ')}]\n\n${worker.log()}`
			})
			.toBe(true);
		const hangs = worker
			.log()
			.split('\n')
			.filter((l) => l.includes('hanging stems'));
		expect(hangs.length, 'each attempt was given to the worker and hung').toBeGreaterThanOrEqual(2);

		await openQueue(maya);
		await expect(maya.locator(SEL.failedTurn)).toContainText("Couldn't make karaoke", { timeout: 5_000 });
	} finally {
		ws.close();
		await worker.stop();
	}
});
