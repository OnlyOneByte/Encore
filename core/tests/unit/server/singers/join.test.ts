// join -> singer:joined broadcast -> singer appears (validated via doJoin).
import { test, expect } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { doJoin, NameTakenError, RoomNotFoundError } from '$lib/server/singers/join';
import { SingerRepository } from '$lib/server/singers/repository';
import { PeopleRepository } from '$lib/server/people/repository';
import { HostKey } from '$lib/server/host-key';
import { RoomRepository } from '$lib/server/rooms/repository';
import {
	PALETTE_STOP_ARC_DEG,
	SINGER_COLORS,
	SINGER_HUES,
	hueDistance,
	hueToHex,
	nearestPaletteStop,
	type ServerEvent
} from '$lib/contract';
import { LocalLibrary } from '$lib/server/media/local';
import { YouTubeResolver } from '$lib/server/media/youtube';
import { SpotifyResolver } from '$lib/server/media/spotify-resolver';
import { createPopularityTracker } from '$lib/server/media/popularity';
import { MediaRepository } from '$lib/server/media/repository';
import { JobRepository } from '$lib/server/jobs/repository';
import { SettingsRepository } from '$lib/server/state/settings-repository';
import { JobReaper } from '$lib/server/jobs/reaper';
import { WorkerRegistry } from '$lib/server/jobs/registry';
import { WorkerHub } from '$lib/server/jobs/worker-hub';
import { LocalMediaStore } from '$lib/server/media/store';
import { PendingDeletes } from '$lib/server/media/library-manage';
import { PresenceTracker } from '$lib/server/realtime/presence';
import { AuthoritativeState } from '$lib/server/state/store';
import { PlayTracker } from '$lib/server/media/plays';
import type { EncoreApp } from '$lib/server/app';
import { AttemptLedger } from '$lib/server/jobs/attempts';
import { PlayLog } from '$lib/server/media/play-log';
import { NightLog } from '$lib/server/nights/repository';
import { SavedSongs } from '$lib/server/songs/repository';

function appHarness(): { app: EncoreApp; published: ServerEvent[]; rooms: RoomRepository; activeRoomId: string } {
	const db = migratedDb();
	const rooms = new RoomRepository(db);
	const activeRoomId = rooms.ensureActive(1_700_000_000_000).id;
	const published: ServerEvent[] = [];
	const attempts = new AttemptLedger(db);
	const jobs = new JobRepository(db, attempts);
	const workers = new WorkerRegistry();
	const mediaById = new Map();
	const app: EncoreApp = {
		db,
		// A real state, not null: doJoin consults the queue, because a name stays claimed while its owner
		// still holds a turn.
		state: new AuthoritativeState(),
		singers: new SingerRepository(db),
		people: new PeopleRepository(db),
		hostKey: new HostKey(db, null),
		rooms,
		activeRoomId,
		presence: new PresenceTracker(),
		plays: new PlayTracker(() => {}),
		jobs,
		attempts,
		playLog: new PlayLog(db),
		nights: new NightLog(db),
		savedSongs: new SavedSongs(db),
		settings: new SettingsRepository(db),
		reaper: new JobReaper(jobs),
		workers,
		workerHub: new WorkerHub({
			queueEntries: () => [],
			jobs,
			registry: workers,
			mediaById,
			toWorker: () => {},
			broadcast: () => {},
			now: () => 1_700_000_000_000
		}),
		mediaById,
		media: new MediaRepository(db),
		localLibrary: new LocalLibrary(),
		youtube: new YouTubeResolver(async () => []),
		// SEPARATE resolver instance, not an alias of `youtube`: EncoreApp declares two, and a harness that
		// reuses one hides a handler reaching for the wrong search surface.
		ytmusic: new YouTubeResolver(async () => []),
		spotify: new SpotifyResolver(async () => []),
		popularity: createPopularityTracker(),
		mediaStore: new LocalMediaStore(),
		mediaStoreConfig: { kind: 'local' },
		pendingDeletes: new PendingDeletes(() => {}),
		publish: (e) => published.push(e),
		toWorker: () => {},
		now: () => 1_700_000_000_000
	};
	return { app, published, rooms, activeRoomId };
}

