// SETTINGS, THREE SCOPES, LIVE. Does a setting persist, refuse garbage, fan out to every connected client, and
// reach the WIRE — all without a restart, because a party cannot be rebooted.
//
// THE CLAIM THAT MATTERS IS "LIVE". Three sections below are only about that: a `joinOrigin` write must move
// the address /tv serves with no process restart; a write on one phone must reach every other phone as
// `settings:changed`; and the lyrics-engine settings must reach a worker's `job:assign` params, which
// `assignParams` reads LIVE at assign time — so a change BETWEEN two processes must show up on the SECOND
// assign. Proving the last one needs a worker that prints what it was handed, which is
// `startObservingWorker` (world/workers.ts): it advertises `align`, records every assign and claims nothing.
//
// NO BROWSER IN MOST OF THIS, DELIBERATELY. The subject is the settings API and the wire, and p9 drove both
// over HTTP and a raw socket. A page would add a rendering layer between the assertion and the thing asserted.
//
// THE RESTORES ARE GONE. p9 put every value back before the next section, because thirty sections shared one
// server. A core per test makes that dead code — and a test that has to undo itself cannot be read in
// isolation.
//
// SECTION 7 IS THE BLAST RADIUS. p9's security section reported the guest-is-a-host findings; proposal 30 closed
// them, so they are asserted CLOSED here: a joined guest cannot write settings or read /api/metrics, a page on
// another site cannot write or open a socket, and a role=worker socket without core's token (the one core makes
// on first boot, #1196) is refused. Every settings write elsewhere goes through the
// host key (`hostCookie`), which is what the boot link hands the host.
//
// WHAT IS DROPPED, NAMED. (1) p9's `EXPECTED_ENV_ORIGIN` arm — "clearing joinOrigin falls back to
// ENCORE_PUBLIC_ORIGIN" — was an INFO whenever the harness did not export that variable, which it never did,
// so there is no condition to move. `startCore({ env })` would make it reachable, but asserting it would be a
// NEW claim. (2) p9's closing "concurrency reduces to clientOpId dedupe" line is an unconditional PASS
// describing source code; it measures nothing, so there is nothing to port.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker, startObservingWorker } from '../../world/workers';
import { startCore, TEST_HOST_KEY } from '../../world/core';
import { WebSocket } from 'ws';
import { request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { World } from '../../world/fixtures';
import type { EffectiveSettings, RoomSettings } from '$lib/contract';

interface ApiResult {
	status: number;
	text: string;
	body: any;
	setCookie: string | null;
}

interface ApiOptions {
	cookie?: string | null;
	body?: unknown;
	/** A RAW body, for the malformed-JSON case, which must not be stringified. */
	raw?: string;
	/** An Origin header, for the request a page on another site would send. */
	origin?: string;
}

async function api(baseURL: string, method: string, path: string, opts: ApiOptions = {}): Promise<ApiResult> {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (opts.cookie) headers.Cookie = opts.cookie;
	if (opts.origin) headers.Origin = opts.origin;
	const res = await fetch(`${baseURL}${path}`, {
		method,
		headers,
		body: opts.raw !== undefined ? opts.raw : opts.body === undefined ? undefined : JSON.stringify(opts.body)
	});
	const text = await res.text();
	let parsed: any = null;
	if (text) {
		try {
			parsed = JSON.parse(text);
		} catch {
			/* left null — a non-JSON body is itself part of some cases' answer */
		}
	}
	return { status: res.status, text, body: parsed, setCookie: res.headers.get('set-cookie') };
}

/** The host session, from the key the test core boots with. Every settings write needs it; section 1 is about
 *  who is refused without it. */
async function hostCookie(baseURL: string): Promise<string> {
	const r = await api(baseURL, 'POST', '/api/host', { body: { key: TEST_HOST_KEY } });
	if (r.status !== 200) throw new Error(`POST /api/host: HTTP ${r.status} ${r.text}`);
	return (r.setCookie ?? '').split(';')[0]!.trim();
}

/** Join over HTTP and keep the session cookie: a singer's socket hears the room, and /api/process needs one. */
async function joinAs(baseURL: string, displayName: string): Promise<string> {
	const r = await api(baseURL, 'POST', '/api/join', { body: { displayName, color: '#7c5cff' } });
	if (r.status !== 200) throw new Error(`join failed for ${displayName}: HTTP ${r.status} ${r.text}`);
	const cookie = (r.setCookie ?? '').split(';')[0]?.trim();
	if (!cookie) throw new Error(`no cookie back from /api/join for ${displayName}`);
	return cookie;
}

async function getSettings(baseURL: string): Promise<EffectiveSettings> {
	const r = await api(baseURL, 'GET', '/api/settings');
	if (r.status !== 200) throw new Error(`GET /api/settings HTTP ${r.status}`);
	return r.body as EffectiveSettings;
}

interface PhoneSocket {
	/** Every frame this socket has received, oldest first. */
	readonly events: any[];
	close(): void;
}

/**
 * A phone socket carrying a singer's cookie, which is what makes it receive the room's broadcasts.
 *
 * `ws`, not the global WebSocket: presence and scoping are resolved from the cookie on the HANDSHAKE, and
 * Node's built-in WebSocket ignores a headers option silently — see world/presence.ts.
 *
 * p9 drained the first 150ms before looking, "or one of [the welcome broadcasts] satisfies the wait for
 * settings:changed". No drain here: every look below filters by frame TYPE, and each test performs exactly one
 * write against its own core, so there is no earlier `settings:changed` to confuse with the one it caused.
 */
async function openPhoneWs(baseURL: string, cookie: string): Promise<PhoneSocket> {
	const events: any[] = [];
	const ws = new WebSocket(`${baseURL.replace(/^http/, 'ws')}/ws?role=phone`, { headers: { Cookie: cookie } });
	ws.on('message', (raw: Buffer | string) => {
		try {
			events.push(JSON.parse(String(raw)));
		} catch {
			/* ignore malformed */
		}
	});
	await new Promise<void>((resolve, reject) => {
		ws.once('open', () => resolve());
		ws.once('error', (err: Error) => reject(new Error(`phone socket refused: ${err.message}`)));
	});
	return { events, close: () => ws.close() };
}

/** The earliest frame of a type, waited for rather than slept at. */
async function awaitFrame(socket: PhoneSocket, type: string, who: string): Promise<any> {
	await expect
		.poll(() => socket.events.filter((e) => e?.type === type).length, {
			message: `${who} never received a ${type} frame. Saw: ${socket.events.map((e) => e?.type).join(', ') || 'nothing'}`
		})
		.toBeGreaterThan(0);
	return socket.events.find((e) => e?.type === type);
}

interface SongRow {
	id: string;
	title: string;
	source: string;
	instrumentalRef?: string | null;
	stemStatus?: string;
}

/**
 * An UNPROCESSED local song. Process on an already-ready song short-circuits with no chain, no align and no
 * wire signal, so readiness is checked on `instrumentalRef`/`stemStatus` and not on the search alone.
 *
 * `world.awaitDemoTrack` first: the library scan is a detached boot pass, so a single search taken right after
 * boot can answer from an empty index and nothing re-runs it.
 */
async function rawLocalSong(world: World, query: string): Promise<SongRow> {
	await world.awaitDemoTrack(query);
	const body = (await (await fetch(`${world.baseURL}/api/search?q=${encodeURIComponent(query)}`)).json()) as {
		ready?: SongRow[];
		processing?: SongRow[];
		results?: SongRow[];
	};
	const all = [...(body.ready ?? []), ...(body.processing ?? []), ...(body.results ?? [])];
	const row = all.find((m) => m.source === 'local' && !m.instrumentalRef && m.stemStatus !== 'ready');
	if (!row) {
		throw new Error(
			`no raw local song matching "${query}" — the wire probe needs an UNPROCESSED song, and the demo ` +
				`library seeds four. Saw: ${JSON.stringify(all.map((m) => [m.id, m.stemStatus]))}`
		);
	}
	return row;
}

// ── 1. the auth boundary ─────────────────────────────────────────────────────────────────────────────────

test('anonymous and guest PUTs are refused on both settings scopes', async ({ world }) => {
	const guest = await joinAs(world.baseURL, 'GuestProbe');
	for (const [who, cookie] of [
		['anonymous', null],
		['a joined guest', guest]
	] as const) {
		const global = await api(world.baseURL, 'PUT', '/api/settings', { cookie, body: { syncMode: 'lines' } });
		expect(global.status, `${who} PUT /api/settings must be refused — routes/api/settings/+server.ts`).toBe(403);
		const room = await api(world.baseURL, 'PUT', '/api/settings/room', { cookie, body: { queueOrder: 'fcfs' } });
		expect(room.status, `${who} PUT /api/settings/room must be refused — routes/api/settings/room/+server.ts`).toBe(
			403
		);
	}
});

// ── 2. persistence ───────────────────────────────────────────────────────────────────────────────────────

/** Every id the contract names must be exercised by the persistence test; an uncovered one is a hole reported
 *  as green. Kept as the probe's own literal set rather than derived, so adding a setting breaks this. */
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

// NO `world`, so no core boots: this asks the contract about itself.
test('the persistence test covers every setting id the contract names', async () => {
	const missing = SEL.SETTING_IDS.filter((id) => !COVERED_IDS.has(id));
	expect(missing, `uncovered SEL.SETTING_IDS entries (${SEL.SETTING_IDS.length} total)`).toEqual([]);
});

/** The two scopes' controls, by their DOM id and the field each writes. */
const ROOM_WRITE = {
	queueOrder: 'fcfs',
	tvProgressStyle: 'corner',
	tvBackgroundStyle: 'solid',
	tvVisualizer: 'starfield',
	lyricsHighlight: 'line',
	lyricsBall: 'off',
	lyricsFont: 'grotesk',
	lyricsCase: 'upper'
} as const satisfies Partial<RoomSettings>;

const ROOM_ID_BY_FIELD: Record<keyof typeof ROOM_WRITE, string> = {
	queueOrder: 'queue-order',
	tvProgressStyle: 'tv-progress',
	tvBackgroundStyle: 'tv-background',
	tvVisualizer: 'tv-visualizer',
	lyricsHighlight: 'lyrics-highlight',
	lyricsBall: 'lyrics-ball',
	lyricsFont: 'lyrics-font',
	lyricsCase: 'lyrics-case'
};

// ONE test for ten controls, because they are not independently falsifiable here: the room normalizer rejects
// PER FIELD to the CURRENT value, so only a FULL round-trip says which field took — one PUT, one reply, ten
// readings of it. The follow-up GET then depends on both scopes' writes, which is why it cannot be its own
// test either.
test('every settings control round-trips, and a follow-up GET proves SQLite rather than memory', async ({ world }) => {
	const cookie = await hostCookie(world.baseURL);

	const joinOrigin = 'http://phones.example:8080';
	const patch1 = await api(world.baseURL, 'PUT', '/api/settings', { cookie, body: { joinOrigin } });
	expect(
		patch1.body?.global?.joinOrigin,
		'#join-origin must persist via PUT /api/settings — contract/core/settings.ts:normalizeJoinOrigin'
	).toBe(joinOrigin);

	const patch2 = await api(world.baseURL, 'PUT', '/api/settings', { cookie, body: { syncMode: 'lines' } });
	expect(patch2.body?.global?.syncMode, '#sync-mode must persist via PUT /api/settings').toBe('lines');

	const written = await api(world.baseURL, 'PUT', '/api/settings/room', { cookie, body: ROOM_WRITE });
	const room = (written.body?.room ?? {}) as Partial<RoomSettings>;
	for (const [field, want] of Object.entries(ROOM_WRITE) as [keyof typeof ROOM_WRITE, string][]) {
		expect(room[field], `#${ROOM_ID_BY_FIELD[field]} must persist via PUT /api/settings/room`).toBe(want);
	}

	// A follow-up GET, because the write endpoint's own reply could be in-memory only.
	const roundtrip = await getSettings(world.baseURL);
	expect(
		{
			queueOrder: roundtrip.room.queueOrder,
			syncMode: roundtrip.global.syncMode,
			joinOrigin: roundtrip.global.joinOrigin
		},
		'GET /api/settings must return the values just written'
	).toEqual({ queueOrder: 'fcfs', syncMode: 'lines', joinOrigin });
});

// ── 3. validation ────────────────────────────────────────────────────────────────────────────────────────

// ONE test, eleven cases, for the reason the probe states: reject-to-current is PER FIELD, so a sibling must
// survive its neighbour's junk — which is only visible if every case is measured against ONE baseline taken
// before any of them ran. Each case names itself in its own message.
test('garbage in a settings write degrades to the current value, per field', async ({ world }) => {
	const cookie = await hostCookie(world.baseURL);
	const baseline = await getSettings(world.baseURL);

	const cases: { scope: 'global' | 'room'; body: Record<string, unknown>; field: string; expected: unknown }[] = [
		{ scope: 'global', body: { syncMode: 'no-thanks' }, field: 'syncMode', expected: baseline.global.syncMode },
		{ scope: 'global', body: { asrModel: '../../etc/passwd' }, field: 'asrModel', expected: baseline.global.asrModel },
		{
			scope: 'global',
			body: { defaultEngine: 'roformer', defaultModel: 'nope-9000' },
			field: 'defaultModel',
			expected: baseline.global.defaultModel
		},
		{
			scope: 'global',
			body: { joinOrigin: 'javascript:alert(1)' },
			field: 'joinOrigin',
			expected: baseline.global.joinOrigin
		},
		{ scope: 'global', body: { joinOrigin: 'not a url' }, field: 'joinOrigin', expected: baseline.global.joinOrigin },
		{ scope: 'room', body: { queueOrder: 'fifo' }, field: 'queueOrder', expected: baseline.room.queueOrder },
		{
			scope: 'room',
			body: { tvProgressStyle: 'DROP TABLE' },
			field: 'tvProgressStyle',
			expected: baseline.room.tvProgressStyle
		},
		{
			// A colour, not an angle: the interesting junk is an unparseable colour reaching a style attribute.
			scope: 'room',
			body: { tvBackgroundColor: 'rebeccapurple' },
			field: 'tvBackgroundColor',
			expected: baseline.room.tvBackgroundColor
		},
		{ scope: 'room', body: { lyricsBall: 'wormhole' }, field: 'lyricsBall', expected: baseline.room.lyricsBall },
		{ scope: 'room', body: { songIntroMs: -99999 }, field: 'songIntroMs', expected: 500 /* MIN_SONG_INTRO_MS */ },
		{ scope: 'room', body: { songIntroMs: 99999999 }, field: 'songIntroMs', expected: 10000 /* MAX_SONG_INTRO_MS */ }
	];

	for (const c of cases) {
		const path = c.scope === 'global' ? '/api/settings' : '/api/settings/room';
		const r = await api(world.baseURL, 'PUT', path, { cookie, body: c.body });
		const bucket = (c.scope === 'global' ? r.body?.global : r.body?.room) as Record<string, unknown> | undefined;
		expect(
			bucket?.[c.field],
			`${c.scope}.${c.field}: garbage ${JSON.stringify(c.body[c.field])} must degrade to ` +
				`${JSON.stringify(c.expected)}`
		).toBe(c.expected);
	}
});

test('a malformed or exotic JSON body is refused without a 500', async ({ world }) => {
	const cookie = await hostCookie(world.baseURL);

	const malformed = await api(world.baseURL, 'PUT', '/api/settings', { cookie, raw: 'not-json' });
	expect(malformed.status, 'a malformed JSON body must 400 rather than 500 — routes/api/settings/+server.ts').toBe(400);
	// The handler reads request.json(), so null, an array and a top-level string all parse. Watch for a crash.
	const nullBody = await api(world.baseURL, 'PUT', '/api/settings', { cookie, body: null });
	expect(
		nullBody.status,
		'a top-level JSON `null` body must be handled — settings-repository.ts:setGlobal(null|undefined)'
	).toBeLessThan(500);
	const arrayBody = await api(world.baseURL, 'PUT', '/api/settings', { cookie, body: [1, 2, 3] });
	expect(arrayBody.status, 'a top-level JSON array body must be handled').toBeLessThan(500);
});

// ── 4. joinOrigin, live ──────────────────────────────────────────────────────────────────────────────────

/**
 * SvelteKit serialises page data through devalue, which writes an OBJECT LITERAL — `joinUrl:"…"`, with the key
 * UNQUOTED — not JSON. p9 matched `"joinUrl":"…"` and fell back to any URL ending in `/join`; neither can match
 * the app as it stands (the key is unquoted, and the advertised address is `<origin>/?room=CODE`, a path that
 * never was `/join`), so its extraction returned null and its assertion could only ever have been vacuous.
 * BOTH key spellings are accepted here, and the assertion — the served address starts with the setting — is
 * p9's own. `joinUrl` is the string the QR image encodes (routes/tv/+page.server.ts), so this is the address a
 * phone is actually sent to, not an echo of the value just written.
 */
function extractJoinUrl(html: string): string | null {
	return html.match(/"?joinUrl"?:\s*"([^"]+)"/)?.[1] ?? null;
}

