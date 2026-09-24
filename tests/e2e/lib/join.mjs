// JOINING A ROOM, IN ONE PLACE — see docs/E2E.md#shared-helpers for the two panes and why every driver
// takes the SCANNED path. The trap this file exists to remove: the name field is on the IDENTITY pane only,
// so a bare `goto('/')` + `fill(nameInput)` lands on the six-box code pane and times out after 10s.
import { SEL } from '../contract.ts';

/** Matches the drivers' own ceiling for a first paint after a navigation. */
const DEFAULT_TIMEOUT = 15_000;

/** Room code per base URL — one per server boot, and every guest in a flow wants the same one. */
const codeCache = new Map();

/**
 * The active room's join code, read off the TV's attract panel. Pass `fresh: true` after restarting a
 * server mid-run.
 *
 * @param {{ goto: (url: string) => Promise<unknown>,
 *           waitForSelector: (sel: string, opts?: { timeout?: number }) => Promise<unknown>,
 *           evaluate: (expr: string) => Promise<any> }} page
 * @param {string} base
 * @param {{ timeout?: number, fresh?: boolean }} [opts]
 * @returns {Promise<string>}
 */
export async function roomCode(page, base, { timeout = DEFAULT_TIMEOUT, fresh = false } = {}) {
	// AN EXPLICIT CODE WINS — the escape hatch for a server that ALREADY has guests. `/tv` renders the
	// attract panel, and therefore the code, only while the room is EMPTY. Flows here open `/tv` before
	// their first join so the cache is primed; a driver pointed at a warm server must be told, with
	// `ENCORE_ROOM_CODE=ABCD23`.
	const declared = (typeof process !== 'undefined' ? process.env?.ENCORE_ROOM_CODE : '')?.trim().toUpperCase();
	if (declared) return declared;
	if (!fresh && codeCache.has(base)) return codeCache.get(base);
	await page.goto(`${base}/tv`);
	await page.waitForSelector(SEL.attractCode, { timeout });
	const code = String(
		await page.evaluate(`document.querySelector(${JSON.stringify(SEL.attractCode)})?.textContent?.trim() ?? ''`)
	);
	if (!/^[A-Z0-9]{6}$/.test(code)) {
		// Loud, with the remedy in it: a silent empty code turns every join below into a pane timeout that
		// reads like a UI bug rather than an environment one.
		throw new Error(
			`could not read the room code off ${base}/tv (got ${JSON.stringify(code)}).\n` +
				'      The attract panel only renders it while the room is EMPTY — a room that already has\n' +
				'      singers shows the lobby instead. Restart the server for a fresh room, or pass the code\n' +
				'      explicitly: ENCORE_ROOM_CODE=ABCD23 bun run <driver>'
		);
	}
	codeCache.set(base, code);
	return code;
}

/**
 * Land on the IDENTITY pane. Deliberately the smaller helper: it navigates and waits, leaving the name, the
 * colour and the submit to the caller. `joinAs` below is the whole flow, for a call site with no opinion.
 *
 * @param {{ goto: (url: string) => Promise<unknown>,
 *           waitForSelector: (sel: string, opts?: { timeout?: number }) => Promise<unknown>,
 *           evaluate: (expr: string) => Promise<any> }} page
 * @param {string} base
 * @param {{ code?: string, timeout?: number }} [opts]
 */
export async function openJoin(page, base, { code, timeout = DEFAULT_TIMEOUT } = {}) {
	const room = code ?? (await roomCode(page, base, { timeout }));
	await page.goto(`${base}/?room=${encodeURIComponent(room)}`);
	// The pane is `resolving` until /api/room-preview answers, so wait for the FIELD rather than sleeping at
	// the navigation — a fill issued before the pane flips lands on nothing and reads as a missing control.
	await page.waitForSelector(SEL.nameInput, { timeout });
}

/**
 * Join as `name` through the real screen and land on the joined home. `stop` is a KEY for the colour ring
 * (`Home`/`End` are the two ends of the 48-stop palette): the ring is a `role="slider"`, so a colour is a
 * keypress and there is no per-colour element to click. Leaves the page on `/` and does NOT open search.
 *
 * @param {{ goto: (url: string) => Promise<unknown>,
 *           fill: (sel: string, value: string) => Promise<unknown>,
 *           pressKey: (sel: string, key: string) => Promise<unknown>,
 *           clickByRole: (role: string, name: string) => Promise<unknown>,
 *           waitFor: (expr: string, opts?: { timeout?: number }) => Promise<any>,
 *           waitForSelector: (sel: string, opts?: { timeout?: number }) => Promise<unknown>,
 *           evaluate: (expr: string) => Promise<any> }} page
 * @param {string} base
 * @param {string} name
 * @param {{ stop?: string, code?: string, timeout?: number }} [opts]
 */
export async function joinAs(page, base, name, { stop, code, timeout = DEFAULT_TIMEOUT } = {}) {
	await openJoin(page, base, { code, timeout });
	await page.fill(SEL.nameInput, name);
	if (stop) await page.pressKey(SEL.colourRing, stop);
	// `SEL.submit` is a regex whose source IS the literal label, so the name is derived rather than re-typed.
	await page.clickByRole('button', SEL.submit.source);
	// The join reloads `/` by hand (a client-side goto from `/` to `/` is a no-op), so wait for the BAND
	// rather than for the URL: the path never changed.
	await page.waitFor(`document.querySelector(${JSON.stringify(SEL.homeReady)}) !== null`, { timeout });
}
