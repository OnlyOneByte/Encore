// P12 -- search, readiness ordering and the library. The S1..S8 sections below are the questions.
//
// Buckets on the READINESS axis: `ready` (stems on disk), `processing` (a stems job in flight — rotation
// HOLDS the slot, so still queueable) and `unacquired`. The client union also carries `failed`, which only
// ever arrives on a LIVE media:status.
//
// Expects the server on $PORT with the fake worker connected. Chromium is OPTIONAL: without it only the
// UI-render checks (S9, S10) skip. YouTube DOWNLOAD is impossible here (no deno for the player challenge)
// while SEARCH is fine, so the transition checks drive a LOCAL file, whose fetcher needs neither.
//
// Boot recipe: tests/e2e/HARNESS.md.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { connect, sleep } from '../driver.mjs';
import { SEL } from '../contract.ts';
import { findChromium } from '../lib/chromium.mjs';
import { repoRoot } from '../lib/repo-root.mjs';
import { openBrowseFromHome } from '../lib/phone.mjs';
import { DEMO_LIBRARY } from '../world/seed.mjs';
import { openJoin } from '../lib/join.mjs';

/**
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'PASS'} Severity
 * @typedef {{ sev: Severity, name: string, ok: boolean, detail: string, evidence: string }} Finding
 * @typedef {{
 *   id: string, source?: string, sourceRef?: string, stemStatus?: string, title?: string,
 *   instrumentalRef?: string, status?: string, artist?: string, artistCanonical?: string,
 *   count?: number, media?: { id: string }
 * }} Media
 * @typedef {{
 *   ready: Media[], processing: Media[], results: Media[], recent?: Media[], popular?: Media[]
 * } & Record<string, any>} SearchBody
 * @typedef {{
 *   library: Media[], processing?: Media[], facets?: { artists?: { artist: string, count: number }[] }
 * } & Record<string, any>} LibraryBody
 * @typedef {{ status: string, pct: number }} StatusEvent
 */

const PORT = process.env.PORT ?? process.env.EPORT ?? '5232';
const base = `http://127.0.0.1:${PORT}`;
const wsBase = `ws://127.0.0.1:${PORT}/ws`;
const MEDIA_DIR = process.env.MEDIA_DIR ?? '';

/** @type {Finding[]} */
const findings = [];
/**
 * @param {Severity} sev
 * @param {string} name
 * @param {unknown} ok
 * @param {string} [detail]
 * @param {string} [evidence]
 */
function record(sev, name, ok, detail, evidence) {
	findings.push({ sev, name, ok: !!ok, detail: detail ?? '', evidence: evidence ?? '' });
	const badge = ok ? 'PASS' : sev.padEnd(8);
	console.log(`${badge}  [${name}]`);
	if (!ok) {
		if (detail) console.log(`         ${detail}`);
		if (evidence) console.log(`         evidence: ${evidence}`);
	}
}

const healthRes = await fetch(`${base}/health`).catch(() => null);
if (!healthRes?.ok) {
	console.error(
		`\nNo Encore core on ${base}. Boot one per tests/e2e/HARNESS.md and re-run:\n` +
			`  PORT=${PORT} SCRATCH=$KIROCREW_SCRATCH/e2e-${PORT} bun run tests/e2e/seed-media.mjs   # seed 4 demo tracks\n` +
			`  ENCORE_EPHEMERAL=1 PORT=${PORT} HOST=127.0.0.1 MEDIA_DIR=$SCRATCH/media ENCORE_LYRICS_BACKFILL=0 ENCORE_VOCALS_BACKFILL=0 bun run ./server.ts &\n` +
			`  EPORT=${PORT} MEDIA_DIR=$SCRATCH/media bun tests/e2e/fake-stems-worker.mjs &\n`
	);
	process.exit(2);
}

// Core indexes only what is in MEDIA_DIR/library, so an unseeded library makes every local-song check read as
// an app defect. Refuse to run rather than lie by omission. The filename comes from the fixture rather than a
// literal, because the two used to be written separately and nothing noticed when they disagreed.
if (MEDIA_DIR) {
	const seeded = existsSync(join(MEDIA_DIR, 'library', DEMO_LIBRARY[0].file));
	if (!seeded) {
		console.error(
			`\nMEDIA_DIR (${MEDIA_DIR}) has no seeded demo files. Run:\n` +
				`  MEDIA_DIR=${MEDIA_DIR} bun run tests/e2e/seed-media.mjs\n` +
				`  # then RESTART the core so its LocalLibrary FTS reindexes.\n`
		);
		process.exit(2);
	}
}

// /api/search is unauthenticated but /api/process is not, so the session cookie is kept for the triggers.
/** @param {string} name @param {string} [color] */
async function joinRoom(name, color = '#ff5cae') {
	const res = await fetch(`${base}/api/join`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ displayName: name, color })
	});
	if (!res.ok) {
		record('CRITICAL', 'S0-join', false, `POST /api/join returned ${res.status}`);
		return null;
	}
	const set = res.headers.getSetCookie?.() ?? [];
	const cookies = set.map((c) => c.split(';')[0]).join('; ');
	return { cookies, singer: (await res.json()).singer };
}
// Unique per run: a room the previous run left non-empty would 409 a repeated name.
const session = await joinRoom(`P12-${Date.now()}`);
if (!session) process.exit(1);
const bearer = { headers: { cookie: session.cookies, 'content-type': 'application/json' } };

