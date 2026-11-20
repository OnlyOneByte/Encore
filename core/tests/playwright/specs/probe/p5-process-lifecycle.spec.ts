// P5 — PROCESS LIFECYCLE, THE UNHAPPY PATHS. Each scenario drives a REAL job through a REAL worker over the
// real protocol and then asks what the phone was told. The fault injectors are the typed options on
// `startFakeWorker` — one per row of docs/E2E.md#fault-injection — and each reaches a SPECIFIC real state, so
// they are named rather than described.
//
// ONE TEST PER SCENARIO, because a scenario is one core's whole life: the old probe wiped $SCRATCH and booted a
// fresh server with its own phone socket and its own fake worker per scenario, and `world` does exactly that per
// test. Inside a scenario the assertions stay together — they are readings of one process settling, and a second
// process would settle differently.
//
// WHAT THE OLD PROBE WAS. It did not assert; it RECORDED findings at CRITICAL/HIGH/MEDIUM/LOW and exited 1 when
// any CRITICAL or HIGH had fired. So each scenario's LOW branch is the claim the repo believes and the HIGH
// branch is the violation, and that is the shape ported here: the LOW branch becomes the expect. Two of the
// eight recorded a HIGH against the product as it stood; one of those two (the silent instrumental) has since
// been FIXED — `WorkerHub#refuseSilentInstrumental` is the guard the finding said was absent — and the other
// (an unservable ref) still reproduces and is annotated, never weakened.
//
// THE PHONE'S SOCKET IS THE SUBJECT, not the database. Every terminal claim below is read off `media:status`
// frames, because what the guest is TOLD is the thing that can lie. A failed terminal job must clear the
// phone's "processing" state: a song that lies is worse than a song that is absent.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome, openQueue } from '../../world/actors';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
// `ws`, not Node's global, for the reason world/presence.ts gives: one WebSocket implementation per suite.
import { WebSocket } from 'ws';
import type { Page } from '@playwright/test';

/** A 16-bit PCM WAV's header is 44 documented bytes; everything past it is samples. */
const WAV_HEADER_BYTES = 44;
/** leases.ts DEFAULT_LEASE_CONFIG progressLeaseMs is 30s and the reaper ticks every 3s, so the dead-worker
 *  scenario CANNOT finish in under ~33s however healthy the box. */
const REAPER_RECOVERY_MS = 90_000;
/** DEFAULT_GLOBAL_SETTINGS.maxProcessesPerSinger — the cap the fourth tap must hit. */
const PROCESS_CAP = 3;

interface Media {
	id: string;
	title: string;
	source: string;
	sourceRef?: string;
}
interface SearchBody {
	ready: Media[];
	processing: Media[];
	results: Media[];
}
interface LibraryBody {
	library: Media[];
}
interface StatusFrame {
	status: string;
	pct: number;
	unservable?: boolean;
}

/** A GET issued BY THE PAGE, so it carries the phone's own session. */
async function apiGet<T>(page: Page, path: string): Promise<{ status: number; body: T }> {
	return page.evaluate(async (p) => {
		const r = await fetch(p);
		return { status: r.status, body: (await r.json().catch(() => null)) as never };
	}, path);
}

/** Just the HTTP status of a ranged read — the old probe's `range: bytes=0-1` probe of /media. */
async function rangeStatus(page: Page, path: string): Promise<number> {
	return page.evaluate(async (p) => {
		const r = await fetch(p, { headers: { range: 'bytes=0-1' } });
		return r.status;
	}, path);
}

async function requestProcess(
	page: Page,
	mediaId: string
): Promise<{
	status: number;
	body: { job?: { id: string }; alreadyReady?: boolean; reason?: string; error?: string };
}> {
	return page.evaluate(async (id) => {
		const r = await fetch('/api/process', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ mediaId: id })
		});
		return { status: r.status, body: (await r.json().catch(() => ({}))) as never };
	}, mediaId);
}

/**
 * The row whose title NAMES the query. Never `.first()` on a bare action selector: the find box is debounced,
 * so the previous query's rows are still on screen when the new query is typed and a blind first-click acts on
 * the wrong song.
 */
function rowFor(page: Page, query: string) {
	return page.locator(SEL.songRow).filter({ hasText: query }).first();
}

interface StatusWatch {
	frames: StatusFrame[];
	/** Every status seen, in order, for a failure message: the transitions ARE the evidence. */
	transitions(): string;
	last(): StatusFrame | undefined;
	close(): void;
}

