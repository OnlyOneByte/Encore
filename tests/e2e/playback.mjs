/*
 * Does a sound actually come out? — the assertion this suite never made.
 *
 * Every other e2e here stops at the DOM: it proves a song is queued, a lower third names a singer, a
 * state class flipped. None of that touches the one thing a karaoke machine is for. The gap was
 * structural, not an oversight — the seeder writes 16-byte placeholders and says in its own header
 * that they are "NOT enough to decode", so there was no audio in the fixture to assert about. ./wav.mjs
 * and ./fake-stems-worker.mjs close that, and this file spends it.
 *
 * WHAT COUNTS AS PROOF. `paused === false` is not proof; a media element reports that while it sits at
 * currentTime 0 forever behind a failed decode. `readyState === 4` is not proof either; it says bytes
 * arrived. The proof is `webkitAudioDecodedByteCount` CLIMBING — the decoder consumed samples and
 * handed them to the audio pipeline — corroborated by currentTime advancing against the wall clock.
 * That distinction is exactly the FLAC-in-a-<video> defect: valid file, element "playing", zero
 * decoded bytes, silent room.
 *
 *   EPORT=5210 bun tests/e2e/playback.mjs
 *
 * Exit 0 all passed · 1 a real failure · 2 the environment could not host the test (no server,
 * no Chromium, empty library) — never conflated with a failure, because a skipped audio test that
 * reports green is how this hole stayed open.
 */
import { join } from 'node:path';
import { connect, sleep } from './driver.mjs';
import { SEL } from './contract.ts';
import { findChromium } from './lib/chromium.mjs';
import { openBrowseFromHome, returnHomeFromBrowse } from './lib/phone.mjs';

/**
 * Types for this out-of-program driver (pattern). Browser/Page derive from
 * driver.mjs's return types so they cannot drift; page.evaluate() is Promise<any>, cast at the call site.
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {{ name: string, ok: boolean }} Check
 *
 * One media element reading the `probe` evaluate returns.
 * @typedef {{
 *   i: number, tag: string, src: string, readyState: number, paused: boolean, muted: boolean,
 *   volume: number, currentTime: number, duration: number, decoded: number | null,
 *   videoDecoded: number | null, error: { code: number, message: string } | null, display: string
 * }} El
 */

const PORT = process.env.EPORT ?? '3000';
const base = `http://127.0.0.1:${PORT}`;

/** @type {Check[]} */
const checks = [];
/** @param {string} name @param {unknown} ok @param {string} [detail] */
function check(name, ok, detail = '') {
	checks.push({ name, ok: !!ok });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}
/** @param {string} msg @returns {never} */
function bail(msg) {
	console.error(`\nENVIRONMENT: ${msg}`);
	process.exit(2);
}

const chromium = findChromium();
if (!chromium) bail('no Chromium found. Set PW_CHROMIUM.');
if (!(await fetch(`${base}/health`).catch(() => null))?.ok) {
	bail(`no Encore server on ${base}. Start one and re-run.`);
}

// A song that can actually be sung has to exist before this test means anything.
const ready = await fetch(`${base}/api/search?q=caroline`)
	.then((r) => r.json())
	.then((d) => d.ready ?? []);
if (!ready.length) {
	bail(
		'no READY song in the library — nothing to play.\n' +
			'  Seed + process one first:  bun run e2e:seed  &&  bun tests/e2e/fake-stems-worker.mjs  (then POST /api/process)'
	);
}
console.log(`fixture: "${ready[0].title}" → ${ready[0].instrumentalRef}\n`);



