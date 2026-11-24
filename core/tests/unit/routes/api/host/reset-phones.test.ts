// The host's Reset phones (#1201): only the host key can, and it signs out every phone of that person, the copied
// one included, so the owner joins fresh.
import { test, expect, afterEach } from 'bun:test';
import { eq } from 'drizzle-orm';
import { migratedDb } from '$lib/server/db/test-db';
import { SingerRepository, SESSION_COOKIE } from '$lib/server/singers/repository';
import { PeopleRepository, DEVICE_COOKIE } from '$lib/server/people/repository';
import { NightLog } from '$lib/server/nights/repository';
import { HostKey, HOST_COOKIE } from '$lib/server/host-key';
import { RoomRepository } from '$lib/server/rooms/repository';
import { SettingsRepository } from '$lib/server/state/settings-repository';
import { AuthoritativeState } from '$lib/server/state/store';
import { PresenceTracker } from '$lib/server/realtime/presence';
import { people, personDevices } from '$lib/server/db/schema';
import { handle } from '$routes/../hooks.server';
import { POST as hostPost } from '$routes/api/host/+server';
import { POST as reset } from '$routes/api/host/people/reset/+server';
import { POST as joinPost } from '$routes/api/join/+server';

const APP_KEY = Symbol.for('encore.app');
const KEY = 'correct-horse-battery-staple-reset';
const ORIGIN = 'http://192.168.1.20:3000';
const T0 = 1_700_000_000_000;

function installApp() {
	const db = migratedDb();
	const rooms = new RoomRepository(db);
	const room = rooms.ensureActive(T0);
	const released: string[] = [];
	const app = {
		db,
		rooms,
		activeRoomId: room.id,
		singers: new SingerRepository(db),
		people: new PeopleRepository(db),
		nights: new NightLog(db),
		hostKey: new HostKey(db, KEY),
		settings: new SettingsRepository(db),
		state: new AuthoritativeState(),
		presence: new PresenceTracker(),
		publish: () => {},
		releaseSinger: (id: string) => released.push(id),
		now: () => T0
	};
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = app;
	return { app, room, released };
}

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
});

function jar(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	return {
		values,
		get: (n: string) => values.get(n),
		set: (n: string, v: string) => void values.set(n, v),
		delete: (n: string) => void values.delete(n)
	};
}

function event(path: string, cookies: ReturnType<typeof jar>, body?: unknown, headers: Record<string, string> = {}) {
	const url = new URL(path, ORIGIN);
	const request = new Request(url, {
		method: 'POST',
		headers: { host: '192.168.1.20:3000', 'content-type': 'application/json', ...headers },
		body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
	});
	return { request, url, cookies, route: { id: path }, getClientAddress: () => '192.168.1.50' } as never;
}

async function hostJar() {
	const cookies = jar();
	expect((await hostPost(event('/api/host', cookies, { key: KEY }))).status).toBe(200);
	return cookies;
}

/** Theo kept on two phones (his and a thief's copy), with tonight's night signed in; Ana kept too. */
function keptTheo(app: ReturnType<typeof installApp>['app']) {
	const theo = app.people.create('Theo', '#a796ff', T0);
	// A second device row for Theo, as a copied cookie or a paired phone would be.
	const second = app.people.create('x', '#000000', T0);
	app.db
		.update(personDevices)
		.set({ personId: theo.person.id })
		.where(eq(personDevices.personId, second.person.id))
		.run();
	app.db.delete(people).where(eq(people.id, second.person.id)).run();
	const night = app.singers.create('Theo', '#a796ff', T0, app.activeRoomId, theo.person.id);
	const ana = app.people.create('Ana', '#00ff00', T0);
	return { theo, copy: second.token, night, ana };
}

test('the host resets a person: every phone of theirs is signed out and they are forgotten; nobody else is', async () => {
	const { app, room, released } = installApp();
	const { theo, copy, night, ana } = keptTheo(app);
	const host = await hostJar();

	const res = await reset(event('/api/host/people/reset', host, { personId: theo.person.id }));
	expect(res.status).toBe(200);
	expect(app.people.exists(theo.person.id)).toBe(false);
	expect(app.db.select().from(personDevices).where(eq(personDevices.personId, theo.person.id)).all()).toEqual([]);
	expect(app.singers.bySessionToken(night.sessionToken)).toBeNull();
	expect(released).toContain(night.id);
	for (const token of [theo.token, copy]) {
		const phone = jar({ [DEVICE_COOKIE]: token });
		expect((await joinPost(event('/api/join', phone, { returning: true, code: room.code }))).status).toBe(401);
	}
	// Ana is untouched, and the owner can join fresh as a guest.
	expect(app.people.byDevice(ana.token, T0)?.person.displayName).toBe('Ana');
	expect((await joinPost(event('/api/join', jar(), { displayName: 'Theo', code: room.code }))).status).toBe(200);
});

