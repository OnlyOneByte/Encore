/*
 * P14 — DOES A PROCESS MOVE THE PLAYING SONG'S PLAYHEAD?
 *
 * The invariant under test, stated as the owner did: "the currently playing song should absolutely
 * NOT be affected by anything happening for processing."
 *
 * METHOD. Process song A, get it genuinely playing and past the seek threshold, then process song B — a
 * DIFFERENT media — and watch A's playhead across B's whole process. B's process produces the real event
 * traffic: `media:status` progress frames, then `onMediaReady`'s `queue:sync` + `nowplaying:changed`.
 * A backwards step in A's `currentTime` is the reported defect.
 *
 * WHY currentTime AND decoded bytes. `paused === false` is not proof of playback (see HARNESS.md), so
 * the run first establishes A is really decoding, and only then treats a backwards step as meaningful.
 * A monotonic playhead across a process with zero decode is not evidence of anything.
 *
 *   PORT=5241 bun tests/e2e/probes/p14-playhead-vs-process.mjs
 *
 * Exit: 0 the playhead held, 1 it moved backwards, 2 the environment could not host the test.
 *
 * NOT-A-TV: this probe GRANTS autoplay. It has to — the invariant is about a MOVING playhead being
 * perturbed, so the playhead must be moving, and a real TV's gestureless policy leaves it at 0.00
 * where nothing can be observed. This run therefore says nothing about whether a real television
 * starts on its own (that is p13's job); it says only what a process does to a song already playing.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { connect, sleep } from '../driver.mjs';
import { findChromium } from '../lib/chromium.mjs';
import { repoRoot } from '../lib/repo-root.mjs';

/**
 * Types for this out-of-program driver, which runs under tsconfig.e2e.json (following the
 * /pattern). Browser/Page are derived from driver.mjs's own return types so they cannot
 * drift from the driver. page.evaluate() is typed Promise<any> by driver.mjs, so DOM/API-shaped results
 * are cast at the call site.
 *
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {import('node:child_process').ChildProcess} Child
 *
 * A media row as returned by /api/search (the fields this probe reads).
 * @typedef {{ id: string, title: string, source: string }} Media
 *
 * The audio-element readout evaluated in the TV page by READ.
 * @typedef {{ t: number, src: string, bytes: number, paused: boolean }} Readout
 */

const PORT = Number(process.env.PORT ?? 5241);
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH = process.env.SCRATCH ?? join('/tmp', `e2e-${PORT}`);
const MEDIA_DIR = join(SCRATCH, 'media');

/** @type {Child[]} */
const children = [];
/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} [opts]
 */
function launch(cmd, args, opts = {}) {
	const p = spawn(cmd, args, { stdio: 'ignore',...opts });
	children.push(p);
	return p;
}
function stopChildren() {
	while (children.length) {
		const p = children.pop();
		try {
			p?.kill('SIGKILL');
		} catch {}
	}
}
process.on('exit', stopChildren);
/** @param {string} m @returns {never} */
const bail = (m) => {
	console.error(`\nENVIRONMENT: ${m}`);
	process.exit(2);
};

/** @param {string} path @returns {Promise<any>} */
const jget = async (path) => (await fetch(BASE + path)).json();

// ── boot a private instance ────────────────────────────────────────────────
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(MEDIA_DIR, { recursive: true });

const seed = launch('bun', ['run', 'tests/e2e/seed-media.mjs'], {
	cwd: repoRoot,
	env: {...process.env, MEDIA_DIR }
});
await new Promise((r) => seed.on('exit', r));

launch('bun', ['run', './server.ts'], {
	cwd: repoRoot,
	env: {...process.env,
		ENCORE_EPHEMERAL: '1',
		PORT: String(PORT),
		HOST: '127.0.0.1',
		MEDIA_DIR,
		ENCORE_LYRICS_BACKFILL: '0',
		ENCORE_VOCALS_BACKFILL: '0'
	}
});
for (let i = 0; i < 80; i++) {
	try {
		await fetch(BASE + '/health');
		break;
	} catch {
		await sleep(500);
	}
}
launch('bun', ['tests/e2e/fake-stems-worker.mjs'], {
	cwd: repoRoot,
	env: {...process.env, EPORT: String(PORT), MEDIA_DIR }
});
await sleep(1500);

