/*
 * P1 — GAPLESS PLAYBACK AND AUTO-ADVANCE. Processes two library songs to real decodable audio, queues
 * them as two DIFFERENT singers and dense-polls the TV. The F1–F9 findings below are the questions.
 *
 * Autoplay is GRANTED, so this is NOT-A-TV (docs/E2E.md#autoplay). Every finding is anchored to the
 * decoded byte counter and the wall clock (docs/E2E.md#proving-audio), never to `paused`.
 *
 *   PORT=5221 EPORT=5221 bun tests/e2e/probes/p1-gapless.mjs   # boot server + worker first
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, sleep } from '../driver.mjs';
import { SEL } from '../contract.ts';
import { findChromium } from '../lib/chromium.mjs';
import { openBrowseFromHome, returnHomeFromBrowse } from '../lib/phone.mjs';

/**
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'} Severity
 * @typedef {{ sev: Severity, id: string, title: string, evidence: string, path: string }} Finding
 * @typedef {{ id: string, title: string, source?: string, instrumentalRef?: string, stemStatus?: string }} Media
 * @typedef {{ name: string, singerId: string, cookie: string }} Singer
 * @typedef {{ tag: string, src: string, readyState: number, paused: boolean, muted: boolean,
 *   volume: number, currentTime: number, duration: number, ended: boolean, decoded: number | null,
 *   error: { code: number, message: string } | null, slotIdx: number, slotVisible: boolean | null }} Elem
 * One dense-poll sample of the TV.
 * @typedef {{ t: number, slotCount: number, slotVisible: boolean[], elems: Elem[],
 *   lowerThird: { visible: boolean, name: string, song: string },
 *   upNext: { visible: boolean, label: string, name: string, song: string, kind: string | null },
 *   attract: boolean, wallMs: number, relMono: number }} Sample
 * @typedef {{ song1: Media, song2: Media, alice: Singer, bob: Singer }} Ctx
 */

const PORT = process.env.EPORT ?? process.env.PORT ?? '5221';
const base = `http://127.0.0.1:${PORT}`;
const SCRATCH = process.env.KIROCREW_SCRATCH ?? '/tmp';
const artDir = join(SCRATCH, `p1-gapless-${PORT}`);
mkdirSync(artDir, { recursive: true });

// The fixtures are 8s and ENCORE_SONG_INTRO_MS defaults to 2500, so one song-to-song cycle is ~18.5s
// of screen time. The budget below leaves margin for process, the first intro card and the end settle.
const PROCESS_TIMEOUT_MS = 30_000;
const OBSERVE_TIMEOUT_MS = 45_000;
const SAMPLE_MS = 40; // ~25 Hz — dense enough to see a boundary the size of one video frame

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
/** Parses `encore_singer=<token>` out of Set-Cookie. @param {string | null} setCookie @returns {string | null} */
function parseSessionCookie(setCookie) {
	if (!setCookie) return null;
	const m = /encore_singer=([^;]+)/.exec(setCookie);
	return m ? m[1] : null;
}
/** @type {Finding[]} */
const findings = []; // {sev, id, title, evidence, path}
/** @param {Severity} sev @param {string} id @param {string} title @param {string} [evidence] @param {string} [path] */
function record(sev, id, title, evidence, path = '') {
	findings.push({ sev, id, title, evidence: evidence ?? '', path });
	console.log(`\n[${sev}] ${id}  ${title}`);
	if (path) console.log(`  where: ${path}`);
	if (evidence) console.log(`  ${evidence.split('\n').join('\n  ')}`);
}

if (!(await fetch(`${base}/health`).catch(() => null))?.ok) {
	bail(`no Encore server on ${base}. Start one and re-run per e2e/HARNESS.md.`);
}
const chromium = findChromium();
if (!chromium) bail('no Chromium found. Set PW_CHROMIUM.');

