// M7-C6: make-karaoke request flips media to cooking-file (rotation auto-holds the slot), enqueues
// a stems job at need-priority, dedups repeats, and refuses to disrupt the live song. markMediaReady
// flips to the playable instrumental. Plus the round-trip: cook → held → ready → plays at its slot.
import { test, expect } from 'bun:test';
import { requestMakeKaraoke, markMediaReady, instrumentalKey, soonestSeqFor, type MakeKaraokeDeps } from './make-karaoke';
import { JobRepository } from './repository';
import { AuthoritativeState } from '../state/store';
import { nextPlayable, isEntryReady } from '../rotation/index';
import { openDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import type { Media, QueueEntry } from '@encore/shared';

const T0 = 1_700_000_000_000;
const media = (id: string, over: Partial<Media> = {}): Media => ({
	id, source: 'youtube', sourceRef: 'vid-' + id, title: id, durationSec: 200, stemStatus: 'none', playMode: 'iframe', ...over
});
let _s = 0;
const entry = (id: string, mediaId: string, singerId = 's1'): QueueEntry => ({ id, mediaId, singerId, status: 'queued', rotationSeq: -1, addedAt: ++_s });

function deps(): MakeKaraokeDeps & { mediaById: Map<string, Media> } {
	const { db } = openDb(':memory:');
	runMigrations(db, './drizzle');
	return { jobs: new JobRepository(db), mediaById: new Map(), state: new AuthoritativeState(), now: () => T0 };
}

test('request flips media to cooking file + enqueues a stems job', () => {
	const d = deps();
	d.mediaById.set('m1', media('m1')); // starts as a ready iframe
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

test('markMediaReady points the media at the instrumental + flips to ready', () => {
	const d = deps();
	d.mediaById.set('m1', media('m1', { playMode: 'file', stemStatus: 'queued' }));
	expect(markMediaReady('m1', d.mediaById)).toBe(true);
	const m = d.mediaById.get('m1')!;
	expect(m.stemStatus).toBe('ready');
	expect(m.playMode).toBe('file');
	expect(m.sourceRef).toBe(instrumentalKey('m1'));
	expect(m.sourceRef).toBe('stems/m1-instrumental.wav');
	expect(markMediaReady('ghost', d.mediaById)).toBe(false);
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