// ── join, then process two DIFFERENT songs ───────────────────────────────────
// Search matches on title, so one query does not surface the whole seeded library. Union across the
// four demo titles (seed-media.mjs) and de-duplicate by id.
const QUERIES = ['caroline', 'believin', 'rhapsody', 'prayer'];
/** @type {Map<string, Media>} */
const found = new Map();
for (const q of QUERIES) {
	const d = await jget(`/api/search?q=${q}`);
	for (const m of /** @type {Media[]} */ ([...(d.ready ?? []),...(d.results ?? [])])) {
		if (m.source === 'local' && !found.has(m.id)) found.set(m.id, m);
	}
}
const uniq = [...found.values()];
if (uniq.length < 2) bail(`need 2 distinct local fixtures, found ${uniq.length}`);
const [songA, songB] = uniq;
/** @param {Media} song @returns {string} */
const qOf = (song) => QUERIES.find((q) => song.title.toLowerCase().includes(q)) ?? QUERIES[0];
const qA = qOf(songA);
const qB = qOf(songB);
/** Has this media id become playable? Asked per-title, for the same reason the fixtures were. */
/**
 * @param {string} id
 * @param {string} q
 * @returns {Promise<boolean>}
 */
async function isReady(id, q) {
	const d = await jget(`/api/search?q=${q}`);
	return (d.ready ?? []).some(/** @param {Media} m */ (m) => m.id === id);
}
console.log(`fixture A (plays): ${songA.title} [${songA.id}]`);
console.log(`fixture B (processes): ${songB.title} [${songB.id}]\n`);

// ── drive the TV ──────────────────────────────────────────────────────────
const chromium = findChromium();
if (!chromium) bail('no Chromium found. Set PW_CHROMIUM.');

await sleep(2500);

/** @type {Browser | undefined} */
let browserMaybe;
try {
	browserMaybe = await connect();
} catch (err) {
	bail(`could not attach to Chromium: ${/** @type {Error} */ (err).message}`);
}
if (!browserMaybe) bail('could not attach to Chromium');
const browser = browserMaybe;
// A PHONE first: the singer session and the queue socket both have to be a real client, because the
// queue validator requires entry.singerId to equal the acting session's singer.
const phone = await browser.newPage();
await phone.goto(`${BASE}/`);
const singerId = await phone.evaluate(`(async () => {
  const r = await fetch('/api/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'P14-${process.pid}', color: '#ff5cae' })
  });
  const d = await r.json().catch(() => ({}));
  return d?.singer?.id ?? d?.id ?? null;
})()`);
if (!singerId) bail('phone join did not yield a singer id');

/** Open a raw socket in the phone page, so ops carry that page's session. */
async function ensureProbeWs() {
	await phone.evaluate(`(async () => {
    if (window.probeWs && window.probeWs.readyState === 1) return;
    const proto = location.protocol === 'https:' ? 'wss': 'ws';
    const ws = new WebSocket(proto + '://' + location.host + '/ws?role=phone');
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws open failed')); });
    window.probeWs = ws;
  })()`);
}
/** @param {string} mediaId */
async function queueAdd(mediaId) {
	await ensureProbeWs();
	const now = Date.now();
	const entry = {
		id: `p14-e-${now}-${Math.floor(Math.random() * 1e6)}`,
		mediaId,
		singerId,
		status: 'queued',
		rotationSeq: Number.MAX_SAFE_INTEGER,
		addedAt: now
	};
	const command = {
		clientOpId: `p14-o-${now}-${Math.floor(Math.random() * 1e6)}`,
		op: { op: 'add', entry }
	};
	await phone.evaluate(
		`window.probeWs.send(JSON.stringify({ type: 'queue:command', command: ${JSON.stringify(command)} }))`
	);
	await sleep(300);
}
/** @param {string} mediaId @returns {Promise<number>} */
const processMedia = (mediaId) =>
	phone.evaluate(`fetch('/api/process', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mediaId: ${JSON.stringify(mediaId)} })
  }).then(r => r.status)`);

