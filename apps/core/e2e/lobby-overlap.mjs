/*
 * Property proof for #98: on a short TV panel the lobby's typed join address must never be
 * intersected — let alone painted over — by the roster strip, at any roster size the real path can
 * produce.
 *
 * WHY THIS IS A SCRIPT, NOT A `bun test`. Same reason party.mjs is: it needs a live server and a
 * Chromium, so as a unit test it would SKIP wherever either is missing, and a permanently-skipped
 * test is the silent rot the contract guard exists to prevent (see contract.test.ts). The always-on
 * reversion guard for #98 lives in src/lib/tv/stage-scale.test.ts as a source scan; THIS is the
 * measured property behind it — run it on demand (`bun run e2e/lobby-overlap.mjs`) or against an
 * already-running server (`EPORT=xxxx bun run e2e/lobby-overlap.mjs`).
 *
 * WHAT IT ASSERTS, and why these inputs. `lobbyRoster` caps the roster at max = 8 in screen.ts, so
 * n = 8 is the PRODUCTION CEILING, not a stress case — and long display names are ordinary user data
 * (people type them at /join), so 8 long names that wrap plus the "+N more" overflow chip is the
 * reachable worst case, NOT a synthetic one. It reads getBoundingClientRect for the address and the
 * strip AND elementFromPoint at the address centre, so "nothing is painted over the address" is
 * measured, not deduced. It sweeps the two short panels the bug is specific to (1280x720, 1366x768);
 * the address is expected clear at 1920x1080 too, checked as a non-regression floor.
 *
 * Presence is seeded the deterministic way — POST /api/join for each singer, then one phone WebSocket
 * per singer held open (the roster is presence-derived from live sockets) — because driving the join
 * UI through CDP does not update Svelte 5's bound $state reliably in headless. The TV is a real
 * browser page so the CSS cascade and layout are the real ones.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect, sleep } from './cdp.mjs';
import { SEL } from './contract.ts';

const PORT = process.env.EPORT ?? '5188';
const base = `http://127.0.0.1:${PORT}`;
const CDP_PORT = Number(process.env.CDP_PORT ?? 9339);

function findChromium() {
	if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
	const cache = join(homedir(), '.cache', 'ms-playwright');
	for (const build of ['chromium-1232', 'chromium-1228']) {
		const p = join(cache, build, 'chrome-linux', 'chrome');
		if (existsSync(p)) return p;
	}
	for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
		if (existsSync(p)) return p;
	}
	return null;
}

const HUES = ['#8b5cf6', '#ec4899', '#22c55e', '#f59e0b', '#3b82f6', '#f43f5e', '#a855f7', '#10b981'];

// Long, ~10-char names so the roster wraps to multiple rows at 720p (the reachable worst case: names
// are user-typed). Unique per case — the singers table is append-only, so a reused name is refused
// with 409 and would abort the run.
function longNames(prefix, n) {
	// 32 chars — the ceiling repository.ts admits (displayName.trim().slice(0, 32)). Unique per case.
	return Array.from({ length: n }, (_, i) => `Guest${i}${prefix}`.padEnd(32, 'x').slice(0, 32));
}

// Each case is [label, names[], overflowExtra] — overflowExtra > 0 adds people past the cap so the
// component receives a non-zero `overflow` and renders the "+N more" chip.
const CASES = [
	['n=3', longNames('A', 3), 0],
	['n=8 (the cap)', longNames('B', 8), 0],
	['n=8 long names + overflow chip', longNames('C', 8), 1]
];
const VIEWPORTS = [
	[1280, 720, true],
	[1366, 768, true],
	[1920, 1080, false] // non-regression floor: never overlapped even before the fix
];

const checks = [];
function check(name, ok, detail = '') {
	checks.push({ name, ok: !!ok });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

const res = await fetch(`${base}/health`).catch(() => null);
if (!res?.ok) {
	console.error(`No Encore server on ${base}. Start one (ENCORE_EPHEMERAL=1 PORT=${PORT} ENCORE_PUBLIC_ORIGIN=http://<lan-ip>:${PORT} bun run start) and re-run.`);
	process.exit(2);
}
const chromium = findChromium();
if (!chromium) { console.error('No Chromium found. Set PW_CHROMIUM.'); process.exit(2); }

const proc = spawn(chromium, ['--headless=new', '--no-sandbox', '--disable-gpu',
	`--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*', 'about:blank'], { stdio: 'ignore' });

let browser;
const sockets = [];
try {
	browser = await connect(CDP_PORT);
	for (const [label, names, overflowExtra] of CASES) {
		// seed presence: join each name, then hold a phone socket per singer
		const total = names.length + overflowExtra;
		const roster = Array.from({ length: total }, (_, i) => [names[i] ?? `${label.replace(/[^a-z]/gi,'')}Extra${i}`, HUES[i % HUES.length]]);
		const cookies = [];
		for (const [displayName, color] of roster) {
			const r = await fetch(`${base}/api/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName, color }) });
			if (!r.ok) { console.error(`join failed (${label}) ${displayName}: ${r.status} ${await r.text()}`); process.exit(2); }
			cookies.push((r.headers.get('set-cookie') || '').split(';')[0]);
		}
		const caseSockets = [];
		for (const c of cookies) {
			const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?role=phone`, { headers: { Cookie: c } });
			await new Promise((ok, err) => { ws.addEventListener('open', ok, { once: true }); ws.addEventListener('error', err, { once: true }); });
			caseSockets.push(ws); sockets.push(ws);
		}
		await sleep(500);

		for (const [w, h, isShort] of VIEWPORTS) {
			const tv = await browser.newPage();
			await tv.viewport(w, h, 1);
			await tv.goto(`${base}/tv`);
			const rendered = await tv.waitFor(`document.querySelector(${JSON.stringify(SEL.lobbyUrl)}) !== null`, { timeout: 8000 }).catch(() => false);
			if (!rendered) { check(`${label} @ ${w}x${h} rendered the lobby`, false, 'no .lobby .url — roster did not sync'); continue; }
			await sleep(800);
			const m = await tv.evaluate(`(() => {
				const url = document.querySelector(${JSON.stringify(SEL.lobbyUrl)}); const strip = document.querySelector(${JSON.stringify(SEL.lobbyStrip)});
				const ub = url.getBoundingClientRect(); const sb = strip ? strip.getBoundingClientRect() : null;
				const cx = ub.left + ub.width / 2, cy = ub.top + ub.height / 2;
				const hit = document.elementFromPoint(cx, cy);
				const chips = [...document.querySelectorAll(${JSON.stringify(SEL.lobbyStripPerson)})];
				const cut = sb ? chips.filter((p) => { const r = p.getBoundingClientRect(); return r.bottom > sb.bottom + 0.5 || r.right > sb.right + 0.5; }).length : 0;
				const more = document.querySelector(${JSON.stringify(SEL.lobbyStripPersonMore)});
				return {
					overlap: sb ? Math.max(0, ub.bottom - sb.top) : 0,
					painted: hit ? (typeof hit.className === 'string' && hit.className ? '.' + hit.className.split(' ')[0] : hit.tagName) : null,
					inStrip: hit ? !!hit.closest(${JSON.stringify(SEL.strip)}) : false,
					strip: sb ? +sb.height.toFixed(1) : null,
					clipped: strip ? strip.scrollHeight > strip.clientHeight || strip.scrollWidth > strip.clientWidth + 1 : false,
					chipsCut: cut,
					moreShown: !!more
				};
			})()`);
			// The address must not intersect the strip AND must be the element painted at its own centre.
			// The address must be clear AND painted AND the strip must not clip any roster member: the
			// #98 fix must not trade the burial for silently dropping the people it names.
			const ok = m.overlap === 0 && m.painted === SEL.lobbyAddress && !m.inStrip && !m.clipped && m.chipsCut === 0;
			check(`${label} @ ${w}x${h}: address clear + roster not clipped`, ok,
				`overlap=${m.overlap}px painted=${m.painted} inStrip=${m.inStrip} clipped=${m.clipped} chipsCut=${m.chipsCut} moreShown=${m.moreShown} stripH=${m.strip}`);
		}

		for (const s of caseSockets) { try { s.close(); } catch {} }
		await sleep(300); // let presence drop before the next case's room
	}
} finally {
	try { browser?.close(); } catch {}
	proc.kill();
	for (const s of sockets) { try { s.close(); } catch {} }
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
