// Your night (proposal 29, PR 2): one row per finished, skipped or failed turn, its own singer's only to read, opt out of
// or delete, and a guest's gone after 90 days.
import { test, expect, afterEach } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { SingerRepository, SESSION_COOKIE } from '$lib/server/singers/repository';
import { PeopleRepository, DEVICE_COOKIE } from '$lib/server/people/repository';
import { RoomRepository } from '$lib/server/rooms/repository';
import { SettingsRepository } from '$lib/server/state/settings-repository';
import { AuthoritativeState } from '$lib/server/state/store';
import { PresenceTracker } from '$lib/server/realtime/presence';
import { PlayLog } from '$lib/server/media/play-log';
import { GUEST_NIGHTS_RETENTION_MS, NIGHT_GAP_MS, NightLog } from '$lib/server/nights/repository';
import { recordTurn, sweepGuestNights } from '$lib/server/nights/service';
import { handlePlayerCommand, handleTelemetry } from '$lib/server/realtime/player';
import { performances, singers } from '$lib/server/db/schema';
import { handle } from '$routes/../hooks.server';
import { GET as listNights, PATCH as setRecording, DELETE as deleteHistory } from '$routes/api/me/nights/+server';
import { GET as oneNight } from '$routes/api/me/nights/[id]/+server';
import { POST as keepPost, DELETE as deleteMe } from '$routes/api/me/person/+server';
import { EMPTY_SONG_PROFILE, type Media, type QueueEntry, type ServerEvent } from '$lib/contract';
import type { HubDeps } from '$lib/server/realtime/hub';

const APP_KEY = Symbol.for('encore.app');
const ORIGIN = 'http://192.168.1.20:3000';
const T0 = 1_700_000_000_000;

