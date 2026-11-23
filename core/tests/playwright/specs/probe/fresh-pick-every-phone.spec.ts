// A FRESH PICK READS AS BEING MADE ON EVERY PHONE, FROM ITS FIRST FRAME. Maya taps Sing on songs nobody has made yet;
// Theo (/queue 390x844), Ana (/queue 320x568), Lee (reloads /queue at the tap) and the TV lobby are read on EVERY
// animation frame from document start. No frame may show the new turn as dead: a `.failed` or `.stalled` card,
// "Couldn't make karaoke", or a strip or lobby saying the song "didn't work". The third pick holds Maya's
// /api/process for 1.5 s, the way a slow phone link would; queue-first Sing showed the danger card with a working
// Try again for that whole time. A refused Sing must book no turn at all. A last test picks with NO maker connected
// (POST held too), whose first frame must be the honest "Can't make this one right now".
//
// `FRESH_PICK_SHOTS=<dir>` writes every watcher at 700 ms into the held pick and once it settles, pass or fail.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { openBrowseFromHome, openQueue } from '../../world/actors';
import { startFakeWorker } from '../../world/workers';
import { STALLED_TURN_LABEL } from '../../../../src/lib/phrasing/process-phrasing';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

const CAPS = ['fetch:ytdlp', 'stems', 'align'];
type Frame = { t: number; cards: string[]; strip: string; lobby: string };

/** Installed as an init script: every animation frame whose reading changed is stamped on the epoch clock the tap
 * uses. Each card is "title: stage [classes]". */