test('a runtime joinOrigin write moves the address /tv serves, with no restart', async ({ world }) => {
	const cookie = await hostCookie(world.baseURL);
	const target = 'http://runtime-fix.example:1234';
	await api(world.baseURL, 'PUT', '/api/settings', { cookie, body: { joinOrigin: target } });

	const html = await (await fetch(`${world.baseURL}/tv`)).text();
	const joinUrl = extractJoinUrl(html);
	expect(
		joinUrl?.startsWith(target),
		`the settings write must reach /tv's joinUrl with no process restart — server/public-origin.ts:joinOrigin. ` +
			`/tv served joinUrl=${joinUrl}`
	).toBe(true);
});

// ── 5. the broadcast ─────────────────────────────────────────────────────────────────────────────────────

test('a room-scope write fans out to every connected phone, carrying the same effective payload', async ({ world }) => {
	const aliceCookie = await joinAs(world.baseURL, 'AliceProbe');
	const bobCookie = await joinAs(world.baseURL, 'BobProbe');
	const alice = await openPhoneWs(world.baseURL, aliceCookie);
	const bob = await openPhoneWs(world.baseURL, bobCookie);
	try {
		const host = await hostCookie(world.baseURL);
		await api(world.baseURL, 'PUT', '/api/settings/room', { cookie: host, body: { tvProgressStyle: 'off' } });

		const aliceFrame = await awaitFrame(alice, 'settings:changed', 'alice (the writer)');
		const bobFrame = await awaitFrame(bob, 'settings:changed', 'bob (the other phone)');
		// Two phones on /settings must converge on ONE payload: a client that had to merge two events to know
		// the effective state would show a different room from its neighbour.
		expect(
			[aliceFrame?.settings?.room?.tvProgressStyle, bobFrame?.settings?.room?.tvProgressStyle],
			'both phones must see the written value in the frame — routes/api/settings/room/+server.ts'
		).toEqual(['off', 'off']);
	} finally {
		alice.close();
		bob.close();
	}
});

