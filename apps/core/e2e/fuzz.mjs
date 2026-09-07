/*
 * FUZZ — a seeded, stateful, adversarial input fuzzer for the karaoke room.
 *
 *   bun run e2e:fuzz                      # boots its own private room, random seed
 *   FUZZ_SEED=123456 bun run e2e:fuzz     # replay that run, input for input
 *   FUZZ_AUTOPLAY=1 bun run e2e:fuzz      # grant autoplay — labelled NOT-A-TV, see below
 *   EPORT=5388 bun run e2e:fuzz           # drive an ALREADY-RUNNING room (owns/kills nothing)
 *
 * WHY A FUZZER AND NOT MORE PROBES. Every probe in e2e/probes drives a curated sequence, and the
 * curated sequences and the live-party reports found almost disjoint defect sets: the bugs were in the
 * ADJACENCY — restart arriving while a cook was in flight, skip landing on the last entry, a transport
 * tap landing while an entry was changing state. A curated list cannot cover the adjacency space of
 * ten inputs across two phones, and a human cannot hand-write the interleavings. A seeded PRNG can,
 * and the seed makes any finding replayable by hand.
 *
 * THE DRIVING IS NOT THE POINT — THE INVARIANTS ARE. A fuzzer that only checks "did it crash" finds
 * nothing here, because none of this room's defects crashed anything. All six invariants below are
 * re-evaluated after EVERY SINGLE INPUT, never once at the end:
 *
 *   I1  currentTime is monotonic within a song; it may only fall across an intentional seek, restart
 *       or entry change.
 *   I2  exactly one queue entry is `playing` — not zero while the TV renders a song, not two.
 *   I3  the TV's RENDERED now-playing equals the SERVER's currentEntryId. Compared against server
 *       state read off its own socket, never against another client's guess.
 *   I4  the lyrics active index is consistent with currentTime — the active line's window contains it.
 *   I5  no entry is simultaneously `playing` and waiting, and the phones' rendered rotation agrees
 *       with the server's waiting set.
 *   I6  webkitAudioDecodedByteCount CLIMBS whenever the UI claims to be playing. Sampled twice,
 *       1.5s apart, strict growth required.
 *
 * I6 IS THE ONE THAT CANNOT BE DROPPED. A media element reports `paused === false` while stuck at
 * currentTime 0 behind a failed decode: `paused` reports INTENT, not progress, and is never an oracle
 * for "audio is happening". That is the FLAC-in-a-<video> defect exactly — valid file, element
 * "playing", zero decoded bytes, silent room.
 *
 * GESTURELESS BY DEFAULT, AND WHY THAT MATTERS. Chromium launches here WITHOUT
 * --autoplay-policy=no-user-gesture-required, because that flag grants a permission a real television
 * does not have. Measured side by side on one real cooked song:
 *
 *     launch                    paused   currentTime   decoded bytes
 *     gestureless (a real TV)   true     0.00          24576  — the preload burst, and nothing more
 *     autoplay granted          false    5.41          507904
 *
 * So a run made with the flag cannot support a claim about whether the room makes a sound. FUZZ_AUTOPLAY=1
 * opts in and prints the literal token NOT-A-TV beside the seed so no reader mistakes that run for
 * evidence about a real television. The honest consequence, printed in this run's own summary: under
 * the gestureless default the TV never starts, so I1/I4/I6 have nothing to measure and report as
 * SKIPPED rather than passing vacuously. Both policies are worth running; only one is a TV.
 *
 * SELECTORS ARE ALL IMPORTED FROM ../contract.ts. contract.test.ts guards that file against the source
 * without needing a browser, so a hand-written selector rots silently and invisibly while every suite
 * stays green — that is how the previous e2e ended up clicking a deleted tab. Where a control this
 * fuzzer needs has NO entry in the contract, it is NOT inlined here: the gap is reported on stderr at
 * startup and the input is driven through the WIRE COMMAND the UI control would have sent, which is the
 * same server path (p4-transport does this for seek, which has no UI control at all). See GAPS below.
 *
 * GAPS FOUND WHILE BUILDING THIS — reported, not papered over:
 *   • `back` does not exist. There is no `back` PlayerCommand in packages/shared/src/events.ts, no
 *     control anywhere in the app, and no previous-entry concept in the server. The spec's alphabet and
 *     its "back-then-pause" seam therefore cannot be driven as written. The nearest reachable analogue
 *     is `restart` (the room's only backwards transport — it even renders the `prev` icon), so
 *     restart→pause is weighted up in its place and named RESTART-THEN-PAUSE in the output so nobody
 *     reads it as evidence about a `back` button.
 *   • no contract entry for the key-shift buttons (`.key-btn` in routes/+page.svelte), the guiding-track
 *     slider (GuidingTrack.svelte, which HAS a HOOKS entry but no SEL entry), or the per-row remove
 *     button (`aria-label="remove from queue"`). Driven as wire commands.
 *   • no contract entry for the TV's visible gapless slot (`.slot.visible`), which is how a probe tells
 *     the on-stage master element from the paused pre-warm one. Worked around by identifying the master
 *     via the server's own instrumentalRef; see pickMaster().
 *
 * EXIT CODES, NEVER CONFLATED.  0 every invariant held · 1 a real violation · 2 the environment could
 * not host the run. Conflating 2 with 0 is exactly how this project's original audio hole stayed hidden.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect, sleep } from './cdp.mjs';
import { SEL } from './contract.ts';

/**
 * Types for the out-of-program driver. This file runs under tsconfig.e2e.json (issue #557); the shapes
 * below are derived from cdp.mjs's own return types (#553) so they cannot drift from the driver.
 *
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6'} InvariantId
 * @typedef {keyof typeof BASE_WEIGHT} InputName
 *
 * A driven input as recorded in the sequence. `evaluate`-derived fields stay loose on purpose: the CDP
 * bridge returns protocol-shaped values (cdp.mjs types `evaluate` as `Promise<any>`), so call sites cast.
 * @typedef {{ who: string, input: string, detail: string, noop?: boolean, seam?: string | null }} Step
 *
 * @typedef {{ present: boolean, disabled: boolean }} TransportState
 *
 * One violation record, or null when the invariant held / was skipped.
 * @typedef {{ id: InvariantId, title: string, observed: string, expected: string, context: string }} Violation
 *
 * A single audio/video element as read back by TV_PROBE.
 * @typedef {{ tag: string, src: string, readyState: number, paused: boolean, muted: boolean, volume: number, currentTime: number, duration: number, decoded: number | null, error: { code: number, message: string } | null }} MediaRow
 *
 * The server's own snapshot, read off a probe socket.
 * @typedef {{ rev?: number, entries?: any[], media?: any[], settings?: any, playback?: any }} ServerSnapshot
 *
 * The reduced world the weighting/seam functions read.
 * @typedef {{ current: any, waiting: number, cooking: number }} WorldLite
 *
 * The full world one readWorld() call produces.
 * @typedef {{ srv: ServerSnapshot, tv: any, cat: { ready: any[], cooking: any[], raw: any[] }, mediaById: Map<any, any>, current: any, curMedia: any, master: MediaRow | null, masterHow: string, waiting: number, playing: any[], cooking: number }} World
 */

// ── seed and policy: the FIRST line of output, before anything can fail ───────────────────────────
const SEED = Number.isFinite(Number(process.env.FUZZ_SEED))
	? Number(process.env.FUZZ_SEED) >>> 0
	: (Math.random() * 0xffffffff) >>> 0;
const AUTOPLAY = process.env.FUZZ_AUTOPLAY === '1';
console.log(`seed=${SEED}${AUTOPLAY ? ' NOT-A-TV' : ''}`);
console.log(
	`replay: FUZZ_SEED=${SEED}${AUTOPLAY ? ' FUZZ_AUTOPLAY=1' : ''} bun run e2e:fuzz` +
		`   (inputs=${process.env.FUZZ_INPUTS ?? 24}, policy=${AUTOPLAY ? 'autoplay-granted' : 'gestureless'})`
);

/**
 * mulberry32 — 32 bits of state, four lines, no dependency. Every random decision this run makes goes
 * through `rnd`, so a seed reproduces the sequence exactly; nothing reads Math.random or the clock.
 */