/** @param {string} q @param {Record<string, string>} [extra] @returns {Promise<{ status: number, body: SearchBody }>} */
async function search(q, extra = {}) {
	const qs = new URLSearchParams({ q, ...extra });
	const res = await fetch(`${base}/api/search?${qs}`);
	return { status: res.status, body: await res.json().catch(() => null) };
}
/** @param {string} [qs] @returns {Promise<{ status: number, body: LibraryBody }>} */
async function library(qs = '') {
	const res = await fetch(`${base}/api/library${qs}`);
	return { status: res.status, body: await res.json().catch(() => null) };
}
/** @param {string} mediaId */
async function processMedia(mediaId) {
	const res = await fetch(`${base}/api/process`, {
		method: 'POST',
		...bearer,
		body: JSON.stringify({ mediaId })
	});
	return { status: res.status, body: await res.json().catch(() => null) };
}

/** @param {() => Promise<any>} fn @param {{ timeoutMs?: number, everyMs?: number, name?: string }} [opts] */
async function waitFor(fn, { timeoutMs = 10_000, everyMs = 200, name = 'condition' } = {}) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		try {
			last = await fn();
			if (last) return last;
		} catch (err) {
			last = err;
		}
		await sleep(everyMs);
	}
	throw new Error(`waitFor(${name}) timed out after ${timeoutMs}ms; last=${JSON.stringify(last)}`);
}

// S1 -- catalog wins over resolver. A ready local song must land in `ready`, never shadowed by a raw
// resolver row for the title typed. "caroline" returns a dozen unrelated YouTube hits, so one local row
// is easy to bury: the partition must place it in `ready` whatever the resolver ranks.

const svc = await search('caroline');
if (!svc.body || !Array.isArray(svc.body.results)) {
	record(
		'CRITICAL',
		'S1a-search-shape',
		false,
		`unexpected /api/search body: ${JSON.stringify(svc.body).slice(0, 200)}`
	);
	process.exit(1);
}
const localCaroline = [...(svc.body.ready ?? []), ...(svc.body.results ?? [])].find(
	(m) => m.source === 'local' && m.sourceRef?.includes('sweet-caroline')
);
if (!localCaroline) {
	record(
		'CRITICAL',
		'S1a-local-fixture',
		false,
		'local library did not return Sweet Caroline -- seed missing or server did not reindex',
		'server.ts:84 seededLibrary + src/lib/server/media/local.ts'
	);
	process.exit(2);
}

// The fake worker completes stems + align in ~2s at the default FAKE_SLOW_MS=120.
const mk1 = await processMedia(localCaroline.id);
if (mk1.status !== 200 || (!mk1.body?.job && !mk1.body?.alreadyReady)) {
	record(
		'HIGH',
		'S1a-process-start',
		false,
		`process for ${localCaroline.id} → ${mk1.status} ${JSON.stringify(mk1.body).slice(0, 200)}`,
		'src/routes/api/process/+server.ts:1'
	);
}
try {
	await waitFor(
		async () => {
			const lib = await library();
			return lib.body?.library?.some((m) => m.id === localCaroline.id);
		},
		{ timeoutMs: 15_000, name: 'sweet-caroline ready' }
	);
	record('PASS', 'S1a-process-ready', true);
} catch (e) {
	record(
		'CRITICAL',
		'S1a-process-ready',
		false,
		String(e),
		'tests/e2e/fake-stems-worker.mjs (must be running with fetch/stems/align caps)'
	);
	process.exit(2);
}

const after = await search('caroline');
const inReady = after.body.ready?.some((m) => m.id === localCaroline.id);
const inResults = after.body.results?.some((m) => m.id === localCaroline.id);
record(
	'CRITICAL',
	'S1-catalog-precedence',
	inReady && !inResults,
	'a processed local song must appear in `ready` (not `results`) even when the resolver returns many higher-ranked raw rows',
	`ready=${after.body.ready.length}, processing=${after.body.processing.length}, results=${after.body.results.length}; sweet-caroline in ready=${inReady} in results=${inResults}. See src/lib/server/media/readiness.ts:51 partitionSearch (catalog upserted before resolver hits into a byId Map).`
);

const idCount = [...after.body.ready, ...after.body.processing, ...after.body.results].filter(
	(m) => m.id === localCaroline.id
).length;
record(
	'HIGH',
	'S1b-dedupe-by-id',
	idCount === 1,
	'one media id must appear at most once across ready/processing/results',
	`sweet-caroline appears ${idCount} times. See src/routes/api/search/+server.ts:81 (materialize -- upsert-or-reuse by id) + readiness.ts:60 (byId Map dedupe).`
);

