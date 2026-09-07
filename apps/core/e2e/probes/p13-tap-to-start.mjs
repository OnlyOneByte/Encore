/*
 * P13 - TAP TO START: the one route out of a silent television, gestureless.
 *
 * #64 shipped the recovery for a TV that autoplay blocked: TvPlayer.svelte arms a document-wide
 * pointerdown/keydown listener and routes/tv/+page.svelte renders a full-screen .autoplay-hint
 * card telling the viewer to tap. That listener is the ONLY path from a fresh TV to audible sound.
 * HARNESS.md and fuzz.mjs are both correct that granting --autoplay-policy=no-user-gesture-required
 * measures an environment no television is in. Every click verb in cdp.mjs is a synthetic el.click()
 * via Runtime.evaluate, an UNTRUSTED event granting NO user activation, so it cannot unblock autoplay.
 *
 *   EPORT=5213 bun apps/core/e2e/probes/p13-tap-to-start.mjs
 *
 * Exit 0 all passed / 1 a real failure / 2 the environment could not host the test.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect, sleep } from '../cdp.mjs';
import { SEL } from '../contract.ts';

const PORT = process.env.EPORT ?? '3000';
const base = 'http://127.0.0.1:' + PORT;
const CDP_PORT = Number(process.env.CDP_PORT ?? 9347);
const SCRATCH = process.env.E2E_SCRATCH ?? '/tmp';

const checks = [];
function check(name, ok, detail) {
	detail = detail || '';
	checks.push({ name, ok: !!ok });
	console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok || !detail ? '' : '\n        ' + detail));
}
function bail(msg) {
	console.error('\nENVIRONMENT: ' + msg);
	process.exit(2);
}

function findChromium() {
	if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
	const cache = join(homedir(), '.cache', 'ms-playwright');
	for (const b of ['chromium-1232', 'chromium-1228']) {
		const p = join(cache, b, 'chrome-linux', 'chrome');
		if (existsSync(p)) return p;
	}
	for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
		if (existsSync(p)) return p;
	}
	return null;
}

const chromium = findChromium();
if (!chromium) bail('no Chromium found. Set PW_CHROMIUM.');
if (!(await fetch(base + '/health').catch(() => null))?.ok) {
	bail('no Encore server on ' + base + '. Start one (ephemeral + fake-stems-worker + a cooked song) and re-run.');
}

// A song that can actually be sung has to exist before this test means anything.
const ready = await fetch(base + '/api/search?q=caroline')
	.then((r) => r.json())
	.then((d) => d.ready ?? []);
if (!ready.length) {
	bail('no READY song in the library - seed + cook one first (bun run e2e:seed && bun e2e/fake-stems-worker.mjs).');
}
console.log('fixture: "' + ready[0].title + '" -> ' + ready[0].instrumentalRef + '\n');

const proc = spawn(
	chromium,
	[
		'--remote-debugging-port=' + CDP_PORT,
		'--headless=new',
		'--no-sandbox',
		'--disable-gpu',
		'--no-first-run',
		'--user-data-dir=' + join(SCRATCH, 'encore-tap2start-' + process.pid),
		// DELIBERATELY NO --autoplay-policy flag: this is a real TV, with the restriction the living
		// room actually has. The point is that the room stays silent until a trusted gesture arrives.
		'about:blank'
	],
	{ stdio: 'ignore' }
);

let browser;
try {
	browser = await connect(CDP_PORT);

	// -- a singer joins and queues the cooked song, through the real UI --
	const phone = await browser.newPage();
	await phone.viewport(390, 844);
	await phone.goto(base + '/join');
	await phone.fill(SEL.nameInput, 'Singer' + (Date.now() % 100000));
	await phone.clickByText('Start singing');
	await phone.waitFor('document.querySelector(' + JSON.stringify(SEL.search) + ') !== null');

	await phone.fill(SEL.search, 'caroline');
	await phone.waitFor('document.querySelectorAll(' + JSON.stringify(SEL.songRow) + ').length > 0');
	const hasAdd = await phone.count(SEL.addTurn);
	await phone.click(hasAdd > 0 ? SEL.addTurn : SEL.sing);
	await phone.waitFor('document.querySelectorAll(' + JSON.stringify(SEL.queueRow) + ').length > 0');
	check('a singer can join and queue the cooked song', true);

	// -- the TV, gestureless --
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

	// Wait until the master element has a source, so a null reading means "no media" not "not yet".
	try {
		await tv.waitFor(
			`(() => { const e=[...document.querySelectorAll('video,audio')].filter(x=>x.currentSrc||x.src); return e.length > 0; })()`,
			{ timeout: 25000 }
		);
	} catch {}
	await sleep(2000);

	// -- STEP 1: the blocked state a real TV sits in --
	const blocked = await tv.evaluate(probe);
	check(
		'the tap-to-start hint is rendered before any gesture',
		blocked.hint === true,
		`hint=${blocked.hint} - the .autoplay-hint card is the #64 affordance; without it there is no route out of silence`
	);
	check(
		'the master is stalled at the preload floor before any gesture (paused, t=0, some decoded bytes)',
		blocked.master && blocked.master.paused === true && blocked.master.currentTime === 0 && (blocked.master.decoded ?? 0) > 0,
		`master=${JSON.stringify(blocked.master)} - gestureless it must NOT be playing`
	);

	// -- STEP 2: one REAL tap, then decoded must strictly climb --
	// A synthetic click() here would grant no user activation and leave decoded flat; realClick
	// delivers a trusted CDP Input gesture - the only thing the browser honors to unblock autoplay.
	await tv.realClick(960, 540);

	const a = (await tv.evaluate(probe)).master;
	await sleep(3000);
	const b = (await tv.evaluate(probe)).master;

	if (!a || !b) {
		check('AUDIO IS DECODING after the tap (decoded byte count climbing)', false, 'no master element with a source to measure');
	} else {
		const dDecoded = (b.decoded ?? 0) - (a.decoded ?? 0);
		const dTime = b.currentTime - a.currentTime;
		check(
			'a single real tap unblocks autoplay - decoded byte count climbs',
			dDecoded > 0,
			`decoded went ${a.decoded} -> ${b.decoded} (+${dDecoded}) over 3s. Zero means the trusted gesture ` +
				`never reached the #64 listener - a real TV stays permanently silent.`
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
			'the #64 recovery clears the card only after autoplay actually recovers'
		);
	}
} catch (err) {
	check('the flow ran to completion', false, String(err?.stack ?? err));
} finally {
	browser?.close();
	proc.kill();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
	console.log('failed:');
	for (const f of failed) console.log(`  - ${f.name}`);
}
process.exit(failed.length ? 1 : 0);