/** @param {number} a */
function mulberry32(a) {
	return function () {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const rnd = mulberry32(SEED);
/** @type {<T>(arr: T[]) => T} */
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
/** @type {(lo: number, hi: number) => number} */
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
/** A deterministic Crockford-ish id, so even the clientOpIds a replay sends are identical. */
let idCounter = 0;
const fuzzId = () => `FZ${SEED.toString(32).toUpperCase()}${(idCounter++).toString(32).toUpperCase().padStart(4, '0')}`;

// ── knobs ────────────────────────────────────────────────────────────────────────────────────────
const N_INPUTS = Number(process.env.FUZZ_INPUTS ?? 24); // tens, not thousands — a human must replay it
const SETTLE_MS = 700; // let one input land before reading state
const CROSS_MS = 3000; // budget for a cross-surface value to propagate before it counts as a violation
const DECODE_GAP_MS = 1500; // "sample twice, seconds apart"
const CDP_PORT = Number(process.env.CDP_PORT ?? 9461);

// ── output ───────────────────────────────────────────────────────────────────────────────────────
/** Everything driven so far, in order — this list IS the reproduction recipe. */
/** @type {Step[]} */
const sequence = [];
/** Per-invariant bookkeeping, so the summary can say which invariants actually got to fire. */
const stats = {
	I1: { checked: 0, skipped: 0, why: new Set() },
	I2: { checked: 0, skipped: 0, why: new Set() },
	I3: { checked: 0, skipped: 0, why: new Set() },
	I4: { checked: 0, skipped: 0, why: new Set() },
	I5: { checked: 0, skipped: 0, why: new Set() },
	I6: { checked: 0, skipped: 0, why: new Set() }
};
/**
 * @param {InvariantId} id
 * @param {string} why
 */
function skip(id, why) {
	stats[id].skipped++;
	stats[id].why.add(why);
	return null;
}
/** @param {InvariantId} id */
function ok(id) {
	stats[id].checked++;
	return null;
}
/**
 * @param {InvariantId} id
 * @param {string} title
 * @param {string} observed
 * @param {string} expected
 * @param {string} [context]
 * @returns {Violation}
 */
function violation(id, title, observed, expected, context = '') {
	return { id, title, observed, expected, context };
}

/** Processes and directories THIS run created — requirement 9 is about what we own, not what we found. */
/** @type {{ procs: import('node:child_process').ChildProcess[], dirs: string[] }} */
const owned = { procs: [], dirs: [] };
let cleanedUp = false;
function cleanup() {
	if (cleanedUp) return;
	cleanedUp = true;
	for (const p of owned.procs) {
		try {
			p.kill('SIGTERM');
		} catch {}
	}
	for (const d of owned.dirs) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {}
	}
}
process.on('SIGINT', () => {
	cleanup();
	process.exit(2);
});
process.on('SIGTERM', () => {
	cleanup();
	process.exit(2);
});

/** @param {string} msg @returns {never} */
function bail(msg) {
	console.error(`\nENVIRONMENT: ${msg}`);
	cleanup();
	process.exit(2);
}

function findChromium() {
	// Validated rather than trusted: an unset-but-wrong PW_CHROMIUM used to sail past here and surface
	// as a CDP connect failure, which reads like a driver bug instead of a missing browser.
	if (process.env.PW_CHROMIUM) return existsSync(process.env.PW_CHROMIUM) ? process.env.PW_CHROMIUM : null;
	const cache = join(homedir(), '.cache', 'ms-playwright');
	for (const b of ['chromium-1232', 'chromium-1228']) {
		const p = join(cache, b, 'chrome-linux', 'chrome');
		if (existsSync(p)) return p;
	}
	for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
		if (existsSync(p)) return p;
	}
	return null;
}

// ── the room: attach to one, or boot a private one and own it ────────────────────────────────────
/** @param {string | number} port */
async function healthy(port) {
	try {
		const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
		return r.ok;
	} catch {
		return false;
	}
}

/** A port nothing is listening on. Bound and released, because two agents share this box. */
/** @param {number} from */
async function freePort(from) {
	for (let p = from; p < from + 60; p++) {
		if (await portFree(p)) return p;
	}
	return null;
}
/** @param {number} p */
async function portFree(p) {
	try {
		const s = Bun.listen({ hostname: '127.0.0.1', port: p, socket: { data() {} } });
		s.stop(true);
		return true;
	} catch {
		return false;
	}
}

async function bootRoom() {
	const given = process.env.EPORT;
	if (given && (await healthy(given))) {
		console.log(`room: attached to the existing server on :${given} (not owned, will not be killed)`);
		return { port: Number(given), owned: false };
	}
	if (given) bail(`EPORT=${given} was set but no server answers /health there.`);

	/*
	 * An EXPLICIT FUZZ_PORT is bind-tested too. Found by a run of this fuzzer: a port handed in on the
	 * command line was already serving a DIFFERENT Encore, our own server died with EADDRINUSE, the
	 * /health probe cheerfully passed against the stranger, and the fake worker then failed its upgrade
	 * against a server that had never heard of it. Silently driving somebody else's room is worse than
	 * refusing to start.
	 */
	/** @type {number | null} */
	let port = Number(process.env.FUZZ_PORT) || 0;
	if (port) {
		if (!(await portFree(port)))
			bail(
				`FUZZ_PORT=${port} is already in use by another process. Pick another, or set EPORT to drive that room deliberately.`
			);
	} else {
		port = await freePort(5400);
	}
	if (!port) bail('no free port in 5400-5460 to host a private room on.');
	const scratch = join(process.env.KIROCREW_SCRATCH ?? '/tmp', `encore-fuzz-${port}-${process.pid}`);
	const media = join(scratch, 'media');
	rmSync(scratch, { recursive: true, force: true });
	mkdirSync(media, { recursive: true });
	owned.dirs.push(scratch);

	// The four demo tracks have to exist as files before the server will index them at all.
	const seed = Bun.spawnSync({
		cmd: ['bun', 'run', join(import.meta.dir, 'seed-media.mjs')],
		env: { ...process.env, MEDIA_DIR: media },
		stdout: 'pipe',
		stderr: 'pipe'
	});
	if (seed.exitCode !== 0) bail(`could not seed the media dir: ${seed.stderr.toString().slice(0, 400)}`);

	const server = spawn('bun', ['run', join(import.meta.dir, '..', 'server.ts')], {
		env: {
			...process.env,
			ENCORE_EPHEMERAL: '1',
			PORT: String(port),
			HOST: '127.0.0.1',
			MEDIA_DIR: media,
			ENCORE_LYRICS_BACKFILL: '0',
			ENCORE_VOCALS_BACKFILL: '0'
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	owned.procs.push(server);
	let serverLog = '';
	server.stdout.on('data', (d) => (serverLog += d));
	server.stderr.on('data', (d) => (serverLog += d));

	for (let i = 0; i < 60; i++) {
		if (await healthy(port)) break;
		if (server.exitCode !== null) bail(`the server exited while starting:\n${serverLog.slice(-900)}`);
		await sleep(500);
	}
	if (!(await healthy(port))) bail(`the server never became healthy on :${port}\n${serverLog.slice(-900)}`);

	// The fake worker stands in for torch/demucs/whisperx, which are absent on this box. It publishes
	// REAL audio (hand-written 16-bit PCM WAV) and real word-level lyrics, so there is something to
	// decode and something to highlight — a placeholder fixture makes I4 and I6 unassertable.
	const worker = spawn('bun', [join(import.meta.dir, 'fake-stems-worker.mjs')], {
		env: { ...process.env, EPORT: String(port), MEDIA_DIR: media },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	owned.procs.push(worker);
	let workerLog = '';
	worker.stdout.on('data', (d) => (workerLog += d));
	worker.stderr.on('data', (d) => (workerLog += d));
	for (let i = 0; i < 30; i++) {
		if (/welcomed/.test(workerLog)) break;
		if (worker.exitCode !== null) bail(`the fake worker exited while starting:\n${workerLog.slice(-600)}`);
		await sleep(300);
	}
	if (!/welcomed/.test(workerLog)) bail(`the fake worker never connected to :${port}\n${workerLog.slice(-600)}`);

	console.log(`room: booted a private server on :${port} (media ${media}) + the fake stems worker`);
	return { port, owned: true, scratch };
}

const room = await bootRoom();
const PORT = room.port;
const base = `http://127.0.0.1:${PORT}`;
const wsBase = `ws://127.0.0.1:${PORT}`;

// ── cook enough songs that a rotation exists, and leave some raw ──────────────────────────────────
/**
 * The catalog, split the three ways this fuzzer cares about.
 *
 * `/api/library` is the honest source for READY and COOKING, and its `cooking` list is the SERVER's own
 * `readinessOf(m) === 'cooking'` verdict rather than a guess at what a `stemStatus` string means — which
 * matters, because a song mid-align has ready stems and queued lyrics and still counts as cooking.
 *
 * RAW songs are the awkward case: `/api/library` deliberately lists only ready rows ("the catalog holds
 * every search result ever materialised … browsing the whole table would bury the library in things you
 * cannot sing yet"), and a search with an EMPTY query returns nothing at all. So the raw local rows are
 * discovered once, up front, with a handful of short queries pinned to `source=local` — which keeps the
 * probe offline and off YouTube. They matter because `sing` on a raw song is the ONLY way to put a cook
 * in flight, and therefore the only way the RESTART-DURING-COOK seam becomes reachable.
 */
const RAW_PROBE_TERMS = ['a', 'e', 'i', 'o', 'u', 's', 'b', 'd', 'l', 'm', 'n', 'r', 't', 'w'];
/** @type {Map<string, any> | null} */
let rawSeen = null;

async function catalog() {
	const lib = await fetch(`${base}/api/library`).then((x) => x.json());
	const ready = (lib.library ?? []).filter((/** @type {any} */ m) => m.source === 'local');
	const cooking = (lib.cooking ?? [])
		.map((/** @type {any} */ c) => c.media)
		.filter((/** @type {any} */ m) => m && m.source === 'local');
	const known = new Set([...ready, ...cooking].map((m) => m.id));

	if (rawSeen === null) {
		rawSeen = new Map();
		for (const term of RAW_PROBE_TERMS) {
			try {
				const r = await fetch(`${base}/api/search?q=${encodeURIComponent(term)}&source=local`).then((x) => x.json());
				for (const row of [...(r.ready ?? []), ...(r.results ?? [])]) {
					if (row.source === 'local' && !known.has(row.id)) rawSeen.set(row.id, row);
				}
			} catch {}
		}
	}
	const raw = [...rawSeen.values()].filter((m) => !known.has(m.id));
	return { ready, cooking, raw };
}

/**
 * Singer names are UNIQUE PER ROOM: a reused one gets a 409 and the join page simply stays put, which
 * looks exactly like a broken flow. So every singer this run creates carries a per-run nonce.
 *
 * The nonce is DELIBERATELY outside the seed. A display name is not an input — it appears in no
 * invariant and no decision — so making it seed-derived would buy nothing and would make a replay
 * against a room that has already hosted one run fail at join with a 409 instead of reproducing.
 */
const NONCE = Date.now().toString(36).toUpperCase().slice(-5);

/**
 * Two cooked songs give a rotation, so `skip` has somewhere to land and I3 has something to disagree
 * about. Fewer than one and no playback invariant means anything, which is an exit-2 environment
 * problem rather than a green run.
 */
/** @param {number} want */
async function cookSongs(want) {
	const c0 = await catalog();
	if (c0.ready.filter((/** @type {any} */ r) => r.lyricsRef).length >= want) return c0.ready;

	const joinRes = await fetch(`${base}/api/join`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ displayName: `Cook${NONCE}`, color: '#ff5cae' })
	});
	if (!joinRes.ok) bail(`could not join to cook a song (${joinRes.status})`);
	const cookie = joinRes.headers.get('set-cookie')?.split(';')[0] ?? '';

	let cooked = c0.ready.length;
	const attempts = [];
	for (const row of c0.raw) {
		if (cooked >= want) break;
		const res = await fetch(`${base}/api/make-karaoke`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie },
			body: JSON.stringify({ mediaId: row.id })
		});
		const body = await res.text().catch(() => '');
		attempts.push(`${row.title}→${res.status}${res.ok ? '' : ` ${body.slice(0, 80)}`}`);
		if (res.ok) cooked++;
	}
	console.log(
		`cook: discovered ${c0.raw.length} raw local row(s); requested ${attempts.length} — ${attempts.join('; ')}`
	);
	// The stems job chains an align job, so readiness arrives a few seconds later.
	for (let i = 0; i < 60; i++) {
		const now = (await catalog()).ready.filter((/** @type {any} */ r) => r.lyricsRef);
		if (now.length >= Math.min(want, 2)) return now;
		await sleep(700);
	}
	return (await catalog()).ready.filter((/** @type {any} */ r) => r.lyricsRef);
}

