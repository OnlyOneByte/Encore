/*
 * P6 — WORD-TIMED LYRICS OVERLAY: does the reel appear without a reload, does the highlight track the
 * audio clock, do the reel and ball move, do live room settings change what is on screen, and does an
 * unlyriced song render nothing broken.
 *
 * THE FIXTURE CAN LOOK LIKE THE BUG. Every timing signal comes from the artifact the fake worker
 * writes, so schema agreement is checked first and the time-varying findings are re-tested against an
 * artifact the probe writes itself. docs/E2E.md#exit-codes-and-what-ran-means
 *
 *   EPORT=5226 MEDIA_DIR=$KIROCREW_SCRATCH/e2e-5226/media bun tests/e2e/probes/p6-lyrics.mjs
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect, sleep } from '../driver.mjs';
import { SEL } from '../contract.ts';
import { findChromium } from '../lib/chromium.mjs';
import { openBrowseFromHome, returnHomeFromBrowse } from '../lib/phone.mjs';
import { atRepo } from '../lib/repo-root.mjs';
import { openJoin } from '../lib/join.mjs';

/**
 * `page.evaluate()` and `fetch().json()` are Promise<any>, so results are cast at the call site.
 *
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'} Severity
 * @typedef {{ id: string, sev: Severity, ok: boolean, name: string, detail: string }} Finding
 * @typedef {{ id: string, title: string, source: string, lyricsRef?: string }} SongRow
 * @typedef {{ results: SongRow[], ready: SongRow[] }} SearchBody
 * @typedef {{
 *   wall: number, currentTime: number, active: string | null, current: string | null,
 *   reelTransform: string
 * }} TrackSample
 * @typedef {{ word: string, start: number, end: number } | null} ExpectedWord
 */

const PORT = process.env.EPORT ?? '5226';
const base = `http://127.0.0.1:${PORT}`;
const MEDIA_DIR = resolve(process.env.MEDIA_DIR ?? './media');

/** @type {Finding[]} */
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

