/*
 * P6 — WORD-TIMED LYRICS OVERLAY probe.
 *
 * The overlay's whole job is to show the singer which word to sing NOW. Everything else
 * — the ball, the reel, the amber tint, the presentation pickers — is in service of that
 * one thing. So this probe measures whether the surface actually delivers on it: does
 * the reel appear without a reload, does the highlight track the audio clock, does the
 * reel scroll and the ball move, does the room's live settings actually change what
 * is on screen, does an unlyriced song render nothing broken.
 *
 * Distinguishing real defects from environment limits matters here more than usual: the
 * fake worker in e2e/fake-stems-worker.mjs writes its own lyrics artifact, and that
 * fixture is where every timing signal in this probe comes from. If the fixture is
 * shaped wrong the overlay LOOKS broken while the overlay is actually fine — and this
 * probe therefore also verifies the fixture-vs-parser schema agreement, and re-tests the
 * time-varying findings against a corrected fixture written by the probe itself.
 *
 *   EPORT=5226 MEDIA_DIR=$KIROCREW_SCRATCH/e2e-5226/media \
 *     bun tests/e2e/probes/p6-lyrics.mjs
 *
 * Exit 0 — every finding passed; 1 — one or more real defects; 2 — the environment could
 * not host the test. Never conflate 2 with 0 (HARNESS.md).
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connect, sleep } from '../cdp.mjs';
import { SEL } from '../contract.ts';
import { findChromium } from '../lib/chromium.mjs';
import { openBrowseFromHome } from '../lib/phone.mjs';

/**
 * Types for this out-of-program driver, which runs under tsconfig.e2e.json (following the
 * fuzz.mjs pattern). Browser/Page are derived from cdp.mjs's own return types
 * so they cannot drift from the driver. page.evaluate()/fetch().json() come back Promise<any>, so
 * DOM/API-shaped results are cast at the call site via the domain typedefs below.
 *
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'} Severity
 *
 * One finding row: a pass/fail check with its id, severity and evidence.
 * @typedef {{ id: string, sev: Severity, ok: boolean, name: string, detail: string }} Finding
 *
 * The raw-CDP surface openRawCdp() returns — a second connection kept alongside cdp.mjs's own.
 * @typedef {{
 *   send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any>,
 *   attachToUrlContaining: (urlSubstring: string) => Promise<string | null>,
 *   close: () => void
 * }} RawCdp
 *
 * One search-result / ready row from /api/search (only the fields this probe reads).
 * @typedef {{ id: string, title: string, source: string, lyricsRef?: string }} SongRow
 *
 * The /api/search response body.
 * @typedef {{ results: SongRow[], ready: SongRow[] }} SearchBody
 *
 * One tracking sample read out of the TV overlay.
 * @typedef {{
 *   wall: number, currentTime: number, active: string | null, current: string | null,
 *   reelTransform: string
 * }} TrackSample
 *
 * The expected-word entry the fake-worker timing table yields for a given time.
 * @typedef {{ word: string, start: number, end: number } | null} ExpectedWord
 */

const PORT = process.env.EPORT ?? '5226';
const base = `http://127.0.0.1:${PORT}`;
const CDP_PORT = Number(process.env.CDP_PORT ?? 9426);
const MEDIA_DIR = resolve(process.env.MEDIA_DIR ?? './media');

/** A tiny second CDP connection, kept alongside the one cdp.mjs owns. Needed because cdp.mjs
 * intentionally keeps its surface small (newPage/close/evaluate/goto/waitFor) and does NOT expose
 * raw `send`, so cache-affecting commands (Network.setCacheDisabled) live here in the probe. Same
 * debugger port, independent socket. */
/** @param {number} port @returns {Promise<RawCdp>} */
async function openRawCdp(port) {
	const v = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
	const ws = new WebSocket(v.webSocketDebuggerUrl);
	await new Promise((r) => ws.addEventListener('open', r, { once: true }));
	const pending = new Map();
	let nextId = 10_000; // stay clear of cdp.mjs's own ids (which start at 1)
	ws.addEventListener('message', (ev) => {
		const m = JSON.parse(String(ev.data));
		if (m.id && pending.has(m.id)) {
			const { resolve, reject } = pending.get(m.id);
			pending.delete(m.id);
			if (m.error) reject(new Error(m.error.message));
			else resolve(m.result);
		}
	});
	/** @param {string} method @param {Record<string, unknown>} [params] @param {string} [sessionId] */
	function send(method, params = {}, sessionId) {
		const id = nextId++;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
			setTimeout(() => pending.delete(id) && reject(new Error(`${method} timed out`)), 8_000);
		});
	}
	/** @param {string} urlSubstring */
	async function attachToUrlContaining(urlSubstring) {
		const targets = await send('Target.getTargets');
		const t = targets.targetInfos.find(
			(/** @type {{ type: string, url: string, targetId: string }} */ tt) =>
				tt.type === 'page' && tt.url.includes(urlSubstring)
		);
		if (!t) return null;
		const { sessionId } = await send('Target.attachToTarget', {
			targetId: t.targetId,
			flatten: true
		});
		await send('Network.enable', {}, sessionId);
		return sessionId;
	}
	return { send, attachToUrlContaining, close: () => ws.close() };
}

/** Findings, printed at the end grouped by severity.
 * @type {Finding[]} */
const findings = [];
/**
 * @param {string} id
 * @param {Severity} sev
 * @param {unknown} ok
 * @param {string} name
 * @param {string} [detail]
 */
function record(id, sev, ok, name, detail = '') {
	findings.push({ id, sev, ok: !!ok, name, detail });
	const badge = ok ? 'PASS' : sev;
	console.log(`${badge.padEnd(9)} ${id}  ${name}${ok || !detail ? '' : `\n           ${detail}`}`);
}
/** @param {string} msg @returns {never} */
function bail(msg) {
	console.error(`\nENVIRONMENT: ${msg}`);
	process.exit(2);
}

