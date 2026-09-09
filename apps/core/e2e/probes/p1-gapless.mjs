/*
 * P1 — GAPLESS PLAYBACK AND AUTO-ADVANCE.
 *
 * Cooks two library songs to real decodable audio via the fake worker, queues them as two DIFFERENT
 * singers, opens the TV headless (autoplay allowed), and answers with numbers:
 *
 *   (1) auto-advance   — does song 2 start with no human touch?
 *   (2) gapless bound   — measure the gap between the last decoded byte of song 1 and the first
 *                          decoded byte of song 2, on the TV's TWO <audio> slots
 *   (3) double audio    — is there ever a sample window where BOTH slots decode? that would be two
 *                          songs at once
 *   (4) song-intro card — does the interstitial appear, name the right singer, and time out to
 *                          ENCORE_SONG_INTRO_MS? does audio start before/during/after it?
 *   (5) last-song end   — does the TV settle into attract, or strand?
 *   (6) lower-third     — does .ls-name change to the new singer at the swap, and only then?
 *
 * WHAT COUNTS AS PROOF. The same rule playback.mjs spelled out: `paused === false` proves nothing,
 * `readyState === 4` proves nothing; the decoded byte counter climbing is what proves samples reached
 * the pipeline. Every finding below is anchored to that counter and to the wall clock, not to
 * `paused` or `currentTime` alone.
 *
 * ENVIRONMENT LIMITS. This box has no deno / no ffmpeg encode / no torch / no ffmpeg volumedetect
 * (see e2e/HARNESS.md). Nothing here needs any of them: the fake worker publishes real 16-bit PCM WAV
 * by hand (wav.mjs) and the whole cook happens over the real wire.
 *
 *   PORT=5221 EPORT=5221 bun apps/core/e2e/probes/p1-gapless.mjs   # boot server + worker first
 *
 * Exit codes:  0 = all findings collected AND no CRITICAL/HIGH  ·  1 = at least one HIGH+ defect  ·
 *              2 = the environment could not host the test (no server, no library, no Chromium)
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, sleep } from '../cdp.mjs';
import { SEL } from '../contract.ts';
import { findChromium } from '../lib/chromium.mjs';
import { openBrowseFromHome } from '../lib/phone.mjs';

/**
 * Types for this out-of-program driver, which runs under tsconfig.e2e.json (issue #561, following the
 * #557/#558/#559/#560 pattern). Browser/Page are derived from cdp.mjs's own return types (#553) so they
 * cannot drift from the driver. page.evaluate() is typed Promise<any> by cdp.mjs, so DOM/API-shaped
 * results are cast at the call site.
 *
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'} Severity
 * @typedef {{ sev: Severity, id: string, title: string, evidence: string, path: string }} Finding
 *
 * A media row as returned by /api/search (the fields this probe reads).
 * @typedef {{ id: string, title: string, source?: string, instrumentalRef?: string, stemStatus?: string }} Media
 *
 * A joined singer with its session cookie.
 * @typedef {{ name: string, singerId: string, cookie: string }} Singer
 *
 * One audio/video element read out of the TV page per sample.
 * @typedef {{
 *   tag: string, src: string, readyState: number, paused: boolean, muted: boolean, volume: number,
 *   currentTime: number, duration: number, ended: boolean, decoded: number | null,
 *   error: { code: number, message: string } | null, slotIdx: number, slotVisible: boolean | null
 * }} Elem
 *
 * One dense-poll sample of the TV: the element readout plus the lower-third / up-next / attract state.
 * @typedef {{
 *   t: number, slotCount: number, slotVisible: boolean[], elems: Elem[],
 *   lowerThird: { visible: boolean, name: string, song: string },
 *   upNext: { visible: boolean, label: string, name: string, song: string, kind: string | null },
 *   attract: boolean, wallMs: number, relMono: number
 * }} Sample
 *
 * The context handed to analyze(): the two readied songs and the two singers.
 * @typedef {{ song1: Media, song2: Media, alice: Singer, bob: Singer }} Ctx
 */

// ── config ─────────────────────────────────────────────────────────────────────────────────────
const PORT = process.env.EPORT ?? process.env.PORT ?? '5221';
const CDP_PORT = Number(process.env.CDP_PORT ?? 9421);
const base = `http://127.0.0.1:${PORT}`;
const SCRATCH = process.env.KIROCREW_SCRATCH ?? '/tmp';
const artDir = join(SCRATCH, `p1-gapless-${PORT}`);
mkdirSync(artDir, { recursive: true });

// The fixtures are 8 seconds long. The room defaults ENCORE_SONG_INTRO_MS to 2500. So one full
// song-to-song cycle is roughly 8s song + 2.5s card + 8s song = 18.5s of screen time. Give a
// generous margin around that for cook, initial intro card, and post-end settle.
const COOK_TIMEOUT_MS = 30_000;
const OBSERVE_TIMEOUT_MS = 45_000;
const SAMPLE_MS = 40; // ~25 Hz — dense enough to see a boundary the size of one video frame

