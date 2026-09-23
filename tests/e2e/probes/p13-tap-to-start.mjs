// P13 — TAP TO START, the one route out of a silent television, driven GESTURELESSLY: a document-wide
// pointerdown/keydown listener plus the full-screen card are the only path from a fresh TV to audible
// sound. Granting autoplay would measure an environment no television is in (docs/E2E.md#autoplay), and
// a synthetic click grants no user activation, so only `realClick` can unblock it (docs/E2E.md#gestures).
//
//   EPORT=5213 bun tests/e2e/probes/p13-tap-to-start.mjs

import { connect, sleep } from '../driver.mjs';
import { SEL } from '../contract.ts';
import { findChromium } from '../lib/chromium.mjs';
import { openBrowseFromHome } from '../lib/phone.mjs';
import { openJoin } from '../lib/join.mjs';

/**
 * Browser/Page derive from driver.mjs so they cannot drift; page.evaluate() is Promise<any>, cast at use.
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {{ name: string, ok: boolean }} Check
 */

const PORT = process.env.EPORT ?? '3000';
const base = 'http://127.0.0.1:' + PORT;

/** @type {Check[]} */
const checks = [];
/** @param {string} name @param {unknown} ok @param {string} [detail] */
function check(name, ok, detail) {
	detail = detail || '';
	checks.push({ name, ok: !!ok });
	console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok || !detail ? '' : '\n        ' + detail));
}
/** @param {string} msg @returns {never} */
function bail(msg) {
	console.error('\nENVIRONMENT: ' + msg);
	process.exit(2);
}

const chromium = findChromium();
if (!chromium) bail('no Chromium found. Set PW_CHROMIUM.');
if (!(await fetch(base + '/health').catch(() => null))?.ok) {
	bail('no Encore server on ' + base + '. Start one (ephemeral + fake-stems-worker + a processed song) and re-run.');
}

const ready = await fetch(base + '/api/search?q=caroline')
	.then((r) => r.json())
	.then((d) => d.ready ?? []);
if (!ready.length) {
	bail(
		'no READY song in the library - seed + process one first (bun run e2e:seed && bun tests/e2e/fake-stems-worker.mjs).'
	);
}
console.log('fixture: "' + ready[0].title + '" -> ' + ready[0].instrumentalRef + '\n');

/** @type {Browser | undefined} */
let browser;
try {
	browser = await connect();

	const phone = await browser.newPage();
	await phone.viewport(390, 844);
	await openJoin(phone, base);
	await phone.fill(SEL.nameInput, 'Singer' + (Date.now() % 100000));
	await phone.clickByRole('button', 'Start singing');
	await phone.waitFor("location.pathname === '/'");
	await openBrowseFromHome(phone);

	await phone.fill(SEL.search, 'caroline');
	await phone.waitFor('document.querySelectorAll(' + JSON.stringify(SEL.songRow) + ').length > 0');
	const hasAdd = await phone.count(SEL.addTurn);
	await phone.click(hasAdd > 0 ? SEL.addTurn : SEL.sing);
	await phone.waitFor('document.querySelectorAll(' + JSON.stringify(SEL.queueRow) + ').length > 0');
	check('a singer can join and queue the processed song', true);

	const tv = await browser.newPage();
	await tv.viewport(1920, 1080, 1);
	await tv.goto(base + '/tv');

	const probe = `(() => {
		const els = [...document.querySelectorAll('video,audio')];
		const master = els.find((e) => (e.currentSrc || e.src || '').includes('instrumental')) ?? els.find((e) => e.currentSrc || e.src) ?? null;
		return {
			hint: !!document.querySelector(${JSON.stringify(SEL.autoplayHint)}),
			master: master ? {
				paused: master.paused,
				currentTime: +master.currentTime.toFixed(2),
				decoded: master.webkitAudioDecodedByteCount ?? null,
				src: master.currentSrc || master.src || ''
			} : null
		};
	})()`;

	// So a null reading below means "no media" rather than "not yet".
	try {
		await tv.waitFor(
			`(() => { const e=[...document.querySelectorAll('video,audio')].filter(x=>x.currentSrc||x.src); return e.length > 0; })()`,
			{ timeout: 25000 }
		);
	} catch {
		/* best-effort cleanup */
	}
	await sleep(2000);

	// The blocked state a real TV sits in.
	const blocked = await tv.evaluate(probe);
	check(
		'the tap-to-start hint is rendered before any gesture',
		blocked.hint === true,
		`hint=${blocked.hint} - the .autoplay-hint card is the tap-to-start affordance; without it there is no route out of silence`
	);
	check(
		'the master is stalled at the preload floor before any gesture (paused, t=0, some decoded bytes)',
		blocked.master &&
			blocked.master.paused === true &&
			blocked.master.currentTime === 0 &&
			(blocked.master.decoded ?? 0) > 0,
		`master=${JSON.stringify(blocked.master)} - gestureless it must NOT be playing`
	);

	// One REAL tap: a synthetic click() grants no user activation and leaves decoded bytes flat.
	await tv.realClick(960, 540);

	const a = (await tv.evaluate(probe)).master;
	await sleep(3000);
	const b = (await tv.evaluate(probe)).master;

	if (!a || !b) {
		check(
			'AUDIO IS DECODING after the tap (decoded byte count climbing)',
			false,
			'no master element with a source to measure'
		);
	} else {
		const dDecoded = (b.decoded ?? 0) - (a.decoded ?? 0);
		const dTime = b.currentTime - a.currentTime;
		check(
			'a single real tap unblocks autoplay - decoded byte count climbs',
			dDecoded > 0,
			`decoded went ${a.decoded} -> ${b.decoded} (+${dDecoded}) over 3s. Zero means the trusted gesture ` +
				`never reached the document-wide gesture listener - a real TV stays permanently silent.`
		);
		check(
			'the playhead advances against the wall clock after the tap',
			dTime > 1.5,
			`currentTime went ${a.currentTime.toFixed(2)} -> ${b.currentTime.toFixed(2)} (+${dTime.toFixed(2)}s) over 3s`
		);
		check('the master is no longer paused after the tap', b.paused === false, `paused=${b.paused}`);
		check(
			'the tap-to-start hint clears once audio is genuinely playing',
			(await tv.evaluate(probe)).hint === false,
			'the tap-to-start recovery clears the card only after autoplay actually recovers'
		);
	}
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
