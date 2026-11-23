// P11 — THE THREE READ-ONLY DASHBOARDS AGAINST REAL DATA: /stats + /api/stats (public, aggregate-only),
// /metrics + /api/metrics (the host's) and /metrics/<id> + /api/audit/<id>.
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
// /stats trend line, the "no fetch step for a LOCAL source" check, and the posture of /api/metrics and
// /api/audit — could fail without failing the probe. They hold today and are asserted here.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { TEST_HOST_KEY } from '../../world/core';
import { openBrowseFromHome, openQueue } from '../../world/actors';
import type { World } from '../../world/fixtures';
import type { Page } from '@playwright/test';
import { SETTLE_MS } from '$lib/transport-target';
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

/** The test process reads the dashboards' JSON directly, as the host: /api/metrics and the /api/audit history
 *  are the host's, and /api/stats does not care. */
const hostCookies = new Map<string, string>();
async function hostCookie(baseURL: string): Promise<string> {
	const known = hostCookies.get(baseURL);
	if (known) return known;
	const res = await fetch(`${baseURL}/api/host`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ key: TEST_HOST_KEY })
	});
	if (!res.ok) throw new Error(`POST /api/host → ${res.status} ${await res.text()}`);
	const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
	hostCookies.set(baseURL, cookie);
	return cookie;
}
async function jget<T>(baseURL: string, path: string): Promise<T> {
	const res = await fetch(`${baseURL}${path}`, { headers: { cookie: await hostCookie(baseURL) } });
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
		// and the strip names the song instead.
		await expect
			.poll(
				async () => {
					if (await add.isDisabled()) return true;
					const strip = (await page.locator(SEL.npStripTitle).first().textContent()) ?? '';
					return strip.toLowerCase().includes(query);
				},
				{ message: `the phone never acknowledged the turn on "${query}" — no queued row and the strip never named it` }
			)
			.toBe(true);
	}

	// The rotation is the ROOM's, so either phone sees every turn. Asserted as scaffolding — a lost add would
	// otherwise surface as a dashboard that counts wrong — and THREE, not four: a playing entry renders no
	// `.qrow` at all, and the first of the four is already playing.
	await openBrowseFromHome(phoneA);
	await phoneA.locator(SEL.clearSearch).click();
	// ASSERTED POSITIVELY, where this used to read `.not.toHaveText(/Nothing playing/)`. That string was the old
	// band's permanent idle copy; the strip has no idle copy at all, because it does not render without something
	// to play — so the negative was vacuous and the PRESENCE of the title element is now the whole claim. Read from
	// `/`, because the strip is chrome on every phone surface.
	await expect(
		phoneA.locator(SEL.npStripTitle),
		'the first turn into an idle room must already be playing, or there is no first play to count'
	).toHaveCount(1);
	// ON /queue, AND THAT IS A ROUTE CHANGE RATHER THAN A SELECTOR SWAP. `/` used to render a Queued section; it is
	// the Sing tab now and renders no `.qrow` at all, so this count was 0 wherever it was asserted from. The queue
	// is its own tab.
	await openQueue(phoneA);
	await expect(
		phoneA.locator(SEL.queueRow),
		'one turn playing and three waiting is the settled state after four adds'
	).toHaveCount(3);

	// `SEL.skip` is a ROLE + accessible name, not a CSS selector: the transport is addressed the way a screen
	// reader sees it, and all three controls are in the dock, on every phone surface.
	//
	// WAITING ON A NEW currentEntryId, not on the rotation shrinking: a SKIPPED turn is recycled to the back of
	// the rotation rather than dropped, so the waiting count is 3 before and after every skip. The play row is
	// written off `nowplaying:changed`, and that frame's entry id is both the settled signal and the thing being
	// counted. The old probe slept 400ms per step and hoped.
	const skip = phoneA.getByRole(SEL.skip.role, { name: SEL.skip.name }).first();
	for (const nth of [2, 3, 4]) {
		/* PAST THE STRIP'S SETTLE WINDOW (`$lib/transport-target`): for SETTLE_MS after the song on the strip
		   changes, its skip still names the song before, so the server drops a back-to-back skip as stale — by
		   design, a double tap takes one song. A deliberate skip of each new turn waits it out; the margin covers the
		   phone hearing the change a little after this probe's socket did. */
		if (nth > 2) await phoneA.waitForTimeout(SETTLE_MS + 250);
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

// The `page` that opens /metrics is the host's: the operator pages send anyone else to /host.
test.beforeEach(async ({ world, page }) => {
	await world.becomeHost(page);
});

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

// A retried song is done on both surfaces: perProcess reads each job's LAST attempt (`pickReachedReady`), as
// audit's processOutcome does, so an abandoned attempt no longer drops it from e2e and the top-10 list.
test('metrics and audit agree on which processes completed, including retried ones', async ({ world }) => {
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
});

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
					tableCount: document.querySelectorAll('table').length,
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

		// Column 0 of each table is the name column and is left-aligned; on every table every other column should
		// be right, so a reader can run an eye down a column and compare.
		const shouldBeRight = Math.max(0, reading.headerCount - reading.tableCount);
		expect(
			reading.rightAligned,
			`/metrics numeric column alignment is broken — a scan-down comparison is not possible. ` +
				`right-aligned=${reading.rightAligned}, total th=${reading.headerCount}, ` +
				`name columns subtracted=${reading.tableCount} (one per table)`
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

test('/api/metrics and the /api/audit history are the host only, and a guest phone is refused too', async ({
	world
}) => {
	// What they expose (worker ids, model and backend names, host details, per-attempt terminal error strings) is
	// the host's. A guest still gets the song's catalog row from /api/audit, because the song page reads it.
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

		// From the TEST PROCESS with no cookie, then from a JOINED GUEST's own session.
		for (const [who, get] of [
			['no cookie', (path: string) => fetch(`${world.baseURL}${path}`)],
			[
				'a guest phone',
				async (path: string) => {
					const r = await phone.request.get(path);
					return { status: r.status(), json: () => r.json() };
				}
			]
		] as const) {
			const metricsRes = await get('/api/metrics');
			expect(metricsRes.status, `${who}: /api/metrics — src/hooks.server.ts`).toBe(403);
			const audit = (await (await get(`/api/audit/${caroline.id}`)).json()) as Record<string, unknown>;
			expect(Object.keys(audit), `${who}: /api/audit — src/routes/api/audit/[mediaId]/+server.ts`).toEqual(['media']);
		}
		expect((await jget<AuditBody>(world.baseURL, `/api/audit/${caroline.id}`)).processes.length).toBeGreaterThan(0);
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
		// The song is known here, so the claim is the title itself rather than the absence of the old band's idle
		// copy ("Nothing playing"), which no longer exists anywhere to be absent.
		await expect(phone.locator(SEL.npStripTitle).first()).toHaveText(/caroline/i);

		const stats = await settledStats(world.baseURL);
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto('/stats');
		// /stats loads in `+page.ts`, so the tiles ship with the document: this waits out hydration rather than a
		// fetch, and is a positive ready signal either way.
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

// ── 7 · the dashboards' claims must be true at the moment they are read ──────────────────────────────────
//
// THESE FOUR STUB THE ENDPOINT instead of driving a worker, and that is the point: the subject is what the
// PAGE does with a payload, so the payload has to be chosen rather than earned. The drives above own the
// arithmetic; these own the wording and the liveness.

/** Every field the /metrics client reads, with nothing in it. Overridden per test — a partial literal would
 *  only prove the page tolerates a short payload, which the real endpoint never sends. */
function emptyMetricsBody(sample: Partial<MetricsSample> = {}, workers: unknown[] = []) {
	return {
		sample: { attempts: 0, total: 0, windowDays: 7, clipped: false, processes: 0, provisional: false, ...sample },
		speed: {
			n: 0,
			p50Multiple: null,
			p90Multiple: null,
			p50AudioSec: null,
			noLength: 0,
			badClock: 0,
			provisional: true
		},
		devices: [],
		failures: [],
		steps: [],
		e2e: { n: 0, meanMs: null, p50Ms: null, p95Ms: null },
		models: [],
		asr: [],
		stages: [],
		slowestProcesses: [],
		workers
	};
}
interface MetricsSample {
	attempts: number;
	total: number;
	windowDays: number;
	clipped: boolean;
	processes: number;
	provisional: boolean;
}

const NO_WORKER = /No worker connected/;

test('/metrics corrects its worker claim in both directions without being touched', async ({ world, page }) => {
	// The banner and the Workers card are PRESENT-TENSE claims. A single mount-time fetch froze both: measured
	// 1 request on mount and 0 over the next 8s, so the page said "no worker connected" through a worker's whole
	// life and kept listing a dead one after it stopped.
	expect(world.baseURL).toContain('http');
	let workers: unknown[] = [];
	let served = 0;
	await page.route('**/api/metrics', (route) => {
		served += 1;
		void route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(emptyMetricsBody({}, workers))
		});
	});

	await page.goto('/metrics');
	const banner = page.getByText(NO_WORKER);
	await expect(banner, 'with no worker in the payload /metrics must lead with the warning').toBeVisible();
	const afterMount = served;

	// Direction A — says dead while alive.
	workers = [{ workerId: 'probe-fake-1', capabilities: ['fetch', 'stems', 'align'], slotsFree: 1, host: null }];
	await expect(
		banner,
		'a worker connected and the page still claimed none was — the reading never refreshed'
	).toBeHidden();
	await expect(page.getByText('probe-fake-1')).toBeVisible();

	// Direction B — says alive while dead.
	workers = [];
	await expect(banner, 'the worker stopped and the page still listed it — the reading never refreshed').toBeVisible();
	await expect(page.getByText('probe-fake-1')).toHaveCount(0);

	expect(
		served,
		`/metrics served ${served} payloads in total but only ${afterMount} by mount — it must keep polling`
	).toBeGreaterThan(afterMount + 1);
});

test('/metrics keeps the last reading when a poll fails, and never blanks the page', async ({ world, page }) => {
	// A poll that misses is transient; swapping the whole page for "Could not load metrics." on one blip would
	// take an operator's screen away for seconds at a time. The HARD state is for having nothing at all.
	expect(world.baseURL).toContain('http');
	let mode: 'ok' | 'dead' = 'ok';
	await page.route('**/api/metrics', (route) => {
		if (mode === 'dead') return route.abort();
		void route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(emptyMetricsBody({ attempts: 12, processes: 3 }))
		});
	});

	await page.goto('/metrics');
	const headline = page.getByText('12 attempts in the last 7 days');
	await expect(headline).toBeVisible();

	mode = 'dead';
	await expect(page.getByText(/Couldn.t refresh/), 'a failed poll must say the reading is old').toBeVisible();
	await expect(headline, 'a failed poll must not discard the reading already on screen').toBeVisible();
	await expect(page.getByText('Could not load metrics.')).toHaveCount(0);

	mode = 'ok';
	await expect(page.getByText(/Couldn.t refresh/), 'a successful poll must clear the stale notice').toBeHidden();
});