const cookedRows = await cookSongs(3);
if (cookedRows.length === 0) {
	bail('no song could be cooked — nothing to sing, so no playback invariant means anything.');
}
{
	const c = await catalog();
	console.log(
		`fixture: ${cookedRows.length} cooked (${cookedRows.map((/** @type {any} */ r) => r.title).join(', ')}), ` +
			`${c.raw.length} raw left for the cook seam${c.raw.length === 0 ? ' — RESTART-DURING-COOK will NOT be reachable this run' : ` (${c.raw.map((/** @type {any} */ r) => r.title).join(', ')})`}`
	);
}

// ── authoritative server state, read off the server's own socket ──────────────────────────────────
/**
 * A `hello` gets back queue:sync + playback:state + nowplaying:changed, which together are a complete
 * consistent snapshot of what the SERVER believes. Read on a fresh short-lived socket per snapshot
 * rather than mirrored from a long-lived one: a mirror has to re-implement the rev/patch reconciliation
 * the clients do, and a bug in the mirror would look exactly like a bug in the room.
 */
/**
 * @param {number} [timeoutMs]
 * @returns {Promise<ServerSnapshot>}
 */
function serverSnapshot(timeoutMs = 4000) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${wsBase}/ws?role=probe`);
		/** @type {ServerSnapshot} */
		const out = {};
		let done = false;
		/** @param {Error} [err] */
		const finish = (err) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try {
				ws.close();
			} catch {}
			if (err) reject(err);
			else resolve(out);
		};
		const timer = setTimeout(() => finish(new Error('server snapshot timed out')), timeoutMs);
		ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', lastRev: 0 }));
		ws.onmessage = (ev) => {
			let e;
			try {
				e = JSON.parse(String(ev.data));
			} catch {
				return;
			}
			if (e.type === 'queue:sync') {
				out.rev = e.rev;
				out.entries = e.entries ?? [];
				out.media = e.media ?? [];
				out.settings = e.settings ?? null;
			}
			if (e.type === 'playback:state') out.playback = e.state;
			if (out.entries && out.playback) finish();
		};
		ws.onerror = () => finish(new Error('server snapshot socket error'));
	});
}

const probe0 = await serverSnapshot().catch((e) => bail(`cannot read server state: ${e.message}`));
/** Lead applied to the lyrics highlight, in seconds — the reel is cued slightly AHEAD of the playhead. */
const LEAD_SEC = Number.isFinite(probe0?.settings?.lyricsLeadMs) ? probe0.settings.lyricsLeadMs / 1000 : 0.3;

/** Lyrics docs, fetched once per ref from the same /media route the TV overlay reads. */
const lyricsCache = new Map();
/** @param {string | null | undefined} ref */
async function lyricsFor(ref) {
	if (!ref) return null;
	if (lyricsCache.has(ref)) return lyricsCache.get(ref);
	let doc = null;
	try {
		const j = await fetch(`${base}/media/${ref}`).then((r) => (r.ok ? r.json() : null));
		if (j && Array.isArray(j.lines)) doc = j;
	} catch {}
	lyricsCache.set(ref, doc);
	return doc;
}

// ── the browser ──────────────────────────────────────────────────────────────────────────────────
const chromium = findChromium();
if (!chromium) bail('no Chromium found. Set PW_CHROMIUM to an existing browser binary.');
const chromeArgs = [
	`--remote-debugging-port=${CDP_PORT}`,
	'--headless=new',
	'--no-sandbox',
	'--disable-gpu',
	'--no-first-run',
	'--user-data-dir=' + join(process.env.KIROCREW_SCRATCH ?? '/tmp', `encore-fuzz-chrome-${process.pid}`)
];
// Deliberately CONDITIONAL. Without the flag this is a television; with it, it is not.
if (AUTOPLAY) chromeArgs.push('--autoplay-policy=no-user-gesture-required');
chromeArgs.push('about:blank');
const chrome = spawn(chromium, chromeArgs, { stdio: 'ignore' });
owned.procs.push(chrome);

/**
 * The TV's on-stage master element.
 *
 * The gapless controller mounts TWO slots; the hidden one pre-warms the next song and exposes its own
 * <audio>, PAUSED at currentTime 0 with only the preload burst decoded. Picking "any audio with an
 * instrumental src" can grab the pre-warm one and read a permanently silent element as the stage.
 *
 * p4-transport scopes to `.slot.visible audio` — but `.slot` has NO entry in the contract, and a
 * hand-written selector here would rot invisibly, which is the one thing this file must not do. So the
 * master is identified by matching the element's src against the SERVER's own instrumentalRef for the
 * entry it says is current. When that cannot be resolved the fallback is the furthest-advanced
 * instrumental element, and the reason is recorded so a skipped check is never read as a pass.
 */
/**
 * @param {MediaRow[]} rows
 * @param {string | undefined} wantRef
 * @returns {{ master: MediaRow | null, how: string }}
 */
function pickMaster(rows, wantRef) {
	const instrumentals = rows.filter((r) => r.src.includes('instrumental'));
	if (wantRef) {
		const matched = instrumentals.filter((r) => wantRef && r.src.includes(wantRef));
		if (matched.length === 1) return { master: matched[0], how: 'src matches server instrumentalRef' };
		if (matched.length > 1) {
			// Two elements on the same song: the pre-warm slot for a repeat. Take the advanced one.
			const best = matched.slice().sort((a, b) => b.currentTime - a.currentTime)[0];
			return { master: best, how: 'two elements on the server song; took the advanced one' };
		}
	}
	if (instrumentals.length === 0) return { master: null, how: 'no instrumental element mounted' };
	const best = instrumentals.slice().sort((a, b) => b.currentTime - a.currentTime)[0];
	return { master: best, how: 'fallback: furthest-advanced instrumental element' };
}

/** Everything the TV can tell us, in one round trip. Only contract selectors are used in here. */
const TV_PROBE = `(() => {
	const rows = [...document.querySelectorAll(${JSON.stringify(SEL.mediaEl)})].map((el) => ({
		tag: el.tagName,
		src: el.currentSrc || el.src || '',
		readyState: el.readyState,
		paused: el.paused,
		muted: el.muted,
		volume: el.volume,
		currentTime: el.currentTime,
		duration: el.duration,
		decoded: el.webkitAudioDecodedByteCount ?? null,
		error: el.error ? { code: el.error.code, message: el.error.message } : null
	}));
	const t = (sel) => { const el = document.querySelector(sel); return el ? el.textContent.trim() : null; };
	const activeWordEl = document.querySelector(${JSON.stringify(SEL.activeWord)});
	/*
	 * The bouncing ball is a CHILD of the active word span, so textContent on it reads "●we". The ball
	 * carries aria-hidden="true" (it is decoration a screen reader must not announce), so the word as a
	 * PERSON reads it is the concatenation of the children that are not hidden. Filtered that way rather
	 * than by stripping the glyph or by selecting .ball, which the contract does not name.
	 */
	const wordText = activeWordEl
		? [...activeWordEl.childNodes]
				.filter((n) => !(n.nodeType === 1 && n.getAttribute('aria-hidden') === 'true'))
				.map((n) => n.textContent ?? '')
				.join('')
				.trim()
		: null;
	return {
		rows,
		nowSong: t(${JSON.stringify(SEL.nowSong)}),
		nowName: t(${JSON.stringify(SEL.nowName)}),
		lowerThird: document.querySelector(${JSON.stringify(SEL.lowerThird)}) !== null,
		attract: document.querySelector(${JSON.stringify(SEL.attract)}) !== null,
		connected: document.querySelector(${JSON.stringify(SEL.tvConnected)}) !== null,
		activeWord: wordText,
		activeWordRaw: activeWordEl ? activeWordEl.textContent.trim() : null
	};
})()`;

/** @type {Browser | undefined} */
let browser;
/** @type {Page} */
let tv;
/** @type {Page[]} */
const phones = [];

/**
 * A phone's own authenticated socket, opened ONCE and kept.
 *
 * Three of the ten inputs (seek, key-shift, guide-level) plus queue-remove have no usable contract
 * selector — seek has no UI control in the app at all, and the other three have controls the contract
 * does not name. Rather than inline a literal, they go out as the exact wire frame the control would
 * have sent, from the phone's OWN socket so the server resolves the same singerId from the same session
 * cookie and runs the same authorization. `__fzRev` tracks the rev so a queue command carries a real
 * baseRev instead of a made-up one.
 */
/** @param {Page} page */
async function openWire(page) {
	await page.evaluate(`(() => new Promise((res, rej) => {
		if (window.__fz && window.__fz.readyState === 1) return res('reused');
		const proto = location.protocol === 'https:' ? 'wss' : 'ws';
		const s = new WebSocket(proto + '://' + location.host + '/ws?role=phone');
		window.__fzRev = 0;
		window.__fzRejects = [];
		s.onmessage = (ev) => {
			try {
				const e = JSON.parse(ev.data);
				if (e.type === 'queue:sync') window.__fzRev = e.rev;
				else if (e.type === 'queue:patch') window.__fzRev = e.patch.rev;
				else if (e.type === 'op:reject') window.__fzRejects.push(e.reason);
			} catch {}
		};
		s.onopen = () => { window.__fz = s; s.send(JSON.stringify({ type: 'hello', lastRev: 0 })); res('open'); };
		s.onerror = () => rej(new Error('the fuzz socket would not open'));
		setTimeout(() => rej(new Error('the fuzz socket timed out')), 5000);
	}))()`);
}

/**
 * @param {Page} page
 * @param {Record<string, unknown>} command
 */
async function wirePlayer(page, command) {
	return page.evaluate(`(() => {
		if (!window.__fz || window.__fz.readyState !== 1) return 'closed';
		window.__fz.send(JSON.stringify({ type: 'player:command', command: ${JSON.stringify(command)} }));
		return 'sent';
	})()`);
}

/**
 * @param {Page} page
 * @param {Record<string, unknown>} op
 * @param {string} opId
 */
async function wireQueueOp(page, op, opId) {
	return page.evaluate(`(() => {
		if (!window.__fz || window.__fz.readyState !== 1) return 'closed';
		window.__fz.send(JSON.stringify({ type: 'queue:command', command: {
			clientOpId: ${JSON.stringify(opId)},
			op: ${JSON.stringify(op)}
		}}));
		return 'sent';
	})()`);
}

// ── the input alphabet ───────────────────────────────────────────────────────────────────────────
/**
 * Ten inputs were specified; NINE are drivable. `back` is absent from this codebase entirely (no
 * PlayerCommand, no control, no previous-entry concept), so it is not silently mapped onto something
 * else — see the header. Weights are a starting point that the adjacency bias below then reshapes.
 */
/** @type {Set<InputName>} */
const TRANSPORT = new Set(['pause', 'resume', 'skip', 'restart', 'seek']);
const BASE_WEIGHT = {
	pause: 3,
	resume: 3,
	skip: 3,
	restart: 3,
	seek: 2,
	key: 2,
	guide: 2,
	'queue-add': 3,
	'queue-remove': 2
};

/**
 * Every defect found in this room so far lived in the SEAM between two inputs, not in one, so the
 * draw is conditioned on what just happened and on what the room is currently doing:
 *
 *   • back-to-back transport is tripled, because that is the seam class as a whole.
 *   • RESTART-DURING-COOK — a cook in flight makes `restart` (and `queue-remove`, which cancels one)
 *     far more likely.
 *   • SKIP-AT-LAST-ENTRY — nothing waiting behind the current song makes `skip` far more likely.
 *   • RESTART-THEN-PAUSE — the reachable stand-in for the specified back-then-pause seam.
 */
/**
 * @param {InputName | null} prev
 * @param {WorldLite} world
 * @returns {Record<InputName, number>}
 */
function weightsFor(prev, world) {
	const w = { ...BASE_WEIGHT };
	if (prev && TRANSPORT.has(prev)) for (const k of TRANSPORT) w[k] *= 3;
	if (world.cooking > 0) {
		w.restart *= 6;
		w['queue-remove'] *= 3;
	}
	if (world.current && world.waiting === 0) w.skip *= 6;
	if (prev === 'restart') w.pause *= 6;
	if (world.waiting + (world.current ? 1 : 0) === 0) {
		// An empty room can only meaningfully be filled.
		for (const k of /** @type {InputName[]} */ (Object.keys(w))) w[k] = k === 'queue-add' ? 10 : 0;
	}
	return w;
}

/**
 * @param {InputName | null} prev
 * @param {WorldLite} world
 * @returns {InputName}
 */
function drawInput(prev, world) {
	const w = weightsFor(prev, world);
	const keys = /** @type {InputName[]} */ (Object.keys(w)).filter((k) => w[k] > 0);
	const total = keys.reduce((s, k) => s + w[k], 0);
	let r = rnd() * total;
	for (const k of keys) {
		r -= w[k];
		if (r <= 0) return k;
	}
	return keys[keys.length - 1];
}

/** Which seam, if any, this draw was biased toward — printed in the sequence so a replay reads clearly. */
/**
 * @param {InputName} input
 * @param {InputName | null} prev
 * @param {WorldLite} world
 * @returns {string | null}
 */
function seamLabel(input, prev, world) {
	if (input === 'restart' && world.cooking > 0) return 'RESTART-DURING-COOK';
	if (input === 'skip' && world.current && world.waiting === 0) return 'SKIP-AT-LAST-ENTRY';
	if (input === 'pause' && prev === 'restart')
		return 'RESTART-THEN-PAUSE (stands in for back-then-pause; `back` does not exist)';
	return null;
}

// ── invariants ───────────────────────────────────────────────────────────────────────────────────
/** currentTime may only fall across an intentional discontinuity. */
/** @type {{ entryId: string | null, t: number | null }} */
let lastPos = { entryId: null, t: null };
const RESETS_POSITION = new Set(['seek', 'restart', 'skip']);
/** The entry id I4 last evaluated against — the lyrics reel re-syncs off a broadcast after a song
 * change, so the first read on a new entry sees the OLD reel and is propagation, not a defect.
 * @type {string | null} */
let lastLyricsEntry = null;

/** @returns {Promise<World>} */
async function readWorld() {
	const srv = await serverSnapshot();
	const tvState = await tv.evaluate(TV_PROBE);
	const cat = await catalog();
	const mediaById = new Map((srv.media ?? []).map((/** @type {any} */ m) => [m.id, m]));
	const cur = (srv.entries ?? []).find((/** @type {any} */ e) => e.id === srv.playback?.currentEntryId) ?? null;
	const curMedia = cur ? (mediaById.get(cur.mediaId) ?? null) : null;
	const { master, how } = pickMaster(tvState.rows, curMedia?.instrumentalRef);
	// Record the FIRST decoded byte-count seen for this src — the preload burst a blocked TV never
	// exceeds. atPreloadFloor() reads this to tell an un-started TV from one that is genuinely playing,
	// which is what makes the refusal excuse survive a seek without crying wolf (#591 A).
	if (master && master.decoded !== null && master.decoded !== undefined && !preloadFloor.has(master.src)) {
		preloadFloor.set(master.src, master.decoded);
	}
	return {
		srv,
		tv: tvState,
		cat,
		mediaById,
		current: cur,
		curMedia,
		master,
		masterHow: how,
		waiting: (srv.entries ?? []).filter((/** @type {any} */ e) => e.status === 'queued').length,
		playing: (srv.entries ?? []).filter((/** @type {any} */ e) => e.status === 'playing'),
		// The SERVER's own cooking verdict, not a guess at what a stemStatus string means.
		cooking: cat.cooking.length
	};
}

/** I2 · exactly one entry is `playing` — not zero while the TV renders a song, not two. */
/** @param {World} w */
function checkI2(w) {
	const n = w.playing.length;
	if (n > 1) {
		return violation(
			'I2',
			'two or more queue entries are in state `playing` at once',
			`${n} playing: ${w.playing.map((/** @type {any} */ e) => `${e.id}(seq ${e.rotationSeq})`).join(', ')}`,
			'exactly one entry may be `playing`'
		);
	}
	const tvRendersASong = w.tv.lowerThird || !!w.tv.nowSong;
	if (n === 0) {
		if (tvRendersASong) {
			return violation(
				'I2',
				'the TV renders a song while NO entry is in state `playing`',
				`playing=0, tv.nowSong=${JSON.stringify(w.tv.nowSong)}, tv.lowerThird=${w.tv.lowerThird}`,
				'an entry must be `playing` whenever the TV shows one'
			);
		}
		return skip('I2', 'nothing playing and the TV renders no song (an idle room is not a violation)');
	}
	return ok('I2');
}

/** I3 · the TV's RENDERED now-playing equals the SERVER's currentEntryId. */
/** @param {World} w */
function checkI3(w) {
	if (!w.current) {
		if (w.tv.nowSong) {
			return violation(
				'I3',
				'the TV names a song while the server has no current entry',
				`tv.ls-song=${JSON.stringify(w.tv.nowSong)}`,
				'server.currentEntryId=null → the TV must render no now-playing'
			);
		}
		return skip('I3', 'the server has no current entry and the TV names none');
	}
	if (!w.curMedia) return skip('I3', 'the server current entry resolves to no media row');
	if (!w.tv.nowSong) {
		return violation(
			'I3',
			'the server has a current entry but the TV renders no now-playing',
			'tv.ls-song=null',
			`server.currentEntryId=${w.current.id} → media ${JSON.stringify(w.curMedia.title)}`
		);
	}
	// The lower third prints the TITLE; that rendered string is what a person in the room sees.
	const want = String(w.curMedia.title ?? '');
	const got = String(w.tv.nowSong);
	if (!(got === want || got.includes(want) || want.includes(got))) {
		return violation(
			'I3',
			"the TV's rendered now-playing disagrees with the server's current entry",
			`tv.ls-song=${JSON.stringify(got)}`,
			`server.currentEntryId=${w.current.id} → media ${JSON.stringify(want)}`
		);
	}
	// Sharper still: the element on stage must carry that entry's instrumental.
	if (w.master && w.curMedia.instrumentalRef && !w.master.src.includes(w.curMedia.instrumentalRef)) {
		return violation(
			'I3',
			'the TV title agrees but the audio on stage is a DIFFERENT song',
			`master.src=${w.master.src} (picked: ${w.masterHow})`,
			`server current instrumentalRef=${w.curMedia.instrumentalRef}`
		);
	}
	return ok('I3');
}

/** I5 · no entry is both playing and waiting, and the phones' rotation agrees with the server. */
/** @param {World} w */
async function checkI5(w) {
	// The server models status as ONE field, so "both at once" can only appear as a disagreement:
	// either the current entry is not marked playing, or something marked playing is not the current.
	if (w.current && w.current.status !== 'playing') {
		return violation(
			'I5',
			'the current entry is not in state `playing` (it is waiting while the room treats it as current)',
			`entry ${w.current.id} status=${w.current.status}`,
			'the server current entry must be `playing`'
		);
	}
	for (const e of w.playing) {
		if (w.srv.playback?.currentEntryId !== e.id) {
			return violation(
				'I5',
				'an entry is `playing` that the server does not consider current',
				`entry ${e.id} status=playing, currentEntryId=${w.srv.playback?.currentEntryId}`,
				'only the current entry may be `playing`'
			);
		}
	}
	// The rotation VIEW: the phone renders exactly the entries whose status is `queued` (one #each over
	// `queued`, rendering a QueueRow or a ProcessingCard — both carry .qrow). So a count mismatch means
	// a phone is showing a rotation the server does not have.
	for (let i = 0; i < phones.length; i++) {
		const n = await phones[i].count(SEL.queueRow);
		if (n !== w.waiting) {
			return violation(
				'I5',
				`phone${i + 1}'s rendered rotation disagrees with the server's waiting set`,
				`phone${i + 1} renders ${n} ${SEL.queueRow} rows`,
				`server has ${w.waiting} entries with status=queued`,
				`server entries: ${(w.srv.entries ?? []).map((/** @type {any} */ e) => `${e.id.slice(-6)}:${e.status}`).join(' ')}`
			);
		}
	}
	return ok('I5');
}

/** I1 · currentTime monotonic within a song. */
/**
 * @param {World} w
 * @param {InputName} lastInput
 */
function checkI1(w, lastInput) {
	if (!w.master) return skip('I1', 'no master element on stage to measure');
	const t = w.master.currentTime;
	const id = w.current?.id ?? null;
	const prev = lastPos;
	lastPos = { entryId: id, t };
	if (prev.t === null) return skip('I1', 'first sample — nothing to compare against');
	if (prev.entryId !== id) return skip('I1', 'the entry changed, so a lower currentTime is expected');
	if (RESETS_POSITION.has(lastInput)) return skip('I1', `the input was \`${lastInput}\`, an intentional discontinuity`);
	if (t < prev.t - 0.25) {
		return violation(
			'I1',
			'currentTime went BACKWARDS within one song, with no seek, restart or entry change',
			`currentTime ${prev.t.toFixed(2)} → ${t.toFixed(2)} on entry ${id}`,
			`currentTime >= ${prev.t.toFixed(2)} (a fall is only legal across seek/restart/entry change)`,
			`last input was \`${lastInput}\``
		);
	}
	return ok('I1');
}

