// Keep me, the returning one-tap join, sign out other phones, delete me and server-side expiry (proposal 30, PR 2).
import { test, expect, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { eq, isNotNull } from 'drizzle-orm';
import { migratedDb } from '$lib/server/db/test-db';
import { SingerRepository, SESSION_COOKIE } from '$lib/server/singers/repository';
import {
	PeopleRepository,
	DEVICE_COOKIE,
	DEVICE_COOKIE_SECURE,
	DEVICE_IDLE_MS,
	ROTATION_GRACE_MS
} from '$lib/server/people/repository';
import { dailyPersonPrune, PERSON_PRUNE_EVERY_MS, pruneIdlePeople } from '$lib/server/people/keep';
import { RoomRepository } from '$lib/server/rooms/repository';
import { NightLog } from '$lib/server/nights/repository';
import { SettingsRepository } from '$lib/server/state/settings-repository';
import { AuthoritativeState } from '$lib/server/state/store';
import { PresenceTracker } from '$lib/server/realtime/presence';
import { people, personDevices, singers } from '$lib/server/db/schema';
import { handle } from '$routes/../hooks.server';
import { POST as keepPost, DELETE as deleteMe } from '$routes/api/me/person/+server';
import { DELETE as signOutOthers } from '$routes/api/me/person/others/+server';
import { POST as joinPost } from '$routes/api/join/+server';
import { GET as preview } from '$routes/api/room-preview/+server';
import type { ServerEvent } from '$lib/contract';

const APP_KEY = Symbol.for('encore.app');
const ORIGIN = 'http://192.168.1.20:3000';
const T0 = 1_700_000_000_000;

function installApp() {
	const db = migratedDb();
	const rooms = new RoomRepository(db);
	const room = rooms.ensureActive(T0);
	const published: ServerEvent[] = [];
	const released: string[] = [];
	const app = {
		db,
		rooms,
		activeRoomId: room.id,
		singers: new SingerRepository(db),
		people: new PeopleRepository(db),
		nights: new NightLog(db),
		settings: new SettingsRepository(db),
		state: new AuthoritativeState(),
		presence: new PresenceTracker(),
		publish: (e: ServerEvent) => published.push(e),
		releaseSinger: (id: string) => released.push(id),
		clock: T0,
		now: () => app.clock
	};
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = app;
	return { app, room, published, released };
}

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
	delete process.env.ENCORE_PUBLIC_ORIGIN;
});

/** One phone's cookie jar, recording every set. */
function phone(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	const sets: { name: string; value: string; opts: Record<string, unknown> }[] = [];
	return {
		values,
		sets,
		cookies: {
			get: (n: string) => values.get(n),
			set: (name: string, value: string, opts: Record<string, unknown>) => {
				sets.push({ name, value, opts });
				values.set(name, value);
			},
			delete: (n: string) => void values.delete(n)
		}
	};
}
type Phone = ReturnType<typeof phone>;