/**
 * Every `media:status` frame for one media, off a phone-role socket. The old probe rode the singer's cookie on
 * the WS handshake because it also sent queue commands down it; nothing here does — the queue is driven through
 * the real UI — so this socket only listens.
 */
async function watchStatus(baseURL: string, mediaId: string): Promise<StatusWatch> {
	const frames: StatusFrame[] = [];
	const ws = new WebSocket(`${baseURL.replace(/^http/, 'ws')}/ws?role=phone`);
	await new Promise<void>((resolve, reject) => {
		ws.once('open', () => resolve());
		ws.once('error', (err) => reject(new Error(`media:status socket refused: ${err.message}`)));
	});
	ws.on('message', (raw: Buffer | string) => {
		try {
			const m = JSON.parse(String(raw)) as {
				type?: string;
				mediaId?: string;
				status?: string;
				pct?: number;
				unservable?: boolean;
			};
			if (m.type === 'media:status' && m.mediaId === mediaId) {
				frames.push({ status: String(m.status), pct: m.pct ?? 0, unservable: m.unservable });
			}
		} catch {
			// a frame this probe is not about
		}
	});
	return {
		frames,
		transitions: () => frames.map((f) => `${f.status}@${f.pct}%`).join(' → ') || '(none)',
		last: () => frames[frames.length - 1],
		close: () => ws.close()
	};
}

const TERMINAL = ['ready', 'failed'];

/** Wait until the phone has been told something terminal, and hand back that frame. */
async function awaitTerminal(watch: StatusWatch, timeout: number, label: string): Promise<StatusFrame> {
	await expect
		.poll(() => TERMINAL.includes(watch.last()?.status ?? ''), {
			timeout,
			message: `no terminal media:status for ${label}; saw [${watch.transitions()}]`
		})
		.toBe(true);
	return watch.last()!;
}

/** True when every sample past the WAV header is zero — the artifact really IS digital silence. */
function samplesAllZero(path: string): { bytes: number; allZero: boolean } {
	const bytes = existsSync(path) ? statSync(path).size : 0;
	if (bytes <= WAV_HEADER_BYTES) return { bytes, allZero: false };
	const buf = readFileSync(path);
	return { bytes, allZero: buf.subarray(WAV_HEADER_BYTES).every((b) => b === 0) };
}

const instrumentalPath = (mediaDir: string, mediaId: string): string =>
	join(mediaDir, 'derived', 'stems', `${mediaId}-instrumental.wav`);

// ── 1 · a floor-level instrumental must be refused ───────────────────────────────────────────────────────

test('a floor-level instrumental is refused rather than published as ready', async ({ world }) => {
	// THE FINDING THIS SCENARIO RAISED IS NOW FIXED, which is why it is a plain assertion: the old probe
	// recorded HIGH — "silent instrumental published as READY with no defense-in-depth in the core" — because
	// #onComplete called markMediaReady unconditionally and the ffmpeg loudness probe was wired only for
	// boot-time vocals backfill. WorkerHub#refuseSilentInstrumental now gates completion on
	// `verifyInstrumental`, which is app.ts's three-way probe: an UNMEASURABLE file is not silence, so only a
	// POSITIVE reading refuses. This test therefore also fails on a host whose ffmpeg cannot run
	// `volumedetect` — correctly, because there the guard cannot fire and the old finding is live again.
	const worker = await startFakeWorker(world, { silentInstrumental: true, slowMs: 150 });
	try {
		const phone = await world.openPhone('P5-s1');
		const media = await world.awaitDemoTrack('caroline');
		const watch = await watchStatus(world.baseURL, media.id);
		try {
			const started = await requestProcess(phone, media.id);
			expect(started.status, `process failed: ${JSON.stringify(started.body)}`).toBe(200);
			const last = await awaitTerminal(watch, 15_000, 'silent-ins terminal');

			// PRECONDITION, not the claim: unless the artifact on disk really is all zeros past the 44-byte
			// header, this run says nothing about silence.
			const stem = samplesAllZero(instrumentalPath(world.mediaDir, media.id));
			if (!stem.allZero) {
				throw new Error(
					`the injected instrumental is not digital silence (${stem.bytes} bytes, allZero=${stem.allZero}), ` +
						`so the refusal below would be testing nothing.\n\n${worker.log()}`
				);
			}
			const inLibrary = (await apiGet<LibraryBody>(phone, '/api/library')).body.library.some((m) => m.id === media.id);
			expect(
				last.status,
				`a floor-level instrumental must be refused, not published. transitions=[${watch.transitions()}], ` +
					`/api/library contains it=${inLibrary}, on-disk stem ${stem.bytes} bytes all-zero=${stem.allZero}. ` +
					`See src/lib/server/jobs/worker-hub.ts #refuseSilentInstrumental, ` +
					`src/lib/server/media/loudness.ts isDigitalSilence, and app.ts's verifyInstrumental — which returns ` +
					`'unknown' (and so publishes) when ffmpeg cannot measure the file.\n\n${world.core.log()}`
			).toBe('failed');
		} finally {
			watch.close();
		}
	} finally {
		await worker.stop();
	}
});