// Process A and queue it, so the room has a real song to sing.
await processMedia(songA.id);
let readyA = false;
for (let i = 0; i < 120; i++) {
	if (await isReady(songA.id, qA)) {
		readyA = true;
		break;
	}
	await sleep(500);
}
if (!readyA) bail('song A never processed');
await queueAdd(songA.id);

const page = await browser.newPage();
await page.goto(`${BASE}/tv`);

const READ = `(() => {
  const els = [...document.querySelectorAll('audio')];
  const m = els.find(e => e.currentSrc && e.currentSrc.includes('/media/'));
  return m ? { t: m.currentTime, src: m.currentSrc, bytes: m.webkitAudioDecodedByteCount ?? 0, paused: m.paused }: null;
})()`;

try {
	// Past SEEK_JUMP_SEC (1.5s) by a clear margin, so a stale-anchor re-seek is unambiguous.
	await page.waitFor(`(${READ})?.t > 3`, { timeout: 60000 });
} catch (err) {
	bail(`song A never reached a playhead past 3s — nothing to perturb. ${/** @type {Error} */ (err).message}`);
}

const before = /** @type {Readout} */ (await page.evaluate(READ));
console.log(`A playing: t=${before.t.toFixed(2)}s decoded=${before.bytes}B paused=${before.paused}`);
if (before.bytes <= 32768) bail(`A is not really decoding (${before.bytes}B) — a held playhead would prove nothing`);

// ── the actual test: process B while A plays ────────────────────────────────
console.log(`\nprocessing B (${songB.title}) while A plays — sampling A's playhead\n`);
await processMedia(songB.id);

// The window is song A ONLY. A song CHANGE legitimately resets the playhead, so the moment the
// element stops holding A's src the window closes — otherwise the natural advance to the next song
// would read as the very defect under test.
const srcA = before.src;
let prev = before.t;
let worstDrop = 0;
/** @type {{ from: number, to: number } | null} */
let worstAt = null;
let readyB = false;
let readyAtT = null;
let samples = 0;
let closedBecause = 'sampling budget spent';
for (let i = 0; i < 90; i++) {
	await sleep(200);
	const now = await page.evaluate(READ);
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
	if (!readyB && (await isReady(songB.id, qB))) {
		readyB = true;
		readyAtT = now.t;
		console.log(
			`  B reported READY at A t=${now.t.toFixed(2)}s — onMediaReady's queue:sync + nowplaying:changed land here`
		);
	}
}

console.log(`\nwindow closed: ${closedBecause}`);
console.log(`samples inside A: ${samples}, last playhead ${prev.toFixed(2)}s`);
console.log(
	`B reached ready inside the window: ${readyB}${readyAtT !== null ? ` (at A t=${readyAtT.toFixed(2)}s)`: ''}`
);

// A 0.25s tolerance covers ordinary decoder jitter on a sampled element; the defect is a jump back to
// a stale COMMAND anchor, which is seconds, and is gated by seekPlan's own 1.5s threshold anyway.
const TOL = 0.25;
if (worstDrop > TOL) {
	console.error(`\nFAIL — A's playhead moved BACKWARDS ${worstDrop.toFixed(2)}s during B's process`);
	if (worstAt) console.error(`  ${worstAt.from.toFixed(2)}s -> ${worstAt.to.toFixed(2)}s`);
	console.error('  Processing another song perturbed the playing song.');
	process.exit(1);
}
if (!readyB) {
	bail(`B never processed inside A's window (${closedBecause}), so the onMediaReady burst was not observed`);
}
console.log(`\nPASS — A's playhead never stepped back (worst delta ${worstDrop.toFixed(3)}s, tol ${TOL}s)`);
console.log("       across B's media:status progress frames AND its onMediaReady queue:sync burst.");
process.exit(0);
