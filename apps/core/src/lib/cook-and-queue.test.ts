// The ordering rule is the whole point of this module, so it gets a test that fails if someone
// "simplifies" the two calls into the other order.
import { test, expect } from 'bun:test';
import { cookAndQueue } from './cook-and-queue';
import { soonestSeqFor, NO_QUEUE_PRIORITY } from '../server/jobs/make-karaoke';
import type { QueueEntry } from '@encore/shared';

test('queue happens BEFORE cook, so the cook inherits the singer position', () => {
	const calls: string[] = [];
	cookAndQueue({ queue: () => calls.push('queue'), cook: () => calls.push('cook') });
	expect(calls).toEqual(['queue', 'cook']);
});

const entry = (over: Partial<QueueEntry> = {}): QueueEntry => ({
	id: 'e1',
	mediaId: 'm1',
	singerId: 's1',
	status: 'queued',
	rotationSeq: 3,
	addedAt: 0,
	...over
});

test('WHY the order matters: an unqueued song cooks at the bottom of the world', () => {
	// Cook-first is this case — the core cannot see any turn waiting on the song, so the job is filed
	// at NO_QUEUE_PRIORITY and sorts behind even the lyrics backfill.
	expect(soonestSeqFor('m1', [])).toBe(NO_QUEUE_PRIORITY);
});

test('queue-first gives the same cook the singer own rotation position', () => {
	expect(soonestSeqFor('m1', [entry()])).toBe(3);
	// The SOONEST turn wins when several singers want the same song — the cook serves whoever is up first.
	expect(soonestSeqFor('m1', [entry({ rotationSeq: 7 }), entry({ id: 'e2', rotationSeq: 2 })])).toBe(2);
});

test('a turn for a DIFFERENT song does not lend its priority', () => {
	expect(soonestSeqFor('m1', [entry({ mediaId: 'other' })])).toBe(NO_QUEUE_PRIORITY);
});