// ── 2 · a silent vocal must NOT fail the process ─────────────────────────────────────────────────────────

test('silent vocals do not fail the process — the song is still singable', async ({ world }) => {
	// The guide track is OPTIONAL: setMediaVocals trusts the worker's report and does not probe content,
	// because "a song is perfectly playable with only the instrumental". A real Python worker would have
	// measured the silence and omitted the ref; the fake worker deliberately does not, so this proves only that
	// the CORE completes cleanly with a silent-vocals report — content-side guarding is the worker's job.
	const worker = await startFakeWorker(world, { silentVocals: true, slowMs: 150 });
	try {
		const phone = await world.openPhone('P5-s2');
		const media = await world.awaitDemoTrack('caroline');
		const watch = await watchStatus(world.baseURL, media.id);
		try {
			const started = await requestProcess(phone, media.id);
			expect(started.status, `process failed: ${JSON.stringify(started.body)}`).toBe(200);
			const last = await awaitTerminal(watch, 15_000, 'silent-voc terminal');
			const inLibrary = (await apiGet<LibraryBody>(phone, '/api/library')).body.library.some((m) => m.id === media.id);
			expect(
				last.status === 'ready' && inLibrary,
				`silent vocals must not break the process — this contradicts setMediaVocals: "a song is perfectly ` +
					`playable with only the instrumental". terminal=${last.status}, /api/library contains it=${inLibrary}, ` +
					`transitions=[${watch.transitions()}]. See src/lib/server/jobs/process.ts setMediaVocals.`
			).toBe(true);
		} finally {
			watch.close();
		}
	} finally {
		await worker.stop();
	}
});

// ── 3 · a ref the worker never wrote ────────────────────────────────────────────────────────────────────

// KNOWN LIVE DEFECT, annotated rather than weakened. A worker with a filesystem fault (a partial write, the
// wrong volume, a race with an eviction) reports refs for files it never wrote, and the core publishes them:
// app.ts's `verifyInstrumental` answers 'unknown' for a path that does not exist — deliberately, since
// unmeasurable must not become silence — and #completeVerified then runs markMediaReady, which trusts the
// reported ref and never fs.exists it. The TV mounts <audio src=/media/…>, the range probe answers 404, and no
// UI surface says so: the phone shows the row as READY until a singer taps play.
// REMOVE THE ANNOTATION once the publish path refuses a ref it cannot serve.
test.fail(
	'an artifact the worker never wrote must not be published as ready',
	{
		annotation: {
			type: 'known-defect',
			description:
				'markMediaReady trusts the reported ref with no fs.exists check, and verifyInstrumental answers ' +
				"'unknown' for a missing file. The assertion is correct; the publish path is not."
		}
	},
	async ({ world }) => {
		const worker = await startFakeWorker(world, { skipWrite: true, slowMs: 150 });
		try {
			const phone = await world.openPhone('P5-s3');
			const media = await world.awaitDemoTrack('caroline');
			const watch = await watchStatus(world.baseURL, media.id);
			try {
				const started = await requestProcess(phone, media.id);
				expect(started.status, `process failed: ${JSON.stringify(started.body)}`).toBe(200);
				const last = await awaitTerminal(watch, 15_000, 'skip-write terminal');

				// PRECONDITIONS, not the claim: the fault has to have landed, or "published ready" would be about
				// a ref that is perfectly servable.
				const onDisk = existsSync(instrumentalPath(world.mediaDir, media.id));
				const served = await rangeStatus(phone, `/media/derived/stems/${media.id}-instrumental.wav`);
				if (onDisk || served !== 404) {
					throw new Error(
						`skipWrite did not take: on-disk=${onDisk}, GET /media/… range=0-1 → ${served}. The claim below ` +
							`is about publishing an UNSERVABLE ref, so both must hold first.\n\n${worker.log()}`
					);
				}
				expect(
					last.status,
					`the song was published READY while /media 404s its instrumental. transitions=[${watch.transitions()}], ` +
						`on-disk=${onDisk}, GET /media/… range=0-1 → ${served}. See ` +
						`src/lib/server/jobs/process.ts markMediaReady (sets stemStatus=ready + instrumentalRef with no ` +
						`fs.exists check) and src/routes/media/[...path]/+server.ts, whose 404 is silent — no room ` +
						`broadcast, no automated re-process.`
				).toBe('failed');
			} finally {
				watch.close();
			}
		} finally {
			await worker.stop();
		}
	}
);

