/*
 * Does a sound actually come out? The worked example of docs/E2E.md#proving-audio.
 *
 * THE CLAIM IS A SOUND, NOT A STATE. `webkitAudioDecodedByteCount` must CLIMB while the UI claims to be playing.
 * This is the FLAC-in-a-<video> defect: a valid file, an element that reports itself "playing", zero decoded
 * bytes, and a silent room. So the counter is sampled TWICE across a fixed interval, and that interval is a
 * MEASUREMENT INTERVAL — not a stand-in for auto-waiting — which is why it stays a dwell and why the playhead is
 * required to have advanced across it. A run that cannot take the two samples FAILS; it never passes quietly.
 *
 * NO `--autoplay-policy=no-user-gesture-required`, and NO GESTURE ON THE TV AT ALL. Relaxing the policy proves
 * playback in an environment the product never ships into — a television grants no gesture — and the suite's own
 * launch options (playwright.config.ts) therefore grant no such flag. docs/E2E.md#autoplay records a box where
 * gestureless playback was REFUSED (`paused true`, `currentTime 0.00`, 24576 decoded bytes: the preload burst and
 * nothing more, against 507904 with the flag); on the Chromium this suite launches, the master decodes unprompted,
 * which is how the old flow measured it too. If a run ever lands on a refusing browser, the decoded-byte failure
 * below is the honest report: the product's own remedy is the tap-to-start hint (`SEL.autoplayHint`), a REAL tap
 * — a synthetic `el.click()` is untrusted, grants no user activation, and can neither unblock autoplay nor resume
 * an AudioContext — and that remedy has its own probe. It is deliberately not wired in here, because a branch
 * this box never takes is a branch nothing tests.
 *
 * A READY SONG HAS TO EXIST FIRST or none of this means anything. The old flow demanded one in the environment
 * ("seed + process one first") and bailed otherwise; here the flow makes one: a fake worker claims the real stems
 * job and publishes real audio, which is the only part of processing this box cannot do for itself.
 */
import { test, expect } from '../../world/fixtures';
import type { Page } from '@playwright/test';
import { SEL } from '../../world/selectors';
import { openBrowseFromHome, returnHomeFromBrowse } from '../../world/actors';
import { DEMO_LIBRARY } from '../../world/seed';
import { startFakeWorker, type FakeWorker } from '../../world/workers';
import type { World } from '../../world/fixtures';

const SEARCH_TERM = 'caroline';

// The track this flow plays, DERIVED from the fixture rather than re-typed: core takes a library track's title
// from its filename.
const DEMO_FILE = DEMO_LIBRARY.map((t) => t.file).find((f) => f.includes(SEARCH_TERM));
if (!DEMO_FILE) {
	// Thrown at collection rather than skipped: a fixture with nothing to play is an environment that cannot
	// answer the question, and a permanently-skipped test is indistinguishable from the rot it was meant to catch.
	throw new Error(`no track in world/seed.ts DEMO_LIBRARY matches "${SEARCH_TERM}" — this flow plays it`);
}
const DEMO_TITLE = DEMO_FILE.replace(/\.[^.]+$/, '');

/** THE MEASUREMENT INTERVAL for the decoded-byte claim. Two samples, this far apart, on the wall clock. */
const SAMPLE_INTERVAL_MS = 3_000;
/** How far the playhead must have moved across that interval. Below this the element is crawling, not playing. */
const MIN_PLAYHEAD_ADVANCE_SEC = 1.5;

/** One media element as the probe reads it. */
interface MediaReading {
	i: number;
	tag: string;
	src: string;
	readyState: number;
	paused: boolean;
	muted: boolean;
	volume: number;
	currentTime: number;
	duration: number;
	decoded: number | null;
	videoDecoded: number | null;
	error: { code: number; message: string } | null;
	display: string;
}

/**
 * Read whatever the stage mounted, without assuming which tag or how many: the master is a hidden `<audio>` and
 * the guiding track adds a second. ONE round trip, so no field can move relative to another between readings.
 */
async function readMedia(page: Page): Promise<MediaReading[]> {
	return page.evaluate((mediaEl) => {
		return [...document.querySelectorAll(mediaEl)].map((node, i) => {
			const el = node as HTMLMediaElement & {
				webkitAudioDecodedByteCount?: number;
				webkitVideoDecodedByteCount?: number;
			};
			return {
				i,
				tag: el.tagName,
				src: el.currentSrc || el.src || '',
				readyState: el.readyState,
				paused: el.paused,
				muted: el.muted,
				volume: el.volume,
				currentTime: el.currentTime,
				duration: el.duration,
				decoded: el.webkitAudioDecodedByteCount ?? null,
				videoDecoded: el.webkitVideoDecodedByteCount ?? null,
				error: el.error ? { code: el.error.code, message: el.error.message } : null,
				display: getComputedStyle(el).display
			};
		});
	}, SEL.mediaEl);
}

