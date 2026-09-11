// Regression for issue #636 on the LEAVE seam.
//
// An explicit leave un-queues a singer's queued songs (doLeave → one queue:patch per remove). That
// changes who plays next — a leaving singer's queued pick may be the advertised upNext, or removing it
// promotes another singer's entry. But doLeave published only queue:patch, never nowplaying:changed,
// so the TV's Up next kept naming a song that just left the room.
//
// This is the same shape #636 fixed on the queue:command seam (docs/loop/COMMON.md shape 3, "transitions
// handled where steady state was"): the invariant "advertised next == true next" held across the
// playback transitions and across none of the queue transitions. doLeave now calls emitNowPlaying after
// its removals (guarded on doomed.length > 0). Base-RED: on base doLeave emits no nowplaying:changed, so
// the assertion below finds none.
//
// The expected next is HARD-CODED ('q-stay'), never re-derived with upNextAfter — the trap COMMON.md names.
import { test, expect } from 'bun:test';
import { migratedDb } from '../db/test-db';
import { doJoin } from './join';
import { doLeave } from './leave';
import { SingerRepository } from './repository';
import { RoomRepository } from '../rooms/repository';
import { SINGER_COLORS, type ServerEvent, type Media, type QueueEntry } from '@encore/shared';
import { EMPTY_SONG_PROFILE } from '@encore/shared';
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

const NOW = 1_700_000_000_000;

/** A finished (singable) media, so upNextAfter will actually name an entry pointing at it. */
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

function appHarness(): { app: EncoreApp; published: ServerEvent[]; mediaById: Map<string, Media> } {
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
	return { app, published, mediaById };
}

function seed(app: EncoreApp, mediaById: Map<string, Media>, id: string, mediaId: string, singerId: string) {
	mediaById.set(mediaId, readyMedia(mediaId));
	app.state.applyQueueOp({
		op: 'add',
		entry: { id, mediaId, singerId, status: 'queued', rotationSeq: -1, addedAt: 1 } as QueueEntry
	});
}

test('leaving re-broadcasts the true next when a departing singer had the advertised next', () => {
	const { app, published, mediaById } = appHarness();
	const dana = doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0] }).singer;
	const maya = doJoin(app, { displayName: 'Maya', color: SINGER_COLORS[1] }).singer;
	app.presence.connect(dana.id);
	app.presence.connect(maya.id);

	// A song is playing; Dana's queued pick is the advertised next; Maya's is behind it.
	seed(app, mediaById, 'p', 'm-p', maya.id);
	seed(app, mediaById, 'q-dana', 'm-dana', dana.id);
	seed(app, mediaById, 'q-stay', 'm-stay', maya.id);
	app.state.applyQueueOp({ op: 'status', id: 'p', status: 'playing' });
	app.state.setPlayback({ currentEntryId: 'p', isPlaying: true });

	const before = published.length;
	const res = doLeave(app, dana.id);
	// Dana's queued song was removed; the playing entry is untouched (kept on purpose).
	expect(res.removed).toContain('q-dana');
	expect(app.state.playback.currentEntryId).toBe('p');

	const np = published
		.slice(before)
		.filter((e) => e.type === 'nowplaying:changed')
		.at(-1) as Extract<ServerEvent, { type: 'nowplaying:changed' }> | undefined;
	// The leave re-broadcast the advertised next, and it is Maya's remaining song (HARD-CODED),
	// never the departed Dana's.
	expect(np).toBeDefined();
	expect(np!.current?.id).toBe('p');
	expect(np!.upNext?.id).toBe('q-stay');
	expect(np!.upNext?.id).not.toBe('q-dana');
});

test('a leave that removes nothing does not broadcast a spurious nowplaying', () => {
	// The emit is guarded on doomed.length > 0: a singer with no queued songs leaving changes no
	// ordering, so no nowplaying:changed should go out. Prevents the guard from degrading into an
	// unconditional re-emit on every leave.
	const { app, published, mediaById } = appHarness();
	const dana = doJoin(app, { displayName: 'Dana', color: SINGER_COLORS[0] }).singer;
	const maya = doJoin(app, { displayName: 'Maya', color: SINGER_COLORS[1] }).singer;
	app.presence.connect(dana.id);
	app.presence.connect(maya.id);
	// Only Maya has a queued song; Dana has none.
	seed(app, mediaById, 'q-maya', 'm-maya', maya.id);

	const before = published.length;
	const res = doLeave(app, dana.id);
	expect(res.removed).toEqual([]);
	const nps = published.slice(before).filter((e) => e.type === 'nowplaying:changed');
	expect(nps.length).toBe(0);
});