// ── 4 · a completion with no songProfile ────────────────────────────────────────────────────────────────

test('a completion with no songProfile does not deadlock the stems gate', async ({ world }) => {
	// setMediaSongProfile ALWAYS writes — an absent record normalises to EMPTY_SONG_PROFILE — and the stems
	// gate checks stemStatus + instrumentalRef only, never the profile. So the absence must be invisible here.
	const worker = await startFakeWorker(world, { noProfile: true, slowMs: 150 });
	try {
		const phone = await world.openPhone('P5-s4');
		const media = await world.awaitDemoTrack('caroline');
		const watch = await watchStatus(world.baseURL, media.id);
		try {
			const started = await requestProcess(phone, media.id);
			expect(started.status, `process failed: ${JSON.stringify(started.body)}`).toBe(200);
			const last = await awaitTerminal(watch, 15_000, 'no-profile terminal');
			const listed = (await apiGet<LibraryBody>(phone, '/api/library')).body.library.find((m) => m.id === media.id);
			expect(
				last.status === 'ready' && !!listed,
				`an absent songProfile deadlocked or failed the process, which contradicts ` +
					`src/lib/contract/queue/gates.ts (the stems gate reads stemStatus + instrumentalRef, NOT the profile) ` +
					`and src/lib/server/jobs/process.ts setMediaSongProfile, which normalises the absent record. ` +
					`terminal=${last.status}, listed=${!!listed}, transitions=[${watch.transitions()}]`
			).toBe(true);
		} finally {
			watch.close();
		}
	} finally {
		await worker.stop();
	}
});

// ── 5 · a failed process, and the retry that must follow it ─────────────────────────────────────────────

test('a failed process surfaces on the phone, settles to un-processed, and accepts a retry', async ({ world }) => {
	// `fail: 'stems'` is `retryable: false`, so the job is TERMINAL rather than requeued — this is how the
	// scenario reaches a real failure instead of an attempt count.
	//
	// FIVE READINGS, ONE PASS, and they cannot be split: the search snapshot must be taken AFTER the failure and
	// BEFORE the retry, because the retry puts the song straight back into `processing`.
	const worker = await startFakeWorker(world, { fail: 'stems', slowMs: 150 });
	try {
		const phone = await world.openPhone('P5-s5');
		const media = await world.awaitDemoTrack('caroline');
		const watch = await watchStatus(world.baseURL, media.id);
		try {
			const started = await requestProcess(phone, media.id);
			expect(started.status, `process failed: ${JSON.stringify(started.body)}`).toBe(200);
			const last = await awaitTerminal(watch, 15_000, 'fail-stems terminal');

			// After settleStemsGate the song must be re-processable — not ready, not processing — or no retry exists.
			const { body: after } = await apiGet<SearchBody>(phone, '/api/search?q=caroline');
			const inReady = after.ready.some((m) => m.id === media.id);
			const inProcessing = after.processing.some((m) => m.id === media.id);
			const inRaw = after.results.some((m) => m.id === media.id);
			const retry = await requestProcess(phone, media.id);

			const evidence =
				`transitions=[${watch.transitions()}]; /api/search after the failure — ready=${inReady} ` +
				`processing=${inProcessing} results=${inRaw}; retry POST /api/process → ${retry.status}, ` +
				`jobId=${retry.body?.job?.id ?? 'null'}`;
			expect(
				last.status === 'failed' && !inReady && !inProcessing && inRaw && retry.status === 200,
				`a failed process must surface visibly, settle the media back to un-processed, and accept a retry. ` +
					`${evidence}. See src/lib/server/jobs/worker-hub.ts #onFailed (settleStemsGate for fetch|stems), ` +
					`src/lib/server/jobs/process.ts settleStemsGate (resets stemStatus to "none"), ` +
					`src/routes/+page.svelte processingRows (INCLUDES failed entries so the row stays visible with a ` +
					`retry), and src/lib/readiness.ts displayReadiness (returns "failed" when live.status=failed and ` +
					`the song is not readyToSing).`
			).toBe(true);
		} finally {
			watch.close();
		}
	} finally {
		await worker.stop();
	}
});

