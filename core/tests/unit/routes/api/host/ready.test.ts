// Ready for tonight (proposal 39): each fact turns its own row, a check that has not answered is never green, and
// the routes are the host's alone. Through the real hub, registry and routes; only the sockets are stand-ins.
import { test, expect, afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migratedDb } from '$lib/server/db/test-db';
import { HostKey } from '$lib/server/host-key';
import { SingerRepository, SESSION_COOKIE } from '$lib/server/singers/repository';
import { WorkerRegistry } from '$lib/server/jobs/registry';
import { validateWorkerMessage } from '$lib/server/jobs/worker-hub';
import { readyRows, READY_TIMEOUT_MS, type ReadyFacts, type ReadyRowId, type ReadyState } from '$lib/ready';
import { resetReadyForTests } from '$lib/server/ready';
import { POST as hostPost } from '$routes/api/host/+server';
import { GET as getReady } from '$routes/api/host/ready/+server';
import { POST as recheckReady } from '$routes/api/host/ready/recheck/+server';
import { POST as chimeReady } from '$routes/api/host/ready/chime/+server';
import { workerNotes, type WorkerCommand } from '$lib/contract';

const APP_KEY = Symbol.for('encore.app');
const KEY = 'correct-horse-battery-staple';
const ORIGIN = 'http://192.168.1.20:3000';
const T0 = 1_700_000_000_000;

const GAP = { code: 'youtube-gap', text: 'YouTube downloads will fail without deno on PATH' };
const LOST = {
	code: 'lyrics-unreachable',
	text: "Can't reach the lyrics service, so songs will use heard words, which are less accurate and slower.",
	detail: 'lrcmux: TLS'
};

let root: string;
let saved: string | undefined;
beforeEach(() => {
	saved = process.env.MEDIA_DIR;
	root = mkdtempSync(join(tmpdir(), 'encore-ready-'));
	process.env.MEDIA_DIR = root;
});
afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
	resetReadyForTests();
	if (saved === undefined) delete process.env.MEDIA_DIR;
	else process.env.MEDIA_DIR = saved;
	rmSync(root, { recursive: true, force: true });
});

function facts(over: Partial<ReadyFacts> = {}): ReadyFacts {
	return {
		now: T0,
		tvName: 'Living room TV',
		audio: 'ok',
		workers: [{ capabilities: ['stems', 'align', 'fetch:ytdlp'], device: 'cpu', notes: [], lyricsAt: T0 }],
		canMake: true,
		typicalMinutes: 3,
		recheckAt: null,
		roomForSongs: 140,
		...over
	};
}
const byId = (f: ReadyFacts) => new Map(readyRows(f).map((r) => [r.id, r]));
const states = (f: ReadyFacts) => Object.fromEntries(readyRows(f).map((r) => [r.id, r.state]));
const ALL_GREEN: Record<ReadyRowId, ReadyState> = {
	tv: 'green',
	sound: 'green',
	maker: 'green',
	youtube: 'green',
	lyrics: 'green',
	room: 'green'
};

test('everything working is six green rows, in the proposal’s words', () => {
	expect(states(facts())).toEqual(ALL_GREEN);
	expect(readyRows(facts()).map((r) => r.status)).toEqual([
		'Living room TV is on and holding the room',
		'The TV can play sound',
		'Ready · cpu · about 3 min a song',
		'Downloads work',
		'Lyrics lookups work',
		'Room for about 140 more songs'
	]);
	// A green row offers nothing to do.
	expect(readyRows(facts()).every((r) => r.fix === undefined)).toBe(true);
});

test('each fact turns its own row red, with one fix line, and leaves the others green', () => {
	const cases: [Partial<ReadyFacts>, ReadyRowId, string][] = [
		[{ tvName: null }, 'tv', 'Open the TV link on the big screen.'],
		[{ audio: 'locked' }, 'sound', 'Tap the TV screen once.'],
		[{ canMake: false }, 'maker', 'Check the karaoke maker’s setup.'],
		[
			{ workers: [{ capabilities: ['stems', 'align', 'fetch:ytdlp'], notes: [GAP], lyricsAt: T0 }] },
			'youtube',
			'The karaoke maker is missing deno on PATH.'
		],
		[
			{ workers: [{ capabilities: ['stems', 'align', 'fetch:ytdlp'], notes: [LOST], lyricsAt: T0 }] },
			'lyrics',
			"Songs will use heard words, which are less accurate and slower. Check this box's internet."
		],
		[{ roomForSongs: 6 }, 'room', 'Clear space in Library.']
	];
	for (const [over, id, fix] of cases) {
		const rows = byId(facts(over));
		expect(rows.get(id)?.state, id).toBe('red');
		expect(rows.get(id)?.fix, id).toBe(fix);
		const others = readyRows(facts(over)).filter((r) => r.id !== id && !(id === 'tv' && r.id === 'sound'));
		expect(
			others.every((r) => r.state === 'green'),
			id
		).toBe(true);
	}
	expect(byId(facts({ roomForSongs: 6 })).get('room')?.status).toBe('Almost full: room for 6 more');
	// The technical line is kept for Details.
	expect(byId(facts({ workers: [{ capabilities: [], notes: [LOST], lyricsAt: T0 }] })).get('lyrics')?.detail).toBe(
		'lrcmux: TLS'
	);
});

