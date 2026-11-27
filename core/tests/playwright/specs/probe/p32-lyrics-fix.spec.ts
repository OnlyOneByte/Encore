/*
 * P32 — A HOST'S LYRICS FIX REACHES THE TV MID-SONG, WITH NO JUMP (proposal 32, docs/FRONTEND.md#lyrics-fixes).
 *
 * The host fixes the words twice and undoes twice, all while one song plays. The TV must show each
 * change (the second fix too, which a fixed paste name never delivered), swap only between lines so the current
 * row never steps back, shift nothing on the page, and Undo must land with no worker.
 *
 * One 40 s song, because every step has to happen inside one turn. The fake worker times a pinned paste on the
 * same 0.8 s grid as its automatic words (lines 0.7 s long, 0.1 s gaps), so a row index means the same slot in
 * every version and "never steps back" is checkable.
 */
import { test, expect, type World } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { DEMO_LIBRARY } from '../../world/seed';
import { startFakeWorker } from '../../world/workers';
import { queueReady } from '../../world/actors';
import { sendPlayerCommand } from './audio-probe-support';
import type { Page } from '@playwright/test';

test.use({
	demoLibrary: [[...DEMO_LIBRARY, { file: 'lyric-fix-song.wav', seconds: 40, hz: [220, 330] }], { scope: 'test' }]
});

const GRID = 0.8;
const LINE = 0.7;
const fixLines = (mark: (i: number) => string) => Array.from({ length: 45 }, (_, i) => ({ text: mark(i) }));

interface Sample {
	t: number;
	row: number;
	pos: number;
	/** Rows of the version on screen: the automatic words have 9, a fix 45. */
	rows: number;
	/** The current row's top on screen, so a reel that slides back shows even where the row index is exempt. */
	top: number;
}

async function rev(page: Page, mediaId: string): Promise<number> {
	const body = await (await page.request.get(`/api/audit/${mediaId}`)).json();
	return body.media?.lyricsEditRev ?? 0;
}

async function change(page: Page, path: string, mediaId: string, extra: Record<string, unknown> = {}) {
	const res = await page.request.post(path, { data: { mediaId, rev: await rev(page, mediaId), ...extra } });
	expect(res.status(), `${path} ${await res.text()}`).toBe(200);
}