// ── 6 · removing a song mid-process ─────────────────────────────────────────────────────────────────────

test('removing a song mid-process settles CANCELED, not FAILED', async ({ world }) => {
	// `slowMs: 5000` holds the job open: without a reported progress frame there is no live job for findLive
	// and the cancel is a no-op, and once the frame has landed the NEXT one is up to 5s out — which is the
	// window the settle has to arrive in.
	const worker = await startFakeWorker(world, { slowMs: 5_000 });
	try {
		const phone = await world.openPhone('P5-s6');
		const media = await world.awaitDemoTrack('caroline');
		const watch = await watchStatus(world.baseURL, media.id);
		try {
			// QUEUED AND PROCESSED IN ONE REAL TAP. `.sing` is "process and take a turn", which is exactly the
			// shape this scenario needs: cancelJobsForMedia short-circuits when nobody still needs the media, so
			// only a singleton queue entry makes the remove produce the cancel + settle + broadcast observed here.
			await openBrowseFromHome(phone);
			await phone.locator(SEL.search).fill('caroline');
			await rowFor(phone, 'caroline').locator(SEL.singAction).click();

			// Wait for a real progress frame with a non-zero pct — that is what makes the job LIVE.
			await expect
				.poll(() => watch.frames.some((f) => (f.status === 'separating' || f.status === 'downloading') && f.pct > 0), {
					timeout: 15_000,
					message: `no first worker progress frame; saw [${watch.transitions()}]\n\n${worker.log()}`
				})
				.toBe(true);

			// Removed through the REAL affordance — the processing card's own "remove from queue" button, by its
			// accessible name. The card lives on /queue since the Sing/Queue/Library tabs, so go there first.
			await openQueue(phone);
			await phone.getByRole('button', { name: 'remove from queue' }).first().click();

			await expect
				.poll(() => ['canceled', 'failed', 'ready'].includes(watch.last()?.status ?? ''), {
					timeout: 15_000,
					message: `no post-remove settle arrived; saw [${watch.transitions()}]\n\n${world.core.log()}`
				})
				.toBe(true);

			expect(
				watch.last()?.status,
				`the guest deliberately removed their song, so the phone must be told CANCELED. "failed" tells them ` +
					`the process broke, which is a lie. transitions=[${watch.transitions()}]. See ` +
					`src/lib/server/jobs/cancel.ts cancelJobsForMedia (broadcasts { type:media:status, status:canceled } ` +
					`after settleStemsGate), src/lib/readiness.ts displayReadiness (treats "canceled" as terminal and ` +
					`returns to catalog readiness, NOT "failed"), and src/routes/+page.svelte processingRows, which ` +
					`deliberately EXCLUDES canceled entries so the removed row does not linger.`
			).toBe('canceled');
		} finally {
			watch.close();
		}
	} finally {
		await worker.stop();
	}
});

// ── 7 · the worker dies mid-process ─────────────────────────────────────────────────────────────────────

