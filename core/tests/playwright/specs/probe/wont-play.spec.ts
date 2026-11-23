// Proposal 11: a song that won't play never stalls the room. Maya is singing, Theo is next, Ana after him. Maya taps
// skip and Theo's song fails one way or another; within the watchdog's 8 s the TV says whose song it was, Ana is
// singing, and Theo's turn is still queued in the spot it held. Theo's phone alone says "Your song didn't play" (PR 2),
// and his Try again makes his song the next one.
// The evidence run on main (encore/evidence/p11): a dead file was marked `done` like a song he sang, and a rejected
// play() sat on "This song won't play" for the full 30 s.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome, openQueue, queueReady } from '../../world/actors';
import { autoplayIsBlocked, requireActivationForPlayback } from '../../world/autoplay';
import { serverPlayback } from './audio-probe-support';
import type { Page, TestInfo } from '@playwright/test';
import type { World } from '../../world/fixtures';
import type { QueueEntry } from '$lib/contract';

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

type Sync = { entries: QueueEntry[]; singers?: { id: string; displayName: string }[] };
/** The server's queue, read over its own socket, so no screen is the witness for what the server holds. */
async function serverQueue(baseURL: string): Promise<QueueEntry[]> {
	return (await serverSync(baseURL)).entries;
}
/** Theo's ONE entry. Found by singer, not by "current after the skip": a dead file is past him before that read. */
async function theoEntry(baseURL: string): Promise<QueueEntry | undefined> {
	const sync = await serverSync(baseURL);
	const theo = sync.singers?.find((s) => s.displayName === 'Theo')?.id;
	return sync.entries.find((e) => e.singerId === theo);
}
function serverSync(baseURL: string): Promise<Sync> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${baseURL.replace(/^http/, 'ws')}/ws?role=probe`);
		const timer = setTimeout(() => reject(new Error('no queue:sync within 5 s')), 5_000);
		ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', lastRev: 0 }));
		ws.onmessage = (ev: MessageEvent) => {
			const e = JSON.parse(String(ev.data)) as { type: string } & Partial<Sync>;
			if (e.type !== 'queue:sync' || !e.entries) return;
			clearTimeout(timer);
			ws.close();
			resolve({ entries: e.entries, singers: e.singers });
		};
	});
}
/** What PAINTS, frame by frame: per label, the wall-clock ms of the first animation frame it was on screen, and how
 *  many frames it was. A MutationObserver would count a node that came and went inside one task and never painted. */
async function sampleFrames(page: Page, watch: Record<string, [selector: string, text: string]>): Promise<void> {
	await page.evaluate((watch) => {
		const w = window as unknown as { seen: Record<string, { at: number; frames: number }> };
		w.seen = {};
		const tick = () => {
			for (const [label, [sel, text]] of Object.entries(watch)) {
				if (!document.querySelector(sel)?.textContent?.includes(text)) continue;
				const hit = (w.seen[label] ??= { at: Date.now(), frames: 0 });
				hit.frames++;
			}
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	}, watch);
}
const seen = (page: Page) =>
	page.evaluate(() => (window as unknown as { seen: Record<string, { at: number; frames: number }> }).seen);

/** Every media element that starts, with when and what: `playing` doesn't bubble, so it is caught on the way down. */
async function recordStarts(page: Page): Promise<void> {
	await page.evaluate(() => {
		const w = window as unknown as { starts: { at: number; src: string }[] };
		w.starts = [];
		document.addEventListener(
			'playing',
			(e) => w.starts.push({ at: Date.now(), src: (e.target as HTMLMediaElement).currentSrc }),
			true
		);
	});
}
const starts = (page: Page) =>
	page.evaluate(() => (window as unknown as { starts: { at: number; src: string }[] }).starts);

const current = async (world: World) => (await serverPlayback(world.baseURL)).state.currentEntryId;

/** Theo's song, on the TV, refuses to start: play() rejects and the element stays paused. A tap cannot lift it. */
async function rejectPlayFor(tv: Page, mediaId: string) {
	await tv.evaluate((id) => {
		const orig = HTMLMediaElement.prototype.play;
		HTMLMediaElement.prototype.play = function () {
			if ((this.getAttribute('src') ?? '').includes(id))
				return Promise.reject(new DOMException('no supported sources', 'NotSupportedError'));
			return orig.call(this);
		};
	}, mediaId);
}

/** Once Theo's song has played `afterSec`, its playhead stops while the room still means to play. `sticky` survives
 *  the TV's one reload (a dead connection); otherwise the reload clears it (a wifi hiccup). */
async function stallFor(tv: Page, mediaId: string, afterSec: number, sticky: boolean) {
	await tv.evaluate(
		({ id, afterSec, sticky }) => {
			const w = window as unknown as { stalledAt?: number };
			const poll = setInterval(() => {
				const el = [...document.querySelectorAll('audio')].find((a) => (a.getAttribute('src') ?? '').includes(id));
				if (!el || el.paused || el.currentTime < afterSec) return;
				clearInterval(poll);
				w.stalledAt = el.currentTime;
				if (sticky) el.defaultPlaybackRate = 0;
				el.playbackRate = 0;
			}, 50);
		},
		{ id: mediaId, afterSec, sticky }
	);
}

/** Maya singing, Theo next with `theoMedia`, Ana after; `breakIt` runs on the TV before Maya's skip. */
async function room(world: World, breakIt?: (tv: Page, theoMedia: string) => Promise<void>) {
	const maya = await world.openPhone('Maya');
	const theo = await world.openPhone('Theo');
	const ana = await world.openPhone('Ana');
	await readyId(world, maya, 'caroline');
	const theoMedia = await readyId(world, maya, 'believin');
	await readyId(world, maya, 'prayer');
	const tv = await world.openTv();
	const warnings: string[] = [];
	tv.on('console', (m) => m.type() === 'warning' && warnings.push(m.text()));
	await queueReady(maya, 'caroline');
	const intro = tv.locator(SEL.stateNext);
	await expect(intro).toBeVisible({ timeout: 30_000 });
	await queueReady(theo, 'believin');
	await queueReady(ana, 'prayer');
	await expect(intro).toBeHidden({ timeout: 10_000 });
	const mayaId = await current(world);
	await breakIt?.(tv, theoMedia);
	return { maya, theo, ana, tv, theoMedia, mayaId, warnings };
}

async function skipMaya(
	world: World,
	{ maya, tv, ana, theo, mayaId }: { maya: Page; tv: Page; ana: Page; theo: Page; mayaId: string | null }
): Promise<{ t0: number; theoId: string }> {
	const theoId = (await theoEntry(world.baseURL))!.id;
	await sampleFrames(tv, {
		notice: [SEL.stateError, "Theo's song wouldn't play"],
		cardAna: [SEL.stateNext, 'Ana'],
		cardTheo: [SEL.stateNext, 'Theo']
	});
	await sampleFrames(ana, { youreUp: ['.youre-up', ''] });
	await sampleFrames(theo, { didntPlay: ['[data-testid="song-didnt-play"]', ''] });
	await recordStarts(tv);
	await maya.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
	const t0 = Date.now();
	await expect.poll(() => current(world), { timeout: 10_000 }).not.toBe(mayaId);
	return { t0, theoId };
}

/** Stills for the PR: one PNG per page, named `<step>-<page>.png` in the test's output folder. */
type Shoot = (step: string, pages: Record<string, Page>) => Promise<unknown>;
const shooter =
	(testInfo: TestInfo): Shoot =>
	(step, pages) =>
		Promise.all(Object.entries(pages).map(([n, p]) => p.screenshot({ path: testInfo.outputPath(`${step}-${n}.png`) })));

/** The moment the room moved on, and everything every screen and the server say about it. */
async function expectMovedOn(
	world: World,
	r: Awaited<ReturnType<typeof room>>,
	theoId: string,
	t0: number,
	shoot?: Shoot
) {
	const notice = r.tv.locator(SEL.stateError);
	await expect(notice).toContainText("Theo's song wouldn't play", { timeout: 12_000 });
	if (shoot) {
		await r.theo.getByTestId('song-didnt-play').waitFor();
		await r.tv.waitForTimeout(800); // past the takeover's fade-in (--motion-slow), well inside the 4 s notice
		await shoot('failed', { tv: r.tv, theo: r.theo, ana: r.ana });
	}
	await expect
		.poll(async () => (await seen(r.tv)).notice?.at, { message: 'no frame painted the notice' })
		.toBeDefined();
	const noticeAt = (await seen(r.tv)).notice!.at;
	const failedAfterMs = noticeAt - t0;
	await expect(notice).toContainText('Up next - Ana');
	// The room's words, never the browser's.
	await expect(notice).not.toContainText(/Error|NotSupported|track would not play/);
	await expect.poll(async () => (await serverQueue(world.baseURL)).find((e) => e.id === theoId)?.status).toBe('queued');
	const q = await serverQueue(world.baseURL);
	const theoEntry = q.find((e) => e.id === theoId)!;
	const anaEntry = q.find((e) => e.singerId !== theoEntry.singerId && e.status === 'playing');
	expect(theoEntry.playFailed).toBe(true);
	// HIS SPOT: still ahead of Ana's, who is singing now.
	expect(anaEntry).toBeDefined();
	expect(theoEntry.rotationSeq).toBeLessThan(anaEntry!.rotationSeq);
	await expect(r.ana.locator(SEL.npStripWho)).toHaveText('Ana');
	// HELD while the notice says she is up next: the room is paused and the TV's song has not moved.
	for (const at of [1_000, 3_000]) {
		await r.tv.waitForTimeout(Math.max(0, at - (Date.now() - noticeAt)));
		await expect(notice).toBeVisible();
		// The lower-third does not name Ana as singing while the notice still says she is up next.
		// Read NOW, not polled: a polled `toBeHidden` waits until the room leaves the stage and passes for that reason.
		const lowerThird = await r.tv.locator(SEL.lowerThird).evaluate((el) => getComputedStyle(el).visibility);
		expect(lowerThird, `lower-third ${at} ms into the notice`).toBe('hidden');
		expect((await serverPlayback(world.baseURL)).state.isPlaying, `room playing ${at} ms into the notice`).toBe(false);
		const t = await r.tv.locator(SEL.slotVisibleAudio).evaluate((a) => (a as HTMLAudioElement).currentTime);
		expect(t, `Ana's song moved ${at} ms into the notice`).toBeLessThan(0.05);
	}
	// After the notice, ONE handoff: the TV's "Now singing · Ana" and her phone's "You're up" together, song starting.
	await r.tv.locator(SEL.stateNext, { hasText: 'Ana' }).waitFor({ timeout: 8_000 });
	await r.ana.locator('.youre-up').waitFor({ timeout: 8_000 });
	const cardAt = (await seen(r.tv)).cardAna!.at;
	const sheetAt = (await seen(r.ana)).youreUp!.at;
	expect(Math.abs(cardAt - sheetAt), 'the TV card and You’re up rise together').toBeLessThan(750);
	expect(cardAt - noticeAt, 'the card follows the whole notice').toBeGreaterThan(3_800);
	await expect(notice).toBeHidden();
	// NOT EVEN FOR A ROUND TRIP: the swap to Ana's warmed slot must not start her song before the server's hold lands.
	// The 1 s and 3 s reads above can't see a few ms of audio; every start the TV made since the skip can.
	const early = (await starts(r.tv)).filter((s) => !s.src.includes(r.theoMedia) && s.at < cardAt - 200);
	expect(early, 'a song other than Theo’s started under the notice').toEqual([]);
	await expect.poll(() => serverPlayback(world.baseURL).then((p) => p.state.isPlaying)).toBe(true);
	await expect
		.poll(() => r.tv.locator(SEL.slotVisibleAudio).evaluate((a) => (a as HTMLAudioElement).currentTime))
		.toBeGreaterThan(0.2);
	// THEO'S PHONE SAYS SO (PR 2), in his colour, with both ways back; it came up with the failure, inside the 8 s.
	const sheet = r.theo.getByTestId('song-didnt-play');
	await expect(sheet).toBeVisible();
	expect((await seen(r.theo)).didntPlay!.at - t0, 'Theo’s sheet within 8 s of his song coming up').toBeLessThan(10_000);
	await expect(sheet).toContainText('Your song didn’t play');
	await expect(sheet).toContainText(/believin/i);
	await expect(sheet).toContainText('You keep your spot.');
	await expect(sheet.getByTestId('didnt-play-retry')).toBeVisible();
	await expect(sheet.getByTestId('didnt-play-pick')).toBeVisible();
	await expect(r.theo.locator('.youre-up')).toHaveCount(0);
	// Other phones get nothing new: the TV tells the room.
	for (const p of [r.maya, r.ana]) {
		await expect(p.getByTestId('song-didnt-play')).toHaveCount(0);
		expect(await p.locator('body').innerText()).not.toMatch(/wouldn.t play|didn.t play/i);
	}
	return failedAfterMs;
}