test('/metrics names the window it counted and declares a partial sample', async ({ world, page }) => {
	// "0 runs across 0 songs" over an unnamed span reads as "nothing has ever been processed" while thousands of
	// attempts sit in the ledger; and when the server's row backstop bites, `attempts` IS the backstop rendered as
	// a measurement. `total`, `windowDays` and `clipped` are sent for exactly this and were dropped by the client.
	expect(world.baseURL).toContain('http');
	await page.route('**/api/metrics', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(
				emptyMetricsBody({ attempts: 2000, total: 4763, windowDays: 14, clipped: true, processes: 134 })
			)
		})
	);
	await page.goto('/metrics');

	const main = page.locator('main[aria-label="Processing metrics"]');
	await expect(main.locator('p.note[role="status"]')).toHaveText(
		'2000 attempts in the last 14 days, across 134 finished songs.'
	);
	const body = await main.innerText();
	expect(body, 'the page must say its sample is partial when the server flagged it clipped').toContain(
		'Partial sample: not every run in this window is counted.'
	);
	expect(body, 'the lifetime ledger size must be visibly separate from the window figure').toContain(
		'4763 attempts recorded in all, including before this window.'
	);
	// The lifetime count must never be read as the window's population.
	expect(body).not.toContain('4763 attempts in the last');
});