// SCHEMA SANITY FIRST: the worker writes {startSec,endSec,text} where the parser reads {start,end,word}.
const parserCheck = await (async () => {
	const raw = {
		lines: [{ start: 0, end: 1, text: 'x', words: [{ word: 'x', start: 0, end: 1 }] }]
	};
	const bad = {
		lines: [{ startSec: 0, endSec: 1, text: 'x', words: [{ text: 'x', startSec: 0, endSec: 1 }] }]
	};
	const mod = await import(pathToFileURL(atRepo('src', 'lib', 'tv', 'lyrics.ts')).href);
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

/**
 * Process a fresh song by title-fragment, resolving when the align artifact lands.
 * @param {string} query
 * @param {{ waitForAlign?: boolean, timeoutMs?: number }} [opts]
 * @returns {Promise<{ id: string, row: SongRow }>}
 */
async function processAndWait(query, { waitForAlign = true, timeoutMs = 15_000 } = {}) {
	const found = /** @type {SearchBody} */ (
		await fetch(`${base}/api/search?q=${encodeURIComponent(query)}`).then((r) => r.json())
	);
	const raw = [...found.results, ...found.ready].find((x) => x.source === 'local');
	if (!raw) throw new Error(`no local song matching "${query}"`);
	if (!found.ready.some((r) => r.id === raw.id)) {
		await fetch(`${base}/api/process`, {
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
let processed;
try {
	processed = await processAndWait('caroline');
} catch (err) {
	bail(`could not process a probe song: ${err instanceof Error ? err.message : String(err)}`);
}
console.log(`processed: "${processed.row.title}" id=${processed.id} lyricsRef=${processed.row.lyricsRef}\n`);

/** One-shot kick: headless refuses unmuted autoplay without a gesture. docs/E2E.md#autoplay
 * @param {Page} tv */
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
		await phone.click(SEL.bandTransport);
		await sleep(600);
		lastReport = await kickPlayback(tv);
		const a2 = await positionAdvancing(tv);
		if (a2.advanced) return { ok: true, report: lastReport, a2 };
	}
	return { ok: false, report: lastReport };
}
/** Seek back to 0 by clicking restart on the phone; kick again if needed.
 * @param {Page} tv @param {Page} phone */
async function seekToStart(tv, phone) {
	try {
		await phone.clickByLabel(SEL.restart.name);
	} catch {
		/* best-effort cleanup */
	}
	await sleep(400);
	await kickPlayback(tv);
}

let browser;
try {
	browser = await connect({ args: ['--autoplay-policy=no-user-gesture-required'] });

	const phone = await browser.newPage();
	await phone.viewport(390, 844);
	await openJoin(phone, base);
	await phone.fill(SEL.nameInput, `P6Phone${Date.now() % 100000}`);
	await phone.clickByRole('button', 'Start singing');
	await phone.waitFor(`location.pathname === '/'`);
	await openBrowseFromHome(phone);

	await phone.fill(SEL.search, 'caroline');
	await phone.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length > 0`);
	const hasAdd = await phone.count(SEL.addTurn);
	await phone.click(hasAdd > 0 ? SEL.addTurn : SEL.sing);
	// Back to the queue BEFORE counting rows: the rotation is not rendered in the results view.
	await returnHomeFromBrowse(phone);
	await phone.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length > 0`);

	const tv = await browser.newPage();
	await tv.viewport(1920, 1080, 1);
	await tv.goto(`${base}/tv`);

	// Off the HTTP cache for /media (`max-age=86400`), or an artifact overwritten below is never re-fetched.
	await tv.bypassCacheFor('**/media/**');

	await tv
		.waitFor(`[...document.querySelectorAll('video,audio')].some(e => e.currentSrc || e.src)`, { timeout: 20_000 })
		.catch(() => {});
	const kicked = await ensurePlaying(tv, phone);
	if (!kicked.ok)
		console.warn(
			`WARN: playback never started — subsequent findings may all be N/A. last kick report: ${kicked.report}`
		);

	// (1) the reel appears without a reload. The wait is long: the play-when-queued path and the 'Next up'
	// interstitial both delay it.
	const reelPresent = await (async () => {
		const deadline = Date.now() + 20_000;
		let lastDiag = 0;
		while (Date.now() < deadline) {
			const p = await tv.evaluate(`document.querySelector(${JSON.stringify(SEL.lyrics)}) !== null`);
			if (p) return true;
			// A periodic snapshot, so a timeout says WHY (attract, interstitial, loading, element failure).
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
		reelPresent ? '' : 'no.lyrics element ever appeared on /tv while a processed song with lyricsRef was current'
	);

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

	// (2) does the active word track the clock? Sampled as-is, then again after the artifact is rewritten
	// in the parser's shape — a wrong shape means no highlight can exist at all.
	/**
	 * @param {string} tag
	 * @param {(t: number) => ExpectedWord} expectedByTime
	 * @returns {Promise<{ tag: string, samples: TrackSample[], lags: { t: number, word: string, lagSec: number }[] }>}
	 */
	async function sampleTracking(tag, expectedByTime) {
		const samples = [];
		const start = Date.now();
		for (let i = 0; i < 20 && Date.now() - start < 6500; i++) {
			const s = await tv.evaluate(`(() => {
				const v = document.querySelector('video,audio');
				const a = document.querySelector(${JSON.stringify(SEL.activeWord)});
				const c = document.querySelector(${JSON.stringify(SEL.lyricsRowCurrent)});
				const reel = document.querySelector(${JSON.stringify(SEL.lyricsReel)});
				const t = reel ? getComputedStyle(reel).transform : '';
				// The .word.active span wraps the ball glyph too, so textContent yields the glyph — strip it.
				const rawActive = a ? a.textContent.trim() : null;
				const active = rawActive ? rawActive.replace(/^[●·]+\s*/, ''): null;
				const rawCurrent = c ? c.textContent.trim() : null;
				const current = rawCurrent ? rawCurrent.replace(/^[●·]+\s*/, '').trim(): null;
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
		// Lag = currentTime - word.start where sampled and expected agree. LYRICS_LEAD_SEC=0.3 puts the ball
		// on a word 0.3s BEFORE the audio, so a healthy lag is ≈ +300..+700ms; near 0 means no lead, negative
		// means late.
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

	// The fake worker's table: 9 words at 0.8s intervals, each 0.7s long — word i covers [i*.8, i*.8+.7).
	const fakeWords = ['Sing', 'along', 'with', 'the', 'tone', 'now', 'here', 'we', 'go'];
	const expectedByFakeTime = (/** @type {number} */ t) => {
		const idx = Math.floor(t / 0.8);
		if (idx < 0 || idx >= fakeWords.length) return null;
		return { word: fakeWords[idx], start: idx * 0.8, end: idx * 0.8 + 0.7 };
	};

	await seekToStart(tv, phone);
	const asIsTracking = await sampleTracking('as-is', expectedByFakeTime);
	const activeSeenAsIs = asIsTracking.samples.filter((s) => s.active).length;
	record(
		'P6-2a',
		'CRITICAL',
		activeSeenAsIs > 0,
		'the active word appears on screen at all against the shipped fake-worker fixture',
		activeSeenAsIs > 0
			? `${activeSeenAsIs}/${asIsTracking.samples.length} samples had a.word.active`
			: `not once did.word.active exist. All ${asIsTracking.samples.length} samples were null. ` +
					`Root cause: fixture/parser schema mismatch above — no word timings survive parseLyricsDoc.`
	);

	// Rewrite the artifact in the real worker's shape, so this measures the overlay and not the fixture.
	if (!processed.row.lyricsRef) throw new Error('processed song has no lyricsRef');
	const lyricsPath = join(MEDIA_DIR, processed.row.lyricsRef);
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
	await tv.goto(`${base}/tv`);
	await tv
		.waitFor(`[...document.querySelectorAll('video,audio')].some(e => e.currentSrc || e.src)`, { timeout: 20_000 })
		.catch(() => {});
	await ensurePlaying(tv, phone);
	await seekToStart(tv, phone);
	await sleep(300);
	const t0 = await tv.evaluate(`document.querySelector('video,audio')?.currentTime ?? -1`);
	if (t0 > 1.5) {
		await seekToStart(tv, phone);
		await sleep(600);
	}
	await kickPlayback(tv);
	const correctedTracking = await sampleTracking('corrected', expectedByFakeTime);
	const activeSeenCorrected = correctedTracking.samples.filter((s) => s.active).length;
	console.log('  corrected samples (last 6):', JSON.stringify(correctedTracking.samples.slice(-6), null, 1));
	const fileNow = (() => {
		try {
			return readFileSync(lyricsPath, 'utf8').slice(0, 200);
		} catch {
			return '<missing>';
		}
	})();
	console.log('  lyrics file (first 200):', fileNow);
	const fetchedByBrowser = await tv.evaluate(
		`fetch('/media/${processed.row.lyricsRef}').then(r => r.text()).then(t => t.slice(0, 200))`
	);
	console.log('  lyrics file as browser sees:', fetchedByBrowser);
	record(
		'P6-2b',
		'HIGH',
		activeSeenCorrected > 0,
		'against a CORRECTLY-shaped fixture, the active word IS drawn',
		activeSeenCorrected > 0
			? `${activeSeenCorrected}/${correctedTracking.samples.length} samples had.word.active`
			: `still no.word.active with the corrected fixture (${JSON.stringify(correctedTracking.samples.slice(0, 3))}) — ` +
					`this would be a real overlay defect, not an env limit.`
	);

	if (correctedTracking.lags.length > 0) {
		const lagsMs = correctedTracking.lags.map((l) => Math.round(l.lagSec * 1000));
		const meanLag = Math.round(lagsMs.reduce((a, b) => a + b, 0) / lagsMs.length);
		const varLag = Math.round(Math.sqrt(lagsMs.reduce((a, b) => a + (b - meanLag) ** 2, 0) / lagsMs.length));
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

	// (3) the reel scrolls (translateY changes) and the ball walks the row.
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

	// Audio advancing with a frozen reel is one bug; a moving reel over stalled audio is another.
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

	// (4) readability at 1920x1080, computed from the DOM as well as shot: the screenshot is a supplement.
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

	// 1080p is read from ~10 feet and --tv-lyric sits at 60-90px, so under 40px is unreadable.
	const sizeOk = !!geom && geom.currentTextPx >= 40;
	record(
		'P6-4a',
		'HIGH',
		sizeOk,
		`current-line text is legible at TV distance (${geom?.currentTextPx ?? 'n/a'}px at 1920x1080)`,
		sizeOk ? '' : `current-line font-size is ${geom?.currentTextPx}px — a couch-distance TV needs ≥40px.`
	);

	// Black stage, white/amber ink clear 4.5:1 by construction, so the 7:1 threshold is what catches an
	// accidental drop to a mid-grey.
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

	// (5) the amber tint and 'Auto-transcribed' label hang off a chosen candidate with textSource
	// asr/captions. The fake worker sends no `candidates`, so no label renders — an ENV LIMIT, because a
	// real ASR worker sends both.
	const provState = await tv.evaluate(`(() => ({
		asrLabel: document.querySelector(${JSON.stringify(SEL.lsAsr)})?.textContent.trim() ?? null,
		unverified: !!document.querySelector(${JSON.stringify(SEL.lyricsUnverified)}),
		reelColor: (() => { const w = document.querySelector(${JSON.stringify(SEL.activeWord)}); return w ? getComputedStyle(w).color : null; })()
	}))()`);
	console.log('  provenance state:', JSON.stringify(provState));
	const provOk = provState.asrLabel === 'Auto-transcribed' && provState.unverified;
	record(
		'P6-5',
		'MEDIUM',
		provOk,
		'transcribed lyrics carry the "Auto-transcribed" provenance label and the amber .unverified tint',
		provOk
			? ''
			: `no.ls-asr label rendered and.lyrics.unverified=${provState.unverified}. ` +
					`ROOT CAUSE (env limit): fake-stems-worker.mjs align branch does not send ` +
					`artifacts.lyrics.candidates; worker-hub.ts:245 calls setMediaLyrics without candidates; ` +
					`chosenCandidate(media) returns null; isAutoTranscribed(null)=false. ` +
					`Real workers via apps/worker do send candidates, so this surface works in a real process.`
	);

	// (6) each lyrics/sync setting flipped through the real /api/settings/room takes effect with no restart.

	async function ensureSongOnStage() {
		const has = await tv.evaluate(`document.querySelector(${JSON.stringify(SEL.lyricsRowCurrent)}) !== null`);
		if (has) return true;
		await seekToStart(tv, phone);
		await sleep(800);
		const nowHas = await tv.evaluate(`document.querySelector(${JSON.stringify(SEL.lyricsRowCurrent)}) !== null`);
		if (nowHas) return true;
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
	// highlight=word and ball=bounce are preconditions for the marker checks below.
	await putRoom({ lyricsHighlight: 'word', lyricsBall: 'bounce', lyricsFont: 'system', lyricsCase: 'natural' });
	await sleep(400);
	const settingsHaveSong = await ensureSongOnStage();
	if (!settingsHaveSong) console.warn('WARN: could not restore a playing song before settings sweep');
	/** @param {Record<string, unknown>} body */
	async function putRoom(body) {
		// The phone's context holds the singer session cookie settings auth rides on.
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
	/** A flip that lands during a silent gap between songs would read null and be mis-attributed. */
	async function readAfterFlip() {
		let out = await readClasses();
		if (!out) {
			await ensureSongOnStage();
			await sleep(500);
			out = await readClasses();
		}
		return out;
	}
	/** Polled, because the ball only mounts under an ACTIVE word and words are ~0.7s wide with ~0.1s
	 * gaps, so a single sample can catch the gap and report a present marker as absent. */
	async function readBallClassPatient(timeoutMs = 1500) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const s = await readAfterFlip();
			if (s?.ballClass) return { ballClass: s.ballClass, ballPresent: s.ballPresent };
			await sleep(150);
		}
		const final = await readAfterFlip();
		return final ?? {};
	}
	const base0 = await readClasses();

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

	await putRoom({ lyricsBall: 'steady' });
	await sleep(700);
	const afterBallSteady = await readBallClassPatient();
	await putRoom({ lyricsBall: 'underline' });
	await sleep(700);
	const afterBallUnder = await readBallClassPatient();
	await putRoom({ lyricsBall: 'off' });
	await sleep(700);
	const afterBallOff = await readAfterFlip();
	await putRoom({ lyricsBall: 'bounce' });
	await sleep(700);
	const afterBallBounce = await readBallClassPatient();
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

	// The font family is set on .viewport and inherited, so read it off .row.current.
	await putRoom({ lyricsFont: 'serif' });
	await sleep(700);
	const afterFontSerif = await readAfterFlip();
	await putRoom({ lyricsFont: 'system' });
	await sleep(700);
	const afterFontSystem = await readAfterFlip();
	// `includes('serif')` is wrong: a system-ui stack ends in 'sans-serif'. Compare resolved families.
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

	// sync-mode `lines` CLAMPS hl-word to hl-line and `forced` restores it, so the resolved values differ
	// from what was asked and the overlay must not break under the clamp.
	await putGlobal({ syncMode: 'lines' });
	await sleep(1000);
	const afterSyncLines = await readAfterFlip();
	await putGlobal({ syncMode: 'forced' });
	await sleep(700);
	const afterSyncForced = await readAfterFlip();
	const syncSurvives = !!afterSyncLines && !!afterSyncForced;
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

	// (7) no lyrics renders nothing broken: the artifact is replaced with content that parses to null,
	// since there is no endpoint for clearing lyricsRef.
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
}

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