/**
 * The launch policy decides whether a master that is not making sound is excusable. Gestureless and
 * BEFORE the run's one real tap, an autoplay refusal is what a real television does (paused, only its
 * preload burst decoded), so any check that reads the decoder or the playhead has nothing to measure
 * and must SKIP with that reason named rather than judge it a defect. Shared by I4 and I6 so the two
 * cannot drift.
 *
 * The honest predicate for "this television has not been started yet" is NOT `currentTime === 0`: a
 * `seek` on a still-blocked master moves the playhead off 0 while the element stays paused and the
 * decoder stays at its preload floor (issue #591 A), so keying on currentTime turns every gestureless
 * seek into a phantom I6. Key instead on what is actually true of an un-started element: its decoder
 * has not advanced past the preload burst it recorded the first time it saw this src (`atPreloadFloor`).
 * That is honest across a transport too — a skip mounts a fresh element that sits at its OWN preload
 * floor until it is started, so the excuse follows the element, not a run-level flag. maybeDeliverTap
 * keeps the current master started (re-applying the one gesture as a real TV’s sticky activation would);
 * once the decoder climbs past the floor, there is no refusal left to blame and a silent room is a real defect.
 */
/** First decoded byte-count seen for each src — the preload burst floor a blocked TV never exceeds. */
const preloadFloor = new Map();
/** Set true once maybeDeliverTap() delivers the run's single real gesture. */
let tapped = false;
/** @param {World} w */
function atPreloadFloor(w) {
	const m = w.master;
	if (!m) return false;
	const d = m.decoded;
	// A missing decoder counter means neither caller can claim the element is at its preload floor, so
	// this returns false: autoplayRefused stops EXCUSING the master and maybeDeliverTap stops RE-TAPPING
	// it, and it falls through to a real I6 evaluation. That is deliberate — fail toward measuring audio
	// rather than toward silently excusing a state we cannot read.
	if (d === null || d === undefined) return false;
	const floor = preloadFloor.get(m.src);
	return floor !== undefined && d <= floor;
}
/** @param {World} w */
function autoplayRefused(w) {
	return !AUTOPLAY && w.master?.paused === true && atPreloadFloor(w);
}

