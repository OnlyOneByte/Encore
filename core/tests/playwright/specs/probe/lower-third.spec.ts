// Does the wall name the RIGHT singer once the second song is actually playing? Anchored on the AUDIBLE
// element's src — unpaused and advancing — and NOT on a first decoded byte: the hidden slot pre-warms, so
// song 2's first byte arrives within milliseconds while song 1 is still playing and the wall should still
// read song 1's singer, which makes a decode-counter anchor compare two moments inside song 1.
//
// ONE test, three assertions: all three read the same sampled series, and a second pass would be a second
// handover with its own timing.
import { test, expect, type World } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome } from '../../world/actors';
import type { Page } from '@playwright/test';

/** The old probe's own cadence, and it is load-bearing: the wall is repainted off a socket frame, so a
 *  sparser series can straddle the handover and attribute song 1's name to song 2. */
const SAMPLE_MS = 250;
/** How long the SECOND src must stay audible before its name is judged — the wall's repaint is a frame
 *  behind the audio, and the old probe bought this by sampling the whole 22.5s window. */
const SETTLE_SAMPLES = 6;
const SAMPLE_DEADLINE_MS = 30_000;

interface SongRow {
	id: string;
	title: string;
	source: string;
	instrumentalRef?: string | null;
	stemStatus?: string;
}
interface SearchBody {
	ready: SongRow[];
	processing: SongRow[];
	results: SongRow[];
}

/**
 * Process one local library song and resolve when it is READY with an instrumental to play.
 *
 * `awaitDemoTrack` first, because the library scan is a detached boot pass: the index is empty for seconds after
 * `/health` answers, and a search landing in that window cannot tell "early" from "broken". The process request
 * rides the PAGE's request context so it carries that phone's singer cookie — `/api/process` refuses an
 * anonymous caller, and a fetch from the test process would be a different session.
 */
async function processToReady(world: World, page: Page, query: string): Promise<SongRow> {
	const track = await world.awaitDemoTrack(query);
	const res = await page.request.post('/api/process', { data: { mediaId: track.id } });
	if (!res.ok()) throw new Error(`/api/process refused "${query}": ${res.status()} ${await res.text()}`);
	await expect
		.poll(
			async () => {
				const body = (await page.request
					.get(`/api/search?q=${encodeURIComponent(query)}`)
					.then((r) => r.json())) as SearchBody;
				return body.ready.some((r) => r.id === track.id && !!r.instrumentalRef);
			},
			{ timeout: 60_000, message: `"${track.title}" never reached ready with an instrumental ref` }
		)
		.toBe(true);
	return track;
}

/**
 * Search for a READY song and take a turn on it through the real row action, then wait for the phone's own
 * acknowledgement — where the old driver slept 600ms and hoped.
 *
 * EITHER signal counts, because which one arrives depends on whether the room was idle: `inQueue` is
 * `queued.some(...)` and a turn that starts PLAYING immediately leaves `queued`, so the row's button
 * re-enables and the band names the song instead.
 */
async function queueReady(page: Page, query: string): Promise<void> {
	await openBrowseFromHome(page);
	await page.locator(SEL.search).fill(query);
	await page.locator(SEL.addTurn).first().click();
	await expect
		.poll(
			async () => {
				if (await page.locator(SEL.addTurn).first().isDisabled()) return true;
				const strip = (await page.locator(SEL.npStripTitle).first().textContent()) ?? '';
				return strip.toLowerCase().includes(query);
			},
			{ message: `the phone never acknowledged the turn on "${query}" — no queued row and the strip never named it` }
		)
		.toBe(true);
}

interface AudibleSample {
	src: string;
	t: number | null;
	name: string;
	song: string;
	mounted: number;
}

/** One reading of what is AUDIBLE and what the wall says about it, in one round trip so the two cannot
 *  describe different moments. */
