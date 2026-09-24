// @ts-check
/*
 * P11 — the three read-only dashboards against real data: /stats + /api/stats (public, aggregate-only),
 * /metrics + /api/metrics (internal, ungated), /metrics/<id> + /api/audit/<id>.
 *
 * It drives the shape a real server sees — several successful processes, one FAILED (FAKE_FAIL=stems), one
 * RETRIED and some PLAYS — then counts each thing ITSELF and compares.
 *
 *   PORT=5231 bun tests/e2e/probes/p11-dashboards.mjs      # port 5231 exclusively, never a collision
 *
 * Boot recipe: tests/e2e/HARNESS.md.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEL } from '../contract.ts';
import { findChromium } from '../lib/chromium.mjs';
import { repoRoot } from '../lib/repo-root.mjs';

/**
 * @typedef {Awaited<ReturnType<typeof import('../driver.mjs').connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'} Severity
 * @typedef {{ severity: Severity, title: string, detail?: string, evidence?: string[] }} Finding
 * @typedef {import('node:child_process').ChildProcess} Child
 * @typedef {{ mediaId: string, label: string, entryId?: string }} DriveEntry
 */

const PORT = Number(process.env.PORT ?? 5231);
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH = process.env.SCRATCH ?? join(process.env.KIROCREW_SCRATCH ?? '/tmp', `e2e-${PORT}`);
const MEDIA_DIR = join(SCRATCH, 'media');
const SHOTS_DIR = join(SCRATCH, 'shots');

/** @type {Finding[]} */
const findings = [];
/** @param {Severity} severity @param {string} title @param {string} [detail] @param {string[]} [evidence] */
function record(severity, title, detail, evidence = []) {
	findings.push({ severity, title, detail, evidence });
	console.log(`\n[${severity}] ${title}`);
	if (detail) console.log(`  ${detail}`);
	for (const e of evidence) console.log(`  · ${e}`);
}
/** @param {string} msg @returns {never} */
function bail(msg) {
	console.error(`\nENVIRONMENT: ${msg}`);
	process.exit(2);
}

/** @type {Child[]} */
const spawned = [];
/** @param {string} cmd @param {string[]} args @param {import('node:child_process').SpawnOptions} [opts] */
function launch(cmd, args, opts = {}) {
	const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
	spawned.push(p);
	return p;
}
/** @param {Child | null | undefined} p */
function killProc(p) {
	try {
		if (p?.pid && !p.killed) process.kill(p.pid, 'SIGKILL');
	} catch {
		/* the process may already have exited */
	}
}
function killAll() {
	for (const p of spawned) killProc(p);
	spawned.length = 0;
}
process.on('exit', killAll);
process.on('SIGINT', () => {
	killAll();
	process.exit(130);
});

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const r = await fetch(`${BASE}/health`);
			if (r.ok) return true;
		} catch {
			/* best-effort cleanup */
		}
		await sleep(200);
	}
	return false;
}

/** @param {string} name @param {string} [color] @returns {Promise<{ cookie: string, singerId: string }>} */
async function joinRoom(name, color = 'violet') {
	const r = await fetch(`${BASE}/api/join`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ displayName: name, color })
	});
	if (!r.ok) throw new Error(`join failed: ${r.status} ${await r.text()}`);
	const raw = r.headers.get('set-cookie') ?? '';
	const m = /encore_singer=([^;]+)/.exec(raw);
	if (!m) throw new Error(`join returned no session cookie: ${raw}`);
	const body = await r.json();
	return { cookie: `encore_singer=${m[1]}`, singerId: body.singer.id };
}

/** @param {string} q @returns {Promise<any>} an API-shaped media hit (source, id, durationSec, …) */
async function searchLocal(q) {
	const r = await fetch(`${BASE}/api/search?q=${encodeURIComponent(q)}`);
	const d = await r.json();
	const hit = [...d.ready, ...d.processing, ...d.results].find((/** @type {any} */ x) => x.source === 'local');
	if (!hit) throw new Error(`no local match for "${q}"`);
	return hit;
}

/** @param {string} cookie @param {string} mediaId */
async function requestProcess(cookie, mediaId) {
	return fetch(`${BASE}/api/process`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie },
		body: JSON.stringify({ mediaId })
	});
}

// Bun's WebSocket takes a `headers` option the DOM lib does not model, which is how the session cookie
// rides the WS upgrade so queue commands validate as this singer. A build that rejects it falls back to
// unauthed, where the read-only assertions still hold.
/**
 * @param {string} cookie
 */
async function openPhone(cookie) {
	/** @type {any[]} */ // server WS frames are protocol-shaped JSON, decoded loose
	const events = [];
	let ws;
	try {
		ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?role=phone`, /** @type {any} */ ({ headers: { cookie } }));
	} catch {
		ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?role=phone`);
	}
	await new Promise(
		/** @type {(resolve: (value?: unknown) => void, reject: (reason?: unknown) => void) => void} */ (
			(resolve, reject) => {
				ws.onopen = () => resolve();
				ws.onerror = (e) => reject(new Error(`ws open error: ${/** @type {any} */ (e)?.message ?? e}`));
			}
		)
	);
	ws.onmessage = (m) => {
		try {
			events.push(JSON.parse(String(m.data)));
		} catch {
			/* best-effort cleanup */
		}
	};
	ws.send(JSON.stringify({ type: 'hello' }));
	await sleep(100);
	return {
		ws,
		events,
		send: (/** @type {any} */ obj) => ws.send(JSON.stringify(obj)),
		close: () => ws.close(),
		statusOf: (/** @type {string} */ mediaId) =>
			events.filter((/** @type {any} */ e) => e.type === 'media:status' && e.mediaId === mediaId),
		lastStatus: (/** @type {string} */ mediaId) => {
			const list = events.filter((/** @type {any} */ e) => e.type === 'media:status' && e.mediaId === mediaId);
			return list[list.length - 1];
		}
	};
}

/**
 * @param {Awaited<ReturnType<typeof openPhone>>} phone
 * @param {string} mediaId
 * @param {(e: any) => boolean} predicate
 * @param {number} timeoutMs
 * @param {string} [label]
 */