test('a global-scope write also fans out via settings:changed', async ({ world }) => {
	const aliceCookie = await joinAs(world.baseURL, 'AliceProbe');
	const bobCookie = await joinAs(world.baseURL, 'BobProbe');
	const alice = await openPhoneWs(world.baseURL, aliceCookie);
	const bob = await openPhoneWs(world.baseURL, bobCookie);
	try {
		const host = await hostCookie(world.baseURL);
		await api(world.baseURL, 'PUT', '/api/settings', { cookie: host, body: { asrModel: 'small' } });

		const aliceFrame = await awaitFrame(alice, 'settings:changed', 'alice (the writer)');
		const bobFrame = await awaitFrame(bob, 'settings:changed', 'bob (the other phone)');
		expect(
			[aliceFrame?.settings?.global?.asrModel, bobFrame?.settings?.global?.asrModel],
			'a deployment-scope write must reach every phone too'
		).toEqual(['small', 'small']);
	} finally {
		alice.close();
		bob.close();
	}
});

test('a room house-rule change fans out', async ({ world }) => {
	const cookie = await joinAs(world.baseURL, 'AliceProbe');
	const alice = await openPhoneWs(world.baseURL, cookie);
	try {
		// queueOrder is stored per queue entry as rotationSeq, so the write must ALSO re-derive the queue and
		// broadcast queue:patch — without it every client stays on the old order until a song is added or
		// removed. An EMPTY queue makes reorder() return null and no queue:patch fires: correct, not a defect,
		// which is why only settings:changed is asserted and the other is reported.
		const host = await hostCookie(world.baseURL);
		await api(world.baseURL, 'PUT', '/api/settings/room', { cookie: host, body: { queueOrder: 'shuffle' } });
		await awaitFrame(alice, 'settings:changed', 'alice');
		const alsoQueuePatch = alice.events.some((e) => e?.type === 'queue:patch');
		expect(
			alice.events.filter((e) => e?.type === 'settings:changed').length,
			`a house-rule change must fan out (queue:patch=${alsoQueuePatch}; it fires only when the order ` +
				`actually changes, and this room's queue is empty)`
		).toBeGreaterThan(0);
	} finally {
		alice.close();
	}
});

