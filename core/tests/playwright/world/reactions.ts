// A ROOM WITH CHEERS: a paused song on a TV and fans whose cheer rows are live, in ONE place, so the reaction
// probe (specs/probe/reactions-lane.spec.ts) and the `tv-reaction-lane` motion row (specs/shot/motion.spec.ts)
// stage the same room and burst the same way.
import { expect, type Page } from '@playwright/test';
import { SEL } from './selectors';
import { startFakeWorker } from './workers';
import { TEST_HOST_KEY } from './core';
import { openBrowseFromHome, transportTap } from './actors';
import type { World } from './fixtures';

/** Taps each phone fires in a burst, three times the bucket. */
const TAPS_PER_PHONE = 9;

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

/** A room setting, written as the host: the page's context is unlocked first. */
export async function putRoom(page: Page, body: Record<string, unknown>): Promise<void> {
	const host = await page.request.post('/api/host', { data: { key: TEST_HOST_KEY } });
	if (!host.ok()) throw new Error(`POST /api/host -> ${host.status()}`);
	const res = await page.request.put('/api/settings/room', { data: body });
	if (!res.ok()) throw new Error(`PUT /api/settings/room ${JSON.stringify(body)} -> ${res.status()}`);
}

/**
 * A song on stage with another queued behind it (so Up next shows), PAUSED so it holds still. Every phone and the
 * TV are reloaded after their recorders attach, so each socket the test relies on is a recorded one.
 */
export async function stage(world: World, fanCount: number) {
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
	await transportTap(fans[0], 'playPause');

	const frames = { tv: recordReacted(tv), star: recordReacted(star), fans: fans.map(recordReacted) };
	for (const p of [star, ...fans]) {
		await p.reload();
		await p.locator(SEL.dock).waitFor({ state: 'attached' });
	}
	await tv.reload();
	await tv.locator(SEL.tvConnected).waitFor({ state: 'attached' });
	await expect(tv.locator(SEL.lyricsRow).first()).toBeAttached({ timeout: 25_000 });
	await tv.mouse.move(1, 1);
	// LIVE, not just present: a resting Cheer key keeps its slot, so presence alone proves nothing. `burst` taps
	// through `HTMLElement.click()`, which fires on an inert button too, so it cannot tell either.
	for (const fan of fans) {
		await expect(fan.locator(SEL.npCheerKey)).not.toHaveAttribute('inert');
		await expect(fan.locator(SEL.npCheerKey)).toHaveCSS('visibility', 'visible');
	}
	await countMounts(tv);
	return { worker, star, fans, tv, frames };
}

/** Counts every disc the TV ever mounts, so one that lives between samples is still seen. */
export async function countMounts(tv: Page): Promise<void> {
	await tv.evaluate((q) => {
		const w = window as unknown as { __mounted: number };
		w.__mounted = 0;
		new MutationObserver((ms) => {
			for (const m of ms) for (const n of m.addedNodes) if (n instanceof Element && n.matches(q)) w.__mounted++;
		}).observe(document.body, { childList: true, subtree: true });
	}, SEL.tvReaction);
}
export const mounted = (tv: Page) => tv.evaluate(() => (window as unknown as { __mounted: number }).__mounted);

/** Every phone at once, every kind in turn, in one synchronous loop each: a tap per Playwright round trip would
 *  spread the burst across refills and blur what the bucket bound is measuring. */
export async function burst(fans: Page[]): Promise<void> {
	// The Cheer key opens the tray first, a real pointer tap, outside the timed loop.
	for (const fan of fans)
		if ((await fan.locator(SEL.npCheers).count()) === 0) await fan.locator(SEL.npCheerKey).click({ timeout: 5_000 });
	await Promise.all(
		fans.map((fan) =>
			fan.locator(SEL.npCheer).evaluateAll((els, n) => {
				for (let i = 0; i < n; i++) (els[i % els.length] as HTMLButtonElement).click();
			}, TAPS_PER_PHONE)
		)
	);
}
