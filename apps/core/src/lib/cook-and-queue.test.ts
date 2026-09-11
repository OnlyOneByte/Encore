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

// ── #741 F1: the retry the app advertises must not book a SECOND turn ─────────────────────────────
// A terminally failed cook keeps offering Sing ("tap Sing to try again"), and taking that advice ran
// BOTH steps — so the singer held two queued turns of one song and the room played it twice. With a
// turn already queued the queue step must be skipped and only the cook run. Asserted against a
// hard-coded expected call list, not derived from the same branch the code takes.
test('a retry (hasQueuedTurn) COOKS but does NOT queue a second turn', () => {
	const calls: string[] = [];
	const out = cookAndQueue({
		queue: () => calls.push('queue'),
		cook: () => calls.push('cook'),
		hasQueuedTurn: true
	});
	expect(calls).toEqual(['cook']); // cook only — the queue step was skipped
	expect(out).toHaveLength(1); // and the caller can tell a retry from a first tap by result length
});

test('a first tap (no queued turn) still queues THEN cooks — the failed case is the only change', () => {
	// The default path is untouched: without a queued turn both steps run, in the load-bearing order.
	const calls: string[] = [];
	cookAndQueue({ queue: () => calls.push('queue'), cook: () => calls.push('cook') });
	expect(calls).toEqual(['queue', 'cook']);
	const explicit: string[] = [];
	cookAndQueue({
		queue: () => explicit.push('queue'),
		cook: () => explicit.push('cook'),
		hasQueuedTurn: false
	});
	expect(explicit).toEqual(['queue', 'cook']);
});

test('the skipped retry cook still inherits the existing turn position, not NO_QUEUE_PRIORITY', () => {
	// The reason skipping the queue step is safe: the turn the singer ALREADY holds is one of the
	// turns soonestSeqFor reads, so the retry cook files at that position rather than at the bottom.
	expect(soonestSeqFor('m1', [entry({ rotationSeq: 4 })])).toBe(4);
	expect(soonestSeqFor('m1', [])).toBe(NO_QUEUE_PRIORITY); // and with no turn at all, the fallback
});
