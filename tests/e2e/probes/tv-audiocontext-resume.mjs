/*
 * Diagnostic: does the TV's AudioContext ever RESUME, with no gesture in the room?
 *
 * Why this exists. A probe measured the pitch shifter's maths as correct (per-partial ratio 1.1236
 * against a theoretical 1.1225 at +2 semitones) while the owner reports the ± buttons doing nothing at
 * a real party. Both can be true: the shifter is documented to degrade to
 * audible-but-unshifted-never-silent when its context cannot run, and /tv has no gesture handler, so a
 * set-and-forget television may never hand the page the user gesture resume() requires.
 *
 * The earlier probe launched Chromium with --autoplay-policy=no-user-gesture-required, which grants
 * exactly the permission a real TV lacks — so it would have masked this. This run compares the two
 * policies side by side and reports the AudioContext state under each. It changes no code.
 *
 * Reading the result:
 *   GESTURELESS ctx.state === 'suspended'  → confirms hypothesis 1. The fix is a gesture affordance on
 *                                            /tv, NOT a change to the shifter.
 *   GESTURELESS ctx absent while shift > 0 → the graph never built; look at `active` (hypothesis 2).
 *   GESTURELESS ctx.state === 'running'    → the context is fine and the cause is elsewhere (3).
 *
 *   EPORT=<port> bun e2e/probes/tv-audiocontext-resume.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { connect, sleep } from '../cdp.mjs';
import { openBrowseFromHome } from '../lib/phone.mjs';
import { SEL } from '../contract.ts';

const PORT = process.env.EPORT ?? '3000';
const base = `http://127.0.0.1:${PORT}`;

const chrome = [
	pathJoin(homedir(), '.cache/ms-playwright/chromium-1232/chrome-linux/chrome'),
	pathJoin(homedir(), '.cache/ms-playwright/chromium-1228/chrome-linux/chrome')
].find(existsSync);
if (!chrome) {
	console.error('no chromium');
	process.exit(2);
}
/** @type {string} the guard above narrows `chrome`; capture it so the nested runUnder() closure keeps the narrowing */
const chromeBin = chrome;

const ready = await fetch(`${base}/api/search?q=sweet`)
	.then((r) => r.json())
	.then((d) => d.ready ?? []);
if (!ready.length) {
	console.error('need a processed song');
	process.exit(2);
}

/**
 * Instrument the page BEFORE it runs any script, so every AudioContext the app constructs is
 * recorded. Reading `.state` after the fact cannot tell you whether one was ever created.
 */
const HOOK = `(() => {
  window.__ctx = [];
  for (const K of ['AudioContext', 'webkitAudioContext']) {
    const Orig = window[K];
    if (!Orig) continue;
    window[K] = class extends Orig {
      constructor(...a) { super(...a); window.__ctx.push(this); }
    };
  }
})()`;

const READ = `(() => {
  const els = [...document.querySelectorAll('audio,video')];
  const live = els.find((e) => !e.paused && e.currentTime > 0.05) ?? els[0] ?? null;
  return {
    contexts: (window.__ctx ?? []).length,
    states: (window.__ctx ?? []).map((c) => c.state),
    audible: live ? { paused: live.paused, t: +live.currentTime.toFixed(2), decoded: live.webkitAudioDecodedByteCount ?? null } : null,
    keyLabel: (document.querySelector(${JSON.stringify(SEL.keyLabel)})?.textContent ?? '').trim()
  };
})()`;

