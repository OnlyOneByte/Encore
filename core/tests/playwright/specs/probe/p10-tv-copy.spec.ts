// Proposal 10, the screen half: a second /tv is a COPY. It shows the same song, plays it muted (`muted` AND volume 0,
// since iOS Safari ignores `.volume`), makes no AudioContext, sends no telemetry, and offers "Make this the TV"; one tap
// moves the seat, the old TV goes silent BEFORE the new one plays, and the old TV turns into the copy. The real TV shows
// nothing new. `SHOT_DIR=<dir>` also writes the screenshots the PR shows.
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

type Screen = { page: Page; sent: { telemetry: number; ended: string[] } };

/**
 * A /tv on its own context, counting the telemetry frames it sends and the AudioContexts it makes or resumes. `real`
 * is the room's TV (the world's screen); any other gets its own `encore_tv` from GET /tv, so it is a second screen.
 * `holdVerdict` drops the server's `tv:seat` frames on their way in, so the page never learns what it is.
 */
async function openScreen(
	browser: Browser,
	world: World,
	width: number,
	height: number,
	{ real = false, holdVerdict = false, resumeMs = 0 } = {}
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
	const sent = { telemetry: 0, ended: [] as string[] };
	const count = (payload: string | Buffer) => {
		if (!String(payload).includes('"tv:telemetry"')) return;
		sent.telemetry++;
		const f = JSON.parse(String(payload)) as { status: string; entryId?: string };
		if (f.status === 'ended') sent.ended.push(f.entryId ?? '');
	};
	if (holdVerdict) {
		await page.routeWebSocket(/\/ws\?role=tv/, (ws) => {
			const server = ws.connectToServer();
			ws.onMessage((m) => {
				count(m);
				server.send(m);
			});
			server.onMessage((m) => {
				if (!String(m).includes('"tv:seat"')) ws.send(m);
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
		// Bo's guide-mix song is queued BEFORE the claim, so the copy pre-warms it while silent (the r5 repro).
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
		// The takeover's own text since #992 ("That song won't play"), and the older wording too.
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

// THE SKIP ONTO A GUIDE-MIX SONG, on the TV alone (r6 review). A plain song plays; a skip makes a guide-mix song
// current in the SAME slot, which has no routed split graph yet, so its mix decision is pending for as long as the
// audio start takes. Until then the element must be SILENT: it still holds the skipped song.
for (const resumeMs of [0, 3_000]) {
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
			for (let i = 0; i < 60; i++) {
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