async function waitForStatus(phone, mediaId, predicate, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const last = phone.lastStatus(mediaId);
		if (last && predicate(last)) return last;
		await sleep(100);
	}
	const seen = phone
		.statusOf(mediaId)
		.map((/** @type {any} */ e) => `${e.status}@${e.pct ?? '?'}%`)
		.join(' → ');
	throw new Error(`waitForStatus timeout (${label ?? ''}): media=${mediaId} seen=[${seen}]`);
}

/** @type {string} */
let serverLogPath;

async function bootServer() {
	if (existsSync(SCRATCH)) rmSync(SCRATCH, { recursive: true, force: true });
	mkdirSync(MEDIA_DIR, { recursive: true });
	mkdirSync(SHOTS_DIR, { recursive: true });

	const seed = launch('bun', ['run', 'tests/e2e/seed-media.mjs'], {
		cwd: repoRoot,
		env: { ...process.env, MEDIA_DIR }
	});
	await new Promise((r) => seed.on('exit', r));

	serverLogPath = join(SCRATCH, 'server.log');
	const w = Bun.file(serverLogPath).writer();
	const p = launch('bun', ['run', './server.ts'], {
		cwd: repoRoot,
		env: {
			...process.env,
			ENCORE_EPHEMERAL: '1',
			ENCORE_LYRICS_BACKFILL: '0',
			ENCORE_VOCALS_BACKFILL: '0',
			PORT: String(PORT),
			HOST: '127.0.0.1',
			MEDIA_DIR
		}
	});
	p.stdout?.on('data', (/** @type {Buffer} */ d) => w.write(d));
	p.stderr?.on('data', (/** @type {Buffer} */ d) => w.write(d));
	if (!(await waitForHealth())) bail(`server did not come up on :${PORT}; see ${serverLogPath}`);
}

/** @param {Record<string, string>} env @param {string} tag */
function bootWorker(env, tag) {
	const workerLog = join(SCRATCH, `${tag}.log`);
	const w = Bun.file(workerLog).writer();
	const p = launch('bun', ['tests/e2e/fake-stems-worker.mjs'], {
		cwd: repoRoot,
		env: { ...process.env, EPORT: String(PORT), MEDIA_DIR, FAKE_WORKER_ID: tag, ...env }
	});
	p.stdout?.on('data', (/** @type {Buffer} */ d) => w.write(d));
	p.stderr?.on('data', (/** @type {Buffer} */ d) => w.write(d));
	return { proc: p, log: workerLog };
}

/** @param {(workers: any[]) => boolean} capsPredicate @param {number} [timeoutMs] @param {string} [label] */
async function waitForWorkerCapabilities(capsPredicate, timeoutMs = 5000, label = 'worker caps') {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const r = await fetch(`${BASE}/api/metrics`)
			.then((r) => r.json())
			.catch(() => null);
		if (r?.workers?.length && capsPredicate(r.workers)) return r.workers;
		await sleep(150);
	}
	throw new Error(`no worker matching predicate came online within ${timeoutMs}ms (${label})`);
}

