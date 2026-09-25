// P12 — SEARCH, READINESS PARTITIONING AND THE LIBRARY.
//
// Buckets on the READINESS axis: `ready` (stems on disk), `processing` (a stems job in flight — rotation HOLDS
// the slot, so still queueable) and `results` (unacquired). The client union also carries `failed`, which only
// ever arrives on a LIVE media:status.
//
// THE TWO CLAIMS THIS PROBE EXISTS FOR, and where its real defects lived:
//   PARTITIONING — a song appears in exactly ONE of ready / processing / results, and a song the catalog
//     already has processed lands in `ready` however the resolver ranked it. `partitionSearch` in
//     src/lib/server/media/readiness.ts is the whole mechanism: catalog entries are inserted FIRST so an
//     already-processed song is never shadowed by a raw resolver row for the same title.
//   DEDUPE — one media id appears at most once across the three buckets, because `partitionSearch` collapses
//     catalog and resolver hits through a single `byId` Map, and /api/search's own `materialize` step is
//     upsert-or-reuse by ORIGIN identity before that.
//
// WHAT WENT AWAY. The old probe opened with two preconditions: a core answering /health, and a MEDIA_DIR with
// the demo files in it ("refuse to run rather than lie by omission"). The `world` fixture now guarantees both —
// it seeds `DEMO_LIBRARY` into a private MEDIA_DIR and boots a core on it per test — so both preconditions are
// gone. What did NOT come across is the seed check's second half: whether core INDEXED what was seeded is
// still a real question — the scan is a DETACHED boot pass that spawns one ffmpeg per file and SKIPS any file
// whose duration it cannot read, so /health answers before the index exists. `world.awaitDemoTrack` is what
// waits for it and names that cause, and every test below that needs a local row goes through it.
//
// READS GO THROUGH THE PAGE, not through the test process. A search is something a phone does, `/api/process`
// refuses an anonymous caller, and a request issued from the page is the one `page.route` can shape — which is
// how the partition and dedupe claims above are mutation-provable at all.
//
// NOT PORTED, each for a stated reason — see the port notes:
//   S3a-ready-order-consistency  vacuous against this fixture: no demo title shares a query term with
//     another, so `search('caroline').ready` and /api/library overlap on at most ONE id and the order
//     comparison cannot fail. The ordering divergence it documents (partitionSearch returns Map insertion
//     order; repository.listReady orders by desc(id), newest-first ULID) is real and reproducible with a query
//     matching two ready songs.
//   S6b-artist-case-insensitive, S7a-artist-facet-present, S7b-browse-by-artist  the demo library carries NO
//     artist: `trackNameFromFile` only reads one off the `Artist - Title.ext` form and every fixture file is
//     kebab-case, so there is no "Neil Diamond" and no "Queen" to find. S7b was already unreachable in the old
//     probe — it sat behind `if (artistFacet)`, which is false for the same reason.
//   S7c, S8a  both `record(…, true, …)` with a literal: prose documenting behaviour, never an assertion.
//   S9d-nonmatching-query-empty-state  its measurement no longer exists. It read the FIRST `.encore-empty`,
//     which on a zero-match search is the yt-dlp notice and never was the ready-group empty state, and the copy
//     it matched (`None of your N karaoke songs match X`) has since been replaced by `Nothing matches “q”.`
//     beside a `Show all N` button. Porting the regex would enshrine an assertion that is wrong twice.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome } from '../../world/actors';
import { DEMO_LIBRARY } from '../../world/seed';
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
// `ws`, not Node's global: the same reason world/presence.ts gives — the built-in accepts no handshake
// headers. Nothing here needs a cookie, but one WebSocket implementation per suite beats two.
import { WebSocket } from 'ws';
import type { World } from '../../world/fixtures';
import type { Page } from '@playwright/test';

interface Media {
	id: string;
	title: string;
	source: string;
	sourceRef?: string;
	stemStatus?: string;
	instrumentalRef?: string;
}
interface SearchBody {
	ready: Media[];
	processing: Media[];
	results: Media[];
	recent?: Media[];
	popular?: Media[];
}
interface LibraryBody {
	library: Media[];
	processing?: { media: Media; status: string }[];
}
interface Api<T> {
	status: number;
	body: T;
}

