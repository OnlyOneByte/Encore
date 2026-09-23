// Reorder MY entries; server re-resolves seq; other clients see canonical order.
import { test, expect } from 'bun:test';
import { AuthoritativeState } from '$lib/server/state/store';
import { type QueueEntry } from '$lib/contract';

const e = (id: string, singerId: string, addedAt: number): QueueEntry => ({
	id,
	mediaId: 'm-' + id,
	singerId,
	status: 'queued',
	rotationSeq: -1,
	addedAt
});

test('reorder within a singer swaps which song holds which rotation slot', () => {
	const s = new AuthoritativeState();
	// Maya queues A, B, C; Sam queues X. Fair order: A, X, B, C.
	s.applyQueueOp({ op: 'add', entry: e('A', 'maya', 1) });
	s.applyQueueOp({ op: 'add', entry: e('X', 'sam', 2) });
	s.applyQueueOp({ op: 'add', entry: e('B', 'maya', 3) });
	s.applyQueueOp({ op: 'add', entry: e('C', 'maya', 4) });
	expect(s.entries.map((x) => x.id)).toEqual(['A', 'X', 'B', 'C']);

	// Maya moves C to the front of HER picks: her slots become C,A,B, and the fair order C,X,A,B — Sam's
	// slot is untouched.
	s.applyQueueOp({ op: 'move', id: 'C', toSeq: 0 });
	expect(s.entries.map((x) => x.id)).toEqual(['C', 'X', 'A', 'B']);
});

test("reorder does not disturb other singers' positions", () => {
	const s = new AuthoritativeState();
	s.applyQueueOp({ op: 'add', entry: e('a1', 'a', 1) });
	s.applyQueueOp({ op: 'add', entry: e('b1', 'b', 2) });
	s.applyQueueOp({ op: 'add', entry: e('a2', 'a', 3) });
	// Fair order a1,b1,a2: b1 always sits in slot 1, b's first pick.
	s.applyQueueOp({ op: 'move', id: 'a2', toSeq: 0 }); // a swaps to a2, a1
	const ids = s.entries.map((x) => x.id);
	expect(ids).toEqual(['a2', 'b1', 'a1']);
	expect(ids[1]).toBe('b1'); // b1 undisturbed in its slot
});

test('move clamps out-of-range target', () => {
	const s = new AuthoritativeState();
	s.applyQueueOp({ op: 'add', entry: e('a1', 'a', 1) });
	s.applyQueueOp({ op: 'add', entry: e('a2', 'a', 2) });
	s.applyQueueOp({ op: 'move', id: 'a1', toSeq: 99 }); // clamp to last
	expect(s.entries.map((x) => x.id)).toEqual(['a2', 'a1']);
});

test('move of unknown id is a safe no-op', () => {
	const s = new AuthoritativeState();
	s.applyQueueOp({ op: 'add', entry: e('a1', 'a', 1) });
	const before = s.entries.map((x) => x.id);
	s.applyQueueOp({ op: 'move', id: 'ghost', toSeq: 0 });
	expect(s.entries.map((x) => x.id)).toEqual(before);
});

// With a PLAYING entry in the moving singer's slots, reorder-DOWN on their FIRST queued pick must swap it
// with the following one. Counting the playing entry as index 0 makes the client's toSeq (queued-index + 1)
// land on the pick's own slot — a silent no-op. The earlier tests use queued-only rosters, so this fixture
// is the only one that reaches it.
test('reorder-DOWN on the next-to-play song moves it (singer has a playing entry)', () => {
	const s = new AuthoritativeState();
	// One singer: P (playing), then q0 (next-to-play), then q1.
	s.applyQueueOp({ op: 'add', entry: e('P', 's', 1) });
	s.applyQueueOp({ op: 'add', entry: e('q0', 's', 2) });
	s.applyQueueOp({ op: 'add', entry: e('q1', 's', 3) });
	s.applyQueueOp({ op: 'status', id: 'P', status: 'playing' });
	// The phone shows [q0, q1], so DOWN on q0 gives toSeq = 0 + 1 = 1.
	s.applyQueueOp({ op: 'move', id: 'q0', toSeq: 1 });
	const queued = s.entries.filter((x) => x.status === 'queued').map((x) => x.id);
	expect(queued).toEqual(['q1', 'q0']); // was ['q0','q1'] before the fix
});