test('the per-song audit agrees with its own play count, separator and plural', async ({ world, page }) => {
	// Measured on a real one-play row: `3:36 long ·sung 1 times` — a missing space, because the separator's only
	// whitespace was the block's trailing newline, which Svelte trims; and a hardcoded "times".
	expect(world.baseURL).toContain('http');
	let plays: { at: number; entryId: string }[] = [];
	let media: unknown = { id: 'probe-media', title: 'A Song', durationSec: 216 };
	await page.route('**/api/audit/**', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ media, processes: [], plays, hasHistory: false })
		})
	);
	const note = page.locator('main p.note[role="status"]');

	for (const [n, expected] of [
		[1, '3:36 long · sung 1 time'],
		[3, '3:36 long · sung 3 times'],
		[0, '3:36 long · sung 0 times']
	] as const) {
		plays = Array.from({ length: n }, (_, i) => ({ at: 1_700_000_000_000 + i, entryId: `e${i}` }));
		await page.goto('/metrics/probe-media');
		await expect(note, `${n} plays must read "${expected}"`).toHaveText(expected);
	}

	// No media row — there is nothing to separate, so no leading separator may be printed.
	media = null;
	plays = [{ at: 1_700_000_000_000, entryId: 'e0' }];
	await page.goto('/metrics/probe-media');
	await expect(note).toHaveText('sung 1 time');
});

