// Renaming, and leaving on purpose.
//
// Both are new capabilities: the singers table was create/read only, and there was no way out of a room
// at all. The rules worth pinning are the ones that are easy to get subtly wrong — a rename colliding
// with itself, and a leave taking the song currently on screen with it.
import { test, expect } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { doJoin, assertNameFree, NameTakenError } from '$lib/server/singers/join';
import { doLeave, removableOnLeave } from '$lib/server/singers/leave';
import { SingerRepository } from '$lib/server/singers/repository';
import { RoomRepository } from '$lib/server/rooms/repository';
import { SINGER_COLORS, type ServerEvent, type Media, type QueueEntry } from '$lib/contract';
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
import { PresenceTracker } from '$lib/server/realtime/presence';
import { AuthoritativeState } from '$lib/server/state/store';
import { PlayTracker } from '$lib/server/media/plays';
import type { EncoreApp } from '$lib/server/app';

const NOW = 1_700_000_000_000;

function appHarness(): { app: EncoreApp; published: ServerEvent[] } {
	const db = migratedDb();
	const rooms = new RoomRepository(db);
	// doJoin resolves the room a join lands in, so the harness mints the single active room.
	const activeRoomId = rooms.ensureActive(1_700_000_000_000).id;
	const published: ServerEvent[] = [];
	const jobs = new JobRepository(db);
	const workers = new WorkerRegistry();
	const mediaById = new Map<string, Media>();
	const app: EncoreApp = {
		db,
		state: new AuthoritativeState(),
		singers: new SingerRepository(db),
		rooms,
		activeRoomId,
		presence: new PresenceTracker(),
		plays: new PlayTracker(() => {}),
		jobs,
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
			now: () => NOW
		}),
		mediaById,
		media: new MediaRepository(db),
		localLibrary: new LocalLibrary(),
		youtube: new YouTubeResolver(async () => []),
		spotify: new SpotifyResolver(async () => []),
		popularity: createPopularityTracker(),
		mediaStore: new LocalMediaStore(),
		mediaStoreConfig: { kind: 'local' },
		publish: (e: ServerEvent) => published.push(e),
		toWorker: () => {},
		now: () => NOW
	} as unknown as EncoreApp;
	return { app, published };
}

const entry = (id: string, singerId: string, status: QueueEntry['status'] = 'queued'): QueueEntry =>
	({ id, mediaId: 'm-' + id, singerId, status, rotationSeq: 0, addedAt: 1 }) as QueueEntry;

// ── rename ────────────────────────────────────────────────────────────────────

test('a rename does not collide with the singer own current name', () => {
	// The trap: assertNameFree without an exception would refuse every no-op save, and every change of
	// capitalisation, because the singer already holds the name.
	const { app } = appHarness();
	const dana = doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0] }).singer;
	app.presence.connect(dana.id);
	expect(() => assertNameFree(app, app.activeRoomId, 'Dana', dana.id)).not.toThrow();
	expect(() => assertNameFree(app, app.activeRoomId, 'DANA', dana.id)).not.toThrow();
});

test('a rename still collides with somebody else in the room', () => {
	const { app } = appHarness();
	const dana = doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0] }).singer;
	const maya = doJoin(app, { displayName: 'Maya', color: SINGER_COLORS[1] }).singer;
	app.presence.connect(dana.id);
	app.presence.connect(maya.id);
	expect(() => assertNameFree(app, app.activeRoomId, 'dana', maya.id)).toThrow(NameTakenError);
});

// name uniqueness is PER-ROOM. A name held by someone in ANOTHER room does not collide, and the
// check must be scoped to the room passed, not run deployment-wide over every singer. Bites the
// room-scoped assertNameFree (and the listPublic(roomId) it now calls): with an unscoped roster this
// throws NameTakenError because roomB's Dana would be seen from roomA.
test('a name taken in another room does not collide — uniqueness is per-party', () => {
	const { app } = appHarness();
	// A second party on the same core. doJoin resolves a room by code, so mint one and join it.
	const roomB = app.rooms.create(app.now() + 1);
	const danaB = doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0], code: roomB.code }).singer;
	app.presence.connect(danaB.id);
	// roomB has a live Dana; the ACTIVE room (roomA) does not — so 'Dana' is free THERE.
	expect(() => assertNameFree(app, app.activeRoomId, 'Dana')).not.toThrow();
	// ...and joining roomA as Dana succeeds, coexisting with roomB's Dana.
	const danaA = doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[1] }).singer;
	expect(danaA.id).not.toBe(danaB.id);
	// The reverse also holds: roomB still refuses a second Dana in ITS OWN room.
	expect(() => assertNameFree(app, roomB.id, 'Dana')).toThrow(NameTakenError);
});