function event(path: string, method: string, p: Phone, body?: unknown, headers: Record<string, string> = {}) {
	const url = new URL(path, ORIGIN);
	const request = new Request(url, {
		method,
		headers: {
			host: '192.168.1.20:3000',
			...(body === undefined ? {} : { 'content-type': 'application/json' }),
			...headers
		},
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	return { request, url, cookies: p.cookies, route: { id: path }, getClientAddress: () => '192.168.1.50' } as never;
}

/** A guest who has sung, holding tonight's singer cookie. */
function sungGuest(app: ReturnType<typeof installApp>['app'], name = 'Theo') {
	const s = app.singers.create(name, '#a796ff', app.now(), app.activeRoomId);
	app.singers.markSang(s.id, app.now());
	return { singer: s, p: phone({ [SESSION_COOKIE]: s.sessionToken }) };
}

test('Keep me is refused before the first song', async () => {
	const { app } = installApp();
	const s = app.singers.create('Ana', '#ff0000', T0, app.activeRoomId);
	const res = await keepPost(event('/api/me/person', 'POST', phone({ [SESSION_COOKIE]: s.sessionToken })));
	expect(res.status).toBe(409);
	expect(app.db.select().from(people).all()).toEqual([]);
});

test('Keep me sets a hashed, HttpOnly, Lax device cookie and swaps the singer token', async () => {
	const { app } = installApp();
	const { singer, p } = sungGuest(app);
	const res = await keepPost(event('/api/me/person', 'POST', p));
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({ kept: true, canKeep: false, otherPhones: 0 });

	const device = p.sets.find((c) => c.name === DEVICE_COOKIE)!;
	expect(device.opts).toMatchObject({
		httpOnly: true,
		sameSite: 'lax',
		secure: false,
		path: '/',
		maxAge: 365 * 86_400
	});
	expect(device.value.length).toBeGreaterThanOrEqual(43);
	const [row] = app.db.select().from(personDevices).all();
	expect(row!.tokenHash).not.toBe(device.value);
	expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);

	// A copy of the old singer cookie no longer resolves; the new one is the kept person.
	expect(app.singers.bySessionToken(singer.sessionToken)).toBeNull();
	expect(app.singers.bySessionToken(p.values.get(SESSION_COOKIE))?.personId).toBe(row!.personId);
	expect((await keepPost(event('/api/me/person', 'POST', p))).status).toBe(409);
});

test('over HTTPS the device cookie is __Host- and Secure', async () => {
	process.env.ENCORE_PUBLIC_ORIGIN = 'https://karaoke.example';
	const { app } = installApp();
	const { p } = sungGuest(app);
	await keepPost(event('/api/me/person', 'POST', p));
	const device = p.sets.find((c) => c.name === DEVICE_COOKIE_SECURE)!;
	expect(device.opts).toMatchObject({ secure: true, path: '/' });
	expect(p.sets.some((c) => c.name === DEVICE_COOKIE)).toBe(false);
});

/** Keep a guest, then end the night: the phone holds only its device cookie. */
async function keptPhone(app: ReturnType<typeof installApp>['app'], name = 'Theo') {
	const { p } = sungGuest(app, name);
	await keepPost(event('/api/me/person', 'POST', p));
	return phone({ [DEVICE_COOKIE]: p.values.get(DEVICE_COOKIE)! });
}

test('a kept phone is welcomed back and joins in one tap as its person', async () => {
	const { app, room, published } = installApp();
	const p = await keptPhone(app);
	// Last night's singer is gone from the room, so the name is free again.
	app.presence = new PresenceTracker();

	const seen = await (await preview(event(`/api/room-preview?code=${room.code}`, 'GET', p))).json();
	expect(seen.returning).toEqual({ displayName: 'Theo', color: '#a796ff' });

	const res = await joinPost(event('/api/join', 'POST', p, { returning: true, code: room.code }));
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body.singer.displayName).toBe('Theo');
	expect(body.singer).not.toHaveProperty('personId');
	const tonight = app.singers.bySessionToken(p.values.get(SESSION_COOKIE))!;
	const [person] = app.db.select().from(people).all();
	expect(tonight.personId).toBe(person!.id);
	// No person, device or token ever reaches the room.
	expect(JSON.stringify(published)).not.toMatch(/personId|person_id|sessionToken|deviceId/);
	expect(JSON.stringify(app.singers.listPublic(app.activeRoomId))).not.toMatch(/personId|sessionToken/);
});

test('the name is never a credential: a phone without the device cookie is not welcomed back', async () => {
	const { app, room } = installApp();
	await keptPhone(app);
	const stranger = phone();
	const seen = await (await preview(event(`/api/room-preview?code=${room.code}`, 'GET', stranger))).json();
	expect(seen.returning).toBeNull();
	const res = await joinPost(event('/api/join', 'POST', stranger, { returning: true, displayName: 'Theo' }));
	expect(res.status).toBe(401);
	const forged = phone({ [DEVICE_COOKIE]: 'not-a-real-device-token-at-all-000000000' });
	expect((await joinPost(event('/api/join', 'POST', forged, { returning: true }))).status).toBe(401);
});

