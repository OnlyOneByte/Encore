// THE TAP-TO-START SCRIM MUST NOT OUTLIVE THE ROOM: the autoplay-blocked latch's only two writers are
// per-slot props, so when the room DRAINS both players unmount, neither can fire again, and a scrim gated
// on that latch alone covers the lobby of an EMPTY room above its own join QR. Only a rendered rung can
// see it — the claim is which element is topmost at the join card's centre, and there is no jsdom here;
// `tests/guards/subsystem-tv/autoplay-recovery.test.ts` is the source-scan half.
//
// GESTURELESS BY CONSTRUCTION — no autoplay flag below, which is the premise and not an omission: a
// never-tapped TV is the only TV that reaches this state, and neither input that gets here is a tap.
//
//   EPORT=5362 bun tests/e2e/probes/tv-scrim-empty-lobby.mjs

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { connect, sleep } from '../driver.mjs';
import { SEL } from '../contract.ts';
import { findChromium } from '../lib/chromium.mjs';
import { openBrowseFromHome, returnHomeFromBrowse } from '../lib/phone.mjs';
import { openJoin } from '../lib/join.mjs';

/**
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {{ name: string, ok: boolean }} Check
 */

const PORT = process.env.EPORT ?? '3000';
const base = 'http://127.0.0.1:' + PORT;
const SCRATCH = process.env.E2E_SCRATCH ?? '/tmp';
const SHOTS = join(SCRATCH, 'shots-tv-scrim-empty-lobby');

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

// A phone-side socket in BOTH directions: the server rejects a player:command from a non-joined session,
// so the skip must ride the joined phone's origin, and recording the frames is what lets the drain be
// asserted against the SERVER rather than only against what the TV drew.
/** @param {Page} phone */
async function ensureProbeWs(phone) {
	await phone.evaluate(`
		(async () => {
			if (window.probeWs && window.probeWs.readyState === 1) return;
			const ws = new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws?role=phone');
			window.__srv = { entries: null, playback: null };
			ws.onmessage = (ev) => {
				let m; try { m = JSON.parse(ev.data); } catch { return; }
				if (m.type === 'queue:sync') { window.__srv.entries = m.entries; if (m.playback) window.__srv.playback = m.playback; }
				if (m.type === 'playback:state') { window.__srv.playback = m.state; }
			};
			await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('probeWs open failed')); });
			window.probeWs = ws;
		})()
	`);
}
/** @param {Page} phone @param {Record<string, unknown>} command */
async function sendPlayer(phone, command) {
	await ensureProbeWs(phone);
	await phone.evaluate(
		`window.probeWs.send(JSON.stringify({ type: 'player:command', command: ${JSON.stringify(command)} }))`
	);
}

const chromium = findChromium();
if (!chromium) bail('no Chromium found. Set PW_CHROMIUM.');
if (!(await fetch(base + '/health').catch(() => null))?.ok) {
	bail('no Encore server on ' + base + '. Start one (ephemeral + fake-stems-worker + a processed song) and re-run.');
}
const ready = await fetch(base + '/api/search?q=caroline')
	.then((r) => r.json())
	.then((d) => d.ready ?? []);
if (!ready.length) bail('no READY song in the library — seed + process one first.');
console.log('fixture: "' + ready[0].title + '" -> ' + ready[0].instrumentalRef + '\n');

mkdirSync(SHOTS, { recursive: true });

// ONE reading, taken identically at every step so before/after is apples-to-apples. `topAtJoinCard` —
// elementFromPoint at the join card's centre — is the load-bearing one, because the guest-visible
// question is whether somebody walking up can read and use the join affordance.
const probe = `(() => {
	const q = (s) => document.querySelector(s);
	const hintEl = q(${JSON.stringify(SEL.autoplayHint)});
	// The affordance is the QR + address, or the operator notice that replaces it on an unroutable origin.
	const card = q(${JSON.stringify(SEL.lobbyUrl)}) ?? q(${JSON.stringify(SEL.badQr)});
	let top = null, topIsCard = null, rect = null;
	if (card) {
		const r = card.getBoundingClientRect();
		rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
		const el = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
		top = el ? (el.className && el.className.toString ? el.className.toString() : el.tagName) : null;
		topIsCard = !!el && (el === card || card.contains(el) || el.contains(card));
	}
	const media = [...document.querySelectorAll(${JSON.stringify(SEL.mediaEl)})];
	const cs = hintEl ? getComputedStyle(hintEl) : null;
	return {
		hint: !!hintEl,
		hintStyle: cs ? { position: cs.position, zIndex: cs.zIndex, inset: cs.inset, bg: cs.backgroundColor, pe: cs.pointerEvents } : null,
		lobby: !!q(${JSON.stringify(SEL.lobby)}),
		card: !!card, cardRect: rect, topAtJoinCard: top, joinCardReachable: topIsCard,
		mediaCount: media.length
	};
})()`;