/** I4 · the lyrics active index is consistent with currentTime. */
/**
 * @param {World} w
 * @param {InputName} lastInput
 */
async function checkI4(w, lastInput) {
	if (!w.master) return skip('I4', 'no master element on stage to measure');
	if (autoplayRefused(w))
		return skip(
			'I4',
			'gestureless, before the tap: the browser refused autoplay (paused, decoder still at its preload floor) — exactly what a real TV does before someone taps it, so the reel advances off the server intent while audio has not started; nothing about the highlight vs currentTime is testable yet'
		);
	// The lyrics reel re-syncs to a new song off a broadcast, ASYNCHRONOUSLY — exactly like the
	// cross-surface invariants. So the first read after the current entry changes (or after any
	// position-resetting transport) sees the OLD reel against a playhead that just snapped to ~0,
	// which is propagation lag, not a highlight defect. Skip that one read with its reason named,
	// the same way I1 skips a currentTime fall across an entry change (#591 B made this reachable).
	{
		const id = w.current?.id ?? null;
		const changed = id !== lastLyricsEntry;
		lastLyricsEntry = id;
		if (changed)
			return skip(
				'I4',
				'the current entry just changed; the lyrics reel re-syncs off a broadcast, so this first read still shows the previous song'
			);
		if (RESETS_POSITION.has(lastInput))
			return skip('I4', `the input was \`${lastInput}\`, a position discontinuity the reel re-syncs to asynchronously`);
	}
	if (!w.curMedia?.lyricsRef) return skip('I4', 'the current song has no lyrics artifact');
	if (!w.tv.activeWord) return skip('I4', 'no active word rendered (between words, or word-highlight is off)');
	const doc = await lyricsFor(w.curMedia.lyricsRef);
	if (!doc) return skip('I4', 'the lyrics artifact could not be read');
	// The rendered ACTIVE WORD identifies the active line — the contract names the word, not the row.
	/** @type {number[]} */
	const hits = [];
	doc.lines.forEach((/** @type {any} */ l, /** @type {number} */ i) => {
		if ((l.words ?? []).some((/** @type {any} */ x) => String(x.word).trim() === w.tv.activeWord)) hits.push(i);
	});
	if (hits.length === 0) {
		return violation(
			'I4',
			"the TV highlights a word that is not in the current song's lyrics at all",
			`activeWord=${JSON.stringify(w.tv.activeWord)} (raw textContent ${JSON.stringify(w.tv.activeWordRaw)})`,
			`one of the words in ${w.curMedia.lyricsRef}`
		);
	}
	if (hits.length > 1) return skip('I4', 'the highlighted word text is ambiguous across lines');
	const idx = hits[0];
	// The highlight is cued LEAD_SEC ahead of the playhead, and the reel holds a line through the gap
	// until the next line starts (see activeLineIndex in src/lib/tv/lyrics.ts), so the legal window for
	// line i runs from its own start to the NEXT line's start.
	const cue = w.master.currentTime + LEAD_SEC;
	const start = doc.lines[idx].start;
	const nextStart = idx + 1 < doc.lines.length ? doc.lines[idx + 1].start : Number.POSITIVE_INFINITY;
	const TOL = 1.0; // the reel interpolates from the server anchor; it is allowed to be a beat off
	const preRoll = idx === 0 && cue < start; // before the first line, line 0 is correctly lit
	if (!preRoll && (cue < start - TOL || cue > nextStart + TOL)) {
		return violation(
			'I4',
			'the lyrics highlight is on a line whose window does not contain the playhead',
			`activeWord=${JSON.stringify(w.tv.activeWord)} → line ${idx} [${start}, ${nextStart}); currentTime=${w.master.currentTime.toFixed(2)} (cue ${cue.toFixed(2)})`,
			`cue within [${(start - TOL).toFixed(2)}, ${(nextStart + TOL).toFixed(2)}]`,
			w.master.paused === true
				? `the master is PAUSED at ${w.master.currentTime.toFixed(2)} (decoded ${w.master.decoded}) while the server says isPlaying=${w.srv.playback?.isPlaying} — the reel advances off the SERVER's intent (lyricsAdvancing(screen, tvState, isPlaying) in src/routes/tv/+page.svelte), never off audio progress, so it runs away from a playhead that is not moving`
				: `server positionSec=${w.srv.playback?.positionSec}, lead ${LEAD_SEC}s`
		);
	}
	return ok('I4');
}