/** The server's own up-next (what the TV preloads), read over a probe socket like `serverSync`. */
function serverUpNext(baseURL: string): Promise<string | null> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${baseURL.replace(/^http/, 'ws')}/ws?role=probe`);
		const timer = setTimeout(() => reject(new Error('no nowplaying:changed within 5 s')), 5_000);
		ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', lastRev: 0 }));
		ws.onmessage = (ev: MessageEvent) => {
			const e = JSON.parse(String(ev.data)) as { type: string; upNext?: { id: string } | null };
			if (e.type !== 'nowplaying:changed') return;
			clearTimeout(timer);
			ws.close();
			resolve(e.upNext?.id ?? null);
		};
	});
}

/** Theo taps Try again on his sheet: the hold lifts and his song is the next one, from the spot it kept. */
async function tryAgain(world: World, r: Awaited<ReturnType<typeof room>>, theoId: string) {
	await r.theo.getByTestId('didnt-play-retry').click();
	await expect(r.theo.getByTestId('song-didnt-play')).toBeHidden();
	await expect
		.poll(async () => (await serverQueue(world.baseURL)).find((e) => e.id === theoId)?.playFailed)
		.toBe(false);
	await expect.poll(() => serverUpNext(world.baseURL), { message: 'Theo’s song is up next' }).toBe(theoId);
	// His queue tab agrees: his row is numbered again, and crowned next.
	await openQueue(r.theo);
	const row = r.theo.locator(SEL.queueRow, { hasText: /believin/i });
	await expect(row).not.toContainText('Didn’t play');
	await expect(row).toHaveClass(/\bup\b/);
	// Ana's song is cut short, and the room plays his next.
	await r.maya.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
}

test('a dead file: the TV says whose song it was at once, and Theo keeps his spot', async ({ world }, testInfo) => {
	const shoot = shooter(testInfo);
	const worker = await startFakeWorker(world);
	try {
		const r = await room(world, (tv, id) =>
			tv.route(`**/*${id}*`, (route) => route.fulfill({ status: 404, body: '' }))
		);
		// A file that is already dead must never be announced as starting: no "Now singing · Theo" paints, not once.
		const { t0, theoId } = await skipMaya(world, r);
		const ms = await expectMovedOn(world, r, theoId, t0, shoot);
		expect(ms, 'a file error fails at once, without waiting out the watchdog').toBeLessThan(3_000);
		// At most ONE frame (≤17 ms): a dead file that missed its pre-warm is cold-loaded, and the loading card can paint
		// once before the 404 comes back. The review measured ~80 ms (the card plus the watchdog's first tick).
		expect(
			(await seen(r.tv)).cardTheo?.frames ?? 0,
			'frames of "Now singing · Theo" for a dead file'
		).toBeLessThanOrEqual(1);
		// Try again plays it next; the file is still dead, so it fails a second time, and now only Pick another is left.
		await tryAgain(world, r, theoId);
		await expect(r.tv.locator(SEL.stateError)).toContainText("Theo's song wouldn't play", { timeout: 12_000 });
		await expect.poll(async () => (await theoEntry(world.baseURL))?.playFailures).toBe(2);
		const sheet = r.theo.getByTestId('song-didnt-play');
		await expect(sheet).toBeVisible();
		await expect(sheet.getByTestId('didnt-play-retry')).toHaveCount(0);
		await expect(sheet.getByTestId('didnt-play-pick')).toBeVisible();
		const row = r.theo.locator(SEL.queueRow, { hasText: /believin/i });
		await expect(row.getByTestId('row-retry')).toHaveCount(0);
		await expect(row.getByTestId('row-pick-another')).toBeVisible();
		await r.tv.waitForTimeout(800);
		await shoot('failed-twice', { tv: r.tv, theo: r.theo });
		const size = r.theo.viewportSize()!;
		await r.theo.setViewportSize({ width: 320, height: 568 });
		await shoot('failed-twice-320', { theo: r.theo });
		await r.theo.setViewportSize(size);
		// Pick another keeps his spot: the Sing tab in replace mode, and the song he picks takes the same turn.
		await sheet.getByTestId('didnt-play-pick').click();
		await r.theo.waitForURL((u) => u.pathname === '/' && u.searchParams.has('replace'));
		await expect(r.theo).toHaveTitle('Pick another · Encore');
		await expect(r.theo.getByTestId('song-didnt-play')).toHaveCount(0);
		await r.theo.locator(SEL.search).fill('caroline');
		// The ready one: its row's action is the plain add, which in replace mode swaps the turn's song.
		await r.theo.locator(SEL.addTurn).first().click();
		await r.theo.waitForURL((u) => u.pathname === '/queue');
		await expect
			.poll(async () => {
				const e = await theoEntry(world.baseURL);
				return (
					e && { id: e.id, playFailed: e.playFailed, playFailures: e.playFailures, changed: e.mediaId !== r.theoMedia }
				);
			})
			.toEqual({ id: theoId, playFailed: false, playFailures: 0, changed: true });
	} finally {
		await worker.stop();
	}
});

test('a song that refuses to start: one quiet retry at 4 s, moved on at 8 s, and no "Tap anywhere"', async ({
	world
}) => {
	// #974 ignores a rejection whose src the slot has LEFT. This one is for the src it holds, so it must still fail.
	const worker = await startFakeWorker(world);
	try {
		const r = await room(world, rejectPlayFor);
		const { t0, theoId } = await skipMaya(world, r);
		const ms = await expectMovedOn(world, r, theoId, t0);
		expect(ms, 'not before the watchdog: a slow start is not a failure').toBeGreaterThan(7_500);
		expect(ms).toBeLessThan(10_000);
		expect(r.warnings.filter((w) => w.includes('reloading it once'))).toHaveLength(1);
		await expect(r.tv.locator(SEL.autoplayHint)).toBeHidden();
		await tryAgain(world, r, theoId);
		await expect.poll(() => current(world), { timeout: 10_000 }).toBe(theoId);
	} finally {
		await worker.stop();
	}
});

test('a song that stalls mid-file: the reload does not save it, and the room moves on', async ({ world }) => {
	const worker = await startFakeWorker(world);
	try {
		const r = await room(world, (tv, id) => stallFor(tv, id, 1, true));
		const { t0, theoId } = await skipMaya(world, r);
		await expectMovedOn(world, r, theoId, t0);
		expect(r.warnings.filter((w) => w.includes('reloading it once'))).toHaveLength(1);
		await tryAgain(world, r, theoId);
		await expect.poll(() => current(world), { timeout: 10_000 }).toBe(theoId);
	} finally {
		await worker.stop();
	}
});

test('a hiccup the retry fixes: Theo sings on from where it stuck, and nobody is skipped', async ({ world }) => {
	const worker = await startFakeWorker(world);
	try {
		const r = await room(world, (tv, id) => stallFor(tv, id, 1, false));
		const { theoId } = await skipMaya(world, r);
		await expect.poll(() => r.warnings.some((w) => w.includes('reloading it once')), { timeout: 10_000 }).toBe(true);
		const stuck = await r.tv.evaluate(() => (window as unknown as { stalledAt?: number }).stalledAt ?? -1);
		// Resumed, not restarted: the server's playhead goes on past the stuck spot on Theo's song.
		await expect
			.poll(async () => (await serverPlayback(world.baseURL)).state.positionSec, { timeout: 8_000 })
			.toBeGreaterThan(stuck + 1);
		expect(await current(world)).toBe(theoId);
		await expect(r.tv.locator(SEL.stateError)).toBeHidden();
	} finally {
		await worker.stop();
	}
});

test('never while the TV waits for a tap: the song is not skipped and the room keeps its turn', async ({ world }) => {
	const worker = await startFakeWorker(world);
	try {
		const maya = await world.openPhone('Maya');
		await readyId(world, maya, 'caroline');
		await readyId(world, maya, 'believin');
		const tv = await world.openTv();
		await requireActivationForPlayback(tv);
		await tv.reload();
		expect(await autoplayIsBlocked(tv), 'the autoplay shim is not in force').toBe(true);
		await queueReady(maya, 'caroline');
		await queueReady(maya, 'believin');
		await expect(tv.locator(SEL.autoplayHint)).toBeVisible({ timeout: 30_000 });
		const first = await current(world);
		await tv.waitForTimeout(12_000); // past the watchdog's 8 s, with the TV silent the whole time
		expect(await current(world)).toBe(first);
		await expect(tv.locator(SEL.stateError)).toBeHidden();
		expect((await serverQueue(world.baseURL)).some((e) => e.playFailed)).toBe(false);
	} finally {
		await worker.stop();
	}
});

test('a failure on the last song gives way to the lobby, with the turn still held', async ({ world }) => {
	const worker = await startFakeWorker(world);
	try {
		const theo = await world.openPhone('Theo');
		const id = await readyId(world, theo, 'believin');
		const tv = await world.openTv();
		await tv.route(`**/*${id}*`, (route) => route.fulfill({ status: 404, body: '' }));
		// Not `queueReady`: its acknowledgement is the strip naming the song, and this song fails and is held (so the strip
		// rightly goes) faster than it polls. The TV is the witness instead.
		await openBrowseFromHome(theo);
		await theo.locator(SEL.search).fill('believin');
		await theo.locator(SEL.addTurn).first().click();
		await expect(tv.locator(SEL.stateError)).toContainText("Theo's song wouldn't play", { timeout: 15_000 });
		await expect(tv.locator(SEL.lobby)).toBeVisible({ timeout: 10_000 });
		await expect(tv.locator(SEL.stateError)).toBeHidden();
		expect(await current(world)).toBeNull();
		expect(await serverQueue(world.baseURL)).toMatchObject([{ status: 'queued', playFailed: true }]);
		// Nothing is being made and nothing can start, so Theo's dock says neither.
		await expect(theo.getByText(/Making karaoke|Ready when you are/)).toHaveCount(0);
		// His queue says what the TV did: "Didn't play", with no place number promising a turn that is not coming.
		await openQueue(theo);
		const row = theo.locator(SEL.queueRow, { hasText: /believin/i });
		await expect(row).toContainText('Didn’t play');
		await expect(row.locator('.seq .n')).toHaveCount(0);
		await expect(row.locator(SEL.queueRemove)).toBeVisible();
		// Both ways back, on his own row (PR 2), as on his sheet.
		await expect(row.getByTestId('row-retry')).toBeVisible();
		await expect(row.getByTestId('row-pick-another')).toBeVisible();
		await expect(theo.getByTestId('song-didnt-play')).toBeVisible();
		// And the TV agrees: it is waiting for a song, not about to play his.
		await expect(tv.locator(SEL.lobby)).toBeVisible();
		await expect(tv.locator(SEL.anyTransientState)).toHaveCount(0);
		// Nothing sits over the lobby's join QR (main's UI-06 leg): the topmost element at its centre is the QR itself.
		const qr = tv.locator(`${SEL.lobby} ${SEL.qrImage}`);
		await expect(qr).toBeVisible();
		const onTop = await qr.evaluate((img) => {
			const r = img.getBoundingClientRect();
			return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === img;
		});
		expect(onTop, 'the join QR is the topmost element at its centre').toBe(true);
	} finally {
		await worker.stop();
	}
});

test('a dead file behind "Tap anywhere": the tap is spent, so the room moves on within 8 s', async ({ world }) => {
	// UI review of #994, D2: the tap retried play(), the dead file refused it, and the latch waited for a second tap
	// for good — the TV sat on "Now singing · Theo" over frozen lyrics.
	const worker = await startFakeWorker(world);
	try {
		const theo = await world.openPhone('Theo');
		const ana = await world.openPhone('Ana');
		const id = await readyId(world, theo, 'believin');
		await readyId(world, theo, 'prayer');
		const tv = await world.openTv();
		await tv.route(`**/*${id}*`, (route) => route.fulfill({ status: 404, body: '' }));
		await requireActivationForPlayback(tv);
		await tv.reload();
		expect(await autoplayIsBlocked(tv), 'the autoplay shim is not in force').toBe(true);
		await queueReady(theo, 'believin');
		await queueReady(ana, 'prayer');
		await expect(tv.locator(SEL.autoplayHint)).toBeVisible({ timeout: 30_000 });
		await tv.waitForTimeout(9_000); // past the watchdog's 8 s: the tap screen is the TV's problem, nothing skips
		await expect(tv.locator(SEL.stateError)).toHaveCount(0);
		await tv.mouse.click(960, 540); // a TRUSTED tap: the only kind the shim counts
		const tapped = Date.now();
		await expect(tv.locator(SEL.stateError)).toContainText("Theo's song wouldn't play", { timeout: 8_000 });
		expect(Date.now() - tapped).toBeLessThan(8_000);
		await expect(ana.locator(SEL.npStripWho)).toHaveText('Ana');
	} finally {
		await worker.stop();
	}
});

test('three dead files in a row: every one moves the room on, so a reused slot never stays failed', async ({
	world
}) => {
	// Code review of #994: a player slot outlives its songs, so its watchdog must reset per ENTRY. Which of the two
	// slots a song lands on is the gapless controller's business, but three failures in a row across two slots put two
	// of them on the SAME slot whatever it decides; a latched watchdog would leave the room on that one for good.
	test.setTimeout(300_000); // four phones and four songs to make
	const worker = await startFakeWorker(world);
	try {
		const maya = await world.openPhone('Maya');
		const theo = await world.openPhone('Theo');
		const ana = await world.openPhone('Ana');
		const bo = await world.openPhone('Bo');
		await readyId(world, maya, 'caroline');
		const dead = [
			await readyId(world, maya, 'believin'),
			await readyId(world, maya, 'prayer'),
			await readyId(world, maya, 'bohemian')
		];
		const tv = await world.openTv();
		for (const id of dead) await tv.route(`**/*${id}*`, (r) => r.fulfill({ status: 404, body: '' }));
		await queueReady(maya, 'caroline');
		await expect(tv.locator(SEL.stateNext)).toBeVisible({ timeout: 30_000 });
		await queueReady(theo, 'believin');
		await queueReady(ana, 'prayer');
		await queueReady(bo, 'bohemian');
		await expect(tv.locator(SEL.stateNext)).toBeHidden({ timeout: 10_000 });
		await maya.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		// Each failure holds the next song behind its 4 s notice, then that song fails at once: well inside 8 s apiece.
		for (const who of ['Theo', 'Ana', 'Bo'])
			await expect(tv.locator(SEL.stateError)).toContainText(`${who}'s song wouldn't play`, { timeout: 8_000 });
		await expect.poll(() => current(world), { timeout: 10_000 }).toBeNull();
		expect((await serverQueue(world.baseURL)).filter((e) => e.playFailed)).toHaveLength(3);
	} finally {
		await worker.stop();
	}
});

test('a play() left pending on a TV nobody touched shows "Tap anywhere" and skips nobody', async ({ world }) => {
	// Code review of #994: a TV browser may leave a play() its autoplay policy refused PENDING rather than rejecting it.
	// Read as a stall, that would fail every song in the queue. A tap then gives the watchdog the song again.
	const worker = await startFakeWorker(world);
	try {
		const r = await room(world, (tv, id) =>
			tv.evaluate((id) => {
				const orig = HTMLMediaElement.prototype.play;
				HTMLMediaElement.prototype.play = function () {
					if ((this.getAttribute('src') ?? '').includes(id)) return new Promise<void>(() => {});
					return orig.call(this);
				};
			}, id)
		);
		const theoId = (await theoEntry(world.baseURL))!.id;
		await r.maya.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		await expect(r.tv.locator(SEL.autoplayHint)).toBeVisible({ timeout: 8_000 });
		await r.tv.waitForTimeout(10_000); // past the watchdog's 8 s
		expect(await current(world)).toBe(theoId);
		await expect(r.tv.locator(SEL.stateError)).toHaveCount(0);
		await r.tv.mouse.click(960, 540); // a trusted tap: now an unanswered play() is the song's problem
		await expect(r.tv.locator(SEL.stateError)).toContainText("Theo's song wouldn't play", { timeout: 12_000 });
	} finally {
		await worker.stop();
	}
});

test('a TV that drops off during the notice: the room waits, and the TV that comes back starts it with its card', async ({
	world
}) => {
	// The owner's rulings on the r3 UI review: the server's fallback starts a held song only where a TV can play it.
	// With none, the room stays paused and no phone is told "You're up"; a TV that returns starts it from 0, with its
	// card, so its playhead and every phone start together.
	test.setTimeout(240_000);
	const worker = await startFakeWorker(world);
	try {
		const r = await room(world, (tv, id) =>
			tv.route(`**/*${id}*`, (route) => route.fulfill({ status: 404, body: '' }))
		);
		await r.maya.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		await expect(r.tv.locator(SEL.stateError)).toContainText("Theo's song wouldn't play", { timeout: 8_000 });
		// The SAME screen goes and comes back (#990's seat is its `encore_tv` cookie): a different screen would be a copy
		// for the seat's grace, and a copy rightly starts nothing.
		await r.tv.context().close(); // the TV goes, mid-notice
		await sampleFrames(r.ana, { youreUp: ['.youre-up', ''] });
		await r.ana.waitForTimeout(9_000); // well past the fallback's 6 s
		expect((await serverPlayback(world.baseURL)).state, 'a song nobody can hear was started').toMatchObject({
			isPlaying: false,
			positionSec: 0
		});
		expect((await seen(r.ana)).youreUp, 'Ana told "You’re up" for a song no TV is playing').toBeUndefined();
		const back = await world.openTv(); // the TV returns: the world's TVs share one screen cookie, so it is the seat
		await back.locator(SEL.stateNext, { hasText: 'Ana' }).waitFor({ timeout: 15_000 });
		const cardAt = Date.now();
		await r.ana.locator('.youre-up').waitFor({ timeout: 5_000 });
		expect(
			Math.abs((await seen(r.ana)).youreUp!.at - cardAt),
			'her phone and the returned TV hand over together'
		).toBeLessThan(1_500);
		// From the server's position (0), not from wherever the phones would have run on to: in step.
		await expect.poll(() => serverPlayback(world.baseURL).then((p) => p.state.isPlaying)).toBe(true);
		const tvAt = await back.locator(SEL.slotVisibleAudio).evaluate((a) => (a as HTMLAudioElement).currentTime);
		expect(tvAt, 'the returned TV starts where the server is').toBeLessThan(2.5);
	} finally {
		await worker.stop();
	}
});

/** A media file whose request is accepted and never answered: nothing loads, no error, play() stays pending. */
const hangFor = (tv: Page, id: string) => tv.route(`**/*${id}*`, () => new Promise<void>(() => {}));

