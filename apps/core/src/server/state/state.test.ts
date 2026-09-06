// Mutate -> rev bumps -> async persist -> reload-from-db equals memory.
import { test, expect } from 'bun:test';
import { AuthoritativeState } from './store';
import { sqlitePersistence } from './persistence';
import { openDb } from '../db/index';
import { runMigrations, hydrate } from '../db/migrate';
import { ulid, type QueueEntry, type PlaybackState } from '@encore/shared';

const entry = (singerId: string, addedAt: number): QueueEntry => ({
	id: ulid(addedAt),
	mediaId: 'm-' + singerId + addedAt,
	singerId,
	status: 'queued',
	rotationSeq: -1,
	addedAt
});

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
	const a1 = entry('a', 1), a2 = entry('a', 2), b1 = entry('b', 3);
	s.applyQueueOp({ op: 'add', entry: a1 });
	s.applyQueueOp({ op: 'add', entry: a2 });
	s.applyQueueOp({ op: 'add', entry: b1 });
	// fair order a1,b1,a2 -> seqs 0,1,2 (NOT insertion order a1,a2,b1)
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
	const { db } = openDb(':memory:');
	runMigrations(db);
	const s = new AuthoritativeState(sqlitePersistence(db), 10_000); // long delay; we force flush

	s.applyQueueOp({ op: 'add', entry: entry('a', 1) });
	s.applyQueueOp({ op: 'add', entry: entry('b', 2) });
	s.setPlayback({ currentEntryId: s.entries[0]!.id, isPlaying: true });
	s.flushNow();

	// hydrate a fresh state from the db and compare
	const reloaded = new AuthoritativeState();
	const { entries, playback } = hydrate(db);
	reloaded.hydrate(entries, playback);

	expect(reloaded.entries.map((e) => e.id)).toEqual(s.entries.map((e) => e.id));
	expect(reloaded.entries.map((e) => e.rotationSeq)).toEqual(s.entries.map((e) => e.rotationSeq));
	expect(reloaded.playback.currentEntryId).toBe(s.playback.currentEntryId);
	expect(reloaded.playback.isPlaying).toBe(true);
});

test('write-behind: the UPDATE arm round-trips ALL playback fields on a SECOND flush', () => {
	// `playback_state.id` is always 'singleton', so the FIRST flush inserts and EVERY later flush
	// takes the onConflictDoUpdate `set` arm. That arm is a hand-duplicated copy of the `.values()`
	// field list; a field added to one and forgotten in the other would persist once and then freeze
	// at its boot value, with every other test (all single-flush) still green. This drives the arm.
	const { db } = openDb(':memory:');
	runMigrations(db);
	const s = new AuthoritativeState(sqlitePersistence(db), 10_000);

	s.applyQueueOp({ op: 'add', entry: entry('a', 1) });
	s.applyQueueOp({ op: 'add', entry: entry('b', 2) });

	// First flush -> INSERT arm. Seed the row with default-ish playback so the second flush is
	// genuinely a CHANGE the update arm has to carry (not a no-op that could pass either way).
	s.setPlayback({ currentEntryId: s.entries[0]!.id });
	s.flushNow();

	// Now set EVERY one of PlaybackState's six fields to a non-default value and flush AGAIN. This
	// second flush is the one that exercises the conflict/update arm.
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
	// Hydrate with the persisted entries alongside playback, exactly as boot does. currentEntryId
	// names entries[1], so passing the real entries keeps it resolvable — an EMPTY entries array here
	// would trip hydrate's dangling-id self-heal (issue #128) and null the very field we round-trip.
	const { entries: reloadedEntries, playback } = hydrate(db);
	reloaded.hydrate(reloadedEntries as unknown as QueueEntry[], playback);

	// Assert EVERY field of `target` round-tripped. The key list is derived from `target` (a typed
	// PlaybackState), not hand-written, so a newly-added field the update arm forgets to carry lands
	// in `target` yet reads back as its boot default here and fails loudly. (We compare per-key rather
	// than whole-object because hydrate passes the raw db row through, which also carries the `id`
	// column — that leak is pre-existing and out of scope for this test.)
	const keys = Object.keys(target) as (keyof PlaybackState)[];
	for (const k of keys) expect(reloaded.playback[k]).toEqual(target[k]);
	// spell out the three fields the old single-flush test never round-tripped, so a regression names itself
	expect(reloaded.playback.keyShift).toBe(3);
	expect(reloaded.playback.background).toBe('solid');
	expect(reloaded.playback.guideLevel).toBe(0.4);
});

test('debounced flush coalesces a burst into persisted state', async () => {
	const { db } = openDb(':memory:');
	runMigrations(db);
	const s = new AuthoritativeState(sqlitePersistence(db), 20);
	for (let i = 1; i <= 5; i++) s.applyQueueOp({ op: 'add', entry: entry('a', i) });
	await new Promise((r) => setTimeout(r, 60)); // let the debounce fire
	const { entries } = hydrate(db);
	expect(entries).toHaveLength(5);
});

test('setPosition does NOT bump rev (Finding #1 — no resync storm from ontimeupdate)', () => {
	const s = new AuthoritativeState();
	s.applyQueueOp({ op: 'add', entry: entry('a', 1) }); // rev -> 1
	const revBefore = s.rev;
	s.setPosition(12.7);
	s.setPosition(13.9);
	s.setPosition(42);
	expect(s.rev).toBe(revBefore); // unchanged across many position updates
	expect(s.playback.positionSec).toBe(42); // floored, tracked
});

test('setPosition floors + clamps negative', () => {
	const s = new AuthoritativeState();
	s.setPosition(-5);
	expect(s.playback.positionSec).toBe(0);
	s.setPosition(7.99);
	expect(s.playback.positionSec).toBe(7);
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


// — #345: server-owned monotonic addedAt (nextAddedAt) —

test('#345: nextAddedAt is strictly increasing even when called faster than the clock ticks', () => {
	const s = new AuthoritativeState();
	const a = s.nextAddedAt();
	const b = s.nextAddedAt();
	const c = s.nextAddedAt();
	expect(b).toBeGreaterThan(a);
	expect(c).toBeGreaterThan(b);
});

test('#345: hydrate seeds nextAddedAt ABOVE the max persisted stamp (survives restart)', () => {
	const s = new AuthoritativeState();
	// Persisted state from before the reboot carries a stamp far in the future of Date.now(): the
	// next server stamp must sit ABOVE it, or a restart-then-add re-opens the very jump this fixes.
	const future = Date.now() + 5_000_000_000; // ~58 days ahead — well past any same-ms Date.now()
	s.hydrate([entry('a', future)], null);
	const next = s.nextAddedAt();
	expect(next).toBeGreaterThan(future);
});

test('#345: hydrate seed also counts terminal (done/skipped) rows a later add must clear', () => {
	const s = new AuthoritativeState();
	const future = Date.now() + 5_000_000_000;
	const done: QueueEntry = { id: 'd', mediaId: 'm-d', singerId: 's1', status: 'done', rotationSeq: -1, addedAt: future };
	// hydrate filters terminal rows OUT of the live queue, but the counter must still be seeded above
	// them — a new add must not collide with a done entry's stamp.
	s.hydrate([done], null);
	expect(s.entries).toHaveLength(0); // terminal filtered from the queue
	expect(s.nextAddedAt()).toBeGreaterThan(future); // ...but the stamp still clears it
});