test('no karaoke maker is red on every row it feeds, and says start it', () => {
	const rows = byId(facts({ workers: [], canMake: false }));
	for (const id of ['maker', 'youtube', 'lyrics'] as const) {
		expect(rows.get(id)?.state, id).toBe('red');
		expect(rows.get(id)?.fix, id).toBe('Start the karaoke maker.');
	}
});

test('a check that has not answered is never green: waiting, then red after the timeout', () => {
	const asking = facts({ recheckAt: T0, workers: [{ capabilities: ['fetch:ytdlp'], notes: [], lyricsAt: T0 - 1 }] });
	expect(byId(asking).get('lyrics')?.state).toBe('wait');
	expect(byId({ ...asking, now: T0 + READY_TIMEOUT_MS + 1 }).get('lyrics')).toMatchObject({
		state: 'red',
		status: "Didn't answer"
	});
	// The worker's answer after the tap turns it green.
	expect(byId({ ...asking, workers: [{ ...asking.workers[0]!, lyricsAt: T0 + 300 }] }).get('lyrics')?.state).toBe(
		'green'
	);
	// A TV that has not played a sound yet is not called "on".
	expect(byId(facts({ audio: null })).get('sound')).toMatchObject({ state: 'wait', action: 'test-sound' });
	// Disk that did not answer in time is red, not a guess.
	expect(byId(facts({ roomForSongs: null })).get('room')?.state).toBe('red');
});

test('a slow karaoke maker is amber: it works, but songs take a while', () => {
	expect(byId(facts({ typicalMinutes: 6.4 })).get('maker')).toMatchObject({
		state: 'amber',
		status: 'Ready · cpu · about 6 min a song'
	});
});

test('a worker that reports no device reads unknown, never cpu (#1368)', () => {
	const noDevice = facts({ workers: [{ capabilities: ['stems', 'align', 'fetch:ytdlp'], notes: [], lyricsAt: T0 }] });
	expect(byId(noDevice).get('maker')?.status).toBe('Ready · unknown · about 3 min a song');
});

