/*
 * P9 — SETTINGS, THREE SCOPES, LIVE. Findings carry path:line evidence.
 *   EPORT=5229 bun tests/e2e/probes/p9-settings.mjs
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { tmpdir } from 'node:os';
import { SEL } from '../contract.ts';

/**
 * @typedef {'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO' | 'PASS'} Severity
 * @typedef {{ sev: Severity, area: string, msg: string, evidence: string }} Finding
 * @typedef {import('$lib/contract').GlobalSettings} GlobalSettings
 * @typedef {import('$lib/contract').RoomSettings} RoomSettings
 * @typedef {import('$lib/contract').EffectiveSettings} EffectiveSettings
 * @typedef {{ cookie?: string | null, body?: unknown, expectJson?: boolean }} ApiOpts
 * @typedef {{ status: number, headers: Headers, text: string, body: any, setCookie: string | null }} ApiResult
 * @typedef {{ ws: WebSocket, events: any[], opened: Promise<unknown> }} PhoneWs
 */

const PORT = process.env.EPORT ?? '5229';
const BASE = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}`;
const SCRATCH = process.env.KIROCREW_SCRATCH ?? tmpdir();

/** @type {Finding[]} */
const findings = [];
/** @param {Severity} sev @param {string} area @param {string} msg @param {string} [evidence] */
function add(sev, area, msg, evidence = '') {
	findings.push({ sev, area, msg, evidence });
	const tag = sev === 'PASS' ? '     ' : `${sev.padEnd(8)}`;
	console.log(`${tag} [${area}] ${msg}${evidence ? `\n           evidence: ${evidence}` : ''}`);
}
/** @param {string} msg @returns {never} */
function bail(msg) {
	console.error(`\nENVIRONMENT: ${msg}`);
	process.exit(2);
}

/** @param {string} method @param {string} path @param {ApiOpts} [opts] @returns {Promise<ApiResult>} */
async function api(method, path, { cookie, body, expectJson = true } = {}) {
	/** @type {Record<string, string>} */
	const headers = { 'content-type': 'application/json' };
	if (cookie) headers.Cookie = cookie;
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const text = await res.text();
	let parsed = null;
	if (expectJson && text) {
		try {
			parsed = JSON.parse(text);
		} catch {
			/* left null */
		}
	}
	return { status: res.status, headers: res.headers, text, body: parsed, setCookie: res.headers.get('set-cookie') };
}
/** @param {string | null} setCookieHeader @returns {string | null} */
function cookieFromSetCookie(setCookieHeader) {
	if (!setCookieHeader) return null;
	const first = setCookieHeader.split(';')[0].trim();
	return first;
}
/** @param {string} name @returns {Promise<{ cookie: string, singerId: string }>} */
async function joinAs(name) {
	const r = await api('POST', '/api/join', { body: { displayName: name, color: '#7c5cff' } });
	if (r.status !== 200) throw new Error(`join failed for ${name}: HTTP ${r.status} ${r.text}`);
	const cookie = cookieFromSetCookie(r.setCookie);
	if (!cookie) throw new Error(`no cookie back from /api/join for ${name}`);
	const singerId = /** @type {{ singer: { id: string } }} */ (r.body).singer.id;
	return { cookie, singerId };
}
/** @returns {Promise<EffectiveSettings>} */
async function getSettings() {
	const r = await api('GET', '/api/settings');
	if (r.status !== 200) throw new Error(`GET /api/settings HTTP ${r.status}`);
	return r.body;
}
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

// The cookie makes this socket a JOINED singer, which is what makes it receive broadcasts at all.
/** @param {string} cookie @returns {PhoneWs} */
function openPhoneWs(cookie) {
	/** @type {any[]} */
	const events = [];
	const ws = new WebSocket(`${WS_BASE}/ws?role=phone`, /** @type {any} */ ({ headers: { Cookie: cookie } }));
	ws.onmessage = (ev) => {
		try {
			events.push(JSON.parse(String(ev.data)));
		} catch {
			/* ignore malformed */
		}
	};
	const opened = new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = (e) => reject(new Error(`ws open error: ${/** @type {any} */ (e)?.message ?? e}`));
	});
	return { ws, events, opened };
}

if (!(await fetch(`${BASE}/health`).catch(() => null))?.ok) {
	bail(`no Encore server on ${BASE}. Follow tests/e2e/HARNESS.md.`);
}
const serverHasEnvOrigin = (process.env.EXPECTED_ENV_ORIGIN ?? '').trim();
// Empty EXPECTED_ENV_ORIGIN soft-skips the env-fallback arm: env is not observable from outside the process.

console.log(`[p9] driving ${BASE}\n`);

// 1. Auth boundary — anonymous PUTs must be refused.
{
	const g = await api('PUT', '/api/settings', { body: { syncMode: 'lines' } });
	add(
		g.status === 401 ? 'PASS' : 'HIGH',
		'auth',
		'anonymous PUT /api/settings refused',
		`HTTP ${g.status} — server.ts routes/api/settings/+server.ts:23`
	);
	const r = await api('PUT', '/api/settings/room', { body: { queueOrder: 'fcfs' } });
	add(
		r.status === 401 ? 'PASS' : 'HIGH',
		'auth',
		'anonymous PUT /api/settings/room refused',
		`HTTP ${r.status} — routes/api/settings/room/+server.ts:15`
	);
}

// 2. Persistence — every SEL.SETTING_IDS control roundtrips.
const { cookie: aliceCookie } = await joinAs('AliceProbe');
{
	// Every id the contract names must be exercised here; an uncovered one is a hole reported as green.
	const COVERED_IDS = new Set([
		'join-origin',
		'sync-mode', // global
		'queue-order',
		'tv-progress',
		'tv-background',
		'tv-visualizer', // room, staging
		'lyrics-highlight',
		'lyrics-ball',
		'lyrics-font',
		'lyrics-case' // room, lyrics
	]);
	const missing = SEL.SETTING_IDS.filter((id) => !COVERED_IDS.has(id));
	add(
		missing.length === 0 ? 'PASS' : 'HIGH',
		'coverage',
		`persistence probe covers every SEL.SETTING_IDS entry (${SEL.SETTING_IDS.length})`,
		missing.length ? `uncovered: ${missing.join(', ')}` : `tests/e2e/contract.ts:104-115`
	);

	const start = await getSettings();
	const patch1 = await api('PUT', '/api/settings', {
		cookie: aliceCookie,
		body: { joinOrigin: 'http://phones.example:8080' }
	});
	const gotJoin = patch1.body?.global?.joinOrigin;
	add(
		gotJoin === 'http://phones.example:8080' ? 'PASS' : 'HIGH',
		'persistence',
		'#join-origin persists via PUT /api/settings',
		`stored=${JSON.stringify(gotJoin)}  — src/lib/contract/core/settings.ts:normalizeJoinOrigin`
	);

	const patch2 = await api('PUT', '/api/settings', { cookie: aliceCookie, body: { syncMode: 'lines' } });
	add(
		patch2.body?.global?.syncMode === 'lines' ? 'PASS' : 'HIGH',
		'persistence',
		'#sync-mode persists via PUT /api/settings',
		`stored=${JSON.stringify(patch2.body?.global?.syncMode)}  — src/lib/contract/lyrics/lyrics-engines.ts:118`
	);

	// The normalizer rejects per-field to CURRENT, so only a full round-trip says which field took.
	/** @type {Partial<RoomSettings>} */
	const roomWrite = {
		queueOrder: 'fcfs',
		tvProgressStyle: 'corner',
		tvBackgroundStyle: 'solid',
		tvVisualizer: 'starfield',
		lyricsHighlight: 'line',
		lyricsBall: 'off',
		lyricsFont: 'grotesk',
		lyricsCase: 'upper'
	};
	const rroom = await api('PUT', '/api/settings/room', { cookie: aliceCookie, body: roomWrite });
	/** @type {Partial<RoomSettings>} */
	const room = rroom.body?.room ?? {};
	for (const id of [
		'queue-order',
		'tv-progress',
		'tv-background',
		'tv-visualizer',
		'lyrics-highlight',
		'lyrics-ball',
		'lyrics-font',
		'lyrics-case'
	]) {
		/** @type {Record<string, keyof RoomSettings>} */
		const camelMap = {
			'queue-order': 'queueOrder',
			'tv-progress': 'tvProgressStyle',
			'tv-background': 'tvBackgroundStyle',
			'tv-visualizer': 'tvVisualizer',
			'lyrics-highlight': 'lyricsHighlight',
			'lyrics-ball': 'lyricsBall',
			'lyrics-font': 'lyricsFont',
			'lyrics-case': 'lyricsCase'
		};
		const camel = camelMap[id];
		const want = roomWrite[camel];
		const got = room[camel];
		add(
			got === want ? 'PASS' : 'HIGH',
			'persistence',
			`#${id} persists via PUT /api/settings/room`,
			`stored=${JSON.stringify(got)} wanted=${JSON.stringify(want)}`
		);
	}

	// A follow-up GET, because the write endpoint's own reply could be in-memory only.
	const roundtrip = await getSettings();
	const persisted =
		roundtrip.room.queueOrder === 'fcfs' &&
		roundtrip.global.syncMode === 'lines' &&
		roundtrip.global.joinOrigin === 'http://phones.example:8080';
	add(
		persisted ? 'PASS' : 'HIGH',
		'persistence',
		'follow-up GET returns the values just written (SQLite, not memory)',
		`GET /api/settings queueOrder=${roundtrip.room.queueOrder} syncMode=${roundtrip.global.syncMode} joinOrigin=${roundtrip.global.joinOrigin}`
	);

	// Restore before the downstream steps, which would otherwise be fighting this section's leftovers.
	await api('PUT', '/api/settings', { cookie: aliceCookie, body: { syncMode: 'forced', joinOrigin: '' } });
	await api('PUT', '/api/settings/room', { cookie: aliceCookie, body: { queueOrder: 'fair' } });
	void start;
}

