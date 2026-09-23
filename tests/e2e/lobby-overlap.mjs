// On a short TV panel the lobby's typed join address must never be intersected — let alone painted over —
// by the roster strip, at any roster size the real path can produce.
//
//   bun run e2e:lobby                    # or EPORT=xxxx against an already-running server
//
// The always-on reversion guard is a source scan in tests/guards/layout/stage-scale.test.ts; THIS is the
// measured property behind it.
//
// WHY THESE INPUTS. `lobbyRoster` caps the roster at 8, so n = 8 is the PRODUCTION CEILING rather than a
// stress case, and long display names are ordinary user data. Both rect AND `elementFromPoint` at the
// address centre are read, so "nothing is painted over the address" is measured rather than deduced. The
// two short panels (1280x720, 1366x768) are the bug's own sizes; 1920x1080 is a non-regression floor.
//
// Presence is seeded deterministically — POST /api/join per singer, then one phone WebSocket per singer
// held open, since the roster is presence-derived from live sockets — because driving the join UI does not
// update Svelte 5's bound $state reliably in headless. The TV is a real page, so the cascade is the real one.
import { connect, sleep } from './driver.mjs';
import { SEL } from './contract.ts';
import { findChromium } from './lib/chromium.mjs';

/**
 * Browser/Page derive from driver.mjs's return types so they cannot drift; page.evaluate() is
 * Promise<any>, cast at the call site.
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {{ name: string, ok: boolean }} Check
 *
 * The measurement the overlap-probe evaluate returns.
 * @typedef {{
 *   overlap: number, painted: string | null, inStrip: boolean, strip: number | null,
 *   clipped: boolean, chipsCut: number, chipsOccluded: number
 * }} OverlapReading
 */

const PORT = process.env.EPORT ?? '5188';
const base = `http://127.0.0.1:${PORT}`;

const HUES = ['#8b5cf6', '#ec4899', '#22c55e', '#f59e0b', '#3b82f6', '#f43f5e', '#a855f7', '#10b981'];

// Long names so the roster wraps to multiple rows at 720p, and UNIQUE per case: the singers table is
// append-only, so a reused name is refused with 409 and would abort the run.
/** @param {string} prefix @param {number} n @returns {string[]} */
function longNames(prefix, n) {
	// 32 chars — the ceiling repository.ts admits (displayName.trim().slice(0, 32)). Unique per case.
	return Array.from({ length: n }, (_, i) => `Guest${i}${prefix}`.padEnd(32, 'x').slice(0, 32));
}

// Each case is [label, names[], overflowExtra] — overflowExtra > 0 adds people past the cap so the
// component receives a non-zero `overflow` and renders the "+N more" chip.
/** @type {[string, string[], number][]} */
const CASES = [
	['n=3', longNames('A', 3), 0],
	['n=8 (the cap)', longNames('B', 8), 0],
	['n=8 long names + overflow chip', longNames('C', 8), 1]
];
/** @type {[number, number, boolean][]} */
const VIEWPORTS = [
	[1280, 720, true],
	[1366, 768, true],
	[1920, 1080, false] // non-regression floor: never overlapped even before the fix
];

