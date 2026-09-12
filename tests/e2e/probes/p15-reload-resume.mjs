/*
 * P15 — DOES A MID-SONG TV RELOAD RESUME AT THE ROOM POSITION?
 *
 * The reported defect: reloading the TV page mid-song restarted the song from 0 instead of resuming
 * where the room is, and the reloaded TV's own telemetry then dragged the server's position backwards,
 * so every phone's progress bar jumped back with it.
 *
 * METHOD. Process song A, get it genuinely playing and past the seek threshold, record the room position
 * from the phone socket's `playback:state`. Then RELOAD the TV page — a cold mount, the exact repro —
 * and watch the fresh master's playhead. On a cold mount the room's position rides `playback:state`,
 * which the server sends before the `nowplaying:changed` that mounts the <audio>, so the fix has to
 * HOLD that position and apply it on the master's `canplay`. A fresh master stuck near 0 while the
 * room is at ~6s is the defect. As the corroborating half, the server position must NOT fall after the
 * reload (the backwards-telemetry drag).
 *
 *   PORT=5251 bun tests/e2e/probes/p15-reload-resume.mjs
 *
 * Exit: 0 the reload resumed at the room position and the server position held, 1 it restarted from 0
 * or dragged the server backwards, 2 the environment could not host the test.
 *
 * NOT-A-TV: this probe GRANTS autoplay. It has to — a reload has to resume a MOVING playhead, and a
 * real TV's gestureless policy leaves it at 0.00 where nothing can be observed (see p13/p14). This run
 * says nothing about whether a real television starts on its own; it says only what a reload does to a
 * song already playing.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connect, sleep } from '../driver.mjs';
import { findChromium } from '../lib/chromium.mjs';

/**
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {import('node:child_process').ChildProcess} Child
 * @typedef {{ id: string, title: string, source: string }} Media
 * @typedef {{ t: number, src: string, bytes: number, paused: boolean }} Readout
 */

const PORT = Number(process.env.PORT ?? 5251);
const CDP_PORT = Number(process.env.CDP_PORT ?? PORT + 100);
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH = process.env.SCRATCH ?? join('/tmp', `e2e-${PORT}`);
const MEDIA_DIR = join(SCRATCH, 'media');
const CORE = resolve(new URL('../..', import.meta.url).pathname);

/** @type {Child[]} */
const children = [];
/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} [opts]
 */
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
/**
 * The room's authoritative position. The server exposes playback state only over the WebSocket
 * (`playback:state` frames), not over HTTP, so the phone socket records the latest reported
 * positionSec (see `ensureProbeWs`) and this reads it back out of the phone page.
 * @returns {Promise<number>}
 */
const roomPos = async () => Number(await phone.evaluate(`window.__roomPos ?? NaN`));

// ── boot a private instance ────────────────────────────────────────────────
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(MEDIA_DIR, { recursive: true });

const seed = launch('bun', ['run', 'e2e/seed-media.mjs'], {
	cwd: CORE,
	env: { ...process.env, MEDIA_DIR }
});
await new Promise((r) => seed.on('exit', r));