/**
 * I6 · decoded bytes climbing whenever the UI claims to be playing.
 *
 * THE GATE IS THE ROOM'S CLAIM, NOT `master.paused`. Keying this on the element's own `paused` looks
 * natural and is exactly wrong: it makes the check skip itself in the one state worth catching, where
 * the server says isPlaying, every phone renders a playing transport, and the element sits paused at 0
 * with only its preload burst decoded. `paused` reports INTENT, and so does `isPlaying` — the ONLY
 * evidence that audio is happening is the decoder consuming bytes.
 *
 * The launch policy decides whether a paused master is excusable. Gestureless, an autoplay refusal is
 * what a real television does and is a property of the environment, so it is SKIPPED with that reason
 * named rather than counted as a defect — reporting the environment as a failure is the same
 * conflation exit code 2 exists to prevent, one category over. With autoplay granted there is no
 * refusal left to blame, so a paused master under a playing room is a real violation.
 */
/** @param {World} w */
async function checkI6(w) {
	const roomClaimsPlaying = w.srv.playback?.isPlaying === true && !!w.current;
	if (!roomClaimsPlaying) return skip('I6', 'the room does not claim to be playing, so it claims nothing about audio');
	if (!w.master) return skip('I6', 'no master element mounted to measure');
	if (w.master.decoded === null) return skip('I6', 'this build exposes no webkitAudioDecodedByteCount');
	if (autoplayRefused(w)) {
		return skip(
			'I6',
			'gestureless, before the tap: the browser refused autoplay (paused, decoder still at its preload floor) — exactly what a real TV does before someone taps it, so nothing about the decoder is testable yet'
		);
	}
	const before = { decoded: w.master.decoded, t: w.master.currentTime, src: w.master.src, paused: w.master.paused };
	await sleep(DECODE_GAP_MS);
	const after0 = await tv.evaluate(TV_PROBE);
	const { master: m2 } = pickMaster(after0.rows, w.curMedia?.instrumentalRef);
	if (!m2 || m2.src !== before.src) return skip('I6', 'the song changed between the two samples');
	// A pause that ARRIVED between the samples is a legal transport action, not a defect — but only if
	// the room stopped claiming to be playing too. Re-read the server rather than trusting the element.
	const srv2 = await serverSnapshot().catch(() => null);
	if (srv2 && srv2.playback?.isPlaying !== true) return skip('I6', 'playback was stopped between the two samples');
	if ((m2.decoded ?? 0) <= before.decoded) {
		return violation(
			'I6',
			'the room claims to be playing but the DECODER consumed nothing — the room is silent',
			`decoded ${before.decoded} → ${m2.decoded} over ${DECODE_GAP_MS}ms; master.paused ${before.paused} → ${m2.paused}, currentTime ${before.t.toFixed(2)} → ${m2.currentTime.toFixed(2)}, readyState=${m2.readyState}`,
			'strictly more decoded bytes at the second sample',
			`server isPlaying=true, currentEntryId=${w.current.id}, positionSec=${w.srv.playback?.positionSec}. ` +
				(m2.paused === true
					? `The element is PAUSED while the room believes it is playing — no sound, no timeupdate, no telemetry, while the server position reads ${w.srv.playback?.positionSec}.`
					: '`paused === false` reports INTENT, not progress; a failed decode looks exactly like this.')
		);
	}
	return ok('I6');
}