// ── 6. the wire ──────────────────────────────────────────────────────────────────────────────────────────

// ONE test for two assertions, because the second one IS the first one happening twice: "live" means the
// SECOND assign carries what was written between them, which cannot be asserted without the first.
test('the lyrics-engine settings reach job:assign live, and a change between processes reaches the NEXT one', async ({
	world
}) => {
	const cookie = await joinAs(world.baseURL, 'AliceProbe');
	const songA = await rawLocalSong(world, 'caroline');
	const songB = await rawLocalSong(world, 'believin');

	// fetch+stems only on the CLAIMING worker: align is left to the observer, which is what reads the assign.
	// A local library file needs no fetch, but advertising it costs nothing and matches the old pair.
	const chain = await startFakeWorker(world, { capabilities: ['fetch', 'stems'] });
	const observer = await startObservingWorker(world);
	try {
		const host = await hostCookie(world.baseURL);
		await api(world.baseURL, 'PUT', '/api/settings', { cookie: host, body: { asrModel: 'medium', syncMode: 'lines' } });
		const startA = await api(world.baseURL, 'POST', '/api/process', { cookie, body: { mediaId: songA.id } });
		expect(startA.status, `/api/process refused "${songA.title}": ${startA.text}`).toBe(200);

		const assignA = await observer.awaitAssign({ jobType: 'align', mediaId: songA.id, timeout: 45_000 });
		expect(
			{ asrModel: assignA.params.asrModel, syncMode: assignA.params.syncMode },
			`the align assign must carry the settings live at assign time — server/jobs/dispatch.ts:assignParams` +
				`\n\n${observer.log()}`
		).toEqual({ asrModel: 'medium', syncMode: 'lines' });

		// A SECOND process with CHANGED settings proves the read is LIVE rather than captured at boot.
		await api(world.baseURL, 'PUT', '/api/settings', { cookie: host, body: { asrModel: 'tiny', syncMode: 'forced' } });
		const startB = await api(world.baseURL, 'POST', '/api/process', { cookie, body: { mediaId: songB.id } });
		expect(startB.status, `/api/process refused "${songB.title}": ${startB.text}`).toBe(200);

		const assignB = await observer.awaitAssign({ jobType: 'align', mediaId: songB.id, timeout: 45_000 });
		expect(
			{ asrModel: assignB.params.asrModel, syncMode: assignB.params.syncMode },
			`a global-settings change BETWEEN processes must reach the NEXT align assign, with no restart` +
				`\n\n${observer.log()}`
		).toEqual({ asrModel: 'tiny', syncMode: 'forced' });
	} finally {
		await observer.stop();
		await chain.stop();
	}
});

