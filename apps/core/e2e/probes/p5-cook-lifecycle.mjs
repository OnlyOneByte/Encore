/*
 * P5 — COOK LIFECYCLE, THE UNHAPPY PATHS.
 *
 * Drives the fake worker's fault-injection env vars (see HARNESS.md) end to end and reports what
 * actually reaches a phone/TV/library surface. Each scenario is a self-contained subroutine that:
 *   1. Wipes $SCRATCH, seeds, boots a fresh server on $PORT, spawns a phone WS observer, spawns the
 *      fake worker with that scenario's env vars.
 *   2. Joins, resolves a local media id, drives the requested action (make-karaoke, remove, kill,
 *      cap).
 *   3. Observes WS media:status frames, /api/library, /api/search, /media/<ref> and the job DB via
 *      the frames the server broadcasts.
 *   4. Reports findings by SEVERITY (CRITICAL/HIGH/MEDIUM/LOW) with the source path:line evidence,
 *      separate from any ENVIRONMENT LIMITS that make a proof impossible on this box.
 *
 *   PORT=5225 bun apps/core/e2e/probes/p5-cook-lifecycle.mjs
 *
 * Exit: 0 all defensible findings hold, 1 a real defect surfaced, 2 the environment could not host.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PORT = Number(process.env.PORT ?? 5225);
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH = process.env.SCRATCH ?? join(process.env.KIROCREW_SCRATCH ?? '/tmp', `e2e-${PORT}`);
const MEDIA_DIR = join(SCRATCH, 'media');
const REPO = resolve(new URL('../..', import.meta.url).pathname); // apps/core

const findings = [];
function record(severity, title, detail, evidence = []) {
	findings.push({ severity, title, detail, evidence });
	console.log(`\n[${severity}] ${title}`);
	if (detail) console.log(`  ${detail}`);
	for (const e of evidence) console.log(`  · ${e}`);
}
function bail(msg) {
	console.error(`\nENVIRONMENT: ${msg}`);
	process.exit(2);
}

// ── process management ─────────────────────────────────────────────────────
const spawned = [];
function launch(cmd, args, opts = {}) {
	const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
	spawned.push(p);
	return p;
}
function killAll() {
	for (const p of spawned) {
		try {
			if (p.pid && !p.killed) process.kill(p.pid, 'SIGKILL');
		} catch {}
	}
	spawned.length = 0;
}
process.on('exit', killAll);
process.on('SIGINT', () => {
	killAll();
	process.exit(130);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const r = await fetch(`${BASE}/health`);
			if (r.ok) return true;
		} catch {}
		await sleep(200);
	}
	return false;
}

// ── phone WS observer ───────────────────────────────────────────────────────
// Subscribes as a phone (with a session cookie) and appends every server event so a scenario can
// assert on the media:status sequence. Not a driver — a passive recorder.
function attachPhone(cookie) {
	const events = [];
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?role=phone`, { headers: { cookie } });
	// Bun WebSocket doesn't support headers in the ctor — use a plain global object with cookie.
	// Fallback via unauthenticated observer: presence events won't be attributed but media:status is
	// broadcast to the ROOM_TOPIC and reaches every subscriber regardless.
	return new Promise((resolve, reject) => {
		const rawWs = new WebSocket(`ws://127.0.0.1:${PORT}/ws?role=phone`);
		rawWs.onopen = () => {
			rawWs.send(JSON.stringify({ type: 'hello' }));
			resolve({
				events,
				close: () => rawWs.close(),
				statusOf: (mediaId) => events.filter((e) => e.type === 'media:status' && e.mediaId === mediaId),
				lastStatus: (mediaId) => {
					const list = events.filter((e) => e.type === 'media:status' && e.mediaId === mediaId);
					return list[list.length - 1];
				}
			});
		};
		rawWs.onerror = (e) => reject(new Error(`phone ws error ${e?.message ?? e}`));
		rawWs.onmessage = (m) => {
			try { events.push(JSON.parse(String(m.data))); } catch {}
		};
	});
}

// ── one-scenario harness ────────────────────────────────────────────────────
async function bootServer() {
	if (existsSync(SCRATCH)) rmSync(SCRATCH, { recursive: true, force: true });
	mkdirSync(join(MEDIA_DIR), { recursive: true });
	const seed = launch('bun', ['run', 'e2e/seed-media.mjs'], {
		cwd: REPO,
		env: { ...process.env, MEDIA_DIR }
	});
	await new Promise((r) => seed.on('exit', r));
	const serverLog = join(SCRATCH, 'server.log');
	const serverOut = Bun.file(serverLog).writer();
	const p = launch('bun', ['run', './server.ts'], {
		cwd: REPO,
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
	p.stdout.on('data', (d) => serverOut.write(d));
	p.stderr.on('data', (d) => serverOut.write(d));
	const ok = await waitForHealth();
	if (!ok) bail(`server did not come up on ${PORT}; see ${serverLog}`);
	return { proc: p, log: serverLog };
}

async function bootWorker(env, tag = 'worker') {
	const workerLog = join(SCRATCH, `${tag}.log`);
	const wOut = Bun.file(workerLog).writer();
	const p = launch('bun', ['e2e/fake-stems-worker.mjs'], {
		cwd: REPO,
		env: { ...process.env, EPORT: String(PORT), MEDIA_DIR, FAKE_WORKER_ID: tag, ...env }
	});
	p.stdout.on('data', (d) => wOut.write(d));
	p.stderr.on('data', (d) => wOut.write(d));
	// Wait a beat for the worker's WS handshake to reach the hub.
	await sleep(500);
	return { proc: p, log: workerLog };
}

async function joinRoom(name, color = 'violet') {
	const r = await fetchNoKeepalive(`${BASE}/api/join`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ displayName: name, color })
	});
	if (!r.ok) throw new Error(`join failed: ${r.status} ${await r.text()}`);
	// Read the Set-Cookie header so subsequent authed requests can present it.
	const raw = r.headers.get('set-cookie') ?? '';
	const m = /encore_singer=([^;]+)/.exec(raw);
	if (!m) throw new Error(`join returned no session cookie: ${raw}`);
	const cookie = `encore_singer=${m[1]}`;
	const body = await r.json();
	return { cookie, singerId: body.singer.id };
}

async function searchLocal(q) {
	// Retry once — between scenarios a stray keep-alive can surface as "Unable to connect" against
	// a server that is already answering /health. The retry stabilises fetch across the boundary.
	let lastErr;
	for (let i = 0; i < 5; i++) {
		try {
			const r = await fetchNoKeepalive(`${BASE}/api/search?q=${encodeURIComponent(q)}`);
			const d = await r.json();
			const hit = [...d.ready, ...d.cooking, ...d.results].find((x) => x.source === 'local');
			if (!hit) throw new Error(`no local match for "${q}" — ready=${d.ready.length} cooking=${d.cooking.length} results=${d.results.length}`);
			return hit;
		} catch (e) { lastErr = e; await sleep(500); }
	}
	throw lastErr;
}

/** Queue a song for the authenticated phone WS. Returns the entryId used. Fires an add op that
 *  passes validateCommand (WS has resolved singerId at upgrade from the cookie header). */