test('R2-H1 a file that never loads, on a TV nobody touched: no "Tap anywhere", and the room moves on within 8 s', async ({
	world
}) => {
	// Code review r2 of #994: Chromium leaves play() pending with readyState 0 and no error when the bytes never come,
	// and the autoplay guard read that as a refused autoplay: "Tap anywhere" for good, with Theo current at 31 s.
	const worker = await startFakeWorker(world);
	try {
		const r = await room(world, hangFor);
		await sampleFrames(r.tv, { hint: [SEL.autoplayHint, ''] });
		const { t0 } = await skipMaya(world, r);
		await expect(r.tv.locator(SEL.stateError)).toContainText("Theo's song wouldn't play", { timeout: CAP_MS });
		expect(Date.now() - t0).toBeLessThan(CAP_MS);
		expect((await seen(r.tv)).hint, '"Tap anywhere" for a song that never loaded').toBeUndefined();
		// Nothing arrived and the fetch stayed open: a slow load, so the 4 s reload was not spent restarting it.
		expect(r.warnings.filter((w) => w.includes('reloading it once'))).toHaveLength(0);
	} finally {
		await worker.stop();
	}
});

test('R2-H2 a slow cold start (6 s) on a TV nobody touched: no false "Tap anywhere", and the song plays', async ({
	world
}) => {
	const worker = await startFakeWorker(world);
	let open!: () => void;
	const gate = new Promise<void>((resolve) => (open = resolve));
	try {
		// Gated on the skip so the pre-warm cannot absorb the delay: the file arrives 6 s after Maya's skip.
		const r = await room(world, (tv, id) =>
			tv.route(`**/*${id}*`, async (route) => {
				await gate;
				await new Promise((resolve) => setTimeout(resolve, 6_000));
				await route.continue();
			})
		);
		await sampleFrames(r.tv, { hint: [SEL.autoplayHint, ''] });
		open();
		const { theoId } = await skipMaya(world, r);
		await expect
			.poll(() => serverPlayback(world.baseURL).then((p) => p.state.positionSec), { timeout: 15_000 })
			.toBeGreaterThan(1);
		expect(await current(world), 'Theo’s slow song was skipped instead of played').toBe(theoId);
		expect((await seen(r.tv)).hint, '"Tap anywhere" on a TV whose autoplay works').toBeUndefined();
		await expect(r.tv.locator(SEL.stateError)).toHaveCount(0);
	} finally {
		open();
		await worker.stop();
	}
});

