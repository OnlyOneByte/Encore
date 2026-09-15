/*
 * P4 — TRANSPORT, SEEK AND POSITION TELEMETRY.
 *
 * The transport controls are the room's second-most user-visible surface (after the queue). Every
 * failure mode below is one where the DOM says the tap landed while the media element did nothing,
 * or where the server's authoritative state falls out of step with what a phone renders. Both are
 * silent from the vantage point of unit tests, which is why this is a probe.
 *
 * SCOPE
 *   T1  play/pause/skip/restart each move the master <audio> as documented.
 *   T2  a `seek` command lands the playhead within tolerance, decoding continues, and the mid-file
 *       206 is what makes that possible (asserted against the /media route directly).
 *   T3  server `PlaybackState.positionSec` tracks the TV — no telemetry drops leave the server
 *       pinned at 0. Corroborated with a raw WS probe (`hello` returns the authoritative value) and
 *       two phones' rendered progress bars.
 *   T4  pausing does NOT reset the phone progress bar to 0 (the reported symptom of the
 *       telemetry-drop class of bug).
 *   T5  transport controls are DISABLED when nothing is playable, rather than dispatching commands
 *       the server would ignore.
 *   T6  skip on the LAST song goes to attract cleanly (no current, playback halted).
 *   T7  restart returns the playhead to 0 and decoding continues from there.
 *
 * DECISIVENESS
 *   The two invisible failures worth naming:
 *     (a) `paused === false` does not prove decoding — a media element reports that while stuck at
 *         currentTime 0 behind a failed decode. The proof of a real transport action is a fresh
 *         `webkitAudioDecodedByteCount` READING taken AFTER the action climbing past what it was
 *         BEFORE it, corroborated by `currentTime` moving against the wall clock.
 *     (b) The phone's `displayPos` interpolates locally from the last `playback:state` anchor plus a
 *         wall clock. During PLAY it climbs perfectly even if telemetry is dropping — the bar's
 *         value is only ever the server's authoritative anchor at PAUSE. So this probe waits for
 *         `isPlaying:false` broadcasts before reading the phone bar.
 *
 * EXIT CODES
 *   0 all passed · 1 a real failure · 2 the environment could not host the test (no server,
 *   no Chromium, no processed song).
 */
import { join } from 'node:path';
import { connect, sleep } from '../driver.mjs';
import { SEL } from '../contract.ts';
import { findChromium } from '../lib/chromium.mjs';
import { openBrowseFromHome, returnHomeFromBrowse, openNowPlaying } from '../lib/phone.mjs';

/**
 * Types for this out-of-program driver, which runs under tsconfig.e2e.json (following the
 * pattern the other out-of-program drivers use). Browser/Page are derived from driver.mjs's own return types so they
 * cannot drift from the driver. page.evaluate()/fetch().json() come back Promise<any>, so DOM/API-shaped
 * results are cast at the call site via the domain typedefs below.
 *
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO'} Severity
 *
 * One finding row: a pass/fail check with its severity, name and evidence.
 * @typedef {{ severity: Severity, name: string, ok: boolean, detail: string }} Finding
 *
 * One ready/search row from /api/search (only the fields this probe reads).
 * @typedef {{ id: string, title: string, instrumentalRef: string }} ReadyRow
 *
 * The master <audio> reading the masterProbe returns for one element.
 * @typedef {{
 *   src: string, readyState?: number, paused: boolean | null, muted?: boolean, volume?: number,
 *   currentTime: number, duration: number, decoded: number | null,
 *   error?: { code: number, message: string } | null, visible?: boolean
 * }} Master
 *
 * The authoritative server PlaybackState this probe reads over a raw WS.
 * @typedef {{ positionSec: number, isPlaying: boolean, currentEntryId: string | null }} PlaybackState
 * @typedef {{ state: PlaybackState, rev: number }} ServerPlayback
 */

const PORT = process.env.EPORT ?? '5224';
const base = `http://127.0.0.1:${PORT}`;
const wsBase = `ws://127.0.0.1:${PORT}`;

/** @type {Finding[]} */
const findings = [];
/**
 * @param {Severity} severity
 * @param {string} name
 * @param {unknown} ok
 * @param {string} [detail]
 */
