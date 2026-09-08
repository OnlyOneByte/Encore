// Regression for issue #639 — delete a song from the library ENTIRELY. Three properties the owner
// ruling turns on, each red on base (the module did not exist) and pinned per-hunk:
//   1. DELETION ORDER: the sidecar (meta/<id>.json) is unlinked FIRST, before audio/derived — a rescan
//      rebuilds the row from the sidecar, so any other order can resurrect the song.
//   2. QUEUE-ROW CLEANUP: every queue entry for the media is removed, across ALL singers (no FK
//      cascade exists), including another singer's turn (ruling 1b: delete their entry too).
//   3. PLAYING-SONG SKIP: deleting the currently-playing song skips to the next entry (ruling 1c),
//      it does not refuse and does not leave a dangling current.
//
// Entries are seeded through the authoritative reducer state.applyQueueOp({op:"add"}) — the same path
// handleQueueCommand ultimately calls — so the fixture does not depend on the command layer's actor
// validation, only on the queue state the delete acts upon.
import { test, expect } from 'bun:test';
import { deleteMediaEntirely, type DeleteMediaDeps } from './delete';
import { AuthoritativeState } from '../state/store';
import type { HubDeps } from '../realtime/hub';
import { type Media, type QueueEntry, type ServerEvent } from '@encore/shared';
import { EMPTY_SONG_PROFILE } from '@encore/shared';
import { metaKey, audioKey } from './paths';

const media = (id: string): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'x',
	title: id,
	durationSec: 100,
	stemStatus: 'ready',
	lyricsStatus: 'ready',
	instrumentalRef: 'derived/stems/' + id + '-instrumental.flac',
	songProfile: EMPTY_SONG_PROFILE
});

let _s = 0;
/** Seed one queued entry directly onto the authoritative state. */
function seed(state: AuthoritativeState, id: string, mediaId: string, singerId = 's1') {
	state.applyQueueOp({
		op: 'add',
		entry: { id, mediaId, singerId, status: 'queued', rotationSeq: -1, addedAt: ++_s } as QueueEntry
	});
}

/** A fake catalog index recording remove() calls; deleteMediaEntirely only calls remove on it. */
function fakeMediaRepo() {
	const removed: string[] = [];
	return { removed, repo: { remove: (id: string) => removed.push(id) } as unknown as DeleteMediaDeps['media'] };
}

/** A jobs stub with no live cook — cancel becomes a no-op, isolating the queue/file/skip behaviour. */
const noJobs = { findLive: () => undefined } as unknown as DeleteMediaDeps['cancel']['jobs'];

function harness(mediaIds: string[]) {
	const published: ServerEvent[] = [];
	const state = new AuthoritativeState();
	const mediaById = new Map<string, Media>(mediaIds.map((id) => [id, media(id)]));
	const hub: HubDeps = {
		state,
		publish: (e) => published.push(e),
		mediaById,
		actorSingerId: 's1'
	};
	const unlinked: string[] = [];
	const { removed, repo } = fakeMediaRepo();
	const deps: DeleteMediaDeps = {
		hub,
		media: repo,
		cancel: { jobs: noJobs, toWorker: () => {}, now: () => 1 },
		deleteFile: (ref) => unlinked.push(ref)
	};
	return { published, state, hub, deps, unlinked, removed };
}

test('unlinks the sidecar FIRST, before audio and derived artifacts', () => {
	const { deps, unlinked } = harness(['m1']);
	const res = deleteMediaEntirely('m1', deps);
	expect(res.deleted).toBe(true);
	expect(unlinked[0]).toBe(metaKey('m1'));
	const metaIdx = unlinked.indexOf(metaKey('m1'));
	const audioIdx = unlinked.indexOf(audioKey('m1'));
	expect(metaIdx).toBeGreaterThanOrEqual(0);
	expect(audioIdx).toBeGreaterThan(metaIdx);
	expect(unlinked.some((r) => r.startsWith('derived/stems/m1-instrumental'))).toBe(true);
});