/** @param {string} label @param {string[]} extraFlags @param {number} cdpPort */
async function runUnder(label, extraFlags, cdpPort) {
	const proc = spawn(
		chromeBin,
		[
			`--remote-debugging-port=${cdpPort}`,
			'--headless=new',
			'--no-sandbox',
			'--disable-gpu',
			'--no-first-run',
			`--user-data-dir=${process.env.KIROCREW_SCRATCH ?? '/tmp'}/tv-actx-${cdpPort}`,
			...extraFlags,
			'about:blank'
		],
		{ stdio: 'ignore' }
	);

	/** @type {Awaited<ReturnType<typeof connect>> | undefined} */
	let browser;
	try {
		browser = await connect(cdpPort);

		// Queue a song through the REAL phone UI first. A hand-rolled WS frame with an invented
		// singerId is rejected, which leaves the TV on the lobby with no media element — and then the
		// absence of an AudioContext proves nothing at all about the shifter.
		const phone = await browser.newPage();
		await phone.viewport(390, 844);
		await phone.goto(`${base}/join`);
		await phone.fill(SEL.nameInput, `T17-${cdpPort}-${Date.now() % 10000}`);
		await phone.clickByText('Start singing');
		await phone.waitFor(`location.pathname === '/'`);
		await openBrowseFromHome(phone);
		await phone.fill(SEL.search, 'sweet');
		await phone.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.addTurn)}).length > 0`);
		await phone.click(SEL.addTurn);
		await sleep(800);

		const tv = await browser.newPage();
		await tv.viewport(1920, 1080, 1);
		// Install the hook before app script runs.
		await tv.evaluate(`(${JSON.stringify(HOOK)}, 0)`).catch(() => {});
		await tv.goto(`${base}/tv`);
		await tv.evaluate(HOOK); // idempotent; also covers the post-navigation context
		// Wait for a media element to actually exist, so a null reading means "no context" and not
		// "nothing was playing".
		await tv
			.waitFor(`[...document.querySelectorAll('audio,video')].some(e => e.currentSrc || e.src)`, { timeout: 20000 })
			.catch(() => {});
		await sleep(2000);

		const before = await tv.evaluate(READ);

		// Ask for a non-zero shift the way a phone does, then give the graph time to build.
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?role=phone`);
		await new Promise((r) => {
			ws.onopen = r;
			ws.onerror = r;
		});
		ws.send(JSON.stringify({ type: 'player:command', command: { cmd: 'key', semitones: 2 } }));
		await sleep(3500);
		const after = await tv.evaluate(READ);
		ws.close();

		console.log(`\n── ${label} ──`);
		console.log(
			`  before shift: contexts=${before.contexts} states=${JSON.stringify(before.states)} audible=${JSON.stringify(before.audible)}`
		);
		console.log(
			`  after  shift: contexts=${after.contexts} states=${JSON.stringify(after.states)} keyLabel="${after.keyLabel}"`
		);
		console.log(`                audible=${JSON.stringify(after.audible)}`);
		return after;
	} finally {
		browser?.close();
		proc.kill();
	}
}

// The real living room: no autoplay grant, no gesture.
const gestureless = await runUnder('GESTURELESS (what a real TV is)', [], 9401);
// The earlier probe's environment, for contrast.
const granted = await runUnder(
	'AUTOPLAY GRANTED (what the earlier probe measured)',
	['--autoplay-policy=no-user-gesture-required'],
	9402
);

console.log('\n════════ VERDICT ════════');
const g = gestureless;
if (g.contexts === 0) {
	console.log('No AudioContext was ever constructed under a shift of +2.');
	console.log('→ hypothesis 2/3: the graph never built. Look at `active` for the audible slot.');
} else if (g.states.every((/** @type {string} */ s) => s === 'suspended')) {
	console.log('AudioContext exists and is SUSPENDED with no gesture available.');
	console.log('→ CONFIRMS hypothesis 1: audio plays UNSHIFTED and the ± buttons appear dead.');
	console.log('→ The fix is a gesture affordance on /tv, NOT a change to the shifter.');
} else if (g.states.includes('running')) {
	console.log('AudioContext is RUNNING even with no gesture — the context is not the cause.');
	console.log('→ hypothesis 3: setShift is not reaching the worklet ratio. Investigate there.');
}
console.log(`(for contrast, autoplay-granted states: ${JSON.stringify(granted.states)})`);
