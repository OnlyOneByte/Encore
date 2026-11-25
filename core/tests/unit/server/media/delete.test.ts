// Deleting a song from the library ENTIRELY turns on three properties. DELETION ORDER: the sidecar
// (meta/<id>.json) is unlinked FIRST, before audio/derived, because a rescan rebuilds the row from the sidecar
// and any other order can resurrect the song. QUEUE-ROW CLEANUP: every queue entry for the media goes, across
// ALL singers, since there is no FK cascade. PLAYING-SONG SKIP: deleting the playing song skips to the next
// entry — it neither refuses nor leaves a dangling current.
import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteMediaEntirely, type DeleteMediaDeps } from '$lib/server/media/delete';
import { AuthoritativeState } from '$lib/server/state/store';
import type { HubDeps } from '$lib/server/realtime/hub';
import { type Media, type QueueEntry, type ServerEvent, type LyricsCandidate } from '$lib/contract';
import { EMPTY_SONG_PROFILE } from '$lib/contract';
import { metaKey, audioKey } from '$lib/server/media/paths';
import { read } from '$test';

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
/** Seed one queued entry onto the authoritative state, bypassing the command layer's actor validation. */
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

/** A jobs stub with no live process — cancel becomes a no-op, isolating the queue/file/skip behaviour. */
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

test('unlinks every fix document of the song by id, named or not, and no other song’s (#1238)', () => {
	const saved = process.env.MEDIA_DIR;
	const root = mkdtempSync(join(tmpdir(), 'encore-del-'));
	process.env.MEDIA_DIR = root;
	try {
		mkdirSync(join(root, 'derived', 'lyrics'), { recursive: true });
		for (const name of ['m1-edit-r1.json', 'm1-edit-r3.json', 'm10-edit-r1.json', 'm1-edit-rx.json'])
			writeFileSync(join(root, 'derived', 'lyrics', name), '{}');
		const { deps, unlinked, hub } = harness(['m1']);
		// Evicted, then Undo: the row names no candidate, and r1 (replaced by r3, then r3 by Undo) is named nowhere.
		Object.assign(hub.mediaById.get('m1')!, { lyricsCandidates: [], lyricsOverrideRef: undefined });
		deleteMediaEntirely('m1', deps);
		expect(unlinked).toContain('derived/lyrics/m1-edit-r1.json');
		expect(unlinked).toContain('derived/lyrics/m1-edit-r3.json');
		expect(unlinked).not.toContain('derived/lyrics/m10-edit-r1.json');
		expect(unlinked).not.toContain('derived/lyrics/m1-edit-rx.json');
	} finally {
		if (saved === undefined) delete process.env.MEDIA_DIR;
		else process.env.MEDIA_DIR = saved;
		rmSync(root, { recursive: true, force: true });
	}
});

test("removes EVERY queue entry for the media, including another singer's turn", () => {
	const { deps, state } = harness(['m1', 'm2']);
	// One song, two turns by different singers; m2 is the survivor.
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

// Deleting a NON-playing entry changes who plays next, so the delete must re-broadcast nowplaying:changed
// on that branch too — reconcileOnReady fires only on the wasPlaying path, so without the `else` arm the
// TV's advertised upNext kept naming the deleted song.
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
	// Not the playing entry, so the reconcile branch is NOT taken — the emit came from the `else`.
	expect(res.wasPlaying).toBe(false);
	expect(state.playback.currentEntryId).toBe('p');

	const np = published
		.slice(before)
		.filter((e) => e.type === 'nowplaying:changed')
		.at(-1) as Extract<ServerEvent, { type: 'nowplaying:changed' }> | undefined;
	// q2 is HARD-CODED, not re-derived with upNextAfter, so the guard cannot agree with a broken helper.
	expect(np).toBeDefined();
	expect(np!.current?.id).toBe('p');
	expect(np!.upNext?.id).toBe('q2');
	expect(np!.upNext?.id).not.toBe('q1');
});