// ── little helpers ─────────────────────────────────────────────────────────────────────────────
/** @param {string} msg @returns {never} */
function bail(msg) {
	console.error(`\nENVIRONMENT: ${msg}`);
	process.exit(2);
}
/** @param {string} url @param {RequestInit} [init] @returns {Promise<{ ok: boolean, status: number, headers: Headers, body: any }>} */
async function j(url, init = {}) {
	const res = await fetch(url, init);
	const text = await res.text();
	try {
		return { ok: res.ok, status: res.status, headers: res.headers, body: JSON.parse(text) };
	} catch {
		return { ok: res.ok, status: res.status, headers: res.headers, body: text };
	}
}
/** Parse an `encore_singer=<token>` value out of one or more Set-Cookie response headers. */
/** @param {string | null} setCookie @returns {string | null} */
function parseSessionCookie(setCookie) {
	if (!setCookie) return null;
	const m = /encore_singer=([^;]+)/.exec(setCookie);
	return m ? m[1] : null;
}
// ── findings sink ──────────────────────────────────────────────────────────────────────────────
/** @type {Finding[]} */
const findings = []; // {sev, id, title, evidence, path}
/**
 * @param {Severity} sev
 * @param {string} id
 * @param {string} title
 * @param {string} [evidence]
 * @param {string} [path]
 */
function record(sev, id, title, evidence, path = '') {
	findings.push({ sev, id, title, evidence: evidence ?? '', path });
	console.log(`\n[${sev}] ${id}  ${title}`);
	if (path) console.log(`  where: ${path}`);
	if (evidence) console.log(`  ${evidence.split('\n').join('\n  ')}`);
}

// ── preflight ──────────────────────────────────────────────────────────────────────────────────
if (!(await fetch(`${base}/health`).catch(() => null))?.ok) {
	bail(`no Encore server on ${base}. Start one and re-run per e2e/HARNESS.md.`);
}
const chromium = findChromium();
if (!chromium) bail('no Chromium found. Set PW_CHROMIUM.');

// The fake worker must be dial-homed for cooks to complete. HARNESS.md tells the caller to start it,
// but a caller who forgot would otherwise sit for 30s at "cook did not complete" with no signpost.
// Cheap check: enqueue one make-karaoke and give up early if it never even reaches `queued`
// beyond the initial dispatch. But the simplest tell is a healthy /health + a search that lands.
const preSearch = await j(`${base}/api/search?q=`);
if (!preSearch.ok) bail(`search endpoint failed: ${preSearch.status} ${JSON.stringify(preSearch.body)}`);

// ── pick two DIFFERENT library songs ───────────────────────────────────────────────────────────
/** Fetch a specific library title from the four demo tracks. */
/** @param {string} q @returns {Promise<Media | null>} */
async function findLocalByTitle(q) {
	const r = await j(`${base}/api/search?q=${encodeURIComponent(q)}`);
	if (!r.ok) bail(`search failed for ${JSON.stringify(q)}: ${r.status}`);
	const groups = [r.body.ready ?? [], r.body.cooking ?? [], r.body.results ?? []];
	for (const g of groups) {
		for (const m of /** @type {Media[]} */ (g)) if (m.source === 'local') return m;
	}
	return null;
}
const song1 = await findLocalByTitle('caroline');
const song2 = await findLocalByTitle('believin');
if (!song1 || !song2) {
	bail(
		`could not find two distinct demo tracks (need sweet-caroline + dont-stop-believin). ` +
			`Seed with: MEDIA_DIR=... bun run e2e/seed-media.mjs`
	);
}
if (song1.id === song2.id) bail('sanity: search returned the same media for both queries');
console.log(`song1: "${song1.title}"  ${song1.id}`);
console.log(`song2: "${song2.title}"  ${song2.id}`);

// ── two singers via /api/join ───────────────────────────────────────────────────────────────────
/** @param {string} name @param {string} color @returns {Promise<Singer>} */
async function joinSinger(name, color) {
	const res = await fetch(`${base}/api/join`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ displayName: name, color })
	});
	if (!res.ok) bail(`join ${name} failed: ${res.status} ${await res.text()}`);
	const setCookie = res.headers.get('set-cookie');
	const token = parseSessionCookie(setCookie);
	if (!token) bail(`join ${name}: no session cookie in response`);
	const body = await res.json();
	return { name, singerId: body.singer.id, cookie: `encore_singer=${token}` };
}
const alice = await joinSinger(`Alice-${Date.now() % 100000}`, '#ff5cae');
const bob = await joinSinger(`Bob-${Date.now() % 100000}`, '#66d1ff');
console.log(`joined ${alice.name} ${alice.singerId} and ${bob.name} ${bob.singerId}`);

// ── cook both songs ─────────────────────────────────────────────────────────────────────────────
/** @param {string} mediaId @param {string} cookie @param {string} label @returns {Promise<Media>} */
async function cookAndWait(mediaId, cookie, label) {
	const res = await fetch(`${base}/api/make-karaoke`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie },
		body: JSON.stringify({ mediaId })
	});
	if (!res.ok && res.status !== 200) {
		const body = await res.text();
		bail(`make-karaoke ${label} failed: ${res.status} ${body}`);
	}
	// poll /api/search?q=<title> until this media appears in `ready`
	const q = label === /** @type {Media} */ (song1).title ? 'caroline' : 'believin';
	const deadline = Date.now() + COOK_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const s = await j(`${base}/api/search?q=${encodeURIComponent(q)}`);
		const ready = /** @type {Media[]} */ (s.body.ready ?? []).find((m) => m.id === mediaId);
		if (ready && ready.instrumentalRef && ready.stemStatus === 'ready') return ready;
		await sleep(300);
	}
	bail(`${label} did not become ready within ${COOK_TIMEOUT_MS}ms — is the fake worker running?`);
}
const readied1 = await cookAndWait(song1.id, alice.cookie, song1.title);
const readied2 = await cookAndWait(song2.id, bob.cookie, song2.title);
console.log(`cooked: ${readied1.title} → ${readied1.instrumentalRef}`);
console.log(`cooked: ${readied2.title} → ${readied2.instrumentalRef}`);

