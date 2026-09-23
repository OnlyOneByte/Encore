// P14 — the playing song's playhead must not be affected by anything happening for PROCESSING. Get song
// A playing past the seek threshold, then process a DIFFERENT song B and watch A's playhead across B's
// whole process, which produces the real traffic: `media:status` frames, then `onMediaReady`'s
// `queue:sync` + `nowplaying:changed`. A backwards step in A's `currentTime` is the defect; A is proved
// to be really DECODING first, or a monotonic playhead proves nothing (docs/E2E.md#proving-audio).
//
//   PORT=5241 bun tests/e2e/probes/p14-playhead-vs-process.mjs
//
// NOT-A-TV: grants autoplay, because the invariant needs a MOVING playhead (docs/E2E.md#autoplay).

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { connect, sleep } from '../driver.mjs';
import { findChromium } from '../lib/chromium.mjs';
import { repoRoot } from '../lib/repo-root.mjs';

/**
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {import('node:child_process').ChildProcess} Child
 * @typedef {{ id: string, title: string, source: string }} Media a /api/search row, fields read here
 * @typedef {{ t: number, src: string, bytes: number, paused: boolean }} Readout what READ evaluates
 */

const PORT = Number(process.env.PORT ?? 5241);
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH = process.env.SCRATCH ?? join('/tmp', `e2e-${PORT}`);
const MEDIA_DIR = join(SCRATCH, 'media');

/** @type {Child[]} */
const children = [];
/** @param {string} cmd @param {string[]} args @param {import('node:child_process').SpawnOptions} [opts] */
function launch(cmd, args, opts = {}) {
	const p = spawn(cmd, args, { stdio: 'ignore', ...opts });
	children.push(p);
	return p;
}
function stopChildren() {
	while (children.length) {
		const p = children.pop();
		try {
			p?.kill('SIGKILL');
		} catch {
			/* the process may already have exited */
		}
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

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(MEDIA_DIR, { recursive: true });

const seed = launch('bun', ['run', 'tests/e2e/seed-media.mjs'], {
	cwd: repoRoot,
	env: { ...process.env, MEDIA_DIR }
});
await new Promise((r) => seed.on('exit', r));

launch('bun', ['run', './server.ts'], {
	cwd: repoRoot,
	env: {
		...process.env,
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
	env: { ...process.env, EPORT: String(PORT), MEDIA_DIR }
});
await sleep(1500);

// Search matches on TITLE, so one query cannot surface the whole library: union the four demo titles.
const QUERIES = ['caroline', 'believin', 'rhapsody', 'prayer'];
/** @type {Map<string, Media>} */
const found = new Map();
for (const q of QUERIES) {
	const d = await jget(`/api/search?q=${q}`);
	for (const m of /** @type {Media[]} */ ([...(d.ready ?? []), ...(d.results ?? [])])) {
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
/** Playable yet? Asked per-title, for the same reason the fixtures were. @param {string} id @param {string} q @returns {Promise<boolean>} */
async function isReady(id, q) {
	const d = await jget(`/api/search?q=${q}`);
	return (d.ready ?? []).some(/** @param {Media} m */ (m) => m.id === id);
}
console.log(`fixture A (plays): ${songA.title} [${songA.id}]`);
console.log(`fixture B (processes): ${songB.title} [${songB.id}]\n`);

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
// A PHONE first: the queue validator requires entry.singerId to equal the acting session's singer.
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

console.log(`\nprocessing B (${songB.title}) while A plays — sampling A's playhead\n`);
await processMedia(songB.id);

// The window is song A ONLY: a song CHANGE legitimately resets the playhead, so it closes the moment the
// element stops holding A's src, or the natural advance to the next song would read as the defect.
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
	`B reached ready inside the window: ${readyB}${readyAtT !== null ? ` (at A t=${readyAtT.toFixed(2)}s)` : ''}`
);

// Covers decoder jitter on a sampled element; the defect is a jump back to a stale COMMAND anchor, which
// is seconds, and seekPlan's own 1.5s threshold gates it anyway.
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
