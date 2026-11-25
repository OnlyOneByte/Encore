// A copied singer cookie is not the person (#1232 review, round 2): once the owner's device token has rotated, the
// copy reads and deletes none of the person's nights or saved songs, even while it holds a live socket.
import { test, expect, afterEach } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { SingerRepository, SESSION_COOKIE } from '$lib/server/singers/repository';
import { PeopleRepository, DEVICE_COOKIE } from '$lib/server/people/repository';
import { NightLog } from '$lib/server/nights/repository';
import { SavedSongs } from '$lib/server/songs/repository';
import { RoomRepository } from '$lib/server/rooms/repository';
import { SettingsRepository } from '$lib/server/state/settings-repository';
import { AuthoritativeState } from '$lib/server/state/store';
import { PresenceTracker } from '$lib/server/realtime/presence';
import { keptCaller } from '$lib/server/people/keep';
import { POST as joinPost } from '$routes/api/join/+server';
import { GET as listNights, DELETE as deleteNights } from '$routes/api/me/nights/+server';
import { GET as listSongs, DELETE as forgetSongs } from '$routes/api/me/songs/+server';
import { PUT as saveSong } from '$routes/api/me/songs/[mediaId]/+server';
import { EMPTY_SONG_PROFILE, type Media } from '$lib/contract';

const APP_KEY = Symbol.for('encore.app');
const ORIGIN = 'http://192.168.1.20:3000';
const T0 = 1_700_000_000_000;

const song: Media = {
	id: 'm1',
	source: 'youtube',
	sourceRef: 'ref-m1',
	title: 'Song m1',
	durationSec: 200,
	stemStatus: 'ready',
	lyricsStatus: 'ready',
	instrumentalRef: 'derived/stems/m1-instrumental.flac',
	songProfile: EMPTY_SONG_PROFILE
};

function installApp() {
	const db = migratedDb();
	const rooms = new RoomRepository(db);
	const room = rooms.ensureActive(T0);
	const app = {
		db,
		rooms,
		activeRoomId: room.id,
		singers: new SingerRepository(db),
		people: new PeopleRepository(db),
		nights: new NightLog(db),
		savedSongs: new SavedSongs(db),
		settings: new SettingsRepository(db),
		state: new AuthoritativeState(),
		presence: new PresenceTracker(),
		mediaById: new Map([['m1', song]]),
		publish: () => {},
		releaseSinger: () => {},
		clock: T0,
		now: () => app.clock
	};
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = app;
	return app;
}
afterEach(() => void delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY]);

const jar = (init: Record<string, string> = {}) => {
	const values = new Map(Object.entries(init));
	return {
		values,
		get: (n: string) => values.get(n),
		set: (n: string, v: string) => void values.set(n, v),
		delete: (n: string) => void values.delete(n)
	};
};
const ev = (method: string, path: string, cookies: ReturnType<typeof jar>, body?: unknown, params = {}) => {
	const url = new URL(path, ORIGIN);
	const request = new Request(url, {
		method,
		headers: { host: '192.168.1.20:3000', origin: ORIGIN, 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	return { request, url, cookies, params, route: { id: path } } as never;
};

test("a copied singer cookie, kept online, reaches none of the person's nights or saves after the owner returns", async () => {
	const app = installApp();
	const theo = app.people.create('Theo', '#a796ff', T0);
	const owner = jar({ [DEVICE_COOKIE]: theo.token });
	expect((await joinPost(ev('POST', '/api/join', owner, { returning: true }))).status).toBe(200);
	const thief = jar(Object.fromEntries(owner.values));
	const copied = app.singers.bySessionToken(thief.get(SESSION_COOKIE))!;
	// The thief holds a live socket on the copied night, so it is not ended when the owner joins again.
	app.presence.connect(copied.id);
	owner.delete(SESSION_COOKIE);
	const back = await joinPost(ev('POST', '/api/join', owner, { returning: true, displayName: 'Theo 2' }));
	expect(back.status).toBe(200);
	const tonight = app.singers.bySessionToken(owner.get(SESSION_COOKIE))!;
	app.clock += 3 * 60_000;
	// Past the rotation grace, the thief's copy no longer proves the person.
	expect(keptCaller(app as never, thief, { request: new Request(ORIGIN), url: new URL(ORIGIN) })).toBeNull();

	app.nights.record(
		{
			roomId: app.activeRoomId,
			singerId: tonight.id,
			personId: theo.person.id,
			mediaId: 'm1',
			entryId: 'e-tonight',
			startedAt: T0,
			endedAt: T0 + 1000,
			end: 'finished',
			keyShift: 0,
			guideLevel: null
		},
		{ keyChanges: 0, cheers: 0 }
	);
	expect((await saveSong(ev('PUT', '/api/me/songs/m1', owner, undefined, { mediaId: 'm1' }))).status).toBe(200);
	const theirs = { singerId: tonight.id, personId: theo.person.id };

	expect((await (await listNights(ev('GET', '/api/me/nights', thief))).json()).nights).toEqual([]);
	expect((await (await listSongs(ev('GET', '/api/me/songs', thief))).json()).songs).toEqual([]);
	expect(await (await deleteNights(ev('DELETE', '/api/me/nights', thief))).json()).toEqual({ deleted: 0 });
	expect(await (await forgetSongs(ev('DELETE', '/api/me/songs', thief))).json()).toEqual({ removed: 0 });
	expect(app.nights.nightsFor(theirs)).toHaveLength(1);
	expect(app.savedSongs.listFor(theirs)).toHaveLength(1);
});
