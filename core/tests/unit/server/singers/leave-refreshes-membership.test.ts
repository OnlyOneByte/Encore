// An explicit leave must not leave the leaver in the snapshot every `queue:sync` is built from.
//
// `doLeave` called `app.presence.forget(singerId)` and nothing else, while server.ts serves its per-socket
// `listOnline`/`listAway` from a module-level `membership` CACHE refreshed only on socket edges, on a
// queue:command and on the 20s sweep. Forgetting the record does not refresh that cache, and the leaver's
// own socket closing cannot either (`presence.disconnect` is a no-op for a deleted record). So the next
// hello reply — a TV reload or its 15s heartbeat — re-advertised the departed singer, and the television
// rendered `lobby` with a chip naming someone who went home.
//
// The behavioural half below wires the cache EXACTLY as server.ts does (one local `membership`, recomputed
// from `app.presence.evaluate`, read through `syncEvent`'s `listOnline`/`listAway`) rather than asserting on
// `presence.online()` — the live map was always correct, and a test reading it would be green on the broken
// tree. What was wrong is the cache, so the cache is what this asserts.
import { test, expect } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { doJoin } from '$lib/server/singers/join';
import { doLeave } from '$lib/server/singers/leave';
import { SingerRepository } from '$lib/server/singers/repository';
import { RoomRepository } from '$lib/server/rooms/repository';
import { SINGER_COLORS, graceMsOf, EMPTY_SONG_PROFILE } from '$lib/contract';
import type { ServerEvent, Media, QueueEntry } from '$lib/contract';
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
import { syncEvent } from '$lib/server/realtime/hub';
import type { EncoreApp } from '$lib/server/app';

const NOW = 1_700_000_000_000;

/** Finished, so an entry pointing at it is a real queued song rather than a processing placeholder. */
const readyMedia = (id: string): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'x',
	title: id,
	durationSec: 100,
	stemStatus: 'ready',
	lyricsStatus: 'ready',
	instrumentalRef: `derived/stems/${id}-instrumental.flac`,
	songProfile: EMPTY_SONG_PROFILE
});

/**
 * An app PLUS server.ts's membership cache and the hello reply built from it. `wireRefresh: false` is the
 * shape every other unit harness has — no hook assigned at all — which is the case the optional field and
 * the `?.()` exist for.
 */
function serverLikeHarness(opts: { wireRefresh: boolean }) {
	const db = migratedDb();
	const rooms = new RoomRepository(db);
	const activeRoomId = rooms.ensureActive(NOW).id;
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

	// server.ts's cache and its refresher, transcribed: the same `evaluate` call, the same `hasPendingSongs`,
	// the same silence when nothing moved.
	let membership = { here: [] as string[], away: [] as string[] };
	const hasPendingSongs = (singerId: string) =>
		app.state.entries.some((e) => e.singerId === singerId && (e.status === 'queued' || e.status === 'playing'));
	let refreshes = 0;
	function refreshMembership(): void {
		refreshes++;
		const next = app.presence.evaluate({
			now: app.now(),
			graceMs: graceMsOf(app.settings.getRoom(app.activeRoomId).presenceGraceMinutes),
			hasPendingSongs
		});
		const same = next.here.join() === membership.here.join() && next.away.join() === membership.away.join();
		membership = { here: next.here, away: next.away };
		if (!same) published.push({ type: 'singer:presence', online: next.here, away: next.away } satisfies ServerEvent);
	}
	if (opts.wireRefresh) app.refreshMembership = refreshMembership;

	/** What a `hello` would be answered with — the payload the TV adopts wholesale. */
	const helloReply = () =>
		syncEvent(app.state, {
			mediaById,
			listSingers: () => app.singers.listPublic(app.activeRoomId),
			listOnline: () => membership.here,
			listAway: () => membership.away,
			getSettings: () => app.settings.getEffective(app.activeRoomId)
		});

	const seed = (id: string, mediaId: string, singerId: string) => {
		mediaById.set(mediaId, readyMedia(mediaId));
		app.state.applyQueueOp({
			op: 'add',
			entry: { id, mediaId, singerId, status: 'queued', rotationSeq: -1, addedAt: 1 } as QueueEntry
		});
	};

	return { app, published, helloReply, refreshMembership, seed, refreshCount: () => refreshes };
}

test('after an explicit leave, the hello reply no longer advertises the leaver as online', () => {
	const { app, published, helloReply, refreshMembership, seed } = serverLikeHarness({ wireRefresh: true });
	const dana = doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0] }).singer;
	const maya = doJoin(app, { displayName: 'Maya', color: SINGER_COLORS[1] }).singer;
	// Two phones with live sockets, each refreshing on the 0→1 edge as server.ts's `open` does.
	app.presence.connect(dana.id);
	refreshMembership();
	app.presence.connect(maya.id);
	refreshMembership();
	seed('q-dana', 'm-dana', dana.id);

	// BEFORE: both are in the snapshot the TV reads, so tvScreen's inRoomCount is 2 and it renders lobby.
	expect(helloReply().online).toEqual([dana.id, maya.id]);

	const before = published.length;
	doLeave(app, dana.id);

	// AFTER: the one that matters. Dana is gone from the CACHED snapshot, not merely from the live map.
	expect(helloReply().online).toEqual([maya.id]);
	expect(helloReply().online).not.toContain(dana.id);
	expect(helloReply().away).toEqual([]);

	// The `singer:presence` edge goes out at leave time rather than up to 20s later, which is what tells an
	// already-connected TV without waiting for its next heartbeat. Clients handle it already — no new event.
	const presence = published
		.slice(before)
		.filter((e) => e.type === 'singer:presence')
		.at(-1) as Extract<ServerEvent, { type: 'singer:presence' }> | undefined;
	expect(presence).toBeDefined();
	expect(presence!.online).toEqual([maya.id]);
	expect(presence!.away).toEqual([]);
});