/** @type {Check[]} */
const checks = [];
/** @param {string} name @param {unknown} ok @param {string} [detail] */
function check(name, ok, detail = '') {
	checks.push({ name, ok: !!ok });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

const res = await fetch(`${base}/health`).catch(() => null);
if (!res?.ok) {
	console.error(
		`No Encore server on ${base}. Start one (ENCORE_EPHEMERAL=1 PORT=${PORT} ENCORE_PUBLIC_ORIGIN=http://<lan-ip>:${PORT} bun run start) and re-run.`
	);
	process.exit(2);
}
const chromium = findChromium();
if (!chromium) {
	console.error('No Chromium found. Set PW_CHROMIUM.');
	process.exit(2);
}

/** @type {Browser | undefined} */
let browser;
/** @type {WebSocket[]} */
const sockets = [];
try {
	const browser0 = await connect();
	browser = browser0;
	for (const [label, names, overflowExtra] of CASES) {
		// Seed presence: join each name, then hold a phone socket per singer.
		const total = names.length + overflowExtra;
		const roster = Array.from({ length: total }, (_, i) => [
			names[i] ?? `${label.replace(/[^a-z]/gi, '')}Extra${i}`,
			HUES[i % HUES.length]
		]);
		const cookies = [];
		for (const [displayName, color] of roster) {
			const r = await fetch(`${base}/api/join`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ displayName, color })
			});
			if (!r.ok) {
				console.error(`join failed (${label}) ${displayName}: ${r.status} ${await r.text()}`);
				process.exit(2);
			}
			cookies.push((r.headers.get('set-cookie') || '').split(';')[0]);
		}
		const caseSockets = [];
		for (const c of cookies) {
			const ws = new /** @type {new (url: string, opts?: { headers?: Record<string, string> }) => WebSocket} */ (
				WebSocket
			)(`ws://127.0.0.1:${PORT}/ws?role=phone`, { headers: { Cookie: c } });
			await new Promise((ok, err) => {
				ws.addEventListener('open', ok, { once: true });
				ws.addEventListener('error', err, { once: true });
			});
			caseSockets.push(ws);
			sockets.push(ws);
		}
		await sleep(500);

		for (const [w, h] of VIEWPORTS) {
			const tv = await browser0.newPage();
			await tv.viewport(w, h, 1);
			await tv.goto(`${base}/tv`);
			const rendered = await tv.waitForSelector(SEL.lobbyUrl, { timeout: 8000 }).catch(() => false);
			if (!rendered) {
				check(`${label} @ ${w}x${h} rendered the lobby`, false, 'no .lobby .url — roster did not sync');
				continue;
			}
			await sleep(800);
			const m = /** @type {OverlapReading} */ (
				await tv.evaluate(`(() => {
				const url = document.querySelector(${JSON.stringify(SEL.lobbyUrl)}); const strip = document.querySelector(${JSON.stringify(SEL.lobbyStrip)});
				const ub = url.getBoundingClientRect(); const sb = strip ? strip.getBoundingClientRect() : null;
				const cx = ub.left + ub.width / 2, cy = ub.top + ub.height / 2;
				const hit = document.elementFromPoint(cx, cy);
				const chips = [...document.querySelectorAll(${JSON.stringify(SEL.lobbyStripPerson)})];
				const cut = sb ? chips.filter((p) => { const r = p.getBoundingClientRect(); return r.bottom > sb.bottom + 0.5 || r.right > sb.right + 0.5; }).length : 0;
				// No chip may be OCCLUDED by a corner control: those are position:absolute above the strip in
				// the paint order, so a name under one is invisible to a clip check.
				const occluded = chips.filter((p) => {
					const r = p.getBoundingClientRect();
					for (const [x, y] of [[r.left + r.width / 2, r.top + r.height / 2], [r.right - 2, r.top + r.height / 2]]) {
						const h = document.elementFromPoint(x, y);
						if (h && (h.closest(${JSON.stringify(SEL.fsBtn)}) || h.closest(${JSON.stringify(SEL.badQr)}))) return true;
					}
					return false;
				}).length;
				return {
					overlap: sb ? Math.max(0, ub.bottom - sb.top) : 0,
					painted: hit ? (typeof hit.className === 'string' && hit.className ? '.' + hit.className.split(' ')[0] : hit.tagName) : null,
					inStrip: hit ? !!hit.closest(${JSON.stringify(SEL.strip)}) : false,
					strip: sb ? +sb.height.toFixed(1) : null,
					clipped: strip ? strip.scrollHeight > strip.clientHeight || strip.scrollWidth > strip.clientWidth + 1 : false,
					chipsCut: cut,
					chipsOccluded: occluded
				};
			})()`)
			);
			// All four together: the address clear of the strip, the address painted at its own centre, no
			// roster member clipped, and none occluded — showing the whole roster must not be traded for
			// silently dropping the people it names.
			const ok =
				m.overlap === 0 &&
				m.painted === SEL.lobbyAddress &&
				!m.inStrip &&
				!m.clipped &&
				m.chipsCut === 0 &&
				m.chipsOccluded === 0;
			check(
				`${label} @ ${w}x${h}: address clear + roster not clipped or occluded`,
				ok,
				`overlap=${m.overlap}px painted=${m.painted} inStrip=${m.inStrip} clipped=${m.clipped} chipsCut=${m.chipsCut} chipsOccluded=${m.chipsOccluded} stripH=${m.strip}`
			);
		}

		for (const s of caseSockets) {
			try {
				s.close();
			} catch {
				/* already closed, or never opened */
			}
		}
		await sleep(300); // let presence drop before the next case's room
	}
} finally {
	try {
		browser?.close();
	} catch {
		/* already closed, or never opened */
	}
	for (const s of sockets) {
		try {
			s.close();
		} catch {
			/* already closed, or never opened */
		}
	}
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
