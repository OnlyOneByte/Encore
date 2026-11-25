// POST /api/host/tonight: the host's "Show the night". Host only, only between songs, to the TV alone.
import { test, expect, afterEach } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { SingerRepository } from '$lib/server/singers/repository';
import { HostKey } from '$lib/server/host-key';
import { AuthoritativeState } from '$lib/server/state/store';
import { PlayLog } from '$lib/server/media/play-log';
import { NightLog } from '$lib/server/nights/repository';
import { POST as hostPost } from '$routes/api/host/+server';
import { POST as showNight } from '$routes/api/host/tonight/+server';
import type { ServerEvent } from '$lib/contract';

const APP_KEY = Symbol.for('encore.app');
const KEY = 'correct-horse-battery-staple';
const ORIGIN = 'http://192.168.1.20:3000';
const T0 = 1_700_000_000_000;

function installApp() {
	const db = migratedDb();
	const room: ServerEvent[] = [];
	const tv: ServerEvent[] = [];
	const app = {
		db,
		activeRoomId: 'room-1',
		singers: new SingerRepository(db),
		hostKey: new HostKey(db, KEY),
		state: new AuthoritativeState(),
		playLog: new PlayLog(db),
		nights: new NightLog(db),
		mediaById: new Map<string, unknown>([
			['m1', { title: 'Fly Away' }],
			['m2', { title: 'Mayday' }]
		]),
		publish: (e: ServerEvent) => room.push(e),
		publishTv: (e: ServerEvent) => tv.push(e),
		now: () => T0
	};
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = app;
	return { app, room, tv };
}

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
});

function jar() {
	const values = new Map<string, string>();
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
async function host() {
	const cookies = jar();
	expect((await hostPost(event('/api/host', 'POST', cookies, { key: KEY }))).status).toBe(200);
	return cookies;
}

/** A turn the room saw: its play, and its recorded row unless the singer opted out. */
function sing(
	app: ReturnType<typeof installApp>['app'],
	singerId: string,
	entryId: string,
	mediaId: string,
	at: number
) {
	app.playLog.record(mediaId, entryId, at);
	if (!app.nights.isRecording([singerId])) return;
	app.nights.record(
		{
			roomId: 'room-1',
			singerId,
			personId: null,
			mediaId,
			entryId,
			startedAt: at,
			endedAt: at + 180_000,
			end: 'finished',
			keyShift: 0,
			guideLevel: null
		},
		{ keyChanges: 0, cheers: 7 }
	);
}

test('the host shows the night: the recap goes to the TV only, never the room broadcast', async () => {
	const { app, room, tv } = installApp();
	const maya = app.singers.create('Maya', '#ff7a7a', T0, 'room-1');
	sing(app, maya.id, 'e1', 'm1', T0 - 600_000);
	const res = await showNight(event('/api/host/tonight', 'POST', await host()));
	expect(res.status).toBe(200);
	expect(room).toEqual([]);
	expect(tv).toEqual([
		{
			type: 'tv:tonight',
			tonight: {
				songs: 1,
				singers: 1,
				cheers: 7,
				first: { title: 'Fly Away', singer: { name: 'Maya', color: '#ff7a7a' } },
				last: undefined,
				everyone: [{ name: 'Maya', color: '#ff7a7a' }]
			}
		}
	]);
});

test('with an opted-out singer in the night, the TV gets songs only and never their name or colour', async () => {
	const { app, tv } = installApp();
	const maya = app.singers.create('Maya', '#ff7a7a', T0, 'room-1');
	const ana = app.singers.create('Ana', '#6fd3c1', T0, 'room-1');
	app.nights.setRecording([ana.id], false, T0);
	sing(app, maya.id, 'e1', 'm1', T0 - 900_000);
	sing(app, ana.id, 'e2', 'm2', T0 - 600_000);
	expect((await showNight(event('/api/host/tonight', 'POST', await host()))).status).toBe(200);
	const sent = JSON.stringify(tv);
	expect(sent).not.toContain('Ana');
	expect(sent).not.toContain('#6fd3c1');
	expect(sent).not.toContain('Mayday');
	const tonight = (tv[0] as Extract<ServerEvent, { type: 'tv:tonight' }>).tonight;
	expect(tonight.songs).toBe(2);
	expect(tonight.singers).toBeUndefined();
	expect(tonight.cheers).toBeUndefined();
});

test('never over a song or ahead of one waiting, and nothing to show is a 404', async () => {
	const { app, tv } = installApp();
	const cookies = await host();
	expect((await showNight(event('/api/host/tonight', 'POST', cookies))).status).toBe(404);
	const maya = app.singers.create('Maya', '#ff7a7a', T0, 'room-1');
	sing(app, maya.id, 'e1', 'm1', T0 - 600_000);
	app.state.applyQueueOp({
		op: 'add',
		entry: { id: 'q1', mediaId: 'm2', singerId: maya.id, status: 'queued', rotationSeq: -1, addedAt: 1 }
	});
	const busy = await showNight(event('/api/host/tonight', 'POST', cookies));
	expect(busy.status).toBe(409);
	expect(((await busy.json()) as { reason: string }).reason).toBe('busy');
	expect(tv).toEqual([]);
});