/** Wait until the server makes `entryId` current; returns that moment, which is when the TV's slot starts watching. */
async function becomesCurrent(world: World, entryId: string): Promise<number> {
	await expect.poll(() => current(world), { timeout: 30_000, intervals: [100] }).toBe(entryId);
	return Date.now();
}
/** One singer's only entry, by display name. */
async function entryOf(world: World, name: string): Promise<string> {
	const sync = await serverSync(world.baseURL);
	const id = sync.singers?.find((s) => s.displayName === name)?.id;
	return sync.entries.find((e) => e.singerId === id)!.id;
}

// UI review r2 of #994: a room update for the SAME entry re-ran the watchdog's reset, restarting the count with a fresh
// retry, so after a song ended by itself the "8 s" cap took 13-15 s and two reloads. These legs reach the next song by
// a natural end, with room traffic inside the window, and hold the cap to 8 s plus a margin for the tick and the RTT.
const CAP_MS = 8_000 + 1_500;

test('a natural end, then a song that will not start: moved on within 8 s, one reload, despite room updates', async ({
	world
}) => {
	const worker = await startFakeWorker(world);
	try {
		const maya = await world.openPhone('Maya');
		const theo = await world.openPhone('Theo');
		await readyId(world, maya, 'caroline');
		const theoMedia = await readyId(world, maya, 'believin');
		await readyId(world, maya, 'prayer');
		const tv = await world.openTv();
		const warnings: string[] = [];
		tv.on('console', (m) => m.type() === 'warning' && warnings.push(m.text()));
		await rejectPlayFor(tv, theoMedia);
		await queueReady(maya, 'caroline');
		await queueReady(theo, 'believin');
		const theoAt = await becomesCurrent(world, await entryOf(world, 'Theo')); // Maya's 8 s song ran out by itself
		await tv.waitForTimeout(3_000);
		await queueReady(maya, 'prayer'); // a queue add lands mid-window: a room update for the same entry
		await expect(tv.locator(SEL.stateError)).toContainText("Theo's song wouldn't play", { timeout: CAP_MS });
		expect(Date.now() - theoAt, 'from his song coming up to the notice').toBeLessThan(CAP_MS);
		expect(warnings.filter((w) => w.includes('reloading it once'))).toHaveLength(1);
	} finally {
		await worker.stop();
	}
});