test('valid join creates a singer and broadcasts singer:joined', () => {
	const { app, published } = appHarness();
	const { singer } = doJoin(app, { displayName: 'Maya', color: '#ff5cae' });
	expect(singer.displayName).toBe('Maya');
	expect(singer.color).toBe('#ff5cae');
	expect(app.singers.bySessionToken(singer.sessionToken)?.id).toBe(singer.id);

	expect(published).toHaveLength(1);
	const ev = published[0] as Extract<ServerEvent, { type: 'singer:joined' }>;
	expect(ev.type).toBe('singer:joined');
	expect(ev.singer.id).toBe(singer.id);
});

test('the singer:joined broadcast carries NO session token', () => {
	// The frame reaches every socket in the room, including a cookie-less spectator. The session token IS
	// the whole auth axis, so a token on this wire hands any listener the credential to impersonate the new
	// singer. Serialised exactly as server.ts does — a raw JSON.stringify, no further redaction — so both
	// halves of the strip (the runtime one and the PublicSinger type) are load-bearing here.
	const { app, published } = appHarness();
	const { singer } = doJoin(app, { displayName: 'Dana', color: '#ff5cae' });

	// Non-vacuity: a token really was minted, so the exclusion below is not passing because minting stopped.
	expect(singer.sessionToken.length).toBeGreaterThan(20);

	const ev = published[0] as Extract<ServerEvent, { type: 'singer:joined' }>;
	const wire = JSON.stringify(ev);
	expect(wire).not.toContain(singer.sessionToken);
	expect(wire).not.toContain('sessionToken');
	// The public fields still ride the wire: the strip removes only the credential.
	expect(ev.singer.id).toBe(singer.id);
	expect(ev.singer.displayName).toBe('Dana');
	expect((ev.singer as Record<string, unknown>).sessionToken).toBeUndefined();
});

/* A guest who never touched the ring sends NO colour, and the room picks one at join time. Guests scan the TV
   together, so every phone read the same room preview: a client-side default gave all four the same violet. */
const stopOf = (hex: string) => nearestPaletteStop(hex);

test('an unusable colour gets the same free pick as no colour, not the first preset', () => {
	// Maya holds the first preset's stop, so falling back to the first preset would hand Sam and Kai her colour.
	for (const bad of ['#nonsense', '#000000']) {
		const { app } = appHarness();
		doJoin(app, { displayName: 'Maya' });
		const untouched = appHarness().app;
		doJoin(untouched, { displayName: 'Maya' });
		const expected = doJoin(untouched, { displayName: 'Sam' }).singer.color;
		const got = doJoin(app, { displayName: 'Sam', color: bad }).singer.color;
		expect(got, bad).toBe(expected);
		expect(stopOf(got).i, bad).not.toBe(stopOf(SINGER_COLORS[0]).i);
	}
});

test('four guests who opened the join screen together and never touched the ring get four colours', () => {
	const { app } = appHarness();
	const colours = ['Sim1', 'Sim2', 'Sim3', 'Sim4'].map((n) => doJoin(app, { displayName: n }).singer.color);
	expect(new Set(colours.map((c) => stopOf(c).i)).size).toBe(4);
	// The first default is still the first preset, snapped to the ring.
	expect(colours[0]).toBe(stopOf(SINGER_COLORS[0]).fill);
});

test('twenty default joins spread round the wheel instead of walking one arc', () => {
	const { app } = appHarness();
	const hues = Array.from({ length: 20 }, (_, k) => stopOf(doJoin(app, { displayName: `G${k}` }).singer.color).hue);
	const minGap = (hs: number[]) => Math.min(...hs.flatMap((a, i) => hs.slice(i + 1).map((b) => hueDistance(a, b))));
	// Sixteen defaults sit at least two stops apart (48 stops, so ~22° spacing is the best possible)...
	expect(minGap(hues.slice(0, 16))).toBeGreaterThanOrEqual(2 * PALETTE_STOP_ARC_DEG - 1);
	// ...and twenty still share no stop.
	expect(new Set(hues).size).toBe(20);
	expect(minGap(hues)).toBeGreaterThan(PALETTE_STOP_ARC_DEG / 2);
});

