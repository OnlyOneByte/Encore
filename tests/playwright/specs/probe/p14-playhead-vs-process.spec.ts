// P14 — the playing song's playhead must not be affected by anything happening for PROCESSING. Get song A
// playing past the seek threshold, then process a DIFFERENT song B and watch A's playhead across B's whole
// process, which produces the real traffic: `media:status` frames, then `onMediaReady`'s `queue:sync` +
// `nowplaying:changed`. A backwards step in A's `currentTime` is the defect; A is proved to be really
// DECODING first, or a monotonic playhead proves nothing (docs/E2E.md#proving-audio).
//
// ONE TEST, because every number here comes from one sampled series over one playback: A's decoded bytes, the
// worst backwards step, and whether B reached ready inside A's window are three readings of the same run. A
// second pass would be a second playback with its own timing.
//
// AUTOPLAY. The old probe was a "NOT-A-TV": it granted `--autoplay-policy=no-user-gesture-required` because
// the invariant needs a MOVING playhead. This suite refuses that grant on purpose — a television grants no
// gesture, so a relaxed policy proves playback in an environment the product never ships into
// (docs/E2E.md#autoplay). The playhead is bought instead with ONE REAL TAP on the TV, which is how a real
// room authorises its own document: TvPlayer keeps a pointerdown listener armed for exactly this.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome } from '../../world/actors';
import type { Page } from '@playwright/test';

/**
 * A PHYSICALLY MEANINGFUL DWELL, not a wait for the app: it is the SAMPLING INTERVAL of a continuous
 * quantity. The claim is about `currentTime` between two moments, so the moments have to be spaced — and
 * spaced finely enough that a re-seek to a stale anchor lands inside the series rather than between two
 * samples. The old probe's own 200ms, kept.
 */
const SAMPLE_MS = 200;
/** 90 samples at 200ms. The fixture tracks are 8 seconds, so in practice the window closes on song A ending
 *  long before this; it is a backstop, not a duration. */
const MAX_SAMPLES = 90;
/** Past SEEK_JUMP_SEC (1.5s) by a clear margin, so a stale-anchor re-seek is unambiguous. */
const MIN_PLAYHEAD_SEC = 3;
/** Covers decoder jitter on a sampled element; the defect is a jump back to a stale COMMAND anchor, which is
 *  seconds, and seekPlan's own 1.5s threshold gates it anyway. */
const TOL_SEC = 0.25;
/** Below this, "playing" is an element that mounted and decoded nothing — the FLAC-in-a-`<video>` shape. */
const MIN_DECODED_BYTES = 32768;
/** The fake worker's dwell between progress frames — see the call site for why B's process is held open. */
const PROCESS_HOLD_MS = 400;

interface SongRow {
	id: string;
	title: string;
	source: string;
}
interface Readout {
	t: number;
	src: string;
	bytes: number;
	paused: boolean;
}

/** The two distinct local fixtures this probe needs, named by the substring their FILENAMES carry. Search
 *  matches on TITLE, so one query cannot surface the whole library — which is why the old probe unioned four. */
const QUERY_A = 'caroline';
const QUERY_B = 'believin';

/** One reading of the element that is actually carrying audio, in one round trip. */
async function read(tv: Page): Promise<Readout | null> {
	return tv.evaluate((mediaEl) => {
		const els = [...document.querySelectorAll<HTMLMediaElement>(mediaEl)];
		const m = els.find((e) => e.currentSrc && e.currentSrc.includes('/media/'));
		if (!m) return null;
		return {
			t: m.currentTime,
			src: m.currentSrc,
			// Chromium-only, and the whole point: an element can report `paused: false` with a playhead that
			// advances off the wall clock while nothing has been decoded. docs/E2E.md#proving-audio
			bytes: (m as HTMLMediaElement & { webkitAudioDecodedByteCount?: number }).webkitAudioDecodedByteCount ?? 0,
			paused: m.paused
		};
	}, SEL.mediaEl);
}

/**
 * The row whose title NAMES the query. Never `.first()` on a bare action selector: the find box is debounced,
 * so the previous query's rows are still on screen when the new query is typed and a blind first-click adds the
 * wrong song.
 */
function rowFor(page: Page, query: string) {
	return page.locator(SEL.songRow).filter({ hasText: query }).first();
}

/** `/api/process` refuses an anonymous caller, so this rides the phone's own session. */
async function startProcess(page: Page, mediaId: string): Promise<void> {
	const res = await page.request.post('/api/process', { data: { mediaId } });
	if (!res.ok()) throw new Error(`/api/process refused ${mediaId}: ${res.status()} ${await res.text()}`);
}

/**
 * Is this media playable yet? Read off `/api/library`, whose `library` IS `listReady()` — the same readiness
 * predicate `/api/search`'s `ready` bucket is built from. Deliberately NOT /api/search: that route fans out to
 * the YouTube resolver on every call, and a second of yt-dlp per sample would stretch the interval this
 * probe's whole claim is measured against.
 */
async function isReady(page: Page, mediaId: string): Promise<boolean> {
	const body = (await page.request.get('/api/library').then((r) => r.json())) as { library: SongRow[] };
	return body.library.some((m) => m.id === mediaId);
}