test('a natural end, then a file that never loads: moved on within 8 s, despite room updates', async ({ world }) => {
	// A dead file fails on its media error and never reaches the watchdog, so it cannot catch a watchdog that keeps
	// restarting its count. A file that never loads (no bytes, no error) is held by the watchdog alone.
	const worker = await startFakeWorker(world);
	try {
		const maya = await world.openPhone('Maya');
		const theo = await world.openPhone('Theo');
		await readyId(world, maya, 'caroline');
		const theoMedia = await readyId(world, maya, 'believin');
		await readyId(world, maya, 'prayer');
		const tv = await world.openTv();
		await hangFor(tv, theoMedia);
		await queueReady(maya, 'caroline');
		await queueReady(theo, 'believin');
		const theoAt = await becomesCurrent(world, await entryOf(world, 'Theo')); // Maya's 8 s song ran out by itself
		await tv.waitForTimeout(3_000);
		await queueReady(maya, 'prayer'); // a room update for the same entry, mid-window
		await expect(tv.locator(SEL.stateError)).toContainText("Theo's song wouldn't play", { timeout: CAP_MS });
		expect(Date.now() - theoAt, 'from his song coming up to the notice').toBeLessThan(CAP_MS);
		await expect(tv.locator(SEL.autoplayHint)).toBeHidden();
	} finally {
		await worker.stop();
	}
});

