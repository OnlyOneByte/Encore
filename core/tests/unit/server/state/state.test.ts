// Mutate -> rev bumps -> async persist -> reload-from-db equals memory.
import { test, expect, jest, spyOn } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { AuthoritativeState } from '$lib/server/state/store';
import { sqlitePersistence } from '$lib/server/state/persistence';
import { hydrate } from '$lib/server/db/migrate';
import { ulid, type QueueEntry, type PlaybackState } from '$lib/contract';

const entry = (singerId: string, addedAt: number): QueueEntry => ({
	id: ulid(addedAt),
	mediaId: 'm-' + singerId + addedAt,
	singerId,
	status: 'queued',
	rotationSeq: -1,
	addedAt
});

// Playback is keyed by room, and these tests exercise one, so a fixed id is enough — the FK is not
// enforced on this bun:sqlite DB, so no `rooms` row is needed for the write to land.
const TEST_ROOM = 'test-room';

test('mutations bump rev monotonically', () => {
	const s = new AuthoritativeState();
	expect(s.rev).toBe(0);
	s.applyQueueOp({ op: 'add', entry: entry('a', 1) });
	expect(s.rev).toBe(1);
	s.applyQueueOp({ op: 'add', entry: entry('b', 2) });
	expect(s.rev).toBe(2);
	s.setPlayback({ isPlaying: true });
	expect(s.rev).toBe(3);
});

test('server re-assigns fair rotationSeq on every mutation (round-robin)', () => {
	const s = new AuthoritativeState();
	const a1 = entry('a', 1),
		a2 = entry('a', 2),
		b1 = entry('b', 3);
	s.applyQueueOp({ op: 'add', entry: a1 });
	s.applyQueueOp({ op: 'add', entry: a2 });
	s.applyQueueOp({ op: 'add', entry: b1 });
	// Fair order a1,b1,a2 gives seqs 0,1,2 — NOT insertion order a1,a2,b1.
	const ids = s.entries.map((e) => e.id);
	expect(ids).toEqual([a1.id, b1.id, a2.id]);
	expect(s.entries.map((e) => e.rotationSeq)).toEqual([0, 1, 2]);
});

test('entries getter returns a defensive copy (caller cannot mutate authoritative state)', () => {
	const s = new AuthoritativeState();
	s.applyQueueOp({ op: 'add', entry: entry('a', 1) });
	const leaked = s.entries; // a defensive copy
	leaked[0]!.status = 'done';
	expect(s.entries[0]!.status).toBe('queued'); // authoritative state unchanged
});

test('write-behind: flushNow persists; reload-from-db equals in-memory', () => {
	const db = migratedDb();
	const s = new AuthoritativeState(sqlitePersistence(db, TEST_ROOM), 10_000); // long delay; we force flush

	s.applyQueueOp({ op: 'add', entry: entry('a', 1) });
	s.applyQueueOp({ op: 'add', entry: entry('b', 2) });
	s.setPlayback({ currentEntryId: s.entries[0]!.id, isPlaying: true });
	s.flushNow();

	const reloaded = new AuthoritativeState();
	const { entries, playback } = hydrate(db, TEST_ROOM);
	reloaded.hydrate(entries, playback);

	expect(reloaded.entries.map((e) => e.id)).toEqual(s.entries.map((e) => e.id));
	expect(reloaded.entries.map((e) => e.rotationSeq)).toEqual(s.entries.map((e) => e.rotationSeq));
	expect(reloaded.playback.currentEntryId).toBe(s.playback.currentEntryId);
	expect(reloaded.playback.isPlaying).toBe(true);
});