function record(severity, name, ok, detail = '') {
	findings.push({ severity, name, ok: !!ok, detail });
	const badge = ok ? 'PASS' : severity;
	console.log(`${badge.padEnd(8)}${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}
/** @param {string} msg @returns {never} */
function bail(msg) {
	console.error(`\nENVIRONMENT: ${msg}`);
	process.exit(2);
}

// ── env preflight ────────────────────────────────────────────────────────────────────────────────
const chromium = findChromium();
if (!chromium) bail('no Chromium found. Set PW_CHROMIUM.');
if (!(await fetch(`${base}/health`).catch(() => null))?.ok) {
	bail(`no Encore server on ${base}. See tests/e2e/HARNESS.md for boot instructions.`);
}
const searchInit = await fetch(`${base}/api/search?q=caroline`).then((r) => r.json());
const processedIds = new Set((searchInit.ready ?? []).map((/** @type {ReadyRow} */ r) => r.id));
if (processedIds.size === 0) {
	bail('no READY song in the library — nothing to play.\n' + '  Seed + process one first (HARNESS.md §Process a song).');
}
// The first ready row is what the TV will pick up when a singer queues it.
const firstReady = (searchInit.ready ?? [])[0];
console.log(`fixture: "${firstReady.title}" → ${firstReady.instrumentalRef}\n`);

// ── raw WS probe: read authoritative state without a joined singer ──────────────────────────────
// A `hello` frame gets back queue:sync + playback:state + nowplaying:changed. We only need the last
// playback:state, which is the authoritative positionSec the server thinks the TV is at.
/** @param {number} [timeoutMs] @returns {Promise<ServerPlayback>} */
async function readServerPlayback(timeoutMs = 2500) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${wsBase}/ws?role=probe`);
		let done = false;
		const t = setTimeout(() => {
			if (!done) {
				done = true;
				try {
					ws.close();
				} catch { /* already closed, or never opened */ }
				reject(new Error('WS probe timeout'));
			}
		}, timeoutMs);
		ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', lastRev: 0 }));
		ws.onmessage = (ev) => {
			const e = JSON.parse(String(ev.data));
			if (e.type === 'playback:state') {
				done = true;
				clearTimeout(t);
				try {
					ws.close();
				} catch { /* already closed, or never opened */ }
				resolve({ state: e.state, rev: e.rev });
			}
		};
		ws.onerror = (err) => {
			if (!done) {
				done = true;
				clearTimeout(t);
				reject(err);
			}
		};
	});
}

// ── browser boot ──────────────────────────────────────────────────────────────────────────────────


// The TV probes the master element by looking for the audio element inside the VISIBLE slot. The
// gapless controller mounts TWO slots (A and B); the hidden slot pre-warms the upNext song and
// exposes its own <audio> element too, PAUSED. A heuristic that grabs any audio with an
// 'instrumental' src can pick the pre-warm one (paused, currentTime 0, decoded 24576 = initial
// buffer) instead of the one on stage. Scoping to `.slot.visible audio` picks the audible master.
const masterProbe = `(() => {
	const visible = document.querySelector(${JSON.stringify(SEL.slotVisibleAudio)});
	const rows = [...document.querySelectorAll('audio')].map((el) => ({
		src: el.currentSrc || el.src || '',
		readyState: el.readyState, paused: el.paused, muted: el.muted, volume: el.volume,
		currentTime: el.currentTime, duration: el.duration,
		decoded: el.webkitAudioDecodedByteCount ?? null,
		error: el.error ? { code: el.error.code, message: el.error.message } : null,
		visible: el.closest(${JSON.stringify(SEL.slot)})?.classList.contains('visible') ?? false
	}));
	// Prefer the visible slot's master; fall back to any instrumental element (early boot before the
	// slot has been marked visible), then to any element with a src.
	let master = null;
	if (visible) {
		master = rows.find((r) => r.visible && r.src.includes('instrumental')) ?? rows.find((r) => r.visible);
	}
	if (!master) master = rows.find((r) => r.src.includes('instrumental')) ?? rows.find((r) => r.src);
	return { rows, master };
})()`;

/** @param {Page} tv @returns {Promise<Master | null>} */
async function readMaster(tv) {
	const r = await tv.evaluate(masterProbe);
	return r.master;
}
/** @param {Page} tv @param {number} [tries] @param {number} [everyMs] @returns {Promise<Master>} */
async function readMasterOrRetry(tv, tries = 6, everyMs = 200) {
	for (let i = 0; i < tries; i++) {
		const m = await readMaster(tv);
		if (m) return m;
		await sleep(everyMs);
	}
	// Return an empty-but-not-undefined shape so callers can report the state instead of crashing.
	const debug = await tv.evaluate(masterProbe);
	console.log(`  [debug readMaster returned nothing — rows=${JSON.stringify(debug.rows)}]`);
	return { src: '', paused: null, currentTime: NaN, decoded: null, duration: NaN };
}

