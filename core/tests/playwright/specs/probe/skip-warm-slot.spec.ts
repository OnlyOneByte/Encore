// #1258: a skip onto the song the TV's hidden slot has already pre-warmed uses that slot, as a natural end does, and a
// warmed file the slot already found dead fails at once: no "Now singing" card, no refetch. Maya is singing, Theo is
// next and warmed, Ana after him; Maya taps skip.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { queueReady, transportTap } from '../../world/actors';
import { serverPlayback } from './audio-probe-support';
import type { Page, TestInfo } from '@playwright/test';
import type { World } from '../../world/fixtures';

test.setTimeout(180_000);

async function readyId(world: World, phone: Page, query: string): Promise<string> {
	const track = await world.awaitDemoTrack(query);
	const res = await phone.request.post('/api/process', { data: { mediaId: track.id } });
	if (!res.ok()) throw new Error(`/api/process refused "${track.title}": ${res.status()}`);
	await expect
		.poll(
			async () => {
				const body = (await phone.request.get('/api/library').then((r) => r.json())) as {
					library: { id: string; instrumentalRef?: string | null }[];
				};
				return body.library.some((m) => m.id === track.id && !!m.instrumentalRef);
			},
			{ timeout: 60_000, message: `"${track.title}" never reached ready` }
		)
		.toBe(true);
	return track.id;
}

const current = async (world: World) => (await serverPlayback(world.baseURL)).state.currentEntryId;

/** Maya singing, Theo next, Ana after. `dead` 404s Theo's file before he is queued, so his pre-warm is what finds it. */
async function room(world: World, { dead }: { dead: boolean }) {
	const maya = await world.openPhone('Maya');
	const theo = await world.openPhone('Theo');
	const ana = await world.openPhone('Ana');
	await readyId(world, maya, 'caroline');
	const theoMedia = await readyId(world, maya, 'believin');
	await readyId(world, maya, 'prayer');
	const tv = await world.openTv();
	if (dead) await tv.route(`**/*${theoMedia}*`, (route) => route.fulfill({ status: 404, body: '' }));
	await queueReady(maya, 'caroline');
	const intro = tv.locator(SEL.stateNext);
	await expect(intro).toBeVisible({ timeout: 30_000 });
	await queueReady(theo, 'believin');
	await queueReady(ana, 'prayer');
	await expect(intro).toBeHidden({ timeout: 10_000 });
	return { maya, theo, ana, tv, theoMedia, mayaId: await current(world) };
}

/** Waits for the hidden slot's element holding Theo's file to settle (buffered, or errored), and tags it. Then logs
 *  every reload event on any element holding his file, and counts the TV's requests for it. */
async function armWarmSlot(tv: Page, theoMedia: string, settled: 'buffered' | 'errored') {
	await expect
		.poll(
			() =>
				tv.evaluate(
					({ id, settled }) => {
						const el = [...document.querySelectorAll('audio')].find((a) => (a.getAttribute('src') ?? '').includes(id));
						if (!el) return false;
						const ok = settled === 'errored' ? !!el.error : el.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA;
						if (ok) el.dataset.probeWarm = '1';
						return ok;
					},
					{ id: theoMedia, settled }
				),
			{ timeout: 20_000, message: `the hidden slot never ${settled} Theo's file` }
		)
		.toBe(true);
	await tv.evaluate((id) => {
		const w = window as unknown as { reloads: string[] };
		w.reloads = [];
		for (const ev of ['abort', 'emptied', 'loadstart'])
			document.addEventListener(
				ev,
				(e) => {
					const el = e.target as HTMLMediaElement;
					if ((el.getAttribute?.('src') ?? '').includes(id) || el.dataset?.probeWarm) w.reloads.push(ev);
				},
				true
			);
	}, theoMedia);
	const fetches: string[] = [];
	// His audio only: the lyrics reel fetches his words when his turn comes, which is right.
	tv.on('request', (r) => r.resourceType() === 'media' && r.url().includes(theoMedia) && fetches.push(r.url()));
	return fetches;
}

