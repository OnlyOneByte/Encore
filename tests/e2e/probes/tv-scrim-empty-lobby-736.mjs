/*
 * — THE TAP-TO-START SCRIM MUST NOT OUTLIVE THE ROOM.
 *
 * `{#if autoplayBlocked}` was the only gate on the full-screen tap-to-start overlay, so it carried no
 * term for "there is something to play". The latch has exactly two writers, both per-slot props
 * (onautoplayblocked -> true, onautoplayrecovered -> false), so when the room DRAINS — a skip at the
 * last entry, where player.ts advance() finds no nextPlayable and sets currentEntryId null / isPlaying
 * false — both players unmount and NEITHER callback can fire again. The 82%-opaque full-viewport scrim
 * (inset: 0, z-index: 10) then sat over the lobby of an EMPTY room indefinitely, above the join QR and
 * the join address a new singer walks up to read.
 *
 * WHY THIS PROBE AND NOT A UNIT TEST. The defect is a rendered stacking-order fact — which element is
 * topmost at the join card's own centre — and Encore has no jsdom, so it is not decidable in `bun test`.
 * The suite guard is a source scan (src/lib/tv/autoplay-recovery.test.ts, "the /tv autoplay hint is scoped to the on-stage band"); this is the
 * rendered half.
 *
 * GESTURELESS BY CONSTRUCTION: no --autoplay-policy flag anywhere below. That restriction is the whole
 * premise — a never-tapped TV is the only TV that can reach this state, and it is the state a wall-
 * mounted television lives in permanently. Two inputs get here and neither is a tap.
 *
 *   EPORT=5362 bun tests/e2e/probes/tv-scrim-empty-lobby-736.mjs
 *
 * Exit 0 all passed / 1 a real failure / 2 the environment could not host the test.
 */
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
const SHOTS = join(SCRATCH, 'shots-736');

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

/*
 * A phone-side socket used for BOTH directions: it sends the skip (the server rejects a
 * player:command from a non-joined session, so it must ride the joined phone's own origin) and it
 * records the latest authoritative frames, so the drain is asserted against what the SERVER says and
 * not only against what the TV drew.
 */
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

/*
 * ONE in-page reading, taken identically at every step so the before/after comparison is
 * apples-to-apples. `topAtJoinCard` is the load-bearing measurement: elementFromPoint at the join
 * card's own centre, reported as the class list of what the browser says is topmost there, plus whether
 * that element is the join card or one of its descendants. That is the guest-visible question — "can
 * somebody walking up to this TV read and use the join affordance" — and it is the one a source scan
 * cannot answer.
 */
const probe = `(() => {
	const q = (s) => document.querySelector(s);
	const hintEl = q(${JSON.stringify(SEL.autoplayHint)});
	// The lobby's join affordance: the QR + typed address on a routable origin, or the operator notice
	// that replaces it on an unroutable one. Either is what a guest reads, so measure whichever is up.
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

	// ── a singer joins and queues the processed song, through the real UI ──────────────────────────
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
	// Back to the queue before counting rows: the rotation is NOT rendered in the results view, so a
	// `.qrow` count taken here reads an empty list and times out. `returnHomeFromBrowse` clears the
	// search, which is what brings the queue back — its own docstring names this exact mistake.
	await returnHomeFromBrowse(phone);
	await phone.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length > 0`);
	check('a singer joins and queues the processed song — one entry, nothing behind it', true);

	// ── the TV, gestureless ────────────────────────────────────────────────────────────────────
	const tv = await browser.newPage();
	await tv.viewport(1920, 1080, 1);
	await tv.goto(base + '/tv');
	try {
		await tv.waitFor(
			`(() => { const e=[...document.querySelectorAll(${JSON.stringify(SEL.mediaEl)})].filter(x=>x.currentSrc||x.src); return e.length > 0; })()`,
			{ timeout: 25000 }
		);
	} catch {
		// Swallowed on purpose: this wait only shortens the settle below. STEP 1 asserts the blocked state
		// explicitly, so a timeout here must surface as that named check failing with its measurements —
		// not as an exception that reports the whole flow as "did not run".
	}
	await sleep(2000);

	// ── STEP 1: the CORRECT pre-drain state — a song is on stage and the TV cannot start it ────
	const blocked = await tv.evaluate(probe);
	await tv.screenshot(join(SHOTS, '01-blocked-with-a-song-on-stage.png'));
	check(
		'BEFORE the drain the hint is up — the block is real and correctly announced',
		blocked.hint === true,
		`hint=${blocked.hint} style=${JSON.stringify(blocked.hintStyle)} — without this the rest of the run proves nothing`
	);

	// ── STEP 2: skip at the last entry — the drain, and the second of the two inputs ───────────
	await sendPlayer(phone, { cmd: 'skip' });
	// Wait for the SERVER to report the drain, read off the joined phone's own socket.
	await phone.waitFor(
		`(() => { const s = window.__srv; return !!s && !!s.playback && s.playback.currentEntryId === null && s.playback.isPlaying === false; })()`,
		{ timeout: 15000 }
	);
	const srv = await phone.evaluate(`JSON.stringify(window.__srv.playback)`);
	console.log('\nserver after skip-at-last-entry: ' + srv + '\n');
	// And for the TV to have fallen to the lobby with no player left mounted.
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

	// ── STEP 3: it is INDEFINITE, so re-measure after a dwell rather than trusting one frame ───
	await sleep(5000);
	const later = await tv.evaluate(probe);
	check(
		'still clear 5s later — nothing re-raises the scrim on an idle room',
		later.hint === false && later.joinCardReachable === true,
		`hint=${later.hint} top="${later.topAtJoinCard}" — the defect was indefinite, so one frame is not enough`
	);

	// ── STEP 4: the latch must SURVIVE — the TV has still never been tapped ────────────────────
	// This is why the fix gates the render instead of clearing the latch. Re-queue and the hint must
	// come straight back: the block is a real property of this television.
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
