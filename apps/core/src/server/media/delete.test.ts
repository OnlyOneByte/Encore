// Regression: delete a song from the library ENTIRELY. Three properties the owner
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
import { type Media, type QueueEntry, type ServerEvent, type LyricsCandidate } from '@encore/shared';
import { EMPTY_SONG_PROFILE } from '@encore/shared';
import { metaKey, audioKey } from './paths';
import { readFileSync } from 'node:fs';

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

// Regression: deleting a NON-playing entry changes who plays next, so the delete path
// must re-broadcast nowplaying:changed too. reconcileOnReady fires only on the wasPlaying path (the
// dangling-current case); the far more common non-playing delete published queue:removed +
// media:status with NO nowplaying:changed, so the TV's advertised upNext kept naming the deleted
// song. The `else emitNowPlaying(hub)` on delete.ts's wasPlaying gate closes it. Base-RED: on base the
// delete path emits no nowplaying:changed on this branch, so the assertion inverts (no such event).
test('deleting a NON-playing entry re-broadcasts the true next', () => {
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

// ── the hard delete left the two biggest byte classes on disk, and left every other
// client's queue stale. Three guards, one per finding. All three are RED on base.

/** A lyrics candidate at the real per-(source, tag, timing) key the worker mints. */
function cand(
	ref: string,
	textSource: LyricsCandidate['textSource'],
	timing: LyricsCandidate['timing']
): LyricsCandidate {
	return { ref, textSource, timing, textConfidence: 'high', createdAt: 1 };
}

// F1. `audioKey`'s default ext is `wav`, the LEGACY mislabelled name. Every song cooked since 2981662
// has `audio/<id>.m4a` or `.webm` on disk, because the worker downloads to `audio/<id>.%(ext)s` and
// discovers the real name with a `<id>.*` glob. So the single `unlink(audioKey(id))` named a path that
// does not exist and the ONE UNRECOVERABLE class survived — permanently, since the sidecar and the row
// are gone when this returns, retention never touches `audio/`, and no boot pass sweeps orphans.
//
// Base-RED at the first assertion: base unlinks exactly ["audio/m1.wav"], so `audio/m1.m4a` is absent.
// The expected refs are HARD-CODED literals, deliberately not built with candidateAudioRefs/audioKey —
// re-deriving them with the code's own helpers would make this pass for any list the code happens to
// hold, including a one-entry one.
test('unlinks the raw original at EVERY extension it could be under, not just .wav (F1)', () => {
	const { deps, unlinked } = harness(['m1']);
	const res = deleteMediaEntirely('m1', deps);
	expect(res.deleted).toBe(true);

	// The modern names first — these are what a real cook actually wrote.
	expect(unlinked).toContain('audio/m1.m4a');
	expect(unlinked).toContain('audio/m1.webm');
	// Every candidate, so a partial widening (e.g. adding only m4a) does not satisfy this.
	for (const ref of [
		'audio/m1.webm',
		'audio/m1.opus',
		'audio/m1.m4a',
		'audio/m1.mp4',
		'audio/m1.mp3',
		'audio/m1.wav'
	]) {
		expect(unlinked).toContain(ref);
	}
	// The sidecar still goes first, and the audio still goes before the derived artifacts.
	expect(unlinked[0]).toBe(metaKey('m1'));
	expect(unlinked.indexOf('audio/m1.m4a')).toBeLessThan(unlinked.findIndex((r) => r.startsWith('derived/')));
});

// F2. `derivedRefsFor` named `lyricsKey(id)` (the dead single-file key) + `m.lyricsRef` and stopped, so
// the other N−1 lyrics JSONs were orphaned forever — the exact undercount retention.ts:216-222 records
// as already-fixed once for itself. Delegating to retention's `derivedRefsOf` closes it.
//
// Base-RED: base unlinks the chosen `lrclib.word` ref (it equals m.lyricsRef) and misses the other two.
test('unlinks EVERY lyrics candidate JSON, not only the chosen one (F2)', () => {
	const { deps, hub, unlinked } = harness(['m1']);
	const chosen = 'derived/lyrics/m1-lrclib-word.json';
	const others = ['derived/lyrics/m1-captions-line.json', 'derived/lyrics/m1-asr-word.json'];
	hub.mediaById.set('m1', {
		...media('m1'),
		lyricsRef: chosen,
		lyricsCandidates: [
			cand(chosen, 'lrclib', 'word'),
			cand(others[0], 'captions', 'line'),
			cand(others[1], 'asr', 'word')
		]
	});

	expect(deleteMediaEntirely('m1', deps).deleted).toBe(true);
	expect(unlinked).toContain(chosen);
	for (const ref of others) expect(unlinked).toContain(ref);
});

// F3. `applyQueueOp` mutates and publishes NOTHING. On the non-playing path the only broadcast was
// `media:status canceled`, which no client turns into a queue mutation — so the server had removed the
// turn while every phone and the TV kept rendering it, healing only when some later `queue:patch`
// tripped the ws gap detector. Base-RED: base's published types are ["nowplaying:changed",
// "media:status"] with no `queue:patch` at all.
test('deleting a QUEUED, non-playing song broadcasts the authoritative queue (F3)', () => {
	const { deps, state, published, hub } = harness(['m1', 'm2']);
	seed(state, 'a', 'm1', 's1'); // the doomed turn
	seed(state, 'b', 'm2', 's2'); // the survivor

	const res = deleteMediaEntirely('m1', deps);
	expect(res.wasPlaying).toBe(false); // the reconcile branch is NOT the one under test
	expect(res.removedEntries).toBe(1);

	const patch = published.find((e) => e.type === 'queue:patch') as
		Extract<ServerEvent, { type: 'queue:patch' }> | undefined;
	expect(patch).toBeDefined();
	// The snapshot is authoritative: the deleted turn is gone from it and the survivor is in it.
	expect(patch!.patch.entries?.map((e) => e.id)).toEqual(['b']);
	expect(patch!.patch.rev).toBe(state.rev);
	// The media projection carries the survivor's title and does NOT re-advertise the deleted song,
	// which is still in mediaById at publish time (the row is dropped afterwards, at step 5).
	expect(hub.mediaById.has('m1')).toBe(false);
	expect(patch!.patch.media?.map((m) => m.id)).toEqual(['m2']);
});

// The companion half of F3's guard: the publish is conditioned on entries having actually been removed,
// so deleting a song nobody queued does not bump every client through a no-op resync.
test('deleting a song with NO queue entries publishes no queue:patch (F3)', () => {
	const { deps, state, published } = harness(['m1', 'm2']);
	seed(state, 'b', 'm2', 's2'); // unrelated turn; nothing points at m1

	const res = deleteMediaEntirely('m1', deps);
	expect(res.removedEntries).toBe(0);
	expect(published.some((e) => e.type === 'queue:patch')).toBe(false);
	expect(published.some((e) => e.type === 'media:status')).toBe(true);
});

// F2's structural half — a SOURCE-SCAN guard, because the behavioural test above cannot see it.
//
// The fix deleted three now-redundant lines from `derivedRefsFor` (`refs.add(m.instrumentalRef)`,
// `m.vocalsRef`, `m.lyricsRef`) whose refs `derivedRefsOf` already supplies. Re-adding them is
// behaviour-identical by construction — the accumulator is a Set — so no runtime assertion can ever
// distinguish the two, and `prove_per_hunk.py` correctly reports those hunks green when reverted. That
// green IS the finding: the lines are a rival enumeration, and a rival enumeration that agrees today is
// exactly how the `lyricsCandidates` omission got here (retention.ts:216-222 records the same drift for
// itself). So the invariant to pin is structural: `derivedRefsFor` DELEGATES the stored-ref question and
// does not answer it a second time.
//
// Reads the real production file (not a fixture) and scans only the function BODY, so the docstrings
// above it — which quote `m.lyricsRef` while explaining the defect — cannot satisfy or trip it.
test('derivedRefsFor delegates the stored-ref enumeration instead of keeping a rival copy (F2)', () => {
	const src = readFileSync(new URL('./delete.ts', import.meta.url), 'utf8');
	const start = src.indexOf('function derivedRefsFor');
	expect(start).toBeGreaterThan(-1);
	const body = src.slice(start, src.indexOf('\n}\n', start));

	// It asks retention for the answer.
	expect(body).toContain('derivedRefsOf(');
	// And it does not re-answer it. Any of the three stored refs added back here is a second list —
	// under ANY property spelling, so a rename cannot slip past a literal-name scan.
	expect(body).not.toMatch(/refs\.add\(\s*m\??\.(instrumentalRef|vocalsRef|lyricsRef)/);
	expect(body).not.toMatch(/if\s*\(\s*m\??\.(instrumentalRef|vocalsRef|lyricsRef)\s*\)\s*refs\.add/);
});