launch('bun', ['run', './server.ts'], {
	cwd: CORE,
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
launch('bun', ['e2e/fake-stems-worker.mjs'], {
	cwd: CORE,
	env: { ...process.env, EPORT: String(PORT), MEDIA_DIR }
});
await sleep(1500);

// ── join, process one song ────────────────────────────────────────────────────
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
if (uniq.length < 1) bail(`need 1 local fixture, found ${uniq.length}`);
const songA = uniq[0];
/** @param {Media} song @returns {string} */
const qOf = (song) => QUERIES.find((q) => song.title.toLowerCase().includes(q)) ?? QUERIES[0];
const qA = qOf(songA);
/**
 * @param {string} id
 * @param {string} q
 * @returns {Promise<boolean>}
 */
async function isReady(id, q) {
	const d = await jget(`/api/search?q=${q}`);
	return (d.ready ?? []).some(/** @param {Media} m */ (m) => m.id === id);
}
console.log(`fixture A (plays): ${songA.title} [${songA.id}]\n`);

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

const phone = await browser.newPage();
await phone.goto(`${BASE}/`);
const singerId = await phone.evaluate(`(async () => {
  const r = await fetch('/api/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'P15-${process.pid}', color: '#ff5cae' })
  });
  const d = await r.json().catch(() => ({}));
  return d?.singer?.id ?? d?.id ?? null;
})()`);
if (!singerId) bail('phone join did not yield a singer id');

async function ensureProbeWs() {
	await phone.evaluate(`(async () => {
    if (window.probeWs && window.probeWs.readyState === 1) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(proto + '://' + location.host + '/ws?role=phone');
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws open failed')); });
    // Record the room's authoritative position from every playback:state frame — the server does not
    // expose it over HTTP, so this socket is the only read.
    window.__roomPos = NaN;
    ws.addEventListener('message', (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m && m.type === 'playback:state' && m.state && typeof m.state.positionSec === 'number') {
          window.__roomPos = m.state.positionSec;
        }
      } catch {}
    });
    // Ask for a fresh authoritative snapshot so __roomPos is populated even between telemetry frames.
    ws.send(JSON.stringify({ type: 'hello' }));
    window.probeWs = ws;
  })()`);
}
/** @param {string} mediaId */
async function queueAdd(mediaId) {
	await ensureProbeWs();
	const now = Date.now();
	const entry = {
		id: `p15-e-${now}-${Math.floor(Math.random() * 1e6)}`,
		mediaId,
		singerId,
		status: 'queued',
		rotationSeq: Number.MAX_SAFE_INTEGER,
		addedAt: now
	};
	const command = {
		clientOpId: `p15-o-${now}-${Math.floor(Math.random() * 1e6)}`,
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
  return m ? { t: m.currentTime, src: m.currentSrc, bytes: m.webkitAudioDecodedByteCount ?? 0, paused: m.paused } : null;
})()`;

try {
	// Past SEEK_JUMP_SEC (1.5s) by a clear margin, so a resume vs a restart-from-0 is unambiguous.
	await page.waitFor(`(${READ})?.t > 3`, { timeout: 60000 });
} catch (err) {
	bail(`song A never reached a playhead past 3s — nothing to resume. ${/** @type {Error} */ (err).message}`);
}

const before = /** @type {Readout} */ (await page.evaluate(READ));
const roomBefore = await roomPos();
console.log(
	`A playing: TV t=${before.t.toFixed(2)}s decoded=${before.bytes}B | server positionSec=${roomBefore.toFixed(2)}s`
);
if (before.bytes <= 32768) bail(`A is not really decoding (${before.bytes}B) — a resume would prove nothing`);
if (!Number.isFinite(roomBefore) || roomBefore <= 3) bail(`server position is not past 3s (${roomBefore}) — no resume to test`);

// ── the actual test: RELOAD the TV mid-song ───────────────────────────────
console.log(`\nreloading /tv mid-song (room at ${roomBefore.toFixed(2)}s) — the repro\n`);
await page.goto(`${BASE}/tv`);

// Wait for the fresh master to mount and reach a real decode, then read where it landed.
let after = null;
for (let i = 0; i < 80; i++) {
	await sleep(200);
	const r = /** @type {Readout | null} */ (await page.evaluate(READ));
	if (r && r.bytes > 32768) {
		after = r;
		break;
	}
}
if (!after) bail('the reloaded TV never mounted a decoding master — cannot judge the resume');
const roomAfter = await roomPos();
console.log(
	`after reload: TV t=${after.t.toFixed(2)}s decoded=${after.bytes}B | server positionSec=${roomAfter.toFixed(2)}s`
);

// (1) The fresh master must have RESUMED near the room position, not restarted from 0. The room keeps
// advancing while the reload completes, so compare to the CURRENT room position with a generous
// tolerance for reload+decode latency; the defect (restart from 0) is the whole song away.
const RESUME_TOL = 2.5;
const gap = Math.abs(after.t - roomAfter);
// (2) The server position must not have been dragged BACKWARDS by the reloaded TV's telemetry. It only
// ever advances; a fall below where it was before the reload is the backwards-drag half of the cold-mount defect.
const SERVER_DRAG_TOL = 0.5;
const serverDrop = roomBefore - roomAfter;

let failed = false;
if (gap > RESUME_TOL) {
	console.error(
		`\nFAIL — the reloaded master did NOT resume: TV t=${after.t.toFixed(2)}s vs room ${roomAfter.toFixed(2)}s (gap ${gap.toFixed(2)}s > ${RESUME_TOL}s).`
	);
	console.error('  A cold-mounted TV restarted the song from ~0 instead of resuming.');
	failed = true;
}
if (serverDrop > SERVER_DRAG_TOL) {
	console.error(
		`\nFAIL — the reloaded TV dragged the server position BACKWARDS ${serverDrop.toFixed(2)}s (${roomBefore.toFixed(2)}s -> ${roomAfter.toFixed(2)}s).`
	);
	console.error("  The fresh master's telemetry overwrote the room position from 0.");
	failed = true;
}
if (failed) process.exit(1);

console.log(
	`\nPASS — the reload resumed at the room position (gap ${gap.toFixed(2)}s, tol ${RESUME_TOL}s) and the server position held (drop ${serverDrop.toFixed(2)}s, tol ${SERVER_DRAG_TOL}s).`
);
process.exit(0);