test('updateProfile changes name and colour and keeps the session token', () => {
	// The token must survive: renaming is not re-joining, so the phone keeps its cookie and its place.
	const { app } = appHarness();
	const dana = doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0] }).singer;
	const updated = app.singers.updateProfile(dana.id, 'Dana B', SINGER_COLORS[3]);
	expect(updated?.displayName).toBe('Dana B');
	expect(updated?.color).toBe(SINGER_COLORS[3]);
	expect(updated?.sessionToken).toBe(dana.sessionToken);
	expect(app.singers.bySessionToken(dana.sessionToken)?.displayName).toBe('Dana B');
});

test('updateProfile trims, caps at 32 chars, and refuses a blank name', () => {
	const { app } = appHarness();
	const dana = doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0] }).singer;
	expect(app.singers.updateProfile(dana.id, '  Dana  ', dana.color)?.displayName).toBe('Dana');
	expect(app.singers.updateProfile(dana.id, 'x'.repeat(60), dana.color)?.displayName).toHaveLength(32);
	expect(app.singers.updateProfile(dana.id, '   ', dana.color)).toBeNull();
	// ...and the refusal left the old name in place rather than half-applying.
	expect(app.singers.byId(dana.id)?.displayName).toHaveLength(32);
});

// ── leave ─────────────────────────────────────────────────────────────────────

test('leaving un-queues their songs and forgets them immediately', () => {
	const { app, published } = appHarness();
	const dana = doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0] }).singer;
	const maya = doJoin(app, { displayName: 'Maya', color: SINGER_COLORS[1] }).singer;
	app.presence.connect(dana.id);
	app.state.applyQueueOp({ op: 'add', entry: entry('d1', dana.id) });
	app.state.applyQueueOp({ op: 'add', entry: entry('d2', dana.id) });
	app.state.applyQueueOp({ op: 'add', entry: entry('m1', maya.id) });
	published.length = 0;

	const res = doLeave(app, dana.id);
	expect(res.removed.sort()).toEqual(['d1', 'd2']);
	expect(app.state.entries.map((e) => e.id)).toEqual(['m1']); // somebody else's turn is untouched
	expect(app.presence.stateOf(dana.id, NOW, 999_999, false)).toBe('gone'); // no grace window waited
	// Removals ride the ordinary patch path, so every client converges the way it would on a tapped remove.
	expect(published.filter((e: ServerEvent) => e.type === 'queue:patch')).toHaveLength(2);
});

test('the song on screen is left alone — leaving does not yank the video', () => {
	const { app } = appHarness();
	const dana = doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0] }).singer;
	app.state.applyQueueOp({ op: 'add', entry: entry('playing-now', dana.id, 'playing') });
	app.state.applyQueueOp({ op: 'add', entry: entry('later', dana.id) });

	const res = doLeave(app, dana.id);
	expect(res.removed).toEqual(['later']);
	expect(res.keptPlaying).toBe('playing-now');
	expect(app.state.entries.map((e) => e.id)).toEqual(['playing-now']);
});

test('leaving with nothing queued is a clean no-op on the queue', () => {
	const { app } = appHarness();
	const dana = doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0] }).singer;
	app.presence.connect(dana.id);
	const res = doLeave(app, dana.id);
	expect(res.removed).toEqual([]);
	expect(app.presence.stateOf(dana.id, NOW, 999_999, false)).toBe('gone');
});

test('leaving releases the name at once, without waiting out the grace window', () => {
	// The point of the explicit exit: absence is ambiguous and needs a timer, but a statement is not.
	const { app } = appHarness();
	const dana = doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0] }).singer;
	app.presence.connect(dana.id);
	expect(() => assertNameFree(app, app.activeRoomId, 'Dana')).toThrow(NameTakenError);

	doLeave(app, dana.id);
	expect(() => assertNameFree(app, app.activeRoomId, 'Dana')).not.toThrow();
});

test('removableOnLeave is what the confirm counts, and it excludes the playing entry', () => {
	const { app } = appHarness();
	const dana = doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0] }).singer;
	app.state.applyQueueOp({ op: 'add', entry: entry('p', dana.id, 'playing') });
	app.state.applyQueueOp({ op: 'add', entry: entry('q1', dana.id) });
	app.state.applyQueueOp({ op: 'add', entry: entry('q2', dana.id) });
	expect(
		removableOnLeave(app, dana.id)
			.map((e) => e.id)
			.sort()
	).toEqual(['q1', 'q2']);
});