/** The element carrying the instrumental, or any element with a source at all. */
function pick(set: MediaReading[]): MediaReading | undefined {
	return set.find((e) => e.src.includes('instrumental')) ?? set.find((e) => e.src);
}

const dump = (set: MediaReading[]): string => JSON.stringify(set);

/** A search row as the API returns it — only the fields this flow reads. */
interface SearchRow {
	id: string;
	source: string;
	sourceRef: string;
	title: string;
}

interface SearchGroups {
	ready?: SearchRow[];
	processing?: SearchRow[];
	results?: SearchRow[];
}

async function searchApi(baseURL: string): Promise<SearchGroups> {
	const res = await fetch(`${baseURL}/api/search?q=${encodeURIComponent(SEARCH_TERM)}`).catch(() => null);
	return res?.ok ? ((await res.json()) as SearchGroups) : {};
}

/**
 * Wait until the demo track is INDEXED, and answer with it.
 *
 * The library scan is a boot pass that finishes AFTER /health answers, and the phone's search is debounced and
 * fires once per keystroke — nothing re-runs it when the index shows up later, so a phone that types too early
 * gets an answer from an empty library. THROWS with the remedy: an unindexed library cannot be searched.
 */
async function awaitDemoTrack(baseURL: string, timeout = 30_000): Promise<SearchRow> {
	const deadline = Date.now() + timeout;
	let seen = 'nothing at all';
	while (Date.now() < deadline) {
		const groups = await searchApi(baseURL);
		const rows = [...(groups.ready ?? []), ...(groups.processing ?? []), ...(groups.results ?? [])];
		const hit = rows.find((r) => r.source === 'local' && r.sourceRef.includes(DEMO_TITLE));
		if (hit) return hit;
		if (rows.length) seen = rows.map((r) => `${r.source}:${r.title}`).join(', ');
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(
		`the demo library never indexed ${DEMO_FILE} within ${timeout / 1000}s. /api/search answered: ${seen}. The ` +
			`demo tracks only index when a file exists behind them and ffmpeg can read a duration — see world/seed.ts.`
	);
}

interface Stage {
	worker: FakeWorker;
	phone: Page;
	tv: Page;
	/** The processed song, as the API names it. */
	song: SearchRow;
}

/**
 * Get a room to the point where a PROCESSED song is playing and a TV is watching it — the state both claims below
 * are about. Returns before asserting anything about sound.
 */
async function stageASound(world: World): Promise<Stage> {
	// FIRST, so the stems job is claimed the moment it is enqueued.
	const worker = await startFakeWorker(world);

	// One singer. A fixed name is safe because the room is per-test; names only have to be unique per ROOM, and a
	// reused one gets a 409 while the join page stays put, which looks exactly like a broken flow.
	const phone = await world.openPhone('Ruth');
	const song = await awaitDemoTrack(world.baseURL);

	// Processing is requested through the API rather than the UI, because the phone's queue action for an
	// unprocessed song queues it as well — and this flow needs the song READY BEFORE the singer queues it, which
	// is what makes the row offer `add` and what the check below measures.
	// Through the PAGE's request context, so it carries that singer's session cookie: /api/process refuses an
	// anonymous caller, and rightly — no anonymous compute.
	const asked = await phone.request.post('/api/process', { data: { mediaId: song.id } });
	expect(asked.ok(), `POST /api/process was refused: ${asked.status()} ${await asked.text()}`).toBe(true);

	await expect
		.poll(async () => (await searchApi(world.baseURL)).ready?.some((r) => r.id === song.id) ?? false, {
			timeout: 60_000,
			message: `${song.title} never became READY, so there is nothing processed to play.\n\n${worker.log()}`
		})
		.toBe(true);

	await openBrowseFromHome(phone); // search lives at the top of the joined home
	await phone.locator(SEL.search).fill(SEARCH_TERM);
	await expect(phone.locator(SEL.songRow).first()).toBeVisible({ timeout: 15_000 });

	// A ready song offers "add" (queue it now); a raw one offers "sing" (queue + process). This song is processed,
	// so the row must offer the cheap action.
	const hasAdd = await phone.locator(SEL.addTurn).count();
	expect(hasAdd, `the processed song offers no queue action: found ${hasAdd} ${SEL.addTurn} buttons`).toBeGreaterThan(
		0
	);

	// THE PROCESSED ROW BY NAME, not whichever action is first on screen: the same term returns a dozen YouTube
	// rows on a box with a network. Then by ROLE + ACCESSIBLE NAME, because the label is the contract.
	await phone
		.locator(SEL.songRow)
		.filter({ hasText: song.title })
		.getByRole('button', { name: /^Add a turn/ })
		.first()
		.click();
	await returnHomeFromBrowse(phone); // the rotation is on home

	// THE SONG IS IN THE ROTATION. Measured as rows OR the band, not as `.qrow` alone: an idle room auto-starts
	// the add and the phone's queue list renders only `queued` entries, so the FIRST song of the night is not a row
	// at all — it is on the band. (The old flow asserted `.qrow > 0` against a long-lived room that already had
	// something playing, where the same add really did land in a row.)
	await expect
		.poll(
			async () => {
				const rows = await phone.locator(SEL.queueRow).count();
				const band = (await phone.locator(SEL.bandTitle).allTextContents())
					.map((t) => t.trim())
					.filter((t) => t && t !== 'Nothing playing');
				return rows + band.length;
			},
			{
				timeout: 30_000,
				message: `${song.title} never reached the rotation: no ${SEL.queueRow} and nothing on the band.`
			}
		)
		.toBeGreaterThan(0);

	const tv = await world.openTv();
	return { worker, phone, tv, song };
}

test('a sound actually comes out', async ({ world }) => {
	const { worker, tv } = await stageASound(world);
	try {
		// Playback must begin with no gesture on the TV, so the first thing asked of it is what it mounted BY
		// ITSELF. Polled rather than slept on: loading a source is the TV's own work and its latency is not a
		// number this file can know.
		let els: MediaReading[] = [];
		await expect
			.poll(
				async () => {
					els = await readMedia(tv);
					return els.filter((e) => e.src).length;
				},
				{
					timeout: 30_000,
					message: `the TV mounted no media element with a source, unprompted.\n\n${worker.log()}`
				}
			)
			.toBeGreaterThan(0);

		const master = pick(els);
		expect(master, `no master element carries the instrumental: ${dump(els)}`).toBeDefined();
		expect(master?.src, `a master element carries no instrumental: src=${master?.src}`).toContain('instrumental');
		// The FLAC-in-a-<video> defect: an audio-only instrumental in a <video> decodes nothing on WebKit. The
		// element that plays the instrumental should be an <audio>.
		expect(
			master?.tag,
			`the master is a <${master?.tag.toLowerCase()}> — WebKit documents FLAC for <audio> only, so a valid file ` +
				`decodes silence here`
		).toBe('AUDIO');
		expect(master?.error, `the master reports a media error: ${JSON.stringify(master?.error)}`).toBeNull();

		// THE ASSERTION THAT MATTERS: decoded bytes climbing. Two samples, SAMPLE_INTERVAL_MS apart — the interval
		// IS the measurement, which is why it is a dwell and not a poll, and why every reading below comes from
		// this one pass rather than from four separate looks at the page.
		const t0 = await readMedia(tv);
		await tv.waitForTimeout(SAMPLE_INTERVAL_MS);
		const t1 = await readMedia(tv);
		const a = pick(t0);
		const b = pick(t1);
		// A run that never managed to take the two samples FAILS. Passing here would be the whole defect this flow
		// exists to catch, wearing a green tick.
		expect(a, `no element with a source to measure at the start of the interval: ${dump(t0)}`).toBeDefined();
		expect(b, `no element with a source to measure at the end of the interval: ${dump(t1)}`).toBeDefined();
		if (!a || !b) return; // unreachable after the two assertions above; narrows the type for what follows

		const dDecoded = (b.decoded ?? 0) - (a.decoded ?? 0);
		const dTime = b.currentTime - a.currentTime;
		expect(
			dDecoded,
			`AUDIO IS NOT DECODING with no gesture on the TV: decoded went ${a.decoded} → ${b.decoded} (+${dDecoded}) ` +
				`over ${SAMPLE_INTERVAL_MS / 1000}s. Zero means the element is "playing" a file it cannot decode — the ` +
				`room hears nothing. If ${SEL.autoplayHint} is on screen the browser REFUSED autoplay, which is a ` +
				`different finding: see the autoplay note at the top of this file.\n\n${dump(t1)}`
		).toBeGreaterThan(0);
		expect(
			dTime,
			`the playhead does not advance against the wall clock: currentTime went ${a.currentTime.toFixed(2)} → ` +
				`${b.currentTime.toFixed(2)} (+${dTime.toFixed(2)}s) over ${SAMPLE_INTERVAL_MS / 1000}s`
		).toBeGreaterThan(MIN_PLAYHEAD_ADVANCE_SEC);
		expect(b.paused, `the master is paused while the room is playing`).toBe(false);
		expect([b.muted, b.volume > 0], `the master is inaudible: muted=${b.muted} volume=${b.volume}`).toEqual([
			false,
			true
		]);
	} finally {
		await worker.stop();
	}
});

test('pause holds the playhead and resume continues from it', async ({ world }) => {
	const { worker, phone, tv } = await stageASound(world);
	try {
		// Still no gesture on the TV: this claim is about the transport, and it is only askable of a master that is
		// really playing.
		await expect
			.poll(async () => pick(await readMedia(tv))?.src ?? '', {
				timeout: 30_000,
				message: `the TV mounted no media element with a source, unprompted.\n\n${worker.log()}`
			})
			.not.toBe('');
		// The transport is only worth pressing once the playhead is moving — otherwise "pause held the playhead"
		// would be asserted about a playhead that never left zero.
		await expect
			.poll(async () => pick(await readMedia(tv))?.currentTime ?? 0, {
				timeout: 30_000,
				message: `the playhead never started moving, so there is nothing for pause to hold.\n\n${worker.log()}`
			})
			.toBeGreaterThan(0.5);

		// PAUSE. Pressed by accessible name on the phone's band — the transport is in the band row at both sheet
		// heights, so it needs no gesture to reach, and the name IS the state.
		const before = pick(await readMedia(tv));
		// ANCHORED, and it has to be: `getByRole`'s name option matches a case-insensitive SUBSTRING, and the band's
		// expand button is labelled "<title> — now playing" — so a bare `Play` resolves to that button as well as to
		// the disc and the click dies of strict mode instead of pressing the transport.
		await phone.getByRole('button', { name: /^Pause$/ }).click();
		let paused: MediaReading | undefined;
		await expect
			.poll(
				async () => {
					paused = pick(await readMedia(tv));
					return paused?.paused ?? null;
				},
				{ timeout: 15_000, message: `pause did not pause the master element.\n\n${worker.log()}` }
			)
			.toBe(true);
		expect(before, 'nothing to compare the paused playhead against').toBeDefined();
		expect(paused, 'no element with a source after the pause').toBeDefined();
		if (!before || !paused) return; // unreachable; narrows the type
		// Pinned into consts: the two readings are the SUBJECT of everything below, and a `let` the poll above
		// reassigns would both lose its narrowing inside the next closure and let a later poll move the baseline.
		const wasAt = before;
		const pausedAt = paused;

		// A JUMP TO 0 IS THE RELOAD BUG: the element was re-created instead of paused.
		expect(
			pausedAt.currentTime,
			`pause reset the playhead: was ${wasAt.currentTime.toFixed(2)}s, after pause ` +
				`${pausedAt.currentTime.toFixed(2)}s`
		).toBeGreaterThan(0.5);
		expect(
			Math.abs(pausedAt.currentTime - wasAt.currentTime),
			`pause moved the playhead: was ${wasAt.currentTime.toFixed(2)}s, after pause ` +
				`${pausedAt.currentTime.toFixed(2)}s`
		).toBeLessThan(2.5);

		// RESUME.
		await phone.getByRole('button', { name: /^Play$/ }).click();
		let resumed: MediaReading | undefined;
		await expect
			.poll(
				async () => {
					resumed = pick(await readMedia(tv));
					return !!resumed && !resumed.paused && (resumed.decoded ?? 0) > (pausedAt.decoded ?? 0);
				},
				{
					timeout: 20_000,
					message:
						`resume did not start decoding again: paused at ${pausedAt.decoded} bytes, ` +
						`${JSON.stringify(resumed)}\n\n${worker.log()}`
				}
			)
			.toBe(true);
		expect(
			resumed?.currentTime ?? -1,
			`resume restarted from the top: paused at ${pausedAt.currentTime.toFixed(2)}s, resumed at ` +
				`${resumed?.currentTime?.toFixed(2)}s`
		).toBeGreaterThanOrEqual(pausedAt.currentTime - 0.5);
	} finally {
		await worker.stop();
	}
});
