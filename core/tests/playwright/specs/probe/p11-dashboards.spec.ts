// P11 — THE THREE READ-ONLY DASHBOARDS AGAINST REAL DATA: /stats + /api/stats (public, aggregate-only),
// /metrics + /api/metrics (internal, ungated) and /metrics/<id> + /api/audit/<id>.
//
// IT COUNTS EVERYTHING ITSELF. The probe drives the shape a real server sees — several successful processes,
// one FAILED, one RETRIED, and some PLAYS — then compares each dashboard against its OWN arithmetic rather
// than against the dashboard's.
//
// A FAKE WORKER MUST ACTUALLY RUN, not merely exist. /api/metrics reads the `job_attempts` ledger, which only
// gets rows when a job is really ASSIGNED, accepted and sealed; /api/audit/<id> reads the same rows. A core with
// no worker produces an empty ledger, which renders as a dashboard that loaded fine and says nothing — so every
// test here starts at least one worker and waits for its job to land.
//
// THE DRIVE IS THE MEASUREMENT. The retried process is reached the only way it can be: a worker is lost while
// stems is running, its 30s progress lease expires, the reaper requeues, and a replacement completes the retry.
// That single fact is why the first two tests below hold nine and one claims respectively instead of one each —
// splitting them would buy nine cores and nine lease expiries for readings that all come from one drive. Every
// `expect` carries its own message, so a failure still names itself.
//
// SEL, NEVER A LITERAL. The vendored Card component renders `encore-card`, so `SEL.dashCard` is `.encore-card`;
// the ported `.card` form resolved against NOTHING on these pages — a selector that can only report "absent".
//
// NOT PORTED, with reasons:
//   '"Where the time goes" bars round sub-second stage means to 0 seconds' — the old probe recorded this
//     unconditionally when any stage mean was under 500ms and had no passing branch at all. It is an
//     observation about a chart, not a claim something must satisfy, and the finding was MEDIUM: non-blocking
//     even there. The rounding is real: src/routes/metrics/+page.svelte's Bars value is
//     Math.round((s.meanMs ?? 0) / 1000), which bypasses metrics-format's dur().
//   'fake-separator/e2e-tone measured rtFactor is null' — MEDIUM, and the LOW branch it guards is about the
//     DEGRADATION of the declared-cost columns. The rtFactor is reported in this spec's message instead.
//
// PROMOTED FROM NON-BLOCKING. The old probe exited 1 only on CRITICAL or HIGH, so four of its claims — the
// /stats trend line, the "no fetch step for a LOCAL source" check, and the ungated posture of /api/metrics and
// /api/audit — could fail without failing the probe. They hold today and are asserted here.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome } from '../../world/actors';
import type { World } from '../../world/fixtures';
import type { Page } from '@playwright/test';
// `ws`, not Node's global, for the reason world/presence.ts gives: one WebSocket implementation per suite.
import { WebSocket } from 'ws';

/** Long enough for a 30s progress lease plus a 3s reaper tick plus a whole retry chain, on top of a core boot. */
const DRIVE_TIMEOUT_MS = 240_000;
/** A PNG this small is not a rendered page. The old probe's own floor, kept: existence and size are the
 *  evidence, and judging the pixels is the reader's job. */
const MIN_SHOT_BYTES = 2_000;

interface Media {
	id: string;
	title: string;
	source: string;
}
interface StatsBody {
	library: { ready: number; catalog: number };
	sings: { total: number; window: number; distinctSongs: number };
	topSongs: { mediaId: string; plays: number; title: string }[];
	perDay: { day: string; plays: number }[];
}
interface MetricsBody {
	sample: { attempts: number; processes: number };
	steps: { step: string; n: number; meanMs: number | null; meanQueueWaitMs: number | null }[];
	e2e: { n: number };
	stages: { stage: string; meanMs: number | null }[];
	models: {
		engine: string | null;
		model: string | null;
		n: number;
		meanRtFactor: number | null;
		declared?: unknown;
		ratioToDeclared: number | null;
	}[];
	slowestProcesses: { processingId: string; mediaId: string }[];
	workers: { workerId: string; capabilities: string[] }[];
}
interface AuditAttempt {
	jobType: string;
	attempt: number;
	outcome: string | null;
	error: string | null;
	queueWaitMs: number | null;
	processingMs: number | null;
}
interface AuditBody {
	processes: { processingId: string; outcome: string; attempts: AuditAttempt[] }[];
}

// ── the wire ─────────────────────────────────────────────────────────────────────────────────────────────

/** /api/stats, /api/metrics and /api/audit/<id> are UNAUTHENTICATED by design, so the test process reads them
 *  directly — which is also exactly the no-cookie request the posture test below is about. */
async function jget<T>(baseURL: string, path: string): Promise<T> {
	const res = await fetch(`${baseURL}${path}`);
	if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
	return (await res.json()) as T;
}

/** `/api/process` refuses an anonymous caller, so it rides the phone's own session. */
async function requestProcess(page: Page, mediaId: string): Promise<void> {
	const res = await page.request.post('/api/process', { data: { mediaId } });
	if (!res.ok()) throw new Error(`/api/process refused ${mediaId}: ${res.status()} ${await res.text()}`);
}

/**
 * The row whose title NAMES the query. Never `.first()` on a bare action selector: the find box is debounced,
 * so the previous query's rows are still on screen when the new query is typed. A blind first-click there adds
 * the WRONG song, which lands as a dashboard that counts two distinct songs where three were queued.
 */