/** A GET issued BY THE PAGE, so it carries the phone's session and is interceptable by `page.route`. */
async function apiGet<T>(page: Page, path: string): Promise<Api<T>> {
	return page.evaluate(async (p) => {
		const r = await fetch(p);
		return { status: r.status, body: (await r.json().catch(() => null)) as never };
	}, path);
}

async function search(page: Page, q: string): Promise<Api<SearchBody>> {
	return apiGet<SearchBody>(page, `/api/search?q=${encodeURIComponent(q)}`);
}

async function library(page: Page): Promise<Api<LibraryBody>> {
	return apiGet<LibraryBody>(page, '/api/library');
}

/** `/api/process` is the one authenticated call here, which is why every read goes through the page too. */
async function processMedia(
	page: Page,
	mediaId: string
): Promise<Api<{ job?: { id: string }; alreadyReady?: boolean }>> {
	return page.evaluate(async (id) => {
		const r = await fetch('/api/process', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ mediaId: id })
		});
		return { status: r.status, body: (await r.json().catch(() => null)) as never };
	}, mediaId);
}

/** Drive one local song all the way to stems-on-disk, and hand back the row. `token` is a bare single-word
 *  match — see the fixture table below for why that matters. */
async function readyLocal(world: World, page: Page, token: string): Promise<Media> {
	const media = await world.awaitDemoTrack(token);
	const started = await processMedia(page, media.id);
	if (started.status !== 200 || (!started.body?.job && !started.body?.alreadyReady)) {
		throw new Error(`/api/process for ${media.id} → ${started.status} ${JSON.stringify(started.body).slice(0, 200)}`);
	}
	await expect
		.poll(async () => (await library(page)).body?.library?.some((m) => m.id === media.id) ?? false, {
			timeout: 30_000,
			message: `"${media.title}" never reached the ready library, so the fake worker never completed its stems`
		})
		.toBe(true);
	return media;
}

/** Every `media:status` frame for one media, off a phone-role socket — the broadcast a live phone reads. */
async function subscribeMediaStatus(
	baseURL: string,
	mediaId: string
): Promise<{ events: { status: string; pct: number }[]; close: () => void }> {
	const events: { status: string; pct: number }[] = [];
	const ws = new WebSocket(`${baseURL.replace(/^http/, 'ws')}/ws?role=phone`);
	await new Promise<void>((resolve, reject) => {
		ws.once('open', () => resolve());
		ws.once('error', (err) => reject(new Error(`media:status socket refused: ${err.message}`)));
	});
	ws.on('message', (raw: Buffer | string) => {
		try {
			const m = JSON.parse(String(raw)) as { type?: string; mediaId?: string; status?: string; pct?: number };
			if (m.type === 'media:status' && m.mediaId === mediaId) {
				events.push({ status: String(m.status), pct: m.pct ?? 0 });
			}
		} catch {
			// a frame this probe is not about
		}
	});
	return { events, close: () => ws.close() };
}

/**
 * Each fixture as a QUERY and as the substring its sourceRef carries. Both come from the filename rather than a
 * literal, because the two used to be written separately and nothing noticed when they disagreed.
 *
 * `q` MUST BE A SINGLE BARE TOKEN, and `world.awaitDemoTrack(q)` is why: that helper uses its argument as the
 * `?q=` AND as the sourceRef filter, so a hyphenated match like `sweet-caroline` runs straight into the FTS5
 * defect this spec documents at `FTS5 metacharacters…` below — LocalLibrary.search would build
 * `sweet-caroline*`, throw at tokenise time, and safeSearch would fold it to an empty library that never
 * indexes. `q` is therefore the token; `ref` stays the fuller form the assertions identify the row by.
 */
const CAROLINE = { q: 'caroline', ref: 'sweet-caroline' };
const BELIEVIN = { q: 'believin', ref: 'believin' };
const BOHEMIAN = { q: 'bohemian', ref: 'bohemian' };

// ── S1 · partitioning and dedupe ─────────────────────────────────────────────────────────────────────────