test('a second failure after a song that played out: also within 8 s of its song coming up', async ({ world }) => {
	// Theo will not start; Ana is held, then plays her whole 8 s song; then Bo will not start. Bo is the case the
	// review timed at 12.6-12.9 s.
	test.setTimeout(300_000);
	const worker = await startFakeWorker(world);
	try {
		const maya = await world.openPhone('Maya');
		const theo = await world.openPhone('Theo');
		const ana = await world.openPhone('Ana');
		const bo = await world.openPhone('Bo');
		await readyId(world, maya, 'caroline');
		const theoMedia = await readyId(world, maya, 'believin');
		await readyId(world, maya, 'prayer');
		const boMedia = await readyId(world, maya, 'bohemian');
		const tv = await world.openTv();
		const warnings: string[] = [];
		tv.on('console', (m) => m.type() === 'warning' && warnings.push(m.text()));
		await rejectPlayFor(tv, theoMedia);
		await rejectPlayFor(tv, boMedia);
		await queueReady(maya, 'caroline');
		await queueReady(theo, 'believin');
		await queueReady(ana, 'prayer');
		await queueReady(bo, 'bohemian');
		const boId = await entryOf(world, 'Bo');
		await expect(tv.locator(SEL.stateError)).toContainText("Theo's song wouldn't play", { timeout: 30_000 });
		const boAt = await becomesCurrent(world, boId); // after Ana's held song played out
		await expect(tv.locator(SEL.stateError)).toContainText("Bo's song wouldn't play", { timeout: CAP_MS });
		expect(Date.now() - boAt, 'from Bo’s song coming up to the notice').toBeLessThan(CAP_MS);
		expect(warnings.filter((w) => w.includes('reloading it once'))).toHaveLength(2); // one each, never two for Bo
	} finally {
		await worker.stop();
	}
});