// Without a dial-homed fake worker no process ever completes, and the caller would sit 30s at
// "process did not complete" with no signpost. A healthy /health plus a search that lands is the tell.
const preSearch = await j(`${base}/api/search?q=`);
if (!preSearch.ok) bail(`search endpoint failed: ${preSearch.status} ${JSON.stringify(preSearch.body)}`);

/** Fetches one of the four demo tracks by title. @param {string} q @returns {Promise<Media | null>} */
async function findLocalByTitle(q) {
	const r = await j(`${base}/api/search?q=${encodeURIComponent(q)}`);
	if (!r.ok) bail(`search failed for ${JSON.stringify(q)}: ${r.status}`);
	const groups = [r.body.ready ?? [], r.body.processing ?? [], r.body.results ?? []];
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
			`Seed with: MEDIA_DIR=... bun run tests/e2e/seed-media.mjs`
	);
}
if (song1.id === song2.id) bail('sanity: search returned the same media for both queries');
console.log(`song1: "${song1.title}"  ${song1.id}`);
console.log(`song2: "${song2.title}"  ${song2.id}`);

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

/** @param {string} mediaId @param {string} cookie @param {string} label @returns {Promise<Media>} */
async function processAndWait(mediaId, cookie, label) {
	const res = await fetch(`${base}/api/process`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie },
		body: JSON.stringify({ mediaId })
	});
	if (!res.ok && res.status !== 200) {
		const body = await res.text();
		bail(`process ${label} failed: ${res.status} ${body}`);
	}
	const q = label === /** @type {Media} */ (song1).title ? 'caroline' : 'believin';
	const deadline = Date.now() + PROCESS_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const s = await j(`${base}/api/search?q=${encodeURIComponent(q)}`);
		const ready = /** @type {Media[]} */ (s.body.ready ?? []).find((m) => m.id === mediaId);
		if (ready && ready.instrumentalRef && ready.stemStatus === 'ready') return ready;
		await sleep(300);
	}
	bail(`${label} did not become ready within ${PROCESS_TIMEOUT_MS}ms — is the fake worker running?`);
}
const readied1 = await processAndWait(song1.id, alice.cookie, song1.title);
const readied2 = await processAndWait(song2.id, bob.cookie, song2.title);
console.log(`processed: ${readied1.title} → ${readied1.instrumentalRef}`);
console.log(`processed: ${readied2.title} → ${readied2.instrumentalRef}`);


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
	browser = await connect();

	// TV FIRST, so observation starts before any queue mutation and the attract → playing entry is seen.
	tv = await browser.newPage();
	await tv.viewport(1920, 1080, 1);
	await tv.goto(`${base}/tv`);
	await tv.waitForSelector(SEL.tvRoot);

	// One context per singer, because a fresh context is fresh cookies. They are already joined via
	// /api/join, so inject those cookies rather than joining again — a second UI join would 409 on the name.
	/** @param {Page} page @param {string} cookieValue */
	async function withCookie(page, cookieValue) {
		// Any same-origin URL first, so `document.cookie` has an origin to attach to.
		await page.goto(`${base}/health`);
		// httpOnly is a browser-side READ gate, so a JS-set cookie still rides same-origin requests.
		await page.evaluate(`document.cookie = ${JSON.stringify(cookieValue + '; path=/')}`);
	}

	phone1 = await browser.newPage();
	await phone1.viewport(390, 844);
	await withCookie(phone1, alice.cookie);
	await phone1.goto(`${base}/`);
	await openBrowseFromHome(phone1);

	phone2 = await browser.newPage();
	await phone2.viewport(390, 844);
	await withCookie(phone2, bob.cookie);
	await phone2.goto(`${base}/`);
	await openBrowseFromHome(phone2);

	// The add action only renders on a READY song, which is why both were processed first.
	await phone1.fill(SEL.search, 'caroline');
	await phone1.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length > 0`);
	const has1 = await phone1.count(SEL.addTurn);
	if (has1 === 0) bail('phone1: processed song 1 did not offer .add (readiness UI is out of step with server)');
	await phone1.click(SEL.addTurn);
	// The rotation is NOT rendered in the results view, so a .qrow count taken there times out on an
	// empty list. Clearing the search is what brings the queue back.
	await returnHomeFromBrowse(phone1);
	await phone1.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length > 0`);

	// The server has already autostarted song 1 by now, so this add lands as UP-NEXT.
	await openBrowseFromHome(phone2); // search lives behind the browse push
	await phone2.fill(SEL.search, 'believin');
	await phone2.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length > 0`);
	const has2 = await phone2.count(SEL.addTurn);
	if (has2 === 0) bail('phone2: processed song 2 did not offer .add');
	await phone2.click(SEL.addTurn);
	await returnHomeFromBrowse(phone2);
	await phone2.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length > 0`);

	// Let the second add, nowplaying:changed and the hidden slot's pre-warm land first: sample #0 would
	// otherwise catch song 2 not yet on the wire, which is not a defect but reads like one.
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
		// Early exit once song 1, song 2 and attract have all been seen, rather than burning the budget.
		if (s.elems.some((e) => (e.decoded ?? 0) > 0)) sawFirstSong = true;
		if (
			sawFirstSong &&
			s.elems.filter((e) => (e.decoded ?? 0) > 0 && e.src).length >= 1 &&
			timelineDistinctDecodedSrcs(timeline).size >= 2
		) {
			sawSecondSong = true;
		}
		if (sawSecondSong && s.attract) {
			// One more sample window, to lock in the terminal state.
			await sleep(SAMPLE_MS);
			timeline.push(/** @type {Sample} */ ({ ...(await tv.evaluate(probe)), wallMs: Date.now() - t0, relMono: 0 }));
			break;
		}
		await sleep(SAMPLE_MS);
	}

	const shot = join(artDir, 'tv-end.png');
	await tv.screenshot(shot);
	console.log(`\ncaptured ${timeline.length} samples over ~${Math.round((Date.now() - t0) / 1000)}s`);
	console.log(`TV frame: ${shot}`);

	analyze(timeline, { song1: readied1, song2: readied2, alice, bob });
	// Persist the timeline so a follow-up can dig deeper without re-driving the browser.
	writeFileSync(join(artDir, 'timeline.json'), JSON.stringify(timeline, null, 1));
	console.log(`timeline: ${join(artDir, 'timeline.json')}`);
} catch (err) {
	record(
		'CRITICAL',
		'PROBE-CRASH',
		'the probe itself blew up',
		String(/** @type {Error} */ (err)?.stack ?? err),
		'tests/e2e/probes/p1-gapless.mjs'
	);
} finally {
	browser?.close();
}