// The phone renders the progress bar's elapsed side as `.seekrow .time` (m:ss). Fall back to the
// scaleX transform on the fill for a fractional check when a coarse m:ss is not enough. The
// scaleX is normalised 0..1 against durationSec.
/** @param {Page} phone @returns {Promise<{ elapsedText: string | null, scaleX: number | null }>} */
async function readPhoneProgress(phone) {
	return await phone.evaluate(`(() => {
		const timeEl = document.querySelector(${JSON.stringify(SEL.seekTime)});
		const fillEl = document.querySelector(${JSON.stringify(SEL.seekFill)});
		const elapsedText = timeEl?.textContent?.trim() ?? null;
		let scaleX = null;
		if (fillEl) {
			const m = fillEl.style.transform?.match(/scaleX\\(([-0-9.]+)\\)/);
			if (m) scaleX = Number(m[1]);
		}
		return { elapsedText, scaleX };
	})()`);
}

// Convert an m:ss (or h:mm:ss) rendered by formatClock() back to seconds. The phone's elapsed side
// rounds DOWN (see clock.ts), so a value of "0:04" means "at least 4s, less than 5s".
/** @param {string | null} text @returns {number | null} */
function parseClock(text) {
	if (!text) return null;
	const parts = text.split(':').map(Number);
	if (parts.some((p) => !Number.isFinite(p))) return null;
	if (parts.length === 2) return parts[0] * 60 + parts[1];
	if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
	return null;
}