test('a processed local song is partitioned into ready, never into results', async ({ world }) => {
	const worker = await startFakeWorker(world);
	try {
		const phone = await world.openPhone('P12-S1');
		const caroline = await readyLocal(world, phone, CAROLINE.q);

		const { body } = await search(phone, CAROLINE.q);
		const inReady = body.ready.some((m) => m.id === caroline.id);
		const inResults = body.results.some((m) => m.id === caroline.id);
		const where =
			`ready=${body.ready.length}, processing=${body.processing.length}, results=${body.results.length}; ` +
			`${CAROLINE.ref} in ready=${inReady} in results=${inResults}`;

		// ONE ASSERTION, not two: "in ready" and "not in results" are the two halves of one partition claim, and
		// splitting them would let a song that is in BOTH satisfy the first on its own.
		expect(
			inReady && !inResults,
			`a processed local song must appear in \`ready\` (not \`results\`) even when the resolver returns many ` +
				`higher-ranked raw rows. ${where}. See src/lib/server/media/readiness.ts partitionSearch — the ` +
				`catalog is upserted into the byId Map BEFORE the resolver hits, so a processed song cannot be shadowed.`
		).toBe(true);
	} finally {
		await worker.stop();
	}
});

test('one media id appears at most once across ready, processing and results', async ({ world }) => {
	const worker = await startFakeWorker(world);
	try {
		const phone = await world.openPhone('P12-S1b');
		const caroline = await readyLocal(world, phone, CAROLINE.q);

		const { body } = await search(phone, CAROLINE.q);
		const all = [...body.ready, ...body.processing, ...body.results];
		const idCount = all.filter((m) => m.id === caroline.id).length;

		expect(
			idCount,
			`${CAROLINE.ref} appears ${idCount} times across the three buckets. See ` +
				`src/routes/api/search/+server.ts (materialize — upsert-or-reuse by ORIGIN identity) plus ` +
				`src/lib/server/media/readiness.ts partitionSearch's byId Map dedupe.`
		).toBe(1);
	} finally {
		await worker.stop();
	}
});

test('a local file and a YouTube upload of the same title coexist as separate rows', async ({ world }) => {
	// Cross-source non-dedupe is INTENTIONAL: a local "Bohemian Rhapsody" and a YouTube "Queen — Bohemian
	// Rhapsody" are different recordings and both belong. All three buckets are checked, because the local file
	// may already be processed and so sit in `ready` while the YouTube upload stays in `results`.
	const phone = await world.openPhone('P12-S1c');
	await world.awaitDemoTrack(BOHEMIAN.q);
	const { body } = await search(phone, 'bohemian rhapsody');
	const all = [...body.ready, ...body.processing, ...body.results];
	const local = all.find((m) => m.source === 'local' && m.sourceRef?.includes(BOHEMIAN.ref));
	const youtube = all.find((m) => m.source === 'youtube');

	expect(
		!!(local && youtube),
		`local=${!!local} youtube=${!!youtube}. The dedupe key is source+sourceRef, not title, so the two must be ` +
			`two rows — see src/routes/api/search/+server.ts originKey. NOTE THE DEPENDENCY: the YouTube half needs ` +
			`yt-dlp on PATH and a reachable network. /api/search folds a dead resolver to [] (safeSearch), so a ` +
			`missing youtube row here is either that dependency or the defect, and this assertion cannot tell them ` +
			`apart. Rows seen: ${JSON.stringify(all.map((m) => `${m.source}:${m.title}`))}`
	).toBe(true);
});

// ── S2 · the live transition, and what a mid-flight song looks like ──────────────────────────────────────