test('a device unused for 180 days is signed out on the server and pruned with its person', async () => {
	const { app, room } = installApp();
	const p = await keptPhone(app);
	app.clock = T0 + DEVICE_IDLE_MS;
	expect((await joinPost(event('/api/join', 'POST', p, { returning: true, code: room.code }))).status).toBe(401);
	expect(await (await preview(event(`/api/room-preview?code=${room.code}`, 'GET', p))).json()).toMatchObject({
		returning: null
	});

	pruneIdlePeople(app as never);
	expect(app.db.select().from(people).all()).toEqual([]);
	expect(app.db.select().from(personDevices).all()).toEqual([]);
	expect(app.db.select().from(singers).where(isNotNull(singers.personId)).all()).toEqual([]);
});

test('the idle prune runs on the tick once a day, not only at boot', async () => {
	const { app } = installApp();
	await keptPhone(app);
	// The last prune ran a moment before the device went idle; the next waits a day.
	const tick = dailyPersonPrune(app as never, T0 + DEVICE_IDLE_MS - 1);
	app.clock = T0 + DEVICE_IDLE_MS;
	tick();
	expect(app.db.select().from(people).all()).toHaveLength(1);
	app.clock = T0 + DEVICE_IDLE_MS - 1 + PERSON_PRUNE_EVERY_MS;
	tick();
	expect(app.db.select().from(people).all()).toEqual([]);
});

test("a returning join rotates the device token, so a thief's copy dies once the grace has passed", async () => {
	const { app, room } = installApp();
	const owner = await keptPhone(app);
	app.presence = new PresenceTracker();
	const thief = phone({ [DEVICE_COOKIE]: owner.values.get(DEVICE_COOKIE)! });
	const before = owner.values.get(DEVICE_COOKIE)!;

	expect((await joinPost(event('/api/join', 'POST', owner, { returning: true, code: room.code }))).status).toBe(200);
	const after = owner.values.get(DEVICE_COOKIE)!;
	expect(after).not.toBe(before);
	expect(owner.sets.find((c) => c.name === DEVICE_COOKIE && c.value === after)?.opts).toMatchObject({
		httpOnly: true,
		sameSite: 'lax'
	});

	app.clock = T0 + ROTATION_GRACE_MS;
	expect(
		(await (await preview(event(`/api/room-preview?code=${room.code}`, 'GET', thief))).json()).returning
	).toBeNull();
	const res = await joinPost(
		event('/api/join', 'POST', thief, { returning: true, code: room.code, displayName: 'T2' })
	);
	expect(res.status).toBe(401);
});

/** The same phone with its cookies as they are now, for a request whose response never arrives. */
const lostResponse = (p: Phone) => phone(Object.fromEntries(p.values));
const deviceRow = (app: ReturnType<typeof installApp>['app']) => app.db.select().from(personDevices).all()[0]!;

test('a join whose response is lost: the retry inside the grace gets the current token and joins as the person', async () => {
	const { app, room } = installApp();
	const owner = await keptPhone(app);
	app.presence = new PresenceTracker();
	const lost = lostResponse(owner);
	expect((await joinPost(event('/api/join', 'POST', lost, { returning: true, code: room.code }))).status).toBe(200);
	const rotated = lost.values.get(DEVICE_COOKIE)!;
	const hashAfterRotation = deviceRow(app).tokenHash;

	app.clock = T0 + ROTATION_GRACE_MS - 1;
	const retry = await joinPost(event('/api/join', 'POST', owner, { returning: true, code: room.code }));
	expect(retry.status).toBe(200);
	expect((await retry.json()).singer.displayName).toBe('Theo');
	// The retry is answered with the token the lost response carried, and nothing rotates again.
	expect(owner.values.get(DEVICE_COOKIE)).toBe(rotated);
	expect(deviceRow(app).tokenHash).toBe(hashAfterRotation);
	expect(app.db.select().from(people).all()).toHaveLength(1);
	expect(app.singers.bySessionToken(owner.values.get(SESSION_COOKIE))?.personId).toBe(deviceRow(app).personId);
});

test('the previous token is refused once the grace has passed', async () => {
	const { app, room } = installApp();
	const owner = await keptPhone(app);
	app.presence = new PresenceTracker();
	await joinPost(event('/api/join', 'POST', lostResponse(owner), { returning: true, code: room.code }));
	app.clock = T0 + ROTATION_GRACE_MS;
	expect((await joinPost(event('/api/join', 'POST', owner, { returning: true, code: room.code }))).status).toBe(401);
	expect(
		(await (await preview(event(`/api/room-preview?code=${room.code}`, 'GET', owner))).json()).returning
	).toBeNull();
});

