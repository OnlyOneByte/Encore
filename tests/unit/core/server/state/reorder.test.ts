// Reorder MY entries; server re-resolves seq; other clients see canonical order.
import { test, expect } from 'bun:test';
import { AuthoritativeState } from '$server/state/store';
import { type QueueEntry } from '@encore/shared';

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
	// Maya queues A then B then C; Sam queues X. Fair order: A, X, B, C
	s.applyQueueOp({ op: 'add', entry: e('A', 'maya', 1) });
	s.applyQueueOp({ op: 'add', entry: e('X', 'sam', 2) });
	s.applyQueueOp({ op: 'add', entry: e('B', 'maya', 3) });
	s.applyQueueOp({ op: 'add', entry: e('C', 'maya', 4) });
	expect(s.entries.map((x) => x.id)).toEqual(['A', 'X', 'B', 'C']);

	// Maya moves C to the front of HER picks (index 0). Her slots were A,B,C -> now C,A,B.
	// Fair order becomes C, X, A, B (Sam's X slot is untouched).
	s.applyQueueOp({ op: 'move', id: 'C', toSeq: 0 });
	expect(s.entries.map((x) => x.id)).toEqual(['C', 'X', 'A', 'B']);
});

test("reorder does not disturb other singers' positions", () => {
	const s = new AuthoritativeState();
	s.applyQueueOp({ op: 'add', entry: e('a1', 'a', 1) });
	s.applyQueueOp({ op: 'add', entry: e('b1', 'b', 2) });
	s.applyQueueOp({ op: 'add', entry: e('a2', 'a', 3) });
	// fair: a1, b1, a2 — b1 always sits in slot 1 (b's first pick)
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

// when the moving singer has a PLAYING entry, reorder-DOWN on their FIRST queued pick
// (the next-to-play song) must swap it with the following pick. Before the fix, the server counted
// the playing entry as index 0, so the client's toSeq (queued-index + 1) landed on the pick's own
// slot — a silent no-op. RED on base for this fixture; the earlier tests use queued-only rosters.
test('reorder-DOWN on the next-to-play song moves it (singer has a playing entry)', () => {
	const s = new AuthoritativeState();
	// One singer: P (will be playing), then q0 (next-to-play), then q1.
	s.applyQueueOp({ op: 'add', entry: e('P', 's', 1) });
	s.applyQueueOp({ op: 'add', entry: e('q0', 's', 2) });
	s.applyQueueOp({ op: 'add', entry: e('q1', 's', 3) });
	s.applyQueueOp({ op: 'status', id: 'P', status: 'playing' });
	// Queued picks the phone would show: [q0, q1]. DOWN on q0 -> toSeq = 0 + 1 = 1.
	s.applyQueueOp({ op: 'move', id: 'q0', toSeq: 1 });
	const queued = s.entries.filter((x) => x.status === 'queued').map((x) => x.id);
	expect(queued).toEqual(['q1', 'q0']); // was ['q0','q1'] before the fix
});