/**
 * Cross-surface invariants are asynchronous BY DESIGN — a phone learns the rotation changed from a
 * broadcast, so a disagreement read one millisecond after an input is propagation, not a defect. Those
 * three (I2/I3/I5) are retried against fresh snapshots until they hold or the budget runs out; the
 * single-surface ones (I1/I4/I6) are read once, because there is nothing to wait for.
 */
function snapshotStats() {
	return Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { checked: v.checked, skipped: v.skipped }]));
}
/** @param {Record<string, { checked: number, skipped: number }>} snap */
function restoreStats(snap) {
	for (const [k, v] of /** @type {[InvariantId, { checked: number, skipped: number }][]} */ (Object.entries(snap))) {
		stats[k].checked = v.checked;
		stats[k].skipped = v.skipped;
	}
}

/** @param {InputName} lastInput */
async function checkAll(lastInput) {
	const deadline = Date.now() + CROSS_MS;
	const before = snapshotStats();
	/** @type {World} */
	let world;
	/** @type {Violation | null} */
	let cross;
	for (;;) {
		// Each retry is a DISCARDED reading, so its bookkeeping is rolled back — otherwise a value that
		// took three attempts to propagate would inflate the summary's counts threefold.
		restoreStats(before);
		world = await readWorld();
		cross = checkI2(world) ?? checkI3(world) ?? (await checkI5(world));
		if (!cross || Date.now() > deadline) break;
		await sleep(250);
	}
	if (cross) return { v: cross, world };
	// I6 is evaluated BEFORE I4 deliberately, even though the spec numbers it last. A silent room makes
	// the lyrics reel drift, so the drift is a downstream SYMPTOM of the decoder finding — reporting the
	// symptom first would send a reader to LyricsOverlay when the fault is in the player.
	const single = checkI1(world, lastInput) ?? (await checkI6(world)) ?? (await checkI4(world, lastInput));
	return { v: single, world };
}

// ── the inputs, driven ───────────────────────────────────────────────────────────────────────────
/**
 * @param {InputName} input
 * @param {World} world
 */