// ── 8 · /stats keeps the reader's place across a Back ────────────────────────────────────────────────────

test('/stats restores its scroll offset on Back, because it ships with the document', async ({ world, page }) => {
	// MECHANISM, not cosmetics. SvelteKit applies a restored scroll offset after `root.$set` plus two
	// `tick()`s — a DOM-COMMIT deadline, which an `onMount` fetch cannot beat. The document was therefore one
	// viewport tall at that moment and the offset clamped to 0: measured /stats restoring 0 where /library and
	// /settings (which has a server load) both restored 500 in the same session. A load function's data is
	// already in the navigation result at commit, so the page has its height before the restore runs.
	const html = await (await fetch(`${world.baseURL}/stats`)).text();
	expect(html, '/stats must ship its tiles in the HTML — with the fetch in onMount it shipped an empty page').toContain(
		'songs sung'
	);

	// THE DOCUMENTED DOOR: `/settings` is the one scope that links here, and the restore needs real history.
	await page.setViewportSize({ width: 390, height: 844 });
	await world.joinAs(page, 'P11-Scroll');
	await page.goto('/settings');
	await page.locator('a[href="/stats"]').click();
	await expect(page.locator(SEL.dashTileNumber).first()).toBeVisible();

	// Derived, not a literal 500: a virgin core's /stats is shorter than the owner's 135-song one, and a target
	// past the scrollable extent would clamp and make the claim vacuous either way.
	const extent = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
	const target = Math.min(500, extent);
	expect(target, `/stats must be scrollable for this claim to mean anything (extent ${extent}px)`).toBeGreaterThan(150);

	await page.evaluate((y) => window.scrollTo(0, y), target);
	await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(target);

	await page.locator(SEL.tab).nth(1).click();
	await expect(page).toHaveURL(/\/queue$/);
	await page.goBack();
	await expect
		.poll(() => page.evaluate(() => Math.round(window.scrollY)), {
			message: `Back into /stats must restore ${target}px; with the fetch in onMount the document was one viewport tall at restore time and the offset clamped to 0`
		})
		.toBe(target);
	// And it STAYS there: a reading that lands later cannot be what put it back.
	await page.waitForTimeout(1_000);
	expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(target);

	// The honesty branch survives the move. Driven on the CLIENT-SIDE leg on purpose: `page.route` cannot
	// intercept the server-side half of a universal load, so a cold goto would answer from the real endpoint.
	await page.route('**/api/stats*', (route) =>
		route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
	);
	await page.goto('/settings');
	await page.locator('a[href="/stats"]').click();
	await expect(page.getByText('Could not load stats.')).toBeVisible();
	await expect(page.locator(SEL.dashTileNumber), 'a failed load must say so rather than render zeros').toHaveCount(0);
});