/** Which frames painted Theo's card or the notice, per animation frame. */
async function sampleFrames(tv: Page): Promise<void> {
	await tv.evaluate(() => {
		const w = window as unknown as { seen: Record<string, number> };
		w.seen = {};
		const watch: Record<string, [string, string]> = {
			cardTheo: ['.state-next', 'Theo'],
			notice: ['.state-error', "Theo's song wouldn't play"]
		};
		const tick = () => {
			for (const [label, [sel, text]] of Object.entries(watch))
				if (document.querySelector(sel)?.textContent?.includes(text)) w.seen[label] = (w.seen[label] ?? 0) + 1;
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
}
const seen = (tv: Page) => tv.evaluate(() => (window as unknown as { seen: Record<string, number> }).seen);

/** Stills every ~100 ms from the skip on, for the PR's GIF: `skip-<n>.png` in the test's output folder. */
function filmstrip(tv: Page, testInfo: TestInfo, ms: number): Promise<void> {
	return (async () => {
		const end = Date.now() + ms;
		for (let i = 0; Date.now() < end; i++) {
			await tv.screenshot({ path: testInfo.outputPath(`skip-${String(i).padStart(3, '0')}.png`), scale: 'css' });
			await tv.waitForTimeout(60);
		}
	})();
}

test('a skip onto the warmed next song plays it from the slot that buffered it: no reload, no refetch', async ({
	world
}, testInfo) => {
	const worker = await startFakeWorker(world);
	try {
		const r = await room(world, { dead: false });
		const fetches = await armWarmSlot(r.tv, r.theoMedia, 'buffered');
		await sampleFrames(r.tv);
		const film = filmstrip(r.tv, testInfo, 5_000);
		await transportTap(r.maya, 'skip');
		await expect.poll(() => current(world), { timeout: 10_000 }).not.toBe(r.mayaId);
		// The handoff is unchanged: Theo still gets his card.
		await expect(r.tv.locator(SEL.stateNext)).toContainText('Theo', { timeout: 5_000 });
		// Then his song plays, on the element that warmed it.
		await expect
			.poll(
				() =>
					r.tv.evaluate(() => {
						const el = document.querySelector<HTMLAudioElement>('audio[data-probe-warm]');
						return !!el && !el.paused && el.currentTime > 0.5 && !!el.closest('.slot.visible');
					}),
				{ timeout: 15_000, message: 'Theo’s song never played from the slot that warmed it' }
			)
			.toBe(true);
		await film;
		expect(await r.tv.evaluate(() => (window as unknown as { reloads: string[] }).reloads)).toEqual([]);
		expect(fetches, 'the TV fetched Theo’s file again after the skip').toEqual([]);
	} finally {
		await worker.stop();
	}
});

test('a skip onto a warmed file that is already dead fails it at once: the notice, no card, no refetch', async ({
	world
}) => {
	const worker = await startFakeWorker(world);
	try {
		const r = await room(world, { dead: true });
		const fetches = await armWarmSlot(r.tv, r.theoMedia, 'errored');
		await sampleFrames(r.tv);
		await transportTap(r.maya, 'skip');
		const t0 = Date.now();
		await expect(r.tv.locator(SEL.stateError)).toContainText("Theo's song wouldn't play", { timeout: 5_000 });
		expect(Date.now() - t0, 'the notice waited on something').toBeLessThan(2_000);
		await expect(r.tv.locator(SEL.stateError)).toContainText('Up next - Ana');
		expect((await seen(r.tv)).cardTheo ?? 0, 'frames of "Now singing · Theo" for a file already known dead').toBe(0);
		expect(fetches, 'the TV fetched Theo’s dead file again').toEqual([]);
		// The room still moves on: Ana's card follows the notice.
		await expect.poll(async () => (await serverPlayback(world.baseURL)).state.currentEntryId).not.toBe(r.mayaId);
		await expect(r.tv.locator(SEL.stateNext)).toContainText('Ana', { timeout: 10_000 });
	} finally {
		await worker.stop();
	}
});

test('#1277 a natural end onto a warmed file that is already dead fails it at once: the notice, no card, no refetch', async ({
	world
}) => {
	const worker = await startFakeWorker(world);
	try {
		const maya = await world.openPhone('Maya');
		const theo = await world.openPhone('Theo');
		const ana = await world.openPhone('Ana');
		await readyId(world, maya, 'caroline');
		const theoMedia = await readyId(world, maya, 'believin');
		await readyId(world, maya, 'prayer');
		const tv = await world.openTv();
		await tv.route(`**/*${theoMedia}*`, (route) => route.fulfill({ status: 404, body: '' }));
		// Armed before anyone queues: Maya's 8 s song plays out on its own, and every frame of it is watched.
		await sampleFrames(tv);
		await tv.evaluate((id) => {
			const w = window as unknown as { mayaEndedAt?: number };
			document.addEventListener(
				'ended',
				(e) => {
					const src = (e.target as HTMLMediaElement).getAttribute('src') ?? '';
					if (!src.includes(id)) w.mayaEndedAt ??= Date.now();
				},
				true
			);
		}, theoMedia);
		await queueReady(maya, 'caroline');
		await queueReady(theo, 'believin');
		await queueReady(ana, 'prayer');
		// Theo's pre-warm finds his file dead while Maya sings; count his audio requests from then on.
		const fetches = await armWarmSlot(tv, theoMedia, 'errored');
		const notice = tv.locator(SEL.stateError);
		await expect(notice).toContainText("Theo's song wouldn't play", { timeout: 20_000 });
		const noticeAt = Date.now();
		const mayaEndedAt = await tv.evaluate(() => (window as unknown as { mayaEndedAt?: number }).mayaEndedAt);
		expect(mayaEndedAt, 'Maya’s song never ended on its own').toBeDefined();
		expect(noticeAt - mayaEndedAt!, 'the notice waited on a reload').toBeLessThan(2_000);
		// No "Up next" line here, unlike a skip: at a natural end the TV has not heard who follows Theo yet, the same as
		// any missed-preload failure today.
		expect((await seen(tv)).cardTheo ?? 0, 'frames of "Now singing · Theo" for a file already known dead').toBe(0);
		expect(fetches, 'the TV fetched Theo’s dead file again').toEqual([]);
		// The room moves on to Ana with her card, and Theo's never shows.
		await expect(tv.locator(SEL.stateNext)).toContainText('Ana', { timeout: 10_000 });
		expect((await seen(tv)).cardTheo ?? 0).toBe(0);
	} finally {
		await worker.stop();
	}
});

test('#1298 review: the TV’s `failed` for that dead song is lost, and the room still moves on to Ana', async ({
	world
}) => {
	const worker = await startFakeWorker(world);
	try {
		const maya = await world.openPhone('Maya');
		const theo = await world.openPhone('Theo');
		const ana = await world.openPhone('Ana');
		await readyId(world, maya, 'caroline');
		const theoMedia = await readyId(world, maya, 'believin');
		await readyId(world, maya, 'prayer');
		const tv = await world.openTv();
		await tv.route(`**/*${theoMedia}*`, (route) => route.fulfill({ status: 404, body: '' }));
		// The first `failed` the TV sends never leaves it: the same net state as a socket down at the end.
		await tv.evaluate(() => {
			const w = window as unknown as { failedSends: number };
			w.failedSends = 0;
			const send = WebSocket.prototype.send;
			WebSocket.prototype.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
				if (typeof data === 'string' && data.includes('"status":"failed"') && w.failedSends++ === 0) return;
				send.call(this, data);
			};
		});
		await queueReady(maya, 'caroline');
		await queueReady(theo, 'believin');
		await queueReady(ana, 'prayer');
		await armWarmSlot(tv, theoMedia, 'errored');
		await expect(tv.locator(SEL.stateError)).toContainText("Theo's song wouldn't play", { timeout: 20_000 });
		// Without the re-send the server sat on Theo, playing, at 0:00, with no slot to fail him again.
		await expect(tv.locator(SEL.stateNext)).toContainText('Ana', { timeout: 15_000 });
		const sends = await tv.evaluate(() => (window as unknown as { failedSends: number }).failedSends);
		expect(sends, 'the lost `failed` was never sent again').toBeGreaterThanOrEqual(2);
		expect(sends, 'the re-send looped').toBeLessThanOrEqual(3);
	} finally {
		await worker.stop();
	}
});