test('unacquired to processing to ready arrives on the WebSocket, with progress that never regresses', async ({
	world
}) => {
	// ONE PASS: both claims read the same frame series. A second process would be a second series.
	const worker = await startFakeWorker(world);
	try {
		const phone = await world.openPhone('P12-S2ab');
		const believin = await world.awaitDemoTrack(BELIEVIN.q);
		// Subscribed BEFORE the process, or the early frames are already gone.
		const sub = await subscribeMediaStatus(world.baseURL, believin.id);
		try {
			const started = await processMedia(phone, believin.id);
			expect(started.status, `/api/process → ${JSON.stringify(started.body).slice(0, 200)}`).toBe(200);

			await expect
				.poll(() => sub.events.some((e) => e.status === 'ready' || e.status === 'failed'), {
					timeout: 30_000,
					message: `no terminal media:status frame for ${believin.id}; saw ${JSON.stringify(sub.events)}`
				})
				.toBe(true);

			const seen = new Set(sub.events.map((e) => e.status));
			expect(
				(seen.has('separating') || seen.has('queued')) && seen.has('ready'),
				`unacquired → processing → ready must arrive on the WebSocket without a reload. ` +
					`events=${JSON.stringify(sub.events)}. See src/lib/server/jobs/worker-hub.ts + ` +
					`src/lib/server/jobs/media-status.ts.`
			).toBe(true);

			// Monotonic pct WITHIN the separating phase: progress may not regress on the way to done.
			const sepPct = sub.events.filter((e) => e.status === 'separating').map((e) => e.pct);
			expect(
				sepPct.every((p, i) => i === 0 || p >= sepPct[i - 1]!),
				`progress % must not regress within one stage. separating pct=${JSON.stringify(sepPct)}`
			).toBe(true);
		} finally {
			sub.close();
		}
	} finally {
		await worker.stop();
	}
});

test('a mid-flight song is visible in the processing bucket and still queueable there', async ({ world }) => {
	// ONE PASS: both claims are read off the FIRST snapshot in which the song appears in either bucket, because
	// "was it ever visible as processing" is falsified by a snapshot that finds it already `ready`.
	//
	// `slowMs` HOLDS stems open. At the default 120ms the whole process can finish between two reads, which
	// would report the row as invisible for the reason "it was already done" rather than "the bucket is wrong".
	const worker = await startFakeWorker(world, { slowMs: 2_000 });
	try {
		const phone = await world.openPhone('P12-S2cd');
		const believin = await world.awaitDemoTrack(BELIEVIN.q);
		const started = await processMedia(phone, believin.id);
		expect(started.status, `/api/process → ${JSON.stringify(started.body).slice(0, 200)}`).toBe(200);

		let snapshot: { asProcessing?: Media; asReady?: Media } | null = null;
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			const { body } = await search(phone, BELIEVIN.q);
			const asProcessing = body.processing.find((m) => m.id === believin.id);
			const asReady = body.ready.find((m) => m.id === believin.id);
			if (asProcessing || asReady) {
				snapshot = { asProcessing, asReady };
				break;
			}
		}
		if (!snapshot) {
			throw new Error(
				`${believin.title} never appeared in either the processing or the ready bucket within 20s, so ` +
					`neither claim below has a measurement.\n\n${worker.log()}`
			);
		}

		expect(
			!!snapshot.asProcessing,
			`a mid-flight song must appear in the \`processing\` bucket; this snapshot found it in ` +
				`\`${snapshot.asReady ? 'ready' : 'neither'}\`. See src/lib/server/media/readiness.ts readinessOf and ` +
				`partitionSearch, which groups processing into its own bucket.`
		).toBe(true);
		expect(
			snapshot.asProcessing?.stemStatus,
			`a processing row's stemStatus must read \`queued\` so the client's readinessOf returns 'processing' and ` +
				`the row still offers .add — rotation HOLDS its slot. 'none' would send readinessOf back to ` +
				`'unacquired', which offers only .sing. See src/lib/readiness.ts readinessOf and ` +
				`src/lib/components/SongRow.svelte's {#if onmake} .sing {:else} .add {/if}.`
		).toBe('queued');
	} finally {
		await worker.stop();
	}
});

// ── S3/S4 · the response shape, and the empty states ────────────────────────────────────────────────────