async function queueViaWs(phone, singerId, mediaId) {
	const entryId = `entry_${Math.random().toString(36).slice(2, 10)}`;
	const clientOpId = `op_${Math.random().toString(36).slice(2, 10)}`;
	phone.send({
		type: 'queue:command',
		command: {
			clientOpId,
			op: {
				op: 'add',
				entry: { id: entryId, mediaId, singerId, source: 'phone', requestedBy: 'guest' }
			}
		}
	});
	// Wait for the queue:patch that references this entry, or an op:reject for this clientOpId.
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		const rej = phone.events.find((e) => e.type === 'op:reject' && e.clientOpId === clientOpId);
		if (rej) throw new Error(`queue add rejected: ${rej.reason}`);
		const applied = phone.events.some((e) => e.type === 'queue:patch' && (e.patch?.entries ?? []).some((x) => x.id === entryId));
		if (applied) return entryId;
		await sleep(50);
	}
	throw new Error(`queue add timed out; last events: ${JSON.stringify(phone.events.slice(-3))}`);
}

/** Remove an entry via authenticated WS. Waits for the queue:patch or an op:reject. */
async function queueRemoveViaWs(phone, entryId) {
	const clientOpId = `op_${Math.random().toString(36).slice(2, 10)}`;
	const marker = phone.events.length;
	phone.send({
		type: 'queue:command',
		command: { clientOpId, op: { op: 'remove', id: entryId } }
	});
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		const rej = phone.events.find((e) => e.type === 'op:reject' && e.clientOpId === clientOpId);
		if (rej) throw new Error(`queue remove rejected: ${rej.reason}`);
		const patched = phone.events.slice(marker).some(
			(e) => e.type === 'queue:patch' && !(e.patch?.entries ?? []).some((x) => x.id === entryId)
		);
		if (patched) return;
		await sleep(50);
	}
	throw new Error(`queue remove timed out; last events: ${JSON.stringify(phone.events.slice(marker, marker + 5))}`);
}

async function requestCook(cookie, mediaId) {
	return fetchNoKeepalive(`${BASE}/api/make-karaoke`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie },
		body: JSON.stringify({ mediaId })
	});
}

async function queueSong(phoneWs, cookie, singerId, mediaId, entryId) {
	// The phone WS carries add ops; the singerId must match the WS session's actor. For probes we
	// bypass the WS by directly posting through the queue via a helper — but simpler: use the same
	// authenticated WS. That requires the WS to have been upgraded with our cookie; the WebSocket
	// polyfill here doesn't send arbitrary headers, so we do queue ops through a socket that DOES.
	return null; // unused in the probes below; kept as a stub in case a follow-up scenario needs it
}