// ── launch Chromium; open TV so we can observe from t=0 of the first song ──────────────────────
const proc = spawn(
	chromium,
	[
		`--remote-debugging-port=${CDP_PORT}`,
		'--headless=new',
		'--no-sandbox',
		'--disable-gpu',
		'--no-first-run',
		'--user-data-dir=' + join(SCRATCH, `p1-gapless-cdp-${process.pid}`),
		// The real TV has nobody to tap it. The app must still not DEPEND on a gesture; this only
		// removes the browser's gating so autoplay policy stops masquerading as a defect.
		'--autoplay-policy=no-user-gesture-required',
		'about:blank'
	],
	{ stdio: 'ignore' }
);

/** @type {Browser | undefined} */
let browser;
/** @type {Page | undefined} */
let phone1;
/** @type {Page | undefined} */
let phone2;
/** @type {Page | undefined} */
let tv;
/** @type {Sample[]} */
const timeline = []; // per-sample rows: {t, elems:[{tag,src,decoded,currentTime,paused,muted,volume,readyState,ended,error}], lowerThird, upName, upSong, transientKind, tvClass, screenClass}

try {
	browser = await connect(CDP_PORT);

	// TV first. That way our observation starts BEFORE any queue mutation, so we can see the
	// attract → loading → playing entry too.
	tv = await browser.newPage();
	await tv.viewport(1920, 1080, 1);
	await tv.goto(`${base}/tv`);
	// Guard: the TV route must render its own DOM.
	await tv.waitFor(`document.querySelector(${JSON.stringify(SEL.tvRoot)}) !== null`);

	// Now the two singers on their own contexts — a fresh browser context is fresh cookies, which is
	// the whole reason they land as distinct sessions. We ALREADY joined them via /api/join above
	// (so we have their session tokens), so drive the browsers with those cookies rather than doing a
	// second UI join — the API-side singer would collide on name and the /join form would 409.
	/** @param {Page} page @param {string} cookieValue */
	async function withCookie(page, cookieValue) {
		// Land on ANY same-origin URL first so `document.cookie` has an origin to attach to.
		await page.goto(`${base}/health`);
		// A JS-set cookie is not httpOnly, but the server does not care about the httpOnly flag when
		// RECEIVING cookies — the flag is a browser-side read gate. Same-origin requests carry it.
		await page.evaluate(`document.cookie = ${JSON.stringify(cookieValue + '; path=/')}`);
	}

	phone1 = await browser.newPage();
	await phone1.viewport(390, 844);
	await withCookie(phone1, alice.cookie);
	await phone1.goto(`${base}/`);
	// Home is the queue since #832 — reach the search box through the browse push.
	await openBrowseFromHome(phone1);

	phone2 = await browser.newPage();
	await phone2.viewport(390, 844);
	await withCookie(phone2, bob.cookie);
	await phone2.goto(`${base}/`);
	await openBrowseFromHome(phone2);

	// Alice queues song 1. The .add button only appears on ready songs, which we've now cooked.
	await phone1.fill(SEL.search, 'caroline');
	await phone1.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length > 0`);
	const has1 = await phone1.count(SEL.addTurn);
	if (has1 === 0) bail('phone1: cooked song 1 did not offer .add (readiness UI is out of step with server)');
	await phone1.click(SEL.addTurn);
	await phone1.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length > 0`);

	// Bob queues song 2. Between his join and this add, the server has already autostarted playback of
	// song 1 (reconcileOnReady), so Bob's add lands as UP-NEXT.
	await openBrowseFromHome(phone2); // #832: search lives behind the browse push
	await phone2.fill(SEL.search, 'believin');
	await phone2.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length > 0`);
	const has2 = await phone2.count(SEL.addTurn);
	if (has2 === 0) bail('phone2: cooked song 2 did not offer .add');
	await phone2.click(SEL.addTurn);
	await phone2.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length > 0`);

	// ── the assertion path — dense polling of the TV ────────────────────────────────────────────
	// Give the room a beat to publish the second queue add + nowplaying:changed and let the hidden
	// slot pre-warm before we start reading. Without this, sample #0 can catch a state where song 2
	// is not yet on the wire, which is not a defect but reads like one.
	await sleep(400);
	const probe = `(() => {
		const t = performance.now();
		const slotEls = [...document.querySelectorAll(${JSON.stringify(SEL.slot)})];
		const els = [...document.querySelectorAll('audio,video')].map((el) => {
			const slot = el.closest(${JSON.stringify(SEL.slot)});
			const slotIdx = slot ? slotEls.indexOf(slot) : -1;
			return {
				tag: el.tagName, src: el.currentSrc || el.getAttribute('src') || '',
				readyState: el.readyState, paused: el.paused, muted: el.muted, volume: el.volume,
				currentTime: el.currentTime, duration: el.duration, ended: el.ended,
				decoded: el.webkitAudioDecodedByteCount ?? null,
				error: el.error ? { code: el.error.code, message: el.error.message } : null,
				slotIdx,
				slotVisible: (slot?.classList.contains('visible')) ?? null
			};
		});
		const lt = document.querySelector(${JSON.stringify(SEL.lowerThird)});
		const upEl = document.querySelector(${JSON.stringify(SEL.interstitial)});
		const upNameEl = upEl?.querySelector(${JSON.stringify(SEL.upName)});
		const upSongEl = upEl?.querySelector(${JSON.stringify(SEL.upSong)});
		const upLabelEl = upEl?.querySelector(${JSON.stringify(SEL.upLabel)});
		const attractEl = document.querySelector(${JSON.stringify(SEL.attract)});
		return {
			t,
			slotCount: slotEls.length,
			slotVisible: slotEls.map((s) => s.classList.contains('visible')),
			elems: els,
			lowerThird: {
				visible: !!lt,
				name: (lt?.querySelector(${JSON.stringify(SEL.nowName)})?.textContent ?? '').trim(),
				song: (lt?.querySelector(${JSON.stringify(SEL.nowSong)})?.textContent ?? '').trim()
			},
			upNext: {
				visible: !!upEl,
				label: (upLabelEl?.textContent ?? '').trim(),
				name: (upNameEl?.textContent ?? '').trim(),
				song: (upSongEl?.textContent ?? '').trim(),
				kind: upEl ? (upEl.classList.contains('state-next') ? 'next'
					: upEl.classList.contains('state-error') ? 'error'
					: upEl.classList.contains('state-waiting') ? 'waiting' : 'other') : null
			},
			attract: !!attractEl
		};
	})()`;

	const t0 = Date.now();
	const t0Mono = await tv.evaluate('performance.now()');
	const deadline = t0 + OBSERVE_TIMEOUT_MS;
	let sawFirstSong = false;
	let sawSecondSong = false;
	while (Date.now() < deadline) {
		const s = /** @type {Sample} */ (await tv.evaluate(probe));
		s.wallMs = Date.now() - t0;
		s.relMono = s.t - t0Mono;
		timeline.push(s);
		// Track state transitions for an early exit — once we've seen song 1, song 2, then attract, we
		// can stop rather than burn the full timeout budget.
		if (s.elems.some((e) => (e.decoded ?? 0) > 0)) sawFirstSong = true;
		if (
			sawFirstSong &&
			s.elems.filter((e) => (e.decoded ?? 0) > 0 && e.src).length >= 1 &&
			// two distinct src values have carried decoded bytes over the run
			timelineDistinctDecodedSrcs(timeline).size >= 2
		) {
			sawSecondSong = true;
		}
		if (sawSecondSong && s.attract) {
			// give it one more sample window so we lock in the terminal state
			await sleep(SAMPLE_MS);
			timeline.push(/** @type {Sample} */ ({ ...(await tv.evaluate(probe)), wallMs: Date.now() - t0, relMono: 0 }));
			break;
		}
		await sleep(SAMPLE_MS);
	}

	// Screenshot as evidence.
	const shot = join(artDir, 'tv-end.png');
	await tv.screenshot(shot);
	console.log(`\ncaptured ${timeline.length} samples over ~${Math.round((Date.now() - t0) / 1000)}s`);
	console.log(`TV frame: ${shot}`);

	// ── analysis ────────────────────────────────────────────────────────────────────────────────
	analyze(timeline, { song1: readied1, song2: readied2, alice, bob });
	// Persist the timeline in machine-readable form so a follow-up can dig deeper without re-driving.
	writeFileSync(join(artDir, 'timeline.json'), JSON.stringify(timeline, null, 1));
	console.log(`timeline: ${join(artDir, 'timeline.json')}`);
} catch (err) {
	record(
		'CRITICAL',
		'PROBE-CRASH',
		'the probe itself blew up',
		String(/** @type {Error} */ (err)?.stack ?? err),
		'apps/core/e2e/probes/p1-gapless.mjs'
	);
} finally {
	browser?.close();
	proc.kill();
}

