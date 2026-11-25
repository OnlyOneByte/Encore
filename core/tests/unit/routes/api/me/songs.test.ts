// Your songs (proposal 36, PR 1): saves and sung songs, only ever the caller's own, carried by Keep me, gone with
// Delete me, a guest's swept after 90 days unused, and an export with no token in it.
import { test, expect, afterEach } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { SingerRepository, SESSION_COOKIE } from '$lib/server/singers/repository';
import { PeopleRepository, DEVICE_COOKIE } from '$lib/server/people/repository';
import { RoomRepository } from '$lib/server/rooms/repository';
import { SettingsRepository } from '$lib/server/state/settings-repository';
import { AuthoritativeState } from '$lib/server/state/store';
import { PresenceTracker } from '$lib/server/realtime/presence';
import { PlayLog } from '$lib/server/media/play-log';
import { GUEST_NIGHTS_RETENTION_MS, NightLog } from '$lib/server/nights/repository';
import { recordTurn, sweepGuestNights } from '$lib/server/nights/service';
import { SavedSongs } from '$lib/server/songs/repository';
import { PendingDeletes } from '$lib/server/media/library-manage';
import { handlePlayerCommand, handleTelemetry } from '$lib/server/realtime/player';
import { savedSongs } from '$lib/server/db/schema';
import { handle } from '$routes/../hooks.server';
import { GET as listSongs, DELETE as forgetSongs } from '$routes/api/me/songs/+server';
import { PUT as saveSong, DELETE as unsaveSong } from '$routes/api/me/songs/[mediaId]/+server';
import { GET as exportMine } from '$routes/api/me/export/+server';
import { POST as keepPost, DELETE as deleteMe } from '$routes/api/me/person/+server';
import { EMPTY_SONG_PROFILE, type Media, type QueueEntry, type ServerEvent } from '$lib/contract';
import type { HubDeps } from '$lib/server/realtime/hub';

const APP_KEY = Symbol.for('encore.app');
const ORIGIN = 'http://192.168.1.20:3000';
const T0 = 1_700_000_000_000;

const song = (id: string): Media => ({
	id,
	source: 'youtube',
	sourceRef: `ref-${id}`,
	title: `Song ${id}`,
	artist: `Artist ${id}`,
	durationSec: 200,
	stemStatus: 'ready',
	lyricsStatus: 'ready',
	instrumentalRef: `derived/stems/${id}-instrumental.flac`,
	songProfile: EMPTY_SONG_PROFILE
});

function installApp() {
	const db = migratedDb();
	const rooms = new RoomRepository(db);
	const room = rooms.ensureActive(T0);
	const published: ServerEvent[] = [];
	const app = {
		db,
		rooms,
		activeRoomId: room.id,
		singers: new SingerRepository(db),
		people: new PeopleRepository(db),
		nights: new NightLog(db),
		savedSongs: new SavedSongs(db),
		playLog: new PlayLog(db),
		settings: new SettingsRepository(db),
		state: new AuthoritativeState(),
		presence: new PresenceTracker(),
		mediaById: new Map(['m1', 'm2', 'm3'].map((id) => [id, song(id)])),
		pendingDeletes: new PendingDeletes(() => {}),
		publish: (e: ServerEvent) => void published.push(e),
		releaseSinger: (_id: string) => {},
		clock: T0,
		now: () => app.clock
	};
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = app;
	const deps: HubDeps = {
		state: app.state,
		publish: () => {},
		mediaById: app.mediaById,
		onNowPlaying: (e) => e && app.playLog.record(e.mediaId, e.id, app.now()),
		onSang: (id) => app.singers.markSang(id, app.now()),
		onKeyChanged: (id) => app.nights.keyChanged(id),
		onTurnEnded: (entry, end, endedWith) => recordTurn(app as never, entry, end, endedWith, (w) => w())
	};
	return { app, deps, published };
}
type App = ReturnType<typeof installApp>['app'];

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
});

function phone(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	return {
		values,
		cookies: {
			get: (n: string) => values.get(n),
			set: (n: string, v: string) => void values.set(n, v),
			delete: (n: string) => void values.delete(n)
		}
	};
}
type Phone = ReturnType<typeof phone>;