test('the search response always exposes ready, processing and results', async ({ world }) => {
	// The API must carry exactly the three bucket keys the client's group heads are built from. Subsumes the old
	// S1a-search-shape, which asked the weaker question "is `results` an array".
	const phone = await world.openPhone('P12-S3b');
	const { body } = await search(phone, CAROLINE.q);
	const keys = Object.keys(body).sort();
	expect(
		['processing', 'ready', 'results'].every((k) => keys.includes(k)),
		`the search response must expose ready/processing/results at minimum. keys=${JSON.stringify(keys)}. ` +
			`See src/routes/api/search/+server.ts.`
	).toBe(true);
});

test('an empty query still returns every bucket, so the client renders one shape', async ({ world }) => {
	const phone = await world.openPhone('P12-S4a');
	const { body } = await search(phone, '');
	const shapeOk =
		Array.isArray(body.ready) &&
		Array.isArray(body.processing) &&
		Array.isArray(body.results) &&
		Array.isArray(body.recent) &&
		Array.isArray(body.popular);
	expect(
		shapeOk,
		`empty ?q= must still return { ready, processing, results, recent, popular } for a single render shape. ` +
			`body keys=${JSON.stringify(Object.keys(body))}.`
	).toBe(true);
});

test('a whitespace-only query is treated as empty', async ({ world }) => {
	// The server trims and the client's searchActive check is query.trim().length > 0, so a divergence here
	// splits the two: the phone would show a results view against a recent/popular payload.
	const phone = await world.openPhone('P12-S4b');
	const { body } = await search(phone, ' ');
	expect(
		Array.isArray(body.recent),
		`a whitespace query must be treated as empty. body=${JSON.stringify(body).slice(0, 120)}. See ` +
			`src/routes/api/search/+server.ts (q.trim()).`
	).toBe(true);
});

test('a query with no matches returns three empty buckets', async ({ world }) => {
	// Asserted at the API level; the phone's "No results" COPY is its own test below.
	const phone = await world.openPhone('P12-S4c');
	const { body } = await search(phone, 'zzzzzzznotasongzzzzzz');
	expect(
		body.ready.length === 0 && body.processing.length === 0 && body.results.length === 0,
		`a query with no matches must return three empty arrays. body=${JSON.stringify(body).slice(0, 200)}`
	).toBe(true);
});

// ── S5 · adversarial input ───────────────────────────────────────────────────────────────────────────────

/**
 * The surfaces: long strings; FTS5 metacharacters that would poison LocalLibrary if unescaped; SQL-ish and
 * path-ish input; regex and shell meta; unicode and emoji; and a newline for header injection.
 */
const ADVERSARIAL: { name: string; q: string }[] = [
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
	{ name: 'unicode-accented', q: 'amin\u00e9' },
	{ name: 'emoji', q: '😀🎤🎉' },
	{ name: 'zero-width', q: 'car\u200boline' },
	{ name: 'rtl-mark', q: '\u202Esweet' }
];

test('no adversarial query crashes the search or changes its shape', async ({ world }) => {
	// ONE TEST over the whole table, because the claim is about the SET: "none of these" is one property, and
	// twenty cores to ask it twenty times would buy nothing. Every failure is named individually in the message.
	const phone = await world.openPhone('P12-S5a');
	const failures: string[] = [];
	for (const t of ADVERSARIAL) {
		const { status, body } = await search(phone, t.q);
		if (status !== 200 || !body || !Array.isArray(body.results)) {
			failures.push(`${t.name} → ${status} ${JSON.stringify(body).slice(0, 80)}`);
		}
	}
	expect(
		failures,
		`${failures.length}/${ADVERSARIAL.length} adversarial inputs did NOT return HTTP 200 with the standard shape`
	).toEqual([]);
});