test("processing another song must not move the playing song's playhead", async ({ world }) => {
	// `slowMs` HOLDS B's job mid-flight. At the default 120ms B's whole process can land between two samples,
	// which would leave the series quiet for the reason "nothing happened" rather than "nothing was disturbed".
	// 400ms spreads stems and align — and so the media:status frames and the onMediaReady burst — across several
	// samples, while still finishing inside the ~5s of song A that remains once its playhead passes 3s.
	const worker = await startFakeWorker(world, { slowMs: PROCESS_HOLD_MS });
	try {
		// A PHONE first: the queue validator requires entry.singerId to equal the acting session's singer, and
		// /api/process needs a session at all.
		const phone = await world.openPhone('P14');
		// The library scan is a DETACHED boot pass, so /health answers before the index exists; this waits for it
		// and names the ffmpeg cause if the fixture never indexed.
		const songA = await world.awaitDemoTrack(QUERY_A);
		const songB = await world.awaitDemoTrack(QUERY_B);
		expect(songA.id, 'fixtures A and B must be two DISTINCT songs').not.toBe(songB.id);

		await startProcess(phone, songA.id);
		await expect
			.poll(() => isReady(phone, songA.id), {
				timeout: 60_000,
				message: `song A ("${songA.title}") never processed, so there is nothing to play`
			})
			.toBe(true);

		// Queued through the REAL row action: a ready row offers `.add`, and this is the same press a singer
		// makes. Its `singerId` is therefore this phone's by construction.
		await openBrowseFromHome(phone);
		await phone.locator(SEL.search).fill(QUERY_A);
		await rowFor(phone, QUERY_A).locator(SEL.addAction).click();

		const tv = await world.openTv();
		await tv.locator(SEL.tvConnected).waitFor({ state: 'attached' });
		// ONE REAL TAP, to authorise the document. See the header.
		await tv.mouse.click(960, 540);

		await expect
			.poll(async () => (await read(tv))?.t ?? 0, {
				timeout: 60_000,
				message:
					`song A never reached a playhead past ${MIN_PLAYHEAD_SEC}s — nothing to perturb. ` +
					`Either the tap did not authorise playback or the instrumental never loaded.\n\n${world.core.log()}`
			})
			.toBeGreaterThan(MIN_PLAYHEAD_SEC);

		const before = await read(tv);
		if (!before) throw new Error('song A’s media element vanished between the wait and the first reading');
		expect(
			before.bytes,
			`A is not really decoding (${before.bytes}B at t=${before.t.toFixed(2)}s, paused=${before.paused}) — ` +
				`a held playhead would prove nothing`
		).toBeGreaterThan(MIN_DECODED_BYTES);

		// B's process starts HERE, with A already sounding: this is what produces the media:status frames and
		// then the onMediaReady queue:sync + nowplaying:changed burst that could disturb A.
		await startProcess(phone, songB.id);

		// The window is song A ONLY: a song CHANGE legitimately resets the playhead, so it closes the moment the
		// element stops holding A's src, or the natural advance to the next song would read as the defect.
		const srcA = before.src;
		let prev = before.t;
		let worstDrop = 0;
		let worstAt: { from: number; to: number } | null = null;
		let readyB = false;
		let readyAtT: number | null = null;
		let samples = 0;
		let closedBecause = 'sampling budget spent';
		for (let i = 0; i < MAX_SAMPLES; i++) {
			await new Promise((r) => setTimeout(r, SAMPLE_MS));
			const now = await read(tv);
			if (!now) {
				closedBecause = 'A’s element went away (song ended)';
				break;
			}
			if (now.src !== srcA) {
				closedBecause = 'the room advanced to the next song';
				break;
			}
			const drop = prev - now.t;
			if (drop > worstDrop) {
				worstDrop = drop;
				worstAt = { from: prev, to: now.t };
			}
			prev = now.t;
			samples++;
			if (!readyB && (await isReady(phone, songB.id))) {
				readyB = true;
				readyAtT = now.t;
			}
		}

		const windowNote =
			`window closed: ${closedBecause}; samples inside A: ${samples}, last playhead ${prev.toFixed(2)}s; ` +
			`B reached ready inside the window: ${readyB}` +
			(readyAtT !== null ? ` (at A t=${readyAtT.toFixed(2)}s)` : '');

		expect(
			worstDrop,
			`A's playhead moved BACKWARDS ${worstDrop.toFixed(2)}s during B's process` +
				(worstAt ? ` (${worstAt.from.toFixed(2)}s → ${worstAt.to.toFixed(2)}s)` : '') +
				`. Processing another song perturbed the playing song.\n${windowNote}`
		).toBeLessThanOrEqual(TOL_SEC);

		// Without this the run above proves only that a quiet window is quiet: the burst has to have landed
		// INSIDE A's window for the playhead to have been exposed to it at all.
		expect(
			readyB,
			`B never processed inside A's window, so the onMediaReady queue:sync + nowplaying:changed burst was ` +
				`not observed and the playhead was never actually challenged.\n${windowNote}\n\n${worker.log()}`
		).toBe(true);
	} finally {
		await worker.stop();
	}
});
