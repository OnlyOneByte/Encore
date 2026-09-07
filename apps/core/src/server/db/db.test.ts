// Migrate a temp db and round-trip one row of each table.
import { test, expect } from 'bun:test';
import { openDb } from './index';
import { runMigrations, hydrate } from './migrate';
import { rooms, singers, media, queueEntries, playbackState, jobs } from './schema';
import { sqlitePersistence } from '../state/persistence';
import type { PlaybackState, QueueEntry } from '@encore/shared';

test('migrations create all tables and every entity round-trips', () => {
	// in-memory bun:sqlite — no disk, fully isolated per test run
	const { db } = openDb(':memory:');
	runMigrations(db);

	const now = 1_700_000_000_000;

	db.insert(rooms).values({ id: 'room1', code: 'PARTY', createdAt: now }).run();
	db.insert(singers)
		.values({ id: 's1', displayName: 'Maya', color: '#ff5cae', sessionToken: 'tok', joinedAt: now })
		.run();
	db.insert(media)
		.values({
			id: 'm1',
			source: 'youtube',
			sourceRef: 'abc',
			title: 'Take On Me',
			durationSec: 225,
			stemStatus: 'none'
		})
		.run();
	db.insert(queueEntries)
		.values({ id: 'q1', mediaId: 'm1', singerId: 's1', status: 'queued', rotationSeq: 0, addedAt: now })
		.run();
	db.insert(playbackState).values({ id: 'singleton', currentEntryId: 'q1', positionSec: 0, isPlaying: false }).run();
	db.insert(jobs)
		.values({
			id: 'j1',
			mediaId: 'm1',
			jobType: 'stems',
			status: 'queued',
			priority: 0,
			createdAt: now,
			updatedAt: now
		})
		.run();

	expect(db.select().from(rooms).all()).toHaveLength(1);
	expect(db.select().from(singers).all()[0]!.displayName).toBe('Maya');
	expect(db.select().from(jobs).all()[0]!.jobType).toBe('stems');

	// boot-hydrate returns the durable queue + playback to seed memory
	const { entries, playback } = hydrate(db);
	expect(entries).toHaveLength(1);
	expect(entries[0]!.id).toBe('q1');
	expect(playback?.currentEntryId).toBe('q1');
});

test('media defaults: stemStatus none', () => {
	const { db } = openDb(':memory:');
	runMigrations(db);
	db.insert(media).values({ id: 'm2', source: 'local', sourceRef: 'f.mp4', title: 'X', durationSec: 100 }).run();
	const row = db.select().from(media).all()[0]!;
	expect(row.stemStatus).toBe('none');
});

// Issue #638: a host pin (pinnedSeq) is durable — it must survive a restart, which is the whole point
// of Option B (a column) over a transient reorder. Round-trips through the REAL write-behind path
// (sqlitePersistence) and boot hydrate, not a raw insert, so it proves the persist mapping carries the
// field. RED on base: the queue_entries baseline has no pinned_seq column, so this insert/read cannot
// preserve it (drizzle would reject the unknown column, or the value would be dropped).
test('a host pin (pinnedSeq) survives persist + hydrate; an unpinned entry stores null', () => {
	const { db } = openDb(':memory:');
	runMigrations(db);
	const now = 1_700_000_000_000;
	const playback: PlaybackState = {
		currentEntryId: null,
		positionSec: 0,
		isPlaying: false,
		keyShift: 0,
		background: null,
		guideLevel: null
	};
	const pinned: QueueEntry = {
		id: 'q-pin',
		mediaId: 'm1',
		singerId: 's1',
		status: 'queued',
		rotationSeq: 0,
		addedAt: now,
		pinnedSeq: 3
	};
	const loose: QueueEntry = {
		id: 'q-loose',
		mediaId: 'm1',
		singerId: 's1',
		status: 'queued',
		rotationSeq: 1,
		addedAt: now + 1
		// no pinnedSeq — an unpinned entry
	};
	sqlitePersistence(db).persist({ entries: [pinned, loose], playback });

	// "restart": read the rows back the way boot does
	const { entries } = hydrate(db);
	const byId = new Map(entries.map((e) => [e.id, e]));
	expect(byId.get('q-pin')!.pinnedSeq).toBe(3);
	expect(byId.get('q-loose')!.pinnedSeq ?? null).toBeNull();
});