function rowFor(page: Page, query: string) {
	return page.locator(SEL.songRow).filter({ hasText: query }).first();
}

interface StatusWatch {
	frames: { status: string; pct: number }[];
	transitions(): string;
	close(): void;
}

/** Every `media:status` frame for one media. The drive below steps on these, not on durations. */
async function watchStatus(baseURL: string, mediaId: string): Promise<StatusWatch> {
	const frames: { status: string; pct: number }[] = [];
	const ws = new WebSocket(`${baseURL.replace(/^http/, 'ws')}/ws?role=phone`);
	await new Promise<void>((resolve, reject) => {
		ws.once('open', () => resolve());
		ws.once('error', (err) => reject(new Error(`media:status socket refused: ${err.message}`)));
	});
	ws.on('message', (raw: Buffer | string) => {
		try {
			const m = JSON.parse(String(raw)) as { type?: string; mediaId?: string; status?: string; pct?: number };
			if (m.type === 'media:status' && m.mediaId === mediaId) {
				frames.push({ status: String(m.status), pct: m.pct ?? 0 });
			}
		} catch {
			// a frame this drive is not about
		}
	});
	return {
		frames,
		transitions: () => frames.map((f) => `${f.status}@${f.pct}%`).join(' → ') || '(none)',
		close: () => ws.close()
	};
}

/**
 * Every DISTINCT `currentEntryId` the room has broadcast, in order. This is the exact quantity the PlayTracker
 * keys on — it dedupes on entryId and fires once per fresh current entry — so counting these counts the play
 * rows about to exist, which is what lets the drive below step on a condition rather than on a duration.
 */
async function watchNowPlaying(baseURL: string): Promise<{ entryIds: string[]; close: () => void }> {
	const entryIds: string[] = [];
	const ws = new WebSocket(`${baseURL.replace(/^http/, 'ws')}/ws?role=phone`);
	await new Promise<void>((resolve, reject) => {
		ws.once('open', () => resolve());
		ws.once('error', (err) => reject(new Error(`nowplaying socket refused: ${err.message}`)));
	});
	ws.on('message', (raw: Buffer | string) => {
		try {
			const m = JSON.parse(String(raw)) as { type?: string; current?: { id?: string } | null };
			if (m.type !== 'nowplaying:changed') return;
			const id = m.current?.id;
			if (id && !entryIds.includes(id)) entryIds.push(id);
		} catch {
			// a frame this drive is not about
		}
	});
	return { entryIds, close: () => ws.close() };
}

/** A worker is only usable once the HUB has it, and /api/metrics.workers is the hub's own answer. */
async function awaitRegistered(baseURL: string, workerId: string): Promise<void> {
	await expect
		.poll(async () => (await jget<MetricsBody>(baseURL, '/api/metrics')).workers.some((w) => w.workerId === workerId), {
			timeout: 15_000,
			message: `worker ${workerId} never appeared in /api/metrics.workers, so nothing would be dispatched to it`
		})
		.toBe(true);
}

async function awaitFrame(
	watch: StatusWatch,
	match: (f: { status: string; pct: number }) => boolean,
	timeout: number,
	label: string
) {
	await expect
		.poll(() => watch.frames.some(match), {
			timeout,
			message: `${label}: no matching media:status frame; saw [${watch.transitions()}]`
		})
		.toBe(true);
}

// ── the drive ────────────────────────────────────────────────────────────────────────────────────────────

interface Driven {
	caroline: Media;
	dontstop: Media;
	bohemian: Media;
	prayer: Media;
}

/**
 * Four processes, in the four shapes a real server produces:
 *   caroline, dontstop — happy path, 2 attempts each (stems, align)
 *   bohemian           — one FAILED stems attempt, `fail: 'stems'` being retryable:false and so terminal
 *   prayer             — RETRIED: a worker lost mid-stems, the 30s progress lease expires, the reaper requeues
 *                        and a replacement finishes the chain
 *
 * WORKERS ARE STOPPED BETWEEN STEPS on purpose: leave the happy worker connected and dispatch races the failing
 * one into a job it was never asked to fail.
 */