test("removes EVERY queue entry for the media, including another singer's turn", () => {
	const { deps, state } = harness(['m1', 'm2']);
	// s1 queues m1; s2 also queues m1 (one song, two turns); s1 queues m2 (survivor).
	seed(state, 'a', 'm1', 's1');
	seed(state, 'b', 'm1', 's2');
	seed(state, 'c', 'm2', 's1');
	expect(state.entries.filter((e) => e.mediaId === 'm1').length).toBe(2);

	const res = deleteMediaEntirely('m1', deps);
	expect(res.removedEntries).toBe(2);
	expect(state.entries.some((e) => e.mediaId === 'm1')).toBe(false);
	expect(state.entries.some((e) => e.id === 'c' && e.mediaId === 'm2')).toBe(true);
});

test('deleting the PLAYING song skips to the next entry rather than refusing', () => {
	const { deps, state } = harness(['m1', 'm2']);
	seed(state, 'p', 'm1', 's1');
	seed(state, 'n', 'm2', 's2');
	// Make m1 the playing song.
	state.applyQueueOp({ op: 'status', id: 'p', status: 'playing' });
	state.setPlayback({ currentEntryId: 'p', isPlaying: true });
	expect(state.playback.currentEntryId).toBe('p');

	const res = deleteMediaEntirely('m1', deps);
	expect(res.wasPlaying).toBe(true);
	expect(state.playback.currentEntryId).toBe('n');
	expect(state.playback.isPlaying).toBe(true);
	expect(state.entries.some((e) => e.mediaId === 'm1')).toBe(false);
});

test('drops the index row and clears the runtime catalog; unknown id is a no-op 404 shape', () => {
	const { deps, hub, removed } = harness(['m1']);
	const res = deleteMediaEntirely('m1', deps);
	expect(res.deleted).toBe(true);
	expect(removed).toEqual(['m1']);
	expect(hub.mediaById.has('m1')).toBe(false);
	const again = deleteMediaEntirely('m1', deps);
	expect(again.deleted).toBe(false);
});

// Regression for issue #636: deleting a NON-playing entry changes who plays next, so the delete path
// must re-broadcast nowplaying:changed too. reconcileOnReady fires only on the wasPlaying path (the
// dangling-current case, #639); the far more common non-playing delete published queue:removed +
// media:status with NO nowplaying:changed, so the TV's advertised upNext kept naming the deleted
// song. The `else emitNowPlaying(hub)` on delete.ts's wasPlaying gate closes it. Base-RED: on base the
// delete path emits no nowplaying:changed on this branch, so the assertion inverts (no such event).
test('deleting a NON-playing entry re-broadcasts the true next (#636)', () => {
	// p is playing; the room's upNext is q1. Delete q1 (NOT the playing entry): truth becomes q2.
	const { deps, state, published } = harness(['m-p', 'm-q1', 'm-q2']);
	seed(state, 'p', 'm-p');
	seed(state, 'q1', 'm-q1');
	seed(state, 'q2', 'm-q2');
	state.applyQueueOp({ op: 'status', id: 'p', status: 'playing' });
	state.setPlayback({ currentEntryId: 'p', isPlaying: true });

	const before = published.length;
	const res = deleteMediaEntirely('m-q1', deps);
	// Not the playing entry, so the wasPlaying/reconcile branch is NOT taken — the emit came from the
	// `else`, which is what pins the fix to the non-playing path.
	expect(res.wasPlaying).toBe(false);
	expect(state.playback.currentEntryId).toBe('p');

	const np = published
		.slice(before)
		.filter((e) => e.type === 'nowplaying:changed')
		.at(-1) as Extract<ServerEvent, { type: 'nowplaying:changed' }> | undefined;
	// The delete re-broadcast the advertised next, and it is q2 (HARD-CODED — not re-derived with
	// upNextAfter), never the deleted q1.
	expect(np).toBeDefined();
	expect(np!.current?.id).toBe('p');
	expect(np!.upNext?.id).toBe('q2');
	expect(np!.upNext?.id).not.toBe('q1');
});