/** @type {Browser | undefined} */
let browser;
try {
	browser = await connect();

	const phone = await browser.newPage();
	await phone.viewport(390, 844);
	await openJoin(phone, base);
	await phone.fill(SEL.nameInput, 'Scrim' + (Date.now() % 100000));
	await phone.clickByRole('button', 'Start singing');
	await phone.waitFor(`location.pathname === '/'`);
	await openBrowseFromHome(phone);
	await ensureProbeWs(phone);

	await openBrowseFromHome(phone); // search lives behind the browse push
	await phone.fill(SEL.search, 'caroline');
	await phone.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length > 0`);
	const hasAdd = await phone.count(SEL.addTurn);
	await phone.click(hasAdd > 0 ? SEL.addTurn : SEL.sing);
	// Back to the queue BEFORE counting rows: the rotation is not rendered in the results view at all.
	await returnHomeFromBrowse(phone);
	await phone.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length > 0`);
	check('a singer joins and queues the processed song — one entry, nothing behind it', true);


	const tv = await browser.newPage();
	await tv.viewport(1920, 1080, 1);
	await tv.goto(base + '/tv');
	try {
		await tv.waitFor(
			`(() => { const e=[...document.querySelectorAll(${JSON.stringify(SEL.mediaEl)})].filter(x=>x.currentSrc||x.src); return e.length > 0; })()`,
			{ timeout: 25000 }
		);
	} catch {
		// Swallowed on purpose: a timeout here must red the named blocked-state check, not abort the flow.
	}
	await sleep(2000);

	// The CORRECT pre-drain state: a song is on stage and the TV cannot start it.
	const blocked = await tv.evaluate(probe);
	await tv.screenshot(join(SHOTS, '01-blocked-with-a-song-on-stage.png'));
	check(
		'BEFORE the drain the hint is up — the block is real and correctly announced',
		blocked.hint === true,
		`hint=${blocked.hint} style=${JSON.stringify(blocked.hintStyle)} — without this the rest of the run proves nothing`
	);

	// Skip at the last entry — the drain, and the second of the two inputs that reach this state.
	await sendPlayer(phone, { cmd: 'skip' });
	// The SERVER's own report of the drain, not the TV's.
	await phone.waitFor(
		`(() => { const s = window.__srv; return !!s && !!s.playback && s.playback.currentEntryId === null && s.playback.isPlaying === false; })()`,
		{ timeout: 15000 }
	);
	const srv = await phone.evaluate(`JSON.stringify(window.__srv.playback)`);
	console.log('\nserver after skip-at-last-entry: ' + srv + '\n');
	await tv.waitFor(
		`(() => document.querySelector(${JSON.stringify(SEL.lobby)}) !== null && document.querySelectorAll(${JSON.stringify(SEL.mediaEl)}).length === 0)()`,
		{ timeout: 15000 }
	);
	await sleep(500);

	const drained = await tv.evaluate(probe);
	await tv.screenshot(join(SHOTS, '02-drained-empty-lobby.png'));

	check(
		'the room really drained — TV on the lobby, zero media elements on stage',
		drained.lobby === true && drained.mediaCount === 0,
		`lobby=${drained.lobby} mediaCount=${drained.mediaCount}`
	);
	check(
		'the join affordance is actually rendered, so the reachability question is meaningful',
		drained.card === true,
		`card=${drained.card} rect=${JSON.stringify(drained.cardRect)} — a missing card would make the next check vacuous`
	);
	check(
		'THE FIX: no tap-to-start scrim over the empty lobby',
		drained.hint === false,
		`hint=${drained.hint} style=${JSON.stringify(drained.hintStyle)} — an 82% full-viewport scrim over an empty room, promising to start music with nothing queued`
	);
	check(
		'THE FIX: the join card is the topmost element at its own centre — a guest can read and use it',
		drained.joinCardReachable === true,
		`elementFromPoint at ${JSON.stringify(drained.cardRect)} -> "${drained.topAtJoinCard}" (joinCardReachable=${drained.joinCardReachable})`
	);

	// The state is INDEFINITE, so re-measure after a dwell rather than trusting one frame.
	await sleep(5000);
	const later = await tv.evaluate(probe);
	check(
		'still clear 5s later — nothing re-raises the scrim on an idle room',
		later.hint === false && later.joinCardReachable === true,
		`hint=${later.hint} top="${later.topAtJoinCard}" — the defect was indefinite, so one frame is not enough`
	);

	// The latch must SURVIVE — gate the RENDER, never clear the latch: the block is a property of this TV.
	const hasAdd2 = await phone.count(SEL.addTurn);
	await phone.click(hasAdd2 > 0 ? SEL.addTurn : SEL.sing);
	await tv.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.mediaEl)}).length > 0`, { timeout: 25000 });
	await sleep(2500);
	const requeued = await tv.evaluate(probe);
	await tv.screenshot(join(SHOTS, '03-requeued-hint-returns.png'));
	check(
		'the hint RETURNS the moment a song is back on stage — the latch survived the idle window',
		requeued.hint === true,
		`hint=${requeued.hint} mediaCount=${requeued.mediaCount} — if this fails the fix threw away a real property of the TV`
	);
} catch (err) {
	check('the flow ran to completion', false, String(err instanceof Error ? err.stack : err));
} finally {
	browser?.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\nshots: ${SHOTS}`);
console.log(`${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
	console.log('failed:');
	for (const f of failed) console.log(`  - ${f.name}`);
}
process.exit(failed.length ? 1 : 0);