const song = (id: string): Media => ({
	id,
	source: 'youtube',
	sourceRef: id,
	title: `Song ${id}`,
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
	const app = {
		db,
		rooms,
		activeRoomId: room.id,
		singers: new SingerRepository(db),
		people: new PeopleRepository(db),
		nights: new NightLog(db),
		playLog: new PlayLog(db),
		settings: new SettingsRepository(db),
		state: new AuthoritativeState(),
		presence: new PresenceTracker(),
		mediaById: new Map(['m1', 'm2', 'm3', 'm4'].map((id) => [id, song(id)])),
		publish: (_e: ServerEvent) => {},
		releaseSinger: (_id: string) => {},
		clock: T0,
		now: () => app.clock
	};
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = app;
	// The deferred row writes run at once unless a test holds them, to land something in the gap.
	const held = { on: false, writes: [] as (() => void)[] };
	const deps: HubDeps = {
		state: app.state,
		publish: () => {},
		mediaById: app.mediaById,
		onNowPlaying: (e) => e && app.playLog.record(e.mediaId, e.id, app.now()),
		onSang: (id) => app.singers.markSang(id, app.now()),
		onKeyChanged: (id) => app.nights.keyChanged(id),
		onTurnEnded: (entry, end, endedWith) =>
			recordTurn(app as never, entry, end, endedWith, (w) => (held.on ? held.writes.push(w) : w()))
	};
	return { app, deps, held };
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

function event(path: string, method: string, p: Phone, body?: unknown, extra: Record<string, unknown> = {}) {
	const url = new URL(path, ORIGIN);
	const request = new Request(url, {
		method,
		headers: { host: '192.168.1.20:3000', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	return { request, url, cookies: p.cookies, route: { id: path }, params: {}, ...extra } as never;
}

function guest(app: App, name: string) {
	const s = app.singers.create(name, '#a796ff', app.now(), app.activeRoomId);
	return { singer: s, p: phone({ [SESSION_COOKIE]: s.sessionToken }) };
}

let seq = 0;
function queue(app: App, singerId: string, mediaId: string): QueueEntry {
	const entry: QueueEntry = { id: `e${++seq}`, mediaId, singerId, status: 'queued', rotationSeq: -1, addedAt: seq };
	app.state.applyQueueOp({ op: 'add', entry });
	return entry;
}

/** Puts `entry` on stage, if nothing else is. */
function play(deps: HubDeps) {
	handlePlayerCommand({ cmd: 'play' }, deps);
}

const rows = (app: App) => app.db.select().from(performances).all();

test('a finished, a skipped and a failed turn each write one row with its own end', () => {
	const { app, deps } = installApp();
	const { singer } = guest(app, 'Theo');
	const a = queue(app, singer.id, 'm1');
	const b = queue(app, singer.id, 'm2');
	const c = queue(app, singer.id, 'm3');
	play(deps);
	app.clock += 200_000;
	handleTelemetry({ entryId: a.id, positionSec: 200, ended: true }, deps);
	app.clock += 30_000;
	handlePlayerCommand({ cmd: 'skip', entryId: b.id }, deps);
	app.clock += 5_000;
	handleTelemetry({ entryId: c.id, positionSec: 0, failed: true }, deps);

	const byEntry = new Map(rows(app).map((r) => [r.entryId, r]));
	expect(byEntry.size).toBe(3);
	expect(byEntry.get(a.id)).toMatchObject({ end: 'finished', singerId: singer.id, mediaId: 'm1', startedAt: T0 });
	expect(byEntry.get(a.id)!.endedAt).toBe(T0 + 200_000);
	expect(byEntry.get(b.id)!.end).toBe('skipped');
	expect(byEntry.get(c.id)!.end).toBe('failed');
	expect(new Set(rows(app).map((r) => r.nightId)).size).toBe(1);
});

test('cheers and key changes are counted per turn, and the key it ended on is kept', () => {
	const { app, deps } = installApp();
	const { singer } = guest(app, 'Theo');
	const a = queue(app, singer.id, 'm1');
	play(deps);
	for (let i = 0; i < 7; i++) app.nights.cheered(a.id);
	handlePlayerCommand({ cmd: 'key', entryId: a.id, semitones: -1 }, { ...deps, actorSingerId: singer.id });
	handlePlayerCommand({ cmd: 'key', entryId: a.id, semitones: -2 }, { ...deps, actorSingerId: singer.id });
	// The same key again is not a change.
	handlePlayerCommand({ cmd: 'key', entryId: a.id, semitones: -2 }, { ...deps, actorSingerId: singer.id });
	handleTelemetry({ entryId: a.id, positionSec: 200, ended: true }, deps);
	expect(rows(app)[0]).toMatchObject({ cheers: 7, keyChanges: 2, keyShift: -2 });
});

test('a turn after six quiet hours starts a new night', () => {
	const { app, deps } = installApp();
	const { singer } = guest(app, 'Theo');
	const a = queue(app, singer.id, 'm1');
	play(deps);
	handleTelemetry({ entryId: a.id, positionSec: 200, ended: true }, deps);
	app.clock += NIGHT_GAP_MS + 1;
	const b = queue(app, singer.id, 'm2');
	play(deps);
	handleTelemetry({ entryId: b.id, positionSec: 200, ended: true }, deps);
	expect(new Set(rows(app).map((r) => r.nightId)).size).toBe(2);
});

test("Don't keep my nights stops new rows, and turning it back on records again", async () => {
	const { app, deps } = installApp();
	const { singer, p } = guest(app, 'Theo');
	const off = await setRecording(event('/api/me/nights', 'PATCH', p, { recording: false }));
	expect(await off.json()).toEqual({ recording: false });
	const a = queue(app, singer.id, 'm1');
	play(deps);
	app.nights.cheered(a.id);
	handleTelemetry({ entryId: a.id, positionSec: 200, ended: true }, deps);
	expect(rows(app)).toEqual([]);

	await setRecording(event('/api/me/nights', 'PATCH', p, { recording: true }));
	const b = queue(app, singer.id, 'm2');
	play(deps);
	handleTelemetry({ entryId: b.id, positionSec: 200, ended: true }, deps);
	// The opted-out turn's cheers did not carry into anything.
	expect(rows(app).map((r) => [r.entryId, r.cheers])).toEqual([[b.id, 0]]);
	expect((await setRecording(event('/api/me/nights', 'PATCH', p, { recording: 'no' }))).status).toBe(400);
});

test('every route is 401 without a cookie, with a forged one, and after leaving', async () => {
	const { app } = installApp();
	const { singer, p } = guest(app, 'Theo');
	for (const jar of [phone(), phone({ [SESSION_COOKIE]: 'not-a-token' })]) {
		expect((await listNights(event('/api/me/nights', 'GET', jar))).status).toBe(401);
		expect((await oneNight(event('/api/me/nights/x', 'GET', jar, undefined, { params: { id: 'x' } }))).status).toBe(
			401
		);
		expect((await setRecording(event('/api/me/nights', 'PATCH', jar, { recording: false }))).status).toBe(401);
		expect((await deleteHistory(event('/api/me/nights', 'DELETE', jar))).status).toBe(401);
	}
	app.singers.endSession(singer.id);
	expect((await listNights(event('/api/me/nights', 'GET', p))).status).toBe(401);
});

test("another singer's night is 404, and the list and delete touch only your own rows", async () => {
	const { app, deps } = installApp();
	const theo = guest(app, 'Theo');
	const maya = guest(app, 'Maya');
	const t = queue(app, theo.singer.id, 'm1');
	const m = queue(app, maya.singer.id, 'm2');
	play(deps);
	app.nights.cheered(t.id);
	handleTelemetry({ entryId: t.id, positionSec: 200, ended: true }, deps);
	app.clock += 1000;
	for (let i = 0; i < 5; i++) app.nights.cheered(m.id);
	handleTelemetry({ entryId: m.id, positionSec: 200, ended: true }, deps);

	const theoList = await (await listNights(event('/api/me/nights', 'GET', theo.p))).json();
	expect(theoList.recording).toBe(true);
	expect(theoList.nights).toHaveLength(1);
	const nightId = theoList.nights[0].id;
	// One night for the room, but Theo's view of it is his song and his times only.
	expect(theoList.nights[0]).toMatchObject({ songs: 1, startedAt: T0, endedAt: T0 });

	const mine = await (await oneNight(event('/x', 'GET', theo.p, undefined, { params: { id: nightId } }))).json();
	expect(mine.turns).toEqual([expect.objectContaining({ mediaId: 'm1', title: 'Song m1', cheers: 1 })]);
	expect(JSON.stringify(mine)).not.toContain(maya.singer.id);
	expect(JSON.stringify(mine)).not.toContain('m2');

	const stranger = guest(app, 'Ana');
	expect((await oneNight(event('/x', 'GET', stranger.p, undefined, { params: { id: nightId } }))).status).toBe(404);
	expect((await oneNight(event('/x', 'GET', theo.p, undefined, { params: { id: 'nope' } }))).status).toBe(404);

	expect(await (await deleteHistory(event('/api/me/nights', 'DELETE', theo.p))).json()).toEqual({ deleted: 1 });
	expect(rows(app).map((r) => r.singerId)).toEqual([maya.singer.id]);
	expect((await oneNight(event('/x', 'GET', theo.p, undefined, { params: { id: nightId } }))).status).toBe(404);
});

test('writes from another site are refused before the route runs', async () => {
	const { app } = installApp();
	const { p } = guest(app, 'Theo');
	for (const method of ['PATCH', 'DELETE']) {
		const url = new URL('/api/me/nights', ORIGIN);
		const request = new Request(url, {
			method,
			headers: { host: '192.168.1.20:3000', origin: 'http://evil.example', 'content-type': 'application/json' },
			body: JSON.stringify({ recording: false })
		});
		const res = await handle({
			event: { request, url, cookies: p.cookies, route: { id: '/api/me/nights' } } as never,
			resolve: () => new Response('reached the route')
		});
		expect(res.status).toBe(403);
	}
	expect(app.nights.isRecording([app.singers.bySessionToken(p.values.get(SESSION_COOKIE))!.id])).toBe(true);
});

test('Keep me links tonight to the person, the opt-out follows, and Delete me removes every night', async () => {
	const { app, deps } = installApp();
	const { singer, p } = guest(app, 'Theo');
	const a = queue(app, singer.id, 'm1');
	play(deps);
	handleTelemetry({ entryId: a.id, positionSec: 200, ended: true }, deps);
	expect(rows(app)[0]!.personId).toBeNull();

	expect((await keepPost(event('/api/me/person', 'POST', p))).status).toBe(200);
	const personId = app.singers.bySessionToken(p.values.get(SESSION_COOKIE))!.personId!;
	expect(rows(app)[0]!.personId).toBe(personId);

	// A later night on the same phone: a new singer row for the same person.
	const later = app.singers.create('Theo', '#a796ff', app.now(), app.activeRoomId, personId);
	const b = queue(app, later.id, 'm2');
	app.clock += NIGHT_GAP_MS + 1;
	play(deps);
	handleTelemetry({ entryId: b.id, positionSec: 200, ended: true }, deps);
	const laterPhone = phone({ [SESSION_COOKIE]: later.sessionToken, [DEVICE_COOKIE]: p.values.get(DEVICE_COOKIE)! });
	const both = await (await listNights(event('/api/me/nights', 'GET', laterPhone))).json();
	expect(both.nights).toHaveLength(2);
	// Without the device cookie, the singer cookie alone reads only its own night.
	const noDevice = phone({ [SESSION_COOKIE]: later.sessionToken });
	expect((await (await listNights(event('/api/me/nights', 'GET', noDevice))).json()).nights).toHaveLength(1);

	// A kept person's rows outlive the guest window.
	app.clock += GUEST_NIGHTS_RETENTION_MS + 1;
	sweepGuestNights(app as never);
	expect(rows(app)).toHaveLength(2);

	expect((await deleteMe(event('/api/me/person', 'DELETE', laterPhone))).status).toBe(200);
	expect(rows(app)).toEqual([]);
});

test('a Delete me landing between a turn ending and its row being written leaves no row', async () => {
	const { app, deps, held } = installApp();
	const { singer, p } = guest(app, 'Theo');
	const a = queue(app, singer.id, 'm1');
	play(deps);
	handleTelemetry({ entryId: a.id, positionSec: 200, ended: true }, deps);
	await keepPost(event('/api/me/person', 'POST', p));
	const b = queue(app, singer.id, 'm2');
	play(deps);
	held.on = true;
	handleTelemetry({ entryId: b.id, positionSec: 200, ended: true }, deps);
	expect((await deleteMe(event('/api/me/person', 'DELETE', p))).status).toBe(200);
	for (const write of held.writes) write();
	expect(rows(app)).toEqual([]);
});

test('a turn that leaves the stage without ending drops its counts when the next turn counts', () => {
	const { app } = installApp();
	app.nights.cheered('removed-mid-song');
	app.nights.keyChanged('removed-mid-song');
	app.nights.cheered('next-turn');
	expect(app.nights.take('removed-mid-song')).toEqual({ keyChanges: 0, cheers: 0 });
	expect(app.nights.take('next-turn')).toEqual({ keyChanges: 0, cheers: 1 });
});

test("a guest's opt-out carries to the person they keep", async () => {
	const { app } = installApp();
	const { singer, p } = guest(app, 'Theo');
	app.singers.markSang(singer.id, app.now());
	await setRecording(event('/api/me/nights', 'PATCH', p, { recording: false }));
	await keepPost(event('/api/me/person', 'POST', p));
	const personId = app.singers.bySessionToken(p.values.get(SESSION_COOKIE))!.personId!;
	const nextNight = app.singers.create('Theo', '#a796ff', app.now(), app.activeRoomId, personId);
	expect(app.nights.isRecording([nextNight.id, personId])).toBe(false);
});

test("the daily sweep deletes a guest's rows after 90 days and leaves newer ones", () => {
	const { app, deps } = installApp();
	const { singer } = guest(app, 'Theo');
	const a = queue(app, singer.id, 'm1');
	play(deps);
	handleTelemetry({ entryId: a.id, positionSec: 200, ended: true }, deps);
	app.clock += GUEST_NIGHTS_RETENTION_MS - 1000;
	const b = queue(app, singer.id, 'm2');
	play(deps);
	handleTelemetry({ entryId: b.id, positionSec: 200, ended: true }, deps);
	app.clock += 2000;
	sweepGuestNights(app as never);
	expect(rows(app).map((r) => r.entryId)).toEqual([b.id]);
	// The singer row itself is not the sweep's to touch.
	expect(app.db.select().from(singers).all()).toHaveLength(1);
});

test('the opt-out is in no wire projection of the singer', async () => {
	const { app } = installApp();
	const { p } = guest(app, 'Theo');
	await setRecording(event('/api/me/nights', 'PATCH', p, { recording: false }));
	expect(JSON.stringify(app.singers.listPublic(app.activeRoomId))).not.toMatch(/record|night|opt/i);
});