test("the first use of the new token ends the grace: a thief's copy is refused after the owner's next use", async () => {
	const { app, room } = installApp();
	const owner = await keptPhone(app);
	app.presence = new PresenceTracker();
	const thief = phone({ [DEVICE_COOKIE]: owner.values.get(DEVICE_COOKIE)! });
	expect((await joinPost(event('/api/join', 'POST', owner, { returning: true, code: room.code }))).status).toBe(200);
	// The owner's phone uses its new token once (the next scan, or the You tab), still inside the 10 minutes.
	expect(
		(await (await preview(event(`/api/room-preview?code=${room.code}`, 'GET', owner))).json()).returning?.displayName
	).toBe('Theo');
	expect(deviceRow(app).prevTokenHash).toBeNull();
	expect(
		(await (await preview(event(`/api/room-preview?code=${room.code}`, 'GET', thief))).json()).returning
	).toBeNull();
	expect(
		(await joinPost(event('/api/join', 'POST', thief, { returning: true, code: room.code, displayName: 'T2' }))).status
	).toBe(401);
});

test('two tabs joining on the same token end on one token and one person', async () => {
	const { app, room } = installApp();
	const owner = await keptPhone(app);
	app.presence = new PresenceTracker();
	const [tabA, tabB] = [lostResponse(owner), lostResponse(owner)];
	const [a, b] = await Promise.all([
		joinPost(event('/api/join', 'POST', tabA, { returning: true, code: room.code })),
		joinPost(event('/api/join', 'POST', tabB, { returning: true, code: room.code }))
	]);
	expect([a.status, b.status]).toEqual([200, 200]);
	expect(tabA.values.get(DEVICE_COOKIE)).toBe(tabB.values.get(DEVICE_COOKIE));
	expect(app.db.select().from(people).all()).toHaveLength(1);
	expect(app.db.select().from(personDevices).all()).toHaveLength(1);
	expect(
		(await (await preview(event(`/api/room-preview?code=${room.code}`, 'GET', tabB))).json()).returning?.displayName
	).toBe('Theo');
});

test("the phone's /ws upgrade with the new token ends the grace, so a copy is refused a second after the join", async () => {
	const { app, room } = installApp();
	const owner = await keptPhone(app);
	app.presence = new PresenceTracker();
	const thief = phone({ [DEVICE_COOKIE]: owner.values.get(DEVICE_COOKIE)! });
	await joinPost(event('/api/join', 'POST', owner, { returning: true, code: room.code }));

	// The old token on a socket does not end anything; the new one does.
	app.people.seenOnSocket(`${DEVICE_COOKIE}=${thief.values.get(DEVICE_COOKIE)}`, app.now());
	expect(deviceRow(app).prevTokenHash).not.toBeNull();
	app.people.seenOnSocket(`encore_singer=x; ${DEVICE_COOKIE}=${owner.values.get(DEVICE_COOKIE)}`, app.now());
	expect(deviceRow(app)).toMatchObject({ prevTokenHash: null, prevValidUntil: null, rotationSalt: null });
	expect(
		(await joinPost(event('/api/join', 'POST', thief, { returning: true, code: room.code, displayName: 'T2' }))).status
	).toBe(401);
});

test('a grace that runs out unused leaves nothing that, with an old cookie, derives the live token', async () => {
	const { app, room } = installApp();
	const owner = await keptPhone(app);
	app.presence = new PresenceTracker();
	const old = owner.values.get(DEVICE_COOKIE)!;
	await joinPost(event('/api/join', 'POST', lostResponse(owner), { returning: true, code: room.code }));
	expect(deviceRow(app).rotationSalt).not.toBeNull();

	// On the reaper tick.
	app.people.clearExpiredGrace(T0 + ROTATION_GRACE_MS - 1);
	expect(deviceRow(app).rotationSalt).not.toBeNull();
	app.people.clearExpiredGrace(T0 + ROTATION_GRACE_MS);
	const row = deviceRow(app);
	expect(row).toMatchObject({ prevTokenHash: null, prevValidUntil: null, rotationSalt: null });
	// Nothing left to derive from: no salt, and the old cookie's hash is nowhere in the table.
	expect(JSON.stringify(app.db.select().from(personDevices).all())).not.toContain(
		createHash('sha256').update(old).digest('hex')
	);
	expect(app.people.byDevice(old, T0 + ROTATION_GRACE_MS)).toBeNull();
});