// WAS A KNOWN LIVE DEFECT, ANNOTATED `fail`, NOW FIXED — and the annotation is removed rather than the test,
// exactly as its own note instructed. The defect: `LocalLibrary.search` built its match expression as `<term>*`
// after stripping only quotes, so `(caroline)` became `(caroline)*` and threw at FTS5 tokenise time
// (`fts5: syntax error near "("`), while a colon threw `no such column: …`. /api/search's `safeSearch` folds a
// throwing resolver to [], and the catalog could not rescue it either (`matchesQuery` is a plain substring test
// and no title contains the parentheses), so a punctuated query returned NO local songs and read as an empty
// library rather than a failure.
//
// The fix is `ftsPrefixQuery` in src/lib/server/media/local.ts: every term is QUOTED and the prefix `*` moved
// OUTSIDE the closing quote, because inside a double-quoted FTS5 string every character is literal text to
// tokenize. Terms with no indexable character are dropped, since `""` is itself a syntax error. The unit suite
// covers the expression shape directly; this stays as the end-to-end half, through a real phone and a real index.
test('FTS5 metacharacters in a query must not silently drop local matches', async ({ world }) => {
	const phone = await world.openPhone('P12-S5b');
	await world.awaitDemoTrack(CAROLINE.q);
	const hasLocal = async (q: string): Promise<boolean> => {
		const { body } = await search(phone, q);
		return [...body.results, ...body.ready].some((m) => m.source === 'local' && m.sourceRef?.includes(CAROLINE.ref));
	};
	const baseline = await hasLocal('caroline');
	const parenised = await hasLocal('(caroline)');
	const starred = await hasLocal('caroline*');
	expect(
		baseline && parenised && starred,
		`baseline(caroline)=local:${baseline}, "(caroline)"=local:${parenised}, "caroline*"=local:${starred}. ` +
			`See src/lib/server/media/local.ts \`ftsPrefixQuery\` — each term must be quoted with the prefix star ` +
			`OUTSIDE the quotes, or a metacharacter is parsed as syntax and src/routes/api/search/+server.ts ` +
			`safeSearch silences the throw and returns [].`
	).toBe(true);
});

test('the server does not reflect a raw script payload into the response body', async ({ world }) => {
	const phone = await world.openPhone('P12-S5c');
	const payload = '<script>alert(1)</script>';
	const { body } = await search(phone, payload);
	expect(
		JSON.stringify(body).includes(payload),
		'the server must not reflect a raw <script> payload into the /api/search response body'
	).toBe(false);
});

// ── S6 · case folding ────────────────────────────────────────────────────────────────────────────────────

test('title search is case-insensitive against the local library', async ({ world }) => {
	// FTS5's default `simple` tokenizer folds ASCII case, so every variant must find the local row.
	const phone = await world.openPhone('P12-S6a');
	await world.awaitDemoTrack(BOHEMIAN.q);
	const variants = ['Bohemian', 'bohemian', 'BOHEMIAN', 'BoHeMiAn'];
	const hits: { q: string; has: boolean }[] = [];
	for (const q of variants) {
		const { body } = await search(phone, q);
		hits.push({
			q,
			has: [...body.results, ...body.ready].some((m) => m.source === 'local' && m.sourceRef?.includes(BOHEMIAN.ref))
		});
	}
	expect(
		hits.every((h) => h.has),
		`title search must be case-insensitive (local library). ${JSON.stringify(hits)}`
	).toBe(true);
});

// ── S7 · the catalog against the disk ────────────────────────────────────────────────────────────────────