test('a colour the guest picked is kept even when someone already holds it', () => {
	const { app } = appHarness();
	doJoin(app, { displayName: 'Maya', color: '#ff5cae' });
	expect(doJoin(app, { displayName: 'Theo', color: '#ff5cae' }).singer.color).toBe('#ff5cae');
});

test('a wheel hue is KEPT, not rewritten to a preset', () => {
	// Not an allowlist of the eight presets: under one, a guest who picked any other hue joined as violet
	// with nothing said, which makes a colour wheel impossible.
	const { app } = appHarness();
	const picked = hueToHex(SINGER_HUES[7]!);
	const { singer } = doJoin(app, { displayName: 'Ada', color: picked });
	expect(singer.color).toBe(picked);
	expect(singer.color).not.toBe(SINGER_COLORS[0]);
});

test('a colour whose dot would vanish on the dark surfaces is refused', () => {
	const { app } = appHarness();
	const { singer } = doJoin(app, { displayName: 'Kai', color: '#000000' });
	// An empty room's free pick: the first preset, snapped to the ring.
	expect(singer.color).toBe(stopOf(SINGER_COLORS[0]).fill);
});

test('shorthand hex is canonicalised on the way in', () => {
	// Everything downstream interpolates this straight into CSS, so the shape is enforced here.
	const { app } = appHarness();
	const { singer } = doJoin(app, { displayName: 'Ren', color: '#0AF' });
	expect(singer.color).toBe('#00aaff');
});

test('blank display name is rejected', () => {
	const { app } = appHarness();
	expect(() => doJoin(app, { displayName: '   ', color: SINGER_COLORS[0] })).toThrow('display name required');
});

// Display-name uniqueness: first come, first served, but only against people still IN THE ROOM. The
// singers table is append-only, so an unqualified unique check claims a name forever and next month's
// guest is rejected by a ghost row from tonight.

test('a name held by someone here is refused', () => {
	const { app } = appHarness();
	const first = doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0] });
	app.presence.connect(first.singer.id);
	expect(() => doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[1] })).toThrow(NameTakenError);
});

test('the check ignores case and surrounding whitespace', () => {
	const { app } = appHarness();
	app.presence.connect(doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0] }).singer.id);
	expect(() => doJoin(app, { displayName: '  dana ', color: SINGER_COLORS[1] })).toThrow(NameTakenError);
	expect(() => doJoin(app, { displayName: 'DANA', color: SINGER_COLORS[1] })).toThrow(NameTakenError);
});

test('a name is still held while its owner is AWAY, so nobody takes it while she is in the kitchen', () => {
	const { app } = appHarness();
	const dana = doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0] }).singer;
	app.presence.connect(dana.id);
	app.presence.disconnect(dana.id, app.now());
	expect(() => doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[1] })).toThrow(NameTakenError);
});

test('a name returns to the pool once its owner has GONE', () => {
	const { app } = appHarness();
	app.settings.setRoom({ presenceGraceMinutes: 0 }, 'main'); // expire on the first sweep after the drain
	const dana = doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0] }).singer;
	app.presence.connect(dana.id);
	app.presence.disconnect(dana.id, app.now());
	app.presence.evaluate({ now: app.now(), graceMs: 0, hasPendingSongs: () => false });

	// The case unqualified uniqueness breaks forever: the same name, another night.
	const second = doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[1] });
	expect(second.singer.displayName).toBe('Dana');
	expect(second.singer.id).not.toBe(dana.id);
});

test('a rehydrated singer that never reconnected does not block a join', () => {
	// A singer row with no presence record this process (rehydrated after a restart) is `gone` by
	// definition, so the append-only table must not hold their name hostage. Written through the repository
	// directly, bypassing the join-time presence seed.
	const { app } = appHarness();
	const ghost = app.singers.create('Ghost', SINGER_COLORS[0], app.now(), app.activeRoomId);
	expect(app.presence.stateOf(ghost.id, app.now(), 999_999, false)).toBe('gone');
	expect(() => doJoin(app, { displayName: 'Ghost', color: SINGER_COLORS[1] })).not.toThrow();
});

