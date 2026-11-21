/*
 * ROOM REACTIONS, end to end on the real core: what the server sends to whom, and where the TV draws it.
 *
 * WIRING (server.ts itself, not a copy): every phone's and the TV's WebSocket frames are recorded. A fan's raw
 * `room:react` must reach the TV as `room:reacted` (the positive control that makes the rest mean something);
 * no phone may ever receive one; the singer's own raw frame, and a fan's after the room switched reactions off,
 * must reach nobody.
 *
 * GEOMETRY: while phones burst, every sample reads what the layout engine resolved. Each disc must lie inside the
 * safe area ([safe-x, vw - safe-x]) and clear of every lyric row, the lyrics' content box, the lower-third, Up
 * next, the corner QR, the fullscreen button and the status dot — at 720p, 1080p and 4K, and at the largest
 * lyric scale. No two discs may touch, and the on-screen bound is the release spacing's, ceil(2400 / 650) = 4.
 */
import { test, expect, type World } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome } from '../../world/actors';
import { MAX_LYRICS_SCALE_PCT } from '$lib/contract';
import type { Page } from '@playwright/test';

const SAMPLE_MS = 80;
const SAMPLE_WINDOW_MS = 4_500;
/** ceil(RISE_MS / SPACING_MS) in tv/Reactions.svelte: the most discs the release spacing ever has on screen. */
const ON_SCREEN_BOUND = 4;
/** MAX_WAITING in tv/Reactions.svelte. */
const MAX_WAITING = 6;
/** Taps each phone fires in a burst, three times the bucket. */
const TAPS_PER_PHONE = 9;
/** Long enough for any frame the server sends to have arrived. */
const SETTLE_MS = 1_500;

interface Box {
	l: number;
	t: number;
	r: number;
	b: number;
}
interface Sample {
	discs: Box[];
	chrome: { cls: string; box: Box }[];
	safeX: number;
	vw: number;
}

async function processSong(world: World, page: Page, query: string): Promise<void> {
	const track = await world.awaitDemoTrack(query);
	const res = await page.request.post('/api/process', { data: { mediaId: track.id } });
	if (!res.ok()) throw new Error(`/api/process refused "${query}": ${res.status()} ${await res.text()}`);
	await expect
		.poll(
			async () => {
				const body = (await page.request.get(`/api/search?q=${query}`).then((r) => r.json())) as {
					ready: { id: string; instrumentalRef?: string | null; lyricsRef?: string | null }[];
				};
				return body.ready.some((r) => r.id === track.id && !!r.instrumentalRef && !!r.lyricsRef);
			},
			{ timeout: 60_000, message: `"${track.title}" never reached ready with lyrics` }
		)
		.toBe(true);
}

async function queue(page: Page, query: string): Promise<void> {
	await openBrowseFromHome(page);
	await page.locator(SEL.search).fill(query);
	await page.locator(SEL.addTurn).first().click();
}

/** Every `room:reacted` this page's sockets receive, from the next socket it opens. */
function recordReacted(page: Page): string[] {
	const got: string[] = [];
	page.on('websocket', (ws) =>
		ws.on('framereceived', ({ payload }) => {
			if (typeof payload === 'string' && payload.includes('"room:reacted"')) got.push(payload);
		})
	);
	return got;
}

async function putRoom(page: Page, body: Record<string, unknown>): Promise<void> {
	const res = await page.request.put('/api/settings/room', { data: body });
	if (!res.ok()) throw new Error(`PUT /api/settings/room ${JSON.stringify(body)} -> ${res.status()}`);
}

/**
 * A song on stage with another queued behind it (so Up next shows), PAUSED so it holds still. Every phone and the
 * TV are reloaded after their recorders attach, so each socket the test relies on is a recorded one.
 */
async function stage(world: World, fanCount: number) {
	const worker = await startFakeWorker(world);
	const star = await world.openPhone('Star');
	const stops = ['End', 'Home', 'PageUp', 'PageDown', 'ArrowLeft'];
	const fans: Page[] = [];
	for (let i = 0; i < fanCount; i++)
		fans.push(await world.openPhone(`Fan ${i + 1}`, { stop: stops[i % stops.length] }));
	// Intro off: the 8 s demo song is all the stage time there is.
	await putRoom(star, { songIntroEnabled: false });
	await processSong(world, star, 'caroline');
	await processSong(world, fans[0], 'believin');
	await queue(star, 'caroline');
	await queue(fans[0], 'believin');

	const tv = await world.openTv();
	await tv.locator(SEL.tvConnected).waitFor({ state: 'attached' });
	// One real tap authorises playback, as a room does. docs/E2E.md#gestures
	await tv.mouse.click(960, 540);
	await expect(tv.locator(SEL.lyricsRow).first()).toBeAttached({ timeout: 25_000 });
	await fans[0].getByRole('button', { name: 'Pause' }).click();

	const frames = { tv: recordReacted(tv), star: recordReacted(star), fans: fans.map(recordReacted) };
	for (const p of [star, ...fans]) {
		await p.reload();
		await p.locator(SEL.dock).waitFor({ state: 'attached' });
	}
	await tv.reload();
	await tv.locator(SEL.tvConnected).waitFor({ state: 'attached' });
	await expect(tv.locator(SEL.lyricsRow).first()).toBeAttached({ timeout: 25_000 });
	await tv.mouse.move(1, 1);
	for (const fan of fans) await expect(fan.locator(SEL.npCheers)).toBeVisible();
	await countMounts(tv);
	return { worker, star, fans, tv, frames };
}