/** @type {Browser | undefined} */
let browser;
try {
	const b = await connect();
	browser = b;

	// ── two phones, each its own singer ───────────────────────────────────────────
	/** @param {string} name @returns {Promise<Page>} */
	async function newPhone(name) {
		const page = await b.newPage();
		await page.viewport(390, 844);
		await page.goto(`${base}/`);
		await page.fill(SEL.nameInput, name);
		await page.clickByRole('button', 'Start singing');
		// Wait for the remote. The search field USED to be the signal the room UI mounted; now it
		// lives on the browse screen, so the docked band is the joined-home signal and this helper also
		// leaves the page on the browse screen, where the rest of this probe expects to be.
		await page.waitFor(`location.pathname === '/'`);
		await openBrowseFromHome(page);
		return page;
	}
	const phone1 = await newPhone(`P4A${Date.now() % 100000}`);
	const phone2 = await newPhone(`P4B${Date.now() % 100000}`);

	// Open each phone's queue sheet so the progress row is present in the DOM. The peek renders its
	// seekrow only when progress !== null, which needs `elapsedSec`/`durationSec` set — those flow
	// from `playback.positionSec` + the current media's `durationSec`. The peek stays visible whether
	// the sheet is expanded or not; expanding is not strictly required, but the aria-label reads
	// better and future controls will need it.
	/**
	 * Reach the transport. It used to live in the queue sheet's peek and needed the sheet opened; since
	 * it is on the now-playing HERO, on the joined home screen, so reaching it means BEING there —
	 * which is also where the rotation rows this probe counts are rendered.
	 * @param {Page} page
	 */
	async function openSheet(page) {
		await returnHomeFromBrowse(page);
	}

	// Queue a processed song from a phone. Uses the real UI: search, then click .add on a ready row.
	/** @param {Page} page @param {string} q */
	async function queueSong(page, q) {
		await openBrowseFromHome(page); // search lives behind the browse push
		await page.fill(SEL.search, q);
		await page.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length > 0`);
		// Prefer .add (already processed) over .sing (queue+process) so we do not depend on the fake worker.
		const hasAdd = await page.count(SEL.addTurn);
		await page.click(hasAdd > 0 ? SEL.addTurn : SEL.sing);
		// The rotation is on home. A PLAYING entry is not a `.qrow` — `queued` filters it out and
		// it renders on the hero — so accept either, or the first song of the night reads as unqueued.
		await returnHomeFromBrowse(page);
		await page
			.waitFor(
				`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length > 0 || [...document.querySelectorAll(${JSON.stringify(SEL.bandTitle)})].some(el => (el.textContent || '').trim() && (el.textContent || '').trim() !== 'Nothing playing')`
			)
			.catch(() => 0);
	}

	await queueSong(phone1, 'caroline');
	// Additional processed songs give us: Song 1 (caroline) — the primary transport target; Song 2
	// (bohemian) — the skip-to-next target; Song 3 (believin) — a headroom song so the OOB seek test
	// can consume ONE song without leaving the queue empty for the last-song skip test.
	/** @type {ReadyRow[]} */
	const extras = [];
	for (const q of ['bohemian', 'believin', 'happy', 'imagine', 'don', 'stand']) {
		try {
			const r = await fetch(`${base}/api/search?q=${encodeURIComponent(q)}`).then((x) => x.json());
			const alt = (r.ready ?? []).find(
				(/** @type {ReadyRow} */ row) => row.id !== firstReady.id && !extras.some((e) => e.id === row.id)
			);
			if (alt) extras.push(alt);
		} catch { /* best-effort cleanup */ }
		if (extras.length >= 2) break;
	}
	// The FIRST extra is bohemian (or the first available) — queued from phone2 so the "credit the
	// authenticated singer" invariant is exercised too. The SECOND extra is queued from phone1 (any
	// joined singer can queue any song, and this saves a second `newPhone` bounce).
	const secondReadyId = extras[0]?.id ?? null;
	const secondReadyTitle = extras[0]?.title ?? null;
	const thirdReadyId = extras[1]?.id ?? null;
	const thirdReadyTitle = extras[1]?.title ?? null;
	if (secondReadyId) await queueSong(phone2, secondReadyTitle.split(' ')[0]);
	if (thirdReadyId) await queueSong(phone1, thirdReadyTitle.split(' ')[0]);

	// ── the TV ─────────────────────────────────────────────────────────────────
	const tv = await b.newPage();
	await tv.viewport(1920, 1080, 1);
	await tv.goto(`${base}/tv`);

	// Playback must begin without a gesture. Poll for a master element with a src.
	let m0;
	try {
		await tv.waitFor(
			`(() => { const e=[...document.querySelectorAll('audio')].filter(x=>(x.currentSrc||x.src).includes('instrumental')); return e.length ? true : null; })()`,
			{ timeout: 25000 }
		);
		m0 = await readMaster(tv);
	} catch {
		m0 = await readMaster(tv);
	}
	record(
		'CRITICAL',
		'TV mounts a master <audio> with the instrumental src, no gesture required',
		!!m0 && m0.src.includes('instrumental'),
		m0 ? `src=${m0.src}` : 'no master element found'
	);
	if (!m0) throw new Error('cannot proceed without a master element');

	// Wait long enough for audio to actually start decoding, then confirm.
	await sleep(2500);
	const m1 = /** @type {Master} */ (await readMaster(tv));
	const dDecoded = (m1.decoded ?? 0) - (m0.decoded ?? 0);
	record(
		'CRITICAL',
		'audio is decoding (byte count climbing) — the transport must act on a playing song',
		dDecoded > 0,
		`decoded ${m0.decoded} → ${m1.decoded} (+${dDecoded}) over 2.5s`
	);
	record(
		'CRITICAL',
		'the playhead advances against the wall clock',
		m1.currentTime > m0.currentTime + 1.0,
		`currentTime ${m0.currentTime.toFixed(2)} → ${m1.currentTime.toFixed(2)}`
	);

	// Open each phone's queue sheet so the progress row is in the DOM.
	await openSheet(phone1);
	await openSheet(phone2);

	// Give the phones one more tick to render the peek/seekrow.
	await sleep(300);

	// ── T1 · PAUSE ────────────────────────────────────────────────────────────
	// Establish the "before pause" TV state, then click phone1's play/pause button.
	const beforePause = /** @type {Master} */ (await readMaster(tv));
	await openNowPlaying(phone1);
	await phone1.clickByLabel('play/pause');
	await sleep(800);
	const afterPause = /** @type {Master} */ (await readMaster(tv));
	record(
		'CRITICAL',
		'T1a · phone play/pause pauses the master element',
		afterPause.paused === true,
		`paused=${afterPause.paused}, currentTime=${afterPause.currentTime.toFixed(2)}`
	);
	record(
		'HIGH',
		'T1b · pause holds the playhead (does not seek to 0)',
		afterPause.currentTime > 0.5 && Math.abs(afterPause.currentTime - beforePause.currentTime) < 2.5,
		`before=${beforePause.currentTime.toFixed(2)}, after=${afterPause.currentTime.toFixed(2)} — a jump to 0 is the reload class of bug`
	);

	// ── T3 · position telemetry lands (server tracks TV) ──────────────────────
	// The server's authoritative positionSec is the last-known value from setPosition() calls, PLUS
	// the current isPlaying/setPlayback state. handlePlayerCommand('pause') broadcasts playback:state
	// with the CURRENT positionSec. If telemetry frames dropped (the ws.send unguarded-throw class),
	// the server value would be pinned at 0 and this broadcast would carry 0. Read via a raw WS.
	const srvAtPause = await readServerPlayback();
	record(
		'CRITICAL',
		'T3a · server PlaybackState.positionSec tracks the TV (not pinned at 0)',
		srvAtPause.state.positionSec >= 1 && Math.abs(srvAtPause.state.positionSec - afterPause.currentTime) < 3,
		`server.positionSec=${srvAtPause.state.positionSec}, tv.currentTime=${afterPause.currentTime.toFixed(2)}`
	);
	record(
		'HIGH',
		'T3b · server PlaybackState.isPlaying === false after pause',
		srvAtPause.state.isPlaying === false,
		`server.isPlaying=${srvAtPause.state.isPlaying}`
	);

	// ── T4 · pause does not reset the phone progress bar to 0 ─────────────────
	// The phone re-anchors displayPos to playback.positionSec at every playback:state — so this is
	// the read that catches the reported symptom. Read both phones' bars; they must agree, since
	// both derive from the SAME playback:state broadcast (rev-scoped fanout).
	await sleep(400); // let the pause broadcast reach both phone WS clients
	const p1AtPause = await readPhoneProgress(phone1);
	const p2AtPause = await readPhoneProgress(phone2);
	const p1sec = parseClock(p1AtPause.elapsedText);
	const p2sec = parseClock(p2AtPause.elapsedText);
	record(
		'CRITICAL',
		'T4a · phone1 progress bar does NOT reset to 0 on pause',
		p1sec !== null && p1sec >= 1,
		`phone1.elapsed="${p1AtPause.elapsedText}" (${p1sec}s); server=${srvAtPause.state.positionSec}s`
	);
	record(
		'CRITICAL',
		'T4b · phone2 progress bar does NOT reset to 0 on pause',
		p2sec !== null && p2sec >= 1,
		`phone2.elapsed="${p2AtPause.elapsedText}" (${p2sec}s); server=${srvAtPause.state.positionSec}s`
	);
	record(
		'HIGH',
		'T4c · both phones show the same elapsed reading (same authoritative anchor)',
		p1sec !== null && p2sec !== null && Math.abs(p1sec - p2sec) <= 1,
		`phone1=${p1sec}s vs phone2=${p2sec}s`
	);

	// ── T1 · RESUME ───────────────────────────────────────────────────────────
	await openNowPlaying(phone1);
	await phone1.clickByLabel('play/pause');
	await sleep(1600);
	const afterResume = /** @type {Master} */ (await readMaster(tv));
	record(
		'CRITICAL',
		'T1c · phone play/pause resumes the master element',
		afterResume.paused === false && (afterResume.decoded ?? 0) > (afterPause.decoded ?? 0),
		`paused=${afterResume.paused}, decoded ${afterPause.decoded} → ${afterResume.decoded}`
	);
	record(
		'HIGH',
		'T1d · resume continues from where it paused (not from 0)',
		afterResume.currentTime >= afterPause.currentTime - 0.3,
		`paused at ${afterPause.currentTime.toFixed(2)}, resumed at ${afterResume.currentTime.toFixed(2)}`
	);

	// ── T2 · SEEK ────────────────────────────────────────────────────────────
	// No visible seek control on the phone; the command is only reachable via a raw player:command.
	// This exercises the same server code the UI would if a seek control were added, PLUS the TV's
	// `seekSec` handler that jumps master.currentTime when the delta is > 1.5s.
	//
	// Send it from phone1 (WHICH IS JOINED — the server rejects player:command from a non-joined
	// socket, so we cannot use the raw probe WS from earlier). `evaluate` reaches into the phone's
	// live WebSocket instance via the module-scoped `ws` variable exposed on window.
	//
	// The phone's <script module> uses a lexical `ws` that is not on window; we open a SECOND WS in
	// the phone context, riding the same session cookie, and send the seek from there. The cookie
	// resolves the singerId at upgrade, so the server accepts the command.
	//
	// FIXTURE CONSTRAINT: the fake stems worker writes 8-second WAVs (see e2e/wav.mjs `tone(seconds:
	// 8)`), so the seek target must stay < 8s or the browser hits EOF and fires `ended` — which the
	// server treats as advance-to-next. That is a legitimate FINDING (see T2-oob below), and it is
	// held out so the primary seek assertion doesn't collide with the fixture limit.
	const seekTarget = 4;
	// Snapshot server state BEFORE the seek so we can see whether it was already broken.
	const srvBeforeSeek = await readServerPlayback().catch((e) => ({ err: String(e) }));
	console.log(`  [debug PRE-seek server]   ${JSON.stringify(srvBeforeSeek)}`);
	const seekResult = await phone1.evaluate(`(() => new Promise((resolve, reject) => {
		try {
			const proto = location.protocol === 'https:' ? 'wss' : 'ws';
			const s = new WebSocket(proto + '://' + location.host + '/ws?role=phone');
			s.onopen = () => {
				s.send(JSON.stringify({ type: 'player:command', command: { cmd: 'seek', positionSec: ${seekTarget} } }));
				setTimeout(() => { try { s.close(); } catch {} resolve('sent'); }, 200);
			};
			s.onerror = (e) => reject(new Error('WS error'));
		} catch (e) { reject(e); }
	}))()`);
	record('INFO', 'T2 · seek command dispatched via phone WS', seekResult === 'sent');
	// DEBUG: capture TV DOM shape and authoritative server state right after the seek.
	const tvDebug = await tv.evaluate(`(() => ({
		audioCount: document.querySelectorAll('audio').length,
		slotsCount: document.querySelectorAll(${JSON.stringify(SEL.slot)}).length,
		slotVisibleCount: document.querySelectorAll(${JSON.stringify(SEL.slotVisible)}).length,
		attractPresent: !!document.querySelector(${JSON.stringify(SEL.attract)}),
		lobbyPresent: !!document.querySelector(${JSON.stringify(SEL.lobby)})
	}))()`);
	console.log(`  [debug post-seek TV DOM]  ${JSON.stringify(tvDebug)}`);
	const srvAfterSeekDbg = await readServerPlayback().catch((e) => ({ err: String(e) }));
	console.log(`  [debug post-seek server]  ${JSON.stringify(srvAfterSeekDbg)}`);
	// The TV effect requires > 1.5s delta and re-runs on the seekSec signal change; give the WS + rAF
	// a moment to land, then verify.
	await sleep(400);
	const afterSeek = await readMasterOrRetry(tv);
	record(
		'CRITICAL',
		`T2a · TV master.currentTime lands near the seek target (${seekTarget}s, ±3s)`,
		Math.abs(afterSeek.currentTime - seekTarget) < 3,
		`currentTime=${afterSeek.currentTime.toFixed(2)}, target=${seekTarget}`
	);
	// Prove decoding continues AFTER the jump — this needs a mid-file 206 to have been served.
	await sleep(2000);
	const afterSeekPlay = await readMasterOrRetry(tv);
	record(
		'CRITICAL',
		'T2b · decoding continues past the seek (bytes climb from post-seek baseline)',
		(afterSeekPlay.decoded ?? 0) > (afterSeek.decoded ?? 0) && afterSeekPlay.currentTime > afterSeek.currentTime + 1.0,
		`decoded ${afterSeek.decoded} → ${afterSeekPlay.decoded}, currentTime ${afterSeek.currentTime.toFixed(2)} → ${afterSeekPlay.currentTime.toFixed(2)}`
	);
	// The 206 assertion is served directly against the /media route so a fake-passing "the seek
	// worked, we hope" reading cannot hide a missing Range implementation. We ask for a MID-FILE
	// slice (not `bytes=0-1`, the WebKit probe) — the seek target is around 30s into a 705644-byte
	// file, so byte ~100000 is a real mid-file offset the seek would have to fetch.
	const rngRes = await fetch(`${base}/media/${firstReady.instrumentalRef}`, {
		headers: { Range: 'bytes=100000-199999' }
	});
	const contentRange = rngRes.headers.get('content-range') ?? '';
	const acceptRanges = rngRes.headers.get('accept-ranges') ?? '';
	record(
		'CRITICAL',
		'T2c · /media/… serves a mid-file 206 (this is what makes seeking work at all)',
		rngRes.status === 206 && /^bytes 100000-199999\//.test(contentRange),
		`status=${rngRes.status}, content-range=${contentRange}, accept-ranges=${acceptRanges}`
	);

	// ── T7 · RESTART ─────────────────────────────────────────────────────────
	// After seeking to ~4s we know currentTime is > ~2s, so a restart's snap to 0 will be visible.
	const beforeRestart = await readMasterOrRetry(tv);
	await openNowPlaying(phone1);
	await phone1.clickByLabel('restart');
	// The restart command sets positionSec=0 and isPlaying=true; the TV's seekSec effect jumps only
	// when |current - target| > 1.5. We were around 4-5s, restart target is 0 → delta ~4, so the jump
	// fires.
	await sleep(600);
	const afterRestart = await readMasterOrRetry(tv);
	record(
		'CRITICAL',
		'T7a · restart snaps the playhead back to 0',
		afterRestart.currentTime < 2.0 && beforeRestart.currentTime > 2.5,
		`before=${beforeRestart.currentTime?.toFixed(2)}, after=${afterRestart.currentTime?.toFixed(2)}`
	);
	await sleep(1200);
	const restartPlaying = await readMasterOrRetry(tv);
	record(
		'CRITICAL',
		'T7b · restart keeps decoding (bytes climb from post-restart baseline)',
		(restartPlaying.decoded ?? 0) > (afterRestart.decoded ?? 0) &&
			restartPlaying.currentTime > (afterRestart.currentTime ?? 0) + 0.4,
		`decoded ${afterRestart.decoded} → ${restartPlaying.decoded}, currentTime ${afterRestart.currentTime?.toFixed(2)} → ${restartPlaying.currentTime?.toFixed(2)}`
	);

	// ── T2-oob · out-of-bounds seek (advisory finding, not a pass/fail gate) ─
	// A seek beyond the file's duration makes the browser fire `ended` on the master, which the
	// server (in handleTelemetry) treats as advance-to-next. That means ANY singer with a joined
	// socket can force the room to skip a song by sending a seek far past the end. Whether that is a
	// defect depends on intent (there is no visible seek control today), but it is worth surfacing
	// because a reconnecting client resuming from a stale positionSec beyond EOF would trigger it
	// too. RECORDED AT THE END so it does not consume queued songs before the skip tests need them.

	// ── T1 · SKIP (→ next song) ──────────────────────────────────────────────
	// If we managed to process a second song, skip must advance to it. Otherwise this becomes the
	// last-song test (T6) directly.
	if (secondReadyId) {
		const preSkip = await readMasterOrRetry(tv);
		const preSkipSrc = preSkip?.src ?? '';
		await openNowPlaying(phone1);
		await phone1.clickByLabel('skip');
		await sleep(1500);
		// After a skip the visible slot changes; the master is whichever slot now carries an
		// instrumental src. Give the gapless swap a moment to complete.
		const afterSkip = await readMasterOrRetry(tv);
		record(
			'CRITICAL',
			'T1e · skip advances to the next song (src changes)',
			afterSkip && afterSkip.src.includes('instrumental') && afterSkip.src !== preSkipSrc,
			`before=${preSkipSrc}, after=${afterSkip?.src}`
		);
		// The next song should have currentTime near 0, be decoding (once the swap settles).
		await sleep(2000);
		const nextPlaying = await readMasterOrRetry(tv);
		// Dump every audio element the page holds so the failure mode is legible in the log.
		const skipDump = await tv.evaluate(masterProbe);
		console.log(`  [debug post-skip audio rows] ${JSON.stringify(skipDump.rows)}`);
		record(
			'HIGH',
			'T1f · next song after skip is DECODING (bytes climbing) and NOT paused',
			(nextPlaying?.decoded ?? 0) > 24576 && nextPlaying?.paused === false,
			`decoded=${nextPlaying?.decoded}, paused=${nextPlaying?.paused}, currentTime=${nextPlaying?.currentTime?.toFixed(2)} — a readyState-4 element sitting paused at currentTime 0 with only the initial preload burst (~24KB) decoded means the media loaded but was never played`
		);

		// ── T2-oob · out-of-bounds seek eats a song via the ended-advance path ─────
		// Now bohemian is playing and believin is queued. A seek to a positionSec past the file's
		// duration makes the media element fire `ended`; the server treats that as advance-to-next.
		// If a third song was queued (thirdReadyId), this advances to it — proving the effect. If
		// not, this advances to attract.
		const srvBeforeOob = await readServerPlayback();
		const curBeforeOob = srvBeforeOob.state.currentEntryId;
		if (curBeforeOob && srvBeforeOob.state.isPlaying) {
			await phone1.evaluate(`(() => new Promise((r) => {
				const proto = location.protocol === 'https:' ? 'wss' : 'ws';
				const s = new WebSocket(proto + '://' + location.host + '/ws?role=phone');
				s.onopen = () => { s.send(JSON.stringify({ type: 'player:command', command: { cmd: 'seek', positionSec: 9999 } })); setTimeout(() => { try { s.close(); } catch {} r('sent'); }, 200); };
			}))()`);
			await sleep(1800);
			const srvAfterOob = await readServerPlayback();
			const advanced = srvAfterOob.state.currentEntryId !== curBeforeOob;
			record(
				'MEDIUM',
				'T2-oob · seek beyond duration silently advances the rotation (any joined singer can force-skip a song by seeking past EOF; this may also chain through multiple queued songs before landing)',
				!advanced,
				`before.current=${curBeforeOob}, after.current=${srvAfterOob.state.currentEntryId}, isPlaying=${srvAfterOob.state.isPlaying} — expected: seek is clamped or ignored; observed: the queue advanced`
			);
		} else {
			record('INFO', 'T2-oob skipped: no current song to seek against', true);
		}

		// ── T6 · SKIP through the rest of the queue until empty ─────────────
		// The intent is "skip on the LAST song": if the queue still holds one song after the OOB
		// test, one skip drains it. If the OOB already consumed everything, we're already there.
		// If several songs remain, we drain the rest via skips so the invariant we check is genuinely
		// "no more songs".
		for (let i = 0; i < 5; i++) {
			const cur = (await readServerPlayback()).state.currentEntryId;
			if (!cur) break;
			await openNowPlaying(phone1);
			await phone1.clickByLabel('skip');
			await sleep(1200);
		}
		const srvAfterLastSkip = await readServerPlayback();
		record(
			'CRITICAL',
			'T6a · after skipping the LAST song, server has no current entry',
			srvAfterLastSkip.state.currentEntryId === null,
			`currentEntryId=${srvAfterLastSkip.state.currentEntryId}, isPlaying=${srvAfterLastSkip.state.isPlaying}`
		);
		record(
			'HIGH',
			'T6b · after skipping the LAST song, server isPlaying === false',
			srvAfterLastSkip.state.isPlaying === false,
			`isPlaying=${srvAfterLastSkip.state.isPlaying}`
		);
	} else {
		// Only ONE song was PROCESSED (secondReadyId is null), so there is no other processed song to skip
		// TO. There may still be more than one QUEUED turn on that one processed song, though — a second
		// singer taking a turn on it, or an entry left behind by an interrupted earlier run. A single
		// skip would then advance INTO the waiting turn (correct rotation, player.ts advance()), so
		// currentEntryId would stay set and the "skip on the sole last song → no-current" assertion
		// would fire a phantom CRITICAL. Drain EVERY remaining turn — same loop as the multi-processed
		// arm — so "the last song" is genuinely the last song regardless of how many turns are
		// queued, and the T5 precondition below (queue empty, nothing playing) is actually true.
		for (let i = 0; i < 8; i++) {
			const cur = (await readServerPlayback()).state.currentEntryId;
			if (!cur) break;
			await openNowPlaying(phone1);
			await phone1.clickByLabel('skip');
			await sleep(1200);
		}
		const srvAfterSkip = await readServerPlayback();
		record(
			'CRITICAL',
			'T6a · skip on the sole (last) song returns the server to no-current',
			srvAfterSkip.state.currentEntryId === null,
			`currentEntryId=${srvAfterSkip.state.currentEntryId}, isPlaying=${srvAfterSkip.state.isPlaying}`
		);
		record('INFO', 'T1e/T1f/T2-oob skipped: only ONE processed song in the fixture — no next song to skip TO', true);
	}

	// ── T5 · disabled controls on an empty room ──────────────────────────────
	// Now nothing is playing and the queue is empty (all skipped). The phone's transport must be
	// disabled rather than dispatching commands into the void.
	await sleep(300);
	// All three transport controls are in the drawer; a closed drawer reads as all three absent.
	await openNowPlaying(phone1);
	const disabledState = await phone1.evaluate(`(() => {
		const grab = (label) => {
			const el = document.querySelector('[aria-label=' + JSON.stringify(label) + ']');
			return el ? { present: true, disabled: !!el.disabled, ariaDisabled: el.getAttribute('aria-disabled') } : { present: false };
		};
		return { restart: grab('restart'), play: grab('play/pause'), skip: grab('skip') };
	})()`);
	record(
		'HIGH',
		'T5a · restart is disabled when there is no current song',
		disabledState.restart.present && disabledState.restart.disabled === true,
		JSON.stringify(disabledState.restart)
	);
	record(
		'HIGH',
		'T5b · skip is disabled when there is no current song',
		disabledState.skip.present && disabledState.skip.disabled === true,
		JSON.stringify(disabledState.skip)
	);
	record(
		'HIGH',
		'T5c · play is disabled when there is no current AND no queued song',
		disabledState.play.present && disabledState.play.disabled === true,
		JSON.stringify(disabledState.play)
	);

	// A final screenshot for the record — useful when reading a failure without re-running.
	const shot = join(process.env.KIROCREW_SCRATCH ?? '/tmp', `p4-final.png`);
	await tv.screenshot(shot);
	console.log(`\nTV final frame: ${shot}`);
} catch (err) {
	record('CRITICAL', 'the probe ran to completion', false, String(err instanceof Error ? err.stack : err));
} finally {
	try {
		browser?.close();
	} catch { /* already closed, or never opened */ }
}

// ── report ───────────────────────────────────────────────────────────────────
const failed = findings.filter((f) => !f.ok);
console.log(`\n${findings.length - failed.length}/${findings.length} passed`);
if (failed.length) {
	console.log('\nfailures:');
	for (const f of failed)
		console.log(`  ${f.severity.padEnd(8)}${f.name}${f.detail ? `\n           ${f.detail}` : ''}`);
}
process.exit(failed.length ? 1 : 0);