async function driveFourProcesses(world: World, phone: Page): Promise<Driven> {
	// awaitDemoTrack, not a bare search: the library scan is a DETACHED boot pass, so /health answers before the
	// index exists and an early read returns an empty library that nothing re-runs. Resolving an id also
	// MATERIALISES it into mediaById, which every later step needs.
	const caroline = await world.awaitDemoTrack('caroline');
	const dontstop = await world.awaitDemoTrack('believin');
	const bohemian = await world.awaitDemoTrack('bohemian');
	const prayer = await world.awaitDemoTrack('prayer');

	// 1 — two normal processes: the play log's content, and the happy-path audit reference.
	const normal = await startFakeWorker(world, { workerId: 'normal-1', slowMs: 100 });
	await awaitRegistered(world.baseURL, 'normal-1');
	for (const media of [caroline, dontstop]) {
		const watch = await watchStatus(world.baseURL, media.id);
		try {
			await requestProcess(phone, media.id);
			await awaitFrame(watch, (f) => f.status === 'ready', 30_000, `${media.title} ready`);
		} finally {
			watch.close();
		}
	}
	await normal.stop();

	// 2 — one FAILED process.
	const failer = await startFakeWorker(world, { workerId: 'fail-stems-2', fail: 'stems', slowMs: 100 });
	await awaitRegistered(world.baseURL, 'fail-stems-2');
	const failWatch = await watchStatus(world.baseURL, bohemian.id);
	try {
		await requestProcess(phone, bohemian.id);
		await awaitFrame(failWatch, (f) => f.status === 'failed' || f.status === 'ready', 30_000, 'bohemian terminal');
	} finally {
		failWatch.close();
	}
	await failer.stop();

	// 3 — one RETRIED process. `slowMs: 45000` parks the job inside `separating` so it is genuinely RUNNING when
	// the worker is lost: lose it during `downloading` and the only lease is the ACK lease, which reaps in 10s
	// without bumping attempts or writing an `abandoned` row, so there would be no retry to observe at all.
	const doomed = await startFakeWorker(world, { workerId: 'doomed-3', slowMs: 45_000 });
	await awaitRegistered(world.baseURL, 'doomed-3');
	const prayerWatch = await watchStatus(world.baseURL, prayer.id);
	try {
		await requestProcess(phone, prayer.id);
		await awaitFrame(prayerWatch, (f) => f.status === 'separating', 45_000, 'prayer separating');
		// Closing the socket is what WorkerRegistry.remove is FOR: "Drop a worker (WS close). Its jobs are
		// reclaimed by the reaper via lease expiry." No shortcut — the 30s lease still has to expire.
		await doomed.stop();
		// The replacement comes up NOW so it can take the requeue the instant the lease does expire.
		const rescue = await startFakeWorker(world, { workerId: 'rescue-3', slowMs: 100 });
		await awaitRegistered(world.baseURL, 'rescue-3');
		// 30s progress lease + 3s reaper tick + the retry, its follow-up align and the broadcast.
		await awaitFrame(
			prayerWatch,
			(f) => f.status === 'ready' || f.status === 'failed',
			90_000,
			'prayer terminal after the retry'
		);
		await rescue.stop();
	} finally {
		prayerWatch.close();
	}

	return { caroline, dontstop, bohemian, prayer };
}

/**
 * caroline, dontstop, caroline, prayer — FOUR plays over THREE distinct songs, which forces apart the two
 * /stats tiles that would otherwise blur together. The repeat needs a SECOND singer: `inMyQueue` disables the
 * add control on a song this phone already has queued, which is the product behaving correctly.
 *
 * EVERY STEP IS A REAL TAP, where the old probe hand-wrote `queue:command` and `player:command` frames onto an
 * authed socket. That buys the thing those frames could not express: the FIRST turn into an idle room starts
 * PLAYING on its own, so `play` is never pressed here and the first `nowplaying:changed` — and therefore the
 * first durable play row — comes from the add itself. The remaining three are reached by skipping.
 *
 * The PlayTracker dedupes on entryId and fires once per fresh currentEntryId, so four entries over three medias
 * is four plays.
 */
async function driveFourPlays(world: World, phoneA: Page): Promise<number> {
	// Subscribed BEFORE the first add, because the first add is already the first play.
	const nowPlaying = await watchNowPlaying(world.baseURL);
	const phoneB = await world.openPhone('P11-B');
	for (const [page, query] of [
		[phoneA, 'caroline'],
		[phoneA, 'believin'],
		[phoneA, 'prayer'],
		[phoneB, 'caroline']
	] as const) {
		await openBrowseFromHome(page);
		await page.locator(SEL.search).fill(query);
		const add = rowFor(page, query).locator(SEL.addAction);
		await expect(add, `no enabled add control on the row named "${query}"`).toBeEnabled();
		await add.click();
		// EITHER signal counts, because which one arrives depends on whether the room was idle: `inQueue` is
		// `queued.some(…)` and a turn that starts PLAYING immediately leaves `queued`, so the control re-enables
		// and the band names the song instead.
		await expect
			.poll(
				async () => {
					if (await add.isDisabled()) return true;
					const band = (await page.locator(SEL.bandTitle).first().textContent()) ?? '';
					return band.toLowerCase().includes(query);
				},
				{ message: `the phone never acknowledged the turn on "${query}" — no queued row and the band never named it` }
			)
			.toBe(true);
	}

	// The rotation is the ROOM's, so either phone sees every turn. Asserted as scaffolding — a lost add would
	// otherwise surface as a dashboard that counts wrong — and THREE, not four: a playing entry renders no
	// `.qrow` at all, and the first of the four is already playing.
	await openBrowseFromHome(phoneA);
	await phoneA.locator(SEL.clearSearch).click();
	await expect(
		phoneA.locator(SEL.bandTitle).first(),
		'the first turn into an idle room must already be playing, or there is no first play to count'
	).not.toHaveText(/Nothing playing/);
	await expect(
		phoneA.locator(SEL.queueRow),
		'one turn playing and three waiting is the settled state after four adds'
	).toHaveCount(3);

	// `SEL.skip` is a ROLE + accessible name, not a CSS selector: the transport is addressed the way a screen
	// reader sees it, and all three controls are in the band row at both sheet heights.
	//
	// WAITING ON A NEW currentEntryId, not on the rotation shrinking: a SKIPPED turn is recycled to the back of
	// the rotation rather than dropped, so the waiting count is 3 before and after every skip. The play row is
	// written off `nowplaying:changed`, and that frame's entry id is both the settled signal and the thing being
	// counted. The old probe slept 400ms per step and hoped.
	const skip = phoneA.getByRole(SEL.skip.role, { name: SEL.skip.name }).first();
	for (const nth of [2, 3, 4]) {
		await skip.click();
		await expect
			.poll(() => nowPlaying.entryIds.length, {
				message:
					`skip ${nth - 1} did not move the room onto a new turn, so there are fewer than ${nth} plays to ` +
					`count. distinct currentEntryIds so far: ${JSON.stringify(nowPlaying.entryIds)}`
			})
			.toBeGreaterThanOrEqual(nth);
	}
	nowPlaying.close();
	return nowPlaying.entryIds.length;
}

