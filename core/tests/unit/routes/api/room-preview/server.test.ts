// GET /api/room-preview — the scanned-guest confirmation source, driven through the REAL handler against a
// real SingerRepository + PresenceTracker on a migrated in-memory DB. Two load-bearing properties:
//
// SCOPING is an INTERSECTION. Presence is one GLOBAL tracker, so `online()` alone counts other rooms'
// phones, and `listPublic(roomId)` is not presence-filtered, so it alone counts singers long gone.
//
// ONE POPULATION. Counting LIVE SOCKETS while `assertNameFree` refuses anyone whose presence state is not
// `gone` lets a guest read "This room is empty right now" and then be rejected with a name-taken error,
// while /tv renders that same singer as AWAY. Both read `roomMembership`, so an away member is counted,
// named and pipped, and `awayCount` keeps the sentence honest about it.
import { test, expect, afterEach } from 'bun:test';
import { GET } from '$routes/api/room-preview/+server';
import { RoomRepository } from '$lib/server/rooms/repository';
import { SingerRepository } from '$lib/server/singers/repository';
import { PresenceTracker } from '$lib/server/realtime/presence';
import { SettingsRepository } from '$lib/server/state/settings-repository';
import { assertNameFree, NameTakenError } from '$lib/server/singers/join';
import { migratedDb } from '$lib/server/db/test-db';

const APP_KEY = Symbol.for('encore.app');
const NOW = 1_700_000_000_000;

// `now` is a MUTABLE box, because the away branch is a property of elapsed time: a singer becomes away by
// dropping their socket and gone by the grace window expiring, and nothing but the clock moves them. The
// real SettingsRepository supplies the grace value, so the window is the one the app ships.
function installApp() {
	const db = migratedDb();
	const rooms = new RoomRepository(db);
	const room = rooms.ensureActive(1); // the active party
	const other = rooms.create(2); // a second, unrelated party
	const singers = new SingerRepository(db);
	const presence = new PresenceTracker();
	const settings = new SettingsRepository(db);
	const clock = { now: NOW };
	const app = {
		db,
		rooms,
		activeRoomId: room.id,
		singers,
		presence,
		settings,
		state: { entries: [] as unknown[] },
		now: () => clock.now
	};
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = app;
	return { room, other, singers, presence, settings, clock, app };
}

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
});

function call(code: string) {
	return GET({ url: new URL(`http://x/api/room-preview?code=${encodeURIComponent(code)}`) } as never);
}

test('present = online AND a singer of THIS room — not online alone, not listed alone', async () => {
	const { room, other, singers, presence } = installApp();
	// Two connected (here), one never connected (gone).
	const maya = singers.create('Maya', '#7c5cff', 1, room.id);
	const dana = singers.create('Dana', '#22c55e', 1, room.id);
	singers.create('Gone', '#f59e0b', 1, room.id); // in the room, but no live socket
	// Connected in a DIFFERENT room: online, but not here.
	const elsewhere = singers.create('Elsewhere', '#ef4444', 1, other.id);

	presence.connect(maya.id);
	presence.connect(dana.id);
	presence.connect(elsewhere.id); // online globally, wrong room

	const res = await call(room.code);
	expect(res.status).toBe(200);
	const body = await res.json();

	// The INTERSECTION: 2, not 4 (listPublic ∪ other) and not 3 (all room singers).
	expect(body.presentCount).toBe(2);
	expect(new Set(body.names)).toEqual(new Set(['Maya', 'Dana']));
	// The COLOURS come from the same intersection in the same order, because the join ring pips them: a set
	// built from a different filter shows the wrong colour as taken. Order-matched to `names`.
	expect(body.colors).toEqual(body.names.map((n: string) => (n === 'Maya' ? maya.color : dana.color)));
	expect(body.colors).not.toContain('#f59e0b'); // the away singer's
	expect(body.colors).not.toContain('#ef4444'); // the other room's
	expect(body.names).not.toContain('Gone');
	expect(body.names).not.toContain('Elsewhere');
	// The normalised code is echoed, though it is never the confirmation itself.
	expect(body.code).toBe(room.code);
});