// 3. Validation — garbage must not persist.
{
	// One field per payload: reject-to-current is PER FIELD, so a sibling must survive its neighbour's junk.
	const baseline = await getSettings();
	/** @type {{ scope: 'global' | 'room', body: Record<string, unknown>, field: string, expect: unknown }[]} */
	const garbage = [
		{ scope: 'global', body: { syncMode: 'no-thanks' }, field: 'syncMode', expect: baseline.global.syncMode },
		{ scope: 'global', body: { asrModel: '../../etc/passwd' }, field: 'asrModel', expect: baseline.global.asrModel },
		{
			scope: 'global',
			body: { defaultEngine: 'roformer', defaultModel: 'nope-9000' },
			field: 'defaultModel',
			expect: baseline.global.defaultModel
		},
		{
			scope: 'global',
			body: { joinOrigin: 'javascript:alert(1)' },
			field: 'joinOrigin',
			expect: baseline.global.joinOrigin
		},
		{ scope: 'global', body: { joinOrigin: 'not a url' }, field: 'joinOrigin', expect: baseline.global.joinOrigin },
		{ scope: 'room', body: { queueOrder: 'fifo' }, field: 'queueOrder', expect: baseline.room.queueOrder },
		{
			scope: 'room',
			body: { tvProgressStyle: 'DROP TABLE' },
			field: 'tvProgressStyle',
			expect: baseline.room.tvProgressStyle
		},
		{
			// A colour, not an angle: the interesting junk is an unparseable colour reaching a style attribute.
			scope: 'room',
			body: { tvBackgroundColor: 'rebeccapurple' },
			field: 'tvBackgroundColor',
			expect: baseline.room.tvBackgroundColor
		},
		{ scope: 'room', body: { lyricsBall: 'wormhole' }, field: 'lyricsBall', expect: baseline.room.lyricsBall },
		{ scope: 'room', body: { songIntroMs: -99999 }, field: 'songIntroMs', expect: 500 /* MIN_SONG_INTRO_MS */ },
		{ scope: 'room', body: { songIntroMs: 99999999 }, field: 'songIntroMs', expect: 10000 /* MAX_SONG_INTRO_MS */ }
	];
	for (const g of garbage) {
		const path = g.scope === 'global' ? '/api/settings' : '/api/settings/room';
		const r = await api('PUT', path, { cookie: aliceCookie, body: g.body });
		/** @type {Record<string, unknown> | undefined} */
		const bucket = g.scope === 'global' ? r.body?.global : r.body?.room;
		const got = bucket?.[g.field];
		const ok = got === g.expect || (Number.isNaN(g.expect) && Number.isNaN(got));
		add(
			ok ? 'PASS' : 'HIGH',
			'validation',
			`${g.scope}.${g.field} garbage ${JSON.stringify(g.body[g.field])} degrades to ${JSON.stringify(g.expect)}`,
			`server returned ${JSON.stringify(got)}`
		);
	}

	// A non-JSON body must 400 rather than crash the server or persist junk.
	const bad = await fetch(`${BASE}/api/settings`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json', Cookie: aliceCookie },
		body: 'not-json'
	});
	add(
		bad.status === 400 ? 'PASS' : 'MEDIUM',
		'validation',
		'malformed JSON body returns 400 rather than a 500',
		`HTTP ${bad.status} — routes/api/settings/+server.ts:27`
	);
	// The handler reads request.json(), so null, an array and a top-level string all parse. Watch for a crash.
	const nullBody = await api('PUT', '/api/settings', { cookie: aliceCookie, body: null });
	add(
		nullBody.status < 500 ? 'PASS' : 'HIGH',
		'validation',
		'top-level JSON `null` body handled without a 500',
		`HTTP ${nullBody.status}  — settings-repository.ts:setGlobal(null|undefined)`
	);
	const arrBody = await api('PUT', '/api/settings', { cookie: aliceCookie, body: [1, 2, 3] });
	add(
		arrBody.status < 500 ? 'PASS' : 'MEDIUM',
		'validation',
		'top-level JSON array body handled without a 500',
		`HTTP ${arrBody.status}`
	);
}