test('an expired grace is also cleared the moment its old cookie is presented', async () => {
	const { app, room } = installApp();
	const owner = await keptPhone(app);
	app.presence = new PresenceTracker();
	await joinPost(event('/api/join', 'POST', lostResponse(owner), { returning: true, code: room.code }));
	app.clock = T0 + ROTATION_GRACE_MS;
	expect((await joinPost(event('/api/join', 'POST', owner, { returning: true, code: room.code }))).status).toBe(401);
	expect(deviceRow(app)).toMatchObject({ prevTokenHash: null, prevValidUntil: null, rotationSalt: null });
});

test("a returning join ends only its own person's idle nights: a turn or a live socket keeps a night", async () => {
	const { app, room } = installApp();
	const owner = await keptPhone(app);
	app.presence = new PresenceTracker();
	const personId = deviceRow(app).personId;
	const night = (name: string, pid: string | null = personId) =>
		app.singers.create(name, '#a796ff', app.now(), app.activeRoomId, pid);
	const queued = night('Theo q');
	const playing = night('Theo p');
	const online = night('Theo o');
	const idle = night('Theo i');
	const otherPerson = app.people.create('Ana', '#00ff00', app.now()).person.id;
	const anaIdle = night('Ana', otherPerson);
	const guestIdle = night('Bo', null);
	const entry = (id: string, singerId: string, status: 'queued' | 'playing') =>
		({ id, mediaId: 'm1', singerId, status, rotationSeq: 1, addedAt: 1 }) as never;
	app.state.hydrate([entry('e1', queued.id, 'queued'), entry('e2', playing.id, 'playing')], null);
	app.presence.connect(online.id);

	expect((await joinPost(event('/api/join', 'POST', owner, { returning: true, code: room.code }))).status).toBe(200);
	const alive = (s: { sessionToken: string }) => app.singers.bySessionToken(s.sessionToken) !== null;
	expect([queued, playing, online].map(alive)).toEqual([true, true, true]);
	expect(alive(idle)).toBe(false);
	expect([anaIdle, guestIdle].map(alive)).toEqual([true, true]);
});

test("sign out other phones also kills an unused copy of this phone's own cookie", async () => {
	const { app, room } = installApp();
	const { p } = sungGuest(app);
	await keepPost(event('/api/me/person', 'POST', p));
	const thief = phone({ [DEVICE_COOKIE]: p.values.get(DEVICE_COOKIE)! });
	expect((await signOutOthers(event('/api/me/person/others', 'DELETE', p))).status).toBe(200);
	expect(p.values.get(DEVICE_COOKIE)).not.toBe(thief.values.get(DEVICE_COOKIE));
	app.clock = T0 + ROTATION_GRACE_MS;
	expect((await joinPost(event('/api/join', 'POST', thief, { returning: true, code: room.code }))).status).toBe(401);
	expect((await (await preview(event(`/api/room-preview?code=${room.code}`, 'GET', p))).json()).returning).toEqual({
		displayName: 'Theo',
		color: '#a796ff'
	});
});

test('a copy used first rotates the owner out once the grace has passed, which is how a theft shows', async () => {
	const { app, room } = installApp();
	const owner = await keptPhone(app);
	const thief = phone({ [DEVICE_COOKIE]: owner.values.get(DEVICE_COOKIE)! });
	expect(
		(await joinPost(event('/api/join', 'POST', thief, { returning: true, code: room.code, displayName: 'T2' }))).status
	).toBe(200);
	app.clock = T0 + ROTATION_GRACE_MS;
	expect(
		(await (await preview(event(`/api/room-preview?code=${room.code}`, 'GET', owner))).json()).returning
	).toBeNull();
});

test('a device used within 180 days stays', async () => {
	const { app } = installApp();
	await keptPhone(app);
	app.clock = T0 + DEVICE_IDLE_MS - 1;
	expect(app.people.pruneIdle(app.now())).toEqual([]);
	expect(app.db.select().from(personDevices).all()).toHaveLength(1);
});

