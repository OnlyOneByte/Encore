/*
 * P4 — TRANSPORT, SEEK AND POSITION TELEMETRY.
 *
 * Every failure mode here is one the DOM hides: the tap landed and the media element did nothing, or
 * the server's authoritative state fell out of step with what a phone renders.
 *
 *   T1 play/pause/skip/restart move the master <audio> · T2 a `seek` lands within tolerance and keeps
 *   decoding, which needs a mid-file 206 (asserted against /media directly) · T3 server
 *   PlaybackState.positionSec tracks the TV rather than staying pinned at 0 · T4 pausing does not
 *   reset the phone bar to 0 · T5 the transport is DISABLED with nothing playable · T6 skip on the
 *   LAST song reaches attract cleanly · T7 restart returns to 0 and keeps decoding.
 *
 * THE PHONE BAR IS ONLY AUTHORITATIVE AT PAUSE. `displayPos` interpolates from the last
 * playback:state anchor plus a wall clock, so during PLAY it climbs perfectly even while telemetry is
 * dropping. Every phone-bar read below therefore waits for an `isPlaying:false` broadcast first.
 *
 * See docs/E2E.md#proving-audio and #exit-codes-and-what-ran-means.
 */
import { join } from 'node:path';
import { connect, sleep } from '../driver.mjs';
import { SEL } from '../contract.ts';
import { findChromium } from '../lib/chromium.mjs';
import { openBrowseFromHome, returnHomeFromBrowse, openNowPlaying } from '../lib/phone.mjs';
import { openJoin } from '../lib/join.mjs';

/**
 * `page.evaluate()` and `fetch().json()` come back Promise<any>, so results are cast at the call site.
 *
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO'} Severity
 * @typedef {{ severity: Severity, name: string, ok: boolean, detail: string }} Finding
 * @typedef {{ id: string, title: string, instrumentalRef: string }} ReadyRow
 * @typedef {{
 *   src: string, readyState?: number, paused: boolean | null, muted?: boolean, volume?: number,
 *   currentTime: number, duration: number, decoded: number | null,
 *   error?: { code: number, message: string } | null, visible?: boolean
 * }} Master
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

const chromium = findChromium();
if (!chromium) bail('no Chromium found. Set PW_CHROMIUM.');
if (!(await fetch(`${base}/health`).catch(() => null))?.ok) {
	bail(`no Encore server on ${base}. See tests/e2e/HARNESS.md for boot instructions.`);
}
const searchInit = await fetch(`${base}/api/search?q=caroline`).then((r) => r.json());
const processedIds = new Set((searchInit.ready ?? []).map((/** @type {ReadyRow} */ r) => r.id));
if (processedIds.size === 0) {
	bail(
		'no READY song in the library — nothing to play.\n' + '  Seed + process one first (HARNESS.md §Process a song).'
	);
}
const firstReady = (searchInit.ready ?? [])[0];
console.log(`fixture: "${firstReady.title}" → ${firstReady.instrumentalRef}\n`);

// A `hello` frame returns the authoritative playback:state, with no joined singer needed.
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
				} catch {
					/* already closed, or never opened */
				}
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
				} catch {
					/* already closed, or never opened */
				}
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


// SCOPE TO `.slot.visible audio`: the hidden pre-warm slot carries its own PAUSED <audio> at
// currentTime 0, so a looser selector can pick that one and read the stage as silent.
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
	// An empty-but-defined shape, so a caller reports the state instead of crashing.
	const debug = await tv.evaluate(masterProbe);
	console.log(`  [debug readMaster returned nothing — rows=${JSON.stringify(debug.rows)}]`);
	return { src: '', paused: null, currentTime: NaN, decoded: null, duration: NaN };
}

// The elapsed side is m:ss; the fill's scaleX (normalised 0..1 against durationSec) is the finer read.
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