// ── 7. the blast radius ──────────────────────────────────────────────────────────────────────────────────

test('a joined guest holds no operator authority over either settings scope', async ({ world }) => {
	const guest = await joinAs(world.baseURL, 'CarolProbe');

	// p9's finding was "ANY joined singer can PUT global settings — sets the fleet's Whisper checkpoint". Closed.
	const model = await api(world.baseURL, 'PUT', '/api/settings', { cookie: guest, body: { asrModel: 'large-v3' } });
	expect(model.status, 'a guest cookie cannot set the ASR checkpoint — server/capabilities.ts:can()').toBe(403);

	// And "ANY joined singer can retarget the join QR to an attacker origin". Closed: the QR keeps its address.
	const origin = await api(world.baseURL, 'PUT', '/api/settings', {
		cookie: guest,
		body: { joinOrigin: 'http://evil.example:80' }
	});
	expect(origin.status, 'a guest cookie cannot retarget the join QR').toBe(403);
	expect((await getSettings(world.baseURL)).global.joinOrigin).toBe('');
});

test('a page on another site can neither write with the host cookie nor open a socket', async ({ world }) => {
	const host = await hostCookie(world.baseURL);
	const csrf = await api(world.baseURL, 'PUT', '/api/settings', {
		cookie: host,
		origin: 'http://evil.example',
		body: { joinOrigin: 'http://evil.example' }
	});
	expect(csrf.status, 'a cross-site PUT carrying the host cookie — src/hooks.server.ts').toBe(403);

	const guest = await joinAs(world.baseURL, 'DanProbe');
	const ws = new WebSocket(`${world.baseURL.replace(/^http/, 'ws')}/ws?role=phone`, {
		headers: { Cookie: guest, Origin: 'http://evil.example' }
	});
	const status = await new Promise<number | 'open'>((resolve) => {
		ws.once('open', () => resolve('open'));
		ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
		ws.once('error', () => {});
	});
	ws.close();
	expect(status, 'a cross-site WebSocket carrying a guest cookie — server.ts').toBe(403);
});