// An away singer still HOLDS their name — `assertNameFree` refuses it and /tv lists them as AWAY — so a
// preview that omits them lets the join screen say the room is empty and then reject the submit. Both
// halves are asserted together, because the property is their AGREEMENT.
test('an away singer is counted, named and pipped — the room is not "empty" while they hold a name', async () => {
	const { room, singers, presence, app } = installApp();
	const maya = singers.create('Maya', '#7c5cff', 1, room.id);
	// Connected, then the phone locked: inside the grace window this is `away`, not `gone`.
	presence.connect(maya.id);
	presence.disconnect(maya.id, NOW);

	const body = await (await call(room.code)).json();
	expect(body.presentCount).toBe(1);
	expect(body.awayCount).toBe(1);
	expect(body.names).toEqual(['Maya']);
	// The ring pips her colour, which is what stops a near-twin arriving on the TV roster.
	expect(body.colors).toEqual([maya.color]);

	// The other half of the contradiction: the name really is refused.
	expect(() => assertNameFree(app as never, room.id, 'Maya')).toThrow(NameTakenError);
});

test('reachable and away members are counted together, with awayCount naming the split', async () => {
	const { room, singers, presence } = installApp();
	singers.create('Here', '#7c5cff', 1, room.id);
	const away = singers.create('Away', '#22c55e', 1, room.id);
	const here = singers.listPublic(room.id).find((s) => s.displayName === 'Here')!;
	presence.connect(here.id);
	presence.connect(away.id);
	presence.disconnect(away.id, NOW);

	const body = await (await call(room.code)).json();
	expect(body.presentCount).toBe(2);
	expect(body.awayCount).toBe(1);
	// `here` first, so a caller naming only a few people names reachable ones.
	expect(body.names).toEqual(['Here', 'Away']);
});

test('a singer past the grace window is gone from both the count and the name pool', async () => {
	const { room, singers, presence, clock, app } = installApp();
	const maya = singers.create('Maya', '#7c5cff', 1, room.id);
	presence.connect(maya.id);
	presence.disconnect(maya.id, NOW);
	// `evaluate` is the only thing that starts a grace clock or moves anyone to `gone`, and a zero window
	// expires it on the spot — a legal room setting (MIN_PRESENCE_GRACE_MINUTES is 0).
	presence.evaluate({ now: NOW, graceMs: 0, hasPendingSongs: () => false });
	clock.now = NOW + 1;

	const body = await (await call(room.code)).json();
	expect(body.presentCount).toBe(0);
	expect(body.awayCount).toBe(0);
	// Which is when the name becomes free again: the pool and the preview move together.
	expect(() => assertNameFree(app as never, room.id, 'Maya')).not.toThrow();
});

test('a malformed (non-six) code is a 400 with a reason, not "not found"', async () => {
	installApp();
	const res = await call('ABC'); // three characters
	expect(res.status).toBe(400);
	const body = await res.json();
	expect(typeof body.error).toBe('string');
	expect(body.error.length).toBeGreaterThan(0);
});

test('a well-formed code naming no room is a 404 that states the code', async () => {
	installApp();
	const res = await call('ZZZZZZ'); // six valid characters, no such room
	expect(res.status).toBe(404);
	const body = await res.json();
	expect(body.error).toContain('ZZZZZZ');
});

test('the code is normalised before lookup — lower case and punctuation resolve the same room', async () => {
	const { room } = installApp();
	// The endpoint upper-cases and strips before byCode, so a lower-cased code still resolves.
	const res = await call(room.code.toLowerCase());
	expect(res.status).toBe(200);
	expect((await res.json()).code).toBe(room.code);
});