/** Counts every disc the TV ever mounts, so one that lives between samples is still seen. */
async function countMounts(tv: Page): Promise<void> {
	await tv.evaluate((q) => {
		const w = window as unknown as { __mounted: number };
		w.__mounted = 0;
		new MutationObserver((ms) => {
			for (const m of ms) for (const n of m.addedNodes) if (n instanceof Element && n.matches(q)) w.__mounted++;
		}).observe(document.body, { childList: true, subtree: true });
	}, SEL.tvReaction);
}
const mounted = (tv: Page) => tv.evaluate(() => (window as unknown as { __mounted: number }).__mounted);

/** A raw `room:react` on a NEW socket from this page, so it carries the page's own session cookie. */
async function rawReact(page: Page, kind = 'clap'): Promise<void> {
	await page.evaluate(
		(kind) =>
			new Promise<void>((resolve, reject) => {
				const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
				ws.onopen = () => {
					ws.send(JSON.stringify({ type: 'room:react', kind }));
					setTimeout(() => (ws.close(), resolve()), 200);
				};
				ws.onerror = () => reject(new Error('raw socket failed'));
			}),
		kind
	);
}

/** Every phone at once, every kind in turn, in one synchronous loop each: a tap per Playwright round trip would
 *  spread the burst across refills and blur what the bucket bound is measuring. */
async function burst(fans: Page[]): Promise<void> {
	await Promise.all(
		fans.map((fan) =>
			fan.locator(SEL.npCheer).evaluateAll((els, n) => {
				for (let i = 0; i < n; i++) (els[i % els.length] as HTMLButtonElement).click();
			}, TAPS_PER_PHONE)
		)
	);
}

/** Every disc and every box it must stay clear of, in one round trip so they describe one frame. */
async function sample(tv: Page): Promise<Sample> {
	return tv.evaluate(
		(sel) => {
			const box = (r: DOMRect) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom });
			// The safe-area inset as the engine resolves it: the token is a max() of env() and viewport terms.
			const probe = document.createElement('div');
			probe.style.cssText = 'position:absolute;visibility:hidden;width:var(--tv-safe-x)';
			document.querySelector(sel.tv)!.appendChild(probe);
			const safeX = probe.getBoundingClientRect().width;
			probe.remove();
			const chrome: { cls: string; box: Box }[] = [];
			for (const [cls, q] of Object.entries(sel.chrome))
				for (const el of document.querySelectorAll(q)) {
					const r = el.getBoundingClientRect();
					if (r.height > 0) chrome.push({ cls, box: box(r) });
				}
			// The reel's CONTENT box: where any row, however long, can paint. The padding is the reserve.
			const lyrics = document.querySelector(sel.lyrics);
			if (lyrics) {
				const r = lyrics.getBoundingClientRect();
				const cs = getComputedStyle(lyrics);
				chrome.push({
					cls: 'lyricsContent',
					box: {
						l: r.left + parseFloat(cs.paddingLeft),
						t: r.top,
						r: r.right - parseFloat(cs.paddingRight),
						b: r.bottom
					}
				});
			}
			return {
				discs: [...document.querySelectorAll(sel.disc)].map((d) => box(d.getBoundingClientRect())),
				chrome,
				safeX,
				vw: window.innerWidth
			};
		},
		{
			tv: SEL.tvRoot,
			disc: SEL.tvReaction,
			lyrics: SEL.lyrics,
			chrome: {
				lyric: SEL.lyricsRow,
				lowerThird: SEL.lowerThird,
				upnext: '.upnext',
				corner: '.corner',
				fullscreen: '.fs-btn',
				status: '.status'
			}
		}
	);
}

async function sampleWindow(tv: Page, ms: number): Promise<Sample[]> {
	const samples: Sample[] = [];
	const until = Date.now() + ms;
	while (Date.now() < until) {
		samples.push(await sample(tv));
		await tv.waitForTimeout(SAMPLE_MS);
	}
	return samples;
}

const overlap = (a: Box, b: Box) =>
	Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
const peakOf = (samples: Sample[]) => Math.max(...samples.map((s) => s.discs.length));