test('a song whose stem was deleted underneath the DB stays listed while /media 404s', async ({ world }) => {
	// ONE PASS, and it has to be: both claims describe the state AFTER one deletion, and a second deletion has
	// nothing left to delete. Browse must still list the song — the DB row is unchanged and there is no
	// filesystem check — while /media answers 404, so rotation can learn to skip it rather than the TV freezing
	// silently on a file that is not there.
	const worker = await startFakeWorker(world);
	try {
		const phone = await world.openPhone('P12-S7de');
		const caroline = await readyLocal(world, phone, CAROLINE.q);

		// The worker writes under MEDIA_DIR/derived unless ENCORE_DERIVED_DIR redirects it; core inherits this
		// process's env, so the two agree by construction.
		const stemsDir = join(world.mediaDir, 'derived', 'stems');
		if (!existsSync(stemsDir)) {
			throw new Error(
				`no ${stemsDir} after "${caroline.title}" reached ready, so there is no stem to delete and the ` +
					`orphan claims have no measurement.\n\n${worker.log()}`
			);
		}
		const instrumental = readdirSync(stemsDir).find((f) => f.includes(caroline.id) && f.endsWith('instrumental.wav'));
		if (!instrumental) {
			throw new Error(`${stemsDir} holds no instrumental for ${caroline.id}: ${JSON.stringify(readdirSync(stemsDir))}`);
		}
		unlinkSync(join(stemsDir, instrumental));

		const stillListed = (await library(phone)).body.library.some((m) => m.id === caroline.id);
		const { body: after } = await search(phone, CAROLINE.q);
		const readyRow = after.ready.find((m) => m.id === caroline.id);
		const ref = readyRow?.instrumentalRef;
		expect(
			stillListed && !!readyRow,
			`a song whose stem was deleted under the DB is still shown as ready by search and library (the DB has ` +
				`no filesystem check). ready=${!!readyRow} library=${stillListed}. See ` +
				`src/lib/server/media/repository.ts listReady, which relies on stemStatus + instrumentalRef.`
		).toBe(true);

		if (!ref) throw new Error(`the ready row for ${caroline.id} carries no instrumentalRef to request`);
		const mediaStatus = (await apiGet<unknown>(phone, `/media/${ref}`)).status;
		expect(
			mediaStatus === 404 || mediaStatus === 410,
			`/media/<ref> must return 404 when the file is gone so the client learns to skip. ` +
				`GET /media/${ref} → ${mediaStatus}. Deleted ${join(stemsDir, instrumental)}.`
		).toBe(true);
	} finally {
		await worker.stop();
	}
});

// ── S8 · a permanently failed process ────────────────────────────────────────────────────────────────────

test('a permanently failed process broadcasts failed and leaves the catalog processing group clear', async ({
	world
}) => {
	// ONE PASS: the second claim is about the state the broadcast left behind, so it can only be read after it.
	//
	// The old probe spawned its fail-worker ALONGSIDE whatever was already connected and had to record "another
	// worker won the race" as an environment limit. A core per test has exactly the workers this test starts, so
	// the only worker here is the one that fails and the race is gone by construction.
	const worker = await startFakeWorker(world, { fail: 'stems', slowMs: 300 });
	try {
		const phone = await world.openPhone('P12-S8');
		const believin = await world.awaitDemoTrack(BELIEVIN.q);
		const sub = await subscribeMediaStatus(world.baseURL, believin.id);
		try {
			const started = await processMedia(phone, believin.id);
			expect(started.status, `/api/process → ${JSON.stringify(started.body).slice(0, 200)}`).toBe(200);

			await expect
				.poll(() => sub.events.some((e) => e.status === 'ready' || e.status === 'failed'), {
					timeout: 30_000,
					message: `no terminal media:status frame arrived; saw ${JSON.stringify(sub.events)}\n\n${worker.log()}`
				})
				.toBe(true);

			expect(
				sub.events.some((e) => e.status === 'failed'),
				`a permanently-failed job must broadcast media:status failed on the WebSocket. ` +
					`events=${JSON.stringify(sub.events)}`
			).toBe(true);

			// settleStemsGate resets stemStatus, so readinessOf falls back to 'unacquired' and the song must be
			// ABSENT from /api/library.processing. A failed terminal job that leaves the row in flight is a song
			// that lies, which is worse than a song that is absent.
			await expect
				.poll(async () => (await library(phone)).body.processing?.some((c) => c.media?.id === believin.id) ?? false, {
					message:
						`the catalog processing group must NOT contain a failed song — settleStemsGate resets ` +
						`stemStatus back to "none". See src/lib/server/jobs/worker-hub.ts #onFailed and ` +
						`src/lib/server/jobs/process.ts settleStemsGate.`
				})
				.toBe(false);
		} finally {
			sub.close();
		}
	} finally {
		await worker.stop();
	}
});

// ── S9 · the rendered rows ───────────────────────────────────────────────────────────────────────────────

interface RowShape {
	add: number;
	sing: number;
	readiness: string;
	title?: string;
}