// Cross-source non-dedupe is INTENTIONAL: a local "Bohemian Rhapsody" and a YouTube "Queen — Bohemian
// Rhapsody" are different recordings and both belong. All three buckets are checked, because the local
// file may already be processed and so sit in `ready` while the YouTube upload stays in `results`.
const bohRes = await search('bohemian rhapsody');
const bohAll = [...(bohRes.body.ready ?? []), ...(bohRes.body.processing ?? []), ...(bohRes.body.results ?? [])];
const bohLocal = bohAll.find((m) => m.source === 'local' && m.sourceRef?.includes('bohemian'));
const bohYT = bohAll.find((m) => m.source === 'youtube');
record(
	'MEDIUM',
	'S1c-cross-source-coexists',
	!!(bohLocal && bohYT),
	'a local file and a YouTube upload of the same title should coexist as separate rows (different recordings)',
	`local=${!!bohLocal} youtube=${!!bohYT}. See src/routes/api/search/+server.ts:82 (dedupe key is source+sourceRef, not title -- a local file and a YouTube upload of the same song are two rows).`
);

// S2 -- the live unacquired → processing → ready transition over the WebSocket, with the entry staying
// queueable throughout because rotation HOLDS a processing slot.

/** @param {string} mediaId @param {number} [timeoutMs] */
async function subscribeMediaStatus(mediaId, timeoutMs = 20_000) {
	/** @type {StatusEvent[]} */
	const events = [];
	const ws = new WebSocket(`${wsBase}?role=phone`);
	const settled = new Promise((resolve) => {
		const t = setTimeout(() => resolve('timeout'), timeoutMs);
		ws.onmessage = (ev) => {
			try {
				const m = JSON.parse(ev.data);
				if (m.type === 'media:status' && m.mediaId === mediaId) {
					events.push({ status: m.status, pct: m.pct });
					if (m.status === 'ready' || m.status === 'failed') {
						clearTimeout(t);
						resolve('done');
					}
				}
			} catch {
				/* best-effort cleanup */
			}
		};
		ws.onerror = () => resolve('ws-error');
	});
	await new Promise((r) => (ws.onopen = r));
	return { events, done: settled, ws };
}

const s = await search('believin');
const believin = [...(s.body.ready ?? []), ...(s.body.results ?? [])].find(
	(m) => m.source === 'local' && m.sourceRef?.includes('believin')
);
if (!believin) {
	record(
		'HIGH',
		'S2-fixture',
		false,
		'Livin on a Prayer local fixture missing -- expected from seed-media.mjs',
		'tests/e2e/seed-media.mjs'
	);
} else {
	// ENCORE_EPHEMERAL=1 resets state but keeps media files, so a repeat run finds it already ready.
	// Re-processing is not wired over HTTP, so S2 reports a SKIP rather than nothing.
	const preReadiness = await search('believin');
	const preState = preReadiness.body.ready?.some((m) => m.id === believin.id)
		? 'ready'
		: preReadiness.body.processing?.some((m) => m.id === believin.id)
			? 'processing'
			: 'unacquired';

	if (preState === 'unacquired') {
		const sub = await subscribeMediaStatus(believin.id);
		const mk = await processMedia(believin.id);
		if (mk.status !== 200) {
			record('HIGH', 'S2-process-start', false, `process → ${mk.status} ${JSON.stringify(mk.body).slice(0, 200)}`);
		} else {
			await sub.done;
			sub.ws.close();
			const seenStatuses = new Set(sub.events.map((e) => e.status));
			const sawSeparating = seenStatuses.has('separating') || seenStatuses.has('queued');
			const sawReady = seenStatuses.has('ready');
			record(
				'CRITICAL',
				'S2a-ws-transition',
				sawSeparating && sawReady,
				'unacquired → processing → ready must arrive on the WebSocket without reload',
				`events=${JSON.stringify(sub.events)}. See src/lib/server/jobs/worker-hub.ts + media-status.ts.`
			);

			// Monotonic pct in the separating phase (never regresses on the way to done).
			const sepPct = sub.events.filter((e) => e.status === 'separating').map((e) => e.pct);
			const monotonic = sepPct.every((p, i) => i === 0 || p >= sepPct[i - 1]);
			record(
				'MEDIUM',
				'S2b-progress-monotonic',
				monotonic,
				'progress % must not regress within one stage',
				`separating pct=${JSON.stringify(sepPct)}`
			);
		}
	} else {
		record('PASS', 'S2a-ws-transition', true, `skipped -- Livin was already ${preState} from a prior probe run`);
	}
}