test('the server sends a reaction to the TV only, and refuses the singer and a room that turned them off', async ({
	world
}) => {
	const { worker, star, fans, tv, frames } = await stage(world, 1);
	try {
		// Positive control: a fan's raw frame through server.ts reaches the TV.
		await rawReact(fans[0], 'fire');
		await expect.poll(() => frames.tv.length, { message: 'a fan reaction never reached the TV' }).toBe(1);
		await expect.poll(() => mounted(tv)).toBe(1);

		// The singer cheering their own song: refused by the server, not just hidden on the phone. The row rests there,
		// keeping its slot so the dock does not jump (dock-cls.spec.ts), with no button left to find or tap.
		await expect(star.locator(SEL.npCheers)).toHaveAttribute('inert');
		await expect(star.locator(SEL.npCheer).first()).toHaveCSS('visibility', 'hidden');
		await rawReact(star, 'heart');
		await tv.waitForTimeout(SETTLE_MS);
		expect(frames.tv.length, "the singer's own room:react reached the TV").toBe(1);
		expect(await mounted(tv)).toBe(1);

		// "Reactions on TV" off: the server drops a fan's frame, so the TV's socket hears nothing.
		await putRoom(star, { tvReactions: false });
		await expect(fans[0].locator(SEL.npCheers)).toHaveCount(0);
		await tv.waitForTimeout(1_000); // a full bucket again, so only the setting can refuse it
		await rawReact(fans[0], 'clap');
		await tv.waitForTimeout(SETTLE_MS);
		expect(frames.tv.length, 'a reaction reached the TV with "Reactions on TV" off').toBe(1);

		// No phone ever heard one: not the fan who sent them, not the singer.
		expect(frames.fans[0], 'a fan phone received room:reacted').toEqual([]);
		expect(frames.star, "the singer's phone received room:reacted").toEqual([]);
	} finally {
		await worker.stop();
	}
});

test('bursts stay inside the safe area and clear of the lyrics and TV chrome, at 720p, 1080p, 4K and the largest lyric scale', async ({
	world
}) => {
	const { worker, star, fans, tv, frames } = await stage(world, 2);
	try {
		const hits: unknown[] = [];
		const outside: unknown[] = [];
		const touching: unknown[] = [];
		const cases = [
			{ w: 1920, h: 1080, scale: 100 },
			{ w: 1280, h: 720, scale: 100 },
			{ w: 3840, h: 2160, scale: 100 },
			{ w: 1920, h: 1080, scale: MAX_LYRICS_SCALE_PCT }
		];
		for (const c of cases) {
			const label = `${c.w}x${c.h} @${c.scale}%`;
			await putRoom(star, { lyricsScalePct: c.scale });
			await tv.setViewportSize({ width: c.w, height: c.h });
			// Settle the new layout, and refill every bucket from the previous case.
			await tv.waitForTimeout(3_200);
			const before = await mounted(tv);
			await burst(fans);
			const samples = await sampleWindow(tv, SAMPLE_WINDOW_MS);

			expect(peakOf(samples), `${label}: no reaction reached the TV`).toBeGreaterThan(0);
			expect(peakOf(samples), `${label}: more on screen than the release spacing allows`).toBeLessThanOrEqual(
				ON_SCREEN_BOUND
			);
			// 9 taps each inside one tick: the bucket lets 3 through per phone, plus at most one refill each.
			const n = (await mounted(tv)) - before;
			expect(n, `${label}: ${n} discs mounted — the per-singer rate limit did not hold`).toBeLessThanOrEqual(
				2 * (3 + 1)
			);
			expect(
				samples.some((s) => s.chrome.some((ch) => ch.cls === 'lyric')),
				`${label}: no lyric row on screen to measure`
			).toBe(true);
			for (const [i, s] of samples.entries())
				for (const d of s.discs) {
					if (d.l < s.safeX - 0.5 || d.r > s.vw - s.safeX + 0.5)
						outside.push({ label, sample: i, disc: d, safeX: s.safeX });
					for (const ch of s.chrome)
						if (overlap(d, ch.box) > 0) hits.push({ label, sample: i, cls: ch.cls, disc: d, box: ch.box });
				}
			// Disc against disc: the release spacing must keep every pair apart for the whole rise.
			for (const [i, s] of samples.entries())
				for (let a = 0; a < s.discs.length; a++)
					for (let b = a + 1; b < s.discs.length; b++)
						if (overlap(s.discs[a], s.discs[b]) > 0) touching.push({ label, sample: i, a: s.discs[a], b: s.discs[b] });
		}
		expect(outside, 'a reaction disc left the safe area').toEqual([]);
		expect(hits, 'a reaction disc intersected the lyrics or the TV chrome').toEqual([]);
		expect(touching, 'two reaction discs overlapped each other').toEqual([]);
		expect([...frames.fans.flat(), ...frames.star], 'a phone received room:reacted').toEqual([]);
	} finally {
		await worker.stop();
	}
});

test('a room of five bursting at once: the waiting line drops the oldest, the screen stays within its bound', async ({
	world
}) => {
	const { worker, fans, tv } = await stage(world, 5);
	try {
		// 5 x 3 = 15 through the server's buckets; the TV's waiting line holds MAX_WAITING.
		await burst(fans);
		const samples = await sampleWindow(tv, 8_000);
		const n = await mounted(tv);
		expect(peakOf(samples)).toBeLessThanOrEqual(ON_SCREEN_BOUND);
		expect(n, 'the stream should deliver the full waiting line').toBeGreaterThanOrEqual(MAX_WAITING);
		expect(n, 'the oldest waiting reactions should have dropped out').toBeLessThan(15);
	} finally {
		await worker.stop();
	}
});