// Open a WS handshake with a cookie header — needed for queue commands, which are only accepted
// after the singerId is resolved at upgrade. Node/Bun's global WebSocket does not accept headers,
// so we speak raw HTTP upgrade with Bun.connect().
async function openAuthedPhoneSocket(cookie) {
	const events = [];
	// Bun's fetch supports WebSocket upgrade — pass headers and it returns a Response you can .webSocket
	// no, actually the right API is `new WebSocket(url, { headers })` — Bun supports the second arg.
	// If that fails we fall through to unauthed.
	let ws;
	try {
		ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?role=phone`, { headers: { cookie } });
	} catch {
		ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?role=phone`);
	}
	await new Promise((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = (e) => reject(new Error(`ws open error: ${e?.message ?? e}`));
	});
	ws.onmessage = (m) => {
		try { events.push(JSON.parse(String(m.data))); } catch {}
	};
	ws.send(JSON.stringify({ type: 'hello' }));
	await sleep(100);
	return {
		ws,
		events,
		send: (obj) => ws.send(JSON.stringify(obj)),
		close: () => ws.close(),
		statusOf: (mediaId) => events.filter((e) => e.type === 'media:status' && e.mediaId === mediaId),
		lastStatus: (mediaId) => {
			const list = events.filter((e) => e.type === 'media:status' && e.mediaId === mediaId);
			return list[list.length - 1];
		}
	};
}

// Wait until a media:status matching a predicate arrives on the phone.
async function waitForStatus(phone, mediaId, predicate, timeoutMs = 15000, label = '') {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const last = phone.lastStatus(mediaId);
		if (last && predicate(last)) return last;
		await sleep(100);
	}
	const seen = phone.statusOf(mediaId).map((e) => `${e.status}@${e.pct ?? '?'}%`).join(' → ');
	throw new Error(`waitForStatus timeout${label ? ' (' + label + ')' : ''}: mediaId=${mediaId} seen: [${seen}]`);
}

async function cleanupScenario(server, worker) {
	try { worker?.proc.kill('SIGKILL'); } catch {}
	try { server?.proc.kill('SIGKILL'); } catch {}
	// Longer than a keep-alive: Bun's HTTP client pools sockets for 1-2s and a POST to a killed
	// server surfaces as "Unable to connect" against the fresh boot on the next scenario.
	await sleep(1500);
}

