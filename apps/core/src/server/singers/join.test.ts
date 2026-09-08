// join -> singer:joined broadcast -> singer appears (validated via doJoin).
import { test, expect } from 'bun:test';
import { migratedDb } from '../db/test-db';
import { doJoin, NameTakenError, RoomNotFoundError } from './join';
import { SingerRepository } from './repository';
import { RoomRepository } from '../rooms/repository';
import { SINGER_COLORS, SINGER_HUES, hueToHex, type ServerEvent } from '@encore/shared';
import { LocalLibrary } from '../media/local';
import { YouTubeResolver } from '../media/youtube';
import { SpotifyResolver } from '../media/spotify-resolver';
import { createPopularityTracker } from '../media/popularity';
import { MediaRepository } from '../media/repository';
import { JobRepository } from '../jobs/repository';
import { SettingsRepository } from '../state/settings-repository';
import { JobReaper } from '../jobs/reaper';
import { WorkerRegistry } from '../jobs/registry';
import { WorkerHub } from '../jobs/worker-hub';
import { LocalMediaStore } from '../media/store';
import { PresenceTracker } from '../realtime/presence';
import { AuthoritativeState } from '../state/store';
import { PlayTracker } from '../media/plays';
import type { EncoreApp } from '../app';
import { AttemptLedger } from '../jobs/attempts';
import { PlayLog } from '../media/play-log';

function appHarness(): { app: EncoreApp; published: ServerEvent[]; rooms: RoomRepository; activeRoomId: string } {
	const db = migratedDb();
	const rooms = new RoomRepository(db);
	// #654: doJoin resolves the room a join lands in, so the harness mints the single active room.
	const activeRoomId = rooms.ensureActive(1_700_000_000_000).id;
	const published: ServerEvent[] = [];
	const attempts = new AttemptLedger(db);
	const jobs = new JobRepository(db, attempts);
	const workers = new WorkerRegistry();
	const mediaById = new Map();
	const app: EncoreApp = {
		db,
		// A real state, not null: doJoin now consults the queue, because a name stays claimed while its
		// owner still holds a turn.
		state: new AuthoritativeState(),
		singers: new SingerRepository(db),
		rooms,
		activeRoomId,
		presence: new PresenceTracker(),
		plays: new PlayTracker(() => {}),
		jobs,
		attempts,
		playLog: new PlayLog(db),
		settings: new SettingsRepository(db),
		reaper: new JobReaper(jobs),
		workers,
		workerHub: new WorkerHub({
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
		spotify: new SpotifyResolver(async () => []),
		popularity: createPopularityTracker(),
		mediaStore: new LocalMediaStore(),
		mediaStoreConfig: { kind: 'local' },
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

test('invalid color falls back to the first palette color', () => {
	const { app } = appHarness();
	const { singer } = doJoin(app, { displayName: 'Sam', color: '#nonsense' });
	expect(singer.color).toBe(SINGER_COLORS[0]);
});

test('a wheel hue is KEPT, not rewritten to a preset', () => {
	// The behaviour change. This used to be an allowlist of the eight presets, so a guest who picked
	// any other hue joined as violet with nothing said — which made a colour wheel impossible.
	const { app } = appHarness();
	const picked = hueToHex(SINGER_HUES[7]!);
	const { singer } = doJoin(app, { displayName: 'Ada', color: picked });
	expect(singer.color).toBe(picked);
	expect(singer.color).not.toBe(SINGER_COLORS[0]);
});

test('a colour whose dot would vanish on the dark surfaces is refused', () => {
	const { app } = appHarness();
	const { singer } = doJoin(app, { displayName: 'Kai', color: '#000000' });
	expect(singer.color).toBe(SINGER_COLORS[0]);
});

test('shorthand hex is canonicalised on the way in', () => {
	// Everything downstream interpolates this straight into CSS, so one shape is worth enforcing here.
	const { app } = appHarness();
	const { singer } = doJoin(app, { displayName: 'Ren', color: '#0AF' });
	expect(singer.color).toBe('#00aaff');
});

test('blank display name is rejected', () => {
	const { app } = appHarness();
	expect(() => doJoin(app, { displayName: '   ', color: SINGER_COLORS[0] })).toThrow('display name required');
});

// ── display-name uniqueness ────────────────────────────────────────────────────
// First come, first served — but only against people still IN THE ROOM. The singers table is
// append-only, so an unqualified unique check would claim a name forever and next month's Dana would be
// rejected by a ghost row from tonight.

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

	// This is the case unqualified uniqueness would have broken forever: a different Dana, another night.
	const second = doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[1] });
	expect(second.singer.displayName).toBe('Dana');
	expect(second.singer.id).not.toBe(dana.id);
});