function event(path: string, method: string, p: Phone, params: Record<string, string> = {}, body?: unknown) {
	const url = new URL(path, ORIGIN);
	const request = new Request(url, {
		method,
		headers: { host: '192.168.1.20:3000', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	return { request, url, cookies: p.cookies, route: { id: path }, params } as never;
}

function guest(app: App, name: string) {
	const s = app.singers.create(name, '#a796ff', app.now(), app.activeRoomId);
	return { singer: s, p: phone({ [SESSION_COOKIE]: s.sessionToken }) };
}

const save = (p: Phone, mediaId: string, body?: unknown) =>
	saveSong(event(`/api/me/songs/${mediaId}`, 'PUT', p, { mediaId }, body));
const list = async (p: Phone) => (await (await listSongs(event('/api/me/songs', 'GET', p))).json()).songs;

let seq = 0;
/** One whole turn of `mediaId` by `singerId`, ending as `how`, with the key `key` set on stage. */
function sing(app: App, deps: HubDeps, singerId: string, mediaId: string, how: 'ended' | 'skip', key = 0) {
	const entry: QueueEntry = { id: `e${++seq}`, mediaId, singerId, status: 'queued', rotationSeq: -1, addedAt: seq };
	app.state.applyQueueOp({ op: 'add', entry });
	handlePlayerCommand({ cmd: 'play' }, deps);
	if (key) handlePlayerCommand({ cmd: 'key', entryId: entry.id, semitones: key }, { ...deps, actorSingerId: singerId });
	app.clock += 1000;
	if (how === 'ended') handleTelemetry({ entryId: entry.id, positionSec: 200, ended: true }, deps);
	else handlePlayerCommand({ cmd: 'skip', entryId: entry.id }, deps);
}

test('every route is 401 without a cookie, with a forged one, and after leaving', async () => {
	const { app } = installApp();
	const { singer, p } = guest(app, 'Theo');
	const calls = (jar: Phone) => [
		listSongs(event('/api/me/songs', 'GET', jar)),
		forgetSongs(event('/api/me/songs', 'DELETE', jar)),
		save(jar, 'm1'),
		unsaveSong(event('/api/me/songs/m1', 'DELETE', jar, { mediaId: 'm1' })),
		exportMine(event('/api/me/export', 'GET', jar))
	];
	for (const jar of [phone(), phone({ [SESSION_COOKIE]: 'not-a-token' })])
		for (const res of await Promise.all(calls(jar))) expect(res.status).toBe(401);
	app.singers.endSession(singer.id);
	for (const res of await Promise.all(calls(p))) expect(res.status).toBe(401);
	expect(app.db.select().from(savedSongs).all()).toEqual([]);
});

test('a save is the caller’s own: another guest sees none of it and cannot unsave it', async () => {
	const { app, published } = installApp();
	const theo = guest(app, 'Theo');
	const ana = guest(app, 'Ana');
	expect((await save(theo.p, 'm1')).status).toBe(200);
	// Saving again keeps the one save.
	expect((await save(theo.p, 'm1')).status).toBe(200);
	expect(await list(theo.p)).toEqual([
		expect.objectContaining({ mediaId: 'm1', title: 'Song m1', sung: 0, saved: expect.any(Object) })
	]);
	expect(await list(ana.p)).toEqual([]);
	expect((await unsaveSong(event('/x', 'DELETE', ana.p, { mediaId: 'm1' }))).status).toBe(404);
	expect(await list(theo.p)).toHaveLength(1);
	// A save is between a guest and their phone: nothing is broadcast.
	expect(published).toEqual([]);
	expect((await unsaveSong(event('/x', 'DELETE', theo.p, { mediaId: 'm1' }))).status).toBe(200);
	expect(await list(theo.p)).toEqual([]);
});

test('the song comes from the catalog, never the body, and an unknown id is 404', async () => {
	const { app } = installApp();
	const { p } = guest(app, 'Theo');
	expect((await save(p, 'nope')).status).toBe(404);
	await save(p, 'm2', { source: 'local', sourceRef: '/etc/passwd', title: 'Forged' });
	const [row] = app.db.select().from(savedSongs).all();
	expect(row).toMatchObject({ source: 'youtube', sourceRef: 'ref-m2', title: 'Song m2', artist: 'Artist m2' });
});

test('sung songs list themselves, in the key of the last finished turn, ranked by use', async () => {
	const { app, deps } = installApp();
	const { singer, p } = guest(app, 'Theo');
	sing(app, deps, singer.id, 'm1', 'ended', -2);
	// A skipped turn counts as sung but does not move the key.
	sing(app, deps, singer.id, 'm1', 'skip', 3);
	sing(app, deps, singer.id, 'm2', 'ended');
	app.clock += 1000;
	await save(p, 'm3');
	const songs = await list(p);
	expect(songs.map((s: { mediaId: string }) => s.mediaId)).toEqual(['m1', 'm3', 'm2']);
	expect(songs[0]).toMatchObject({ sung: 2, keyShift: -2, saved: null });
	// Finished at 0 is a key; never finished is none, so the phone's remembered key can stand in.
	expect(songs[2]).toMatchObject({ keyShift: 0 });
	expect(songs[1]).toMatchObject({ keyShift: null, guideLevel: null });
});

test('"Don\'t keep my nights" keeps a guest\'s sung songs out too, since they are the same rows', async () => {
	const { app, deps } = installApp();
	const { singer, p } = guest(app, 'Theo');
	app.nights.setRecording([singer.id], false, app.now());
	sing(app, deps, singer.id, 'm1', 'ended');
	expect(await list(p)).toEqual([]);
});

test('each row carries its catalog song, and canKeep says when the Keep me line belongs under the list', async () => {
	const { app, deps } = installApp();
	const { singer, p } = guest(app, 'Theo');
	const body = async () => (await listSongs(event('/api/me/songs', 'GET', p))).json();
	await save(p, 'm2');
	// Saved but never sung: Keep me is not offered yet, so neither is the line.
	expect(await body()).toEqual({ songs: [expect.objectContaining({ media: song('m2') })], canKeep: false });
	sing(app, deps, singer.id, 'm1', 'ended');
	expect((await body()).canKeep).toBe(true);
	await keepPost(event('/api/me/person', 'POST', p));
	expect((await body()).canKeep).toBe(false);
	// A song inside its delete's Undo window is already hidden, as search and the library hide it.
	app.pendingDeletes.schedule('m2');
	expect((await body()).songs.find((s: { title: string }) => s.title === 'Song m2').media).toBeNull();
	app.pendingDeletes.undo('m2');
	// A save whose song left the library has no catalog row.
	app.mediaById.delete('m2');
	expect((await body()).songs.find((s: { title: string }) => s.title === 'Song m2').media).toBeNull();
});

test('Keep me takes the saves to the person, every phone of theirs sees them, and Delete me removes them', async () => {
	const { app, deps } = installApp();
	const { singer, p } = guest(app, 'Theo');
	sing(app, deps, singer.id, 'm1', 'ended');
	await save(p, 'm2');
	expect((await keepPost(event('/api/me/person', 'POST', p))).status).toBe(200);
	const personId = app.singers.bySessionToken(p.values.get(SESSION_COOKIE))!.personId!;
	expect(app.db.select().from(savedSongs).all()).toEqual([
		expect.objectContaining({ ownerKind: 'person', ownerId: personId })
	]);

	// Another night on the same phone: a new singer row for the person.
	const later = app.singers.create('Theo', '#a796ff', app.now(), app.activeRoomId, personId);
	const laterPhone = phone({ [SESSION_COOKIE]: later.sessionToken, [DEVICE_COOKIE]: p.values.get(DEVICE_COOKIE)! });
	expect((await list(laterPhone)).map((s: { mediaId: string }) => s.mediaId).sort()).toEqual(['m1', 'm2']);
	// The singer cookie alone, with no device cookie, does not reach the person's songs.
	const noDevice = phone({ [SESSION_COOKIE]: later.sessionToken });
	expect(await list(noDevice)).toEqual([]);
	// A kept caller's new save goes to the person; one made without the device cookie lands on that singer row.
	await save(laterPhone, 'm3');
	await save(noDevice, 'm1');
	expect(
		app.db
			.select()
			.from(savedSongs)
			.all()
			.map((r) => `${r.ownerKind}:${r.sourceRef}`)
			.sort()
	).toEqual(['person:ref-m2', 'person:ref-m3', 'singer:ref-m1']);

	expect((await deleteMe(event('/api/me/person', 'DELETE', laterPhone))).status).toBe(200);
	expect(app.db.select().from(savedSongs).all()).toEqual([]);
});

test('a save on a kept singer row made without the device cookie survives the sweep', () => {
	// The reviewer's repro (#1232): a singer-kind save on a linked singer row, as an older client could leave one.
	const { app } = installApp();
	const s = app.singers.create('K', '#ff0000', T0, app.activeRoomId, null);
	app.singers.linkPerson(s.id, 'person-1');
	app.savedSongs.save({ singerId: s.id, personId: null }, app.mediaById.get('m1')!, T0);
	expect(app.savedSongs.sweepGuests(T0 + GUEST_NIGHTS_RETENTION_MS + 1)).toBe(0);
});

test('re-keying a guest onto a person who saved the same song keeps one save', () => {
	const { app } = installApp();
	const m = app.mediaById.get('m1')!;
	app.savedSongs.save({ singerId: 'p-singer', personId: 'person-1' }, m, T0);
	app.savedSongs.save({ singerId: 'guest-1', personId: null }, m, T0 + 1);
	app.savedSongs.save({ singerId: 'guest-1', personId: null }, app.mediaById.get('m2')!, T0 + 2);
	app.savedSongs.linkPerson('guest-1', 'person-1');
	const rows = app.db.select().from(savedSongs).all();
	expect(rows.map((r) => [r.ownerKind, r.ownerId, r.sourceRef]).sort()).toEqual([
		['person', 'person-1', 'ref-m1'],
		['person', 'person-1', 'ref-m2']
	]);
});

test('Forget my songs removes only the caller’s saves', async () => {
	const { app } = installApp();
	const theo = guest(app, 'Theo');
	const ana = guest(app, 'Ana');
	await save(theo.p, 'm1');
	await save(theo.p, 'm2');
	await save(ana.p, 'm1');
	expect(await (await forgetSongs(event('/api/me/songs', 'DELETE', theo.p))).json()).toEqual({ removed: 2 });
	expect(await list(ana.p)).toHaveLength(1);
});

test('a save outlives a library delete, and finds its song again when it is made again under a new id', async () => {
	const { app } = installApp();
	const { p } = guest(app, 'Theo');
	await save(p, 'm1');
	app.mediaById.delete('m1');
	expect(await list(p)).toEqual([expect.objectContaining({ mediaId: null, title: 'Song m1', artist: 'Artist m1' })]);
	app.mediaById.set('m9', { ...song('m1'), id: 'm9' });
	expect(await list(p)).toEqual([expect.objectContaining({ mediaId: 'm9' })]);
});

test("the daily sweep deletes a guest's saves after 90 days unused and keeps a kept person's", async () => {
	const { app } = installApp();
	const idle = guest(app, 'Idle');
	const active = guest(app, 'Active');
	app.savedSongs.save({ singerId: 'x', personId: 'person-1' }, app.mediaById.get('m1')!, app.now());
	await save(idle.p, 'm1');
	await save(active.p, 'm1');
	app.clock += GUEST_NIGHTS_RETENTION_MS + 1;
	// Active sang recently, so their row is recent use.
	app.singers.markSang(active.singer.id, app.now());
	sweepGuestNights(app as never);
	expect(
		app.db
			.select()
			.from(savedSongs)
			.all()
			.map((r) => r.ownerId)
			.sort()
	).toEqual([active.singer.id, 'person-1'].sort());
});

test('the export holds the caller’s data and no token, hash or other person’s rows', async () => {
	const { app, deps } = installApp();
	const theo = guest(app, 'Theo');
	const ana = guest(app, 'Ana');
	sing(app, deps, theo.singer.id, 'm1', 'ended', -1);
	await save(theo.p, 'm2');
	await keepPost(event('/api/me/person', 'POST', theo.p));
	await save(ana.p, 'm3');
	sing(app, deps, ana.singer.id, 'm3', 'ended');

	const res = await exportMine(event('/api/me/export', 'GET', theo.p));
	expect(res.headers.get('content-disposition')).toContain('attachment');
	expect(res.headers.get('cache-control')).toContain('no-store');
	const text = await res.text();
	const data = JSON.parse(text);
	expect(data).toMatchObject({
		name: 'Theo',
		kept: true,
		phones: [{ keptAt: expect.any(Number), lastSeenAt: expect.any(Number) }]
	});
	expect(Object.keys(data.phones[0]).sort()).toEqual(['keptAt', 'lastSeenAt']);
	expect(data.savedSongs.map((s: { title: string }) => s.title)).toEqual(['Song m2']);
	expect(data.nights[0].turns).toEqual([expect.objectContaining({ title: 'Song m1', keyShift: -1, end: 'finished' })]);
	expect(text).not.toMatch(/token|hash|salt/i);
	// No internal id at any depth: not a night's, a turn's, a song's, a singer's or a person's.
	const keys = (v: unknown): string[] =>
		v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : [];
	expect(keys(data).filter((k) => /ids?$/i.test(k))).toEqual([]);
	expect(text).not.toContain('Ana');
	expect(text).not.toContain('Song m3');
	expect(text).not.toContain(theo.singer.id);
	expect(text).not.toContain(app.singers.bySessionToken(theo.p.values.get(SESSION_COOKIE))!.personId!);
});

test('writes from another site are refused before the route runs', async () => {
	const { app } = installApp();
	const { p } = guest(app, 'Theo');
	for (const [method, path] of [
		['PUT', '/api/me/songs/m1'],
		['DELETE', '/api/me/songs/m1'],
		['DELETE', '/api/me/songs']
	] as const) {
		const url = new URL(path, ORIGIN);
		const request = new Request(url, { method, headers: { host: '192.168.1.20:3000', origin: 'http://evil.example' } });
		const res = await handle({
			event: { request, url, cookies: p.cookies, route: { id: path } } as never,
			resolve: () => new Response('reached the route')
		});
		expect(res.status).toBe(403);
	}
	expect(app.db.select().from(savedSongs).all()).toEqual([]);
});