/** Read /api/stats until two consecutive reads agree on the play total — a STABILITY condition, deliberately
 *  not the expected value, so the assertions below stay falsifiable. */
async function settledStats(baseURL: string): Promise<StatsBody> {
	let previous = -1;
	for (let i = 0; i < 12; i++) {
		const stats = await jget<StatsBody>(baseURL, '/api/stats');
		if (stats.sings.total === previous) return stats;
		previous = stats.sings.total;
		await new Promise((r) => setTimeout(r, 400));
	}
	return jget<StatsBody>(baseURL, '/api/stats');
}

// ── shots ────────────────────────────────────────────────────────────────────────────────────────────────

/** The old probe's two widths: a phone, and a desktop wide enough for the tables not to scroll. */
const SHOT_SIZES: { label: string; width: number; height: number }[] = [
	{ label: '390', width: 390, height: 900 },
	{ label: '1440', width: 1440, height: 900 }
];

/**
 * One dashboard at one width, written into the test's output dir and attached for a reader. The wait is on the
 * page's OWN data having arrived — a card exists only once the fetch landed — plus webfonts, where the old
 * probe's `sleep(600)` was a guess at both.
 */
async function shoot(
	page: Page,
	url: string,
	name: string,
	size: (typeof SHOT_SIZES)[number],
	testInfo: import('@playwright/test').TestInfo
): Promise<void> {
	await page.setViewportSize({ width: size.width, height: size.height });
	await page.goto(url);
	await expect(page.locator(SEL.pageHeading).first()).toBeVisible();
	await expect(page.locator(SEL.dashCard).first()).toBeVisible();
	await page.evaluate(() => document.fonts.ready.then(() => true));
	const file = `${name}-${size.label}.png`;
	const path = testInfo.outputPath(file);
	const png = await page.screenshot({ path, fullPage: true });
	await testInfo.attach(file, { path, contentType: 'image/png' });
	expect(
		png.byteLength,
		`${file} came out suspiciously small: ${png.byteLength} bytes for ${url} at ${size.width}px`
	).toBeGreaterThan(MIN_SHOT_BYTES);
}

// ── 1 · every number on the three dashboards, against one drive ──────────────────────────────────────────