test('the YouTube row passes on the worker’s missing setting and names no path (#1368)', () => {
	const gap = {
		code: 'youtube-gap',
		text: 'YouTube downloads will fail without deno on PATH and --remote-components ejs:github in a yt-dlp config'
	};
	const rows = byId(facts({ workers: [{ capabilities: ['fetch:ytdlp'], notes: [gap], lyricsAt: T0 }] }));
	const youtube = rows.get('youtube');
	expect(youtube?.fix).toBe(
		'The karaoke maker is missing deno on PATH and --remote-components ejs:github in a yt-dlp config.'
	);
	expect(youtube?.detail).toBe(gap.text);
	expect(`${youtube?.fix} ${youtube?.detail}`).not.toMatch(/\//);
});

test('the worker’s notes are kept only when well shaped, and a warnings frame is checked', () => {
	expect(
		workerNotes([GAP, { code: 1, text: 'x' }, null, { code: 'c', text: 'y'.repeat(400), detail: 5 }, 'nope'])
	).toEqual([GAP, { code: 'c', text: 'y'.repeat(300) }]);
	expect(workerNotes('not a list')).toEqual([]);
	expect(validateWorkerMessage({ type: 'worker:warnings', workerId: 'w1', warnings: [] })).toBeNull();
	expect(validateWorkerMessage({ type: 'worker:warnings', workerId: 'w1', warnings: 'x' })).toBe('malformed warnings');
	const registry = new WorkerRegistry();
	registry.hello('w1', ['stems'], 1, '1', T0, undefined, undefined, [GAP]);
	expect(registry.get('w1')?.warnings).toEqual([GAP]);
	expect(registry.get('w1')?.lyricsAt).toBeUndefined();
	// Replace, never merge: the fresh set after a check is the whole truth, and stamps when it answered.
	expect(registry.warnings('w1', [], T0 + 5)).toBe(true);
	expect(registry.get('w1')).toMatchObject({ warnings: [], lyricsAt: T0 + 5 });
	expect(registry.warnings('gone', [], T0)).toBe(false);
});

// ── the routes ───────────────────────────────────────────────────────────────────────────────────────────────

function jar(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	return {
		get: (name: string) => values.get(name),
		set: (name: string, value: string) => void values.set(name, value),
		delete: (name: string) => void values.delete(name)
	};
}
function event(path: string, method: string, cookies: ReturnType<typeof jar>, body?: unknown) {
	const url = new URL(path, ORIGIN);
	const request = new Request(url, {
		method,
		headers: { host: '192.168.1.20:3000', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	return { request, url, route: { id: null }, getClientAddress: () => '192.168.1.50', cookies } as never;
}

function installApp(opts: { midSong?: boolean } = {}) {
	const db = migratedDb();
	let now = T0;
	const sent: [string, WorkerCommand][] = [];
	const chimes: string[] = [];
	const registry = new WorkerRegistry();
	registry.hello('w1', ['stems', 'align', 'fetch:ytdlp'], 1, '1', T0, undefined, { device: 'cpu' } as never, [GAP]);
	const app = {
		db,
		activeRoomId: 'room-1',
		singers: new SingerRepository(db),
		hostKey: new HostKey(db, KEY),
		media: { listReady: () => [] },
		mediaStore: { size: async () => 0 },
		attempts: { finishedSince: () => [] },
		screens: {
			list: () => [{ id: 't', name: 'Living room TV', isTv: true }],
			audio: () => 'locked' as const,
			chime: () => {
				if (opts.midSong) return 'mid-song' as const;
				chimes.push('chime');
				return 'ok' as const;
			}
		},
		workerHub: {
			workers: () => registry.list(),
			canMake: () => true,
			recheck: () => {
				for (const w of registry.list()) sent.push([w.workerId, { type: 'worker:recheck' }]);
			}
		},
		now: () => now
	};
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = app;
	return { app, sent, chimes, tick: (ms: number) => (now += ms) };
}
async function host() {
	const cookies = jar();
	expect((await hostPost(event('/api/host', 'POST', cookies, { key: KEY }))).status).toBe(200);
	return cookies;
}

test('the host reads the rows from live state, and no secret or path rides the answer', async () => {
	installApp();
	const res = await getReady(event('/api/host/ready', 'GET', await host()));
	expect(res.status).toBe(200);
	const body = (await res.json()) as { rows: { id: string; state: string; fix?: string }[] };
	expect(body.rows.map((r) => [r.id, r.state])).toEqual([
		['tv', 'green'],
		['sound', 'red'],
		['maker', 'green'],
		['youtube', 'red'],
		['lyrics', 'wait'],
		['room', 'green']
	]);
	const text = JSON.stringify(body);
	expect(text).not.toContain(KEY);
	expect(text).not.toContain(root);
});

test('a guest, a TV cookie and no cookie are refused every ready route', async () => {
	const { app, sent, chimes } = installApp();
	const guest = app.singers.create('Ana', '#ff0000', 0, 'room-1');
	for (const cookies of [jar({ [SESSION_COOKIE]: guest.sessionToken }), jar({ encore_tv: 'x' }), jar()]) {
		expect((await getReady(event('/api/host/ready', 'GET', cookies))).status).toBe(403);
		expect((await recheckReady(event('/api/host/ready/recheck', 'POST', cookies))).status).toBe(403);
		expect((await chimeReady(event('/api/host/ready/chime', 'POST', cookies))).status).toBe(403);
	}
	expect(sent).toEqual([]);
	expect(chimes).toEqual([]);
});

test('Check again asks every karaoke maker, at most once every 5 s', async () => {
	const { sent, tick } = installApp();
	const cookies = await host();
	expect((await recheckReady(event('/api/host/ready/recheck', 'POST', cookies))).status).toBe(200);
	tick(4_000);
	expect((await recheckReady(event('/api/host/ready/recheck', 'POST', cookies))).status).toBe(429);
	tick(1_000);
	expect((await recheckReady(event('/api/host/ready/recheck', 'POST', cookies))).status).toBe(200);
	expect(sent).toEqual([
		['w1', { type: 'worker:recheck' }],
		['w1', { type: 'worker:recheck' }]
	]);
});

test('the test sound goes to the TV, and never over a singer', async () => {
	const { chimes } = installApp();
	expect((await chimeReady(event('/api/host/ready/chime', 'POST', await host()))).status).toBe(200);
	expect(chimes).toEqual(['chime']);
	installApp({ midSong: true });
	const res = await chimeReady(event('/api/host/ready/chime', 'POST', await host()));
	expect(res.status).toBe(409);
	expect(((await res.json()) as { reason: string }).reason).toBe('mid-song');
});
