// M0-C3 done-when: migrate a temp db and round-trip one row of each table.
import { test, expect } from 'bun:test';
import { openDb } from './index';
import { runMigrations, hydrate } from './migrate';
import { rooms, singers, media, queueEntries, playbackState, jobs } from './schema';

test('migrations create all tables and every entity round-trips', () => {
	// in-memory bun:sqlite — no disk, fully isolated per test run
	const { db } = openDb(':memory:');
	runMigrations(db, './drizzle');

	const now = 1_700_000_000_000;

	db.insert(rooms).values({ id: 'room1', code: 'PARTY', createdAt: now }).run();
	db.insert(singers)
		.values({ id: 's1', displayName: 'Maya', color: '#ff5cae', sessionToken: 'tok', joinedAt: now })
		.run();
	db.insert(media)
		.values({ id: 'm1', source: 'youtube', sourceRef: 'abc', title: 'Take On Me', durationSec: 225, stemStatus: 'none', playMode: 'iframe' })
		.run();
	db.insert(queueEntries)
		.values({ id: 'q1', mediaId: 'm1', singerId: 's1', status: 'queued', rotationSeq: 0, addedAt: now })
		.run();
	db.insert(playbackState)
		.values({ id: 'singleton', currentEntryId: 'q1', positionSec: 0, isPlaying: false })
		.run();
	db.insert(jobs)
		.values({ id: 'j1', mediaId: 'm1', jobType: 'stems', status: 'queued', priority: 0, createdAt: now, updatedAt: now })
		.run();

	expect(db.select().from(rooms).all()).toHaveLength(1);
	expect(db.select().from(singers).all()[0]!.displayName).toBe('Maya');
	expect(db.select().from(media).all()[0]!.playMode).toBe('iframe');
	expect(db.select().from(jobs).all()[0]!.jobType).toBe('stems');

	// boot-hydrate returns the durable queue + playback for M1-C1 to seed memory
	const { entries, playback } = hydrate(db);
	expect(entries).toHaveLength(1);
	expect(entries[0]!.id).toBe('q1');
	expect(playback?.currentEntryId).toBe('q1');
});

test('media defaults: stemStatus none, playMode iframe', () => {
	const { db } = openDb(':memory:');
	runMigrations(db, './drizzle');
	db.insert(media).values({ id: 'm2', source: 'local', sourceRef: 'f.mp4', title: 'X', durationSec: 100 }).run();
	const row = db.select().from(media).all()[0]!;
	expect(row.stemStatus).toBe('none');
	expect(row.playMode).toBe('iframe');
});