// The /api/join → WebSocket-open gap: doJoin writes the singer row, but if only the WS `open` handler
// registers presence then `stateOf` reads `gone` until that socket lands, and a second phone can claim the
// identical name. doJoin seeds the singer into presence as AWAY at join time to close it.

test('two joins with the SAME name inside the join window collide', () => {
	const { app } = appHarness();
	doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0] });
	// No presence.connect: the socket has not opened, but the join seed holds the name.
	expect(() => doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[1] })).toThrow(NameTakenError);
});

test('the join seed is AWAY, so the name frees up once the grace sweep expires it', () => {
	// A phone that joined and immediately died must not hold a name all night: the away seed expires
	// through the ordinary sweep, like any dropped socket.
	const { app } = appHarness();
	app.settings.setRoom({ presenceGraceMinutes: 0 }, 'main'); // expire on the first sweep after the drain
	doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0] });
	app.presence.evaluate({ now: app.now(), graceMs: 0, hasPendingSongs: () => false });
	expect(() => doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[1] })).not.toThrow();
});

test('distinct names are unaffected', () => {
	const { app } = appHarness();
	app.presence.connect(doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0] }).singer.id);
	expect(() => doJoin(app, { displayName: 'Maya', color: SINGER_COLORS[1] })).not.toThrow();
});

// Room identity: minting, and join-by-code. A room is minted and a phone joins a SPECIFIC one by its code
// (the QR encodes it), and the join returns WHICH room it landed in. Playback, queue and singers are NOT
// yet room-scoped, so the identity is what the join returns and the session carries, not a column on the
// singer.

test("a bare join lands in the core's single active room", () => {
	const { app, activeRoomId } = appHarness();
	const { roomId } = doJoin(app, { displayName: 'Maya', color: SINGER_COLORS[0] });
	expect(roomId).toBe(activeRoomId);
});

// A phone joining WITH a room code joins THAT room's identity, not the default: doJoin resolves the code
// via rooms.byCode and returns that room's id, and the route sets it as the room cookie.
test('joining with a room code lands in THAT room, not the default active one', () => {
	const { app, rooms, activeRoomId } = appHarness();
	// A second, distinct party on the same core.
	const other = rooms.create(1_700_000_000_001);
	expect(other.id).not.toBe(activeRoomId);

	const { roomId } = doJoin(app, { displayName: 'Maya', color: SINGER_COLORS[0], code: other.code });
	expect(roomId).toBe(other.id);
	expect(roomId).not.toBe(activeRoomId);
});

test('the room code is matched case- and whitespace-insensitively', () => {
	// Codes are minted uppercase, so a lowercased and padded copy typed off a TV still joins.
	const { app, rooms } = appHarness();
	const other = rooms.create(1_700_000_000_001);
	const { roomId } = doJoin(app, {
		displayName: 'Sam',
		color: SINGER_COLORS[0],
		code: `  ${other.code.toLowerCase()} `
	});
	expect(roomId).toBe(other.id);
});

test('an unknown room code is refused, never silently routed to the default room', () => {
	const { app } = appHarness();
	expect(() => doJoin(app, { displayName: 'Kai', color: SINGER_COLORS[0], code: 'NOSUCH' })).toThrow(RoomNotFoundError);
});

test('a bad code fails BEFORE a singer is created, leaving no orphaned row or claimed name', () => {
	const { app } = appHarness();
	expect(() => doJoin(app, { displayName: 'Kai', color: SINGER_COLORS[0], code: 'NOSUCH' })).toThrow(RoomNotFoundError);
	// The name is free and no singer exists, so a retry with a bare join succeeds as the same name.
	const { singer } = doJoin(app, { displayName: 'Kai', color: SINGER_COLORS[0] });
	expect(singer.displayName).toBe('Kai');
	expect(app.singers.listPublic(app.activeRoomId)).toHaveLength(1);
});