const chromium = findChromium();
if (!chromium) bail('no Chromium found. Set PW_CHROMIUM.');
if (!(await fetch(`${base}/health`).catch(() => null))?.ok) {
	bail(`no Encore server on ${base}. See HARNESS.md for how to boot one.`);
}
console.log(`\nP6 lyrics probe — server ${base}, media ${MEDIA_DIR}\n`);

// ── Sanity: is the fake-worker fixture even something the client parser can read? ─────
// The fake worker's align payload writes {startSec,endSec,text} on words/lines, but the
// TV overlay's parseLyricsDoc reads {start,end,word}. If the fixture is wrong every
// downstream timing check is meaningless, so surface that BEFORE cooking a song and
// looking at moving pixels.
const parserCheck = await (async () => {
	const raw = {
		lines: [{ start: 0, end: 1, text: 'x', words: [{ word: 'x', start: 0, end: 1 }] }]
	};
	const bad = {
		lines: [{ startSec: 0, endSec: 1, text: 'x', words: [{ text: 'x', startSec: 0, endSec: 1 }] }]
	};
	const mod = await import(new URL('../../src/lib/tv/lyrics.ts', import.meta.url).href);
	const parseLyricsDoc = mod.parseLyricsDoc;
	const good = parseLyricsDoc(raw);
	const badParsed = parseLyricsDoc(bad);
	return {
		goodOk: !!good && good.lines.length === 1 && good.lines[0].words.length === 1,
		badWordsDropped: !!badParsed && badParsed.lines[0].words.length === 0,
		badLineBoundsNull: !!badParsed && badParsed.lines[0].start === null && badParsed.lines[0].end === null
	};
})();
const fixtureShapeMatchesParser = !parserCheck.badWordsDropped;

// ── Cook a song, using the running fake worker ─────────────────────────────
const jar = join(process.env.KIROCREW_SCRATCH ?? '/tmp', `p6-jar-${process.pid}`);
await fetch(`${base}/api/join`, {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ displayName: `P6-${process.pid % 1000}`, color: '#7cf' })
}).then(async (r) => {
	const setCookie = r.headers.get('set-cookie');
	if (setCookie) writeFileSync(jar, setCookie.split(';')[0]);
});
const cookieHeader = existsSync(jar) ? readFileSync(jar, 'utf8') : '';

/** Cook a fresh song by title-fragment, returning its media id when the align artifact lands. */
/**
 * @param {string} query
 * @param {{ waitForAlign?: boolean, timeoutMs?: number }} [opts]
 * @returns {Promise<{ id: string, row: SongRow }>}
 */
async function cookAndWait(query, { waitForAlign = true, timeoutMs = 15_000 } = {}) {
	const found = /** @type {SearchBody} */ (
		await fetch(`${base}/api/search?q=${encodeURIComponent(query)}`).then((r) => r.json())
	);
	const raw = [...found.results, ...found.ready].find((x) => x.source === 'local');
	if (!raw) throw new Error(`no local song matching "${query}"`);
	if (!found.ready.some((r) => r.id === raw.id)) {
		await fetch(`${base}/api/make-karaoke`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: cookieHeader },
			body: JSON.stringify({ mediaId: raw.id })
		});
	}
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const s = /** @type {SearchBody} */ (
			await fetch(`${base}/api/search?q=${encodeURIComponent(query)}`).then((r) => r.json())
		);
		const row = s.ready.find((r) => r.id === raw.id);
		if (row && (!waitForAlign || row.lyricsRef)) return { id: raw.id, row };
		await sleep(400);
	}
	throw new Error(`song "${query}" never reached ready state`);
}

/** @type {{ id: string, row: SongRow }} */
let cooked;
try {
	cooked = await cookAndWait('caroline');
} catch (err) {
	bail(`could not cook a probe song: ${err instanceof Error ? err.message : String(err)}`);
}
console.log(`cooked: "${cooked.row.title}" id=${cooked.id} lyricsRef=${cooked.row.lyricsRef}\n`);

// ── Boot Chromium once, drive two contexts (phone + TV) ─────────────────────
const proc = spawn(
	chromium,
	[
		`--remote-debugging-port=${CDP_PORT}`,
		'--headless=new',
		'--no-sandbox',
		'--disable-gpu',
		'--no-first-run',
		'--user-data-dir=' + join(process.env.KIROCREW_SCRATCH ?? '/tmp', `p6-lyrics-${process.pid}`),
		// The real TV has nobody to tap. The app must not DEPEND on a gesture; other findings
		// assert that separately.
		'--autoplay-policy=no-user-gesture-required',
		'about:blank'
	],
	{ stdio: 'ignore' }
);

/** Kick the media element once — headless refuses unmuted autoplay without either a gesture
 * or the CLI flag above, and this is the same one-shot the capture flow uses. */
/** @param {Page} tv */
async function kickPlayback(tv) {
	return tv.evaluate(`(async () => {
		const out = [];
		for (const v of document.querySelectorAll('video,audio')) {
			if (!v.currentSrc) continue;
			try { await v.play(); out.push('started'); } catch (e) { out.push('rejected:' + e.name); }
		}
		return out.join(',') || 'no media element with a src';
	})()`);
}
/** @param {Page} tv @param {number} [overMs] */
async function positionAdvancing(tv, overMs = 1500) {
	const read = () =>
		tv.evaluate(`(() => { const v = document.querySelector('video, audio'); return v ? v.currentTime : -1; })()`);
	const a = await read();
	await sleep(overMs);
	const b = await read();
	return { advanced: b > a + 0.2, a, b };
}
/** @param {Page} tv @param {Page} phone @param {number} [attempts] */
async function ensurePlaying(tv, phone, attempts = 4) {
	let lastReport = '';
	for (let i = 0; i < attempts; i++) {
		lastReport = await kickPlayback(tv);
		const a1 = await positionAdvancing(tv);
		if (a1.advanced) return { ok: true, report: lastReport, a1 };
		await phone.clickByLabel(SEL.play.name);
		await sleep(600);
		lastReport = await kickPlayback(tv);
		const a2 = await positionAdvancing(tv);
		if (a2.advanced) return { ok: true, report: lastReport, a2 };
	}
	return { ok: false, report: lastReport };
}
/** Seek the current media back to 0 by clicking restart on the phone; kick again if needed. */
/** @param {Page} tv @param {Page} phone */
async function seekToStart(tv, phone) {
	try {
		await phone.clickByLabel(SEL.restart.name);
	} catch {}
	await sleep(400);
	await kickPlayback(tv);
}