test('a reset night still holding a turn keeps its name until the turn is gone; without one it is freed at once', async () => {
	const { app, room } = installApp();
	const { theo, night } = keptTheo(app);
	// Theo's night is in the room (joined, then its socket dropped) with a queued turn; Ana's kept night has none.
	app.presence.connect(night.id);
	app.presence.disconnect(night.id, T0);
	const ana = app.singers.create(
		'Ana',
		'#00ff00',
		T0,
		app.activeRoomId,
		app.people.list().find((p) => p.displayName === 'Ana')!.id
	);
	app.presence.connect(ana.id);
	const turn = { id: 'e1', mediaId: 'm1', singerId: night.id, status: 'queued', rotationSeq: 1, addedAt: 1 } as never;
	app.state.hydrate([turn], null);
	const host = await hostJar();

	expect((await reset(event('/api/host/people/reset', host, { personId: theo.person.id }))).status).toBe(200);
	// The turn still waits under "Theo", so a new guest cannot take the name.
	const guest = await joinPost(event('/api/join', jar(), { displayName: 'Theo', code: room.code }));
	expect(guest.status).toBe(409);
	// The turn plays and finishes: the name is free with no grace window, since nobody can come back as that night.
	app.state.hydrate([{ ...(turn as object), status: 'done' } as never], null);
	expect((await joinPost(event('/api/join', jar(), { displayName: 'Theo', code: room.code }))).status).toBe(200);

	// A night with no turn frees its name the moment it is reset.
	expect((await reset(event('/api/host/people/reset', host, { personId: app.people.list()[0]!.id }))).status).toBe(200);
	expect((await joinPost(event('/api/join', jar(), { displayName: 'Ana', code: room.code }))).status).toBe(200);
});

test("Reset phones deletes the person's recorded nights, tonight's included, and nobody else's", async () => {
	const { app } = installApp();
	const { theo, night } = keptTheo(app);
	const past = app.singers.create('Theo', '#a796ff', T0 - 7 * 86_400_000, app.activeRoomId, theo.person.id);
	const bo = app.singers.create('Bo', '#ff0000', T0, app.activeRoomId);
	const turn = (singerId: string, personId: string | null, entryId: string, at: number) =>
		app.nights.record(
			{
				roomId: app.activeRoomId,
				singerId,
				personId,
				mediaId: 'm1',
				entryId,
				startedAt: at,
				endedAt: at + 180_000,
				end: 'finished',
				keyShift: 0,
				guideLevel: null
			},
			{ keyChanges: 0, cheers: 0 }
		);
	turn(past.id, theo.person.id, 'e-past', T0 - 7 * 86_400_000);
	turn(night.id, theo.person.id, 'e-tonight', T0 - 600_000);
	turn(bo.id, null, 'e-bo', T0 - 300_000);
	const theosOwner = { singerId: night.id, personId: theo.person.id };
	expect(app.nights.nightsFor(theosOwner).length).toBeGreaterThan(0);

	const host = await hostJar();
	expect((await reset(event('/api/host/people/reset', host, { personId: theo.person.id }))).status).toBe(200);
	expect(app.nights.nightsFor(theosOwner)).toEqual([]);
	expect(app.nights.nightsFor({ singerId: past.id, personId: null })).toEqual([]);
	expect(app.nights.nightsFor({ singerId: bo.id, personId: null })).toHaveLength(1);
});

test('Reset phones refuses a guest, the kept person themselves, the TV and a caller with no key', async () => {
	const { app } = installApp();
	const { theo, night } = keptTheo(app);
	const callers = {
		guest: jar({ [SESSION_COOKIE]: app.singers.create('Bo', '#ff0000', T0, app.activeRoomId).sessionToken }),
		self: jar({ [SESSION_COOKIE]: night.sessionToken, [DEVICE_COOKIE]: theo.token }),
		tv: jar({ encore_tv: 'some-screen' }),
		wrongHostCookie: jar({ [HOST_COOKIE]: 'not-a-host-session-token-at-all-0000000000' }),
		cookieless: jar()
	};
	for (const [who, cookies] of Object.entries(callers)) {
		const res = await reset(event('/api/host/people/reset', cookies, { personId: theo.person.id }));
		expect(res.status, who).toBe(403);
	}
	expect(app.people.exists(theo.person.id)).toBe(true);
});

test('Reset phones refuses a request from another site, and a form post', async () => {
	installApp();
	const host = await hostJar();
	const crossSite = await handle({
		event: event('/api/host/people/reset', host, { personId: 'p' }, { origin: 'http://evil.example' }),
		resolve: () => new Response('reached')
	} as never);
	expect(crossSite.status).toBe(403);
	const form = await handle({
		event: event('/api/host/people/reset', host, 'personId=p', { 'content-type': 'application/x-www-form-urlencoded' }),
		resolve: () => new Response('reached')
	} as never);
	expect(form.status).toBe(415);
});

test('an unknown person is 404 and a missing id is 400, for the host', async () => {
	installApp();
	const host = await hostJar();
	expect((await reset(event('/api/host/people/reset', host, { personId: 'nobody' }))).status).toBe(404);
	expect((await reset(event('/api/host/people/reset', host, {}))).status).toBe(400);
});
