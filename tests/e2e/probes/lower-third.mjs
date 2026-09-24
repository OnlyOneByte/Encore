// Does the wall name the RIGHT singer once the second song is actually playing? Anchored on the AUDIBLE
// element's src — unpaused and advancing — and NOT on a first decoded byte: the hidden slot pre-warms, so
// song 2's first byte arrives within milliseconds while song 1 is still playing and the wall should
// still read song 1's singer, which makes a decode-counter anchor compare two moments inside song 1.
//
//   EPORT=<port> bun tests/e2e/probes/lower-third.mjs

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect, sleep } from '../driver.mjs';
import { openBrowseFromHome } from '../lib/phone.mjs';
import { SEL } from '../contract.ts';

/**
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {{ n: string, ok: boolean }} Check
 */

const PORT = process.env.EPORT ?? '3000';
const base = `http://127.0.0.1:${PORT}`;

const chrome = [
	join(homedir(), '.cache/ms-playwright/chromium-1232/chrome-linux/chrome'),
	join(homedir(), '.cache/ms-playwright/chromium-1228/chrome-linux/chrome')
].find(existsSync);
if (!chrome) {
	console.error('no chromium');
	process.exit(2);
}

/** @param {string} name @returns {Promise<{ name: string, cookie: string }>} */
async function joinSinger(name) {
	const r = await fetch(`${base}/api/join`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ displayName: name, color: '#ff5cae' })
	});
	if (!r.ok) throw new Error(`join ${name}: ${r.status} ${await r.text()}`);
	return { name, cookie: (r.headers.getSetCookie?.() ?? []).join('; ').split(';')[0] };
}
const ready = await fetch(`${base}/api/search?q=e`)
	.then((r) => r.json())
	.then((d) => d.ready ?? []);
if (ready.length < 2) {
	console.error(`need 2 processed songs, have ${ready.length}`);
	process.exit(2);
}

const a = await joinSinger(`LT-A-${Date.now() % 100000}`);
const b = await joinSinger(`LT-B-${(Date.now() + 1) % 100000}`);

/** @type {Browser | undefined} */
let browser;
/** @type {Check[]} */
const checks = [];
const check = (/** @type {string} */ n, /** @type {boolean} */ ok, d = '') => {
	checks.push({ n, ok });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok || !d ? '' : `\n        ${d}`}`);
};

try {
	browser = await connect();
	for (const [i, s] of [a, b].entries()) {
		const p = await browser.newPage();
		await p.goto(`${base}/health`);
		await p.evaluate(`document.cookie = ${JSON.stringify(s.cookie + '; path=/')}`);
		await p.goto(`${base}/`);
		await openBrowseFromHome(p);
		await p.fill(SEL.search, ready[i].title.split(' ')[0]);
		await p.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.addTurn)}).length > 0`);
		await p.click(SEL.addTurn);
		await sleep(600);
	}

	const tv = await browser.newPage();
	await tv.viewport(1920, 1080, 1);
	await tv.goto(`${base}/tv`);

	// "Audible" means not paused AND currentTime moving — the pre-warmed sibling is neither.
	const sample = `(() => {
		const els = [...document.querySelectorAll('audio,video')];
		const live = els.find((e) => !e.paused && e.currentTime > 0.05) ?? null;
		return {
			src: live ? (live.currentSrc || live.src) : '',
			t: live ? live.currentTime : null,
			name: (document.querySelector(${JSON.stringify(SEL.nowName)})?.textContent ?? '').trim(),
			song: (document.querySelector(${JSON.stringify(SEL.nowSong)})?.textContent ?? '').trim(),
			mounted: els.length
		};
	})()`;

	const seen = [];
	for (let i = 0; i < 90; i++) {
		const s = await tv.evaluate(sample);
		if (s.src) {
			const last = seen[seen.length - 1];
			if (!last || last.src !== s.src) seen.push({ ...s, at: i * 250 });
			else last.lastName = s.name;
		}
		await sleep(250);
	}

	console.log('\naudible-src transitions:');
	for (const s of seen)
		console.log(
			`  +${s.at}ms  src=…${s.src.slice(-28)}  name="${s.name}"${s.lastName && s.lastName !== s.name ? ` → "${s.lastName}"` : ''}  song="${s.song}"`
		);

	check(
		'two different songs actually became audible in turn',
		seen.length >= 2,
		`saw ${seen.length} distinct audible src(s) — ${seen.length < 2 ? 'the handover never happened' : ''}`
	);

	if (seen.length >= 2) {
		const n1 = seen[0].lastName ?? seen[0].name;
		const n2 = seen[1].lastName ?? seen[1].name;
		check(
			'the wall names a different singer once the second song is audible',
			n1 !== n2 && !!n1 && !!n2,
			`song 1 showed "${n1}", song 2 showed "${n2}" — identical means the room keeps the old singer's name up`
		);
		check(
			'both names are real singers from this run',
			[a.name, b.name].includes(n1) && [a.name, b.name].includes(n2),
			`expected two of [${a.name}, ${b.name}], got "${n1}" and "${n2}"`
		);
	}
} catch (e) {
	check('the flow ran', false, String(e instanceof Error ? e.stack : e));
} finally {
	browser?.close();
}
const bad = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - bad.length}/${checks.length} passed`);
process.exit(bad.length ? 1 : 0);