test('the last guest leaving empties the roster, so the TV has nothing to keep it off the attract screen', () => {
	// The reported symptom: a one-guest room where the TV abandons attract and names the departed guest.
	// `inRoomCount = online.length + away.length`, so BOTH lists have to be empty.
	const { app, helloReply, refreshMembership } = serverLikeHarness({ wireRefresh: true });
	const solo = doJoin(app, { displayName: 'Solo', color: SINGER_COLORS[0] }).singer;
	app.presence.connect(solo.id);
	refreshMembership();
	expect(helloReply().online!.length + helloReply().away!.length).toBe(1);

	doLeave(app, solo.id);
	expect(helloReply().online).toEqual([]);
	expect(helloReply().away).toEqual([]);
	expect(helloReply().online!.length + helloReply().away!.length).toBe(0);
});

test('a leave only refreshes once, and a singer still holding a socket is untouched', () => {
	// Guards the obvious over-correction: refreshing per removed entry, or forgetting someone else.
	const { app, helloReply, refreshMembership, seed, refreshCount } = serverLikeHarness({ wireRefresh: true });
	const dana = doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0] }).singer;
	const maya = doJoin(app, { displayName: 'Maya', color: SINGER_COLORS[1] }).singer;
	app.presence.connect(dana.id);
	app.presence.connect(maya.id);
	refreshMembership();
	seed('q-dana-1', 'm-d1', dana.id);
	seed('q-dana-2', 'm-d2', dana.id);
	seed('q-maya', 'm-m', maya.id);

	const before = refreshCount();
	const res = doLeave(app, dana.id);
	expect(res.removed).toEqual(['q-dana-1', 'q-dana-2']);
	expect(refreshCount() - before).toBe(1);
	expect(helloReply().online).toEqual([maya.id]);
	// Maya keeps her socket AND her song: the leave is about one singer.
	expect(app.presence.sockets(maya.id)).toBe(1);
	expect(app.state.entries.map((e) => e.id)).toEqual(['q-maya']);
});

test('doLeave still works where no refresh hook is wired at all', () => {
	// Why the field is OPTIONAL and the call is `?.()`: every other harness, and any embedder that is not
	// server.ts, hands doLeave an app with no hook. That must be a no-op, never a crash on the leave path.
	const { app, helloReply, seed } = serverLikeHarness({ wireRefresh: false });
	const dana = doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0] }).singer;
	app.presence.connect(dana.id);
	seed('q-dana', 'm-dana', dana.id);
	expect(app.refreshMembership).toBeUndefined();

	const res = doLeave(app, dana.id);
	expect(res.removed).toEqual(['q-dana']);
	// The live map is still corrected by `forget` — it is only the never-refreshed cache that lags, which
	// here was never populated at all.
	expect(app.presence.online()).toEqual([]);
	expect(helloReply().online).toEqual([]);
});

// server.ts is the Bun.serve entry with no unit harness, so the halves above only MIRROR its composition.
// Pinned below: the hook really is assigned there, and doLeave really calls it — the two ends of the wire
// the behavioural tests transcribe.
import { readFileSync } from 'node:fs';
import { at } from '$test';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

const SERVER = stripComments(readFileSync(at('server.ts'), 'utf8'));
const LEAVE = stripComments(readFileSync(at('src/lib/server/singers/leave.ts'), 'utf8'));

test('server.ts assigns the refreshMembership hook, after the function it hands over', () => {
	// Non-vacuous: the cache and its refresher must still be here, or these assertions sweep nothing.
	expect(SERVER).toMatch(/function refreshMembership\(\)/);
	expect(SERVER).toMatch(/listOnline: \(\) => membership\.here/);

	const assignIdx = SERVER.search(/app\.refreshMembership\s*=\s*refreshMembership\s*;/);
	expect(assignIdx).toBeGreaterThanOrEqual(0);
	// AFTER the declaration, so the reader meets the function before the hand-off and the identifier is
	// not a forward reference into a `let`.
	const declIdx = SERVER.indexOf('function refreshMembership()');
	expect(assignIdx).toBeGreaterThan(declIdx);
});

test('doLeave refreshes the membership cache, optionally, right after forgetting the leaver', () => {
	const forgetIdx = LEAVE.search(/app\.presence\.forget\(singerId\)/);
	const refreshIdx = LEAVE.search(/app\.refreshMembership\?\.\(\)/);
	expect(forgetIdx).toBeGreaterThanOrEqual(0);
	expect(refreshIdx).toBeGreaterThan(forgetIdx);

	// `?.()` and not a bare call: a required-looking call would throw for every embedder that is not
	// server.ts, including the harnesses in this very file.
	expect(LEAVE).not.toMatch(/app\.refreshMembership\(\)/);
});