async function main() {
	try {
		const h = await fetch(`${BASE}/health`);
		if (h.ok) bail(`port ${PORT} is already in use — probe requires an exclusive port`);
	} catch {
		/* best-effort cleanup */
	}

	const chromium = findChromium();
	if (!chromium) bail('no Chromium found; screenshots are a required deliverable of this probe');

	console.log(`P11 booting on :${PORT}, scratch=${SCRATCH}`);
	await bootServer();

	const { cookie, singerId } = await joinRoom(`Probe-P11-${Date.now() % 100000}`);
	const phone = await openPhone(cookie);

	// Resolving the four ids also MATERIALISES them into mediaById, which the queue path needs.
	const caroline = await searchLocal('caroline');
	const dontstop = await searchLocal('believin');
	const bohemian = await searchLocal('bohemian');
	const prayer = await searchLocal('prayer');
	console.log(`  media: caroline=${caroline.id} dontstop=${dontstop.id} bohemian=${bohemian.id} prayer=${prayer.id}`);

	// STEP 1. Two normal processes: the play log's content, and the happy-path audit reference.
	console.log('\n[step 1] two normal processes');
	let normal = bootWorker({ FAKE_SLOW_MS: '100' }, 'normal-1');
	await waitForWorkerCapabilities(
		(ws) => ws.some((/** @type {any} */ w) => w.workerId === 'normal-1'),
		5000,
		'normal-1'
	);

	const c1 = await requestProcess(cookie, caroline.id);
	if (!c1.ok) throw new Error(`caroline process failed: ${c1.status} ${await c1.text()}`);
	await waitForStatus(phone, caroline.id, (/** @type {any} */ e) => e.status === 'ready', 10000, 'caroline ready');

	const c2 = await requestProcess(cookie, dontstop.id);
	if (!c2.ok) throw new Error(`dontstop process failed: ${c2.status} ${await c2.text()}`);
	await waitForStatus(phone, dontstop.id, (/** @type {any} */ e) => e.status === 'ready', 10000, 'dontstop ready');

	// Stopped first, or dispatch races the FAKE_FAIL worker into a job it was not asked to fail.
	killProc(normal.proc);
	await sleep(600);

	// STEP 2. One FAILED process: FAKE_FAIL=stems is retryable:false, so it is terminal. Outcome 'failed'.
	console.log('\n[step 2] one FAILED process via FAKE_FAIL=stems');
	const failer = bootWorker({ FAKE_FAIL: 'stems', FAKE_SLOW_MS: '100' }, 'fail-stems-2');
	await waitForWorkerCapabilities(
		(ws) => ws.some((/** @type {any} */ w) => w.workerId === 'fail-stems-2'),
		5000,
		'fail-stems-2'
	);

	const c3 = await requestProcess(cookie, bohemian.id);
	if (!c3.ok) throw new Error(`bohemian process failed: ${c3.status} ${await c3.text()}`);
	await waitForStatus(
		phone,
		bohemian.id,
		(/** @type {any} */ e) => e.status === 'failed' || e.status === 'ready',
		10000,
		'bohemian terminal'
	);
	// Take the failer offline so it cannot pick up prayer's stems below.
	killProc(failer.proc);
	await sleep(600);

	// STEP 3. One RETRIED process, ending stems abandoned / stems ready / align ready, outcome 'ready'.
	console.log('\n[step 3] one RETRIED process via kill-mid-process + progress-lease expiry (~30s)');
	const doomed = bootWorker({ FAKE_SLOW_MS: '45000' }, 'doomed-3');
	await waitForWorkerCapabilities(
		(ws) => ws.some((/** @type {any} */ w) => w.workerId === 'doomed-3'),
		5000,
		'doomed-3'
	);

	const c4 = await requestProcess(cookie, prayer.id);
	if (!c4.ok) throw new Error(`prayer process failed: ${c4.status} ${await c4.text()}`);
	// Wait for the FIRST 'separating' frame: only then is the job truly RUNNING under the doomed worker. A
	// kill during 'downloading' yields an ack-timeout, which neither bumps attempts nor writes an 'abandoned'
	// row — so there would be no retry to observe at all.
	await waitForStatus(
		phone,
		prayer.id,
		(/** @type {any} */ e) => e.status === 'separating',
		30000,
		'prayer separating'
	);
	console.log('  SIGKILLing doomed worker while stems is running');
	killProc(doomed.proc);

	// Progress lease 30s (leases.ts DEFAULT_LEASE_CONFIG), reaper tick 3s. The replacement comes up NOW so it
	// can take the requeue the instant the lease expires.
	bootWorker({ FAKE_SLOW_MS: '100' }, 'rescue-3');
	await waitForWorkerCapabilities(
		(ws) => ws.some((/** @type {any} */ w) => w.workerId === 'rescue-3'),
		5000,
		'rescue-3'
	);
	// 30s progress lease + 3s reaper tick + ~10s slack for retry + follow-up align + broadcast.
	await waitForStatus(
		phone,
		prayer.id,
		(/** @type {any} */ e) => e.status === 'ready' || e.status === 'failed',
		60000,
		'prayer terminal'
	);

	// STEP 4. caroline, dontstop, caroline, prayer — 4 plays over 3 distinct songs, which forces apart the
	// two /stats tiles that could otherwise blur together.
	console.log('\n[step 4] queue four entries and drive plays');

	let addedAt = Date.now();
	/** @param {string} mediaId @returns {string} */
	function queueEntry(mediaId) {
		// A FULL QueueEntry. A missing addedAt trips the queue_entries.added_at NOT NULL constraint on flush,
		// and because the state store applies queue ops synchronously that exception unwinds through the WS
		// handler and takes server.ts down. rotationSeq is MAX_SAFE_INTEGER; applyAndReseq assigns the real one.
		const entryId =
			`01M${Math.random().toString(36).slice(2, 10).toUpperCase()}${Date.now().toString(36).toUpperCase().slice(-10)}`.slice(
				0,
				26
			);
		const clientOpId = `op_${Math.random().toString(36).slice(2, 12)}`;
		phone.send({
			type: 'queue:command',
			clientOpId,
			command: {
				clientOpId,
				op: {
					op: 'add',
					entry: {
						id: entryId,
						mediaId,
						singerId,
						status: 'queued',
						rotationSeq: Number.MAX_SAFE_INTEGER,
						addedAt: addedAt++
					}
				}
			}
		});
		return entryId;
	}

	/** @type {DriveEntry[]} */
	const entries = [
		{ mediaId: caroline.id, label: 'caroline#1' },
		{ mediaId: dontstop.id, label: 'dontstop#1' },
		{ mediaId: caroline.id, label: 'caroline#2' },
		{ mediaId: prayer.id, label: 'prayer#1' }
	];
	for (const e of entries) {
		e.entryId = queueEntry(e.mediaId);
		await sleep(120);
	}

	// `play` from idle picks up the first playable entry and emits a nowplaying:changed, which the
	// PlayTracker converts into one durable play row.
	console.log('  starting playback');
	phone.send({ type: 'player:command', command: { cmd: 'play' } });
	await sleep(400);
	for (let i = 0; i < entries.length - 1; i++) {
		phone.send({ type: 'player:command', command: { cmd: 'skip' } });
		await sleep(400);
	}
	// The last advance still has to fire emitNowPlaying → PlayTracker → PlayLog.record.
	await sleep(500);

	// STEP 5. Count what happened here, so the comparison is against the probe's numbers, not the dashboard's.
	console.log('\n[step 5] read endpoints');
	const stats = await fetch(`${BASE}/api/stats`).then((r) => r.json());
	const metrics = await fetch(`${BASE}/api/metrics`).then((r) => r.json());
	const auditCaroline = await fetch(`${BASE}/api/audit/${caroline.id}`).then((r) => r.json());
	const auditBohemian = await fetch(`${BASE}/api/audit/${bohemian.id}`).then((r) => r.json());
	const auditPrayer = await fetch(`${BASE}/api/audit/${prayer.id}`).then((r) => r.json());
	const auditDontstop = await fetch(`${BASE}/api/audit/${dontstop.id}`).then((r) => r.json());

	writeFileSync(join(SCRATCH, 'stats.json'), JSON.stringify(stats, null, 2));
	writeFileSync(join(SCRATCH, 'metrics.json'), JSON.stringify(metrics, null, 2));
	writeFileSync(join(SCRATCH, 'audit-caroline.json'), JSON.stringify(auditCaroline, null, 2));
	writeFileSync(join(SCRATCH, 'audit-bohemian.json'), JSON.stringify(auditBohemian, null, 2));
	writeFileSync(join(SCRATCH, 'audit-prayer.json'), JSON.stringify(auditPrayer, null, 2));
	writeFileSync(join(SCRATCH, 'audit-dontstop.json'), JSON.stringify(auditDontstop, null, 2));

	console.log('\n[step 6] cross-check numbers');
	// (1) the numbers match: library.ready = 3 (bohemian FAILED, so not 4), sings.total = 4, distinctSongs = 3.
	{
		const libReady = stats.library?.ready;
		const total = stats.sings?.total;
		const distinct = stats.sings?.distinctSongs;
		const window = stats.sings?.window;
		if (libReady === 3 && total === 4 && distinct === 3 && window === 4) {
			record(
				'LOW',
				'/api/stats reports the correct library size, total plays and distinct-song count',
				`library.ready=${libReady}, sings.total=${total}, distinctSongs=${distinct}, window=${window}`,
				[
					`we processed 4 songs — 3 succeeded (caroline, dontstop, prayer) and 1 failed (bohemian) — so library.ready must be 3`,
					`we queued 4 entries across 3 distinct medias (caroline twice, dontstop once, prayer once); dedup is on entryId, so total plays = 4`
				]
			);
		} else {
			record(
				'HIGH',
				'/api/stats numbers disagree with what actually happened',
				`observed library.ready=${libReady} (want 3), sings.total=${total} (want 4), distinctSongs=${distinct} (want 3), window=${window} (want 4)`,
				[
					'src/routes/api/stats/+server.ts:22-51 — library.ready reads listReady, sings.* read PlayLog',
					'src/server/media/plays.ts:24-49 — PlayTracker dedupes on entryId, sink fires once per fresh currentEntryId'
				]
			);
		}
		// NaN or Infinity anywhere in the payload is a defect on its own.
		const dump = JSON.stringify(stats);
		const hasBadNum =
			/"perDay":\[.*"(NaN|Infinity|-Infinity)"/.test(dump) ||
			Object.values(stats.sings ?? {}).some((/** @type {any} */ v) => typeof v === 'number' && !Number.isFinite(v)) ||
			stats.topSongs.some((/** @type {any} */ s) => typeof s.plays !== 'number' || !Number.isFinite(s.plays));
		if (hasBadNum) {
			record(
				'HIGH',
				'/api/stats contains a non-finite number',
				'a raw NaN or Infinity in a public aggregate is a rendering hazard — see the top of /stats'
			);
		}
	}

	// caroline=2 then dontstop=1 and prayer=1 TIED, and tie order is implementation-defined — so the SET is
	// asserted, never the order.
	{
		const bySong = new Map(stats.topSongs.map((/** @type {any} */ s) => [s.mediaId, s.plays]));
		const car = bySong.get(caroline.id) ?? 0;
		const ds = bySong.get(dontstop.id) ?? 0;
		const pr = bySong.get(prayer.id) ?? 0;
		if (car === 2 && ds === 1 && pr === 1) {
			record(
				'LOW',
				'/api/stats topSongs plays match the entry log',
				`caroline=2, dontstop=1, prayer=1 — one song played through two distinct entries counts as two plays`
			);
		} else {
			record(
				'HIGH',
				'/api/stats topSongs counts wrong per-song plays',
				`caroline=${car} (want 2), dontstop=${ds} (want 1), prayer=${pr} (want 1)`
			);
		}
	}

	// perDay: exactly one bar today (all 4 plays), no earlier days, no NaN/Infinity.
	{
		const today = new Date().toISOString().slice(0, 10);
		const todayEntry = stats.perDay.find((/** @type {any} */ d) => d.day === today);
		const hasBadNum = stats.perDay.some(
			(/** @type {any} */ d) => typeof d.plays !== 'number' || !Number.isFinite(d.plays)
		);
		if (todayEntry && todayEntry.plays === 4 && !hasBadNum && stats.perDay.length === 1) {
			record(
				'LOW',
				'the /stats trend line has exactly one bar today with 4 plays',
				`perDay=[${stats.perDay.map((/** @type {any} */ d) => `${d.day}:${d.plays}`).join(', ')}] — the log has no zero-fill (an absent day = "we can't tell if it was quiet or the server was off"), so a fresh install shows one bar and honest copy`,
				[
					'src/server/media/play-log.ts:75-88 — perDay omits days with no plays rather than 0-filling',
					'src/routes/stats/+page.svelte:95-100 — footnote makes the ambiguity explicit'
				]
			);
		} else {
			record(
				'MEDIUM',
				'the /stats trend line does not match the play log',
				`observed perDay=[${stats.perDay.map((/** @type {any} */ d) => `${d.day}:${d.plays}`).join(', ')}], today=${todayEntry ? JSON.stringify(todayEntry) : '(missing)'}, hasBadNum=${hasBadNum}`
			);
		}
	}

	{
		const steps = metrics.steps;
		// Every step row carries meanMs (work) and meanQueueWaitMs (wait), separately.
		const bothPopulated =
			steps.length > 0 &&
			steps.every((/** @type {any} */ s) => typeof s.meanMs === 'number' && typeof s.meanQueueWaitMs === 'number');
		// The claim is that the two are distinct COLUMNS in the payload, not that one is larger: on a
		// single-worker box with cheap work they can legitimately be close.
		const oneAttempt = auditCaroline.processes[0]?.attempts?.[0];
		const perAttemptSplit =
			oneAttempt &&
			'queueWaitMs' in oneAttempt &&
			'processingMs' in oneAttempt &&
			typeof oneAttempt.queueWaitMs === 'number' &&
			typeof oneAttempt.processingMs === 'number';
		if (bothPopulated && perAttemptSplit) {
			record(
				'LOW',
				'queue wait is reported alongside — and separately from — processing time',
				`steps rollup carries meanMs and meanQueueWaitMs as distinct fields; per-attempt audit carries queueWaitMs and processingMs. Example (caroline fetch): queueWait=${oneAttempt.queueWaitMs}ms, processing=${oneAttempt.processingMs}ms`
			);
		} else {
			record(
				'HIGH',
				'queue wait and processing time are conflated or missing',
				`bothPopulated=${bothPopulated}, perAttemptSplit=${perAttemptSplit}, example=${JSON.stringify(oneAttempt)}`
			);
		}
	}

	// (3) the audit shows every attempt, including the failed and the retried one. `needsFetch` is false for
	// source:'local' (proc.ts:154), so a local process enqueues NO fetch step and every count below excludes it:
	//   caroline: 1 proc, 2 attempts (stems ready, align ready)
	//   dontstop: 1 proc, 2 attempts (stems ready, align ready)
	//   bohemian: 1 proc, 1 attempt  (stems failed) — process outcome=failed, no align chain
	//   prayer:   1 proc, 3 attempts (stems abandoned, stems ready, align ready) — process outcome=ready
	/** @param {any} audit */
	function summarizeAudit(audit) {
		const proc = audit.processes[0];
		if (!proc) return { processOutcome: null, byType: {} };
		/** @type {Record<string, string[]>} */
		const byType = {};
		for (const a of proc.attempts) {
			(byType[a.jobType] ??= []).push(a.outcome);
		}
		return { processOutcome: proc.outcome, byType, attempts: proc.attempts.length };
	}

	const carA = summarizeAudit(auditCaroline);
	const dsA = summarizeAudit(auditDontstop);
	const boA = summarizeAudit(auditBohemian);
	const prA = summarizeAudit(auditPrayer);

	// Its own finding, because every audit count below depends on it.
	{
		const noFetchAnywhere = ![carA, dsA, boA, prA].some((a) => Object.keys(a.byType).includes('fetch'));
		if (noFetchAnywhere) {
			record(
				'LOW',
				'LOCAL-source processes correctly skip the fetch step',
				`every audit log for a demo-library song shows 0 fetch attempts. proc.ts:154 branches on needsFetch(media.source) and starts a local process directly at the stems step, saving a redundant download of a file that already exists.`,
				[
					'src/server/jobs/proc.ts:154-155 — needsFetch(source) is false for source:"local"',
					'src/server/jobs/dispatch.ts:53-88 — assignParams still fills fetcher=local for chained stems, without a separate fetch step'
				]
			);
		} else {
			record(
				'MEDIUM',
				'a fetch step ran for a LOCAL-source process — unexpected',
				`byType per song: caroline=${JSON.stringify(carA.byType)} dontstop=${JSON.stringify(dsA.byType)} bohemian=${JSON.stringify(boA.byType)} prayer=${JSON.stringify(prA.byType)}`
			);
		}
	}

	{
		const carOk =
			carA.processOutcome === 'ready' &&
			carA.attempts === 2 &&
			JSON.stringify(carA.byType) === JSON.stringify({ stems: ['ready'], align: ['ready'] });
		const dsOk =
			dsA.processOutcome === 'ready' &&
			dsA.attempts === 2 &&
			JSON.stringify(dsA.byType) === JSON.stringify({ stems: ['ready'], align: ['ready'] });
		if (carOk && dsOk) {
			record(
				'LOW',
				'audit shows 2 attempts / process for a happy-path LOCAL proc, all outcomes = ready',
				`caroline ${carA.attempts}× outcome=${carA.processOutcome}, dontstop ${dsA.attempts}× outcome=${dsA.processOutcome}. Local sources skip the fetch step (proc.ts:154 uses needsFetch), which is the correct optimisation but MUST be reflected in every audit expectation.`
			);
		} else {
			record(
				'HIGH',
				'audit disagrees with the actual happy-path process shape',
				`caroline=${JSON.stringify(carA)}\n         dontstop=${JSON.stringify(dsA)}`
			);
		}
	}
	{
		const boOk =
			boA.processOutcome === 'failed' &&
			boA.attempts === 1 &&
			JSON.stringify(boA.byType) === JSON.stringify({ stems: ['failed'] });
		// An empty error message silently drops the reason the operator opened the audit page for.
		const stemsFailed = auditBohemian.processes[0]?.attempts?.find((/** @type {any} */ a) => a.jobType === 'stems');
		const hasReason = typeof stemsFailed?.error === 'string' && stemsFailed.error.length > 0;
		if (boOk && hasReason) {
			record(
				'LOW',
				'audit records a FAILED process with per-attempt outcomes and the terminal error string',
				`bohemian: stems=failed, proc.outcome=failed, error="${stemsFailed.error}"`
			);
		} else {
			record(
				'HIGH',
				'audit for a FAILED process is missing outcomes or the error string',
				`observed=${JSON.stringify(boA)}, stems.error=${JSON.stringify(stemsFailed?.error)}`
			);
		}
	}
	{
		const stemsAttempts =
			auditPrayer.processes[0]?.attempts?.filter((/** @type {any} */ a) => a.jobType === 'stems') ?? [];
		const outcomes = stemsAttempts.map((/** @type {any} */ a) => a.outcome);
		// The retried stems attempt must be attempt=2 — AttemptLedger.open is 1-based.
		const attemptNumbers = stemsAttempts.map((/** @type {any} */ a) => a.attempt);
		const retryOk =
			prA.processOutcome === 'ready' &&
			prA.attempts === 3 &&
			outcomes.includes('abandoned') &&
			outcomes.includes('ready') &&
			attemptNumbers.includes(2);
		if (retryOk) {
			record(
				'LOW',
				'audit records a RETRIED process with the abandoned attempt preserved as its own row',
				`prayer: total=${prA.attempts} attempts, stems outcomes=[${outcomes.join(', ')}], attempt numbers=[${attemptNumbers.join(', ')}], proc.outcome=${prA.processOutcome}`
			);
		} else {
			record(
				'HIGH',
				'audit for the RETRIED process is missing the abandoned attempt or the retry lineage',
				`observed=${JSON.stringify(prA)}, stems outcomes=[${outcomes.join(', ')}], attempts=[${attemptNumbers.join(', ')}]`
			);
		}
	}

	// (4) the audit endpoint agrees with metrics on which processes completed.
	{
		const processesInMetrics = new Set(metrics.slowestProcesses.map((/** @type {any} */ c) => c.processingId));
		const auditPrayerProcessingId = auditPrayer.processes[0]?.processingId;
		const auditCarolineProcessingId = auditCaroline.processes[0]?.processingId;
		const auditDontstopProcessingId = auditDontstop.processes[0]?.processingId;
		const carolineInMetrics = processesInMetrics.has(auditCarolineProcessingId);
		const dontstopInMetrics = processesInMetrics.has(auditDontstopProcessingId);
		const prayerInMetrics = processesInMetrics.has(auditPrayerProcessingId);
		// The two disagree on what a retried process IS: audit.processOutcome ignores 'abandoned' and reads
		// 'ready', while metrics.perProcess needs EVERY attempt 'ready'. The finding below spells out the cost.
		if (carolineInMetrics && dontstopInMetrics && !prayerInMetrics) {
			record(
				'HIGH',
				'metrics.perProcess treats a retried-then-completed process as INCOMPLETE — /api/audit disagrees with itself',
				`the prayer processingId=${auditPrayerProcessingId} completed successfully after one abandoned attempt (audit.processOutcome="ready"), but it is ABSENT from metrics.slowestProcesses and NOT counted in metrics.e2e (e2e.n=${metrics.e2e.n} vs 3 completed processes). The audit page reports it as done; the operator dashboard silently drops it from every average and top-10 list, biasing the fleet's reported end-to-end downward.`,
				[
					`observed: /api/audit/${prayer.id}.processes[0].outcome = "${prA.processOutcome}"`,
					`observed: /api/metrics.slowestProcesses[].processingId = [${[...processesInMetrics].join(', ')}] (${processesInMetrics.size} processes, prayer absent)`,
					`observed: /api/metrics.e2e.n = ${metrics.e2e.n} (expected 3 including prayer)`,
					'src/server/jobs/metrics.ts:127-146 — perProcess: `complete = sealed.length === list.length && sealed.every(a => a.outcome === "ready")` — abandoned makes complete=false',
					'src/routes/api/audit/[mediaId]/+server.ts:71-76 — processOutcome ignores "abandoned"; a retried process reads "ready"',
					'consequence: /metrics "Start to finish" tile understates n by one process per retried song; slowestProcesses omits the retried outliers a person specifically wants to see'
				]
			);
		} else if (carolineInMetrics && dontstopInMetrics && prayerInMetrics) {
			record(
				'LOW',
				'metrics.slowestProcesses and /api/audit agree on which processes completed, including retried ones',
				`overlap=3 processingIds — the retried process (prayer) is counted alongside the two happy-path ones`
			);
		} else {
			record(
				'MEDIUM',
				'metrics.slowestProcesses and audit endpoint disagree on which processes completed (unexpected pattern)',
				`caroline in metrics=${carolineInMetrics}, dontstop=${dontstopInMetrics}, prayer=${prayerInMetrics}`,
				['src/server/jobs/metrics.ts:127-146 — perProcess filters to complete=every attempt.outcome===ready']
			);
		}
	}

	// (5) cost per model, unknown-model degradation, and chart precision. The "Where the time goes" chart
	// rounds meanMs/1000 to an integer, so a sub-second stage reads "0 s avg" where the tables say "100ms".
	{
		const anyStageSubSecond = metrics.stages.some(
			(/** @type {any} */ s) => (s.meanMs ?? 0) > 0 && (s.meanMs ?? 0) < 500
		);
		if (anyStageSubSecond) {
			record(
				'MEDIUM',
				'"Where the time goes" bars round sub-second stage means to 0 seconds',
				`the chart divides meanMs by 1000 and rounds to an integer, so any stage under 500ms displays as "0 s avg" — a reader interprets that as "did not take any time" rather than "took a tiny amount". Every OTHER duration on the page (in the "each step" table, in "Start to finish", in the audit) goes through dur() and formats correctly as "100ms". The chart alone loses fidelity.`,
				[
					`observed metrics.stages = ${JSON.stringify(metrics.stages)} — all sub-second`,
					'src/routes/metrics/+page.svelte:194-196 — Bars value = Math.round((s.meanMs ?? 0) / 1000)',
					'src/lib/metrics-format.ts:22-32 — dur() renders sub-second as "100ms" — the Bars call bypasses it'
				]
			);
		}
	}

	// fake-separator/e2e-tone is not in the allowlist, so separatorCost() returns undefined and both declared
	// and ratioToDeclared are null — the row must SHIP anyway, so a measurement is visibly taken.
	{
		const models = metrics.models;
		const fake = models.find((/** @type {any} */ m) => m.engine === 'fake-separator' && m.model === 'e2e-tone');
		if (!fake) {
			record(
				'HIGH',
				'metrics.models is missing the fake-separator/e2e-tone row',
				`this measurement is the only per-model data on the box. Models seen: ${models.map((/** @type {any} */ m) => `${m.engine}/${m.model}`).join(', ') || '(none)'}`
			);
		} else if (fake.declared !== undefined && fake.declared !== null) {
			record(
				'HIGH',
				'fake-separator/e2e-tone declared cost was fabricated — not in the whitelist',
				`declared=${JSON.stringify(fake.declared)}. separatorCost() should return undefined for this pair.`,
				[
					'src/lib/contract/lyrics/separators.ts:227-230 — separatorCost returns undefined for a pair not in the engine list'
				]
			);
		} else if (fake.ratioToDeclared !== null) {
			record(
				'HIGH',
				'ratioToDeclared is not null when the declared cost is unknown',
				`ratio=${fake.ratioToDeclared}. When declared is undefined, the ratio must be null.`
			);
		} else if (fake.meanRtFactor === null || !Number.isFinite(fake.meanRtFactor)) {
			record(
				'MEDIUM',
				'fake-separator/e2e-tone measured rtFactor is null despite a completed process',
				`meanRtFactor=${fake.meanRtFactor}. audioSec is snapshotted from media.durationSec (250 for caroline); this should have been a real number.`,
				['src/server/jobs/worker-hub.ts:390-401 — audioSec is captured at assign time from media.durationSec']
			);
		} else {
			record(
				'LOW',
				'cost-per-model degrades correctly when the model has no declared rtFactor',
				`observed fake-separator/e2e-tone: n=${fake.n}, meanRtFactor=${fake.meanRtFactor.toFixed(4)}×, declared=undefined, ratioToDeclared=null — the /metrics table renders "—" in the benchmark and vs columns for this row, which is the documented degradation`,
				[
					'src/lib/contract/lyrics/separators.ts:227-230 — separatorCost undefined for an unknown pair',
					'src/routes/metrics/+page.svelte:172-176 — "—" for a null declared, "—" for a null ratioToDeclared'
				]
			);
		}
	}

	console.log('\n[step 7] screenshot the three dashboards at 390 and 1440');
	// (6) SSR plus screenshots at 390 and 1440.
	const { connect } = await import('../driver.mjs');
	const browser = await connect();
	try {
		/** @param {string} path @param {string} url @param {number} w @param {number} h */
		async function shoot(path, url, w, h) {
			const page = await browser.newPage();
			await page.viewport(w, h, 1);
			await page.goto(url);
			// The h1 must exist, or the shot catches a still-loading spinner.
			await page.waitForSelector('h1', { timeout: 8000 }).catch(() => null);
			await sleep(600);
			await page.screenshot(path, { fullPage: true });
			return path;
		}

		/** @type {{ name: string, size: string, path: string, url: string }[]} */
		const shots = [];
		/** @type {[string, string][]} */
		const pages = [
			['stats', '/stats'],
			['metrics', '/metrics'],
			['audit-caroline', `/metrics/${caroline.id}`],
			['audit-prayer-retried', `/metrics/${prayer.id}`],
			['audit-bohemian-failed', `/metrics/${bohemian.id}`]
		];
		/** @type {[string, number, number][]} */
		const sizes = [
			['390', 390, 900],
			['1440', 1440, 900]
		];
		for (const [name, path] of pages) {
			for (const [size, w, h] of sizes) {
				const outfile = join(SHOTS_DIR, `${name}-${size}.png`);
				try {
					await shoot(outfile, `${BASE}${path}`, w, h);
					shots.push({ name, size, path: outfile, url: `${BASE}${path}` });
					console.log(`  shot ${name}@${size} → ${outfile}`);
				} catch (e) {
					record('MEDIUM', `screenshot failed: ${name}@${size}`, String(e));
				}
			}
		}

		// Alignment and vocabulary leaks are what a person judges from the screenshot, and both are decidable
		// off the DOM without an image.
		const dompage = await browser.newPage();
		await dompage.viewport(1440, 900, 1);
		await dompage.goto(`${BASE}/metrics`);
		await dompage.waitForSelector('h1', { timeout: 8000 });
		await sleep(400);
		const headerRow = await dompage.texts('table th');
		const bodyText = await dompage.text('body');
		{
			// The step and stage TABLES must render user-facing labels with "typical"/"worst" headers, while the
			// WORKERS panel shows raw capability strings BY DESIGN — so only the tables' text is scanned.
			const inTables =
				await dompage.evaluate(`(() => [...document.querySelectorAll(${JSON.stringify(SEL.dashCardTable)})]
				.map((t) => t.textContent).join('\\n'))()`);
			await dompage.evaluate(`(() => document.querySelector(${JSON.stringify(SEL.dashChartOrBody)})
				?.textContent ?? '')()`);
			const stagesLabelsText = await dompage.evaluate(`(() => {
				const cards = [...document.querySelectorAll(${JSON.stringify(SEL.dashCard)})];
				const staged = cards.find((c) => c.querySelector('h2')?.textContent?.trim() === 'Where the time goes');
				return staged?.textContent ?? '';
			})()`);

			const leaksInternalPercentiles = /\bp50\b|\bp95\b/.test(bodyText);
			const leaksStepInTables = /\bfetch\b|\balign\b|\bseparating\b|\baligning\b/.test(inTables);
			// STAGE_LABELS maps only "separating"/"aligning"/"downloading", so any other stage token falls
			// through to its raw name on the chart.
			const leaksStageInBar = /\bseparate\b|\balign\b/.test(stagesLabelsText);
			const speaksHuman = /remove vocals|time lyrics|typical|worst/i.test(bodyText);
			if (!leaksInternalPercentiles && !leaksStepInTables && !leaksStageInBar && speaksHuman) {
				record(
					'LOW',
					'/metrics uses operator-facing vocabulary — no p50/p95, no raw job-type names in tables, no raw stage names on the chart',
					`headers=[${headerRow.join(', ')}]; body contains "typical" / "worst" / "remove vocals"`
				);
			} else if (!leaksInternalPercentiles && !leaksStepInTables && leaksStageInBar) {
				record(
					'LOW',
					'"Where the time goes" bar labels read "separate"/"align" — harness artefact, not a UI defect',
					`the fake-stems-worker emits short stage tokens in its job:complete stages array, while the real Python worker uses the long forms (worker/src/vocabulary.py:48). STAGE_LABELS is keyed on the long forms, so a real process renders "removing vocals" / "timing lyrics" as intended. The leak in this probe's screenshots is expected.`,
					[
						`observed rollup: /api/metrics.stages = ${JSON.stringify(metrics.stages)}`,
						'src/lib/metrics-format.ts:52-56 — STAGE_LABELS: downloading / separating / aligning',
						'worker/src/vocabulary.py:48-50 — Stage.SEPARATING="separating", Stage.ALIGNING="aligning"',
						'tests/e2e/fake-stems-worker.mjs — emits short "separate"/"align" tokens; harness-only'
					]
				);
			} else {
				record(
					'HIGH',
					'/metrics leaks internal identifiers in a user-facing surface',
					`leaks p50/p95=${leaksInternalPercentiles}, leaks raw step in tables=${leaksStepInTables}, leaks raw stage in bars=${leaksStageInBar}, speaks human=${speaksHuman}`,
					['src/lib/metrics-format.ts:39-45 — STEP_LABELS map']
				);
			}
		}
		const nHeaders = await dompage.count('table th');
		const rightAlignedCount = await dompage.evaluate(`(() => {
			const ths = [...document.querySelectorAll('table th')];
			return ths.filter((th) => getComputedStyle(th).textAlign === 'right').length;
		})()`);
		{
			// Column 0 is the step name and is left-aligned; on each of the three tables every other column
			// should be right.
			const shouldBeRight = Math.max(0, nHeaders - 3); // 3 tables × 1 leading name column each
			if (rightAlignedCount >= shouldBeRight) {
				record(
					'LOW',
					'numeric columns on /metrics right-align — a reader can run an eye down a column and compare',
					`right-aligned th count=${rightAlignedCount}, name-col count subtracted=${shouldBeRight}, total th=${nHeaders}`
				);
			} else {
				record(
					'HIGH',
					'/metrics numeric column alignment is broken — a scan-down comparison is not possible',
					`right-aligned=${rightAlignedCount}, expected ≥${shouldBeRight}`
				);
			}
		}

		// Existence and size are the evidence; judging the pixels is the reader's job.
		for (const s of shots) {
			const size = existsSync(s.path) ? await Bun.file(s.path).size : 0;
			if (size < 2000) {
				record('HIGH', `screenshot ${s.name}@${s.size} is suspiciously small`, `${size} bytes at ${s.path}`);
			}
		}
		record(
			'LOW',
			'six screenshots written for a human to eyeball',
			`three pages × two viewports, at ${SHOTS_DIR}`,
			shots.map((s) => `${s.url}  →  ${s.path}`)
		);
	} finally {
		browser.close();
	}

	console.log('\n[step 8] check the documented security posture');
	// (7) the documented security posture.
	// (a) /stats is aggregate-only. The play log has no singer column by construction, but the endpoint could
	// still leak by growing a join, so singer-ish keys are hunted for.
	{
		const dump = JSON.stringify(stats);
		const suspiciousKeys = /"(singer|singerId|displayName|color|sessionToken)"/i.test(dump);
		if (!suspiciousKeys) {
			record(
				'LOW',
				'/api/stats is aggregate-only — no singer keys in the payload',
				`response contains no singer / singerId / displayName / color / sessionToken keys`,
				[
					'src/server/db/schema.ts — plays table has no singer column',
					'src/routes/api/stats/+server.ts — endpoint only reads library, playLog, and popularity'
				]
			);
		} else {
			record(
				'CRITICAL',
				'/api/stats contains singer identity fields',
				`the documented posture is aggregate-only. Payload sample keys: ${Object.keys(stats).join(', ')}`
			);
		}
	}
	// (b) /api/metrics and /api/audit/* are UNGATED deliberately, so a no-cookie 200 is correct — what they
	// expose is the finding worth recording.
	{
		/** @type {Record<string, string>} */
		const noCookieHeaders = {}; // no cookie
		const mRes = await fetch(`${BASE}/api/metrics`, { headers: noCookieHeaders });
		const aRes = await fetch(`${BASE}/api/audit/${caroline.id}`, { headers: noCookieHeaders });
		if (mRes.status === 200 && aRes.status === 200) {
			// What is exposed: worker ids, model and backend names, host details, terminal error strings.
			const m = await mRes.json();
			const a = await aRes.json();
			const workerIds = m.workers.map((/** @type {any} */ w) => w.workerId);
			const errStrings = a.processes
				.flatMap((/** @type {any} */ c) => c.attempts.map((/** @type {any} */ att) => att.error))
				.filter(Boolean);
			record(
				'MEDIUM',
				'/api/metrics and /api/audit/<id> are UNGATED, as documented',
				`both endpoints return 200 without any cookie — this is the current posture (see the header comment in src/routes/api/metrics/+server.ts).`,
				[
					`observed: /api/metrics → 200 without cookie, exposing worker ids: ${JSON.stringify(workerIds)}`,
					`observed: /api/audit/${caroline.id} → 200 without cookie`,
					`what is exposed: worker ids, model/backend names, host details, per-attempt terminal error strings`,
					`example error strings on the box: ${
						errStrings
							.slice(0, 2)
							.map((/** @type {any} */ e) => JSON.stringify(e))
							.join(', ') || '(none on this run)'
					}`,
					'src/routes/api/metrics/+server.ts:1-13 — decision to bind the server to a trusted interface or add a token',
					'src/routes/api/audit/[mediaId]/+server.ts:11-14 — same posture, one song at a time'
				]
			);
		} else {
			record(
				'CRITICAL',
				'/api/metrics or /api/audit is unexpectedly gated',
				`metrics status=${mRes.status}, audit status=${aRes.status}. The documented posture says both are unauthenticated; a 401/403 here means the header comment is wrong OR a real gate was added silently.`
			);
		}
	}

	// (8) UI parity: the numbers rendered in a phone-sized viewport must match the API's.
	{
		const browser2 = await connect();
		{
			try {
				const p = await browser2.newPage();
				await p.viewport(1440, 900, 1);
				await p.goto(`${BASE}/stats`);
				await p.waitForSelector(SEL.dashTileNumber, { timeout: 8000 });
				await sleep(400);
				const tiles = await p.texts(SEL.dashTileNumber);
				// Order in DOM: songs sung, ready to sing, different songs (see /stats markup).
				const shownTotal = Number(tiles[0]);
				const shownReady = Number(tiles[1]);
				const shownDistinct = Number(tiles[2]);
				if (
					shownTotal === stats.sings.total &&
					shownReady === stats.library.ready &&
					shownDistinct === stats.sings.distinctSongs
				) {
					record(
						'LOW',
						'the /stats page shows the same numbers /api/stats reports',
						`page.tiles=[${tiles.join(', ')}], api.sings.total=${stats.sings.total}, api.library.ready=${stats.library.ready}, api.sings.distinctSongs=${stats.sings.distinctSongs}`
					);
				} else {
					record(
						'HIGH',
						'/stats page numbers disagree with /api/stats payload',
						`page total=${shownTotal} (api=${stats.sings.total}), page ready=${shownReady} (api=${stats.library.ready}), page distinct=${shownDistinct} (api=${stats.sings.distinctSongs})`
					);
				}
			} finally {
				browser2.close();
			}
		}
	}

	phone.close();
}

try {
	await main();
} catch (err) {
	record('CRITICAL', 'probe threw during execution', String(/** @type {any} */ (err)?.stack ?? err));
}

console.log('\n\n=== P11 SUMMARY ===');
/** @type {Record<Severity, Finding[]>} */
const bySev = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [] };
for (const f of findings) (bySev[f.severity] ?? []).push(f);
for (const s of /** @type {Severity[]} */ (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'])) {
	if (bySev[s].length) {
		console.log(`\n${s}: ${bySev[s].length}`);
		for (const f of bySev[s]) console.log(`  • ${f.title}`);
	}
}
const blocking = bySev.CRITICAL.length + bySev.HIGH.length;
console.log(`\n${findings.length} findings total; ${blocking} at CRITICAL/HIGH`);
process.exit(blocking ? 1 : 0);