test('the dashboards agree with a drive of four processes and four plays', async ({ world, page }, testInfo) => {
	test.setTimeout(DRIVE_TIMEOUT_MS);
	const phone = await world.openPhone('P11-A');
	const { caroline, dontstop, bohemian, prayer } = await driveFourProcesses(world, phone);
	const distinctTurnsPlayed = await driveFourPlays(world, phone);
	expect(
		distinctTurnsPlayed,
		'four distinct turns must have become the current entry, or there are not four plays to count'
	).toBe(4);

	const stats = await settledStats(world.baseURL);
	const metrics = await jget<MetricsBody>(world.baseURL, '/api/metrics');
	const audit = {
		caroline: await jget<AuditBody>(world.baseURL, `/api/audit/${caroline.id}`),
		dontstop: await jget<AuditBody>(world.baseURL, `/api/audit/${dontstop.id}`),
		bohemian: await jget<AuditBody>(world.baseURL, `/api/audit/${bohemian.id}`),
		prayer: await jget<AuditBody>(world.baseURL, `/api/audit/${prayer.id}`)
	};

	// (1) the library size, the play total and the distinct-song count. We processed 4 songs — 3 succeeded and 1
	// failed — so library.ready must be 3; we queued 4 entries across 3 distinct medias and the PlayTracker
	// dedupes on entryId, so total plays must be 4.
	expect(
		{
			libraryReady: stats.library.ready,
			total: stats.sings.total,
			distinct: stats.sings.distinctSongs,
			window: stats.sings.window
		},
		`/api/stats must agree with what actually happened. See src/routes/api/stats/+server.ts (library.ready ` +
			`reads listReady, sings.* read PlayLog) and src/lib/server/media/plays.ts PlayTracker, which dedupes on ` +
			`entryId and fires once per fresh currentEntryId.`
	).toEqual({ libraryReady: 3, total: 4, distinct: 3, window: 4 });

	// A raw NaN or Infinity in a public aggregate is a rendering hazard on its own.
	const nonFinite =
		Object.values(stats.sings).some((v) => typeof v === 'number' && !Number.isFinite(v)) ||
		stats.topSongs.some((s) => typeof s.plays !== 'number' || !Number.isFinite(s.plays)) ||
		stats.perDay.some((d) => typeof d.plays !== 'number' || !Number.isFinite(d.plays));
	expect(
		nonFinite,
		`/api/stats carries a non-finite number, which renders at the top of /stats: ` +
			`sings=${JSON.stringify(stats.sings)} topSongs=${JSON.stringify(stats.topSongs)} ` +
			`perDay=${JSON.stringify(stats.perDay)}`
	).toBe(false);

	// (2) per-song plays. caroline=2 then dontstop=1 and prayer=1 TIED, and tie order is
	// implementation-defined — so the SET is asserted, never the order.
	const bySong = new Map(stats.topSongs.map((s) => [s.mediaId, s.plays]));
	expect(
		{
			caroline: bySong.get(caroline.id) ?? 0,
			dontstop: bySong.get(dontstop.id) ?? 0,
			prayer: bySong.get(prayer.id) ?? 0
		},
		`/api/stats topSongs must match the entry log — one song played through two distinct entries counts as ` +
			`two plays. topSongs=${JSON.stringify(stats.topSongs)}`
	).toEqual({ caroline: 2, dontstop: 1, prayer: 1 });

	// The trend line: exactly one bar today holding all four plays. The log has NO zero-fill — an absent day
	// means "we cannot tell if it was quiet or the server was off" — so a fresh install shows one bar and
	// honest copy. See src/lib/server/media/play-log.ts perDay and /stats' own footnote.
	const today = new Date().toISOString().slice(0, 10);
	expect(
		stats.perDay,
		`the /stats trend line must be exactly one bar today with 4 plays. ` +
			`perDay=${JSON.stringify(stats.perDay)}, today=${today}`
	).toEqual([{ day: today, plays: 4 }]);

	// (3) queue wait beside — and separate from — processing time. The claim is that the two are distinct
	// COLUMNS, not that one is larger: on a single-worker box with cheap work they can legitimately be close.
	const oneAttempt = audit.caroline.processes[0]?.attempts?.[0];
	expect(
		metrics.steps.length > 0 &&
			metrics.steps.every((s) => typeof s.meanMs === 'number' && typeof s.meanQueueWaitMs === 'number'),
		`every step row must carry meanMs (work) and meanQueueWaitMs (wait) as distinct populated fields. ` +
			`steps=${JSON.stringify(metrics.steps)}`
	).toBe(true);
	expect(
		!!oneAttempt && typeof oneAttempt.queueWaitMs === 'number' && typeof oneAttempt.processingMs === 'number',
		`each audited attempt must carry queueWaitMs and processingMs separately. example=${JSON.stringify(oneAttempt)}`
	).toBe(true);

	// (4) a LOCAL-source process enqueues NO fetch step, which every attempt count below depends on:
	// `needsFetch(media.source)` is false for source:'local', so the process starts at the stems step and saves
	// a redundant download of a file that already exists.
	const typesOf = (a: AuditBody): Record<string, string[]> => {
		const byType: Record<string, string[]> = {};
		for (const att of a.processes[0]?.attempts ?? []) (byType[att.jobType] ??= []).push(String(att.outcome));
		return byType;
	};
	const shapes = {
		caroline: typesOf(audit.caroline),
		dontstop: typesOf(audit.dontstop),
		bohemian: typesOf(audit.bohemian),
		prayer: typesOf(audit.prayer)
	};
	expect(
		Object.values(shapes).some((s) => 'fetch' in s),
		`a fetch step ran for a LOCAL-source process. byType=${JSON.stringify(shapes)}. See ` +
			`src/lib/server/jobs/process.ts, which branches on needsFetch(media.source) and starts a local process ` +
			`directly at the stems step.`
	).toBe(false);

	// (5) the happy path: 1 process, 2 attempts, every outcome ready.
	expect(
		{
			caroline: { outcome: audit.caroline.processes[0]?.outcome, byType: shapes.caroline },
			dontstop: { outcome: audit.dontstop.processes[0]?.outcome, byType: shapes.dontstop }
		},
		'the audit must show 2 attempts per happy-path LOCAL process, all outcomes ready'
	).toEqual({
		caroline: { outcome: 'ready', byType: { stems: ['ready'], align: ['ready'] } },
		dontstop: { outcome: 'ready', byType: { stems: ['ready'], align: ['ready'] } }
	});

	// (6) the FAILED process: one attempt, outcome failed, and the terminal error STRING — an empty message
	// silently drops the reason the operator opened the audit page for.
	const stemsFailed = audit.bohemian.processes[0]?.attempts?.find((a) => a.jobType === 'stems');
	expect(
		{ outcome: audit.bohemian.processes[0]?.outcome, byType: shapes.bohemian },
		'the audit must record a FAILED process with its per-attempt outcome'
	).toEqual({ outcome: 'failed', byType: { stems: ['failed'] } });
	expect(
		typeof stemsFailed?.error === 'string' && stemsFailed.error.length > 0,
		`the failed attempt must carry a terminal error string. error=${JSON.stringify(stemsFailed?.error)}`
	).toBe(true);

	// (7) the RETRIED process: the abandoned attempt is preserved as its OWN row, and the retry is attempt 2 —
	// AttemptLedger.open is 1-based.
	const prayerStems = (audit.prayer.processes[0]?.attempts ?? []).filter((a) => a.jobType === 'stems');
	const outcomes = prayerStems.map((a) => String(a.outcome));
	const attemptNumbers = prayerStems.map((a) => a.attempt);
	expect(
		audit.prayer.processes[0]?.outcome === 'ready' &&
			(audit.prayer.processes[0]?.attempts.length ?? 0) === 3 &&
			outcomes.includes('abandoned') &&
			outcomes.includes('ready') &&
			attemptNumbers.includes(2),
		`the audit must record the RETRIED process with the abandoned attempt kept as its own row and the retry ` +
			`numbered 2. outcome=${audit.prayer.processes[0]?.outcome}, ` +
			`attempts=${audit.prayer.processes[0]?.attempts.length}, stems outcomes=[${outcomes.join(', ')}], ` +
			`attempt numbers=[${attemptNumbers.join(', ')}]`
	).toBe(true);

	// (8) the three per-song audit pages, at both widths, as evidence for a reader. These are the frames the
	// `shot` project cannot produce: they need exactly this drive's data behind them.
	for (const [name, media] of [
		['audit-caroline', caroline],
		['audit-prayer-retried', prayer],
		['audit-bohemian-failed', bohemian]
	] as const) {
		for (const size of SHOT_SIZES) await shoot(page, `/metrics/${media.id}`, name, size, testInfo);
	}
});

