// P10, the screen half: a second /tv is a COPY. It shows the same song, plays it muted (`muted` AND volume 0,
// since iOS Safari ignores `.volume`), makes no AudioContext, sends no telemetry, and offers "Make this the TV"; one tap
// moves the seat, the old TV goes silent BEFORE the new one plays, and the old TV turns into the copy. The real TV shows
// nothing new. `SHOT_DIR=<dir>` also writes screenshots of each state.
import { test, expect } from '../../world/fixtures';
import { startFakeWorker } from '../../world/workers';
import { readySong, queueReady, openBrowseFromHome } from '../../world/actors';
import { SEL } from '../../world/selectors';
import {
	TRACKS,
	armGraphHook,
	readGraphState,
	processTrack,
	queueReadyTrack,
	sendPlayerCommand,
	serverPlayback,
	singTrack,
	tapStage
} from './audio-probe-support';
import type { Browser, Page } from '@playwright/test';
import type { World } from '../../world/fixtures';

const CHIP = '.copy-chip';
const CLAIM = { name: 'Make this the TV' };

type Screen = { page: Page; sent: { telemetry: number; ended: string[]; playing: [at: number, sec: number][] } };

/**
 * A /tv on its own context, counting the telemetry frames it sends and the AudioContexts it makes or resumes. `real`
 * is the room's TV (the world's screen); any other gets its own `encore_tv` from GET /tv, so it is a second screen.
 * `holdVerdict` drops the server's `tv:seat` frames on their way in, so the page never learns what it is. `dropEnded`
 * drops this screen's own `ended` telemetry on its way out (counted, never delivered), so it can never end a song.
 * `noWebAudio` deletes `AudioContext` from the page, so every guide-mix route settles plain at once (degraded).
 */
async function openScreen(
	browser: Browser,
	world: World,
	width: number,
	height: number,
	{ real = false, holdVerdict = false, resumeMs = 0, dropEnded = false, noWebAudio = false } = {}
): Promise<Screen> {
	const ctx = await browser.newContext({ viewport: { width, height }, baseURL: world.baseURL });
	if (real) await ctx.addCookies([world.tvCookie]);
	const page = await ctx.newPage();
	await page.addInitScript((resumeMs: number) => {
		const w = window as unknown as { __ctx: { made: number; resumed: number }; __mediaErrors: string[] };
		w.__ctx = { made: 0, resumed: 0 };
		// Every media `error` event, with the src it fired on: a skip or a dropped song starts as one of these.
		w.__mediaErrors = [];
		addEventListener(
			'error',
			(e) => {
				if (e.target instanceof HTMLMediaElement) w.__mediaErrors.push(e.target.getAttribute('src') ?? '');
			},
			true
		);
		// `resumeMs` slows AudioContext.resume(), as a real TV's audio start can be (pitch-shift.ts allows 10 s).
		if (resumeMs > 0) {
			const R = AudioContext.prototype.resume;
			AudioContext.prototype.resume = function () {
				return new Promise<void>((ok) => setTimeout(() => R.call(this).then(ok, ok), resumeMs));
			};
		}
		const Real = window.AudioContext;
		window.AudioContext = class extends Real {
			constructor(...a: ConstructorParameters<typeof AudioContext>) {
				super(...a);
				w.__ctx.made++;
			}
			resume() {
				w.__ctx.resumed++;
				return super.resume();
			}
		};
	}, resumeMs);
	if (noWebAudio)
		await page.addInitScript(() => {
			const w = window as unknown as Record<string, unknown>;
			delete w.AudioContext;
			delete w.webkitAudioContext;
		});
	// `playing` keeps every position this screen tells the room, stamped when it left (the same clock as `Date.now()`
	// in a page), so a hold on the positions is read at the source, not off a server poll that can miss one frame.
	const sent = { telemetry: 0, ended: [] as string[], playing: [] as [number, number][] };
	const count = (payload: string | Buffer) => {
		if (!String(payload).includes('"tv:telemetry"')) return;
		sent.telemetry++;
		const f = JSON.parse(String(payload)) as { status: string; entryId?: string; positionSec?: number };
		if (f.status === 'ended') sent.ended.push(f.entryId ?? '');
		if (f.status === 'playing') sent.playing.push([Date.now(), f.positionSec ?? 0]);
	};
	if (holdVerdict || dropEnded) {
		await page.routeWebSocket(/\/ws\?role=tv/, (ws) => {
			const server = ws.connectToServer();
			ws.onMessage((m) => {
				count(m);
				if (dropEnded && /"tv:telemetry"/.test(String(m)) && /"status":"ended"/.test(String(m))) return;
				server.send(m);
			});
			server.onMessage((m) => {
				if (!holdVerdict || !String(m).includes('"tv:seat"')) ws.send(m);
			});
		});
	} else page.on('websocket', (ws) => ws.on('framesent', (f) => count(f.payload)));
	await page.goto(`/tv?room=${encodeURIComponent(world.code)}`);
	return { page, sent };
}

/** The element actually playing the song (`/media/`, running first, so after a gapless swap it is the OTHER slot):
 *  its volume, `muted`, and whether it runs. Null before one is. */
const audioOf = (tv: Page) =>
	tv.evaluate(() => {
		const all = [...document.querySelectorAll<HTMLMediaElement>('audio')].filter((e) =>
			e.currentSrc.includes('/media/')
		);
		const m = all.find((e) => !e.paused) ?? all[0];
		return m ? { volume: m.volume, muted: m.muted, paused: m.paused } : null;
	});