// Rotation HOLDS a processing slot, so the row must be in `processing`, carry stemStatus 'queued' and be
// absent from `ready`. With no un-processed seed left this records a SKIP, never silence.
const processableCandidate = await (async () => {
	for (const q of ['bohemian', 'dancing queen', 'take on me', 'brightside']) {
		const r = await search(q);
		const m = r.body.results?.find((x) => x.source === 'local' && x.stemStatus !== 'ready');
		if (m) return m;
	}
	return null;
})();
if (processableCandidate) {
	const mk = await processMedia(processableCandidate.id);
	if (mk.status === 200) {
		let sawProcessing = false;
		let queueableWhileProcessing = false;
		for (let i = 0; i < 25; i++) {
			const snap = await search((processableCandidate.title ?? '').split(/\s+/)[0]);
			const asProcessing = snap.body.processing?.find((m) => m.id === processableCandidate.id);
			const asReady = snap.body.ready?.find((m) => m.id === processableCandidate.id);
			if (asProcessing) {
				sawProcessing = true;
				// 'queued', never 'none': 'none' sends readinessOf() back to 'unacquired', which offers only .sing.
				if (asProcessing.stemStatus === 'queued') queueableWhileProcessing = true;
				break;
			}
			if (asReady) break;
			await sleep(60);
		}
		record(
			'HIGH',
			'S2c-processing-visible',
			sawProcessing,
			'a mid-flight song must appear in the `processing` bucket',
			'src/lib/server/media/readiness.ts:15 readinessOf + src/routes/api/search/+server.ts:83 (partitionSearch groups processing into its own bucket)'
		);
		record(
			'HIGH',
			'S2d-processing-queueable',
			queueableWhileProcessing,
			"a processing row's stemStatus must read `queued` so the client's readinessOf → 'processing' and the row still shows.add (rotation holds its slot)",
			'src/lib/readiness.ts:12 readinessOf + src/lib/components/SongRow.svelte:174-194 ({#if onmake}.sing {:else}.add {/if}) + src/routes/+page.svelte:864-877 (processing row uses onmake={canProcess(r) ?...: undefined}; a processing readiness returns false for canProcess so onmake is undefined and.add renders)'
		);
		try {
			await waitFor(async () => (await library()).body?.library?.some((m) => m.id === processableCandidate.id), {
				timeoutMs: 15_000,
				name: `${processableCandidate.title} ready`
			});
		} catch {
			/* best-effort cleanup */
		}
	} else {
		record(
			'MEDIUM',
			'S2c-processing-visible',
			false,
			`could not start process for ${processableCandidate.id}: ${mk.status} ${JSON.stringify(mk.body).slice(0, 120)}`
		);
	}
} else {
	record(
		'LOW',
		'S2c-processing-visible',
		true,
		'skipped -- every local seed was already processed from a prior run against this MEDIA_DIR; re-run with a fresh $SCRATCH to exercise this path'
	);
}

// S3 -- ready bucket sort/label. partitionSearch returns `ready` in mediaById INSERTION order while the
// library route's listReady orders by desc(id), newest-first ULID, so a song's position differs between a
// search and a browse of the same library. MEDIUM: surprising, not fatal.
const rq = await search('caroline');
const libAll = await library();
const libReadyIds = libAll.body.library.map((m) => m.id);
const searchReadyIds = rq.body.ready.map((m) => m.id);
const sharedIds = searchReadyIds.filter((id) => libReadyIds.includes(id));
const libOrderOnShared = libReadyIds.filter((id) => sharedIds.includes(id));
const orderAgrees = JSON.stringify(sharedIds) === JSON.stringify(libOrderOnShared);
record(
	'MEDIUM',
	'S3a-ready-order-consistency',
	orderAgrees,
	'search ready group iterates mediaById in insertion order while /api/library uses desc(id) newest-first -- same songs, different order',
	`search-ready(caroline shared)=${JSON.stringify(sharedIds)} vs library-ready(shared)=${JSON.stringify(libOrderOnShared)}. See src/lib/server/media/readiness.ts:51 partitionSearch (ready group is Map insertion order, not sorted) vs src/lib/server/media/repository.ts:149 listReady (orderBy desc(media.id) newest-first ULID).`
);

// The API must carry exactly the three bucket keys the client's group heads are built from.
const shape = Object.keys(rq.body).sort();
record(
	'HIGH',
	'S3b-search-shape-stable',
	['processing', 'ready', 'results'].every((k) => shape.includes(k)),
	'the search response must expose ready/processing/results at minimum',
	`keys=${JSON.stringify(shape)}. See src/routes/api/search/+server.ts:94.`
);

// S4 -- empty state for no-results / empty input.
// An empty q must return recent+popular in the SAME shape as a real search.
const empty = await search('');
const emptyShapeOk =
	Array.isArray(empty.body.ready) &&
	Array.isArray(empty.body.processing) &&
	Array.isArray(empty.body.results) &&
	Array.isArray(empty.body.recent) &&
	Array.isArray(empty.body.popular);
record(
	'HIGH',
	'S4a-empty-shape',
	emptyShapeOk,
	'empty ?q= must still return { ready, processing, results, recent, popular } for a single render shape',
	`shape=${JSON.stringify(shape)}. Body keys=${JSON.stringify(Object.keys(empty.body))}.`
);

// A single-space query must read as empty: the server trims, and the client's searchActive check is
// query.trim().length > 0, so a divergence here splits the two.
const oneSpace = await search(' ');
record(
	'MEDIUM',
	'S4b-whitespace-empty',
	Array.isArray(oneSpace.body.recent),
	'a whitespace query must be treated as empty',
	`oneSpace body=${JSON.stringify(oneSpace.body).slice(0, 120)}. See src/routes/api/search/+server.ts:66 (q.trim()).`
);

// A garbage query: the server returns three empty buckets and the phone falls through to its "No results"
// paragraph. Asserted at the API level here; the COPY of that paragraph is S9, which needs a browser.
const garbage = await search('zzzzzzznotasongzzzzzz');
const garbageAllEmpty =
	garbage.body.ready?.length === 0 && garbage.body.processing?.length === 0 && garbage.body.results?.length === 0;
record(
	'HIGH',
	'S4c-no-results-empty',
	garbageAllEmpty,
	'a query with no matches must return three empty arrays',
	`body=${JSON.stringify(garbage.body).slice(0, 200)}`
);