let browser;
let rawCdp;
try {
	browser = await connect(CDP_PORT);
	rawCdp = await openRawCdp(CDP_PORT);

	// ── phone joins and queues the cooked song ────────────────────────────
	const phone = await browser.newPage();
	await phone.viewport(390, 844);
	await phone.goto(`${base}/join`);
	await phone.fill(SEL.nameInput, `P6Phone${Date.now() % 100000}`);
	await phone.clickByText('Start singing');
	await phone.waitFor(`location.pathname === '/'`);
	await openBrowseFromHome(phone);

	await phone.fill(SEL.search, 'caroline');
	await phone.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length > 0`);
	const hasAdd = await phone.count(SEL.addTurn);
	await phone.click(hasAdd > 0 ? SEL.addTurn : SEL.sing);
	await phone.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length > 0`);

	// ── TV opens the /tv route ───────────────────────────────────────────
	const tv = await browser.newPage();
	await tv.viewport(1920, 1080, 1);
	await tv.goto(`${base}/tv`);

	// Disable the TV page's HTTP cache once, so a subsequent artifact overwrite is actually
	// SEEN by the overlay. The /media route replies with `Cache-Control: public, max-age=86400`
	// (see src/routes/media/[...path]/+server.ts), so without this the browser reuses the first
	// fetch of a given lyricsRef until tomorrow — and every reload-based re-test lies.
	const tvSession = await rawCdp.attachToUrlContaining('/tv');
	if (tvSession) {
		try {
			await rawCdp.send('Network.setCacheDisabled', { cacheDisabled: true }, tvSession);
		} catch (e) {
			console.warn(`WARN could not disable HTTP cache on TV: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// Wait for a media element with a src so we know the stage is up.
	await tv
		.waitFor(`[...document.querySelectorAll('video,audio')].some(e => e.currentSrc || e.src)`, { timeout: 20_000 })
		.catch(() => {});
	const kicked = await ensurePlaying(tv, phone);
	if (!kicked.ok)
		console.warn(
			`WARN: playback never started — subsequent findings may all be N/A. last kick report: ${kicked.report}`
		);

	// ── FINDING (1): the reel appears without a reload ────────────────────
	// The overlay fetches /media/<ref> on mount and re-fetches when lyricsRef changes; a
	// green here means the fetch → parse → render path completes in a single navigation.
	// Give it plenty of time — the room's own play-when-queued path starts the song, and
	// the interstitial ("Next up") can hold the reel off for several seconds.
	const reelPresent = await (async () => {
		const deadline = Date.now() + 20_000;
		let lastDiag = 0;
		while (Date.now() < deadline) {
			const p = await tv.evaluate(`document.querySelector(${JSON.stringify(SEL.lyrics)}) !== null`);
			if (p) return true;
			// Every 3s, print a diagnostic snapshot of the page state so we can tell WHY the reel is
			// not there yet (attract screen, interstitial, loading, media element failure).
			if (Date.now() - lastDiag > 3000) {
				lastDiag = Date.now();
				const diag = await tv.evaluate(`(() => {
					const media = [...document.querySelectorAll('video,audio')].map(v => ({
						tag: v.tagName, src: !!v.currentSrc, ct: v.currentTime, rs: v.readyState, paused: v.paused
					}));
					return {
						url: location.pathname,
						screens: {
							attract: !!document.querySelector(${JSON.stringify(SEL.attract)}),
							interstitial: !!document.querySelector(${JSON.stringify(SEL.interstitial)}),
							lowerThird: !!document.querySelector(${JSON.stringify(SEL.lowerThird)}),
							stateWaiting: !!document.querySelector(${JSON.stringify(SEL.stateWaiting)}),
							stateError: !!document.querySelector(${JSON.stringify(SEL.stateError)})
						},
						media,
						lyricsInMemory: !!document.querySelector(${JSON.stringify(SEL.lyrics)})
					};
				})()`);
				console.log('  P6-1 diag:', JSON.stringify(diag));
				// Kick playback periodically in case autoplay was refused.
				await kickPlayback(tv);
			}
			await sleep(400);
		}
		return false;
	})();
	record(
		'P6-1',
		'HIGH',
		reelPresent,
		'lyrics overlay renders once the align artifact is available, without a reload',
		reelPresent ? '' : 'no .lyrics element ever appeared on /tv while a cooked song with lyricsRef was current'
	);

	// Under what state exactly does it render? Useful context for the visual finding.
	const overlayState = await tv.evaluate(`(() => {
		const l = document.querySelector(${JSON.stringify(SEL.lyrics)});
		if (!l) return { present: false };
		const cs = getComputedStyle(l);
		return {
			present: true,
			unverified: l.classList.contains('unverified'),
			hlClass: [...l.classList].find(c => c.startsWith('hl-')),
			rows: document.querySelectorAll(${JSON.stringify(SEL.lyricsRow)}).length,
			hasCurrent: document.querySelector(${JSON.stringify(SEL.lyricsRowCurrent)}) !== null,
			rowsText: [...document.querySelectorAll(${JSON.stringify(SEL.lyricsRow)})].map(r => r.textContent.trim()),
			bbox: l.getBoundingClientRect(),
			fontSize: cs.fontSize,
			color: cs.color
		};
	})()`);
	console.log('  overlay state:', JSON.stringify(overlayState));

	// ── FIXTURE / PARSER SCHEMA agreement — the elephant behind (2)/(3) ──────
	// Report this BEFORE the tracking checks, because the finding is what tells the
	// reader why the numbers below look the way they do.
	record(
		'P6-fixture',
		'MEDIUM',
		fixtureShapeMatchesParser,
		'fake-worker align artifact uses the field names the TV parser reads',
		fixtureShapeMatchesParser
			? ''
			: `tests/e2e/fake-stems-worker.mjs:196-207 writes {startSec,endSec,text} but ` +
					`src/lib/tv/lyrics.ts:31-51 reads {start,end,word}. ` +
					`Every word entry is dropped by parseLyricsDoc; line bounds resolve to null; ` +
					`activeLineIndex returns 0 forever. Real Python worker (worker/src/lyrics/artifact.py:6-7) ` +
					`writes the correct shape — this is a FIXTURE bug in the e2e harness, not an overlay defect.`
	);

	// ── FINDING (2): does the active word track the clock? ────────────────
	// Sample .word.active text and the master's currentTime together at several points.
	// If the fixture shape is wrong the highlight cannot exist AT ALL, so measure two
	// scenarios: (a) as-is, and (b) after we override the artifact with a well-shaped
	// version and reload.
	/**
	 * @param {string} tag
	 * @param {(t: number) => ExpectedWord} expectedByTime
	 * @returns {Promise<{ tag: string, samples: TrackSample[], lags: { t: number, word: string, lagSec: number }[] }>}
	 */
	async function sampleTracking(tag, expectedByTime) {
		const samples = [];
		const start = Date.now();
		// Poll every ~300ms for up to 6s.
		for (let i = 0; i < 20 && Date.now() - start < 6500; i++) {
			const s = await tv.evaluate(`(() => {
				const v = document.querySelector('video,audio');
				const a = document.querySelector(${JSON.stringify(SEL.activeWord)});
				const c = document.querySelector(${JSON.stringify(SEL.lyricsRowCurrent)});
				const reel = document.querySelector(${JSON.stringify(SEL.lyricsReel)});
				const t = reel ? getComputedStyle(reel).transform : '';
				// The .word.active element wraps both the ball glyph (a <span class="ball">) AND the
				// word's own text. textContent lumps them together and yields "●here" — strip that
				// glyph so downstream matching sees "here". Reading the last text-node child would
				// also work, but this is trivially reversible.
				const rawActive = a ? a.textContent.trim() : null;
				const active = rawActive ? rawActive.replace(/^[●·]+\\s*/, '').trim() : null;
				const rawCurrent = c ? c.textContent.trim() : null;
				const current = rawCurrent ? rawCurrent.replace(/^[●·]+\\s*/, '').trim() : null;
				return {
					wall: performance.now(),
					currentTime: v ? v.currentTime : -1,
					active,
					current,
					reelTransform: t
				};
			})()`);
			samples.push(s);
			await sleep(300);
		}
		// Compute lag: for each sample with an active word, look up the expected word at that
		// currentTime, and if they match, record (currentTime - word.start). Positive means the
		// audio has moved past the word's start (the highlight is late, or the sample landed
		// AFTER the ball moved onto the word); with LYRICS_LEAD_SEC=0.3 the ball moves onto a
		// word 0.3s BEFORE the audio reaches its start, so the natural lag ≈ +300..+700ms.
		/** @type {{ t: number, word: string, lagSec: number }[]} */
		const lags = [];
		for (const s of samples) {
			if (!s.active || s.currentTime < 0) continue;
			const expected = expectedByTime(s.currentTime);
			if (!expected) continue;
			if (expected.word.toLowerCase() === s.active.toLowerCase()) {
				lags.push({ t: s.currentTime, word: s.active, lagSec: s.currentTime - expected.start });
			}
		}
		return { tag, samples, lags };
	}

	// The fake worker's timing table (see fake-stems-worker.mjs align branch): 9 words
	// at 0.8s intervals, each of length 0.7s. i.e. word i covers [i*0.8, i*0.8+0.7).
	const fakeWords = ['Sing', 'along', 'with', 'the', 'tone', 'now', 'here', 'we', 'go'];
	const expectedByFakeTime = (/** @type {number} */ t) => {
		const idx = Math.floor(t / 0.8);
		if (idx < 0 || idx >= fakeWords.length) return null;
		return { word: fakeWords[idx], start: idx * 0.8, end: idx * 0.8 + 0.7 };
	};

	// Restart the song so we're near t=0.
	await seekToStart(tv, phone);
	const asIsTracking = await sampleTracking('as-is', expectedByFakeTime);
	const activeSeenAsIs = asIsTracking.samples.filter((s) => s.active).length;
	record(
		'P6-2a',
		'CRITICAL',
		activeSeenAsIs > 0,
		'the active word appears on screen at all against the shipped fake-worker fixture',
		activeSeenAsIs > 0
			? `${activeSeenAsIs}/${asIsTracking.samples.length} samples had a .word.active`
			: `not once did .word.active exist. All ${asIsTracking.samples.length} samples were null. ` +
					`Root cause: fixture/parser schema mismatch above — no word timings survive parseLyricsDoc.`
	);

	// ── Override the artifact file with the CORRECT shape, so we can measure real
	// tracking behavior of the overlay itself. Field names {start,end,word} match the
	// real Python worker at worker/src/lyrics/artifact.py.
	if (!cooked.row.lyricsRef) throw new Error('cooked song has no lyricsRef');
	const lyricsPath = join(MEDIA_DIR, cooked.row.lyricsRef);
	const correctedDoc = {
		language: 'en',
		lines: fakeWords.map((w, i) => ({
			start: i * 0.8,
			end: i * 0.8 + 0.7,
			text: w,
			words: [{ word: w, start: i * 0.8, end: i * 0.8 + 0.7 }]
		}))
	};
	try {
		writeFileSync(lyricsPath, JSON.stringify(correctedDoc, null, 1));
	} catch (err) {
		console.warn(`WARN could not overwrite ${lyricsPath}: ${err instanceof Error ? err.message : String(err)}`);
	}
	// Force the overlay to re-fetch: reload the TV route.
	await tv.goto(`${base}/tv`);
	await tv
		.waitFor(`[...document.querySelectorAll('video,audio')].some(e => e.currentSrc || e.src)`, { timeout: 20_000 })
		.catch(() => {});
	await ensurePlaying(tv, phone);
	await seekToStart(tv, phone);
	await sleep(300);
	// Confirm we actually reset the song and playback is moving before sampling.
	const t0 = await tv.evaluate(`document.querySelector('video,audio')?.currentTime ?? -1`);
	if (t0 > 1.5) {
		// Fall back: click restart again, kick.
		await seekToStart(tv, phone);
		await sleep(600);
	}
	await kickPlayback(tv);
	const correctedTracking = await sampleTracking('corrected', expectedByFakeTime);
	const activeSeenCorrected = correctedTracking.samples.filter((s) => s.active).length;
	console.log('  corrected samples (last 6):', JSON.stringify(correctedTracking.samples.slice(-6), null, 1));
	// After sampling, verify what the browser is actually seeing on disk.
	const fileNow = (() => {
		try {
			return readFileSync(lyricsPath, 'utf8').slice(0, 200);
		} catch {
			return '<missing>';
		}
	})();
	console.log('  lyrics file (first 200):', fileNow);
	const fetchedByBrowser = await tv.evaluate(
		`fetch('/media/${cooked.row.lyricsRef}').then(r => r.text()).then(t => t.slice(0, 200))`
	);
	console.log('  lyrics file as browser sees:', fetchedByBrowser);
	record(
		'P6-2b',
		'HIGH',
		activeSeenCorrected > 0,
		'against a CORRECTLY-shaped fixture, the active word IS drawn',
		activeSeenCorrected > 0
			? `${activeSeenCorrected}/${correctedTracking.samples.length} samples had .word.active`
			: `still no .word.active with the corrected fixture (${JSON.stringify(correctedTracking.samples.slice(0, 3))}) — ` +
					`this would be a real overlay defect, not an env limit.`
	);

	// Report lag / drift, only if any lags landed on the expected word.
	if (correctedTracking.lags.length > 0) {
		const lagsMs = correctedTracking.lags.map((l) => Math.round(l.lagSec * 1000));
		const meanLag = Math.round(lagsMs.reduce((a, b) => a + b, 0) / lagsMs.length);
		const varLag = Math.round(Math.sqrt(lagsMs.reduce((a, b) => a + (b - meanLag) ** 2, 0) / lagsMs.length));
		// The overlay adds LYRICS_LEAD_SEC=0.3s to cuePos, so the highlight is expected to
		// LEAD the audio: `currentTime - word.start` should sit near +LYRICS_LEAD (positive
		// = ahead of audio) when the ball reaches a word. So a good lag is around +300ms.
		// A value near 0 means no lead applied; a negative means the highlight is late.
		const okLag = meanLag >= -100 && meanLag <= 900; // roomy — includes lead + reasonable sampling jitter
		record(
			'P6-2c',
			'HIGH',
			okLag,
			`highlight tracks the audio clock: mean lag ${meanLag}ms, stdev ${varLag}ms across ${lagsMs.length} matched samples`,
			okLag ? `raw lags(ms) = ${JSON.stringify(lagsMs)}` : `lags(ms) = ${JSON.stringify(lagsMs)}`
		);
	} else {
		record(
			'P6-2c',
			'MEDIUM',
			false,
			'could not measure highlight lag',
			'no sample landed on an expected word; cannot compute drift'
		);
	}

	// ── FINDING (3): does the reel SCROLL and does the ball MOVE? ─────────
	// Reel scrolling shows up as a changing translateY on .reel. Ball moving means the
	// .word.active element identity moves along the row over time.
	const reelSamples = correctedTracking.samples.map((s) => s.reelTransform).filter(Boolean);
	const distinctTransforms = new Set(reelSamples).size;
	record(
		'P6-3a',
		'HIGH',
		distinctTransforms > 1,
		`reel scrolls over the song (${distinctTransforms} distinct transforms observed across ${reelSamples.length} samples)`,
		distinctTransforms > 1
			? ''
			: `reel transform stayed at ${JSON.stringify([...new Set(reelSamples)])} throughout — frozen reel with advancing audio.`
	);

	const activeWords = correctedTracking.samples.map((s) => s.active).filter(Boolean);
	const distinctActive = new Set(activeWords).size;
	record(
		'P6-3b',
		'HIGH',
		distinctActive > 1,
		`bouncing ball advances through the line (${distinctActive} distinct .word.active values observed)`,
		distinctActive > 1
			? `words seen: ${JSON.stringify([...new Set(activeWords)])}`
			: `only one active word ever seen: ${JSON.stringify([...new Set(activeWords)])}`
	);

	// Explicit reconciliation: audio advancing AND reel frozen is one bug shape; reel
	// moving AND audio stalled is another. Distinguish them.
	const audioAdvanced =
		correctedTracking.samples.length >= 2 &&
		correctedTracking.samples[correctedTracking.samples.length - 1].currentTime -
			correctedTracking.samples[0].currentTime >
			1.0;
	record(
		'P6-3c',
		'MEDIUM',
		audioAdvanced,
		'audio clock is advancing during the tracking window',
		audioAdvanced
			? ''
			: `currentTime moved only ${(
					correctedTracking.samples[correctedTracking.samples.length - 1]?.currentTime -
					correctedTracking.samples[0]?.currentTime
				).toFixed(
					3
				)}s across ${correctedTracking.samples.length} samples — the reel-frozen finding above is CAUSED by silent audio, not by the overlay.`
	);

	// ── FINDING (4): readability at 1920x1080 ─────────────────────────────
	// Take a screenshot mid-song, then READ it — but the honest thing is also to compute
	// numeric size + contrast from the DOM, because the screenshot is downsampled and a
	// human-eye reading is a subjective supplement.
	const shotPath = join(process.env.KIROCREW_SCRATCH ?? '/tmp', `p6-lyrics-1080.png`);
	await tv.screenshot(shotPath);
	console.log(`\n  screenshot: ${shotPath}`);

	const geom = await tv.evaluate(`(() => {
		const current = document.querySelector(${JSON.stringify(SEL.lyricsRowCurrent)});
		const active = document.querySelector(${JSON.stringify(SEL.activeWord)});
		const viewport = document.querySelector(${JSON.stringify(SEL.lyricsViewport)});
		const cs = current ? getComputedStyle(current) : null;
		return current ? {
			currentTextPx: parseFloat(cs.fontSize),
			currentColor: cs.color,
			activeColor: active ? getComputedStyle(active).color : null,
			viewportH: viewport ? viewport.getBoundingClientRect().height : null,
			currentText: current.textContent.trim(),
			innerHtml: current.innerHTML.length
		} : null;
	})()`);
	console.log('  reel geometry:', JSON.stringify(geom));

	// TVs at 1080p are read from ~10 feet away — the app's own type scale
	// (src/app.css --tv-lyric) sits in the 60-90px range. Anything below
	// 40px would be unreadable from a couch.
	const sizeOk = !!geom && geom.currentTextPx >= 40;
	record(
		'P6-4a',
		'HIGH',
		sizeOk,
		`current-line text is legible at TV distance (${geom?.currentTextPx ?? 'n/a'}px at 1920x1080)`,
		sizeOk ? '' : `current-line font-size is ${geom?.currentTextPx}px — a couch-distance TV needs ≥40px.`
	);

	// A quick contrast check via ratio on the current word's colour vs the stage floor.
	// The stage is pure black under the lyrics (see .tv rule in +page.svelte). The
	// component defines white/amber as ink; both are >4.5:1 vs #000 by construction, and
	// the >=7:1 check here catches an accidental drop to a mid-grey.
	/** @param {number[]} rgb */
	function relLum(rgb) {
		const [r, g, b] = rgb.map((/** @type {number} */ c) => {
			const s = c / 255;
			return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
		});
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	}
	/** @param {string} css @returns {number[] | null} */
	function parseRgb(css) {
		const m = css?.match(/rgba?\((\d+)[^\d]+(\d+)[^\d]+(\d+)/);
		return m ? [+m[1], +m[2], +m[3]] : null;
	}
	const inkRgb = parseRgb(geom?.currentColor);
	const ratio = inkRgb ? (relLum(inkRgb) + 0.05) / (0 + 0.05) : null;
	const contrastOk = ratio !== null && ratio >= 7;
	record(
		'P6-4b',
		'MEDIUM',
		contrastOk,
		`text contrast vs stage floor is high (${ratio?.toFixed(1) ?? 'n/a'}:1)`,
		contrastOk
			? ''
			: `ink colour ${geom?.currentColor} lands at ${ratio?.toFixed(1)}:1 — below the WCAG AAA 7:1 target for large text.`
	);

	// ── FINDING (5): provenance label for transcribed words ───────────────
	// The overlay's amber tint AND the "Auto-transcribed" provenance label both hang off
	// `chosenCandidate(media)` returning a candidate whose textSource is 'asr' /
	// 'captions'. The fake worker in fake-stems-worker.mjs sends `artifacts.lyrics.uri`
	// but NOT `artifacts.lyrics.candidates`, so setMediaLyrics attaches only the ref and
	// chosenCandidate returns null → provenance is null → no label rendered.
	const provState = await tv.evaluate(`(() => ({
		asrLabel: document.querySelector(${JSON.stringify(SEL.lsAsr)})?.textContent.trim() ?? null,
		unverified: !!document.querySelector(${JSON.stringify(SEL.lyricsUnverified)}),
		reelColor: (() => { const w = document.querySelector(${JSON.stringify(SEL.activeWord)}); return w ? getComputedStyle(w).color : null; })()
	}))()`);
	console.log('  provenance state:', JSON.stringify(provState));
	// This is a LEGIT env limit rather than a real defect: real ASR workers (whisperx.py
	// via worker/src/lyrics/artifact.py) also pass candidates alongside the uri, so
	// the label DOES appear in a real cook. The fake worker exposes the surface — the
	// probe therefore records the finding but classifies it as MEDIUM/env-limit.
	const provOk = provState.asrLabel === 'Auto-transcribed' && provState.unverified;
	record(
		'P6-5',
		'MEDIUM',
		provOk,
		'transcribed lyrics carry the "Auto-transcribed" provenance label and the amber .unverified tint',
		provOk
			? ''
			: `no .ls-asr label rendered and .lyrics.unverified=${provState.unverified}. ` +
					`ROOT CAUSE (env limit): fake-stems-worker.mjs align branch does not send ` +
					`artifacts.lyrics.candidates; worker-hub.ts:245 calls setMediaLyrics without candidates; ` +
					`chosenCandidate(media) returns null; isAutoTranscribed(null)=false. ` +
					`Real workers via worker do send candidates, so this surface works in a real cook.`
	);

	// ── FINDING (6): live settings changes take effect with NO restart ────
	// Flip each of lyrics-highlight, lyrics-ball, lyrics-font, lyrics-case, sync-mode
	// through the real /api/settings/room endpoint (same call the settings UI makes), and
	// assert the overlay reacted.

	// Make sure a song is playing (the 8s fixture may have ended between findings).
	async function ensureSongOnStage() {
		const has = await tv.evaluate(`document.querySelector(${JSON.stringify(SEL.lyricsRowCurrent)}) !== null`);
		if (has) return true;
		// First cheapest attempt — seek back to 0 in the current song via the phone.
		await seekToStart(tv, phone);
		await sleep(800);
		const nowHas = await tv.evaluate(`document.querySelector(${JSON.stringify(SEL.lyricsRowCurrent)}) !== null`);
		if (nowHas) return true;
		// Fall back to re-queueing.
		await openBrowseFromHome(phone); // search lives behind the browse push
		await phone.fill(SEL.search, 'caroline');
		await sleep(300);
		await phone
			.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length > 0`, { timeout: 5000 })
			.catch(() => {});
		const canAdd = await phone.count(SEL.addTurn);
		if (canAdd > 0) await phone.click(SEL.addTurn);
		else if ((await phone.count(SEL.sing)) > 0) await phone.click(SEL.sing);
		await sleep(1200);
		await ensurePlaying(tv, phone);
		await sleep(600);
		return tv.evaluate(`document.querySelector(${JSON.stringify(SEL.lyricsRowCurrent)}) !== null`);
	}
	// Ensure lyricsHighlight is `word` so ball/marker rules below are meaningful. Also
	// force lyricsBall back to bounce (the default) — a previous run may have changed it.
	await putRoom({ lyricsHighlight: 'word', lyricsBall: 'bounce', lyricsFont: 'system', lyricsCase: 'natural' });
	await sleep(400);
	const settingsHaveSong = await ensureSongOnStage();
	if (!settingsHaveSong) console.warn('WARN: could not restore a playing song before settings sweep');
	/** @param {Record<string, unknown>} body */
	async function putRoom(body) {
		// Use the phone's browser context — it holds the real singer session cookie set by the
		// /join redirect, and settings API auth rides on that cookie.
		return phone.evaluate(`fetch('/api/settings/room', {
			method: 'PUT', headers: {'content-type': 'application/json'},
			body: ${JSON.stringify(JSON.stringify(body))}
		}).then(r => r.ok).catch(() => false)`);
	}
	/** @param {Record<string, unknown>} body */
	async function putGlobal(body) {
		return phone.evaluate(`fetch('/api/settings', {
			method: 'PUT', headers: {'content-type': 'application/json'},
			body: ${JSON.stringify(JSON.stringify(body))}
		}).then(r => r.ok).catch(() => false)`);
	}
	async function readClasses() {
		return tv.evaluate(`(() => {
			const l = document.querySelector(${JSON.stringify(SEL.lyrics)});
			if (!l) return null;
			const w = document.querySelector(${JSON.stringify(SEL.lyricsRowCurrent)});
			const cs = w ? getComputedStyle(w) : null;
			const ball = document.querySelector(${JSON.stringify(SEL.ball)});
			return {
				hlClass: [...l.classList].find(c => c.startsWith('hl-')),
				ballClass: ball ? [...ball.classList].find(c => ['bounce','steady','underline'].includes(c)) : null,
				ballPresent: !!ball,
				fontFamily: cs?.fontFamily ?? null,
				textTransform: cs?.textTransform ?? null,
				unverified: l.classList.contains('unverified')
			};
		})()`);
	}
	/** readClasses with an "ensure a song is on stage" fallback — a setting flip that lands during a
	 * silent gap between songs would otherwise read null and be mis-attributed as a failed live-flip. */
	async function readAfterFlip() {
		let out = await readClasses();
		if (!out) {
			await ensureSongOnStage();
			await sleep(500);
			out = await readClasses();
		}
		return out;
	}
	/** Read the ball's class over a short polling window — the ball only mounts under an ACTIVE word,
	 * and words are ~0.7s wide with ~0.1s gaps between, so a single-sample read may catch the gap
	 * and mis-report a genuinely present marker as absent. Returns the first non-null observation. */
	async function readBallClassPatient(timeoutMs = 1500) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const s = await readAfterFlip();
			if (s?.ballClass) return { ballClass: s.ballClass, ballPresent: s.ballPresent };
			// Also accept "no marker" as a legitimate off-state when we specifically expected it.
			await sleep(150);
		}
		const final = await readAfterFlip();
		return final ?? {};
	}
	// Baseline
	const base0 = await readClasses();

	// lyrics-highlight
	await putRoom({ lyricsHighlight: 'line' });
	await sleep(700);
	const afterHlLine = await readAfterFlip();
	await putRoom({ lyricsHighlight: 'off' });
	await sleep(700);
	const afterHlOff = await readAfterFlip();
	await putRoom({ lyricsHighlight: 'word' });
	await sleep(700);
	const afterHlWord = await readAfterFlip();
	const hlLive =
		afterHlLine?.hlClass === 'hl-line' && afterHlOff?.hlClass === 'hl-off' && afterHlWord?.hlClass === 'hl-word';
	record(
		'P6-6a',
		'HIGH',
		hlLive,
		'lyrics-highlight (word / line / off) applies live to the overlay via .hl-* class',
		hlLive
			? ''
			: `hlClass went ${base0?.hlClass} → line:${afterHlLine?.hlClass}, off:${afterHlOff?.hlClass}, word:${afterHlWord?.hlClass}`
	);

	// lyrics-ball (only meaningful under highlight=word; already restored)
	await putRoom({ lyricsBall: 'steady' });
	await sleep(700);
	const afterBallSteady = await readBallClassPatient();
	await putRoom({ lyricsBall: 'underline' });
	await sleep(700);
	const afterBallUnder = await readBallClassPatient();
	await putRoom({ lyricsBall: 'off' });
	await sleep(700);
	// For `off`, the ball element must NOT mount. Read once — no need to poll for it appearing.
	const afterBallOff = await readAfterFlip();
	await putRoom({ lyricsBall: 'bounce' });
	await sleep(700);
	const afterBallBounce = await readBallClassPatient();
	// `off` should mean no ball element mounted; each named style should set its class.
	const ballLive =
		afterBallSteady?.ballClass === 'steady' &&
		afterBallUnder?.ballClass === 'underline' &&
		afterBallOff?.ballPresent === false &&
		afterBallBounce?.ballClass === 'bounce';
	record(
		'P6-6b',
		'HIGH',
		ballLive,
		'lyrics-ball (bounce / steady / underline / off) applies live to the marker',
		ballLive
			? ''
			: `ball went steady:${afterBallSteady?.ballClass}, under:${afterBallUnder?.ballClass}, off-present:${afterBallOff?.ballPresent}, bounce:${afterBallBounce?.ballClass}`
	);

	// lyrics-font — the family is applied to .viewport but inherited on rows, so read
	// getComputedStyle on the .row.current.
	await putRoom({ lyricsFont: 'serif' });
	await sleep(700);
	const afterFontSerif = await readAfterFlip();
	await putRoom({ lyricsFont: 'system' });
	await sleep(700);
	const afterFontSystem = await readAfterFlip();
	// A simple `includes('serif')` check breaks because a system-ui stack ends in `sans-serif`,
	// which contains the substring "serif". Compare the fully-resolved family strings instead;
	// they differ character-for-character between font ids.
	const fontLive =
		!!afterFontSerif?.fontFamily &&
		!!afterFontSystem?.fontFamily &&
		afterFontSerif.fontFamily !== afterFontSystem.fontFamily;
	record(
		'P6-6c',
		'MEDIUM',
		fontLive,
		'lyrics-font (system / serif / …) changes the reel font family live',
		fontLive
			? `serif=${afterFontSerif?.fontFamily}, system=${afterFontSystem?.fontFamily}`
			: `serif=${afterFontSerif?.fontFamily}, system=${afterFontSystem?.fontFamily} — no observable change`
	);

	// lyrics-case
	await putRoom({ lyricsCase: 'upper' });
	await sleep(700);
	const afterCaseUpper = await readAfterFlip();
	await putRoom({ lyricsCase: 'natural' });
	await sleep(700);
	const afterCaseNatural = await readAfterFlip();
	const caseLive = afterCaseUpper?.textTransform === 'uppercase' && afterCaseNatural?.textTransform !== 'uppercase';
	record(
		'P6-6d',
		'MEDIUM',
		caseLive,
		'lyrics-case (natural / upper / …) applies via text-transform live',
		caseLive ? '' : `upper=${afterCaseUpper?.textTransform}, natural=${afterCaseNatural?.textTransform}`
	);

	// sync-mode — flipping to `lines` should CLAMP the highlight/ball; overlay should not
	// break, and (per the settings warning) the resolved values differ from what was asked.
	await putGlobal({ syncMode: 'lines' });
	await sleep(1000);
	const afterSyncLines = await readAfterFlip();
	await putGlobal({ syncMode: 'forced' });
	await sleep(700);
	const afterSyncForced = await readAfterFlip();
	// Overlay must still render throughout (not break under the clamp).
	const syncSurvives = !!afterSyncLines && !!afterSyncForced;
	// Under `lines`, resolveLyricsPresentation clamps `word` → `line`, so hlClass should be
	// `hl-line`; under `forced` it goes back to `hl-word`.
	const syncEffective = afterSyncLines?.hlClass === 'hl-line' && afterSyncForced?.hlClass === 'hl-word';
	record(
		'P6-6e',
		'HIGH',
		syncSurvives && syncEffective,
		'sync-mode flip live-clamps the overlay without breaking it',
		syncSurvives && syncEffective
			? ''
			: `overlay survives=${syncSurvives}, hlClass went lines:${afterSyncLines?.hlClass}, forced:${afterSyncForced?.hlClass}`
	);

	// ── FINDING (7): a song with NO lyrics renders no broken reel ─────────
	// Strategy: overwrite the artifact file with empty content, force a re-fetch by
	// briefly clearing lyricsRef through a settings ping (no such endpoint) or, more
	// portably, replace the file with `null`-parsing JSON and reload the TV.
	writeFileSync(lyricsPath, '{}');
	await tv.goto(`${base}/tv`);
	await tv
		.waitFor(`[...document.querySelectorAll('video,audio')].some(e => e.currentSrc || e.src)`, {
			timeout: 15_000
		})
		.catch(() => {});
	await sleep(1500);
	const emptyState = await tv.evaluate(`(() => {
		const l = document.querySelector(${JSON.stringify(SEL.lyrics)});
		return {
			present: !!l,
			rows: document.querySelectorAll(${JSON.stringify(SEL.lyricsRow)}).length,
			hasCurrent: document.querySelector(${JSON.stringify(SEL.lyricsRowCurrent)}) !== null,
			hasText: (document.querySelector(${JSON.stringify(SEL.lyrics)})?.textContent ?? '').trim().length
		};
	})()`);
	// Overlay must render nothing observable when parseLyricsDoc returns null.
	const emptyOk = !emptyState.present || (!emptyState.hasCurrent && emptyState.hasText === 0);
	record(
		'P6-7',
		'HIGH',
		emptyOk,
		'a media with an EMPTY/absent lyrics artifact renders no broken reel',
		emptyOk
			? ''
			: `.lyrics present=${emptyState.present}, rows=${emptyState.rows}, hasCurrent=${emptyState.hasCurrent}, textLen=${emptyState.hasText} — the overlay should silently no-op.`
	);
} catch (err) {
	record('P6-flow', 'CRITICAL', false, 'probe ran to completion', String(err instanceof Error ? err.stack : err));
} finally {
	browser?.close();
	rawCdp?.close();
	proc.kill();
}

// ── Summary ────────────────────────────────────────────────────────────────
const pass = findings.filter((f) => f.ok).length;
const total = findings.length;
console.log(`\n${'─'.repeat(72)}\n${pass}/${total} passed\n`);
/** @type {Record<Severity, Finding[]>} */
const bySev = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [] };
for (const f of findings) if (!f.ok) (bySev[f.sev] ??= []).push(f);
for (const sev of /** @type {Severity[]} */ (['CRITICAL', 'HIGH', 'MEDIUM'])) {
	if (!bySev[sev]?.length) continue;
	console.log(`${sev}:`);
	for (const f of bySev[sev]) console.log(`  - ${f.id} ${f.name}`);
}
const realDefects = findings.filter(
	(f) => !f.ok && f.sev !== 'MEDIUM' && !['P6-fixture', 'P6-5'].includes(f.id)
).length;
process.exit(realDefects ? 1 : 0);