test('the operator JSON is the host only, and the worker socket is open by design without a token', async ({
	world
}) => {
	// (a) /api/metrics reveals worker ids, model names and error strings: the host's.
	const metrics = await api(world.baseURL, 'GET', '/api/metrics');
	expect(metrics.status, '/api/metrics refuses a cookieless caller — src/hooks.server.ts').toBe(403);

	// (b) /api/audit/[mediaId]: the attempt history and its errors are the host's; anyone gets the catalog row.
	const someone = await world.awaitDemoTrack('caroline');
	const audit = await api(world.baseURL, 'GET', `/api/audit/${encodeURIComponent(someone.id)}`);
	expect(Object.keys(audit.body ?? {}), `/api/audit/${someone.id} — routes/api/audit/[mediaId]/+server.ts`).toEqual([
		'media'
	]);

	// (c) a role=worker socket carries dispatch authority. `world` boots core with NO ENCORE_WORKER_TOKEN, so
	// core made one (#1196): a socket without it is refused, one with it opens, and the token is never served.
	const dialWorker = (token: string | null) =>
		new Promise<number | 'open'>((resolve) => {
			const query = token ? `&token=${encodeURIComponent(token)}` : '';
			const ws = new WebSocket(`${world.baseURL.replace(/^http/, 'ws')}/ws?role=worker${query}`);
			ws.once('open', () => (ws.close(), resolve('open')));
			ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
			ws.once('error', () => resolve(0));
			setTimeout(() => resolve(0), 5_000);
		});
	const token = world.core.workerToken();
	expect(token, `core made no worker token\n\n${world.core.log()}`).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(await dialWorker(null), 'a role=worker socket with no token — server.ts must 401 it').toBe(401);
	expect(await dialWorker(`${token}x`), 'a wrong token must 401').toBe(401);
	expect(await dialWorker(token), "core's own token must open the socket").toBe('open');
	expect(world.core.log(), 'core logs where the token is, never the token').not.toContain(token!);
});