async function sampleAudible(tv: Page): Promise<AudibleSample> {
	return tv.evaluate(
		({ mediaEl, nowName, nowSong }) => {
			const els = [...document.querySelectorAll<HTMLMediaElement>(mediaEl)];
			// "Audible" means not paused AND currentTime moving — the pre-warmed sibling is neither.
			const live = els.find((e) => !e.paused && e.currentTime > 0.05) ?? null;
			return {
				src: live ? live.currentSrc || live.src : '',
				t: live ? live.currentTime : null,
				name: (document.querySelector(nowName)?.textContent ?? '').trim(),
				song: (document.querySelector(nowSong)?.textContent ?? '').trim(),
				mounted: els.length
			};
		},
		{ mediaEl: SEL.mediaEl, nowName: SEL.nowName, nowSong: SEL.nowSong }
	);
}

interface Transition extends AudibleSample {
	at: number;
	/** The name still on the wall at the LAST sample this src was audible — what the wall settled on, not
	 *  what it happened to say in the frame the src changed. */
	lastName?: string;
	samples: number;
}

test('the wall names the singer of whichever src is actually audible', async ({ world }) => {
	const worker = await startFakeWorker(world);
	try {
		const a = await world.openPhone('LT-A');
		const b = await world.openPhone('LT-B');

		// Both processed before either is queued, so the rotation order is the order they were ADDED and not
		// the order two processes happened to finish in.
		await processToReady(world, a, 'caroline');
		await processToReady(world, a, 'believin');
		await queueReady(a, 'caroline');
		await queueReady(b, 'believin');

		const tv = await world.openTv();
		await tv.locator(SEL.tvConnected).waitFor({ state: 'attached' });
		// ONE REAL TAP. A television grants no user activation and this probe's subject is not autoplay, so
		// the document is authorised the way a real room authorises it — TvPlayer's always-armed pointerdown
		// listener — rather than by relaxing the policy for a browser no TV ships as. docs/E2E.md#gestures
		await tv.mouse.click(960, 540);

		const seen: Transition[] = [];
		const started = Date.now();
		let last: AudibleSample | null = null;
		while (Date.now() - started < SAMPLE_DEADLINE_MS) {
			const s = await sampleAudible(tv);
			last = s;
			if (s.src) {
				const tail = seen[seen.length - 1];
				if (!tail || tail.src !== s.src) seen.push({ ...s, at: Date.now() - started, samples: 1 });
				else {
					tail.lastName = s.name;
					tail.samples += 1;
				}
			}
			// The series is complete once the SECOND src has been audible long enough for the wall to have
			// repainted; sampling past that adds nothing the claims read.
			if (seen.length >= 2 && (seen[seen.length - 1]?.samples ?? 0) >= SETTLE_SAMPLES) break;
			await new Promise((r) => setTimeout(r, SAMPLE_MS));
		}

		const series = seen
			.map(
				(s) =>
					`  +${s.at}ms  src=…${s.src.slice(-28)}  name="${s.name}"` +
					`${s.lastName && s.lastName !== s.name ? ` → "${s.lastName}"` : ''}  song="${s.song}"`
			)
			.join('\n');
		const detail = `audible-src transitions:\n${series || '  (none)'}\nlast sample: ${JSON.stringify(last)}`;

		expect(
			seen.length,
			`saw ${seen.length} distinct audible src(s) — ${seen.length < 2 ? 'the handover never happened' : ''}\n${detail}`
		).toBeGreaterThanOrEqual(2);

		const n1 = seen[0]?.lastName ?? seen[0]?.name ?? '';
		const n2 = seen[1]?.lastName ?? seen[1]?.name ?? '';
		expect(
			n1 !== n2 && !!n1 && !!n2,
			`song 1 showed "${n1}", song 2 showed "${n2}" — identical means the room keeps the old singer's ` +
				`name up\n${detail}`
		).toBe(true);
		expect(
			['LT-A', 'LT-B'].includes(n1) && ['LT-A', 'LT-B'].includes(n2),
			`expected two of [LT-A, LT-B], got "${n1}" and "${n2}"\n${detail}`
		).toBe(true);
	} finally {
		await worker.stop();
	}
});