// ── 2 · metrics and audit must agree on which processes completed ────────────────────────────────────────

// KNOWN LIVE DEFECT, annotated rather than weakened. The two surfaces disagree on what a retried process IS:
// audit's processOutcome ignores 'abandoned' and reads 'ready', while metrics' perProcess needs EVERY attempt
// 'ready' — `complete = sealed.length === list.length && sealed.every(a => a.outcome === 'ready')` — so one
// abandoned attempt makes complete false. The audit page reports the song as done; the operator dashboard
// silently drops it from every average and from the top-10 list, biasing the fleet's reported end-to-end
// downward and omitting exactly the retried outliers a person opened the page to find.
// REMOVE THE ANNOTATION once perProcess counts a retried-then-completed process as complete.
test.fail(
	'metrics and audit agree on which processes completed, including retried ones',
	{
		annotation: {
			type: 'known-defect',
			description:
				"metrics' perProcess requires every attempt to be 'ready', so a retried process is dropped from " +
				"slowestProcesses and e2e while audit's processOutcome reports it 'ready'."
		}
	},
	async ({ world }) => {
		test.setTimeout(DRIVE_TIMEOUT_MS);
		const phone = await world.openPhone('P11-agree');
		const { caroline, dontstop, prayer } = await driveFourProcesses(world, phone);

		const metrics = await jget<MetricsBody>(world.baseURL, '/api/metrics');
		const ids = new Set(metrics.slowestProcesses.map((c) => c.processingId));
		const idOf = async (media: Media): Promise<string | undefined> =>
			(await jget<AuditBody>(world.baseURL, `/api/audit/${media.id}`)).processes[0]?.processingId;
		const carolineId = await idOf(caroline);
		const dontstopId = await idOf(dontstop);
		const prayerId = await idOf(prayer);

		expect(
			{
				caroline: ids.has(String(carolineId)),
				dontstop: ids.has(String(dontstopId)),
				prayer: ids.has(String(prayerId))
			},
			`the retried process (prayer, processingId=${prayerId}) completed successfully after one abandoned ` +
				`attempt, so it must be counted alongside the two happy-path ones. ` +
				`slowestProcesses=[${[...ids].join(', ')}] (${ids.size} processes), /api/metrics.e2e.n=${metrics.e2e.n} ` +
				`(expected 3). See src/lib/server/jobs/metrics.ts perProcess and ` +
				`src/routes/api/audit/[mediaId]/audit-shape.ts processOutcome, which ignores "abandoned".`
		).toEqual({ caroline: true, dontstop: true, prayer: true });
	}
);

// ── 3 · /metrics speaks to an operator ───────────────────────────────────────────────────────────────────