/** A lyrics candidate at the real per-(source, tag, timing) key the worker mints. */
function cand(
	ref: string,
	textSource: LyricsCandidate['textSource'],
	timing: LyricsCandidate['timing']
): LyricsCandidate {
	return { ref, textSource, timing, textConfidence: 'high', createdAt: 1 };
}

// F1. `audioKey`'s default ext is `wav` but the worker globs for the real name, so one `unlink(audioKey(id))`
// named a nonexistent path and left the ONE UNRECOVERABLE class behind forever (sidecar and row already gone,
// retention never touches `audio/`, no orphan sweep). The refs below are HARD-CODED, not re-derived.
test('unlinks the raw original at EVERY extension it could be under, not just .wav (F1)', () => {
	const { deps, unlinked } = harness(['m1']);
	const res = deleteMediaEntirely('m1', deps);
	expect(res.deleted).toBe(true);

	expect(unlinked).toContain('audio/m1.m4a'); // what a real process actually wrote
	expect(unlinked).toContain('audio/m1.webm');
	// Every candidate, so a partial widening (adding only m4a) does not satisfy this.
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
	expect(unlinked[0]).toBe(metaKey('m1')); // the sidecar still goes first, audio before derived
	expect(unlinked.indexOf('audio/m1.m4a')).toBeLessThan(unlinked.findIndex((r) => r.startsWith('derived/')));
});

// F2. `derivedRefsFor` named `lyricsKey(id)` (the dead single-file key) + `m.lyricsRef` and stopped, so the
// other N−1 lyrics JSONs were orphaned forever. Delegating to retention's `derivedRefsOf` closes it.
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

// F3. `applyQueueOp` mutates and publishes NOTHING, and on the non-playing path the only broadcast was
// `media:status canceled`, which no client turns into a queue mutation — so the server had removed the turn
// while every phone kept rendering it, healing only when a later `queue:patch` tripped the ws gap detector.
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
	expect(patch!.patch.entries?.map((e) => e.id)).toEqual(['b']); // the snapshot is authoritative
	expect(patch!.patch.rev).toBe(state.rev);
	// The media projection must not re-advertise the deleted song, whose row is dropped after the publish.
	expect(hub.mediaById.has('m1')).toBe(false);
	expect(patch!.patch.media?.map((m) => m.id)).toEqual(['m2']);
});

// The publish is conditioned on entries actually removed, so deleting an unqueued song is not a resync.
test('deleting a song with NO queue entries publishes no queue:patch (F3)', () => {
	const { deps, state, published } = harness(['m1', 'm2']);
	seed(state, 'b', 'm2', 's2'); // unrelated turn; nothing points at m1

	const res = deleteMediaEntirely('m1', deps);
	expect(res.removedEntries).toBe(0);
	expect(published.some((e) => e.type === 'queue:patch')).toBe(false);
	expect(published.some((e) => e.type === 'media:status')).toBe(true);
});

// F2's structural half. Re-adding the three stored-ref lines is behaviour-identical (the accumulator is a
// Set), so no runtime assertion distinguishes them — yet a rival enumeration that agrees today is how the
// `lyricsCandidates` omission got here, so `derivedRefsFor` must DELEGATE. Scans only the function BODY, so
// the docstrings above it (which quote `m.lyricsRef`) can neither satisfy nor trip it.
test('derivedRefsFor delegates the stored-ref enumeration instead of keeping a rival copy (F2)', () => {
	const src = read('src/lib/server/media/delete.ts');
	const start = src.indexOf('function derivedRefsFor');
	expect(start).toBeGreaterThan(-1);
	const body = src.slice(start, src.indexOf('\n}\n', start));

	expect(body).toContain('derivedRefsOf('); // it asks retention for the answer …
	// … and does not re-answer it, under ANY property spelling, so a rename cannot slip past.
	expect(body).not.toMatch(/refs\.add\(\s*m\??\.(instrumentalRef|vocalsRef|lyricsRef)/);
	expect(body).not.toMatch(/if\s*\(\s*m\??\.(instrumentalRef|vocalsRef|lyricsRef)\s*\)\s*refs\.add/);
});
