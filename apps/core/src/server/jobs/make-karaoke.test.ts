// Make-karaoke request flips media to cooking-file (rotation auto-holds the slot), enqueues
// a stems job at need-priority, dedups repeats, and refuses to disrupt the live song. markMediaReady
// flips to the playable instrumental. Plus the round-trip: cook → held → ready → plays at its slot.
import { test, expect } from 'bun:test';
import { requestMakeKaraoke, markMediaReady, setMediaLyrics, setMediaPitch, instrumentalKey, soonestSeqFor, isCooked, cookState, type MakeKaraokeDeps } from './make-karaoke';
import { JobRepository } from './repository';
import { AuthoritativeState } from '../state/store';
import { nextPlayable, isEntryReady } from '../rotation/index';
import { openDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import { playbackRef, type Media, type QueueEntry } from '@encore/shared';

const T0 = 1_700_000_000_000;
const media = (id: string, over: Partial<Media> = {}): Media => ({
	id, source: 'youtube', sourceRef: 'vid-' + id, title: id, durationSec: 200, stemStatus: 'none', playMode: 'iframe', ...over
});
let _s = 0;
const entry = (id: string, mediaId: string, singerId = 's1'): QueueEntry => ({ id, mediaId, singerId, status: 'queued', rotationSeq: -1, addedAt: ++_s });

function deps(): MakeKaraokeDeps & { mediaById: Map<string, Media> } {
	const { db } = openDb(':memory:');
	runMigrations(db);
	return { jobs: new JobRepository(db), mediaById: new Map(), state: new AuthoritativeState(), now: () => T0 };
}

test('request flips media to cooking file + enqueues a stems job', () => {
	const d = deps();
	d.mediaById.set('m1', media('m1'));
	const job = requestMakeKaraoke('m1', d);
	expect(job).not.toBeNull();
	expect(job!.jobType).toBe('stems');
	expect(job!.status).toBe('queued');
	// media is now a cooking file → rotation will hold its slot
	const m = d.mediaById.get('m1')!;
	expect(m.playMode).toBe('file');
	expect(m.stemStatus).toBe('queued');
	expect(isEntryReady(entry('q', 'm1'), d.mediaById)).toBe(false);
});

test('idempotent: a repeat request reuses the same live job (one compute)', () => {
	const d = deps();
	d.mediaById.set('m1', media('m1'));
	const a = requestMakeKaraoke('m1', d);
	const b = requestMakeKaraoke('m1', d);
	expect(b!.id).toBe(a!.id);
	expect(d.jobs.listByStatus('queued')).toHaveLength(1);
});

test('unknown media → null (no job)', () => {
	const d = deps();
	expect(requestMakeKaraoke('ghost', d)).toBeNull();
});

test('refuses to make-karaoke the currently-playing song (would yank the live video)', () => {
	const d = deps();
	d.mediaById.set('m1', media('m1'));
	d.state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	d.state.setPlayback({ currentEntryId: 'q1', isPlaying: true });
	expect(requestMakeKaraoke('m1', d)).toBeNull();
	expect(d.mediaById.get('m1')!.playMode).toBe('iframe'); // unchanged
});

test('priority = soonest rotationSeq among queued entries needing the media', () => {
	const entries = [
		{ ...entry('q1', 'm1'), rotationSeq: 5, status: 'queued' as const },
		{ ...entry('q2', 'm1'), rotationSeq: 2, status: 'queued' as const },
		{ ...entry('q3', 'm2'), rotationSeq: 0, status: 'queued' as const }
	];
	expect(soonestSeqFor('m1', entries)).toBe(2); // soonest of the two m1 entries
	expect(soonestSeqFor('m2', entries)).toBe(0);
	expect(soonestSeqFor('absent', entries)).toBe(Number.MAX_SAFE_INTEGER);
});

test('markMediaReady records the instrumental key and LEAVES sourceRef alone', () => {
	const d = deps();
	d.mediaById.set('m1', media('m1', { playMode: 'file', stemStatus: 'queued' }));
	expect(markMediaReady('m1', d.mediaById)).toBe(true);
	const m = d.mediaById.get('m1')!;
	expect(m.stemStatus).toBe('ready');
	expect(m.playMode).toBe('file');
	expect(m.instrumentalRef).toBe(instrumentalKey('m1'));
	expect(m.instrumentalRef).toBe('derived/stems/m1-instrumental.flac');
	// REGRESSION: overwriting sourceRef forked the song into two rows — the cooked one in the
	// library and a fresh uncooked one on the next search, because search dedupes on it.
	expect(m.sourceRef).toBe('vid-m1');
	expect(markMediaReady('ghost', d.mediaById)).toBe(false);
});

test('a cooked song stays recognisable by its ORIGIN identity (search dedupe key)', () => {
	const d = deps();
	d.mediaById.set('m1', media('m1', { sourceRef: 'djV11Xbc914' }));
	requestMakeKaraoke('m1', d);
	markMediaReady('m1', d.mediaById);
	const m = d.mediaById.get('m1')!;
	// the exact lookup /api/search does when deciding "have I seen this result before?"
	const matches = [...d.mediaById.values()].filter((x) => x.source === 'youtube' && x.sourceRef === 'djV11Xbc914');
	expect(matches).toHaveLength(1);
	expect(matches[0]!.id).toBe('m1');
	expect(matches[0]!.stemStatus).toBe('ready'); // and it is recognised as ALREADY COOKED
	expect(playbackRef(m)).toBe('derived/stems/m1-instrumental.flac'); // while still playing the instrumental
});

test('setMediaLyrics attaches the align artifact uri, and no-ops without one', () => {
	const d = deps();
	d.mediaById.set('m1', media('m1'));
	expect(setMediaLyrics('m1', 'lyrics/m1-aligned.json', d.mediaById)).toBe(true);
	expect(d.mediaById.get('m1')!.lyricsRef).toBe('lyrics/m1-aligned.json');
	// undefined uri (stems-only complete) and unknown media both no-op
	expect(setMediaLyrics('m1', undefined, d.mediaById)).toBe(false);
	expect(setMediaLyrics('ghost', 'x.json', d.mediaById)).toBe(false);
});

test('setMediaPitch attaches the reference pitch-track uri, and no-ops without one', () => {
	const d = deps();
	d.mediaById.set('m1', media('m1'));
	expect(setMediaPitch('m1', 'pitch/m1-pitch.json', d.mediaById)).toBe(true);
	expect(d.mediaById.get('m1')!.pitchRef).toBe('pitch/m1-pitch.json');
	expect(setMediaPitch('m1', undefined, d.mediaById)).toBe(false);
	expect(setMediaPitch('ghost', 'x.json', d.mediaById)).toBe(false);
});

test('ROUND TRIP: cook → held while another plays → ready → plays at its preserved slot', () => {
	const d = deps();
	// two singers: a wants make-karaoke on m1 (queued first → seq 0), b has a ready iframe m2
	d.mediaById.set('m1', media('m1'));
	d.mediaById.set('m2', media('m2'));
	d.state.applyQueueOp({ op: 'add', entry: entry('q-a', 'm1', 'a') });
	d.state.applyQueueOp({ op: 'add', entry: entry('q-b', 'm2', 'b') });

	requestMakeKaraoke('m1', d); // m1 now cooking-file → held
	// while cooking, the soonest PLAYABLE is q-b (q-a is held even though its seq is lower)
	expect(nextPlayable(d.state.entries, d.mediaById).next?.id).toBe('q-b');
	const held = nextPlayable(d.state.entries, d.mediaById).held.map((e) => e.id);
	expect(held).toContain('q-a');

	// stems finish → media ready → q-a is playable again AT its fair position (seq 0, before q-b)
	markMediaReady('m1', d.mediaById);
	expect(nextPlayable(d.state.entries, d.mediaById).next?.id).toBe('q-a');
});

// ── dedupe to already-separated stems (the durable catalog's payoff) ────────────────────

test('isCooked is true only for a stems-ready FILE media', () => {
	expect(isCooked(media('m1', { playMode: 'file', stemStatus: 'ready' }))).toBe(true);
	expect(isCooked(media('m1', { playMode: 'file', stemStatus: 'queued' }))).toBe(false);
	expect(isCooked(media('m1', { playMode: 'iframe', stemStatus: 'ready' }))).toBe(false);
	expect(isCooked(media('m1'))).toBe(false);
});

test('cookState distinguishes unknown / playing / ready / cooking / cookable', () => {
	const d = deps();
	expect(cookState('ghost', d)).toBe('unknown');

	d.mediaById.set('plain', media('plain'));
	expect(cookState('plain', d)).toBe('cookable');

	d.mediaById.set('done', media('done', { playMode: 'file', stemStatus: 'ready' }));
	expect(cookState('done', d)).toBe('ready');

	d.mediaById.set('wip', media('wip', { playMode: 'file', stemStatus: 'queued' }));
	expect(cookState('wip', d)).toBe('cooking');

	// the live song outranks everything else — never yank the running video
	d.state.applyQueueOp({ op: 'add', entry: entry('q1', 'plain') });
	d.state.setPlayback({ currentEntryId: 'q1', isPlaying: true });
	expect(cookState('plain', d)).toBe('playing');
});

test('an already-cooked song is NEVER re-cooked (no second job, no wasted separation)', () => {
	const d = deps();
	// exactly the shape hydrated from disk on boot: file + ready + the instrumental key
	d.mediaById.set('m1', media('m1', { playMode: 'file', stemStatus: 'ready', instrumentalRef: instrumentalKey('m1') }));

	expect(requestMakeKaraoke('m1', d)).toBeNull();
	expect(d.jobs.listByStatus('queued')).toHaveLength(0);
	// and the media is left exactly as it was — still pointing at its existing instrumental
	const m = d.mediaById.get('m1')!;
	expect(m.stemStatus).toBe('ready');
	expect(m.instrumentalRef).toBe(instrumentalKey('m1'));
	// a ready file entry is immediately playable, so re-queueing it skips the worker entirely
	expect(isEntryReady(entry('q', 'm1'), d.mediaById)).toBe(true);
});

test('RESTART ROUND TRIP: cook, "restart" with the catalog rehydrated, re-request → zero jobs', () => {
	const d = deps();
	d.mediaById.set('m1', media('m1'));
	expect(requestMakeKaraoke('m1', d)).not.toBeNull(); // night one: cooked
	markMediaReady('m1', d.mediaById);

	// night two: fresh job repo + a catalog hydrated from the durable row (same media object shape)
	const d2 = deps();
	d2.mediaById.set('m1', { ...d.mediaById.get('m1')! });
	expect(requestMakeKaraoke('m1', d2)).toBeNull();
	expect(d2.jobs.listByStatus('queued')).toHaveLength(0);
});

test('a reused ALREADY-READY job reconciles the media instead of deadlocking rotation', () => {
	// Regression: the dedup index counts `ready` as live, so enqueue can return a finished job. If the
	// media were left cooking against it, no worker would ever run and the entry would be held out of
	// rotation forever — the song silently never plays. Found by the durable-catalog restart harness.
	const d = deps();
	d.mediaById.set('m1', media('m1'));
	const first = requestMakeKaraoke('m1', d)!;
	d.jobs.assign(first.id, 'w1', T0 + 1000, T0);
	d.jobs.accept(first.id, T0 + 2000, T0);
	d.jobs.complete(first.id, T0);
	expect(d.jobs.byId(first.id)!.status).toBe('ready');

	// the media's ready flags are lost (a stub overwrote the runtime entry) → request again
	d.mediaById.set('m1', media('m1'));
	const second = requestMakeKaraoke('m1', d)!;
	expect(second.id).toBe(first.id); // deduped to the finished job
	const m = d.mediaById.get('m1')!;
	expect(m.stemStatus).toBe('ready'); // NOT left 'queued'
	expect(m.instrumentalRef).toBe(instrumentalKey('m1'));
	expect(isEntryReady(entry('q', 'm1'), d.mediaById)).toBe(true); // playable, not held forever
});