test('a worker lost mid-process leaves no stranded job — the reaper recovers it', async ({ world }) => {
	// CANNOT finish in under ~33s however healthy the box: 30s progress lease + a 3s reaper tick + margin.
	test.setTimeout(180_000);
	// The old probe SIGKILLed the worker process. `stop()` closes the socket instead, which is the SAME thing
	// to the core: WorkerRegistry.remove's own docstring is "Drop a worker (WS close). Its jobs are reclaimed by
	// the reaper via lease expiry." No shortcut is taken — the lease still has to expire.
	const worker = await startFakeWorker(world, { slowMs: 4_000 });
	const phone = await world.openPhone('P5-s7');
	const media = await world.awaitDemoTrack('caroline');
	const watch = await watchStatus(world.baseURL, media.id);
	try {
		const started = await requestProcess(phone, media.id);
		expect(started.status, `process failed: ${JSON.stringify(started.body)}`).toBe(200);
		// The FIRST progress frame stamps the progressDeadline this scenario is about. Lose the worker before the
		// assign lands and the only lease is an ACK lease, which reaps in 10s with different semantics.
		await expect
			.poll(() => watch.frames.some((f) => f.pct > 0), {
				timeout: 15_000,
				message: `no first progress frame; saw [${watch.transitions()}]\n\n${worker.log()}`
			})
			.toBe(true);

		const killedAt = Date.now();
		await worker.stop();

		// Any of the reaper's three recovery signals counts: a 'queued' requeue, unservable:true (no capable
		// worker after the requeue), or a terminal 'failed'.
		await expect
			.poll(
				() =>
					watch.frames.some(
						(f) => f.status === 'failed' || f.status === 'ready' || f.status === 'queued' || f.unservable === true
					),
				{
					timeout: REAPER_RECOVERY_MS,
					intervals: [500],
					message:
						`the lost worker produced no reaper recovery within ${REAPER_RECOVERY_MS / 1000}s, so the job may ` +
						`be stranded. transitions=[${watch.transitions()}]. See src/lib/server/jobs/reaper.ts tick(), ` +
						`src/lib/server/jobs/leases.ts DEFAULT_LEASE_CONFIG (progressLeaseMs 30_000) and sweep ` +
						`(bumps attempts on progress-lease-expired). This may also be Bun.serve's 30s WS idleTimeout ` +
						`racing the 30s progress lease on a slow host.\n\n${world.core.log()}`
				}
			)
			.toBe(true);

		const recovered = watch.frames.find(
			(f) => f.status === 'failed' || f.status === 'ready' || f.status === 'queued' || f.unservable === true
		);
		expect(
			recovered?.status === 'failed' || recovered?.status === 'queued' || recovered?.unservable === true,
			`the only signal after the worker was lost was "${recovered?.status}", which is neither a requeue nor a ` +
				`terminal failure. ${Math.round((Date.now() - killedAt) / 1000)}s after the close. ` +
				`transitions=[${watch.transitions()}]`
		).toBe(true);
	} finally {
		watch.close();
	}
});

// ── 8 · the per-singer concurrency cap ──────────────────────────────────────────────────────────────────

test('the fourth concurrent process for one singer is refused with 429 and a human reason', async ({ world }) => {
	// `slowMs: 5000` keeps the first three in flight while the fourth is asked for.
	//
	// THE ATTRIBUTION MOVED, so the old probe's scaffolding is gone. It queued each song before processing it
	// because `countInFlightProcesses` used to attribute through the singer's QUEUE ENTRIES — which its own HIGH
	// branch flagged, since a direct API caller who never queued bypassed the cap. It now counts from the JOB
	// LEDGER (`jobs.liveProcessMediaForSinger`), so a process is attributed to the singer who asked for it and
	// the queue plays no part. The queueing is therefore dropped, not the claim.
	const worker = await startFakeWorker(world, { slowMs: 5_000, concurrency: PROCESS_CAP });
	try {
		const phone = await world.openPhone('P5-s8');
		const queries = ['caroline', 'believin', 'bohemian', 'prayer'];
		const medias: Media[] = [];
		for (const q of queries) medias.push(await world.awaitDemoTrack(q));
		const distinct = new Set(medias.map((m) => m.id));
		expect(
			distinct.size,
			`the cap is ${PROCESS_CAP}, so ${PROCESS_CAP + 1} DISTINCT local songs are needed; the demo library ` +
				`resolved ${distinct.size} for ${JSON.stringify(queries)}`
		).toBe(queries.length);

		const accepted: number[] = [];
		for (let i = 0; i < PROCESS_CAP; i++) accepted.push((await requestProcess(phone, medias[i]!.id)).status);
		expect(
			accepted,
			`could not stage ${PROCESS_CAP} concurrent processes, so the cap below would never be reached.\n\n` + worker.log()
		).toEqual(Array(PROCESS_CAP).fill(200));

		const fourth = await requestProcess(phone, medias[PROCESS_CAP]!.id);
		const detail = `4th tap status=${fourth.status}, body=${JSON.stringify(fourth.body)}`;
		expect(
			fourth.status,
			`the ${PROCESS_CAP + 1}th concurrent process must be refused. ${detail}. See ` +
				`src/routes/api/process/+server.ts's 429 branch and src/lib/server/jobs/process.ts ` +
				`maxProcessesPerSinger + countInFlightProcesses.`
		).toBe(429);
		// The phone renders `error` VERBATIM and branches on `reason`, so a 429 without both falls through to
		// generic handling and the singer is told nothing useful.
		expect(fourth.body?.reason, `the 429 body must name reason:"over-limit". ${detail}`).toBe('over-limit');
		expect(
			typeof fourth.body?.error === 'string' && fourth.body.error.length > 0,
			`the 429 body must carry a human error string a phone can render verbatim. ${detail}`
		).toBe(true);
	} finally {
		await worker.stop();
	}
});