test('/metrics uses operator vocabulary and right-aligns its numeric columns', async ({ world, page }, testInfo) => {
	// ONE PASS over one rendered page: alignment and vocabulary are both decidable off the DOM without an image,
	// which is what a person judges from the screenshot anyway.
	//
	// A REAL ATTEMPT LEDGER, cheaply: one completed process is enough for all three tables to have rows. Without
	// a worker /api/metrics returns empty rollups and every scan below passes against nothing.
	const worker = await startFakeWorker(world, { slowMs: 100 });
	try {
		const phone = await world.openPhone('P11-vocab');
		const caroline = await world.awaitDemoTrack('caroline');
		const watch = await watchStatus(world.baseURL, caroline.id);
		try {
			await requestProcess(phone, caroline.id);
			await awaitFrame(watch, (f) => f.status === 'ready', 30_000, 'caroline ready');
		} finally {
			watch.close();
		}
		const metrics = await jget<MetricsBody>(world.baseURL, '/api/metrics');
		expect(metrics.steps.length, 'the steps rollup is empty, so the tables below would render no rows').toBeGreaterThan(
			0
		);

		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto('/metrics');
		await expect(page.locator(SEL.dashCard).first()).toBeVisible();

		const reading = await page.evaluate(
			({ dashCard, dashCardTable }) => {
				const cards = [...document.querySelectorAll(dashCard)];
				const staged = cards.find((c) => c.querySelector('h2')?.textContent?.trim() === 'Where the time goes');
				const headers = [...document.querySelectorAll('table th')];
				return {
					body: document.body.textContent ?? '',
					inTables: [...document.querySelectorAll(dashCardTable)].map((t) => t.textContent).join('\n'),
					stageLabels: staged?.textContent ?? '',
					headerCount: headers.length,
					headerTexts: headers.map((th) => (th.textContent ?? '').trim()),
					rightAligned: headers.filter((th) => getComputedStyle(th).textAlign === 'right').length
				};
			},
			{ dashCard: SEL.dashCard, dashCardTable: SEL.dashCardTable }
		);

		const leaksPercentiles = /\bp50\b|\bp95\b/.test(reading.body);
		const leaksStepInTables = /\bfetch\b|\balign\b|\bseparating\b|\baligning\b/.test(reading.inTables);
		// STAGE_LABELS maps only downloading/separating/aligning, so any other stage token falls through to its
		// raw name on the chart.
		const leaksStageInBar = /\bseparate\b|\balign\b/.test(reading.stageLabels);
		const speaksHuman = /remove vocals|time lyrics|typical|worst/i.test(reading.body);

		expect(
			leaksPercentiles,
			`/metrics must not leak internal percentile names into a user-facing surface. ` +
				`headers=${JSON.stringify(reading.headerTexts)}`
		).toBe(false);
		// The step and stage TABLES must render user-facing labels; the WORKERS panel shows raw capability
		// strings BY DESIGN, so only the tables' text is scanned. See src/lib/metrics-format.ts STEP_LABELS.
		expect(
			leaksStepInTables,
			`/metrics tables must not show raw job-type names. tables=${reading.inTables.slice(0, 400)}`
		).toBe(false);
		// EITHER branch the old probe accepted: human wording, OR the bar labels reading "separate"/"align",
		// which is a HARNESS ARTEFACT and not a UI defect — the fake worker emits short stage tokens in its
		// job:complete `stages` array while the real Python worker uses the long forms STAGE_LABELS is keyed on
		// (worker/encore_worker/protocol/vocabulary.py), so a real process renders "removing vocals" / "timing lyrics" as intended.
		expect(
			leaksStageInBar || speaksHuman,
			`/metrics must speak human: neither "typical"/"worst"/"remove vocals" in the body nor the known ` +
				`harness-artefact bar labels were found. stageLabels=${reading.stageLabels.slice(0, 200)}`
		).toBe(true);

		// Column 0 of each table is the name column and is left-aligned; on each of the three tables every other
		// column should be right, so a reader can run an eye down a column and compare.
		const shouldBeRight = Math.max(0, reading.headerCount - 3);
		expect(
			reading.rightAligned,
			`/metrics numeric column alignment is broken — a scan-down comparison is not possible. ` +
				`right-aligned=${reading.rightAligned}, total th=${reading.headerCount}, ` +
				`name columns subtracted=3 (one per table)`
		).toBeGreaterThanOrEqual(shouldBeRight);

		for (const size of SHOT_SIZES) await shoot(page, '/metrics', 'metrics', size, testInfo);
	} finally {
		await worker.stop();
	}
});

// ── 4 · cost per model, and how it degrades ──────────────────────────────────────────────────────────────

test('cost-per-model degrades correctly when the model has no declared rtFactor', async ({ world }) => {
	// fake-separator/e2e-tone is not in the separator allowlist, so separatorCost() returns undefined and both
	// `declared` and `ratioToDeclared` must be null/absent — and the row must SHIP anyway, so a reader can see
	// that a measurement WAS taken. /metrics renders "—" in the benchmark and vs columns for such a row.
	const worker = await startFakeWorker(world, { slowMs: 100 });
	try {
		const phone = await world.openPhone('P11-models');
		const caroline = await world.awaitDemoTrack('caroline');
		const watch = await watchStatus(world.baseURL, caroline.id);
		try {
			await requestProcess(phone, caroline.id);
			await awaitFrame(watch, (f) => f.status === 'ready', 30_000, 'caroline ready');
		} finally {
			watch.close();
		}

		const metrics = await jget<MetricsBody>(world.baseURL, '/api/metrics');
		const seen = metrics.models.map((m) => `${m.engine}/${m.model}`).join(', ') || '(none)';
		const fake = metrics.models.find((m) => m.engine === 'fake-separator' && m.model === 'e2e-tone');
		expect(
			!!fake,
			`/api/metrics.models is missing the fake-separator/e2e-tone row, which is the only per-model data on ` +
				`the box. Models seen: ${seen}`
		).toBe(true);
		expect(
			fake!.declared ?? null,
			`a declared cost was fabricated for a pair that is not in the allowlist. See ` +
				`src/lib/contract/lyrics/separators.ts separatorCost, which returns undefined for an unknown pair. ` +
				`Measured rtFactor on this box: ${fake!.meanRtFactor}`
		).toBe(null);
		expect(
			fake!.ratioToDeclared,
			`ratioToDeclared must be null when the declared cost is unknown. ratio=${fake!.ratioToDeclared}`
		).toBe(null);
	} finally {
		await worker.stop();
	}
});

// ── 5 · the documented security posture ──────────────────────────────────────────────────────────────────

