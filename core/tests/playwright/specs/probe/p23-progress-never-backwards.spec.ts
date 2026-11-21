// P23 — THE BAR NEVER RUNS BACKWARDS. The fake worker interleaves a timer keepalive's `pct: 0` between its real
// figures, which is the frame order a worker produced before its keepalive repeated the last figure. Core must
// never let a figure fall within a stage, so neither the room's `media:status` nor the phone's bar moves back.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome, openQueue } from '../../world/actors';
import { WebSocket } from 'ws';

/** -80 for `translateX(-80%)`: the fill's left edge. Rising toward 0 is the bar filling. */
const fillOf = (transform: string): number => Number(/translateX\((-?[\d.]+)%\)/.exec(transform)?.[1] ?? NaN);

test('keepalives between real figures never move the bar or the room status back', async ({ world }) => {
	test.setTimeout(120_000);
	const worker = await startFakeWorker(world, { slowMs: 1_200, keepaliveMs: 250 });
	const frames: { status: string; pct: number }[] = [];
	const ws = new WebSocket(`${world.baseURL.replace(/^http/, 'ws')}/ws?role=phone`);
	await new Promise<void>((resolve, reject) => {
		ws.once('open', () => resolve());
		ws.once('error', (err) => reject(err));
	});
	ws.on('message', (raw: Buffer | string) => {
		const m = JSON.parse(String(raw)) as { type?: string; status?: string; pct?: number };
		if (m.type === 'media:status') frames.push({ status: String(m.status), pct: m.pct ?? 0 });
	});
	try {
		const maya = await world.openPhone('Maya');
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

		const fill = maya.locator(`${SEL.processing} [data-slot="progress-indicator"]`).first();
		await expect(fill).toBeAttached({ timeout: 20_000 });
		const fills: number[] = [];
		while ((await fill.count()) > 0 && fills.length < 300) {
			const style = await fill.getAttribute('style', { timeout: 1_000 }).catch(() => null);
			if (style) fills.push(fillOf(style));
			await maya.waitForTimeout(100);
		}

		const fell = frames.filter((f, i) => i > 0 && f.status === frames[i - 1]!.status && f.pct < frames[i - 1]!.pct);
		expect(fell, `media:status fell within a stage: ${frames.map((f) => `${f.status}@${f.pct}`).join(' ')}`).toEqual(
			[]
		);
		const back = fills.filter((x, i) => i > 0 && x < fills[i - 1]! - 0.01);
		expect(fills.length, 'sampled the bar while the song cooked').toBeGreaterThan(5);
		expect(back, `the bar ran back: ${fills.join(' ')}`).toEqual([]);
	} finally {
		ws.close();
		await worker.stop();
	}
});