/** Distinct decoded-carrying src strings so far. @param {Sample[]} tl @returns {Set<string>} */
function timelineDistinctDecodedSrcs(tl) {
	const s = new Set();
	for (const row of tl) {
		for (const el of row.elems) {
			if ((el.decoded ?? 0) > 0 && el.src) s.add(el.src);
		}
	}
	return s;
}

/** Per-src: first sample with decoded>0, last where it climbed. @param {Sample[]} tl @param {(src: string) => boolean} srcMatch */
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

/** Every finding carries numbers a reviewer can re-derive from timeline.json. @param {Sample[]} tl @param {Ctx} ctx */
function analyze(tl, ctx) {
	if (tl.length === 0) {
		record('CRITICAL', 'P1-NO-SAMPLES', 'no timeline samples were collected', '', 'tests/e2e/probes/p1-gapless.mjs');
		return;
	}
	const { song1, song2 } = ctx;
	// playbackRef resolves to instrumentalRef, so an element's src is /media/<mediaId>-instrumental.wav.
	const isSong1 = (/** @type {string} */ src) =>
		src.includes(song1.id) || (song1.instrumentalRef ? src.includes(song1.instrumentalRef) : false);
	const isSong2 = (/** @type {string} */ src) =>
		src.includes(song2.id) || (song2.instrumentalRef ? src.includes(song2.instrumentalRef) : false);

	const w1 = decodingWindow(tl, isSong1);
	const w2 = decodingWindow(tl, isSong2);

	// Buffering alone gives a stuck element a non-zero decoded count, so "played" requires a CLIMB.
	const REAL_PLAYBACK_BYTES = 60_000; // preload of a decode-only WebAudio buffer is 8–24KB
	const w1Played = w1.peak >= REAL_PLAYBACK_BYTES;
	const w2Played = w2.peak >= REAL_PLAYBACK_BYTES;

	// F1: did song 1 ever produce sound at all?
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
	// F2: did song 2 actually play — the auto-advance question.
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

	// F3: the boundary — song 1's last decoded byte to song 2's first.
	if (w1.lastClimb >= 0 && w2.first >= 0) {
		const tEndA = tl[w1.lastClimb].wallMs;
		const tStartB = tl[w2.first].wallMs;
		const deltaMs = tStartB - tEndA;
		const deltaLabel = deltaMs >= 0 ? `${deltaMs}ms of GAP` : `${-deltaMs}ms of OVERLAP`;
		// The A/B swap is one composited frame with no network, so low tens of ms is the shape. Past
		// ~250ms is an audible dead-air seam; negative is double audio.
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

	// F4: double audio — do BOTH slots decode within one sample window?
	let simulRows = 0;
	let firstSimulT = -1;
	let maxSimul = 0;
	for (let i = 1; i < tl.length; i++) {
		const prev = tl[i - 1];
		const cur = tl[i];
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
		// Simultaneous decoding is the double-song bug only if it OUTLASTS one frame: a single row at the
		// boundary is sampling jitter (both counters moved between the same two reads). Flag by duration.
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

	// F5: the song-intro card appears, names the right singer, and dismisses on schedule.
	const upFrames = tl.map((r, i) => ({ i, r, up: r.upNext.visible && r.upNext.kind === 'next' ? r.upNext : null }));
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
			// Nominal 2500ms, ±SAMPLE_MS at each edge, so [~2300, ~2700] is on-nominal.
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

	// F5b: does audio play behind the intro card?
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

	// F6: did .ls-name change at the swap, and only then?
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

	// F7: last song ends — attract, or stranded?
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
			// A run cut short by OBSERVE_TIMEOUT must say so rather than cry wolf.
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

	// F8: the instrumental plays through <audio>, not <video>.
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

	// F9: does the hidden slot mount a pre-warm <audio> at all?
	// Two slots, one visible and one pre-warming upNext. Seeing only ONE <audio> ever means the hidden
	// slot has no media, so every swap costs the visible slot a cold load — the feature defeated.
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
	// Both slot divs may be mounted while their <audio> children are conditional, so count CO-EXISTENCE.
	if (maxAudioCount < 2 && w2.first >= 0) {
		// Song 2 played but the two <audio>s never coexisted, so there was no pre-warm buffer — which is
		// the mechanical cause of any seam F3 measures.
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

	// Any sample where one element carries song 1's src and another carries song 2's.
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

const bySev = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
for (const f of findings) bySev[f.sev] = (bySev[f.sev] ?? 0) + 1;
console.log(`\n── SUMMARY ──`);
console.log(`  CRITICAL: ${bySev.CRITICAL}   HIGH: ${bySev.HIGH}   MEDIUM: ${bySev.MEDIUM}   LOW: ${bySev.LOW}`);
console.log(`  ${findings.length} findings total (see per-finding blocks above).`);
console.log(`  artifacts: ${artDir}`);
process.exit(bySev.CRITICAL + bySev.HIGH > 0 ? 1 : 0);