test('/api/stats is aggregate-only — no singer identity in the payload', async ({ world }) => {
	// The play log has no singer column by construction, but the endpoint could still leak by growing a join,
	// so singer-ish keys are hunted for rather than assumed absent.
	const phone = await world.openPhone('P11-posture-a');
	// One real play, so the payload is not empty when it is searched.
	const worker = await startFakeWorker(world, { slowMs: 100 });
	try {
		const caroline = await world.awaitDemoTrack('caroline');
		const watch = await watchStatus(world.baseURL, caroline.id);
		try {
			await requestProcess(phone, caroline.id);
			await awaitFrame(watch, (f) => f.status === 'ready', 30_000, 'caroline ready');
		} finally {
			watch.close();
		}
		await openBrowseFromHome(phone);
		await phone.locator(SEL.search).fill('caroline');
		await rowFor(phone, 'caroline').locator(SEL.addAction).click();

		const dump = JSON.stringify(await jget<StatsBody>(world.baseURL, '/api/stats'));
		expect(
			/"(singer|singerId|displayName|color|sessionToken)"/i.test(dump),
			`/api/stats is documented aggregate-only (docs/ARCHITECTURE.md §10) and the plays table has no singer ` +
				`column. Payload: ${dump.slice(0, 300)}`
		).toBe(false);
	} finally {
		await worker.stop();
	}
});

test('/api/metrics and /api/audit are ungated, as documented', async ({ world }) => {
	// A no-cookie 200 is CORRECT here — both endpoints are unauthenticated deliberately and temporarily, and
	// what they expose (worker ids, model and backend names, host details, per-attempt terminal error strings)
	// is the finding worth recording rather than a bug to fix in the test. A 401/403 means either the header
	// comment in src/routes/api/metrics/+server.ts is now wrong or a real gate was added silently.
	const worker = await startFakeWorker(world, { slowMs: 100 });
	try {
		const phone = await world.openPhone('P11-posture-b');
		const caroline = await world.awaitDemoTrack('caroline');
		const watch = await watchStatus(world.baseURL, caroline.id);
		try {
			await requestProcess(phone, caroline.id);
			await awaitFrame(watch, (f) => f.status === 'ready', 30_000, 'caroline ready');
		} finally {
			watch.close();
		}

		// From the TEST PROCESS, which holds no session cookie of any kind.
		const metricsRes = await fetch(`${world.baseURL}/api/metrics`);
		const auditRes = await fetch(`${world.baseURL}/api/audit/${caroline.id}`);
		expect(
			{ metrics: metricsRes.status, audit: auditRes.status },
			`both endpoints must answer 200 without a cookie. See src/routes/api/metrics/+server.ts and ` +
				`src/routes/api/audit/[mediaId]/+server.ts — the decision recorded there is to bind the server to a ` +
				`trusted interface or add a token, not to gate these routes.`
		).toEqual({ metrics: 200, audit: 200 });

		// Named so the exposure is on the record, as the old probe's evidence lines were.
		const metricsBody = (await metricsRes.json()) as MetricsBody;
		const auditBody = (await auditRes.json()) as AuditBody;
		const errors = auditBody.processes.flatMap((p) => p.attempts.map((a) => a.error)).filter(Boolean);
		test.info().annotations.push({
			type: 'exposed-ungated',
			description:
				`worker ids ${JSON.stringify(metricsBody.workers.map((w) => w.workerId))}; ` +
				`model/backend names, host details; per-attempt error strings ${JSON.stringify(errors.slice(0, 2))}`
		});
	} finally {
		await worker.stop();
	}
});

// ── 6 · the /stats page against its own API ──────────────────────────────────────────────────────────────

test('the /stats page shows the same numbers /api/stats reports', async ({ world, page }, testInfo) => {
	// UI PARITY, not specific values: the claim is that the rendered tiles and the payload agree, so any drive
	// that produces a play is enough and the numbers themselves are the other tests' business.
	const worker = await startFakeWorker(world, { slowMs: 100 });
	try {
		const phone = await world.openPhone('P11-parity');
		const caroline = await world.awaitDemoTrack('caroline');
		const watch = await watchStatus(world.baseURL, caroline.id);
		try {
			await requestProcess(phone, caroline.id);
			await awaitFrame(watch, (f) => f.status === 'ready', 30_000, 'caroline ready');
		} finally {
			watch.close();
		}
		// One turn into an idle room starts playing on its own, which is the one play this parity check needs.
		await openBrowseFromHome(phone);
		await phone.locator(SEL.search).fill('caroline');
		await rowFor(phone, 'caroline').locator(SEL.addAction).click();
		await expect(phone.locator(SEL.bandTitle).first()).not.toHaveText(/Nothing playing/);

		const stats = await settledStats(world.baseURL);
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto('/stats');
		// The tiles exist only once the fetch has landed, so one of them IS the ready signal.
		await expect(page.locator(SEL.dashTileNumber).first()).toBeVisible();
		const tiles = await page.locator(SEL.dashTileNumber).allTextContents();

		// DOM order, from the /stats markup: songs sung, ready to sing, different songs.
		expect(
			{ total: Number(tiles[0]), ready: Number(tiles[1]), distinct: Number(tiles[2]) },
			`the /stats page must render the same numbers /api/stats reports. page tiles=${JSON.stringify(tiles)}, ` +
				`api=${JSON.stringify({ ...stats.sings, libraryReady: stats.library.ready })}`
		).toEqual({
			total: stats.sings.total,
			ready: stats.library.ready,
			distinct: stats.sings.distinctSongs
		});

		for (const size of SHOT_SIZES) await shoot(page, '/stats', 'stats', size, testInfo);
	} finally {
		await worker.stop();
	}
});