/** Fetch with Connection: close so Bun does not pool a socket across a scenario boundary. */
async function fetchNoKeepalive(url, init = {}) {
	const headers = { ...(init.headers ?? {}), connection: 'close' };
	return fetch(url, { ...init, headers, keepalive: false });
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios
// ─────────────────────────────────────────────────────────────────────────────

async function scenario1_silentInstrumental() {
	console.log('\n=== 1. FAKE_SILENT_INSTRUMENTAL — a floor-level instrumental must be refused ===');
	const server = await bootServer();
	const worker = await bootWorker({ FAKE_SILENT_INSTRUMENTAL: '1', FAKE_SLOW_MS: '150' }, 'silent-ins');
	try {
		const { cookie } = await joinRoom(`P5s1-${Date.now() % 100000}`);
		const phone = await openAuthedPhoneSocket(cookie);
		const media = await searchLocal('caroline');
		const r = await requestCook(cookie, media.id);
		if (!r.ok) throw new Error(`make-karaoke failed: ${r.status} ${await r.text()}`);
		const last = await waitForStatus(phone, media.id,
			(e) => e.status === 'ready' || e.status === 'failed', 10000, 'silent-ins terminal');
		// Independent server-side proof: /api/library will list a "cooked" song as ready.
		const lib = await (await fetchNoKeepalive(`${BASE}/api/library`)).json();
		const inReady = lib.library.some((m) => m.id === media.id);
		// The file on disk MUST be silent (all zeros beyond the 44-byte header) — check that too.
		const stemPath = join(MEDIA_DIR, 'derived', 'stems', `${media.id}-instrumental.wav`);
		const stemBytes = existsSync(stemPath) ? statSync(stemPath).size : 0;
		let allZeroAudio = false;
		if (stemBytes > 44) {
			const buf = await Bun.file(stemPath).arrayBuffer();
			const view = new Uint8Array(buf, 44);
			// Every sample is 0 (silence emits amp=0 which quantizes to 0).
			allZeroAudio = view.every((b) => b === 0);
		}
		if (last.status === 'ready' && inReady && allZeroAudio) {
			record('HIGH',
				'silent instrumental published as READY with no defense-in-depth in the core',
				'The worker wrote a floor-level WAV, reported it as stems.instrumental, and worker-hub#onComplete called markMediaReady unconditionally. media:status="ready" was broadcast to the phone; /api/library lists the song as ready. Nothing in the core measured the audio content of the reported instrumental — the ffmpeg loudness probe is only wired for boot-time vocals BACKFILL (app.ts:257-297), not for a live worker publish. The design note in setMediaVocals says the WORKER owns the content check, and the fake worker deliberately does not, but the harness table explicitly frames this as "the guard must refuse to publish it" — that guard is absent on the core side. A worker regression that removed its own silence check would silently ship a room-plays-nothing outage with no signal.',
				[
					`observed: media:status = "${last.status}" pct=${last.pct}, phone.events transitions=[${phone.statusOf(media.id).map(e => e.status).join(', ')}]`,
					`observed: /api/library.library contains ${media.id}: ${inReady}`,
					`observed: on-disk stem ${stemBytes} bytes, samples all-zero: ${allZeroAudio}`,
					'apps/core/src/server/jobs/worker-hub.ts:158-186 — #onComplete calls markMediaReady with reportedUri, no loudness check',
					'apps/core/src/server/media/loudness.ts:14-20 — ffmpegLoudnessProbe/isDigitalSilence exist',
					'apps/core/src/server/app.ts:257-297 — probe ONLY invoked for backfill, never for live publish',
					'apps/core/src/server/jobs/make-karaoke.ts:220-238 — markMediaReady only defends against a downrank, not a silent artifact',
					'ENV: this host has decode-only ffmpeg (no volumedetect), so even a wired guard would return null=unmeasurable=not-silent — a fix must therefore delegate content assurance to the worker OR ship a full ffmpeg with the core'
				]);
		} else if (last.status === 'failed') {
			record('LOW', 'silent instrumental defense works',
				`terminal status = failed, /api/library.contains=${inReady}, disk allZeroAudio=${allZeroAudio}`);
		} else {
			record('MEDIUM', 'silent instrumental behavior is ambiguous',
				`terminal status=${last.status}, /api/library.contains=${inReady}, allZeroAudio=${allZeroAudio}, stemBytes=${stemBytes}`);
		}
		phone.close();
	} finally {
		await cleanupScenario(server, worker);
	}
}

async function scenario2_silentVocals() {
	console.log('\n=== 2. FAKE_SILENT_VOCALS — a silent vocal must NOT fail the cook ===');
	const server = await bootServer();
	const worker = await bootWorker({ FAKE_SILENT_VOCALS: '1', FAKE_SLOW_MS: '150' }, 'silent-voc');
	try {
		const { cookie } = await joinRoom(`P5s2-${Date.now() % 100000}`);
		const phone = await openAuthedPhoneSocket(cookie);
		const media = await searchLocal('caroline');
		const r = await requestCook(cookie, media.id);
		if (!r.ok) throw new Error(`make-karaoke failed: ${r.status} ${await r.text()}`);
		const last = await waitForStatus(phone, media.id, (e) => e.status === 'ready' || e.status === 'failed', 10000);
		const lib = await (await fetchNoKeepalive(`${BASE}/api/library`)).json();
		const inReady = lib.library.some((m) => m.id === media.id);
		if (last.status === 'ready' && inReady) {
			// The vocals ref should be set (the fake worker still reports it) even though the file is
			// silent — the design says an absent ref means "no guide" and the worker trusts its own
			// content check, so an all-nulls stem still linked here matches the docstring intent.
			const catalog = lib.library.find((m) => m.id === media.id);
			const vocRef = catalog?.vocalsRef ?? null;
			record('LOW',
				'silent vocals do not fail the cook — instrumental gate satisfied, song still singable',
				`ready reached; vocalsRef=${vocRef}. Guide track is trusted from the worker (setMediaVocals docstring). Real Python worker would have measured silence and omitted the ref; the fake worker does not, so this test proves ONLY that the CORE completes cleanly with a silent-vocals report — content-side guarding is the worker's responsibility.`,
				[
					`observed: terminal status=${last.status}, /api/library.contains=${inReady}`,
					`observed: vocalsRef=${vocRef} — a workers-trust design (setMediaVocals docstring)`,
					'apps/core/src/server/jobs/make-karaoke.ts:410-421 — setMediaVocals trusts the worker report, does not probe content'
				]);
		} else {
			record('HIGH',
				'silent vocals broke the cook — the guide track is optional per docs',
				`observed terminal status=${last.status}. This contradicts setMediaVocals: "a song is perfectly playable with only the instrumental".`,
				[`observed transitions: [${phone.statusOf(media.id).map(e => e.status).join(', ')}]`]);
		}
		phone.close();
	} finally {
		await cleanupScenario(server, worker);
	}
}

async function scenario3_skipWrite() {
	console.log('\n=== 3. FAKE_SKIP_WRITE — worker reports refs for files it never wrote ===');
	const server = await bootServer();
	const worker = await bootWorker({ FAKE_SKIP_WRITE: '1', FAKE_SLOW_MS: '150' }, 'skip-write');
	try {
		const { cookie } = await joinRoom(`P5s3-${Date.now() % 100000}`);
		const phone = await openAuthedPhoneSocket(cookie);
		const media = await searchLocal('caroline');
		const r = await requestCook(cookie, media.id);
		if (!r.ok) throw new Error(`make-karaoke failed: ${r.status} ${await r.text()}`);
		const last = await waitForStatus(phone, media.id, (e) => e.status === 'ready' || e.status === 'failed', 10000);
		// Check the /media route for the reported ref. It SHOULD 404 — nothing on disk.
		const stemPath = join(MEDIA_DIR, 'derived', 'stems', `${media.id}-instrumental.wav`);
		const onDisk = existsSync(stemPath);
		const mediaResp = await fetchNoKeepalive(`${BASE}/media/derived/stems/${media.id}-instrumental.wav`, {
			headers: { range: 'bytes=0-1' }
		});
		if (last.status === 'ready' && !onDisk && mediaResp.status === 404) {
			record('HIGH',
				'unservable artifact — song published READY, /media 404s the instrumental',
				`worker-hub trusts the reported ref (markMediaReady, make-karaoke.ts:229). It does not fs.exists the ref, so a worker with a filesystem fault (partial write, wrong volume, race with an eviction) can flip the media to ready with a phantom path. The TV mounts <audio src=/media/...> and the range probe returns 404 — the TV shows no error class (see playback.mjs assumptions about the error field: many browsers just sit at readyState=0), and the phone shows the row as READY. The fault is invisible to every UI surface until a singer taps play.`,
				[
					`observed: terminal media:status = "${last.status}"`,
					`observed: on-disk file exists: ${onDisk}`,
					`observed: HTTP /media/... range=0-1 -> ${mediaResp.status}`,
					`observed: phone transitions [${phone.statusOf(media.id).map(e => e.status).join(', ')}]`,
					'apps/core/src/server/jobs/make-karaoke.ts:220-238 — markMediaReady sets stemStatus=ready + instrumentalRef, no fs.exists check',
					'apps/core/src/routes/media/[...path]/+server.ts:35, 46, 51, 70 — 404 responses are silent (no room broadcast, no automated re-cook)'
				]);
		} else if (last.status === 'failed') {
			record('LOW', 'skip-write was caught somewhere',
				`terminal=${last.status}, onDisk=${onDisk}, mediaHttp=${mediaResp.status}`);
		} else {
			record('MEDIUM', 'skip-write behavior ambiguous',
				`terminal=${last.status}, onDisk=${onDisk}, mediaHttp=${mediaResp.status}`);
		}
		phone.close();
	} finally {
		await cleanupScenario(server, worker);
	}
}

async function scenario4_noProfile() {
	console.log('\n=== 4. FAKE_NO_PROFILE — completion with no songProfile must not deadlock ===');
	const server = await bootServer();
	const worker = await bootWorker({ FAKE_NO_PROFILE: '1', FAKE_SLOW_MS: '150' }, 'no-profile');
	try {
		const { cookie } = await joinRoom(`P5s4-${Date.now() % 100000}`);
		const phone = await openAuthedPhoneSocket(cookie);
		const media = await searchLocal('caroline');
		const r = await requestCook(cookie, media.id);
		if (!r.ok) throw new Error(`make-karaoke failed: ${r.status} ${await r.text()}`);
		const last = await waitForStatus(phone, media.id, (e) => e.status === 'ready' || e.status === 'failed', 10000);
		const lib = await (await fetchNoKeepalive(`${BASE}/api/library`)).json();
		const cat = lib.library.find((m) => m.id === media.id);
		if (last.status === 'ready' && cat) {
			record('LOW',
				'no songProfile → normalized to EMPTY_SONG_PROFILE, gate satisfied, no deadlock',
				`ready reached, song listed in /api/library. setMediaSongProfile normalizes the absent record to EMPTY_SONG_PROFILE by design.`,
				[
					`observed: terminal status=${last.status}, catalog.songProfile=${JSON.stringify(cat.songProfile ?? null)}`,
					'apps/core/src/server/jobs/make-karaoke.ts:437-476 — setMediaSongProfile ALWAYS writes; presence, not content, satisfies the gate',
					'packages/shared/src/gates.ts:52-76 — stems gate checks stemStatus + instrumentalRef only, not the profile'
				]);
		} else {
			record('HIGH',
				'absent songProfile deadlocked or failed the cook',
				`terminal=${last.status}; contradicts gates.ts contract (profile is NOT a gate) and the make-karaoke docstring which explicitly avoids this class.`,
				[`observed transitions: [${phone.statusOf(media.id).map(e => e.status).join(', ')}]`]);
		}
		phone.close();
	} finally {
		await cleanupScenario(server, worker);
	}
}

async function scenario5_failStems() {
	console.log('\n=== 5. FAKE_FAIL=stems — visible failure on the phone, retryable ===');
	const server = await bootServer();
	const worker = await bootWorker({ FAKE_FAIL: 'stems', FAKE_SLOW_MS: '150' }, 'fail-stems');
	try {
		const { cookie } = await joinRoom(`P5s5-${Date.now() % 100000}`);
		const phone = await openAuthedPhoneSocket(cookie);
		const media = await searchLocal('caroline');
		const r = await requestCook(cookie, media.id);
		if (!r.ok) throw new Error(`make-karaoke failed: ${r.status} ${await r.text()}`);
		const last = await waitForStatus(phone, media.id,
			(e) => e.status === 'failed' || e.status === 'ready', 15000, 'fail-stems terminal');
		// After settleStemsGate, /api/search must return the song as re-cookable (unacquired, or at
		// least NOT ready/cooking) so the singer can retry.
		const search = await (await fetchNoKeepalive(`${BASE}/api/search?q=caroline`)).json();
		const inReady = search.ready.some((m) => m.id === media.id);
		const inCooking = search.cooking.some((m) => m.id === media.id);
		const inRaw = search.results.some((m) => m.id === media.id);
		// Retry: make-karaoke a SECOND time. If the settle worked, cookState returns 'cookable' and
		// the API returns a fresh job.
		const retry = await requestCook(cookie, media.id);
		const retryOk = retry.ok;
		const retryBody = await retry.json().catch(() => ({}));
		if (last.status === 'failed' && !inReady && !inCooking && inRaw && retryOk) {
			record('LOW',
				'failed cook surfaces visibly, media settles to un-cooked, retry is accepted',
				`terminal status=failed reached the phone; /api/search puts the song back in .results (un-cooked); a second make-karaoke returns 200 with a fresh job.`,
				[
					`observed: WS media:status transitions = [${phone.statusOf(media.id).map(e => e.status).join(', ')}]`,
					`observed: /api/search after fail — ready=${inReady} cooking=${inCooking} results=${inRaw}`,
					`observed: retry POST /api/make-karaoke -> ${retry.status}, jobId=${retryBody?.job?.id ?? 'null'}`,
					'apps/core/src/server/jobs/worker-hub.ts:225-252 — #onFailed calls settleStemsGate for fetch|stems',
					'apps/core/src/server/jobs/make-karaoke.ts:284-298 — settleStemsGate resets stemStatus to "none"',
					'apps/core/src/routes/+page.svelte:309-324 — cookingRows INCLUDES failed entries so the row is visible with a retry button',
					'apps/core/src/lib/components/SongRow.svelte:159-162 — readiness===failed renders the failure chip',
					'apps/core/src/lib/readiness.ts:34-44 — displayReadiness returns "failed" when live.status=failed and !readyToSing'
				]);
		} else {
			record('HIGH',
				'failed cook did not surface / settle / retry cleanly',
				`terminal=${last.status}; search.ready=${inReady} cooking=${inCooking} results=${inRaw}; retry status=${retry.status}`,
				[`observed transitions: [${phone.statusOf(media.id).map(e => e.status).join(', ')}]`]);
		}
		phone.close();
	} finally {
		await cleanupScenario(server, worker);
	}
}

async function scenario6_removeMidCook() {
	console.log('\n=== 6. REMOVE MID-COOK — status settles CANCELED, not FAILED ===');
	const server = await bootServer();
	// Progress frames every 5s keep the stems job alive long enough to remove it mid-flight.
	const worker = await bootWorker({ FAKE_SLOW_MS: '5000' }, 'slow-remove');
	try {
		const { cookie, singerId } = await joinRoom(`P5s6-${Date.now() % 100000}`);
		const phone = await openAuthedPhoneSocket(cookie);
		const media = await searchLocal('caroline');
		// Queue the song first — cancelJobsForMedia short-circuits when NO one still needs the media
		// (that is the correct behaviour when a shared cook is in flight). Our singleton entry means a
		// remove triggers the cancel + settle + broadcast we want to observe.
		const entryId = await queueViaWs(phone, singerId, media.id);
		const rc = await requestCook(cookie, media.id);
		if (!rc.ok) throw new Error(`make-karaoke failed: ${rc.status} ${await rc.text()}`);
		// Wait until the worker has actually reported progress (an in-flight stems job). Otherwise the
		// cancel arrives before findLive can find anything, and cancelJobsForMedia is a no-op.
		await waitForStatus(phone, media.id,
			(e) => (e.status === 'separating' || e.status === 'downloading') && (e.pct ?? 0) > 0,
			10000, 'first worker progress frame');
		// Now REMOVE — onEntryRemoved → cancelJobsForMedia → job:cancel + settleStemsGate + broadcast.
		await queueRemoveViaWs(phone, entryId);
		// Watch for the canceled broadcast. FAKE_SLOW_MS=5000 so the next progress frame is up to 5s
		// out; give the settle broadcast up to 8s.
		let last;
		try {
			last = await waitForStatus(phone, media.id,
				(e) => e.status === 'canceled' || e.status === 'failed' || e.status === 'ready',
				8000, 'post-remove settle');
		} catch (e) {
			last = phone.lastStatus(media.id) ?? { status: '<none>' };
		}
		const transitions = phone.statusOf(media.id).map((e) => e.status).join(' → ');
		if (last.status === 'canceled') {
			record('LOW',
				'mid-cook remove settles to CANCELED, not FAILED',
				`the phone received media:status=canceled after the queue remove; cancelJobsForMedia broadcasts a dedicated 'canceled' event instead of lying to the guest with 'failed'.`,
				[
					`observed: last media:status = "${last.status}" pct=${last.pct}`,
					`observed: full transitions = ${transitions}`,
					'apps/core/src/server/jobs/cancel.ts:117-133 — cancelJobsForMedia broadcasts { type:media:status, status:canceled } after settleStemsGate',
					'apps/core/src/lib/readiness.ts:41-43 — displayReadiness treats "canceled" as terminal and returns to catalog readiness (un-cooked), NOT "failed"',
					'apps/core/src/routes/+page.svelte:314-316 — cookingRows deliberately EXCLUDES canceled entries; the removed row does not linger'
				]);
		} else if (last.status === 'failed') {
			record('CRITICAL',
				'mid-cook remove lied to the guest — status=FAILED instead of CANCELED',
				`the guest deliberately removed their song and the phone told them the cook broke. Regresses the fix in cancel.ts:117-133.`,
				[`observed: transitions = ${transitions}`,
				 `observed: last media:status = ${JSON.stringify(last)}`]);
		} else {
			record('MEDIUM',
				'mid-cook remove: settle status did not arrive within 8s',
				`terminal=${last.status}. Transitions observed: ${transitions}. This may indicate a race where the cancel arrived before findLive could locate the running job, OR the media:status:canceled broadcast is not being sent for this scenario shape. See ${worker.log} for the worker's view.`,
				[`observed transitions: ${transitions}`,
				 'apps/core/src/server/jobs/cancel.ts:117-133 — settle broadcast']);
		}
		phone.close();
	} finally {
		await cleanupScenario(server, worker);
	}
}

async function scenario7_killWorker() {
	console.log('\n=== 7. KILL WORKER MID-COOK — reaper requeues the job ===');
	// The progress lease is 30s by default (leases.ts DEFAULT_LEASE_CONFIG), so this scenario needs
	// ≥30s wall time even in the happiest case. Also Bun.serve's idleTimeout=30 governs when the
	// dead worker's WS is detected as closed. Total budget: 30 (lease) + 3 (tick) + a few more.
	const server = await bootServer();
	const worker = await bootWorker({ FAKE_SLOW_MS: '4000' }, 'kill-target');
	try {
		const { cookie } = await joinRoom(`P5s7-${Date.now() % 100000}`);
		const phone = await openAuthedPhoneSocket(cookie);
		const media = await searchLocal('caroline');
		const r = await requestCook(cookie, media.id);
		if (!r.ok) throw new Error(`make-karaoke failed: ${r.status} ${await r.text()}`);
		// Wait for the FIRST progress frame — that stamps a fresh progressDeadline the reaper will
		// then time out. Without waiting we might kill the worker before the assign lands and the
		// only lease is an ack lease, which reaps far faster (10s) with different semantics.
		await waitForStatus(phone, media.id, (e) => (e.pct ?? 0) > 0, 12000, 'first progress frame');
		const killedAt = Date.now();
		process.kill(worker.proc.pid, 'SIGKILL');
		// Watch for any of the three signals the reaper produces on recovery:
		//   - a 'queued' broadcast (reaper requeued the job)
		//   - unservable:true on the media:status (dispatch found no capable worker after requeue)
		//   - a terminal 'failed' (attempts exhausted, though we only used 1 so this is unlikely)
		let terminal = null;
		let requeuedSignal = null;
		const deadline = killedAt + 90_000;
		while (Date.now() < deadline) {
			const events = phone.statusOf(media.id);
			const terminalEvt = events.find((e) => e.status === 'failed' || e.status === 'ready');
			if (terminalEvt) { terminal = terminalEvt.status; break; }
			const requeue = events.find((e) => e.unservable === true || e.status === 'queued');
			if (requeue) { requeuedSignal = requeue; break; }
			await sleep(500);
		}
		const elapsed = Math.round((Date.now() - killedAt) / 1000);
		if (requeuedSignal || terminal === 'failed') {
			record('LOW',
				`reaper handled the dead worker (${elapsed}s after SIGKILL)`,
				`After SIGKILL on the running worker, the progress lease expired and the reaper produced a recovery action. No forever-stranded job.`,
				[
					`observed: elapsed=${elapsed}s from SIGKILL to signal, requeue=${JSON.stringify(requeuedSignal ?? null)}, terminal=${terminal}`,
					'apps/core/src/server/jobs/reaper.ts:38-52 — tick() applies sweep actions on lease expiry',
					'apps/core/src/server/jobs/leases.ts:20-22 — DEFAULT_LEASE_CONFIG progressLeaseMs=30_000',
					'apps/core/src/server/jobs/leases.ts:56-77 — sweep bumps attempts on progress-lease-expired'
				]);
		} else {
			// Look at the server log for the reaper trace so a reader can see whether the tick ran.
			const log = existsSync(server.log)
				? readdirSync(SCRATCH).filter(Boolean)
				: [];
			record('HIGH',
				`worker kill did not trigger reaper recovery within 90s — job may be stranded`,
				`terminal=${terminal}, last media:status = ${JSON.stringify(phone.lastStatus(media.id))}. Server log: ${server.log}. This may be Bun-serve WS idle timeout (30s) + progress lease (30s) racing on a slow host.`,
				[`observed: elapsed=${elapsed}s, files in SCRATCH: ${log.join(',')}`,
				 'apps/core/src/server/jobs/leases.ts:20-22 — progress lease is 30s',
				 'apps/core/server.ts:79 — Bun.serve idleTimeout: 30']);
		}
		phone.close();
	} finally {
		await cleanupScenario(server, worker);
	}
}

async function scenario8_perSingerCap() {
	console.log('\n=== 8. MAX_CONCURRENT_COOKS_PER_SINGER — 429 with a human reason ===');
	const server = await bootServer();
	// Keep cooks in flight long enough that the cap actually pinches.
	const worker = await bootWorker({ FAKE_SLOW_MS: '5000', FAKE_CONCURRENCY: '3' }, 'cap-worker');
	try {
		const { cookie, singerId } = await joinRoom(`P5s8-${Date.now() % 100000}`);
		const phone = await openAuthedPhoneSocket(cookie);
		const queries = ['caroline', 'believin', 'bohemian', 'prayer'];
		const medias = [];
		for (const q of queries) {
			try { medias.push(await searchLocal(q)); }
			catch (e) { console.log(`  · skip "${q}": ${e.message}`); }
		}
		if (medias.length < 4) {
			record('MEDIUM',
				'per-singer cap could not be exercised — fewer than 4 local songs in the library',
				`only ${medias.length} local songs indexed; the cap is 3, so 4 distinct medias are needed. Seed the missing tracks under $MEDIA_DIR/library/ and re-run.`,
				['apps/core/src/server/jobs/make-karaoke.ts:56-64 — MAX_CONCURRENT_COOKS_PER_SINGER = 3']);
			phone.close();
			return;
		}
		// Attribution to a singer happens through their QUEUE ENTRIES (countInFlightCooks reads
		// state.entries filtered by singerId). Reproduce the client's cook-and-queue flow: queue
		// then cook per song, so the cap can actually see this singer's in-flight cooks.
		const rs = [];
		for (let i = 0; i < 3; i++) {
			await queueViaWs(phone, singerId, medias[i].id);
			rs.push(await requestCook(cookie, medias[i].id));
		}
		const okCount = rs.filter((r) => r.ok).length;
		if (okCount !== 3) {
			record('HIGH', 'per-singer cap: could not stage 3 concurrent cooks',
				`only ${okCount}/3 accepted; statuses=${rs.map((r) => r.status).join(',')}`);
			phone.close();
			return;
		}
		// The 4th tap: queue then cook. The cap must fire regardless of whether the queue add lands
		// first — countInFlightCooks counts distinct medias in this singer's cooking entries.
		await queueViaWs(phone, singerId, medias[3].id);
		const fourth = await requestCook(cookie, medias[3].id);
		const body = await fourth.json().catch(() => ({}));
		if (fourth.status === 429 && body?.reason === 'over-limit' && typeof body?.error === 'string' && body.error.length > 0) {
			record('LOW',
				'per-singer concurrent-cook cap: fourth tap is refused with 429 + human reason',
				`the API returned 429 with { reason:"over-limit", error:"${body.error}" } — a phone can render the message verbatim.`,
				[
					`observed: 3rd-song statuses=[${rs.map((r) => r.status).join(',')}] — all 200`,
					`observed: 4th tap status=${fourth.status}, body=${JSON.stringify(body)}`,
					'apps/core/src/routes/api/make-karaoke/+server.ts:31-40 — 429 branch names reason:"over-limit"',
					'apps/core/src/server/jobs/make-karaoke.ts:56-64,73-89 — MAX_CONCURRENT_COOKS_PER_SINGER + countInFlightCooks (attribution via queue entries)'
				]);
		} else if (fourth.status === 429) {
			record('MEDIUM',
				'per-singer cap returned 429 but the body is not the documented shape',
				`status=429 but body=${JSON.stringify(body)}. The phone reads reason:"over-limit" + error string; without the reason, generic 429 handling would fire.`);
		} else {
			// Cap did not fire — worth breaking down WHY. countInFlightCooks iterates queue entries; if
			// the queue adds were rejected the cap can never see this singer.
			const patches = phone.events.filter((e) => e.type === 'queue:patch');
			const totalEntries = patches[patches.length - 1]?.patch?.entries?.length ?? 0;
			record('HIGH',
				'per-singer cap did not fire when queue-then-cook was reproduced',
				`4th tap status=${fourth.status}, body=${JSON.stringify(body)}. Queue entries observed on last patch: ${totalEntries} (need ≥3 for the cap to trigger). NOTE: the cap only attributes cooks through singer queue entries (make-karaoke.ts:73-89 docstring). A direct API caller who never queues bypasses the cap by design — worth flagging on its own if that is undesired.`,
				['apps/core/src/server/jobs/make-karaoke.ts:56-64 — cap constant',
				 'apps/core/src/server/jobs/make-karaoke.ts:73-89 — attribution IS through queue entries, so a raw POST /api/make-karaoke without queueing bypasses the cap']);
		}
		phone.close();
	} finally {
		await cleanupScenario(server, worker);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
	// Preflight: is anything already on :PORT?
	try {
		const h = await fetch(`${BASE}/health`);
		if (h.ok) {
			bail(`port ${PORT} is already in use — probe requires an exclusive port`);
		}
	} catch {}

	const scenarios = [
		scenario1_silentInstrumental,
		scenario2_silentVocals,
		scenario3_skipWrite,
		scenario4_noProfile,
		scenario5_failStems,
		scenario6_removeMidCook,
		scenario7_killWorker,
		scenario8_perSingerCap
	];

	for (const s of scenarios) {
		try { await s(); }
		catch (e) {
			record('CRITICAL', `${s.name} threw during execution`, String(e?.stack ?? e));
		}
	}

	// ── Summary ───────────────────────────────────────────────────────────────
	console.log('\n\n=== P5 SUMMARY ===');
	const bySev = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [] };
	for (const f of findings) (bySev[f.severity] ?? []).push(f);
	for (const s of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) {
		if (bySev[s].length) {
			console.log(`\n${s}: ${bySev[s].length}`);
			for (const f of bySev[s]) console.log(`  • ${f.title}`);
		}
	}
	const failed = bySev.CRITICAL.length + bySev.HIGH.length;
	console.log(`\n${findings.length} findings total; ${failed} at CRITICAL/HIGH`);
	process.exit(failed ? 1 : 0);
}

await main();