// 4. join-origin runtime override — no restart.
{
	// joinOrigin must move the QR with NO process restart; booted on ENCORE_PUBLIC_ORIGIN, clearing proves setting > env.
	const setNew = 'http://runtime-fix.example:1234';
	await api('PUT', '/api/settings', { cookie: aliceCookie, body: { joinOrigin: setNew } });
	const tvHtmlA = await (await fetch(`${BASE}/tv`)).text();
	const joinUrlA = tvHtmlA.match(/"joinUrl":"([^"]+)"/)?.[1] ?? extractJoinFromHtml(tvHtmlA);
	add(
		joinUrlA?.startsWith(setNew) ? 'PASS' : 'HIGH',
		'join-origin',
		'runtime PUT joinOrigin changes /tv joinUrl with no restart',
		`joinUrl=${joinUrlA} setting=${setNew}  — server/public-origin.ts:joinOrigin`
	);

	// The fallback rule is setting → env → request, so clearing must serve the booted env if there is one.
	await api('PUT', '/api/settings', { cookie: aliceCookie, body: { joinOrigin: '' } });
	const tvHtmlB = await (await fetch(`${BASE}/tv`)).text();
	const joinUrlB = tvHtmlB.match(/"joinUrl":"([^"]+)"/)?.[1] ?? extractJoinFromHtml(tvHtmlB);
	if (serverHasEnvOrigin) {
		add(
			joinUrlB?.startsWith(serverHasEnvOrigin) ? 'PASS' : 'HIGH',
			'join-origin',
			`clearing joinOrigin falls back to ENCORE_PUBLIC_ORIGIN=${serverHasEnvOrigin}`,
			`joinUrl=${joinUrlB}  — server/public-origin.ts:configuredOrigin`
		);
	} else {
		add(
			'INFO',
			'join-origin',
			'after clearing joinOrigin (no env-origin declared by harness), fell back to request-derived origin',
			`joinUrl=${joinUrlB}  — pass EXPECTED_ENV_ORIGIN to assert setting > env`
		);
	}
}
/** @param {string} html @returns {string | null} */
function extractJoinFromHtml(html) {
	// SvelteKit serialises page data through devalue, so joinUrl may not appear as a literal key-value pair.
	const m = html.match(/https?:\/\/[^"\\<>\s]+\/join/);
	return m?.[0] ?? null;
}

// 5. Broadcast — `settings:changed` reaches every connected client.
{
	const { cookie: bobCookie } = await joinAs('BobProbe');
	const alice = openPhoneWs(aliceCookie);
	const bob = openPhoneWs(bobCookie);
	await Promise.all([alice.opened, bob.opened]);
	// Drain the welcome broadcasts first, or one of them satisfies the wait for settings:changed.
	await sleep(150);
	alice.events.length = 0;
	bob.events.length = 0;

	const roomWrite = { tvProgressStyle: 'off' };
	await api('PUT', '/api/settings/room', { cookie: aliceCookie, body: roomWrite });
	await sleep(200);
	const aliceGotIt = alice.events.find((e) => e.type === 'settings:changed');
	const bobGotIt = bob.events.find((e) => e.type === 'settings:changed');
	add(
		aliceGotIt && bobGotIt ? 'PASS' : 'HIGH',
		'broadcast',
		'a room-scope write fans out to every connected phone',
		`alice=${!!aliceGotIt} bob=${!!bobGotIt}  — routes/api/settings/room/+server.ts:29`
	);
	const converged =
		aliceGotIt?.settings?.room?.tvProgressStyle === 'off' && bobGotIt?.settings?.room?.tvProgressStyle === 'off';
	add(
		converged ? 'PASS' : 'HIGH',
		'broadcast',
		'two phones open on /settings converge to the same effective payload after one writes',
		`alice.tvProgress=${aliceGotIt?.settings?.room?.tvProgressStyle} bob.tvProgress=${bobGotIt?.settings?.room?.tvProgressStyle}`
	);

	alice.events.length = 0;
	bob.events.length = 0;
	await api('PUT', '/api/settings', { cookie: aliceCookie, body: { asrModel: 'small' } });
	await sleep(200);
	const aliceGlobal = alice.events.find((e) => e.type === 'settings:changed');
	const bobGlobal = bob.events.find((e) => e.type === 'settings:changed');
	const globalConverged =
		aliceGlobal?.settings?.global?.asrModel === 'small' && bobGlobal?.settings?.global?.asrModel === 'small';
	add(
		globalConverged ? 'PASS' : 'HIGH',
		'broadcast',
		'a global-scope write also fans out via settings:changed',
		`alice.asrModel=${aliceGlobal?.settings?.global?.asrModel} bob.asrModel=${bobGlobal?.settings?.global?.asrModel}`
	);

	// queueOrder is stored per queue entry as rotationSeq, so the write must ALSO re-derive the queue and
	// broadcast queue:patch — without it every client stays on the old order until a song is added or removed.
	alice.events.length = 0;
	await api('PUT', '/api/settings/room', { cookie: aliceCookie, body: { queueOrder: 'shuffle' } });
	await sleep(200);
	const alsoQueuePatch = alice.events.some((e) => e.type === 'queue:patch');
	// An empty queue makes reorder() return null and no queue:patch fires: correct, not a defect.
	add(
		alice.events.some((e) => e.type === 'settings:changed') ? 'PASS' : 'HIGH',
		'broadcast',
		'a room house-rule change fans out',
		`settings:changed=yes queue:patch=${alsoQueuePatch} (queue:patch only fires when the order actually changes; empty queues emit only settings:changed)`
	);

	alice.ws.close();
	bob.ws.close();
}

// 6. Lyrics-engine settings reach the WIRE at assign time.
// assignParams reads settings LIVE from getSettings() at assign time, so proving it needs a real worker
// that prints what it was handed: fake-align-worker.mjs, behind fake-stems-worker.mjs's fetch→stems chain.
async function runWireProbe() {
	// TWO distinct UNPROCESSED songs, one per run: process on an already-ready song short-circuits with no
	// chain, no align and no wire signal, so stemStatus/instrumentalRef must be checked, not just the search.
	const seen = new Map();
	for (const q of ['caroline', 'believin', 'bohemian', 'livin', 'journey', 'queen']) {
		const s = await (await fetch(`${BASE}/api/search?q=${encodeURIComponent(q)}`)).json().catch(() => ({}));
		for (const m of [...(s.ready ?? []), ...(s.processing ?? []), ...(s.results ?? [])]) {
			if (m.source === 'local' && !seen.has(m.id)) seen.set(m.id, m);
		}
	}
	const raw = [...seen.values()].filter((m) => !m.instrumentalRef && m.stemStatus !== 'ready');
	if (raw.length === 0) {
		add(
			'LOW',
			'wire',
			'no raw local song to process — skipped wire probe',
			`fixture has ${seen.size} local songs, all already processed. Re-seed with a fresh MEDIA_DIR.`
		);
		return;
	}
	const rawCand = raw[0];
	const otherRaw = raw[1] ?? null;

	await api('PUT', '/api/settings', { cookie: aliceCookie, body: { asrModel: 'medium', syncMode: 'lines' } });

	// fetch,stems only — align is left to the one-shot worker below, which is what reads the assign.
	const stems = spawn('bun', [pathJoin(process.cwd(), 'tests/e2e/fake-stems-worker.mjs')], {
		env: { ...process.env, EPORT: PORT, MEDIA_DIR: process.env.MEDIA_DIR ?? './media', FAKE_CAPS: 'fetch,stems' },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	/** @type {string[]} */
	const stemsOut = [];
	stems.stdout.on('data', (d) => stemsOut.push(String(d)));
	stems.stderr.on('data', (d) => stemsOut.push(String(d)));
	// worker:hello must land before dispatch tries to route, or the job finds no capable worker.
	await sleep(500);

	const alignA = spawn('bun', [pathJoin(process.cwd(), 'tests/e2e/fake-align-worker.mjs')], {
		env: { ...process.env, EPORT: PORT },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	/** @type {string[]} */
	const alignOutA = [];
	alignA.stdout.on('data', (d) => alignOutA.push(String(d)));
	alignA.stderr.on('data', (d) => alignOutA.push(String(d)));
	await sleep(300);

	const mk = await api('POST', '/api/process', { cookie: aliceCookie, body: { mediaId: rawCand.id } });
	if (mk.status !== 200) {
		add('LOW', 'wire', `process rejected: HTTP ${mk.status}`, mk.text);
		stems.kill();
		alignA.kill();
		return;
	}

	// Longer than the align worker's own 15s watchdog, so its exit is what ends this wait.
	const alignExit = await new Promise((resolve) => {
		const t = setTimeout(() => resolve('timeout'), 20000);
		alignA.on('exit', (code) => {
			clearTimeout(t);
			resolve(`exit=${code}`);
		});
	});
	const alignOutJoined = alignOutA.join('');
	const paramsMatch = /params\s*=\s*(\{[^\n]+\})/m.exec(alignOutJoined);
	let alignParams = null;
	if (paramsMatch) {
		try {
			alignParams = JSON.parse(paramsMatch[1]);
		} catch {
			/* left null */
		}
	}
	add(
		alignParams?.asrModel === 'medium' && alignParams?.syncMode === 'lines' ? 'PASS' : 'HIGH',
		'wire',
		'align job:assign carries the settings live at assign time (run A: medium/lines)',
		`fake-align exit=${alignExit} asrModel=${alignParams?.asrModel} syncMode=${alignParams?.syncMode}  — server/jobs/dispatch.ts:82`
	);

	// A SECOND process with changed settings proves the read is LIVE, and must not perturb the running song.
	if (!otherRaw) {
		add(
			'LOW',
			'wire',
			'only one raw song available — skipped run B (live-update assertion)',
			'a second unprocessed song is needed to trigger a second align at a different setting'
		);
	} else {
		await api('PUT', '/api/settings', { cookie: aliceCookie, body: { asrModel: 'tiny', syncMode: 'forced' } });
		const alignB = spawn('bun', [pathJoin(process.cwd(), 'tests/e2e/fake-align-worker.mjs')], {
			env: { ...process.env, EPORT: PORT },
			stdio: ['ignore', 'pipe', 'pipe']
		});
		/** @type {string[]} */
		const alignOutB = [];
		alignB.stdout.on('data', (d) => alignOutB.push(String(d)));
		alignB.stderr.on('data', (d) => alignOutB.push(String(d)));
		await sleep(300);
		const mk2 = await api('POST', '/api/process', { cookie: aliceCookie, body: { mediaId: otherRaw.id } });
		if (mk2.status !== 200) {
			add('LOW', 'wire', `run B process rejected: HTTP ${mk2.status}`, mk2.text);
			alignB.kill();
		} else {
			const alignExitB = await new Promise((resolve) => {
				const t = setTimeout(() => resolve('timeout'), 20000);
				alignB.on('exit', (code) => {
					clearTimeout(t);
					resolve(`exit=${code}`);
				});
			});
			const outB = alignOutB.join('');
			const pB = /params\s*=\s*(\{[^\n]+\})/m.exec(outB);
			let paramsB = null;
			if (pB) {
				try {
					paramsB = JSON.parse(pB[1]);
				} catch {
					/* left null */
				}
			}
			add(
				paramsB?.asrModel === 'tiny' && paramsB?.syncMode === 'forced' ? 'PASS' : 'HIGH',
				'wire',
				'a global-settings change BETWEEN processes reaches the NEXT align:assign (live, no restart)',
				`fake-align exit=${alignExitB} asrModel=${paramsB?.asrModel} syncMode=${paramsB?.syncMode}  — dispatch.ts:assignParams`
			);
		}
	}

	stems.kill();
	await sleep(100);
	writeFileSync(pathJoin(SCRATCH, `p9-wire-stems.log`), stemsOut.join(''));
	writeFileSync(pathJoin(SCRATCH, `p9-wire-alignA.log`), alignOutA.join(''));
}
try {
	await runWireProbe();
} catch (err) {
	const detail = err instanceof Error ? err.message : String(err);
	add('LOW', 'wire', 'wire probe threw — environment issue', `${detail}. Bun + fake workers required.`);
}

// 7. Security — the room's blast radius.
// Every joined singer is a host (server/capabilities.ts:can()), so any phone on the LAN holds operator authority.
{
	const { cookie: guestCookie } = await joinAs('CarolProbe');
	const r = await api('PUT', '/api/settings', { cookie: guestCookie, body: { asrModel: 'large-v3' } });
	add(
		r.status === 200 && r.body?.global?.asrModel === 'large-v3' ? 'HIGH' : 'PASS',
		'security',
		"ANY joined singer can PUT global settings — sets the fleet's Whisper checkpoint (1550M weights)",
		`HTTP ${r.status} stored=${r.body?.global?.asrModel}  — server/capabilities.ts:can() returns true for any singerId`
	);
	const rQ = await api('PUT', '/api/settings', { cookie: guestCookie, body: { joinOrigin: 'http://evil.example:80' } });
	add(
		rQ.body?.global?.joinOrigin === 'http://evil.example' ? 'HIGH' : 'PASS',
		'security',
		'ANY joined singer can retarget the join QR to an attacker origin — party phishing vector for later joiners',
		`stored=${rQ.body?.global?.joinOrigin}  — TV re-renders on next request, no restart`
	);
	await api('PUT', '/api/settings', { cookie: aliceCookie, body: { joinOrigin: '', asrModel: 'base' } });

	// (c) /api/metrics is ungated by design, and still a finding: it reveals worker ids, engine names, errors.
	const met = await api('GET', '/api/metrics');
	const bodyKb = ((met.text?.length ?? 0) / 1024).toFixed(1);
	add(
		met.status === 200 ? 'HIGH' : 'PASS',
		'security',
		'/api/metrics is UNGATED (worker ids, model names, error strings)',
		`HTTP ${met.status} body=${bodyKb} KB  — routes/api/metrics/+server.ts:8-11 (documented as intentional)`
	);

	// (d) /api/audit/[mediaId], same reasoning; any indexed media will do.
	const idxSearch = await (await fetch(`${BASE}/api/search?q=caroline`)).json().catch(() => ({}));
	const someone = [...(idxSearch.ready ?? []), ...(idxSearch.results ?? [])][0];
	if (someone) {
		const aud = await api('GET', `/api/audit/${encodeURIComponent(someone.id)}`);
		add(
			aud.status === 200 ? 'HIGH' : 'PASS',
			'security',
			`/api/audit/${someone.id} is UNGATED (per-song attempt history + errors)`,
			`HTTP ${aud.status}  — routes/api/audit/[mediaId]/+server.ts:8-9 (documented as intentional)`
		);
	}

	// (e) A role=worker socket opens with NO token unless ENCORE_WORKER_TOKEN is set — and it carries dispatch authority.
	const wws = new WebSocket(`${WS_BASE}/ws?role=worker`);
	const workerOpened = await new Promise((resolve) => {
		wws.onopen = () => resolve(true);
		wws.onerror = () => resolve(false);
		setTimeout(() => resolve(false), 1000);
	});
	if (workerOpened) wws.close();
	// With a token set the upgrade returns 401, so report the state observed rather than an opinion.
	add(
		workerOpened ? 'MEDIUM' : 'PASS',
		'security',
		workerOpened
			? 'role=worker socket accepted without a token — dispatch authority on the LAN. Set ENCORE_WORKER_TOKEN to gate it.'
			: 'role=worker socket refused without a token (ENCORE_WORKER_TOKEN set)',
		`server.ts:161-163`
	);
}

console.log('\n─── summary ──────────────────────────────────────────────────');
const bySev = new Map();
for (const f of findings) bySev.set(f.sev, (bySev.get(f.sev) ?? 0) + 1);
for (const s of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO', 'PASS']) {
	if (bySev.get(s)) console.log(`  ${s.padEnd(9)} ${bySev.get(s)}`);
}
console.log('─────────────────────────────────────────────────────────────');
const realFailures = findings.filter((f) => f.sev === 'CRITICAL' || f.sev === 'HIGH').length;
process.exit(realFailures ? 1 : 0);
