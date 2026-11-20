/*
 * ROOM REACTIONS NEVER COVER A WORD. Two phones burst every reaction at once while the TV sings, and every
 * sample reads what the layout engine RESOLVED for each rising disc against each lyric row, the lower-third,
 * "Up next" and the corner QR — the measured-tv-chrome gate's approach, on the real playing branch.
 *
 * Also pinned here, because they are only observable with a song on: the singer's own phone has no reaction
 * row, the server's bucket lets at most 3 per phone through a burst, and the TV never shows more than 12.
 */
import { test, expect, type World } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome } from '../../world/actors';
import type { Page } from '@playwright/test';

const SONG = 'caroline';
const SAMPLE_MS = 80;
const SAMPLE_WINDOW_MS = 3_000;
const MAX_ON_SCREEN = 12;
/** Taps each phone fires in the burst, three times the bucket. */
const TAPS_PER_PHONE = 9;

interface Box {
	l: number;
	t: number;
	r: number;
	b: number;
}
interface Sample {
	discs: Box[];
	chrome: { cls: string; box: Box }[];
}

async function processAndQueue(world: World, page: Page): Promise<void> {
	const track = await world.awaitDemoTrack(SONG);
	const res = await page.request.post('/api/process', { data: { mediaId: track.id } });
	if (!res.ok()) throw new Error(`/api/process refused "${SONG}": ${res.status()} ${await res.text()}`);
	await expect
		.poll(
			async () => {
				const body = (await page.request.get(`/api/search?q=${SONG}`).then((r) => r.json())) as {
					ready: { id: string; instrumentalRef?: string | null; lyricsRef?: string | null }[];
				};
				return body.ready.some((r) => r.id === track.id && !!r.instrumentalRef && !!r.lyricsRef);
			},
			{ timeout: 60_000, message: `"${track.title}" never reached ready with lyrics` }
		)
		.toBe(true);
	await openBrowseFromHome(page);
	await page.locator(SEL.search).fill(SONG);
	await page.locator(SEL.addTurn).first().click();
}

/** Every rising disc and every box it must stay clear of, in one round trip so they describe one frame. */
async function sample(tv: Page): Promise<Sample> {
	return tv.evaluate(
		(sel) => {
			const box = (el: Element) => {
				const r = el.getBoundingClientRect();
				return { l: r.left, t: r.top, r: r.right, b: r.bottom };
			};
			const chrome: { cls: string; box: Box }[] = [];
			for (const [cls, q] of Object.entries(sel.chrome))
				for (const el of document.querySelectorAll(q))
					if (el.getBoundingClientRect().height > 0) chrome.push({ cls, box: box(el) });
			return { discs: [...document.querySelectorAll(sel.disc)].map(box), chrome };
		},
		{
			disc: SEL.tvReaction,
			// Rows, not the `.lyrics` box: that box spans the full stage and is padded by the gutter the lane lives in.
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

const overlap = (a: Box, b: Box) =>
	Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));

/** A song on stage and PAUSED, so it holds still for the whole burst instead of ending under it. */
async function stage(world: World, fanCount: number) {
	const worker = await startFakeWorker(world);
	const star = await world.openPhone('Star');
	const stops = ['End', 'Home', 'PageUp', 'PageDown', 'ArrowLeft'];
	const fans: Page[] = [];
	for (let i = 0; i < fanCount; i++)
		fans.push(await world.openPhone(`Fan ${i + 1}`, { stop: stops[i % stops.length] }));
	// Intro off: the 8 s demo song is all the stage time there is.
	const put = await star.request.put('/api/settings/room', { data: { songIntroEnabled: false } });
	expect(put.ok()).toBe(true);
	await processAndQueue(world, star);

	const tv = await world.openTv();
	await tv.locator(SEL.tvConnected).waitFor({ state: 'attached' });
	// One real tap authorises playback, as a room does. docs/E2E.md#gestures
	await tv.mouse.click(960, 540);
	await expect(tv.locator(SEL.lyricsRow).first()).toBeAttached({ timeout: 25_000 });
	await fans[0].getByRole('button', { name: 'Pause' }).click();
	for (const fan of fans) await expect(fan.locator(SEL.npCheers)).toBeVisible();
	// Counts every disc the TV ever mounts, so a drop is visible even between samples.
	await tv.evaluate((q) => {
		const w = window as unknown as { __mounted: number };
		w.__mounted = 0;
		new MutationObserver((ms) => {
			for (const m of ms) for (const n of m.addedNodes) if (n instanceof Element && n.matches(q)) w.__mounted++;
		}).observe(document.body, { childList: true, subtree: true });
	}, SEL.tvReaction);
	return { worker, star, fans, tv };
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

async function sampleWindow(tv: Page, ms: number): Promise<Sample[]> {
	const samples: Sample[] = [];
	const until = Date.now() + ms;
	while (Date.now() < until) {
		samples.push(await sample(tv));
		await tv.waitForTimeout(SAMPLE_MS);
	}
	return samples;
}

const peakOf = (samples: Sample[]) => Math.max(...samples.map((s) => s.discs.length));

test('two phones bursting reactions never put a disc over the lyrics or the TV chrome', async ({ world }) => {
	const { worker, star, fans, tv } = await stage(world, 2);
	try {
		await expect(star.locator(SEL.npCheers), 'the singer must not be offered a row to cheer themselves').toHaveCount(0);
		await burst(fans);
		const samples = await sampleWindow(tv, SAMPLE_WINDOW_MS);

		const peak = peakOf(samples);
		expect(peak, 'no reaction reached the TV').toBeGreaterThan(0);
		// 9 taps each inside one tick: the bucket lets 3 through per phone, plus at most one refill each.
		const mounted = await tv.evaluate(() => (window as unknown as { __mounted: number }).__mounted);
		expect(mounted, `${mounted} discs mounted — the per-singer rate limit did not hold`).toBeLessThanOrEqual(
			2 * (3 + 1)
		);
		expect(
			samples.some((s) => s.chrome.some((c) => c.cls === 'lyric')),
			'no lyric row was on screen to measure'
		).toBe(true);

		const hits = samples.flatMap((s, i) =>
			s.discs.flatMap((d) =>
				s.chrome.filter((c) => overlap(d, c.box) > 0).map((c) => ({ sample: i, cls: c.cls, disc: d, box: c.box }))
			)
		);
		expect(hits, 'a reaction disc intersected a lyric row or the TV chrome').toEqual([]);
	} finally {
		await worker.stop();
	}
});

test('a room of five bursting at once never puts more than 12 on the TV', async ({ world }) => {
	const { worker, fans, tv } = await stage(world, 5);
	try {
		// 5 x 3 = 15 through the server's buckets, more than the TV shows.
		await burst(fans);
		const samples = await sampleWindow(tv, 4_500);
		const mounted = await tv.evaluate(() => (window as unknown as { __mounted: number }).__mounted);
		expect(peakOf(samples)).toBeLessThanOrEqual(MAX_ON_SCREEN);
		expect(mounted, 'the stream should still deliver a full screen').toBeGreaterThanOrEqual(MAX_ON_SCREEN);
		expect(mounted, 'the oldest waiting reactions should have dropped out').toBeLessThan(15);
	} finally {
		await worker.stop();
	}
});
