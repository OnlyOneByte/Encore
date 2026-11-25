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
			// A timer as well as frames: under load headless Chromium paints a few frames a second.
			const sample = () => {
				const rows = [...document.querySelectorAll(row)];
				const cur = document.querySelector(rowCurrent);
				const media = [...document.querySelectorAll<HTMLMediaElement>('audio,video')].find((m) => !m.paused);
				if (cur && media)
					w.samples.push({
						t: Date.now(),
						row: rows.indexOf(cur),
						pos: media.currentTime,
						rows: rows.length
					});
			};
			const tick = () => {
				sample();
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
			setInterval(sample, 25);
		},
		{ row: SEL.lyricsRow, rowCurrent: SEL.lyricsRowCurrent, active: SEL.activeWord }
	);
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

/** How many samples after time `from` disagree with the grid. Past the version's last line, that line stays lit
 *  (`activeLineIndex`): the automatic words end at 7.2 s, and a slow box brings them back after that (#1270). */
function offGrid(all: Sample[], from: number): number {
	return all.filter((s) => {
		if (s.t < from) return false;
		const want = expectedRow(s.pos);
		return want !== null && s.row !== Math.min(want, s.rows - 1);
	}).length;
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
	// Through two fixes and two Undos, with no exemption, the current row never steps back.
	const backs = all.filter((s, i) => i > 0 && s.row < all[i - 1]!.row);
	expect(backs, 'the current row stepped back').toEqual([]);
	// Each version came in between lines: in the flush that added its rows, no word was lit.
	const swaps = await tv.evaluate(() => (window as unknown as { swaps: Record<string, boolean> }).swaps);
	expect(swaps, 'a version swapped in mid-word').toMatchObject({ fixed: false, again: false });
	// The reel follows the words' own timing throughout (proportional: a loaded box's playhead reading jitters).
	const graded = all.filter((s) => s.t >= startedAt && expectedRow(s.pos) !== null).length;
	expect(offGrid(all, startedAt), 'off the words timing').toBeLessThanOrEqual(Math.max(2, graded / 5));
	expect(cls, 'layout shift across the swaps').toBe(0);
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