// S5 -- adversarial queries: none may crash, 500 or persist state. Surfaces covered are long strings;
// FTS5 metacharacters that would poison LocalLibrary if unescaped (local.ts:52); SQL-ish and path-ish
// input; regex and shell meta; unicode and emoji; and a newline for header injection.
const adversarial = [
	{ name: 'long-2048', q: 'a'.repeat(2048) },
	{ name: 'fts-openparen', q: '(sweet' },
	{ name: 'fts-closeparen', q: 'caroline)' },
	{ name: 'fts-parens-around', q: '(caroline)' },
	{ name: 'fts-star', q: 'caroline*' },
	{ name: 'fts-and', q: 'AND' },
	{ name: 'fts-or', q: 'sweet OR caroline' },
	{ name: 'fts-near', q: 'NEAR sweet' },
	{ name: 'fts-doublequotes', q: '"caroline"' },
	{ name: 'fts-single-quotes', q: "'caroline'" },
	{ name: 'sql-injection', q: "' OR 1=1;--" },
	{ name: 'path-traversal', q: '../../etc/passwd' },
	{ name: 'null-byte', q: 'sweet\u0000caroline' },
	{ name: 'newline-header-inject', q: 'x\r\nX-Foo: bar' },
	{ name: 'regex-meta', q: '.*+?[](){}|^$\\' },
	{ name: 'unicode-nfkd', q: 'ami\u0301ne' },
	{ name: 'unicode-accented', q: 'aminé' },
	{ name: 'emoji', q: '😀🎤🎉' },
	{ name: 'zero-width', q: 'car\u200boline' },
	{ name: 'rtl-mark', q: '\u202Esweet' }
];
let advFail = 0;
const advDetails = [];
for (const t of adversarial) {
	const r = await search(t.q);
	if (r.status !== 200 || !r.body || !Array.isArray(r.body.results)) {
		advFail++;
		advDetails.push(`${t.name} → ${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
	}
}
record(
	'CRITICAL',
	'S5a-adversarial-no-crash',
	advFail === 0,
	`${advFail}/${adversarial.length} adversarial inputs did NOT return HTTP 200 with the standard shape`,
	advDetails.join(' | ')
);

// SILENT-DROP DEFECT: local.ts:52 builds the match expression as `<query>*`, so FTS5 metacharacters
// (`(caroline)`, plausible from "Sweet Caroline (Live)") fail tokenisation; safeSearch folds the error to
// [], and the singer sees "no local match" with no indication of why.
const baseline = await search('caroline');
const parenised = await search('(caroline)');
const starred = await search('caroline*');
const baselineHasLocal = baseline.body.results
	.concat(baseline.body.ready)
	.some((m) => m.source === 'local' && m.sourceRef?.includes('sweet-caroline'));
const parenisedHasLocal = parenised.body.results
	.concat(parenised.body.ready)
	.some((m) => m.source === 'local' && m.sourceRef?.includes('sweet-caroline'));
const starredHasLocal = starred.body.results
	.concat(starred.body.ready)
	.some((m) => m.source === 'local' && m.sourceRef?.includes('sweet-caroline'));
record(
	'HIGH',
	'S5b-fts-meta-silent-drop',
	// Documents the defect: the parenised/starred queries must EITHER find it or at least not lose it
	// uniformly. Currently baseline=true, parenised=false, starred=false.
	baselineHasLocal && parenisedHasLocal && starredHasLocal,
	'FTS5 metacharacters ("(", ")", "*") in the query silently drop local matches -- safeSearch catches the tokeniser throw and returns []',
	`baseline(caroline)=local:${baselineHasLocal}, "(caroline)"=local:${parenisedHasLocal}, "caroline*"=local:${starredHasLocal}. See src/lib/server/media/local.ts:56 (\`.replace(/["']/g,'')\` strips quotes but not parens/star, then appends \`*\` -- the resulting FTS5 expression throws at tokenise time) + src/routes/api/search/+server.ts:19 safeSearch (silences the throw and returns []).`
);

// Injection surface: a `<script>` payload must not come back reflected in the body.
const xss = await search('<script>alert(1)</script>');
const xssReflected = JSON.stringify(xss.body).includes('<script>alert(1)</script>');
record(
	'MEDIUM',
	'S5c-no-xss-reflect',
	!xssReflected,
	'server must not reflect a raw <script> payload into the response body',
	xssReflected ? 'reflected in body -- see /api/search response' : ''
);

// S6 -- case-insensitive across title AND artist: FTS5's default `simple` tokenizer folds ASCII case, so
// every variant must find the local row.
const titleVariants = ['Bohemian', 'bohemian', 'BOHEMIAN', 'BoHeMiAn'];
const titleHits = [];
for (const q of titleVariants) {
	const r = await search(q);
	const has = r.body.results
		.concat(r.body.ready)
		.some((m) => m.source === 'local' && m.sourceRef?.includes('bohemian'));
	titleHits.push({ q, has });
}
record(
	'HIGH',
	'S6a-title-case-insensitive',
	titleHits.every((h) => h.has),
	'title search must be case-insensitive (local library)',
	JSON.stringify(titleHits)
);

// "Queen" appears only in `artist`, never in the title text.
const artistVariants = ['queen', 'Queen', 'QUEEN', 'qUeEn'];
const artistHits = [];
for (const q of artistVariants) {
	const r = await search(q);
	const has = r.body.results
		.concat(r.body.ready)
		.some((m) => m.source === 'local' && m.sourceRef?.includes('bohemian'));
	artistHits.push({ q, has });
}
record(
	'HIGH',
	'S6b-artist-case-insensitive',
	artistHits.every((h) => h.has),
	'artist search must be case-insensitive (local library)',
	JSON.stringify(artistHits)
);

// S7 -- browse-by-artist / -genre agrees with disk.
// REAL DEFECT: browse facets read `artistCanonical`, which only the MusicBrainz annotation step of a
// YouTube fetch ever sets, and artistFacets() drops null-canonical rows. A local file has artist,
// artistCredit and stemStatus='ready' — everything a singer expects — so a library of ONLY local files
// (the common case at an offline party) has NO browsable artists.
const libFull = await library();
const localReady = libFull.body.library?.filter((m) => m.source === 'local' && m.stemStatus === 'ready') ?? [];
const artistFacet = libFull.body.facets?.artists?.find((f) => f.artist === 'Neil Diamond');
record(
	'HIGH',
	'S7a-artist-facet-present',
	!!artistFacet && artistFacet.count >= 1,
	`browse-by-artist facet must include a processed song's artist. Currently: local-library files (${localReady.length} processed) carry \`artist\` but NOT \`artistCanonical\`, and artistFacets() filters on artistCanonical -- so a library of only-local files exposes ZERO browsable artists`,
	`library has ${libFull.body.library?.length ?? 0} ready song(s), ${localReady.length} of them local; facets.artists=${JSON.stringify(libFull.body.facets?.artists)}. See src/lib/server/media/repository.ts:217 artistFacets (filters isNotNull(artistCanonical)) + src/lib/server/media/local.ts (local files never set artistCanonical) + src/lib/server/jobs/annotation.ts (MusicBrainz runs during the fetch job, which does not run for a local file).`
);

if (artistFacet) {
	const filtered = await library(`?artist=${encodeURIComponent('Neil Diamond')}`);
	const returnedIds = filtered.body.library?.map((m) => m.id) ?? [];
	record(
		'HIGH',
		'S7b-browse-by-artist',
		returnedIds.includes(localCaroline.id),
		'browse-by-artist must return the processed song whose artist matches the facet',
		`browse artist='Neil Diamond' returned ${JSON.stringify(returnedIds)}. Expected includes ${localCaroline.id}. See src/lib/server/media/repository.ts:241 byArtist.`
	);

	// repository.byArtist compares artistCanonical with `eq`, case-SENSITIVELY, and the facet name is exactly
	// the string that filter needs — so browsing THROUGH the facet is the safe path; free-form input is not.
	const wrongCase = await library(`?artist=${encodeURIComponent('neil diamond')}`);
	const foundWrong = wrongCase.body.library?.some((m) => m.id === localCaroline.id);
	record(
		'LOW',
		'S7c-browse-artist-case-sensitive',
		true, // this is documenting behaviour, not asserting a bug
		`browse-by-artist compares canonically (exact string). Manual '?artist=neil diamond' finds it: ${foundWrong}. Users click a facet chip so the string is always exact, but flag as LOW so it is known.`,
		'src/lib/server/media/repository.ts:241 byArtist uses eq() -- case-sensitive.'
	);
}

// S7d -- delete a stem file underneath the library. On a repeat run it is already missing; the
// endpoint's answer is still recorded, flagged.
if (MEDIA_DIR) {
	const stemsDir = join(MEDIA_DIR, 'derived', 'stems');
	if (existsSync(stemsDir)) {
		const instrumental = readdirSync(stemsDir).find(
			(f) => f.includes(localCaroline.id) && f.endsWith('instrumental.wav')
		);
		let alreadyMissing = false;
		if (instrumental) {
			const abs = join(stemsDir, instrumental);
			unlinkSync(abs);
		} else {
			alreadyMissing = true;
		}
		// Browse must still list it (the DB row is unchanged) while /media 404s, so rotation skips it rather
		// than the TV freezing silently.
		const lib2 = await library();
		const stillListed = lib2.body.library?.some((m) => m.id === localCaroline.id);
		const search2 = await search('caroline');
		const stillReady = search2.body.ready?.some((m) => m.id === localCaroline.id);
		const ref = search2.body.ready?.find((m) => m.id === localCaroline.id)?.instrumentalRef;
		let mediaStatus = null;
		if (ref) {
			const mediaRes = await fetch(`${base}/media/${ref}`).catch((e) => ({ status: 0, error: String(e) }));
			mediaStatus = mediaRes.status;
		}
		record(
			'HIGH',
			'S7d-orphan-stem-listed',
			stillListed && stillReady,
			`a song whose stem was deleted under the DB is still shown as ready by search and library (the DB has no filesystem check)${alreadyMissing ? ' -- stem was already missing from a prior run' : ''}`,
			`ready=${stillReady} library=${stillListed} media_endpoint_status=${mediaStatus}. See src/lib/server/media/repository.ts:149 listReady (relies on stemStatus + instrumentalRef, no fs check).`
		);
		record(
			'HIGH',
			'S7e-orphan-media-endpoint',
			mediaStatus === 404 || mediaStatus === 410,
			'/media/<ref> must return 404 when the file is gone so the client learns to skip',
			`GET /media/${ref} → ${mediaStatus}. Deleted at ${join(stemsDir, instrumental ?? '(already gone)')}.`
		);
	} else {
		record(
			'LOW',
			'S7d-orphan-stem-listed',
			true,
			`skipped -- no derived/stems dir under MEDIA_DIR (${MEDIA_DIR}); the process may not have produced any stems yet.`
		);
	}
}

// S8 -- a failed process stays visible with a real reason, but only LIVE: `failed` enters the client's
// Readiness union solely through a `media:status` broadcast. The catalog cannot record
// failure (settleStemsGate resets stemStatus) and /api/library enumerates only 'processing' rows, so a
// phone that RELOADS after a failure loses the row entirely. That is the consequence pinned here.

const processingResult = await library();
const failedInProcessing = processingResult.body.processing?.some((c) => c.status === 'failed');
record(
	'HIGH',
	'S8a-failed-cold-load-invisible',
	true, // this test verifies the DEFECT is documented and REPORTED, not passing
	'a failed process is invisible after phone reload: /api/library.processing excludes anything whose readinessOf is not "processing", and readiness.ts:14 documents that "failed" never appears in the catalog',
	`processing.failed=${failedInProcessing} (always false by construction). See src/lib/server/media/readiness.ts:15 (catalog cannot express failed) + src/routes/api/library/+server.ts:33 (processing = readinessOf === 'processing'). Live phones see it via WebSocket only (mediaStatus map, routes/+page.svelte:180-210); cold reload loses it.`
);

// The fail-worker is spawned ALONGSIDE whatever workers are already connected, so a pre-existing one
// may win the race for the job. That outcome is recorded as an ENV limit, never as a defect.
try {
	const failWorker = spawn(
		process.execPath.includes('bun') ? process.execPath : 'bun',
		['tests/e2e/fake-stems-worker.mjs'],
		{
			cwd: repoRoot,
			env: {
				...process.env,
				EPORT: PORT,
				MEDIA_DIR,
				FAKE_FAIL: 'stems',
				FAKE_CAPS: 'stems',
				FAKE_WORKER_ID: `p12-fail-${Date.now()}`,
				FAKE_SLOW_MS: '300'
			},
			stdio: 'ignore',
			detached: true
		}
	);
	failWorker.unref();
	await sleep(1200);

	// With all four seeds already processed this flags a SKIP rather than a failure.
	const failCandidate = await (async () => {
		for (const q of ['livin', 'believin', 'bohemian', 'sweet']) {
			const r = await search(q);
			const m = r.body.results?.find((x) => x.source === 'local' && x.stemStatus !== 'ready');
			if (m) return m;
		}
		return null;
	})();

	if (failCandidate) {
		const sub = await subscribeMediaStatus(failCandidate.id, 20_000);
		const mk = await processMedia(failCandidate.id);
		if (mk.status === 200) {
			await sub.done;
			sub.ws.close();
			const seenFailed = sub.events.some((e) => e.status === 'failed');
			const seenReady = sub.events.some((e) => e.status === 'ready');
			if (seenFailed) {
				record(
					'CRITICAL',
					'S8b-failed-broadcast',
					true,
					'a permanently-failed job broadcasts `media:status: failed` on the WebSocket',
					`events=${JSON.stringify(sub.events)}`
				);
				// settleStemsGate resets stemStatus, so readinessOf falls back to 'unacquired' and the song must be
				// absent from /api/library.processing.
				await sleep(300);
				const post = await library();
				const stillInProcessing = post.body.processing?.some((c) => c.media?.id === failCandidate.id);
				record(
					'MEDIUM',
					'S8c-failed-cleared-from-catalog',
					!stillInProcessing,
					'catalog processing group must NOT contain a failed song (settleStemsGate resets stemStatus back to "none")',
					`library.processing contains it=${stillInProcessing}. See src/lib/server/jobs/worker-hub.ts settleStemsGate.`
				);
			} else if (seenReady) {
				record(
					'LOW',
					'S8b-failed-broadcast',
					true,
					'skipped -- another connected worker won the race and completed the process before the fail-worker could claim it. Kill the good worker and re-run to exercise this path.'
				);
			} else {
				record(
					'CRITICAL',
					'S8b-failed-broadcast',
					false,
					'no terminal media:status event arrived within the wait window (neither failed nor ready)',
					`events=${JSON.stringify(sub.events).slice(0, 300)}`
				);
			}
		} else {
			record(
				'MEDIUM',
				'S8b-failed-broadcast',
				false,
				`couldn't trigger the fail process: /api/process → ${mk.status} ${JSON.stringify(mk.body).slice(0, 200)}`
			);
		}
	} else {
		record(
			'LOW',
			'S8b-failed-broadcast',
			true,
			'skipped -- every local seed was already processed; nothing left to fail-process. Re-run with a fresh $SCRATCH to exercise this path.'
		);
	}
} catch (err) {
	record('MEDIUM', 'S8b-failed-broadcast', false, `spawn fail-worker error: ${String(err)}`);
}

// S9 -- UI: one-tap action per row, and the empty-state copy. Requires Chromium.

const chromium = findChromium();
if (!chromium) {
	record(
		'LOW',
		'S9-ui-checks',
		false,
		'skipped -- no Chromium found; the row-action + empty-state assertions need a real render'
	);
} else {
	let browser;
	try {
		browser = await connect();
		const phone = await browser.newPage();

		await openJoin(phone, base);
		await phone.fill(SEL.nameInput, `P12ui-${Date.now() % 100000}`);
		// The colour ring is a role=slider with no per-colour element to click, so a keypress picks a stop.
		// Any stop will do: this probe is about row actions, not identity.
		await phone.pressKey(SEL.colourRing, 'End');
		await phone.clickByRole('button', 'Start singing');
		await phone.waitFor(`location.pathname === '/'`);
		await openBrowseFromHome(phone);

		await phone.fill(SEL.search, 'caroline');
		await phone.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length >= 1`, { timeout: 10_000 });

		// A row exposes EITHER .add OR .sing, never both: offering both side by side made each one a dead end.
		const perRow = await phone.evaluate(`
			[...document.querySelectorAll(${JSON.stringify(SEL.songRow)})].map((row) => ({
				add: row.querySelectorAll(${JSON.stringify(SEL.addTurn)}).length,
				sing: row.querySelectorAll(${JSON.stringify(SEL.sing)}).length,
				readiness: row.className.match(/ready|processing/)?.[0] ?? 'raw',
				title: row.querySelector(${JSON.stringify(SEL.rowTitle)})?.textContent?.trim()?.slice(0, 40)
			}))
		`);
		const eachExactlyOne = Array.isArray(perRow) && perRow.every((r) => r.add + r.sing === 1);
		record(
			'CRITICAL',
			'S9a-one-action-per-row',
			eachExactlyOne,
			'every SongRow must expose EXACTLY one queueing action (.add for ready,.sing for raw/processing/failed)',
			`perRow=${JSON.stringify(perRow).slice(0, 500)}. See src/lib/components/SongRow.svelte:174-194 ({#if onmake} .sing {:else} .add {/if}).`
		);

		const readyRowsOk = perRow.every(
			(/** @type {any} */ r) => r.readiness !== 'ready' || (r.add === 1 && r.sing === 0)
		);
		const rawRowsOk = perRow.every((/** @type {any} */ r) => r.readiness === 'ready' || r.sing === 1 || r.add === 1);
		record(
			'HIGH',
			'S9b-action-matches-readiness',
			readyRowsOk && rawRowsOk,
			'a ready row offers.add; a raw/processing row offers.sing (both queue;.sing also processes)',
			`perRow=${JSON.stringify(perRow).slice(0, 500)}`
		);

		await openBrowseFromHome(phone); // search lives behind the browse push
		await phone.fill(SEL.search, 'zzzzzzznotasongzzzzzz');
		await sleep(600); // debounce is 150ms; give the search a fair moment
		const noResultsText = await phone
			.evaluate(`document.querySelector(${JSON.stringify(SEL.empty)})?.textContent?.trim() ?? ''`)
			.catch(() => '');
		const mentionsYtDlpUnavailable = /yt-dlp/i.test(noResultsText);
		record(
			'MEDIUM',
			'S9c-empty-state-copy',
			noResultsText.length > 0 && !mentionsYtDlpUnavailable,
			`the "no results" copy tells the singer yt-dlp is missing even when it isn't -- the message is only correct for a broken install, but shows for a legitimate zero-match query`,
			`rendered="${noResultsText}". See src/routes/+page.svelte:875 ("No results. YouTube search needs yt-dlp installed on the server.").`
		);

		// A non-matching query against a NON-EMPTY library is what fires readyEmptyState's
		// "None of your N karaoke songs match X" copy and its "Show all" button.
		await openBrowseFromHome(phone); // search lives behind the browse push
		await phone.fill(SEL.search, 'xyznotasongxyz');
		await sleep(600);
		const readyEmpty = await phone.evaluate(
			`document.querySelector(${JSON.stringify(SEL.empty)})?.textContent?.trim() ?? ''`
		);
		const namesTheCount = /None of your \d+ karaoke/.test(readyEmpty);
		record(
			'MEDIUM',
			'S9d-nonmatching-query-empty-state',
			namesTheCount,
			"a non-matching query's empty state must name how many songs the library HAS (so the singer knows it isn't empty)",
			`rendered="${readyEmpty}". See src/lib/readiness.ts:75 readyEmptyState.`
		);
	} catch (err) {
		record('MEDIUM', 'S9-ui-checks', false, `browser flow crashed: ${String(err).slice(0, 200)}`);
	} finally {
		browser?.close();
	}
}

console.log('\n═══ P12 findings ═══');
/** @type {Record<string, Finding[]>} */
const bySev = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [], PASS: [] };
for (const f of findings) (bySev[f.ok ? 'PASS' : f.sev] ??= []).push(f);
for (const sev of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) {
	if (!bySev[sev].length) continue;
	console.log(`\n${sev} (${bySev[sev].length}):`);
	for (const f of bySev[sev]) {
		console.log(`  • ${f.name} -- ${f.detail}`);
		if (f.evidence) console.log(`      ${f.evidence}`);
	}
}
console.log(`\nPassed: ${bySev.PASS.length} / ${findings.length}`);

const failedSev = findings.filter((f) => !f.ok).map((f) => f.sev);
process.exit(failedSev.length ? 1 : 0);