test('sign out other phones revokes them on the server and ends their nights', async () => {
	const { app, room, released } = installApp();
	const { singer, p } = sungGuest(app);
	await keepPost(event('/api/me/person', 'POST', p));
	const personId = app.singers.byId(singer.id)!.personId!;
	// Another phone of Theo's, kept and in the room, as pairing (PR 3) will add one.
	const other = app.people.create('Theo', '#a796ff', app.now());
	app.db.update(personDevices).set({ personId }).where(eq(personDevices.personId, other.person.id)).run();
	app.db.delete(people).where(eq(people.id, other.person.id)).run();
	const otherPhone = phone({ [DEVICE_COOKIE]: other.token });
	const otherNight = app.singers.create('Theo 2', '#a796ff', app.now(), app.activeRoomId, personId);

	const res = await signOutOthers(event('/api/me/person/others', 'DELETE', p));
	expect(res.status).toBe(200);
	expect(await res.json()).toMatchObject({ kept: true, otherPhones: 0 });
	expect(app.singers.bySessionToken(otherNight.sessionToken)).toBeNull();
	expect(released).toContain(otherNight.id);
	expect((await joinPost(event('/api/join', 'POST', otherPhone, { returning: true, code: room.code }))).status).toBe(
		401
	);
	// This phone is untouched.
	expect(app.singers.bySessionToken(p.values.get(SESSION_COOKIE))?.id).toBe(singer.id);
});

test('delete me removes the person, every device and past nights; tonight stays as a guest', async () => {
	const { app } = installApp();
	const { singer, p } = sungGuest(app);
	await keepPost(event('/api/me/person', 'POST', p));
	const personId = app.singers.byId(singer.id)!.personId!;
	const lastWeek = app.singers.create('Theo', '#a796ff', T0 - 7 * 86_400_000, app.activeRoomId, personId);
	const guest = app.singers.create('Ana', '#00ff00', T0, app.activeRoomId);

	const res = await deleteMe(event('/api/me/person', 'DELETE', p));
	expect(res.status).toBe(200);
	expect(app.db.select().from(people).all()).toEqual([]);
	expect(app.db.select().from(personDevices).all()).toEqual([]);
	expect(app.singers.byId(lastWeek.id)).toBeNull();
	expect(app.singers.byId(singer.id)?.personId).toBeNull();
	expect(app.singers.byId(guest.id)).not.toBeNull();
	expect(p.values.has(DEVICE_COOKIE)).toBe(false);
	expect(app.db.select().from(singers).where(isNotNull(singers.personId)).all()).toEqual([]);
});

test('delete me and sign out others refuse a caller who is not this kept person', async () => {
	const { app } = installApp();
	const theo = sungGuest(app, 'Theo');
	await keepPost(event('/api/me/person', 'POST', theo.p));
	const ana = sungGuest(app, 'Ana');
	// Ana's singer cookie with Theo's device cookie, and each alone.
	const mixed = phone({
		[SESSION_COOKIE]: ana.p.values.get(SESSION_COOKIE)!,
		[DEVICE_COOKIE]: theo.p.values.get(DEVICE_COOKIE)!
	});
	const deviceOnly = phone({ [DEVICE_COOKIE]: theo.p.values.get(DEVICE_COOKIE)! });
	for (const caller of [mixed, deviceOnly, ana.p, phone()]) {
		expect((await deleteMe(event('/api/me/person', 'DELETE', caller))).status).toBe(401);
		expect((await signOutOthers(event('/api/me/person/others', 'DELETE', caller))).status).toBe(401);
	}
	expect(app.db.select().from(people).all()).toHaveLength(1);
});

test('the kept-person writes refuse a request from another site', async () => {
	installApp();
	for (const [path, method] of [
		['/api/me/person', 'POST'],
		['/api/me/person', 'DELETE'],
		['/api/me/person/others', 'DELETE']
	] as const) {
		const res = await handle({
			event: event(path, method, phone(), undefined, { origin: 'http://evil.example' }),
			resolve: () => new Response('reached')
		} as never);
		expect(res.status, `${method} ${path}`).toBe(403);
	}
});