test('every song row exposes exactly one queueing action, and it matches the row readiness', async ({ world }) => {
	// ONE PASS over one rendered list: both claims read the same `perRow` reading, and a re-render is a
	// different list.
	const phone = await world.openPhone('P12-S9ab');
	await world.awaitDemoTrack(CAROLINE.q);
	await openBrowseFromHome(phone);
	await phone.locator(SEL.search).fill(CAROLINE.q);
	await expect(phone.locator(SEL.songRow).first()).toBeVisible();

	const perRow = await phone.evaluate(
		({ songRow, addTurn, sing, rowTitle }) =>
			[...document.querySelectorAll(songRow)].map((row) => ({
				add: row.querySelectorAll(addTurn).length,
				sing: row.querySelectorAll(sing).length,
				readiness: row.className.match(/ready|processing/)?.[0] ?? 'raw',
				title: row.querySelector(rowTitle)?.textContent?.trim()?.slice(0, 40)
			})),
		{ songRow: SEL.songRow, addTurn: SEL.addTurn, sing: SEL.sing, rowTitle: SEL.rowTitle }
	);
	const shown = JSON.stringify(perRow).slice(0, 500);
	expect(perRow.length, `no rows rendered for "${CAROLINE.q}", so neither claim has a measurement`).toBeGreaterThan(0);

	// A row exposes EITHER .add OR .sing, never both: offering both side by side made each one a dead end.
	expect(
		perRow.every((r: RowShape) => r.add + r.sing === 1),
		`every SongRow must expose EXACTLY one queueing action (.add for ready, .sing for raw/processing/failed). ` +
			`perRow=${shown}. See src/lib/components/SongRow.svelte's {#if onmake} .sing {:else} .add {/if}.`
	).toBe(true);

	const readyRowsOk = perRow.every((r: RowShape) => r.readiness !== 'ready' || (r.add === 1 && r.sing === 0));
	const rawRowsOk = perRow.every((r: RowShape) => r.readiness === 'ready' || r.sing === 1 || r.add === 1);
	expect(
		readyRowsOk && rawRowsOk,
		`a ready row offers .add; a raw/processing row offers .sing (both queue; .sing also processes). perRow=${shown}`
	).toBe(true);
});

// KNOWN LIVE DEFECT. The copy is only correct for a broken install, but it shows for any legitimate zero-match
// query: src/routes/+page.svelte renders "No results. YouTube search needs yt-dlp on the server." whenever both
// result groups are empty, with no test of whether yt-dlp is actually missing. REMOVE THE ANNOTATION once the
// notice is conditioned on the resolver's real state.
test.fail(
	'the no-results copy must not blame yt-dlp for a legitimate zero-match query',
	{
		annotation: {
			type: 'known-defect',
			description:
				'src/routes/+page.svelte renders the yt-dlp notice whenever both result groups are empty, without ' +
				'asking whether yt-dlp is actually missing. The assertion is correct; the copy is not.'
		}
	},
	async ({ world }) => {
		const phone = await world.openPhone('P12-S9c');
		await openBrowseFromHome(phone);
		await phone.locator(SEL.search).fill('zzzzzzznotasongzzzzzz');
		// Waited on, not slept for: the empty state's APPEARANCE is the settled end of the 150ms debounce plus the
		// round trip, where the old probe's `sleep(600)` was a guess at both.
		await expect(phone.locator(SEL.empty).first()).toBeVisible();

		const copy = ((await phone.locator(SEL.empty).first().textContent()) ?? '').trim();
		expect(copy.length, 'the zero-match state rendered no copy at all').toBeGreaterThan(0);
		expect(
			/yt-dlp/i.test(copy),
			`the "no results" copy tells the singer yt-dlp is missing even when it is not. rendered="${copy}". ` +
				`See src/routes/+page.svelte's search-empty branch.`
		).toBe(false);
	}
);

// A guard on the port itself: every query above is matched against a FIXTURE FILENAME, so a renamed demo track
// must break here — loudly, once — rather than turning four searches into silent zero-match passes.
test('the demo library still carries the filenames this probe searches by', async () => {
	const files = DEMO_LIBRARY.map((t) => t.file);
	for (const { q, ref } of [CAROLINE, BELIEVIN, BOHEMIAN]) {
		expect(
			files.some((f) => f.includes(ref)),
			`no demo track's filename contains "${ref}" (searched as "${q}"). files=${JSON.stringify(files)}`
		).toBe(true);
	}
});
