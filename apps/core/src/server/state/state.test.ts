// M1-C1 done-when: mutate -> rev bumps -> async persist -> reload-from-db equals memory.
import { test, expect } from 'bun:test';
import { AuthoritativeState } from './store';
import { sqlitePersistence } from './persistence';
import { openDb } from '../db/index';
import { runMigrations, hydrate } from '../db/migrate';
import { ulid, type QueueEntry } from '@encore/shared';

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
	s.entries[0]!.status = 'done';
	expect(s.entries[0]!.status).toBe('queued'); // unchanged
});

test('write-behind: flushNow persists; reload-from-db equals in-memory', () => {
	const { db } = openDb(':memory:');
	runMigrations(db, './drizzle');
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

test('debounced flush coalesces a burst into persisted state', async () => {
	const { db } = openDb(':memory:');
	runMigrations(db, './drizzle');
	const s = new AuthoritativeState(sqlitePersistence(db), 20);
	for (let i = 1; i <= 5; i++) s.applyQueueOp({ op: 'add', entry: entry('a', i) });
	await new Promise((r) => setTimeout(r, 60)); // let the debounce fire
	const { entries } = hydrate(db);
	expect(entries).toHaveLength(5);
});