test('with MEDIA_DIR=X and DATA_DIR=X/data core boots with a warning, and /media 404s the token it made', async () => {
	// Core's default puts the token at DATA_DIR/../auth, which this layout places inside MEDIA_DIR (#1202, #1213).
	const root = mkdtempSync(join(tmpdir(), 'enc-p9-layout-'));
	const dataDir = join(root, 'data');
	mkdirSync(dataDir, { recursive: true });
	const real = join(root, 'auth', 'worker-token');
	try {
		// An empty ENCORE_WORKER_TOKEN_FILE is core's default, as on a hand-configured box.
		const core = await startCore({ mediaDir: root, dataDir, env: { ENCORE_WORKER_TOKEN_FILE: '' } });
		try {
			// Polled: /health can answer before the boot line reaches the captured output.
			await expect
				.poll(() => core.log(), { message: 'the one-folder layout is said at boot' })
				.toContain('/media never serves it');
			const token = readFileSync(real, 'utf8').trim();
			expect(token.length).toBeGreaterThanOrEqual(24);
			for (const ref of ['auth/worker-token', 'auth%2Fworker-token', 'AUTH/worker-token', 'auth/']) {
				const served = await fetch(`${core.baseURL}/media/${ref}`);
				expect(served.status, `GET /media/${ref}`).toBe(404);
				expect(await served.text()).not.toContain(token);
			}
		} finally {
			await core.stop();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

/** A request with the path sent byte for byte: `fetch` would resolve `..` and `.` before it left. */
function rawRequest(
	baseURL: string,
	method: string,
	path: string,
	headers: Record<string, string>,
	body?: string
): Promise<{ status: number; text: string }> {
	const { hostname, port } = new URL(baseURL);
	return new Promise((resolve, reject) => {
		const req = httpRequest({ hostname, port, method, path, headers }, (res) => {
			let text = '';
			res.on('data', (d: Buffer) => (text += d.toString()));
			res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
		});
		req.on('error', reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

// Every spelling of a gated path a browser or a client can send: percent-encoded letters and slashes, double
// encoding, mixed case, a trailing slash, an empty segment and dot segments.
const METRICS_SPELLINGS = [
	'/api/metrics',
	'/api/%6Detrics',
	'/%61pi/metrics',
	'/api/metric%73',
	'/api/%6detrics',
	'/API/metrics',
	'/api/metrics/',
	'/api//metrics',
	'/api/./metrics',
	'/api/x/../metrics',
	'/api%2Fmetrics',
	'/api/%256Detrics',
	'/api/metrics?format=csv'
];
const PAGE_SPELLINGS = [
	'/metrics',
	'/%6Detrics',
	'/metrics/',
	'/%61dmin',
	'/admin/',
	'/x/../admin',
	'/metrics/%2E%2E/admin'
];
const SIZES_SPELLINGS = [
	'/api/library/sizes',
	'/api/library/%73izes',
	'/%61pi/library/sizes',
	'/API/library/sizes',
	'/api/library/sizes/',
	'/api/x/../library/sizes'
];

test('no spelling of a gated path reaches it without the host key', async ({ world }) => {
	const guest = await joinAs(world.baseURL, 'EncodedProbe');
	const host = await hostCookie(world.baseURL);
	for (const [who, cookie] of [
		['cookieless', ''],
		['a guest', guest]
	] as const) {
		const headers: Record<string, string> = cookie ? { cookie } : {};
		for (const path of METRICS_SPELLINGS) {
			const r = await rawRequest(world.baseURL, 'GET', path, headers);
			expect(r.status, `${who} GET ${path} — ${r.text.slice(0, 80)}`).not.toBe(200);
			expect(r.text, `${who} GET ${path} leaked the metrics`).not.toContain('"workers"');
		}
		for (const path of PAGE_SPELLINGS) {
			const r = await rawRequest(world.baseURL, 'GET', path, headers);
			expect(r.status, `${who} GET ${path}`).not.toBe(200);
		}
		for (const path of SIZES_SPELLINGS) {
			const r = await rawRequest(world.baseURL, 'GET', path, headers);
			expect(r.status, `${who} GET ${path}`).not.toBe(200);
			expect(r.text, `${who} GET ${path} leaked the sizes`).not.toContain('totalBytes');
		}
	}
	// The host still gets the real thing, so the refusals above are the gate and not a broken route.
	expect((await rawRequest(world.baseURL, 'GET', '/api/%6Detrics', { cookie: host })).status).toBe(200);
	expect((await rawRequest(world.baseURL, 'GET', '/api/library/%73izes', { cookie: host })).text).toContain(
		'totalBytes'
	);
});

test('no spelling of a mutating path lets another site, or a no-cors post, act with a cookie', async ({ world }) => {
	const guest = await joinAs(world.baseURL, 'CsrfProbe');
	const host = await hostCookie(world.baseURL);
	const both = `${guest}; ${host}`;
	const otherPort = `http://127.0.0.1:${Number(new URL(world.baseURL).port) + 1}`;
	const ours = world.baseURL;
	const routes: [string, string, string][] = [
		['POST', '/api/leave', '{}'],
		['POST', '/api/delete-media', '{"mediaId":"nope"}'],
		['POST', '/api/lyrics-reselect', '{"mediaId":"nope","text":"x"}'],
		['POST', '/api/lyrics-edit', '{"mediaId":"nope","rev":0,"lines":[{"text":"x"}]}'],
		['POST', '/api/lyrics-edit/undo', '{"mediaId":"nope","rev":0}'],
		['POST', '/api/lyrics-edit/auto', '{"mediaId":"nope","rev":0}'],
		['POST', '/api/library/manage/rename', '{"mediaId":"nope","title":"x","artist":""}'],
		['POST', '/api/library/manage/keep', '{"mediaId":"nope","keep":true}'],
		['POST', '/api/library/manage/delete', '{"mediaId":"nope"}'],
		['POST', '/api/library/manage/undo', '{"mediaId":"nope"}'],
		['POST', '/api/library/manage/bulk', '{"action":"delete","mediaIds":["nope"]}'],
		['POST', '/api/library/manage/remake', '{"mediaId":"nope"}'],
		['POST', '/api/join', '{"displayName":"Evil","color":"#ff0000"}'],
		['PUT', '/api/settings', '{"joinOrigin":"http://evil.example"}'],
		['PUT', '/api/settings/room', '{"queueOrder":"fcfs"}'],
		['DELETE', '/api/host', ''],
		['PATCH', '/api/me', '{"displayName":"Evil"}']
	];
	for (const [method, path, body] of routes) {
		const spellings = [
			path,
			path.replace('/api/', '/%61pi/'),
			path.replace('/api/', '/API/'),
			`${path}/`,
			`/x/..${path}`
		];
		for (const p of spellings) {
			const cross = await rawRequest(
				world.baseURL,
				method,
				p,
				{ cookie: both, origin: otherPort, 'content-type': 'application/json' },
				body
			);
			// SvelteKit answers a trailing slash with a 308 before any hook, and the followed request is checked here.
			const refusedOr308 = (refusal: number) => (p.endsWith('/') ? [refusal, 308] : [refusal]);
			expect(refusedOr308(403), `${method} ${p} from another port`).toContain(cross.status);
			if (!body) continue;
			// fetch(url, { mode: 'no-cors', body: new Blob([json]) }) sends a body with no Content-Type.
			const noCors = await rawRequest(world.baseURL, method, p, { cookie: both, origin: ours }, body);
			expect(refusedOr308(415), `${method} ${p} with no Content-Type`).toContain(noCors.status);
		}
	}
	// None of it landed: the guest is still joined and the join address is untouched.
	expect((await api(world.baseURL, 'GET', '/api/me', { cookie: guest })).status).toBe(200);
	expect((await getSettings(world.baseURL)).global.joinOrigin).toBe('');
});

/** Every write that changes the machine or a library song for every room. A guest runs the party, not these. */
const HOST_ONLY_WRITES: [string, string, (mediaId: string) => string][] = [
	['PUT', '/api/settings', () => '{"joinOrigin":"http://evil.example"}'],
	['PUT', '/api/settings/room', () => '{"queueOrder":"fcfs"}'],
	['POST', '/api/delete-media', (id) => JSON.stringify({ mediaId: id })],
	['POST', '/api/lyrics-reselect', (id) => JSON.stringify({ mediaId: id, text: 'not the words' })],
	['POST', '/api/lyrics-edit', (id) => JSON.stringify({ mediaId: id, rev: 0, lines: [{ text: 'not the words' }] })],
	['POST', '/api/lyrics-edit/undo', (id) => JSON.stringify({ mediaId: id, rev: 0 })],
	['POST', '/api/lyrics-edit/auto', (id) => JSON.stringify({ mediaId: id, rev: 0 })],
	['POST', '/api/library/manage/rename', (id) => JSON.stringify({ mediaId: id, title: 'Hijacked', artist: '' })],
	['POST', '/api/library/manage/keep', (id) => JSON.stringify({ mediaId: id, keep: true })],
	['POST', '/api/library/manage/delete', (id) => JSON.stringify({ mediaId: id })],
	['POST', '/api/library/manage/undo', (id) => JSON.stringify({ mediaId: id })],
	['POST', '/api/library/manage/remake', (id) => JSON.stringify({ mediaId: id })],
	['POST', '/api/host/people/reset', () => '{"personId":"anyone"}'],
	['POST', '/api/host/tonight', () => ''],
	['POST', '/api/library/manage/bulk', (id) => JSON.stringify({ action: 'delete', mediaIds: [id] })],
	['POST', '/api/library/manage/bulk', (id) => JSON.stringify({ action: 'keep', mediaIds: [id] })],
	['DELETE', '/api/host', () => '']
];

test('every host-only write refuses a guest and a cookieless caller, in every spelling', async ({ world }) => {
	const guest = await joinAs(world.baseURL, 'HostOnlyProbe');
	const song = await world.awaitDemoTrack('caroline');
	for (const [method, path, body] of HOST_ONLY_WRITES) {
		for (const p of [path, path.replace('/api/', '/%61pi/'), `/x/..${path}`]) {
			for (const [who, cookie] of [
				['cookieless', ''],
				['a guest', guest]
			] as const) {
				const headers: Record<string, string> = { origin: world.baseURL, 'content-type': 'application/json' };
				if (cookie) headers.cookie = cookie;
				const r = await rawRequest(world.baseURL, method, p, headers, body(song.id) || undefined);
				expect(r.status, `${who} ${method} ${p} — ${r.text.slice(0, 80)}`).toBe(403);
			}
		}
	}
	// The song is still in the library, with no re-time queued.
	const search = (await (await fetch(`${world.baseURL}/api/search?q=caroline`)).json()) as {
		ready?: { id: string }[];
		processing?: { id: string }[];
		results?: { id: string }[];
	};
	const all = [...(search.ready ?? []), ...(search.processing ?? []), ...(search.results ?? [])];
	expect(all.some((m) => m.id === song.id)).toBe(true);
});