// The rendered elapsed side rounds DOWN, so "0:04" means at least 4s and less than 5s.
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

	/** @param {string} name @returns {Promise<Page>} */
	async function newPhone(name) {
		const page = await b.newPage();
		await page.viewport(390, 844);
		await openJoin(page, base);
		await page.fill(SEL.nameInput, name);
		await page.clickByRole('button', 'Start singing');
		// The docked band is the joined-home signal, and this leaves the page on the browse screen.
		await page.waitFor(`location.pathname === '/'`);
		await openBrowseFromHome(page);
		return page;
	}
	const phone1 = await newPhone(`P4A${Date.now() % 100000}`);
	const phone2 = await newPhone(`P4B${Date.now() % 100000}`);

	// The seekrow only renders when progress !== null, which needs elapsedSec/durationSec from
	// playback.positionSec plus the current media's durationSec.
	/**
	 * Reach the transport, on the joined home screen — also where the rotation rows render.
	 * @param {Page} page
	 */
	async function openSheet(page) {
		await returnHomeFromBrowse(page);
	}

	/** @param {Page} page @param {string} q */
	async function queueSong(page, q) {
		await openBrowseFromHome(page); // search lives behind the browse push
		await page.fill(SEL.search, q);
		await page.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length > 0`);
		// .add over .sing, so this does not depend on the fake worker.
		const hasAdd = await page.count(SEL.addTurn);
		await page.click(hasAdd > 0 ? SEL.addTurn : SEL.sing);
		// A PLAYING entry renders no .qrow, so accept either — otherwise the first song reads as unqueued.
		await returnHomeFromBrowse(page);
		await page
			.waitFor(
				`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length > 0 || [...document.querySelectorAll(${JSON.stringify(SEL.bandTitle)})].some(el => (el.textContent || '').trim() && (el.textContent || '').trim() !== 'Nothing playing')`
			)
			.catch(() => 0);
	}

	await queueSong(phone1, 'caroline');
	// Three songs: the transport target, the skip-to-next target, and headroom so the out-of-bounds seek
	// can consume one without emptying the queue before the last-song skip.
	/** @type {ReadyRow[]} */
	const extras = [];
	for (const q of ['bohemian', 'believin', 'happy', 'imagine', 'don', 'stand']) {
		try {
			const r = await fetch(`${base}/api/search?q=${encodeURIComponent(q)}`).then((x) => x.json());
			const alt = (r.ready ?? []).find(
				(/** @type {ReadyRow} */ row) => row.id !== firstReady.id && !extras.some((e) => e.id === row.id)
			);
			if (alt) extras.push(alt);
		} catch {
			/* best-effort cleanup */
		}
		if (extras.length >= 2) break;
	}
	// From phone2, so the credit-the-authenticated-singer path is exercised too.
	const secondReadyId = extras[0]?.id ?? null;
	const secondReadyTitle = extras[0]?.title ?? null;
	const thirdReadyId = extras[1]?.id ?? null;
	const thirdReadyTitle = extras[1]?.title ?? null;
	if (secondReadyId) await queueSong(phone2, secondReadyTitle.split(' ')[0]);
	if (thirdReadyId) await queueSong(phone1, thirdReadyTitle.split(' ')[0]);

	const tv = await b.newPage();
	await tv.viewport(1920, 1080, 1);
	await tv.goto(`${base}/tv`);

	// Playback must begin with no gesture.
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

	await openSheet(phone1);
	await openSheet(phone2);

	await sleep(300);

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

	// T3 · `pause` broadcasts playback:state with the CURRENT positionSec, so a server whose telemetry
	// frames were dropped would broadcast 0. Read over a raw WS.
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

	// T4 · the phone re-anchors displayPos on every playback:state, and both phones must agree because
	// they derive from the SAME broadcast.
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

	// T2 · SEEK. No seek control exists on the phone, so the command goes over a raw player:command —
	// the same server path a control would use, plus the TV's jump-when-delta->1.5s handler. It is sent
	// from a SECOND socket opened inside phone1's page: the server rejects player:command from a
	// non-joined socket, the page's own `ws` is lexically scoped, and a socket opened there rides the
	// session cookie so the singerId resolves at upgrade.
	// UNDER THE FIXTURE'S 8s WAV (tests/e2e/wav.mjs): past EOF the browser fires `ended` and the server
	// advances to the next song, which T2-oob exercises deliberately.
	const seekTarget = 4;
	// Snapshot server state BEFORE the seek, to tell a new break from a pre-existing one.
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
	// The TV effect needs a > 1.5s delta and re-runs on the seekSec change; let the WS and rAF land.
	await sleep(400);
	const afterSeek = await readMasterOrRetry(tv);
	record(
		'CRITICAL',
		`T2a · TV master.currentTime lands near the seek target (${seekTarget}s, ±3s)`,
		Math.abs(afterSeek.currentTime - seekTarget) < 3,
		`currentTime=${afterSeek.currentTime.toFixed(2)}, target=${seekTarget}`
	);
	await sleep(2000);
	const afterSeekPlay = await readMasterOrRetry(tv);
	record(
		'CRITICAL',
		'T2b · decoding continues past the seek (bytes climb from post-seek baseline)',
		(afterSeekPlay.decoded ?? 0) > (afterSeek.decoded ?? 0) && afterSeekPlay.currentTime > afterSeek.currentTime + 1.0,
		`decoded ${afterSeek.decoded} → ${afterSeekPlay.decoded}, currentTime ${afterSeek.currentTime.toFixed(2)} → ${afterSeekPlay.currentTime.toFixed(2)}`
	);
	// A MID-FILE slice is what a seek must fetch; `bytes=0-1` is the WebKit probe and would pass against
	// a route with no Range implementation at all.
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

	// T7 · RESTART. From ~4s the snap to 0 is past the TV's 1.5s jump threshold, so the jump fires.
	const beforeRestart = await readMasterOrRetry(tv);
	await openNowPlaying(phone1);
	await phone1.clickByLabel('restart');
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

	// T2-oob · a seek past EOF makes the master fire `ended`, which the server treats as advance-to-next,
	// so any joined socket can force a skip. RECORDED LAST, so it does not eat the skip tests' songs.

	// T1 · SKIP. With a second processed song, skip must advance to it; otherwise this becomes T6.
	if (secondReadyId) {
		const preSkip = await readMasterOrRetry(tv);
		const preSkipSrc = preSkip?.src ?? '';
		await openNowPlaying(phone1);
		await phone1.clickByLabel('skip');
		await sleep(1500);
		// After a skip the master is whichever slot carries an instrumental src; let the swap finish.
		const afterSkip = await readMasterOrRetry(tv);
		record(
			'CRITICAL',
			'T1e · skip advances to the next song (src changes)',
			afterSkip && afterSkip.src.includes('instrumental') && afterSkip.src !== preSkipSrc,
			`before=${preSkipSrc}, after=${afterSkip?.src}`
		);
		await sleep(2000);
		const nextPlaying = await readMasterOrRetry(tv);
		const skipDump = await tv.evaluate(masterProbe);
		console.log(`  [debug post-skip audio rows] ${JSON.stringify(skipDump.rows)}`);
		record(
			'HIGH',
			'T1f · next song after skip is DECODING (bytes climbing) and NOT paused',
			(nextPlaying?.decoded ?? 0) > 24576 && nextPlaying?.paused === false,
			`decoded=${nextPlaying?.decoded}, paused=${nextPlaying?.paused}, currentTime=${nextPlaying?.currentTime?.toFixed(2)} — a readyState-4 element sitting paused at currentTime 0 with only the initial preload burst (~24KB) decoded means the media loaded but was never played`
		);

		// T2-oob · the seek eats a song: to the third if one is queued, which proves the effect.
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

		// T6 · drain every remaining turn by skipping, so "the last song" is genuinely the last one.
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
		// One processed song can still carry SEVERAL turns, and a single skip would advance INTO the waiting
		// one — correct rotation, but currentEntryId stays set and the no-current assertion fires a phantom
		// CRITICAL. Drain them all.
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

	// T5 · nothing playing and the queue empty: the transport must be disabled, not dispatch into the void.
	await sleep(300);
	// All three controls are in the drawer, so a closed drawer reads as all three absent.
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

	const shot = join(process.env.KIROCREW_SCRATCH ?? '/tmp', `p4-final.png`);
	await tv.screenshot(shot);
	console.log(`\nTV final frame: ${shot}`);
} catch (err) {
	record('CRITICAL', 'the probe ran to completion', false, String(err instanceof Error ? err.stack : err));
} finally {
	try {
		browser?.close();
	} catch {
		/* already closed, or never opened */
	}
}

const failed = findings.filter((f) => !f.ok);
console.log(`\n${findings.length - failed.length}/${findings.length} passed`);
if (failed.length) {
	console.log('\nfailures:');
	for (const f of failed)
		console.log(`  ${f.severity.padEnd(8)}${f.name}${f.detail ? `\n           ${f.detail}` : ''}`);
}
process.exit(failed.length ? 1 : 0);