/** Every media element on the page is `muted`: both player slots, so the gapless swap cannot hand a copy sound. */
const allMuted = (tv: Page) =>
	tv.evaluate(() => [...document.querySelectorAll<HTMLMediaElement>('audio, video')].every((e) => e.muted));
const mediaErrorsOf = (tv: Page) => tv.evaluate(() => (window as unknown as { __mediaErrors: string[] }).__mediaErrors);
const contextsOf = (tv: Page) =>
	tv.evaluate(() => (window as unknown as { __ctx: { made: number; resumed: number } }).__ctx);

async function shot(page: Page, name: string): Promise<void> {
	if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png` });
}

/** One tap per screen, as a room gives it: a television grants no autoplay. Top-right, clear of the copy's chip. */
const tap = (s: Screen) => s.page.mouse.click(s.page.viewportSize()!.width - 2, s.page.viewportSize()!.height / 2);

test('a second /tv is a muted copy that sends no telemetry, and "Make this the TV" moves the seat', async ({
	browser,
	world
}) => {
	test.setTimeout(120_000);
	const worker = await startFakeWorker(world, { seconds: 30 });
	try {
		const tv = await openScreen(browser, world, 1920, 1080, { real: true });
		const phone = await world.openPhone('Ana');
		await readySong(world, phone, 'caroline');
		const copy = await openScreen(browser, world, 1920, 1080);
		const small = await openScreen(browser, world, 390, 844);
		const tiny = await openScreen(browser, world, 320, 568);
		await expect(copy.page.locator(CHIP)).toBeVisible();
		await expect(tv.page.locator(CHIP)).toHaveCount(0);
		await shot(copy.page, 'copy-1920-lobby');
		await shot(small.page, 'copy-390-lobby');
		await shot(tiny.page, 'copy-320-lobby');

		for (const s of [tv, copy, small, tiny]) await tap(s);
		await queueReady(phone, 'caroline');
		await expect.poll(() => audioOf(tv.page), { timeout: 30_000 }).toMatchObject({ muted: false, paused: false });
		await expect.poll(() => audioOf(copy.page), { timeout: 30_000 }).toMatchObject({ volume: 0, muted: true });
		expect(await allMuted(small.page)).toBe(true);
		// A plain song at key 0: no AudioContext anywhere, so the copy's zero proves nothing yet (see the guide test).
		expect((await contextsOf(copy.page)).made).toBe(0);
		// The same stage on the copy: the song is up on both.
		await expect(copy.page.locator('.lower-third')).toContainText(/Ana/);
		// The join QR's corner is the chip's on a copy; the real TV keeps it.
		const joinCorner = (p: Page) => p.getByLabel('Scan to join Encore').locator('visible=true');
		await expect(joinCorner(tv.page)).toHaveCount(1);
		await expect(joinCorner(copy.page)).toHaveCount(0);
		const before = { tv: tv.sent.telemetry, copy: copy.sent.telemetry };
		await tv.page.waitForTimeout(3_000);
		expect(tv.sent.telemetry - before.tv).toBeGreaterThan(0);
		expect(copy.sent.telemetry).toBe(0);
		await shot(tv.page, 'tv-1920-seat');
		await shot(copy.page, 'copy-1920');
		await shot(small.page, 'copy-390');
		await shot(tiny.page, 'copy-320');

		// "Make this the TV": the chip moves to the old TV, and the sound follows.
		await copy.page.getByRole('button', CLAIM).click();
		await expect(copy.page.locator(CHIP)).toHaveCount(0);
		await expect(tv.page.locator(CHIP)).toBeVisible();
		// The move is announced on the screen that became the TV, and the chip's own status line is the sentence only.
		await expect(copy.page.locator('p.vh[role="status"]')).toHaveText('This screen is now the TV');
		// The demoted TV says so in the page's live region; the chip itself holds none.
		await expect(tv.page.locator('p.vh[role="status"]')).toHaveText('Another screen is the TV');
		await expect(tv.page.locator(`${CHIP} [role="status"], ${CHIP}[role="status"]`)).toHaveCount(0);
		// No live region on the page holds the button, so its label is never read out as status.
		await expect(tv.page.locator('[role="status"]').filter({ has: tv.page.getByRole('button', CLAIM) })).toHaveCount(0);
		await expect.poll(() => audioOf(tv.page)).toMatchObject({ volume: 0, muted: true });
		await expect.poll(() => audioOf(copy.page)).toMatchObject({ muted: false, paused: false });
		const sinceClaim = tv.sent.telemetry;
		await copy.page.waitForTimeout(2_000);
		expect(tv.sent.telemetry).toBe(sinceClaim);
		expect(copy.sent.telemetry).toBeGreaterThan(0);
		await shot(copy.page, 'claimed-1920-seat');
		await shot(tv.page, 'claimed-old-tv-copy');
	} finally {
		await worker.stop();
	}
});

// Proposal 19: while no screen is the TV, a copy says so, instead of pointing the room at a screen that is gone.
test('the TV drops mid-song: every copy says "The TV is reconnecting..." and goes back when the TV returns', async ({
	browser,
	world
}) => {
	test.setTimeout(120_000);
	const worker = await startFakeWorker(world, { seconds: 30 });
	try {
		const tv = await openScreen(browser, world, 1920, 1080, { real: true });
		const phone = await world.openPhone('Ana');
		await readySong(world, phone, 'caroline');
		const copies = [
			await openScreen(browser, world, 1920, 1080),
			await openScreen(browser, world, 390, 844),
			await openScreen(browser, world, 320, 568)
		];
		for (const s of [tv, ...copies]) await tap(s);
		await queueReady(phone, 'caroline');
		await expect(copies[0]!.page.locator('.lower-third')).toContainText(/Ana/, { timeout: 30_000 });
		// Past the "Now singing" card, so the drop lands over the lyrics.
		for (const c of copies) await expect(c.page.locator(SEL.stateNext)).toHaveCount(0, { timeout: 15_000 });
		for (const c of copies) await expect(c.page.locator(CHIP)).toContainText('Another screen is the TV');

		await tv.page.context().close();
		for (const c of copies) {
			await expect(c.page.locator(CHIP)).toContainText('The TV is reconnecting...', { timeout: 1_000 });
			await expect(c.page.locator('p.vh[role="status"]')).toHaveText('The TV is reconnecting...');
			// Same chip, same button: "Make this the TV" stays the remedy.
			await expect(c.page.getByRole('button', CLAIM)).toBeVisible();
			await shot(c.page, `tv-offline-copy${c.page.viewportSize()!.width}`);
		}

		// The TV reloads with its cookie: it is the TV again, and every copy says so.
		const back = await openScreen(browser, world, 1920, 1080, { real: true });
		await expect(back.page.locator(CHIP)).toHaveCount(0);
		for (const c of copies) {
			await expect(c.page.locator(CHIP)).toContainText('Another screen is the TV', { timeout: 5_000 });
			await expect(c.page.locator('p.vh[role="status"]')).toHaveText('Another screen is the TV');
		}
	} finally {
		await worker.stop();
	}
});

test('both player slots are muted on a copy: the one playing and the one pre-warming the next song', async ({
	browser,
	world
}) => {
	test.setTimeout(150_000);
	// 30 s stems, so the second song is pre-warmed into slot B during the first, and is still playing when checked.
	const worker = await startFakeWorker(world, { seconds: 30 });
	try {
		const tv = await openScreen(browser, world, 1920, 1080, { real: true });
		const ana = await world.openPhone('Ana');
		const bo = await world.openPhone('Bo');
		await readySong(world, ana, 'caroline');
		await readySong(world, bo, 'believin');
		const copy = await openScreen(browser, world, 1920, 1080);
		await expect(copy.page.locator(CHIP)).toBeVisible();
		for (const s of [tv, copy]) await tap(s);
		await queueReady(ana, 'caroline');
		await queueReady(bo, 'believin');
		// While Ana sings, the OTHER slot pre-warms Bo's song (gapless). Which slot is which varies, so wait until both
		// slots hold an element and check every one: the pre-warmed slot is the one the next swap hands the song to.
		await expect(copy.page.locator('.lower-third')).toContainText(/Ana/, { timeout: 60_000 });
		await expect
			.poll(() => copy.page.evaluate(() => document.querySelectorAll('.slot audio').length), { timeout: 30_000 })
			.toBe(2);
		await expect.poll(() => audioOf(tv.page), { timeout: 30_000 }).toMatchObject({ muted: false, paused: false });
		await expect.poll(() => audioOf(copy.page), { timeout: 30_000 }).toMatchObject({ volume: 0, muted: true });
		expect(await allMuted(copy.page)).toBe(true);
	} finally {
		await worker.stop();
	}
});

test('a screen that has not heard the seat verdict yet is silent and sends no telemetry', async ({
	browser,
	world
}) => {
	test.setTimeout(120_000);
	const worker = await startFakeWorker(world, { seconds: 30 });
	try {
		const tv = await openScreen(browser, world, 1920, 1080, { real: true });
		const phone = await world.openPhone('Ana');
		await readySong(world, phone, 'caroline');
		const waiting = await openScreen(browser, world, 1920, 1080, { holdVerdict: true });
		for (const s of [tv, waiting]) await tap(s);
		await queueReady(phone, 'caroline');
		await expect.poll(() => audioOf(waiting.page), { timeout: 30_000 }).toMatchObject({ muted: true, paused: false });
		await waiting.page.waitForTimeout(3_000);
		expect(tv.sent.telemetry).toBeGreaterThan(0);
		expect(waiting.sent.telemetry).toBe(0);
	} finally {
		await worker.stop();
	}
});

test('a copy makes no AudioContext on a guide-mix song, while the TV builds one and plays the guide', async ({
	browser,
	world
}) => {
	test.setTimeout(120_000);
	const worker = await startFakeWorker(world, { guideMix: true, seconds: 30 });
	try {
		const phone = await world.openPhone('Guide');
		await openBrowseFromHome(phone);
		await singTrack(phone, world.baseURL, TRACKS.caroline);
		const tv = await world.openTv();
		const copy = await openScreen(browser, world, 1920, 1080);
		// The hook must be in place before the TV's eager split graph is built (see p2-guiding-track's `stage`).
		await armGraphHook(tv);
		await tv.reload();
		await tv.locator(SEL.tvRoot).first().waitFor({ state: 'attached', timeout: 30_000 });
		await tapStage(tv);
		await tapStage(copy.page);
		await expect(copy.page.locator(CHIP)).toBeVisible();
		await sendPlayerCommand(phone, { cmd: 'guide', level: 0.15 });
		await expect.poll(async () => (await readGraphState(tv))?.gainValues[1], { timeout: 30_000 }).toBeCloseTo(0.15, 3);
		// Polled to a PLAYING copy first, so the zero below is a copy that is running the song, not one still loading.
		await expect.poll(() => audioOf(copy.page), { timeout: 30_000 }).toMatchObject({ muted: true, paused: false });
		expect(await contextsOf(copy.page)).toEqual({ made: 0, resumed: 0 });
	} finally {
		await worker.stop();
	}
});

type Box = { x: number; y: number; right: number; bottom: number };
const boxes = (p: Page, sel: string) =>
	p.evaluate(
		(s) =>
			[...document.querySelectorAll(s)].map((e) => {
				const b = e.getBoundingClientRect();
				return { x: b.x, y: b.y, right: b.right, bottom: b.bottom };
			}),
		sel
	);
const overlap = (a: Box, b: Box) =>
	Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x)) *
	Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y));

test('on a phone the chip stays inside the screen, clear of the reactions lane, the roster and the room code', async ({
	browser,
	world
}) => {
	test.setTimeout(120_000);
	const worker = await startFakeWorker(world, { seconds: 30 });
	try {
		const tv = await openScreen(browser, world, 1920, 1080, { real: true });
		const phones = [
			await openScreen(browser, world, 390, 844),
			await openScreen(browser, world, 320, 568),
			await openScreen(browser, world, 1920, 1080)
		];
		const check = async (state: string, avoid: string[], only?: number) => {
			for (const s of phones) {
				const vw = s.page.viewportSize()!.width;
				if (only && vw !== only) continue;
				// Measured only once the chip is ON SCREEN: in the lobby it renders in the lobby's own flow, after load.
				await expect(s.page.locator(CHIP)).toBeVisible({ timeout: 15_000 });
				const [chip] = await boxes(s.page, CHIP);
				expect(chip, `${state} ${vw}: no chip`).toBeTruthy();
				expect(chip!.x, `${state} ${vw}: chip left edge`).toBeGreaterThanOrEqual(0);
				expect(chip!.right, `${state} ${vw}: chip right edge`).toBeLessThanOrEqual(vw);
				const [button] = await boxes(s.page, `${CHIP} button`);
				expect(button!.x >= chip!.x && button!.right <= chip!.right, `${state} ${vw}: button inside the chip`).toBe(
					true
				);
				for (const sel of avoid) {
					const others = await boxes(s.page, sel);
					expect(others.length, `${state} ${vw}: ${sel} is on screen`).toBeGreaterThan(0);
					for (const o of others) expect(overlap(chip!, o), `${state} ${vw}: chip over ${sel}`).toBe(0);
				}
			}
		};
		// Nobody has joined: attract. On a phone the chip floats in attract's empty bottom band, clear of the wordmark and
		// the QR at both widths, and at 390 of the typed join path too. Attract's two-column TV layout already overflows a
		// 320 screen on main, so there is no free band left there for the code line (a known edge, in the PR body).
		await check('attract', ['.attract .brand', '.attract .qr', '.jt-url', '.jt-code', '.jt-or'], 390);
		await check('attract', ['.attract .brand', '.attract .qr'], 320);
		// A wide copy in attract: the chip bottom-right, and the attract screen itself still painted under it.
		await check('attract', ['.attract .brand', '.attract .qr', '.jt-url', '.jt-code', '.jt-or'], 1920);
		const wide = phones[2]!.page;
		const [slot] = await boxes(wide, '.copy-slot');
		expect(slot!.x, 'attract 1920: the chip slot spans the screen').toBeGreaterThan(960);
		expect(slot!.y, 'attract 1920: the chip slot spans the screen').toBeGreaterThan(540);
		const ana = await world.openPhone('Ana');
		await world.openPhone('Bo');
		await readySong(world, ana, 'caroline');
		// In the lobby the chip stands in the QR's place: clear of the instruction lines, the address, the code, the roster.
		await check('lobby', ['.lobby h1', '.lobby .sub', '.lobby .url', '.lobby .code', '.lobby .strip']);
		for (const s of [tv, ...phones]) await tap(s);
		await queueReady(ana, 'caroline');
		await expect(phones[0]!.page.locator('.lower-third')).toContainText(/Ana/, { timeout: 30_000 });
		await check('mid-song', ['.reaction-lane', '.lower-third']);
	} finally {
		await worker.stop();
	}
});

/** Every 4 ms, whether this screen is AUDIBLE: its song element running, not muted, volume above 0. */
const startSampling = (p: Page) =>
	p.evaluate(() => {
		const w = window as unknown as { __lv: [number, boolean][] };
		w.__lv = [];
		setInterval(() => {
			const m = [...document.querySelectorAll<HTMLMediaElement>('audio')].find((e) => e.currentSrc.includes('/media/'));
			w.__lv.push([performance.timeOrigin + performance.now(), !!m && !m.paused && !m.muted && m.volume > 0]);
		}, 4);
	});
const samples = (p: Page) => p.evaluate(() => (window as unknown as { __lv: [number, boolean][] }).__lv);

test('a seat move never plays two screens at once, whichever socket is older (4 ms sampling)', async ({
	browser,
	world
}) => {
	test.setTimeout(120_000);
	const worker = await startFakeWorker(world, { seconds: 30 });
	try {
		const a = await openScreen(browser, world, 1920, 1080, { real: true });
		const phone = await world.openPhone('Ana');
		await readySong(world, phone, 'caroline');
		const b = await openScreen(browser, world, 1920, 1080);
		for (const s of [a, b]) await tap(s);
		await queueReady(phone, 'caroline');
		await expect.poll(() => audioOf(a.page), { timeout: 30_000 }).toMatchObject({ muted: false, paused: false });
		// First the younger socket claims (from b), then the older one claims back (from a).
		for (const [from, to] of [
			[a, b],
			[b, a]
		] as const) {
			await startSampling(from.page);
			await startSampling(to.page);
			await to.page.getByRole('button', CLAIM).click();
			await expect.poll(() => audioOf(to.page)).toMatchObject({ muted: false, paused: false });
			await to.page.waitForTimeout(500);
			const [off, on] = [await samples(from.page), await samples(to.page)];
			const lastOld = Math.max(...off.filter(([, loud]) => loud).map(([t]) => t));
			const firstNew = Math.min(...on.filter(([, loud]) => loud).map(([t]) => t));
			// Non-vacuous: the old TV WAS audible in this window, and the new one became so.
			expect(Number.isFinite(lastOld) && Number.isFinite(firstNew), 'no audible samples on one side').toBe(true);
			test.info().annotations.push({ type: 'silent gap', description: `${Math.round(firstNew - lastOld)} ms` });
			await expect(to.page.locator('p.vh[role="status"]')).toHaveText('This screen is now the TV');
			expect(
				firstNew,
				`the new TV was audible ${lastOld - firstNew} ms before the old one went silent`
			).toBeGreaterThan(lastOld);
		}
		// b just LEFT the seat (its region says so); it comes back within the 4 s, and that move is announced too.
		await expect(b.page.locator('p.vh[role="status"]')).toHaveText('Another screen is the TV');
		await b.page.getByRole('button', CLAIM).click();
		await expect(b.page.locator('p.vh[role="status"]')).toHaveText('This screen is now the TV', { timeout: 2_000 });
		// And it clears once read, so the region is empty for the next change.
		await expect(b.page.locator('p.vh[role="status"]')).toHaveText('', { timeout: 10_000 });
	} finally {
		await worker.stop();
	}
});

test('a mid-song claim on a guide-mix song keeps the song going, and the NEXT singer’s song then plays clean', async ({
	browser,
	world
}) => {
	test.setTimeout(180_000);
	const worker = await startFakeWorker(world, { guideMix: true, seconds: 30 });
	try {
		const phone = await world.openPhone('Guide');
		await openBrowseFromHome(phone);
		const bo = await world.openPhone('Bo');
		await openBrowseFromHome(bo);
		const tv = await openScreen(browser, world, 1920, 1080, { real: true });
		const copy = await openScreen(browser, world, 1920, 1080);
		const reader = await openScreen(browser, world, 390, 844);
		for (const s of [tv, copy, reader]) await tap(s);
		await singTrack(phone, world.baseURL, TRACKS.caroline);
		await expect.poll(() => audioOf(copy.page), { timeout: 30_000 }).toMatchObject({ muted: true, paused: false });
		// Bo's guide-mix song is queued BEFORE the claim, so the copy pre-warms it while silent.
		await singTrack(bo, world.baseURL, TRACKS.believin);
		// Late in the song (30 s stems), so a restart at 0:00 is unmistakable and the next song follows soon after.
		await expect
			.poll(async () => (await serverPlayback(world.baseURL)).state.positionSec, { timeout: 60_000 })
			.toBeGreaterThan(18);
		const srcOf = (p: Page) =>
			p.evaluate(() => [...document.querySelectorAll('audio')].find((e) => !e.paused)?.getAttribute('src') ?? '');
		const plain = await srcOf(copy.page);
		const at = (p: Page) =>
			p.evaluate(
				() => [...document.querySelectorAll<HTMLMediaElement>('audio')].find((e) => !e.paused)?.currentTime ?? -1
			);
		const before = { room: (await serverPlayback(world.baseURL)).state.positionSec, copy: await at(copy.page) };
		await copy.page.getByRole('button', CLAIM).click();
		await expect.poll(() => audioOf(copy.page)).toMatchObject({ muted: false, paused: false });
		// Counted from the claim, so an error at the song change (within ms of it) is inside the window.
		const errorsBefore = (await mediaErrorsOf(copy.page)).length;
		// What re-decides a src on the new TV: a guide move (it re-syncs playback state on every screen).
		await sendPlayerCommand(phone, { cmd: 'guide', level: 0.3 });
		// Four seconds of samples: the room's playhead, the new TV's own clock and a phone reading along never go back.
		let last = { room: before.room, copy: before.copy, reader: await at(reader.page) };
		for (let i = 0; i < 16; i++) {
			await copy.page.waitForTimeout(250);
			const now = {
				room: (await serverPlayback(world.baseURL)).state.positionSec,
				copy: await at(copy.page),
				reader: await at(reader.page)
			};
			for (const k of ['room', 'copy', 'reader'] as const)
				expect(now[k], `${k} jumped back at sample ${i}: ${last[k]} -> ${now[k]}`).toBeGreaterThan(last[k] - 0.5);
			last = now;
		}
		expect(last.room, 'the room restarted the song').toBeGreaterThan(before.room);
		expect(await srcOf(copy.page), 'the new TV switched src mid-song (a reload)').toBe(plain);

		// THE NEXT SONG, on the screen that took the seat: Bo's guide-mix song is its first full song as the TV, so it
		// builds the guide graph now. It must load the mix, play, raise no "would not play", and end no song early.
		const guideEntry = (await serverPlayback(world.baseURL)).state.currentEntryId;
		await expect
			.poll(async () => (await serverPlayback(world.baseURL)).state.currentEntryId, { timeout: 60_000 })
			.not.toBe(guideEntry);
		const boEntry = (await serverPlayback(world.baseURL)).state.currentEntryId;
		expect(boEntry, "the server dropped Bo's song").toBeTruthy();
		// The takeover's own text ("That song won't play"), and an older wording too.
		const skipNotice = copy.page.getByText(/won.t play|would not play/i);
		for (let i = 0; i < 24; i++) {
			expect(await skipNotice.count(), `a "won't play" notice at sample ${i}`).toBe(0);
			await copy.page.waitForTimeout(250);
		}
		await expect.poll(() => srcOf(copy.page), { timeout: 15_000 }).toContain('guide');
		expect(copy.sent.ended, "an ended frame named Bo's song before it played out").not.toContain(boEntry);
		// The song change raised no media error at all (an empty src is one, even when nothing else goes wrong).
		expect((await mediaErrorsOf(copy.page)).slice(errorsBefore), 'media errors across the song change').toEqual([]);
		expect((await serverPlayback(world.baseURL)).state.currentEntryId).toBe(boEntry);
		for (const p of [phone, bo]) await expect(p.locator(SEL.npStripTitle).first()).toContainText(/believin/i);
	} finally {
		await worker.stop();
	}
});

test('a key-shifted song makes no AudioContext on a copy, while the TV builds its shift graph', async ({
	browser,
	world
}) => {
	test.setTimeout(120_000);
	const worker = await startFakeWorker(world, { seconds: 30 });
	try {
		const tv = await openScreen(browser, world, 1920, 1080, { real: true });
		const phone = await world.openPhone('Ana');
		await readySong(world, phone, 'caroline');
		const copy = await openScreen(browser, world, 1920, 1080);
		for (const s of [tv, copy]) await tap(s);
		await queueReady(phone, 'caroline');
		await expect.poll(() => audioOf(copy.page), { timeout: 30_000 }).toMatchObject({ muted: true, paused: false });
		await sendPlayerCommand(phone, { cmd: 'key', semitones: 2 });
		await expect.poll(async () => (await serverPlayback(world.baseURL)).state.keyShift, { timeout: 10_000 }).toBe(2);
		// Non-vacuous: the shift reached the screens, and the TV built a graph for it.
		await expect.poll(async () => (await contextsOf(tv.page)).made, { timeout: 15_000 }).toBeGreaterThan(0);
		expect(await contextsOf(copy.page)).toEqual({ made: 0, resumed: 0 });
	} finally {
		await worker.stop();
	}
});

// THE SKIP ONTO A GUIDE-MIX SONG, on the TV alone. A plain song plays; a skip makes a guide-mix song
// current in the SAME slot, which has no routed split graph yet, so its mix decision is pending for as long as the
// audio start takes. Until then the element must be SILENT: it still holds the skipped song.
for (const resumeMs of [0, 3_000, 8_000]) {
	test(`a skip onto a guide-mix song never plays the skipped song under the next card (audio start +${resumeMs} ms)`, async ({
		browser,
		world
	}) => {
		test.setTimeout(240_000);
		const ana = await world.openPhone('Ana');
		const bo = await world.openPhone('Bo');
		const plain = await startFakeWorker(world, { guideMix: false, seconds: 60 });
		const anaMedia = (await processTrack(ana, world.baseURL, TRACKS.caroline)).id;
		await plain.stop();
		const mix = await startFakeWorker(world, { guideMix: true, seconds: 60 });
		try {
			const boMedia = (await processTrack(bo, world.baseURL, TRACKS.believin)).id;
			const tv = await openScreen(browser, world, 1920, 1080, { real: true, resumeMs });
			await tap(tv);
			await openBrowseFromHome(ana);
			await queueReadyTrack(ana, TRACKS.caroline);
			await openBrowseFromHome(bo);
			await queueReadyTrack(bo, TRACKS.believin);
			const playingSrc = () =>
				tv.page.evaluate(() =>
					[...document.querySelectorAll<HTMLMediaElement>('audio')]
						.filter((m) => !m.paused && !m.muted)
						.map((m) => m.getAttribute('src') ?? '')
				);
			await expect.poll(async () => (await playingSrc()).join(), { timeout: 60_000 }).toContain(anaMedia);
			await tv.page.waitForTimeout(4_000);
			const anaEntry = (await serverPlayback(world.baseURL)).state.currentEntryId;
			await sendPlayerCommand(ana, { cmd: 'skip' });
			// From the moment the room is on Bo's song until Bo's song is heard: never Ana's.
			await expect
				.poll(async () => (await serverPlayback(world.baseURL)).state.currentEntryId, { timeout: 10_000 })
				.not.toBe(anaEntry);
			expect((await serverPlayback(world.baseURL)).state.currentEntryId, "the server dropped Bo's song").toBeTruthy();
			const heard: string[][] = [];
			// Watched until Bo is HEARD (up to 20 s), however long the audio start takes, not for a fixed window.
			const until = Date.now() + 20_000;
			while (Date.now() < until) {
				const now = await playingSrc();
				heard.push(now);
				if (now.some((src) => src.includes(boMedia))) break;
				await tv.page.waitForTimeout(100);
			}
			expect(
				heard.flat().filter((src) => src.includes(anaMedia)),
				"the skipped song played on under Bo's card"
			).toEqual([]);
			await expect.poll(async () => (await playingSrc()).join(), { timeout: 20_000 }).toContain(boMedia);
			expect(await mediaErrorsOf(tv.page)).toEqual([]);
			expect(tv.sent.ended, 'an ended frame named a song that never played out').toEqual([]);
		} finally {
			await mix.stop();
		}
	});
}

// A CLAIM AT THE SWAP. The copy's song ends and the gapless swap makes the warmed slot (Bo's guide-mix song,
// decided plain while silent) the PLAYING one, and the claim lands then. Bo's song must still get its guide.
//  - `boundary`: inside the swap edge, with the OLD TV's `ended` dropped on its way out. Nobody but the new seat can
//    then tell the server the song ended, so the room moves on within a second only if the new seat says so.
//  - `+300 ms` after the edge, the old TV left alone (its own `ended` usually gets there first).
//  - `into`: 1.5 s into Bo's song, already playing plain on the copy. The guide reload must RESUME there, not restart
//    Bo at 0:00, and no position the new TV sends may fall back towards 0 meanwhile.
//  - `into`, on a copy with NO Web Audio: the re-decide settles on the plain src it already plays, so nothing reloads.
//    The held resume must go, or the new TV says nothing until a later re-buffer jumps the song back to the claim.
const SWAP_CASES = [
	{
		name: 'at the song swap, the old TV never ending it',
		offsetMs: 0,
		dropOldEnded: true,
		intoSec: 0,
		noWebAudio: false
	},
	{ name: 'at the song swap (+300 ms)', offsetMs: 300, dropOldEnded: false, intoSec: 0, noWebAudio: false },
	{ name: '1.5 s into the next song', offsetMs: 0, dropOldEnded: false, intoSec: 1.5, noWebAudio: false },
	{
		name: '1.5 s into the next song, with no Web Audio',
		offsetMs: 0,
		dropOldEnded: false,
		intoSec: 1.5,
		noWebAudio: true
	}
];
for (const c of SWAP_CASES) {
	const outcome = c.noWebAudio ? 'keeps the plain song going' : "keeps the next song's guide, in place";
	test(`a claim ${c.name} ${outcome}, and the room on it`, async ({ browser, world }) => {
		test.setTimeout(180_000);
		const worker = await startFakeWorker(world, { guideMix: true, seconds: 30 });
		try {
			const phone = await world.openPhone('Guide');
			await openBrowseFromHome(phone);
			const bo = await world.openPhone('Bo');
			await openBrowseFromHome(bo);
			// No "Now singing" card, so the lower-third names the song on screen from the swap on.
			await world.becomeHost(phone);
			const res = await phone.request.put('/api/settings/room', { data: { songIntroEnabled: false } });
			expect(res.ok()).toBe(true);
			const tv = await openScreen(browser, world, 1920, 1080, { real: true, dropEnded: c.dropOldEnded });
			const copy = await openScreen(browser, world, 1920, 1080, { noWebAudio: c.noWebAudio });
			for (const s of [tv, copy]) await tap(s);
			await singTrack(phone, world.baseURL, TRACKS.caroline);
			await singTrack(bo, world.baseURL, TRACKS.believin);
			await expect.poll(() => audioOf(copy.page), { timeout: 30_000 }).toMatchObject({ muted: true, paused: false });
			const first = (await serverPlayback(world.baseURL)).state.currentEntryId;
			await expect
				.poll(async () => (await serverPlayback(world.baseURL)).state.positionSec, { timeout: 60_000 })
				.toBeGreaterThan(20);
			const errorsBefore = (await mediaErrorsOf(copy.page)).length;
			// Where the guide mix STARTS playing on the copy, read at its own `playing` event and once more 300 ms on.
			await copy.page.evaluate(() => {
				const w = window as unknown as { __guideAt?: number[] };
				addEventListener(
					'playing',
					(e) => {
						const el = e.target;
						if (!(el instanceof HTMLMediaElement) || !el.getAttribute('src')?.includes('guide') || w.__guideAt) return;
						w.__guideAt = [el.currentTime];
						setTimeout(() => w.__guideAt!.push(el.currentTime), 300);
					},
					true
				);
			});
			if (c.intoSec > 0) {
				await expect
					.poll(async () => (await serverPlayback(world.baseURL)).state.currentEntryId, { timeout: 30_000 })
					.not.toBe(first);
				// Claimed from inside the page the moment Bo's (plain, muted) song on the copy reaches `intoSec`.
				await copy.page.evaluate((into: number) => {
					const w = window as unknown as { __claimAt?: number; __claimPlayhead?: number };
					const btn = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
						/Make this the TV/.test(b.textContent ?? '')
					)!;
					const id = setInterval(() => {
						const el = [...document.querySelectorAll<HTMLMediaElement>('audio')].find((e) => !e.paused);
						if (!el || el.currentTime < into || el.currentTime > into + 1) return;
						clearInterval(id);
						w.__claimPlayhead = el.currentTime;
						w.__claimAt = Date.now();
						btn.click();
					}, 5);
				}, c.intoSec);
			}
			// Armed in the page, on the WINDOW in capture (so before the page's own handler), timed in the page's own clock.
			// THE SWAP is the first of three edges: the playing song's `ended`; the OTHER slot starting to play; or, with no
			// warmed slot, the same element loading the next song. A copy whose clock runs behind the TV's follows the
			// server's advance before its own element ends, so it may never see `ended`.
			const armed = await copy.page.evaluate(
				(off: number) => {
					const w = window as unknown as { __claimAt?: number };
					if (off < 0) return { into: true }; // armed above, on the next song's own clock
					const btn = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
						/Make this the TV/.test(b.textContent ?? '')
					)!;
					const el = [...document.querySelectorAll<HTMLMediaElement>('audio')].find((e) => !e.paused);
					const claim = () => {
						w.__claimAt = Date.now();
						btn.click();
					};
					const onSwap = (e: Event) => {
						if (!(e.target instanceof HTMLMediaElement)) return;
						if (e.type === 'playing' && e.target === el) return;
						if (e.type === 'loadstart' && e.target !== el) return;
						for (const t of ['ended', 'playing', 'loadstart']) removeEventListener(t, onSwap, true);
						if (off === 0) claim();
						else setTimeout(claim, off);
					};
					for (const t of ['ended', 'playing', 'loadstart']) addEventListener(t, onSwap, true);
					return { at: el?.currentTime ?? null, dur: el?.duration ?? null };
				},
				c.intoSec > 0 ? -1 : c.offsetMs
			);
			try {
				await expect
					.poll(() => copy.page.evaluate(() => !!(window as { __claimAt?: number }).__claimAt), { timeout: 30_000 })
					.toBe(true);
			} catch {
				const audio = await copy.page.evaluate(() =>
					[...document.querySelectorAll<HTMLMediaElement>('audio')].map((e) => ({
						src: e.getAttribute('src'),
						t: e.currentTime,
						paused: e.paused,
						ended: e.ended
					}))
				);
				const room = (await serverPlayback(world.baseURL)).state;
				throw new Error(`no swap on the copy (armed at ${JSON.stringify(armed)}): ${JSON.stringify({ audio, room })}`);
			}
			const claimAt = await copy.page.evaluate(() => (window as unknown as { __claimAt: number }).__claimAt);
			await expect(copy.page.locator(CHIP)).toHaveCount(0);
			if (c.intoSec > 0) {
				// What the new TV TELLS the room after the claim, read off its own sent `playing` frames: never a position
				// back towards 0 (a reload reads 0 until `canplay` seeks it home, and the phones and the lyrics would
				// follow it), and, with no reload at all, no silence either: a frame within 1.5 s and no gap over 1 s.
				const playhead = await copy.page.evaluate(
					() => (window as unknown as { __claimPlayhead: number }).__claimPlayhead
				);
				await copy.page.waitForTimeout(Math.max(0, 4_000 - (Date.now() - claimAt)));
				const told = copy.sent.playing.filter(([at]) => at >= claimAt);
				const said = told.map(([at, sec]) => `+${at - claimAt}ms:${sec.toFixed(2)}`).join(', ');
				expect(told.length, 'the new TV sent no position after the claim').toBeGreaterThan(0);
				expect(told[0][0] - claimAt, `the new TV's first position came late: ${said}`).toBeLessThan(1_500);
				const gaps = told.slice(1).map(([at], i) => at - told[i][0]);
				expect(Math.max(0, ...gaps), `a gap in the new TV's positions: ${said}`).toBeLessThan(1_000);
				expect(
					Math.min(...told.map(([, sec]) => sec)),
					`the new TV sent a position back near 0: ${said}`
				).toBeGreaterThan(playhead - 0.5);
			}

			// THE ROOM MOVES ON within about a second of the claim: the server, every phone, and the new TV's lower-third.
			await expect
				.poll(async () => (await serverPlayback(world.baseURL)).state.currentEntryId, {
					timeout: 1_500,
					intervals: [50]
				})
				.not.toBe(first);
			const boEntry = (await serverPlayback(world.baseURL)).state.currentEntryId;
			expect(boEntry, "the server dropped Bo's song").toBeTruthy();
			const left = Math.max(1, 2_000 - (Date.now() - claimAt));
			for (const p of [phone, bo])
				await expect(p.locator(SEL.npStripTitle).first()).toContainText(/believin/i, { timeout: left });
			await expect(copy.page.locator(SEL.lowerThird)).toContainText(/Bo/, {
				timeout: Math.max(1, 2_000 - (Date.now() - claimAt))
			});

			// THE GUIDE: Bo's song plays the guide mix on the screen that took the seat, with no notice and no media error.
			const srcOf = (p: Page) =>
				p.evaluate(() => [...document.querySelectorAll('audio')].find((e) => !e.paused)?.getAttribute('src') ?? '');
			if (c.noWebAudio) {
				// Degraded: the plain instrumental plays on, never the 4-channel mix with no graph to split it.
				expect(await srcOf(copy.page), 'a copy with no Web Audio switched src').toContain('instrumental');
			} else await expect.poll(() => srcOf(copy.page), { timeout: 15_000 }).toContain('guide');
			if (c.intoSec > 0 && !c.noWebAudio) {
				// IN PLACE: the guide mix starts where the plain song was at the claim, not at 0:00.
				const playhead = await copy.page.evaluate(
					() => (window as unknown as { __claimPlayhead: number }).__claimPlayhead
				);
				await expect
					.poll(() => copy.page.evaluate(() => (window as unknown as { __guideAt?: number[] }).__guideAt?.length ?? 0))
					.toBe(2);
				const at = await copy.page.evaluate(() => (window as unknown as { __guideAt: number[] }).__guideAt);
				for (const t of at)
					expect(
						t,
						`the guide mix restarted Bo's song (claim at ${playhead}, guide at ${at.join(', ')})`
					).toBeGreaterThan(playhead - 0.2);
			}
			await expect(copy.page.getByText(/won.t play|would not play/i)).toHaveCount(0);
			expect((await mediaErrorsOf(copy.page)).slice(errorsBefore), 'media errors across the swap').toEqual([]);
			expect(copy.sent.ended, "an ended frame named Bo's song").not.toContain(boEntry);
			expect((await serverPlayback(world.baseURL)).state.currentEntryId).toBe(boEntry);
		} finally {
			await worker.stop();
		}
	});
}