async function driveInput(input, world) {
	const phoneIdx = int(0, phones.length - 1); // interleaved between the two phones on purpose
	const page = phones[phoneIdx];
	const who = `phone${phoneIdx + 1}`;
	const playing = world.srv.playback?.isPlaying === true;
	let detail;

	/**
	 * The transport controls are DISABLED when there is nothing for them to act on, and calling .click()
	 * on a disabled button does precisely nothing and throws nothing. Recording "clicked" for one of
	 * those would put a beat in the reproduction recipe that never happened, so the state is read first.
	 */
	/** @param {string} label */
	async function tapTransport(label) {
		const state = await page.evaluate(`(() => {
			const el = document.querySelector('[aria-label=' + ${JSON.stringify(JSON.stringify(label))} + ']');
			return el ? { present: true, disabled: !!el.disabled } : { present: false, disabled: false };
		})()`);
		if (!state.present) return { who, input, detail: `no-op (no ${label} control rendered)`, noop: true };
		if (state.disabled) return { who, input, detail: `no-op (${label} is disabled)`, noop: true };
		await page.clickByLabel(label);
		return { who, input, detail: `clicked ${label}` };
	}

	switch (input) {
		case 'pause': {
			// The control is ONE toggle keyed on playback.isPlaying, so a `pause` when the room is
			// already paused is a no-op rather than a second command. Recorded as such: a replay must
			// see the same sequence, including the beats that did nothing.
			if (!playing) return { who, input, detail: 'no-op (already paused)', noop: true };
			return await tapTransport(SEL.play.name);
		}
		case 'resume': {
			if (playing) return { who, input, detail: 'no-op (already playing)', noop: true };
			return await tapTransport(SEL.play.name);
		}
		case 'skip':
			return await tapTransport(SEL.skip.name);
		case 'restart':
			return await tapTransport(SEL.restart.name);
		case 'seek': {
			// No seek control exists in the app; this is the wire command the control would send.
			// Mostly in-file, but 1 in 10 lands past EOF deliberately — a media element that hits the
			// end fires `ended`, which the server treats as advance-to-next, and that is a seam.
			const beyond = rnd() < 0.1;
			const positionSec = beyond ? int(60, 400) : int(0, 7);
			const r = await wirePlayer(page, { cmd: 'seek', positionSec });
			return { who, input, detail: `seek positionSec=${positionSec}${beyond ? ' (past EOF)' : ''} [wire: ${r}]` };
		}
		case 'key': {
			const cur = world.srv.playback?.keyShift ?? 0;
			const semitones = Math.max(-9, Math.min(9, cur + (rnd() < 0.5 ? -1 : 1) * int(1, 3)));
			const r = await wirePlayer(page, { cmd: 'key', semitones });
			return { who, input, detail: `key semitones=${semitones} (from ${cur}) [wire: ${r}]` };
		}
		case 'guide': {
			const clear = rnd() < 0.2;
			const level = clear ? null : Math.round(rnd() * 100) / 100;
			const r = await wirePlayer(page, { cmd: 'guide', level });
			return { who, input, detail: `guide level=${level} [wire: ${r}]` };
		}
		case 'queue-add': {
			const { ready, raw } = world.cat;
			if (ready.length === 0 && raw.length === 0) return { who, input, detail: 'no-op (empty library)', noop: true };
			// 30% of adds deliberately target a RAW song, which starts a cook and is the only way the
			// RESTART-DURING-COOK seam becomes reachable at all.
			const wantRaw = raw.length > 0 && (ready.length === 0 || rnd() < 0.3);
			const row = pick(wantRaw ? raw : ready);
			const term = String(row.title).split(/\s+/)[0].toLowerCase();
			await page.fill(SEL.search, term);
			try {
				await page.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length > 0`, { timeout: 15000 });
			} catch {
				return { who, input, detail: `no-op (search "${term}" returned no ${SEL.songRow})`, noop: true };
			}
			const nAdd = await page.count(SEL.addTurn);
			const nSing = await page.count(SEL.sing);
			if (wantRaw && nSing > 0) {
				await page.click(SEL.sing);
				detail = `search "${term}" → clicked ${SEL.sing} (queues AND starts a cook)`;
			} else if (nAdd > 0) {
				await page.click(SEL.addTurn);
				detail = `search "${term}" → clicked ${SEL.addTurn}`;
			} else if (nSing > 0) {
				await page.click(SEL.sing);
				detail = `search "${term}" → clicked ${SEL.sing}`;
			} else {
				return { who, input, detail: `no-op (search "${term}" offered no queue action)`, noop: true };
			}
			return { who, input, detail };
		}
		case 'queue-remove': {
			// No contract entry for the per-row remove button, so this is its wire op. Any joined singer
			// may remove any entry (capabilities.ts: every joined singer is a host), so the fuzzer is
			// allowed to remove a turn it did not add — including the one that is playing, which is the
			// dangling-current-entry seam.
			const candidates = (world.srv.entries ?? []).filter(
				(/** @type {any} */ e) => e.status === 'queued' || e.status === 'playing'
			);
			if (candidates.length === 0) return { who, input, detail: 'no-op (nothing in the queue)', noop: true };
			const target = pick(candidates);
			const r = await wireQueueOp(page, { op: 'remove', id: target.id }, fuzzId());
			return {
				who,
				input,
				detail: `remove entry ${target.id.slice(-6)} (status ${target.status}${
					target.id === world.srv.playback?.currentEntryId ? ', THE CURRENT ONE' : ''
				}) [wire: ${r}]`
			};
		}
		default:
			return { who, input, detail: 'unknown input', noop: true };
	}
}

// ── report ───────────────────────────────────────────────────────────────────────────────────────
/** @param {boolean} markLast */
function printSequence(markLast) {
	for (let i = 0; i < sequence.length; i++) {
		const s = sequence[i];
		const mark = markLast && i === sequence.length - 1 ? '  <-- the offending input' : '';
		console.log(
			`  ${String(i + 1).padStart(3)} ${s.who.padEnd(7)} ${s.input.padEnd(13)} ${s.detail}${
				s.seam ? `   [seam: ${s.seam}]` : ''
			}${mark}`
		);
	}
}

/**
 * @param {Violation} v
 * @param {World} world
 */
function reportViolation(v, world) {
	console.log('');
	console.log('════════════════════════════════════════════════════════════════════════════');
	console.log(`VIOLATION · ${v.id} — ${v.title}`);
	console.log('════════════════════════════════════════════════════════════════════════════');
	console.log(
		`  replay      FUZZ_SEED=${SEED}${AUTOPLAY ? ' FUZZ_AUTOPLAY=1' : ''} FUZZ_INPUTS=${N_INPUTS} bun run e2e:fuzz`
	);
	console.log(`  policy      ${AUTOPLAY ? 'autoplay granted — NOT-A-TV' : 'gestureless (a real TV)'}`);
	console.log(`  at input    #${sequence.length} of ${N_INPUTS}`);
	console.log('  sequence');
	printSequence(true);
	console.log(`  observed    ${v.observed}`);
	console.log(`  expected    ${v.expected}`);
	if (v.context) console.log(`  context     ${v.context}`);
	console.log('  room state');
	console.log(
		`    server    rev=${world.srv.rev} currentEntryId=${world.srv.playback?.currentEntryId} isPlaying=${world.srv.playback?.isPlaying} positionSec=${world.srv.playback?.positionSec} keyShift=${world.srv.playback?.keyShift} guideLevel=${world.srv.playback?.guideLevel}`
	);
	console.log(
		`    entries   ${(world.srv.entries ?? []).map((/** @type {any} */ e) => `${e.id.slice(-6)}:${e.status}@${e.rotationSeq}`).join(' ') || '(none)'}`
	);
	console.log(
		`    tv        nowSong=${JSON.stringify(world.tv.nowSong)} nowName=${JSON.stringify(world.tv.nowName)} attract=${world.tv.attract} activeWord=${JSON.stringify(world.tv.activeWord)}`
	);
	console.log(
		`    master    ${world.master ? `src=${world.master.src} paused=${world.master.paused} t=${world.master.currentTime.toFixed(2)} decoded=${world.master.decoded} err=${JSON.stringify(world.master.error)}` : 'none'} (${world.masterHow})`
	);
	console.log('');
}

function printSummary() {
	console.log('');
	console.log(
		`ran 1 opening add + ${sequence.length - 1} fuzzed inputs across ${phones.length} phones + the TV, seed ${SEED}, ${AUTOPLAY ? 'autoplay granted (NOT-A-TV)' : 'gestureless'}`
	);
	console.log('');
	console.log('invariant   checked  skipped  why it was skipped');
	/** @type {Record<InvariantId, string>} */
	const titles = {
		I1: 'currentTime monotonic within a song',
		I2: 'exactly one entry is `playing`',
		I3: 'TV rendered now-playing == server currentEntryId',
		I4: 'lyrics active index consistent with currentTime',
		I5: 'no entry both playing and waiting; rotation agrees',
		I6: 'decoded bytes climbing while the UI claims to play'
	};
	for (const id of /** @type {InvariantId[]} */ (['I1', 'I2', 'I3', 'I4', 'I5', 'I6'])) {
		const s = stats[id];
		console.log(
			`  ${id}       ${String(s.checked).padStart(6)}   ${String(s.skipped).padStart(6)}  ${[...s.why].join(' | ') || '—'}`
		);
		console.log(`             ${titles[id]}`);
	}
	console.log('');
	console.log('sequence');
	printSequence(false);
}

/**
 * THE GESTURE, DELIVERED — AND KEPT. #332 added a trusted real tap to the driver (cdp.mjs realClick,
 * proven 7/7 by p13-tap-to-start.mjs), but this randomised driver never called it — so gesturelessly
 * the TV never started and I4/I6 could only ever SKIP (#591 B). Deliver the real tap the first time
 * the room has a mounted master on the current song and claims to be playing, and re-apply it whenever
 * the CURRENT master is paused at its own preload floor under a playing room. No --autoplay-policy flag
 * is granted, so this is still a television; a viewer’s tap is the one gesture a living-room TV gets,
 * and on a real TV that gesture’s user activation is STICKY — it carries across the auto-advance a
 * skip triggers, so the next song plays without a second tap. Headless mounts a fresh <audio> per
 * entry and does not always re-apply that activation on its own, so re-tapping models the real TV
 * rather than inventing a permission: the tap is only ever re-applied to a master ALREADY sitting at
 * its preload floor, which is exactly the un-started state a real sticky activation would have cleared.
 *
 * The FIRST tap is recorded in the sequence as an explicit input so a replay stays faithful; later
 * re-applications are silent recovery of the same one gesture, not new inputs.
 *
 * autoplay-granted (NOT-A-TV) runs skip the tap entirely: the browser already needs no gesture there,
 * and the whole point of that policy is that it is not a television.
 * @param {World} world
 */
async function maybeDeliverTap(world) {
	if (AUTOPLAY) return;
	if (!world.master || !world.current) return;
	if (world.srv.playback?.isPlaying !== true) return;
	// Nothing to do once this master is genuinely playing (decoder past its floor).
	if (tapped && !(world.master.paused === true && atPreloadFloor(world))) return;
	await tv.realClick(960, 540); // trusted CDP Input gesture — the only thing that unblocks autoplay
	if (!tapped) {
		tapped = true;
		sequence.push({
			who: 'TV',
			input: 'real-tap',
			detail: 'the one real tap a viewer makes to start a gestureless TV (#591 B)'
		});
	}
	await sleep(1200); // let the decoder begin climbing before the next invariant read
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────────
let exitCode = 0;
try {
	browser = await connect(CDP_PORT);

	// Two phones, each its own isolated context and therefore its own session — two genuinely
	// different guests, not one guest in two tabs. That is the whole point of the topology: a
	// single-client sequence cannot produce a cross-surface disagreement.
	/** @param {string} name @returns {Promise<Page>} */
	async function newPhone(name) {
		const page = await /** @type {Browser} */ (browser).newPage();
		await page.viewport(390, 844);
		await page.goto(`${base}/join`);
		await page.fill(SEL.nameInput, name);
		await page.clickByText('Start singing');
		await page.waitFor(`document.querySelector(${JSON.stringify(SEL.search)}) !== null`, { timeout: 15000 });
		await openWire(page);
		// The transport lives in the queue sheet's peek; open the sheet so it is mounted and clickable.
		try {
			await page.click(SEL.peek);
		} catch {}
		return page;
	}
	phones.push(await newPhone(`FzA${NONCE}`));
	phones.push(await newPhone(`FzB${NONCE}`));

	tv = await browser.newPage();
	await tv.viewport(1920, 1080, 1);
	await tv.goto(`${base}/tv`);
	await tv
		.waitFor(`document.querySelector(${JSON.stringify(SEL.tvConnected)}) !== null`, { timeout: 15000 })
		.catch(() => {});

	// The room starts empty; seed it with one add so the first input has something to act on. Recorded
	// in the sequence like any other input, because it is one.
	{
		const world = await readWorld();
		const first = await driveInput('queue-add', world);
		sequence.push({ ...first, detail: `${first.detail} (opening add)` });
		await sleep(1200);
		await maybeDeliverTap(await readWorld());
	}

	let prev = null;
	for (let i = 0; i < N_INPUTS; i++) {
		const world = await readWorld();
		const w = {
			current: world.current,
			waiting: world.waiting,
			cooking: world.cooking
		};
		// The one real tap lands as soon as the room is playing a mounted master (#591 B). Faithful to a
		// living-room TV, and what makes I4/I6 measurable at all under the gestureless default.
		await maybeDeliverTap(world);
		const input = drawInput(prev, w);
		const seam = seamLabel(input, prev, w);
		const rec = await driveInput(input, world);
		sequence.push({ ...rec, seam });
		prev = input;

		await sleep(SETTLE_MS);
		const { v, world: after } = await checkAll(input);
		if (v) {
			reportViolation(v, after);
			exitCode = 1;
			break;
		}
	}

	if (exitCode === 0) {
		printSummary();
		// NON-VACUITY FLOOR (#591 B). I6 is the invariant this file calls the one that cannot be dropped;
		// a run that never got to evaluate it measured nothing about audio and must NOT wear a green badge.
		// Exit 2 ("the environment could not host the run") is the file’s own contract for a run that
		// proved nothing — never 0. Never conflate 2 with 0; that conflation is how the original hole hid.
		if (stats.I6.checked === 0) {
			console.log(
				'\nNON-VACUITY: I6 (decoded bytes climbing while the room claims to play) never evaluated — this run measured nothing about audio, so it cannot report green. Exiting 2.'
			);
			exitCode = 2;
		} else {
			console.log('\nall six invariants held after every input.');
		}
	}
} catch (err) {
	// An error in the DRIVER is an environment problem, not a room defect — reporting it as a violation
	// would be exactly the conflation requirement 8 forbids, one category over.
	console.error(`\nENVIRONMENT: the fuzzer could not complete its run: ${/** @type {any} */ (err)?.stack ?? err}`);
	if (sequence.length) {
		console.error('  sequence so far:');
		printSequence(false);
	}
	exitCode = 2;
} finally {
	try {
		browser?.close();
	} catch {}
	cleanup();
}

process.exit(exitCode);