test('write-behind: the UPDATE arm round-trips ALL playback fields on a SECOND flush', () => {
	// `playback_state.room_id` is the same for every flush in a room, so the FIRST flush inserts and every
	// later one takes the onConflictDoUpdate `set` arm — a hand-duplicated copy of the `.values()` field
	// list. A field added to one and forgotten in the other persists once and then freezes at its boot
	// value, with every single-flush test still green. This is the only arm that drives it.
	const db = migratedDb();
	const s = new AuthoritativeState(sqlitePersistence(db, TEST_ROOM), 10_000);

	s.applyQueueOp({ op: 'add', entry: entry('a', 1) });
	s.applyQueueOp({ op: 'add', entry: entry('b', 2) });

	// First flush is the INSERT arm, seeded with default-ish playback so the second flush is genuinely a
	// CHANGE the update arm has to carry rather than a no-op that passes either way.
	s.setPlayback({ currentEntryId: s.entries[0]!.id });
	s.flushNow();

	// EVERY one of PlaybackState's six fields non-default, then flush again: this is the update arm.
	const target: PlaybackState = {
		currentEntryId: s.entries[1]!.id,
		positionSec: 42,
		isPlaying: true,
		keyShift: 3,
		background: 'solid',
		guideLevel: 0.4
	};
	s.setPlayback(target);
	s.flushNow();

	const reloaded = new AuthoritativeState();
	// Hydrate with the persisted entries alongside playback, as boot does: currentEntryId names entries[1],
	// so an EMPTY entries array trips hydrate's dangling-id self-heal and nulls the field under test.
	const { entries: reloadedEntries, playback } = hydrate(db, TEST_ROOM);
	reloaded.hydrate(reloadedEntries as unknown as QueueEntry[], playback);

	// The key list is DERIVED from `target` (a typed PlaybackState), never hand-written, so a newly-added
	// field the update arm forgets to carry reads back as its boot default and fails loudly. Per-key rather
	// than whole-object, because hydrate passes the raw db row through and it also carries `room_id`.
	const keys = Object.keys(target) as (keyof PlaybackState)[];
	for (const k of keys) expect(reloaded.playback[k]).toEqual(target[k]);
	// The three fields a single-flush test never round-trips, spelled out so a regression names itself.
	expect(reloaded.playback.keyShift).toBe(3);
	expect(reloaded.playback.background).toBe('solid');
	expect(reloaded.playback.guideLevel).toBe(0.4);
});

test('debounced flush coalesces a burst into persisted state', async () => {
	const db = migratedDb();
	const s = new AuthoritativeState(sqlitePersistence(db, TEST_ROOM), 20);
	for (let i = 1; i <= 5; i++) s.applyQueueOp({ op: 'add', entry: entry('a', i) });
	await new Promise((r) => setTimeout(r, 60)); // let the debounce fire
	const { entries } = hydrate(db, TEST_ROOM);
	expect(entries).toHaveLength(5);
});

test('a throwing flush is logged and retried, not thrown out of the timer (BE-05)', async () => {
	// SQLITE_FULL / SQLITE_BUSY out of the bare setTimeout was an uncaught exception: it killed the party server.
	const persisted: boolean[] = [];
	let failuresLeft = 1;
	const s = new AuthoritativeState(
		{
			persist: (snap) => {
				if (failuresLeft-- > 0) throw new Error('SQLITE_FULL: database or disk is full');
				persisted.push(snap.playback.isPlaying);
			}
		},
		5
	);
	const logged: unknown[] = [];
	const realError = console.error;
	console.error = (...args: unknown[]) => logged.push(args);
	try {
		s.setPlayback({ isPlaying: true });
		await new Promise((r) => setTimeout(r, 100)); // first attempt throws, the backed-off retry lands
	} finally {
		console.error = realError;
	}
	expect(logged).toHaveLength(1);
	expect(persisted).toEqual([true]);
});

test('flushNow() resets the failure count after a good write, so the next failure backs off from the start', () => {
	// Calls 1 and 3 fail, call 2 (the flushNow) succeeds. Without the reset, call 3 logs "(2x) ... 1000ms".
	let calls = 0;
	const s = new AuthoritativeState({
		persist: () => {
			if (++calls !== 2) throw new Error('SQLITE_FULL: database or disk is full');
		}
	});
	const logged: string[] = [];
	const err = spyOn(console, 'error').mockImplementation((msg: unknown) => void logged.push(String(msg)));
	jest.useFakeTimers();
	try {
		s.setPlayback({ isPlaying: true });
		jest.advanceTimersByTime(250); // call 1 fails, backoff armed
		s.flushNow(); // call 2 succeeds and clears the backoff timer
		s.setPlayback({ isPlaying: false });
		jest.advanceTimersByTime(250); // call 3 fails
	} finally {
		jest.useRealTimers();
		err.mockRestore();
	}
	expect(calls).toBe(3);
	expect(logged).toHaveLength(2);
	expect(logged[1]).toContain('(1x), retrying in 500ms');
});

test('setPosition does NOT bump rev (Finding #1 — no resync storm from ontimeupdate)', () => {
	const s = new AuthoritativeState();
	s.applyQueueOp({ op: 'add', entry: entry('a', 1) }); // rev -> 1
	const revBefore = s.rev;
	s.setPosition(12.7);
	s.setPosition(13.9);
	s.setPosition(42);
	expect(s.rev).toBe(revBefore); // unchanged across many position updates
	expect(s.playback.positionSec).toBe(42); // tracked (final write is a whole second)
});