function recorder() {
	const w = window as unknown as { __frames: Frame[] };
	w.__frames = [];
	const txt = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
	let last = '';
	const tick = () => {
		const cards = [...document.querySelectorAll('.qrow.proc')].map((r) => {
			const cls = ['failed', 'stalled'].filter((c) => r.classList.contains(c));
			return `${txt(r.querySelector('.t'))}: ${txt(r.querySelector('.stage'))} [${cls.join(' ')}]`;
		});
		const f = {
			t: Math.round(performance.timeOrigin + performance.now()),
			cards,
			strip: txt(document.querySelector('.dock .strip')),
			lobby: txt(document.querySelector('.lobby'))
		};
		const key = JSON.stringify([f.cards, f.strip, f.lobby]);
		if (key !== last) w.__frames.push(f);
		last = key;
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
}

const framesSince = (p: Page, tap: number) =>
	p.evaluate((t) => (window as unknown as { __frames: Frame[] }).__frames.filter((f) => f.t >= t), tap);

/** Every frame that calls the new turn dead. `stalledOk` is the no-maker case, where the honest card IS `.stalled`. */
function wrongFrames(frames: Frame[], word: RegExp, tap: number, stalledOk = false): string[] {
	const bad: string[] = [];
	for (const f of frames) {
		const mine = f.cards.filter((c) => word.test(c));
		const deadCard = mine.find(
			(c) => c.includes('[failed') || (!stalledOk && c.includes('stalled')) || c.includes("Couldn't make karaoke")
		);
		const deadLine = [f.strip, f.lobby].find((s) => s.includes("didn't work"));
		if (deadCard || deadLine) bad.push(`+${f.t - tap}ms ${deadCard ?? ''} ${deadLine ?? ''}`.trim());
	}
	return bad;
}

/** The new turn's stage line on the first frame it appears. */
function firstStage(frames: Frame[], word: RegExp): string | undefined {
	for (const f of frames) {
		const mine = f.cards.find((c) => word.test(c));
		if (mine) return mine;
	}
	return undefined;
}

async function singOn(maya: Page, q: string, re: RegExp) {
	await maya.goto('/');
	await openBrowseFromHome(maya);
	await maya.locator(SEL.search).fill(q);
	const row = maya
		.locator(SEL.songRow)
		.filter({ hasText: re })
		.filter({ has: maya.locator(SEL.singAction) })
		.first();
	await row.waitFor({ timeout: 20_000 });
	return row.locator(SEL.singAction);
}

async function watch(p: Page, path: string): Promise<void> {
	await p.addInitScript(recorder);
	await p.goto(path);
}

test('fresh pick: every phone and the TV read the new turn as being made from its first frame', async ({ world }) => {
	test.setTimeout(240_000);
	// Slow enough that nothing finishes while the frames are read.
	const worker = await startFakeWorker(world, { slowMs: 20_000, capabilities: CAPS });
	try {
		await world.awaitDemoTrack('caroline');
		const tv = await world.openTv();
		await watch(tv, '/tv');
		const theo = await world.openPhone('Theo');
		const ana = await world.openPhone('Ana');
		await ana.setViewportSize({ width: 320, height: 568 });
		const lee = await world.openPhone('Lee');
		const maya = await world.openPhone('Maya');
		for (const p of [theo, ana, lee]) {
			await watch(p, '/queue');
			await openQueue(p);
		}
		const picks = [
			{ q: 'dont stop believin', re: /believ/i, holdMs: 0 },
			{ q: 'sweet caroline', re: /caroline/i, holdMs: 0 },
			{ q: 'livin on a prayer', re: /prayer/i, holdMs: 1_500 }
		];
		for (const pk of picks) {
			const sing = await singOn(maya, pk.q, pk.re);
			if (pk.holdMs)
				await maya.route('**/api/process', async (r) => {
					await new Promise((res) => setTimeout(res, pk.holdMs));
					await r.continue();
				});
			const tap = Date.now();
			await sing.click();
			const reload = lee.reload();
			const dir = pk.holdMs ? process.env.FRESH_PICK_SHOTS : undefined;
			const watchers = { 'theo-390': theo, 'ana-320': ana, 'lee-390': lee, 'tv-1920': tv };
			if (dir) {
				mkdirSync(dir, { recursive: true });
				await theo.waitForTimeout(700);
				for (const [name, p] of Object.entries(watchers))
					await p.screenshot({ path: join(dir, `held-${name}-at-700ms.png`) });
			}
			await reload;
			// Settled: the turn reads as being made on every phone.
			for (const p of [theo, ana, lee])
				await expect(p.locator(SEL.processing).filter({ hasText: pk.re })).toContainText('Making karaoke', {
					timeout: 10_000
				});
			await expect(tv.locator(SEL.lobby)).toContainText('Making karaoke', { timeout: 10_000 });
			if (dir)
				for (const [name, p] of Object.entries(watchers))
					await p.screenshot({ path: join(dir, `held-${name}-after.png`) });
			if (pk.holdMs) await maya.unroute('**/api/process');

			// Soft, so one run reports every watcher on every pick, the held one included.
			for (const [name, p] of Object.entries({ theo, ana, lee, tv })) {
				const frames = await framesSince(p, tap);
				expect.soft(wrongFrames(frames, pk.re, tap), `${name}, ${pk.q}`).toEqual([]);
				if (name !== 'tv') expect.soft(firstStage(frames, pk.re), `${name}, ${pk.q}`).toContain('Making karaoke');
			}
		}
	} finally {
		await worker.stop();
	}
});

test('a refused Sing books no turn: the refusal is said, and no phone gets a card nothing is making', async ({
	world
}) => {
	test.setTimeout(120_000);
	await world.awaitDemoTrack('caroline');
	const theo = await world.openPhone('Theo');
	const maya = await world.openPhone('Maya');
	await theo.goto('/queue');
	await openQueue(theo);
	const sing = await singOn(maya, 'sweet caroline', /caroline/i);
	const refusal = 'You already have 2 songs processing.';
	await maya.route('**/api/process', (r) =>
		r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: refusal }) })
	);
	await sing.click();
	await expect(maya.getByText(refusal)).toBeVisible({ timeout: 10_000 });
	// Long enough for an add to have reached Theo, which takes tens of ms on this box.
	await theo.waitForTimeout(1_500);
	await expect(theo.locator(SEL.queueRow).filter({ hasText: /caroline/i })).toHaveCount(0);
});

test('fresh pick with no maker: the first frame is the honest "Can\'t make this one right now"', async ({ world }) => {
	test.setTimeout(120_000);
	await world.awaitDemoTrack('caroline');
	const tv = await world.openTv();
	await watch(tv, '/tv');
	const theo = await world.openPhone('Theo');
	const maya = await world.openPhone('Maya');
	await watch(theo, '/queue');
	await openQueue(theo);
	const sing = await singOn(maya, 'sweet caroline', /caroline/i);
	// Held like the slow pick above: on a LAN the queue-first window here is a few frames and a run can miss it.
	await maya.route('**/api/process', async (r) => {
		await new Promise((res) => setTimeout(res, 1_500));
		await r.continue();
	});
	const tap = Date.now();
	await sing.click();
	await expect(theo.locator(SEL.stalledTurn).filter({ hasText: /caroline/i })).toContainText(STALLED_TURN_LABEL, {
		timeout: 10_000
	});
	const frames = await framesSince(theo, tap);
	expect.soft(wrongFrames(frames, /caroline/i, tap, true), 'theo').toEqual([]);
	expect.soft(firstStage(frames, /caroline/i), 'theo').toContain(STALLED_TURN_LABEL);
	expect.soft(wrongFrames(await framesSince(tv, tap), /caroline/i, tap, true), 'tv').toEqual([]);
});