type ProbeOp =
	{ op: 'retry-play'; id: string } | { op: 'replace-media'; id: string; mediaId: string; keyShift: number };
/** One queue op over a fresh socket opened IN `page`, so its cookies go with it: what the server answered. */
function opFrom(page: Page, wsPath: string, op: ProbeOp): Promise<string> {
	return page.evaluate(
		({ wsPath, op }) =>
			new Promise<string>((resolve) => {
				const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}${wsPath}`);
				const clientOpId = `probe-${Math.random().toString(36).slice(2)}`;
				const t = setTimeout(() => resolve('timeout'), 4_000);
				ws.onopen = () => {
					ws.send(JSON.stringify({ type: 'hello', lastRev: 0 }));
					ws.send(JSON.stringify({ type: 'queue:command', command: { clientOpId, op } }));
				};
				ws.onmessage = (ev) => {
					const e = JSON.parse(String(ev.data));
					const done = (s: string) => (clearTimeout(t), ws.close(), resolve(s));
					if (e.type === 'op:reject' && e.clientOpId === clientOpId) done(`reject: ${e.reason}`);
					if (e.type === 'queue:patch' && e.patch?.causedBy === clientOpId) done('applied');
				};
			}),
		{ wsPath, op }
	);
}
/** The same from the test runner itself: no browser, no cookie. */
function opCookieless(baseURL: string, op: ProbeOp): Promise<string> {
	return new Promise((resolve) => {
		const ws = new WebSocket(`${baseURL.replace(/^http/, 'ws')}/ws`);
		const t = setTimeout(() => resolve('timeout'), 4_000);
		ws.onopen = () => {
			ws.send(JSON.stringify({ type: 'hello', lastRev: 0 }));
			ws.send(JSON.stringify({ type: 'queue:command', command: { clientOpId: 'probe-anon', op } }));
		};
		ws.onmessage = (ev: MessageEvent) => {
			const e = JSON.parse(String(ev.data));
			const done = (s: string) => (clearTimeout(t), ws.close(), resolve(s));
			if (e.type === 'op:reject' && e.clientOpId === 'probe-anon') done(`reject: ${e.reason}`);
			if (e.type === 'queue:patch' && e.patch?.causedBy === 'probe-anon') done('applied');
		};
	});
}

test('only Theo can lift his hold: Try again and Pick another from Ana, the TV or a cookieless socket are refused', async ({
	world
}) => {
	// The #1047 reviews measured Ana lifting Theo's hold twice: by `retry-play` (r1), then by "picking" his own dead song
	// for him with `replace-media` (r2). Both asked for a capability every singer has. Folds in reviews/pr-1047-r2-sec.
	const worker = await startFakeWorker(world);
	try {
		const r = await room(world, (tv, id) =>
			tv.route(`**/*${id}*`, (route) => route.fulfill({ status: 404, body: '' }))
		);
		const { theoId } = await skipMaya(world, r);
		await expect(r.tv.locator(SEL.stateError)).toContainText("Theo's song wouldn't play", { timeout: 12_000 });
		await expect.poll(async () => (await theoEntry(world.baseURL))?.playFailed).toBe(true);
		const retry: ProbeOp = { op: 'retry-play', id: theoId };
		const sameSong: ProbeOp = { op: 'replace-media', id: theoId, mediaId: r.theoMedia, keyShift: 0 };
		const anaSong = (await serverQueue(world.baseURL)).find((e) => e.status === 'playing')!.mediaId;
		const otherSong: ProbeOp = { op: 'replace-media', id: theoId, mediaId: anaSong, keyShift: 0 };
		for (const op of [retry, sameSong, otherSong]) {
			expect(await opFrom(r.ana, '/ws', op), `Ana's ${op.op}`).toBe('reject: only the singer can change this entry');
			expect(await opFrom(r.tv, '/ws?role=tv', op), `the TV's ${op.op}`).toBe('reject: join the room first');
			expect(await opCookieless(world.baseURL, op), `a cookieless ${op.op}`).toBe('reject: join the room first');
		}
		expect(await theoEntry(world.baseURL)).toMatchObject({ mediaId: r.theoMedia, playFailed: true, playFailures: 1 });
		await expect(r.theo.getByTestId('song-didnt-play')).toBeVisible();
		// Theo's own is the one that lands.
		expect(await opFrom(r.theo, '/ws', retry)).toBe('applied');
		await expect.poll(async () => (await theoEntry(world.baseURL))?.playFailed).toBe(false);
	} finally {
		await worker.stop();
	}
});

test('Try again goes ahead of whoever is On deck, and Bo is told "Theo’s going first"', async ({ world }) => {
	// Proposal 11: the turn plays straight after the current song. Proposal 14: a singer who loses On deck through
	// nobody's fault of theirs is told who goes first, on any tab.
	const worker = await startFakeWorker(world);
	try {
		const maya = await world.openPhone('Maya');
		const theo = await world.openPhone('Theo');
		const ana = await world.openPhone('Ana');
		const bo = await world.openPhone('Bo');
		await readyId(world, maya, 'caroline');
		const theoMedia = await readyId(world, maya, 'believin');
		await readyId(world, maya, 'prayer');
		await readyId(world, maya, 'bohemian');
		const tv = await world.openTv();
		await tv.route(`**/*${theoMedia}*`, (route) => route.fulfill({ status: 404, body: '' }));
		await queueReady(maya, 'caroline');
		await expect(tv.locator(SEL.stateNext)).toBeVisible({ timeout: 30_000 });
		await queueReady(theo, 'believin');
		await queueReady(ana, 'prayer');
		await queueReady(bo, 'bohemian');
		await expect(tv.locator(SEL.stateNext)).toBeHidden({ timeout: 10_000 });
		await maya.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		await expect(tv.locator(SEL.stateError)).toContainText("Theo's song wouldn't play", { timeout: 12_000 });
		// Ana sings next and Bo is On deck: the server's up-next says so.
		const boId = await entryOf(world, 'Bo');
		await expect.poll(() => serverUpNext(world.baseURL)).toBe(boId);
		await theo.getByTestId('didnt-play-retry').click();
		const theoId = (await theoEntry(world.baseURL))!.id;
		await expect.poll(() => serverUpNext(world.baseURL)).toBe(theoId);
		await expect(bo.getByText(/Theo’s going first/)).toBeVisible({ timeout: 8_000 });
		// Only Bo lost On deck, so only Bo is told.
		for (const p of [maya, ana, theo]) await expect(p.getByText(/going first/)).toHaveCount(0);
	} finally {
		await worker.stop();
	}
});