test('setPosition keeps sub-second precision in-memory + clamps negative', () => {
	const s = new AuthoritativeState();
	s.setPosition(-5);
	expect(s.playback.positionSec).toBe(0); // a negative playhead is nonsense, clamp it
	// The in-memory and broadcast value must NOT be floored: flooring makes the first ~1.25s of every song
	// broadcast an exact 0, which guide-sync's `restartToZero` reads as a rewind.
	s.setPosition(7.99);
	expect(s.playback.positionSec).toBe(7.99);
});

test('a sub-second telemetry frame is never broadcast as exact 0, yet persists as an integer', () => {
	// `restartToZero` treats an exact 0, with the master past the pre-roll tolerance, as an unambiguous
	// rewind — so a floored sub-second position makes any rev-bumping command (key/guide/pause) re-seek
	// both elements to 0 for the first ~1.25s of every song. The broadcast value must stay sub-second here
	// so it is distinguishable from a restart's literal 0.
	const db = migratedDb();
	const s = new AuthoritativeState(sqlitePersistence(db, TEST_ROOM));
	s.setPosition(0.6);
	expect(s.playback.positionSec).not.toBe(0); // NOT the restart fixed point
	expect(s.playback.positionSec).toBe(0.6);
	s.setPosition(0.9);
	expect(s.playback.positionSec).not.toBe(0);
	expect(s.playback.positionSec).toBe(0.9);

	// The floor still lands at the PERSISTENCE boundary, so the `integer` position_sec column never
	// receives a float — deleting the floor outright is not the fix. This first flush is the INSERT arm.
	s.flushNow();
	const afterInsert = hydrate(db, TEST_ROOM).playback;
	expect(afterInsert).not.toBeNull();
	expect(Number.isInteger(afterInsert!.positionSec)).toBe(true);

	// A second sub-second frame hits the UPDATE arm, which floors INDEPENDENTLY: without it this reads back
	// a float in an integer column. 2.7 keeps a fractional part so that floor is load-bearing on its own.
	s.setPosition(2.7);
	expect(s.playback.positionSec).toBe(2.7); // in-memory still sub-second
	s.flushNow();
	const { playback } = hydrate(db, TEST_ROOM);
	expect(playback).not.toBeNull();
	expect(Number.isInteger(playback!.positionSec)).toBe(true);
	expect(playback!.positionSec).toBe(2); // 2.7 floored to 2 for storage through the UPDATE arm
});

test('applyQueueOp prunes terminal entries from the authoritative queue (Finding #3a)', () => {
	const s = new AuthoritativeState();
	const a: QueueEntry = { id: 'a', mediaId: 'm-a', singerId: 's1', status: 'queued', rotationSeq: -1, addedAt: 1 };
	const b: QueueEntry = { id: 'b', mediaId: 'm-b', singerId: 's1', status: 'queued', rotationSeq: -1, addedAt: 2 };
	s.applyQueueOp({ op: 'add', entry: a });
	s.applyQueueOp({ op: 'add', entry: b });
	s.applyQueueOp({ op: 'status', id: 'a', status: 'done' });
	expect(s.entries.find((e) => e.id === 'a')).toBeUndefined(); // pruned, not lingering
	expect(s.entries.map((e) => e.id)).toEqual(['b']);
});

// — server-owned monotonic addedAt (nextAddedAt) —

test('nextAddedAt is strictly increasing even when called faster than the clock ticks', () => {
	const s = new AuthoritativeState();
	const a = s.nextAddedAt();
	const b = s.nextAddedAt();
	const c = s.nextAddedAt();
	expect(b).toBeGreaterThan(a);
	expect(c).toBeGreaterThan(b);
});

test('hydrate seeds nextAddedAt ABOVE the max persisted stamp (survives restart)', () => {
	const s = new AuthoritativeState();
	// Persisted state can carry a stamp far in the future of Date.now(), and the next server stamp must sit
	// ABOVE it, or a restart-then-add re-opens the jump.
	const future = Date.now() + 5_000_000_000; // ~58 days ahead — well past any same-ms Date.now()
	s.hydrate([entry('a', future)], null);
	const next = s.nextAddedAt();
	expect(next).toBeGreaterThan(future);
});

test('hydrate seed also counts terminal (done/skipped) rows a later add must clear', () => {
	const s = new AuthoritativeState();
	const future = Date.now() + 5_000_000_000;
	const done: QueueEntry = {
		id: 'd',
		mediaId: 'm-d',
		singerId: 's1',
		status: 'done',
		rotationSeq: -1,
		addedAt: future
	};
	// hydrate filters terminal rows OUT of the live queue, but the counter is still seeded above them: a new
	// add must not collide with a done entry's stamp.
	s.hydrate([done], null);
	expect(s.entries).toHaveLength(0); // terminal filtered from the queue
	expect(s.nextAddedAt()).toBeGreaterThan(future); // ...but the stamp still clears it
});