/** Every frame on the TV: the current row's index and text, whether a word is lit, and the audio position. */
async function startSampling(tv: Page): Promise<void> {
	await tv.evaluate(
		({ row, rowCurrent, active }) => {
			const w = window as unknown as { samples: Sample[]; cls: number; swaps: Record<string, boolean> };
			w.samples = [];
			w.cls = 0;
			// The flush that adds a version's rows: was any word lit then? Exact, where a sample can land late.
			w.swaps = {};
			new MutationObserver((records) => {
				for (const r of records)
					for (const n of r.addedNodes) {
						const word = n instanceof HTMLElement ? n.textContent?.trim().split(' ')[0] : undefined;
						if (word && !(word in w.swaps) && n instanceof HTMLElement && n.matches(row))
							w.swaps[word] = !!document.querySelector(active);
					}
			}).observe(document.body, { childList: true, subtree: true });
			new PerformanceObserver((list) => {
				for (const e of list.getEntries() as unknown as { value: number }[]) w.cls += e.value;
			}).observe({ type: 'layout-shift', buffered: false });
			// A timer as well as frames: under load headless Chromium paints a few frames a second. The reel moves on the
			// page's own frames, so a sample pairs the rows with the position AT THE LAST FRAME, read in the probe's own
			// frame callback; the timer then samples in a later task, after that frame's flush. Paired with the position
			// at the sample instead, every timer sample between two of the runner's slow frames read as off the grid (#1134).
			let framePos: number | null = null;
			const playingMedia = () => [...document.querySelectorAll<HTMLMediaElement>('audio,video')].find((m) => !m.paused);
			const sample = () => {
				const rows = [...document.querySelectorAll(row)];
				const cur = document.querySelector(rowCurrent);
				if (cur && playingMedia() && framePos !== null)
					w.samples.push({
						t: Date.now(),
						row: rows.indexOf(cur),
						pos: framePos,
						rows: rows.length,
						top: cur.getBoundingClientRect().top
					});
			};
			const tick = () => {
				framePos = playingMedia()?.currentTime ?? null;
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
			setInterval(sample, 25);
		},
		{ row: SEL.lyricsRow, rowCurrent: SEL.lyricsRowCurrent, active: SEL.activeWord }
	);
	// Nothing is sampled before the page's first frame, which under load can come after the change a caller sends next.
	await tv.waitForFunction(() => (window as unknown as { samples: Sample[] }).samples.length > 0);
}

/** Each pair of samples where the current row sits lower on screen than before, so the reel moved back. A later row
 *  is exempt: it rises from below into the current slot. */
function slidBack(all: Sample[]): [Sample, Sample][] {
	return all.flatMap((s, i) => {
		const prev = all[i - 1];
		return prev && s.top > prev.top + 2 && s.row <= prev.row ? [[prev, s] as [Sample, Sample]] : [];
	});
}

const samples = (tv: Page) => tv.evaluate(() => (window as unknown as { samples: Sample[] }).samples);

/** Wait until some row on the TV reads `text`. */
async function tvShows(tv: Page, text: string): Promise<void> {
	await expect(tv.locator(SEL.lyricsRow, { hasText: text }).first()).toBeAttached({ timeout: 15_000 });
}

/** The row the grid puts the cue on, or null within 60 ms of a boundary, where frame jitter decides. */
function expectedRow(cue: number): number | null {
	const i = Math.floor(cue / GRID);
	const into = cue - i * GRID;
	if (into < 0.06 || Math.abs(into - LINE) < 0.06 || into > GRID - 0.06) return null;
	return i;
}

/** How many samples from time `from` (to `to`) disagree with the grid, with the words shown `leadSec` early. Past
 *  the version's last line, that line stays lit (`activeLineIndex`): the automatic words end at 7.2 s, and a slow
 *  box brings them back after that (#1270). */
function offGrid(all: Sample[], from: number, leadSec = 0, to = Infinity): number {
	return all.filter((s) => {
		if (s.t < from || s.t >= to) return false;
		const want = expectedRow(s.pos + leadSec);
		return want !== null && s.row !== Math.min(want, s.rows - 1);
	}).length;
}

/** The lead that best fits the rows seen in [from, to): the middle of the 50 ms steps over one grid period that fit
 *  best, since the 60 ms bands `expectedRow` skips make a plateau. The TV's own lag cancels out of a difference of
 *  two; a lead and one a period away fit alike, so a difference is read mod GRID. */
function fittedLead(all: Sample[], from: number, to: number): number {
	const leads = Array.from({ length: GRID / 0.05 }, (_, i) => -GRID / 2 + i * 0.05);
	const misses = leads.map((l) => offGrid(all, from, l, to));
	const best = leads.filter((_, i) => misses[i] === Math.min(...misses));
	return best.reduce((a, b) => a + b, 0) / best.length;
}

async function stage(world: World) {
	await startFakeWorker(world, { seconds: 40 });
	const phone = await world.openPhone('P32Host');
	await world.becomeHost(phone);
	const track = await world.awaitDemoTrack('lyric-fix');
	expect((await phone.request.post('/api/process', { data: { mediaId: track.id } })).ok()).toBe(true);
	await expect
		.poll(async () => (await (await phone.request.get(`/api/audit/${track.id}`)).json()).media?.lyricsRef ?? null, {
			timeout: 60_000
		})
		.not.toBeNull();
	await phone.request.put('/api/settings/room', { data: { lyricsHighlight: 'word', lyricsLeadMs: 0 } });
	await queueReady(phone, track.title);
	const tv = await world.openTv();
	// When each nudge reached the TV page, on the sampler's clock. openTv's socket opened before this, so reload.
	await tv.addInitScript(() => {
		const w = window as unknown as { nudges: { t: number; ms: number }[] };
		w.nudges = [];
		const Socket = window.WebSocket;
		window.WebSocket = class extends Socket {
			constructor(...args: ConstructorParameters<typeof WebSocket>) {
				super(...args);
				this.addEventListener('message', (e) => {
					const ms = String(e.data).match(/"lyricsOffsetMs":(-?\d+)/)?.[1];
					if (ms !== undefined) w.nudges.push({ t: Date.now(), ms: Number(ms) });
				});
			}
		};
	});
	await tv.reload();
	await tv.locator(SEL.tvConnected).waitFor({ state: 'attached' });
	await tv.mouse.click(960, 540);
	await tv.locator(SEL.lyricsRowCurrent).waitFor({ timeout: 30_000 });
	return { phone, tv, mediaId: track.id };
}

test('P32 · fixes and Undo reach the TV mid-song, between lines, with nothing stepping back', async ({ world }) => {
	test.setTimeout(150_000);
	const { phone, tv, mediaId } = await stage(world);
	await startSampling(tv);

	// Fix 1 and fix 2: the second must reach a TV that already loaded the first.
	await change(phone, '/api/lyrics-edit', mediaId, { lines: fixLines((i) => `fixed ${i} words`) });
	await tvShows(tv, 'fixed 20 words');
	await change(phone, '/api/lyrics-edit', mediaId, { lines: fixLines((i) => `again ${i} words`) });
	await tvShows(tv, 'again 30 words');

	// Undo fix 2, then fix 1: fix 1's words, then the automatic ones, come back from stored documents, no worker.
	const startedAt = Date.now();
	await change(phone, '/api/lyrics-edit/undo', mediaId);
	await tvShows(tv, 'fixed 40 words');
	await change(phone, '/api/lyrics-edit/undo', mediaId);
	await expect(tv.locator(SEL.lyricsRow, { hasText: 'fixed' })).toHaveCount(0, { timeout: 15_000 });
	await tv.waitForTimeout(1_000);

	const all = await samples(tv);
	const cls = await tv.evaluate(() => (window as unknown as { cls: number }).cls);
	expect(all.length, 'the sampler saw the reel').toBeGreaterThan(40);
	// Through two fixes and two Undos, the current row never steps back. The one index exemption is #1299's: an Undo to
	// the automatic words after they end (7.2 s) lands on their last row, held, a different version's past line.
	const backs = all.filter(
		(s, i) => i > 0 && s.row < all[i - 1]!.row && !(s.rows !== all[i - 1]!.rows && s.row === s.rows - 1)
	);
	expect(backs, 'the current row stepped back').toEqual([]);
	// No exemption for motion: each landing cuts to the current slot, and the reel never slides back.
	expect(slidBack(all), 'the reel slid back').toEqual([]);
	// Each version came in between lines: in the flush that added its rows, no word was lit.
	const swaps = await tv.evaluate(() => (window as unknown as { swaps: Record<string, boolean> }).swaps);
	expect(swaps, 'a version swapped in mid-word').toMatchObject({ fixed: false, again: false });
	// The reel follows the words' own timing throughout (proportional: a loaded box's playhead reading jitters).
	const graded = all.filter((s) => s.t >= startedAt && expectedRow(s.pos) !== null).length;
	expect(offGrid(all, startedAt), 'off the words timing').toBeLessThanOrEqual(Math.max(2, graded / 5));
	expect(cls, 'layout shift across the swaps').toBe(0);
});

test("P32 · the host's Earlier taps move every line on the TV live, with no re-time", async ({ world }) => {
	test.setTimeout(120_000);
	const { phone, tv, mediaId } = await stage(world);
	const audit = async () => (await (await phone.request.get(`/api/audit/${mediaId}`)).json()).media;
	// A fix first: its 45 lines run the whole song, where the automatic words end at 7.2 s and then hold.
	await change(phone, '/api/lyrics-edit', mediaId, { lines: fixLines((i) => `nudge ${i} words`) });
	await tvShows(tv, 'nudge 30 words');
	const before = await audit();
	await phone.goto(`/song/${mediaId}`);
	await startSampling(tv);
	const plain = Date.now();
	await tv.waitForTimeout(4_000);
	const earlier = phone.getByRole('button', { name: 'Earlier' });
	const tapped = Date.now();
	for (let i = 0; i < 4; i++) await earlier.click();
	await expect(phone.getByRole('status').filter({ hasText: 'Words 0.2 s early' })).toBeVisible();
	await expect.poll(async () => (await audit()).lyricsOffsetMs, { timeout: 10_000 }).toBe(-200);
	// Each window holds one lead only (#1334): the "before" one ends at the first tap, since the TV can have the nudge
	// before the server's answer reaches here, and the "after" one starts when the TV page has the last nudge.
	const landed = () =>
		tv.evaluate(
			() => (window as unknown as { nudges: { t: number; ms: number }[] }).nudges.find((n) => n.ms === -200)?.t
		);
	await expect.poll(landed, { timeout: 10_000 }).toBeDefined();
	const nudged = (await landed())!;
	await tv.waitForTimeout(Math.max(0, nudged + 4_000 - Date.now()));
	const all = await samples(tv);
	// Both windows read the fix's rows while lines still change: a held last line fits every lead alike.
	const live = (from: number, to: number) =>
		all.filter((s) => s.t >= from && s.t < to && s.rows === 45 && s.pos < 35).length;
	expect(live(plain, tapped), 'the sampler saw the reel before the taps').toBeGreaterThan(20);
	expect(live(nudged, Infinity), 'the sampler saw the reel after the taps').toBeGreaterThan(20);

	// The rows run 0.2 s further ahead of the audio than they did before the taps (a quarter of a line, so a move the
	// wrong way reads as -0.2).
	const raw = fittedLead(all, nudged, Infinity) - fittedLead(all, plain, tapped);
	const shift = raw - GRID * Math.round(raw / GRID);
	// The leads sit on a 0.05 s grid, so 0.1 off is in, and a float sum such as 0.30000000000000004 must not tip it.
	expect(Math.abs(shift - 0.2), `the rows moved ${shift.toFixed(2)} s, not 0.2`).toBeLessThanOrEqual(0.1 + 1e-9);
	// The words and their document are untouched: nothing was re-timed.
	const after = await audit();
	expect({ ref: after.lyricsRef, rev: after.lyricsEditRev }).toEqual({
		ref: before.lyricsRef,
		rev: before.lyricsEditRev
	});

	// To the limit by keyboard: the button there goes inert but keeps the focus the last press gave it.
	const later = phone.getByRole('button', { name: 'Later' });
	await later.focus();
	for (let i = 0; i < 66; i++) await phone.keyboard.press('Enter');
	await expect(phone.getByRole('status').filter({ hasText: 'Words 3 s late' })).toBeVisible();
	await expect(later).toHaveAttribute('aria-disabled', 'true');
	await expect(later).toBeFocused();
	await expect.poll(async () => (await audit()).lyricsOffsetMs, { timeout: 10_000 }).toBe(3000);
});

test('#1299 an Undo to words that end before the playhead lands mid-song, at the next gap, with no shift', async ({
	world
}) => {
	test.setTimeout(120_000);
	const { phone, tv, mediaId } = await stage(world);
	await change(phone, '/api/lyrics-edit', mediaId, { lines: fixLines((i) => `fixed ${i} words`) });
	await tvShows(tv, 'fixed');
	// Past the automatic words' last line (7.2 s), with the fix's rows still running.
	const position = () =>
		tv.evaluate(
			() => [...document.querySelectorAll<HTMLMediaElement>('audio,video')].find((m) => !m.paused)?.currentTime ?? 0
		);
	await expect.poll(position, { timeout: 30_000 }).toBeGreaterThan(9);
	await startSampling(tv);
	await change(phone, '/api/lyrics-edit/undo', mediaId);
	const undoneAt = await position();
	// Main held this Undo until the song ended, 30 s on: here it lands at the fix's next gap, inside a line or two.
	await expect(tv.locator(SEL.lyricsRow, { hasText: 'fixed' })).toHaveCount(0, { timeout: 5_000 });
	expect(await position(), 'the Undo waited for the song').toBeLessThan(undoneAt + 5);
	// The automatic words are back, their last line held as the current row, and the page shifted nothing.
	await expect(tv.locator(SEL.lyricsRowCurrent)).toBeAttached();
	await tv.waitForTimeout(1_000);
	// That row is cut to in the current slot: the reel never slides back to reach it.
	const all = await samples(tv);
	expect(all.some((s) => s.rows === 9) && all.some((s) => s.rows === 45), 'the sampler saw the swap').toBe(true);
	expect(slidBack(all), 'the reel slid back').toEqual([]);
	expect(await tv.evaluate(() => (window as unknown as { cls: number }).cls), 'layout shift at the swap').toBe(0);
	const swaps = await tv.evaluate(() => (window as unknown as { swaps: Record<string, boolean> }).swaps);
	expect(Object.values(swaps), 'the Undo swapped in mid-word').not.toContain(true);
});

test('P32 · on a paused song a fix lands at once, without waiting for play', async ({ world }) => {
	test.setTimeout(120_000);
	const { phone, tv, mediaId } = await stage(world);
	await sendPlayerCommand(phone, { cmd: 'pause' });
	const paused = () =>
		tv.evaluate(() => [...document.querySelectorAll<HTMLMediaElement>('audio,video')].every((m) => m.paused));
	await expect.poll(paused, { timeout: 15_000, message: 'the pause never reached the TV' }).toBe(true);
	const current = () =>
		tv.evaluate(
			({ row, rowCurrent }) => {
				const cur = document.querySelector(rowCurrent);
				const text = cur?.textContent?.replace(/\s+/g, ' ').trim();
				return { at: [...document.querySelectorAll(row)].indexOf(cur!), text };
			},
			{ row: SEL.lyricsRow, rowCurrent: SEL.lyricsRowCurrent }
		);
	const before = await current();

	await change(phone, '/api/lyrics-edit', mediaId, { lines: fixLines((i) => `paused ${i} words`) });
	await tvShows(tv, 'paused');
	expect(await paused(), 'the fix waited for play').toBe(true);
	// The same row stays current, now in the fix's words.
	expect(await current()).toEqual({ at: before.at, text: `paused ${before.at} words` });
});