// ── analysis helpers ───────────────────────────────────────────────────────────────────────────

/** Set of distinct decoded-carrying src strings across the timeline so far. */
/** @param {Sample[]} tl @returns {Set<string>} */
function timelineDistinctDecodedSrcs(tl) {
	const s = new Set();
	for (const row of tl) {
		for (const el of row.elems) {
			if ((el.decoded ?? 0) > 0 && el.src) s.add(el.src);
		}
	}
	return s;
}

/** Per-src stream: first sample where decoded>0 (start), last sample where it climbed (end). */
/** @param {Sample[]} tl @param {(src: string) => boolean} srcMatch */
function decodingWindow(tl, srcMatch) {
	let first = -1;
	let lastClimb = -1;
	let peak = 0;
	for (let i = 0; i < tl.length; i++) {
		const el = tl[i].elems.find((e) => e.src && srcMatch(e.src));
		if (!el) continue;
		const d = el.decoded ?? 0;
		if (d > 0 && first === -1) first = i;
		if (d > peak) {
			peak = d;
			lastClimb = i;
		}
	}
	return { first, lastClimb, peak };
}

/**
 * The core of P1. Every finding here should carry numbers a reviewer can re-derive from timeline.json.
 */
/** @param {Sample[]} tl @param {Ctx} ctx */
function analyze(tl, ctx) {
	if (tl.length === 0) {
		record(
			'CRITICAL',
			'P1-NO-SAMPLES',
			'no timeline samples were collected',
			'',
			'apps/core/e2e/probes/p1-gapless.mjs'
		);
		return;
	}
	const { song1, song2 } = ctx;
	// Anchor srcs on the two songs. `playbackRef` resolves to instrumentalRef, so the src the element
	// holds is `/media/<mediaId>-instrumental.wav`.
	const isSong1 = (/** @type {string} */ src) =>
		src.includes(song1.id) || (song1.instrumentalRef ? src.includes(song1.instrumentalRef) : false);
	const isSong2 = (/** @type {string} */ src) =>
		src.includes(song2.id) || (song2.instrumentalRef ? src.includes(song2.instrumentalRef) : false);

	const w1 = decodingWindow(tl, isSong1);
	const w2 = decodingWindow(tl, isSong2);

	// A stuck-at-preload element reports a non-zero decoded byte count from buffering alone. Real
	// playback grows the counter as samples are consumed, so require a genuine climb before we count
	// a song as having "played".
	const REAL_PLAYBACK_BYTES = 60_000; // preload of a decode-only WebAudio buffer is 8–24KB
	const w1Played = w1.peak >= REAL_PLAYBACK_BYTES;
	const w2Played = w2.peak >= REAL_PLAYBACK_BYTES;

	// ── (F1) did song 1 EVER produce sound at all? ─────────────────────────────────────────────
	if (!w1Played) {
		record(
			'CRITICAL',
			'P1-F1-NO-SONG1',
			'song 1 never really played',
			`over ${tl.length} samples, "${song1.title}" (${song1.instrumentalRef}) reached a peak decoded byte count of ` +
				`${w1.peak} — below the ${REAL_PLAYBACK_BYTES}-byte real-playback floor, which is what buffering alone can produce. ` +
				`the room heard silence.`,
			'src/lib/tv/TvPlayer.svelte'
		);
		return; // nothing else makes sense
	}
	// ── (F2) did song 2 ACTUALLY PLAY? → the AUTO-ADVANCE question ──────────────────────────────
	if (!w2Played) {
		const stuckAtPreload = w2.first >= 0 && w2.peak > 0 && w2.peak < REAL_PLAYBACK_BYTES;
		const evidence = stuckAtPreload
			? `song 2's element loaded and buffered (peak decoded = ${w2.peak} bytes, only the preload amount), ` +
				`but the byte counter never grew from playback. the element is holding song 2 but is NOT playing it. ` +
				`this is auto-advance broken in the transport, not the queue: the queue advanced (see .ls-name flip) but the ` +
				`new visible slot's transport never went to 'play'. check transport.ts inputs — hasSrc / active / visible / playing — ` +
				`for whichever slot became visible after the swap.`
			: `song 2's element never even loaded a byte. the server never advanced, or the client's applyNowPlaying ` +
				`did not route the new current onto a slot.`;
		record(
			'CRITICAL',
			'P1-F2-NO-AUTO-ADVANCE',
			`song 2 never played — auto-advance is broken (peak decoded = ${w2.peak}B)`,
			evidence,
			'src/lib/tv/transport.ts + src/lib/tv/TvPlayer.svelte + src/lib/tv/gapless.ts'
		);
	}

	// ── (F3) BOUNDARY — the gap between last-decoded of song 1 and first-decoded of song 2 ─────
	if (w1.lastClimb >= 0 && w2.first >= 0) {
		const tEndA = tl[w1.lastClimb].wallMs;
		const tStartB = tl[w2.first].wallMs;
		const deltaMs = tStartB - tEndA;
		const deltaLabel = deltaMs >= 0 ? `${deltaMs}ms of GAP` : `${-deltaMs}ms of OVERLAP`;
		// The A/B swap is meant to be a single composited frame, no network at transition. On this
		// harness a boundary in the low tens of ms is the expected shape; anything past ~250ms reads
		// as an audible dead-air seam, and anything negative reads as double-audio.
		/** @type {Severity} */
		let sev = 'LOW';
		if (deltaMs > 400) sev = 'HIGH';
		else if (deltaMs > 150) sev = 'MEDIUM';
		if (deltaMs < -80) sev = 'HIGH';
		record(
			sev,
			'P1-F3-BOUNDARY',
			`song-to-song boundary: ${deltaLabel}`,
			`wall-clock last decoded climb of song 1 at ${tEndA}ms; first decoded byte of song 2 at ${tStartB}ms. ` +
				`sample density ${SAMPLE_MS}ms — the boundary is resolved to ±one sample. ` +
				`song 1 duration = ${Math.max(...tl.map((r) => r.elems.find((e) => e.src && isSong1(e.src))?.currentTime ?? 0)).toFixed(2)}s.`,
			'src/lib/tv/gapless.ts (onEnded → swap) + src/lib/tv/TvPlayer.svelte (transport + hidden pre-warm)'
		);
	}

	// ── (F4) DOUBLE AUDIO — do BOTH slots decode within the same sample window? ─────────────────
	let simulRows = 0;
	let firstSimulT = -1;
	let maxSimul = 0;
	for (let i = 1; i < tl.length; i++) {
		const prev = tl[i - 1];
		const cur = tl[i];
		// per-src growth
		const growthByTag = new Map();
		for (const el of cur.elems) {
			if (!el.src) continue;
			const pel = prev.elems.find((p) => p.src === el.src);
			if (!pel) continue;
			const grew = (el.decoded ?? 0) > (pel.decoded ?? 0);
			if (grew) growthByTag.set(el.src, (growthByTag.get(el.src) ?? 0) + 1);
		}
		if (growthByTag.size >= 2) {
			simulRows++;
			if (firstSimulT < 0) firstSimulT = cur.wallMs;
			maxSimul = Math.max(maxSimul, growthByTag.size);
		}
	}
	if (simulRows === 0) {
		record(
			'LOW',
			'P1-F4-NO-DOUBLE-AUDIO',
			'no simultaneous decoding on both slots — clean handoff',
			`across ${tl.length - 1} sample transitions, at most one slot's decoded byte counter grew per window. ` +
				`no double-audio window was observed at ${SAMPLE_MS}ms sampling.`,
			''
		);
	} else {
		// Simultaneous decoding is the audible double-song bug when it lasts more than one frame — but
		// a single row at the swap boundary can be an artifact of sampling jitter (both counters
		// updated between the same two reads) and does NOT prove overlap. Flag by duration.
		const dur = simulRows * SAMPLE_MS;
		const sev = simulRows > 3 ? 'HIGH' : simulRows > 1 ? 'MEDIUM' : 'LOW';
		record(
			sev,
			'P1-F4-DOUBLE-AUDIO',
			`both slots grew their decoded counters in ${simulRows} window(s) (~${dur}ms)`,
			`first simultaneous-growth window at wall+${firstSimulT}ms. max simultaneous srcs in one window = ${maxSimul}. ` +
				`${
					simulRows === 1
						? 'ONE such window is likely a sampling artifact — the counters both moved between the same two reads.'
						: simulRows === 2 || simulRows === 3
							? 'a short burst — could be a decoder flush during the swap, worth ear-testing.'
							: 'a sustained overlap — the room would hear two songs at once.'
				}`,
			'src/lib/tv/transport.ts + src/lib/tv/TvPlayer.svelte (hidden slot must be paused before swap)'
		);
	}

	// ── (F5) SONG-INTRO CARD — appears, names the right singer, dismisses on schedule ──────────
	const upFrames = tl.map((r, i) => ({ i, r, up: r.upNext.visible && r.upNext.kind === 'next' ? r.upNext : null }));
	// Find contiguous ranges of `next` cards.
	const cards = [];
	let cur = null;
	for (const f of upFrames) {
		if (f.up) {
			if (!cur) cur = { startI: f.i, endI: f.i, name: f.up.name, song: f.up.song, label: f.up.label };
			else {
				cur.endI = f.i;
			}
		} else if (cur) {
			cards.push(cur);
			cur = null;
		}
	}
	if (cur) cards.push(cur);

	if (cards.length === 0) {
		record(
			'HIGH',
			'P1-F5-NO-INTRO-CARD',
			'no song-intro card was ever rendered',
			`ENCORE_SONG_INTRO_MS defaults to 2500ms, and the room has openedOnce=false → true → true, so the card ` +
				`should appear at least once at the start of song 1 and once at the swap to song 2. observed: zero.`,
			'src/routes/tv/+page.svelte (onFirstSongReady + onVisibleEnded → holdSongIntro)'
		);
	} else {
		for (let k = 0; k < cards.length; k++) {
			const c = cards[k];
			const start = tl[c.startI].wallMs;
			const end = tl[c.endI].wallMs;
			const dur = end - start;
			// Nominal 2500ms. Sampling adds ±SAMPLE_MS at both edges, so a window in [~2300, ~2700] is on-nominal.
			const drift = dur - 2500;
			/** @type {Severity} */
			let sev = 'LOW';
			if (Math.abs(drift) > 400) sev = 'MEDIUM';
			if (Math.abs(drift) > 1200) sev = 'HIGH';
			record(
				sev,
				`P1-F5-CARD-${k + 1}`,
				`song-intro card #${k + 1}: label="${c.label}" name="${c.name}" song="${c.song}" — held ~${dur}ms`,
				`nominal 2500ms; observed ${dur}ms (drift ${drift >= 0 ? '+' : ''}${drift}ms). ` +
					`sample resolution ±${SAMPLE_MS}ms.`,
				'src/routes/tv/+page.svelte (holdSongIntro)'
			);

			// Which singer is the card announcing?
			const expectSong = k === 0 ? ctx.song1.title : ctx.song2.title;
			const expectSinger = k === 0 ? ctx.alice.name : ctx.bob.name;
			if (!c.name.includes(expectSinger.split('-')[0])) {
				record(
					'HIGH',
					`P1-F5-CARD-${k + 1}-WRONG-SINGER`,
					`card #${k + 1} named the wrong singer`,
					`expected name to include "${expectSinger}", got "${c.name}". this is either the two-singer ordering being backwards or a bug in ` +
						`introEntry being derived from upNext (which advances mid-card).`,
					'src/routes/tv/+page.svelte (introEntry capture)'
				);
			}
			if (!c.song.toLowerCase().includes(expectSong.toLowerCase().slice(0, 4))) {
				record(
					'MEDIUM',
					`P1-F5-CARD-${k + 1}-WRONG-SONG`,
					`card #${k + 1} named the wrong song`,
					`expected "${expectSong}", got "${c.song}".`,
					'src/routes/tv/+page.svelte'
				);
			}
		}
	}

	// ── (F5b) does AUDIO play behind the intro card? ───────────────────────────────────────────
	if (cards.length > 0 && w1.first >= 0) {
		const firstCard = cards[0];
		const cardT0 = tl[firstCard.startI].wallMs;
		const cardT1 = tl[firstCard.endI].wallMs;
		const song1FirstT = tl[w1.first].wallMs;
		const relToCard = song1FirstT - cardT0;
		let where;
		if (song1FirstT < cardT0 - SAMPLE_MS) where = 'BEFORE the card';
		else if (song1FirstT > cardT1 + SAMPLE_MS) where = 'AFTER the card dismissed';
		else where = 'DURING the card';
		record(
			'LOW',
			'P1-F5B-AUDIO-VS-CARD',
			`song 1 audio started ${where} (${relToCard}ms into the card window)`,
			`the transport is derived only from visible/active/playing/hasSrc — NOT from tvState — so audio starts as ` +
				`soon as the slot is ready and active. this reproduces that: card was up ${cardT0}..${cardT1}ms and song 1 ` +
				`decoding started at ${song1FirstT}ms. see src/lib/tv/transport.ts.`,
			'src/lib/tv/transport.ts'
		);
	}

	// ── (F6) LOWER-THIRD — did .ls-name change at the swap, and only then? ─────────────────────
	// Collect the first sample carrying song1-decoded and the first sample carrying song2-decoded,
	// then look at .ls-name text around those anchors.
	if (w1.first >= 0 && w2.first >= 0) {
		const nameDuringSong1 = tl[w1.first + 3]?.lowerThird?.name ?? tl[w1.first]?.lowerThird?.name ?? '';
		const nameDuringSong2 = tl[w2.first + 3]?.lowerThird?.name ?? tl[w2.first]?.lowerThird?.name ?? '';
		const changed = nameDuringSong1 && nameDuringSong2 && nameDuringSong1 !== nameDuringSong2;
		if (!changed) {
			record(
				'HIGH',
				'P1-F6-LOWER-THIRD-STUCK',
				'.ls-name did not update between songs',
				`during song 1 (near sample ${w1.first}): "${nameDuringSong1}". during song 2 (near sample ${w2.first}): "${nameDuringSong2}". ` +
					`the room would keep the old singer's name on the wall through the next song.`,
				'src/routes/tv/+page.svelte (.lower-third .ls-name; singers map)'
			);
		} else {
			// Where did it actually flip? Find first sample where name differs from the song-1 name.
			const flipI = tl.findIndex((r, i) => i >= w1.first && r.lowerThird.name && r.lowerThird.name !== nameDuringSong1);
			const flipT = flipI >= 0 ? tl[flipI].wallMs : null;
			const w2StartT = tl[w2.first].wallMs;
			const drift = flipT !== null ? flipT - w2StartT : null;
			record(
				'LOW',
				'P1-F6-LOWER-THIRD',
				`.ls-name changed at the swap`,
				`"${nameDuringSong1}" → "${nameDuringSong2}". the change first observed at wall+${flipT}ms; ` +
					`song 2 decoding began at wall+${w2StartT}ms (offset ${drift}ms, sample resolution ±${SAMPLE_MS}ms). ` +
					`for the singer waiting to sing, that is the right beat.`,
				'src/routes/tv/+page.svelte (.lower-third)'
			);
		}
	}

	// ── (F7) LAST-SONG END → attract or stranded? ──────────────────────────────────────────────
	if (w2.first >= 0) {
		const tailStart = Math.min(w2.lastClimb + 1, tl.length - 1);
		const tail = tl.slice(tailStart);
		const sawAttract = tail.some((r) => r.attract);
		const stillDecoding = tail.some((r) =>
			r.elems.some((e) => (e.decoded ?? 0) > (tl[tailStart - 1]?.elems.find((p) => p.src === e.src)?.decoded ?? 0))
		);
		if (sawAttract && !stillDecoding) {
			record(
				'LOW',
				'P1-F7-ATTRACT',
				'TV returned to attract after the last song ended',
				`tail window: ${tail.length} samples after song 2 stopped growing. .attract element observed. no further decoding.`,
				'src/lib/tv/screen.ts (tvScreen: no current → attract)'
			);
		} else if (!sawAttract) {
			// Might have been cut short by OBSERVE_TIMEOUT — say so explicitly rather than crying wolf.
			const lastRow = tl[tl.length - 1];
			const lastEl = lastRow.elems.find((e) => e.src && isSong2(e.src));
			const stillPlaying = lastEl && !lastEl.paused && !lastEl.ended;
			record(
				stillPlaying ? 'MEDIUM' : 'HIGH',
				'P1-F7-NO-ATTRACT',
				stillPlaying
					? 'observation ended while song 2 was still playing — cannot judge end-of-run behavior'
					: 'TV never returned to attract after the last song ended',
				`tail samples ${tail.length}; last element state: paused=${lastEl?.paused} ended=${lastEl?.ended} currentTime=${lastEl?.currentTime?.toFixed(2)}s. ` +
					`no .attract element observed at any point after song 2 stopped growing.`,
				'src/lib/tv/screen.ts + src/lib/tv/gapless.ts (onEnded with no upNext)'
			);
		}
	}

	// ── (F8) sanity: instrumental plays through <audio>, not <video> ──────────────────────────
	const seenTags = new Set();
	for (const r of tl) {
		for (const e of r.elems) {
			if ((e.decoded ?? 0) > 0) seenTags.add(e.tag);
		}
	}
	if (seenTags.has('VIDEO')) {
		record(
			'HIGH',
			'P1-F8-VIDEO-TAG',
			'the instrumental played through a <video>, not an <audio>',
			`WebKit documents FLAC for <audio> only; audio-only streams in a <video> can decode silently on some browsers. ` +
				`tags observed decoding: ${[...seenTags].join(', ')}.`,
			'src/lib/tv/TvPlayer.svelte (the master element)'
		);
	} else {
		record(
			'LOW',
			'P1-F8-AUDIO-TAG',
			'the instrumental plays through <audio> as designed',
			`tags observed decoding: ${[...seenTags].join(', ') || 'none'}`,
			''
		);
	}

	// ── (F9) SLOT ARCHITECTURE — is the hidden slot mounting a pre-warm <audio> at all? ────────
	// The gapless design mounts TWO slots (A + B), one visible for the current song and one hidden
	// pre-warming the upNext. If we only ever see ONE <audio> element in the DOM, the hidden slot is
	// mounted as a div but never given a media, so there is no pre-warm buffer at all — every swap
	// costs the visible slot a fresh element and a cold load. That defeats the whole feature.
	const slotCounts = new Set(tl.map((r) => r.slotCount));
	const maxAudioCount = tl.reduce((m, r) => Math.max(m, r.elems.length), 0);
	if (!slotCounts.has(2)) {
		record(
			'HIGH',
			'P1-F9-SLOT-COUNT',
			`the .slot count was never 2 — the A/B slot pair is not both mounted`,
			`observed .slot counts across the run: ${[...slotCounts].sort().join(', ')}. ` +
				`the gapless controller expects two slot divs (see src/routes/tv/+page.svelte's two <TvPlayer/> instances).`,
			'src/routes/tv/+page.svelte'
		);
	}
	// Both slot divs may be mounted, but their audio elements are conditionally rendered per media.
	// Count how many distinct sources ever CO-EXISTED in the DOM at the same time.
	if (maxAudioCount < 2 && w2.first >= 0) {
		// We saw song 2 play, but never two <audio>s at once — that means slot B's audio was never
		// mounted alongside slot A's while song 1 was playing. The pre-warm buffer literally didn't
		// exist. That is the mechanical reason the swap opens up the 369ms gap in F3: with no
		// warmed hidden element, the visible slot has to load song 2 cold at the swap moment.
		record(
			'HIGH',
			'P1-F9-NO-PREWARM-MOUNT',
			'the pre-warm slot never mounted an <audio> alongside the playing slot',
			`max concurrent audio/video elements in the DOM = ${maxAudioCount}. the whole run stayed at one ` +
				`element, meaning the hidden slot never carried a pre-warm buffer while the visible slot was playing. ` +
				`syncSlots (src/routes/tv/+page.svelte) should set slotMedia.B = mediaOf(upNext) whenever an upNext exists — ` +
				`if that assignment is happening but the audio still does not mount, the TvPlayer {#if media && isPlayable(media)} ` +
				`gate is refusing it. If it is not happening, ctl.onNowPlaying is being fed a null upNext even though the server ` +
				`published one. Either way, the gapless swap the controller advertises has no buffer to swap TO.`,
			'src/routes/tv/+page.svelte (syncSlots + <TvPlayer media={slotMedia.B}/>) + src/lib/tv/TvPlayer.svelte ({#if media && isPlayable(media)})'
		);
	}

	// Was song 2's <audio> ever present at the same time as song 1's? Concretely: any sample where at
	// least one element carries song 1's src AND another carries song 2's src.
	const overlapMountSamples = tl.filter(
		(r) => r.elems.some((e) => e.src && isSong1(e.src)) && r.elems.some((e) => e.src && isSong2(e.src))
	).length;
	if (overlapMountSamples === 0 && w1.first >= 0 && w2.first >= 0) {
		record(
			'HIGH',
			'P1-F9B-NO-PARALLEL-MOUNT',
			'song 1 and song 2 never co-existed in the DOM',
			`across ${tl.length} samples, no single moment carried both song srcs. that says slot B did not pre-warm ` +
				`song 2 while slot A played song 1 — the "warm the next song" half of gapless swapping never ran.`,
			'src/routes/tv/+page.svelte + src/lib/tv/TvPlayer.svelte'
		);
	} else if (overlapMountSamples > 0) {
		const firstOverlap = tl.findIndex(
			(r) => r.elems.some((e) => e.src && isSong1(e.src)) && r.elems.some((e) => e.src && isSong2(e.src))
		);
		record(
			'LOW',
			'P1-F9B-PARALLEL-MOUNT',
			`song 1 and song 2 co-existed in the DOM for ${overlapMountSamples} sample(s)`,
			`first co-existence at wall+${tl[firstOverlap].wallMs}ms — the pre-warm slot mounted before the swap. good sign.`,
			''
		);
	}
}

// ── final summary ──────────────────────────────────────────────────────────────────────────────
const bySev = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
for (const f of findings) bySev[f.sev] = (bySev[f.sev] ?? 0) + 1;
console.log(`\n── SUMMARY ──`);
console.log(`  CRITICAL: ${bySev.CRITICAL}   HIGH: ${bySev.HIGH}   MEDIUM: ${bySev.MEDIUM}   LOW: ${bySev.LOW}`);
console.log(`  ${findings.length} findings total (see per-finding blocks above).`);
console.log(`  artifacts: ${artDir}`);
process.exit(bySev.CRITICAL + bySev.HIGH > 0 ? 1 : 0);