test('a rehydrated singer that never reconnected does not block a join', () => {
	// A singer row with no presence record this process (e.g. rehydrated after a restart) is `gone` by
	// definition, so their name must not be held hostage by the append-only table. Simulated by writing
	// the row through the repository directly, bypassing the join-time presence seed doJoin adds.
	const { app } = appHarness();
	const ghost = app.singers.create('Ghost', SINGER_COLORS[0], app.now(), app.activeRoomId);
	expect(app.presence.stateOf(ghost.id, app.now(), 999_999, false)).toBe('gone');
	expect(() => doJoin(app, { displayName: 'Ghost', color: SINGER_COLORS[1] })).not.toThrow();
});

// ── the /api/join → WebSocket-open gap (PR #19 regression) ─────────────────────
// doJoin writes the singer row, but only the WS `open` handler used to register them with presence. In
// the window before that socket lands, presence.stateOf returned `gone` — so a second phone could claim
// the identical name. doJoin now seeds the singer into presence as away at join time to close that gap.

test('two joins with the SAME name inside the join window collide', () => {
	const { app } = appHarness();
	doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0] });
	// No presence.connect — the first phone's socket has not opened yet, but the join seed holds the name.
	expect(() => doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[1] })).toThrow(NameTakenError);
});

test('the join seed is AWAY, so the name frees up once the grace sweep expires it', () => {
	// A phone that joined and immediately died must not hold a name for the whole night: the away seed
	// expires through the ordinary sweep, same as any dropped socket.
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

// ── room identity: minting + join-by-code (#654) ───────────────────────────────
// Before this issue nothing wrote the rooms table and doJoin ignored any code: every join landed in
// one implicit singleton party. The identity layer mints a room and lets a phone join a SPECIFIC one
// by its code (the QR encodes it), returning WHICH room the join landed in. Playback/queue/singers
// are NOT yet scoped to the room — that is #655/#656 — so the identity is what the join returns and
// the session then carries, not (yet) a column on the singer.

test("a bare join lands in the core's single active room", () => {
	const { app, activeRoomId } = appHarness();
	const { roomId } = doJoin(app, { displayName: 'Maya', color: SINGER_COLORS[0] });
	expect(roomId).toBe(activeRoomId);
});

// THE PIN: a phone joining WITH a room code joins THAT room's identity, not the default. Reds on base,
// where doJoin takes no code and returns no roomId. Mechanism: doJoin resolves the code via
// rooms.byCode and returns that room's id; the /api/join route sets it as the room cookie.
test('joining with a room code lands in THAT room, not the default active one', () => {
	const { app, rooms, activeRoomId } = appHarness();
	// A second, distinct party on the same core. Its code is the identity a phone scanning its QR uses.
	const other = rooms.create(1_700_000_000_001);
	expect(other.id).not.toBe(activeRoomId);

	const { roomId } = doJoin(app, { displayName: 'Maya', color: SINGER_COLORS[0], code: other.code });
	expect(roomId).toBe(other.id);
	expect(roomId).not.toBe(activeRoomId);
});

test('the room code is matched case- and whitespace-insensitively', () => {
	// A guest types a code off a TV; codes are minted uppercase, so a lowercased/padded copy still joins.
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
	// The name is free and no singer exists — a retry with a good (bare) join succeeds as the same name.
	const { singer } = doJoin(app, { displayName: 'Kai', color: SINGER_COLORS[0] });
	expect(singer.displayName).toBe('Kai');
	expect(app.singers.listPublic(app.activeRoomId)).toHaveLength(1);
});