/** @type {Browser | undefined} */
let browser;
try {
	browser = await connect();

	// ── a singer joins and queues the processed song, through the real UI ──────────
	const phone = await browser.newPage();
	await phone.viewport(390, 844);
	await phone.goto(`${base}/`);
	await phone.fill(SEL.nameInput, `Singer${Date.now() % 100000}`);
	await phone.clickByText('Start singing');
	await phone.waitFor(`location.pathname === '/'`);
	await openBrowseFromHome(phone);
	check('a singer can join and reach the remote', true);

	await openBrowseFromHome(phone); // search lives behind the browse push
	await phone.fill(SEL.search, 'caroline');
	await phone.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length > 0`);
	// A ready song offers "add" (queue it now); a raw one offers "sing" (queue + process).
	const hasAdd = await phone.count(SEL.addTurn);
	check('the processed song offers a queue action', hasAdd > 0, `found ${hasAdd} .add buttons`);
	await phone.click(hasAdd > 0 ? SEL.addTurn : SEL.sing);
	await returnHomeFromBrowse(phone); // the rotation is on home
	await phone.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length > 0`);
	check('the song lands in the queue', true);

	// ── the TV ─────────────────────────────────────────────────────────────────
	const tv = await browser.newPage();
	await tv.viewport(1920, 1080, 1);
	await tv.goto(`${base}/tv`);

	// Read whatever media elements the stage mounted, without assuming which tag or how many: the
	// master has been a <video> and is now a hidden <audio>, and the guiding track adds a second.
	const probe = `(() => {
		const els = [...document.querySelectorAll('video,audio')];
		return els.map((el, i) => ({
			i, tag: el.tagName, src: el.currentSrc || el.src || '',
			readyState: el.readyState, paused: el.paused, muted: el.muted, volume: el.volume,
			currentTime: el.currentTime, duration: el.duration,
			decoded: el.webkitAudioDecodedByteCount ?? null,
			videoDecoded: el.webkitVideoDecodedByteCount ?? null,
			error: el.error ? { code: el.error.code, message: el.error.message } : null,
			display: getComputedStyle(el).display
		}));
	})()`;

	// Playback must begin with NO gesture on the TV. Poll for a master that has a src at all.
	/** @type {El[]} */
	let els = [];
	try {
		els = /** @type {El[]} */ (
			await tv.waitFor(
				`(() => { const e=[...document.querySelectorAll('video,audio')].filter(x=>x.currentSrc||x.src); return e.length ? ${probe} : null; })()`,
				{ timeout: 25000 }
			)
		);
	} catch {
		els = /** @type {El[]} */ (await tv.evaluate(probe));
	}
	check(
		'the TV mounts a media element with a source, unprompted',
		els.some((e) => e.src),
		`elements: ${JSON.stringify(els)}`
	);

	const master = els.find((e) => e.src.includes('instrumental')) ?? els.find((e) => e.src) ?? null;
	if (!master) {
		check('a master element carries the instrumental', false, JSON.stringify(els));
	} else {
		check('a master element carries the instrumental', master.src.includes('instrumental'), `src=${master.src}`);
		// The FLAC-in-a-<video> defect: an audio-only instrumental in a <video> decodes nothing on
		// WebKit. The element that plays the instrumental should be an <audio>.
		check(
			'the instrumental plays through an <audio>, not a <video>',
			master.tag === 'AUDIO',
			`the master is a <${master.tag.toLowerCase()}> — WebKit documents FLAC for <audio> only, so a valid file decodes silence here`
		);
		check('the master reports no media error', master.error === null, JSON.stringify(master.error));
	}

	// ── the assertion that matters: decoded bytes climbing ─────────────────────
	const t0 = /** @type {El[]} */ (await tv.evaluate(probe));
	await sleep(3000);
	const t1 = /** @type {El[]} */ (await tv.evaluate(probe));
	/** @param {El[]} set */
	const pick = (set) => set.find((e) => e.src.includes('instrumental')) ?? set.find((e) => e.src);
	const a = pick(t0);
	const b = pick(t1);

	if (!a || !b) {
		check('AUDIO IS DECODING (bytes consumed by the decoder)', false, 'no element with a source to measure');
	} else {
		const dDecoded = (b.decoded ?? 0) - (a.decoded ?? 0);
		const dTime = b.currentTime - a.currentTime;
		check(
			'AUDIO IS DECODING (decoded byte count climbing)',
			dDecoded > 0,
			`decoded went ${a.decoded} → ${b.decoded} (+${dDecoded}) over 3s. Zero means the element ` +
				`is "playing" a file it cannot decode — the room hears nothing.`
		);
		check(
			'the playhead advances against the wall clock',
			dTime > 1.5,
			`currentTime went ${a.currentTime.toFixed(2)} → ${b.currentTime.toFixed(2)} (+${dTime.toFixed(2)}s) over 3s`
		);
		check('the master is not paused while the room is playing', b.paused === false, `paused=${b.paused}`);
		check(
			'the master is audible (not muted, volume > 0)',
			b.muted === false && b.volume > 0,
			`muted=${b.muted} volume=${b.volume}`
		);
	}

	// ── transport: pause must hold position, not reload to zero ────────────────
	const before = pick(/** @type {El[]} */ (await tv.evaluate(probe)));
	await phone.clickByLabel('play/pause');
	await sleep(1200);
	const paused = pick(/** @type {El[]} */ (await tv.evaluate(probe)));
	check('pause actually pauses the master element', paused?.paused === true, `paused=${paused?.paused}`);
	check(
		'pause holds the playhead instead of resetting it',
		before && paused && paused.currentTime > 0.5 && Math.abs(paused.currentTime - before.currentTime) < 2.5,
		`was ${before?.currentTime?.toFixed(2)}s, after pause ${paused?.currentTime?.toFixed(2)}s — a jump to 0 is the reload bug`
	);

	await phone.clickByLabel('play/pause');
	await sleep(2000);
	const resumed = pick(/** @type {El[]} */ (await tv.evaluate(probe)));
	check(
		'resume starts decoding again',
		resumed && !resumed.paused && (resumed.decoded ?? 0) > (paused?.decoded ?? 0),
		JSON.stringify(resumed)
	);
	check(
		'resume continues from where it paused, not from the top',
		resumed && resumed.currentTime >= (paused?.currentTime ?? 0) - 0.5,
		`paused at ${paused?.currentTime?.toFixed(2)}s, resumed at ${resumed?.currentTime?.toFixed(2)}s`
	);

	const shot = join(process.env.KIROCREW_SCRATCH ?? '/tmp', 'tv-playing.png');
	await tv.screenshot(shot);
	console.log(`\nTV frame: ${shot}`);
	console.log('final element state:', JSON.stringify(await tv.evaluate(probe), null, 1));
} catch (err) {
	check('the flow ran to completion', false, String(err instanceof Error ? err.stack : err));
} finally {
	browser?.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
	console.log('failed:');
	for (const f of failed) console.log(`  - ${f.name}`);
}
process.exit(failed.length ? 1 : 0);
