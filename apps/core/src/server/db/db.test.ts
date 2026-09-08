// Migrate a temp db and round-trip one row of each table.
import { test, expect } from 'bun:test';
import { openDb } from './index';
import { runMigrations, hydrate } from './migrate';
import { rooms, singers, media, queueEntries, playbackState, jobs, jobAttempts } from './schema';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
	db.insert(playbackState).values({ roomId: 'room1', currentEntryId: 'q1', positionSec: 0, isPlaying: false }).run();
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
	const { entries, playback } = hydrate(db, 'room1');
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
	sqlitePersistence(db, 'room-pin').persist({ entries: [pinned, loose], playback });

	// "restart": read the rows back the way boot does
	const { entries } = hydrate(db, 'room-pin');
	const byId = new Map(entries.map((e) => [e.id, e]));
	expect(byId.get('q-pin')!.pinnedSeq).toBe(3);
	expect(byId.get('q-loose')!.pinnedSeq ?? null).toBeNull();
});

// #669 — the job_attempts.selection column must arrive as an INCREMENTAL migration (0001), not an edit
// to the baseline. An existing deployment restarts and re-runs runMigrations; drizzle replays only
// migrations it has not recorded, so a new column belongs in a new numbered file. Editing 0000 in place
// makes an existing DB replay the baseline and throw on CREATE TABLE of an already-existing table (an
// availability failure, reproduced by the reviewer on PR #700). This pins the column reaches the schema
// through migration and round-trips. RED on base: no 0001, so the column is absent and the insert throws.
test('job_attempts.selection is added by migration and round-trips (#669)', () => {
	const { db, sqlite } = openDb(':memory:');
	runMigrations(db);

	const cols = (sqlite.query('PRAGMA table_info(job_attempts)').all() as { name: string }[]).map((c) => c.name);
	expect(cols).toContain('selection');

	const now = 1_700_000_000_000;
	const rec = JSON.stringify({
		baselineFallback: false,
		winnerSuspect: false,
		winnerScore: 0.94,
		choices: [{ textSource: 'lrclib', chosen: 'v1', decidedBy: 'agreement', votes: 2, rejected: [] }]
	});
	db.insert(jobAttempts)
		.values({
			id: 'a1',
			jobId: 'j1',
			mediaId: 'm1',
			cookId: 'c1',
			jobType: 'align',
			attempt: 1,
			enqueuedAt: now,
			selection: rec
		})
		.run();
	const [row] = db.select().from(jobAttempts).all();
	expect(row.selection).toBe(rec);
	// A row that recorded no selection stores NULL, never undefined — the column is nullable by design.
	db.insert(jobAttempts)
		.values({
			id: 'a2',
			jobId: 'j2',
			mediaId: 'm1',
			cookId: 'c1',
			jobType: 'stems',
			attempt: 1,
			enqueuedAt: now
		})
		.run();
	const a2 = db
		.select()
		.from(jobAttempts)
		.all()
		.find((r) => r.id === 'a2')!;
	expect(a2.selection).toBeNull();
});

// #655: playback_state is KEYED BY ROOM. Two rooms each hold their own now-playing / position /
// key-shift / background — the mechanism is the `room_id` primary key replacing the single
// 'singleton' row. On base this REDS: the old table has one PK-'singleton' row, so the second
// insert collides on the primary key (one shared row per deployment) and hydrate can only ever
// return one room's playback for both.
test('#655: two rooms hold independent playback state, keyed by room_id', () => {
	const { db } = openDb(':memory:');
	runMigrations(db);
	const now = 1_700_000_000_000;

	db.insert(rooms).values({ id: 'roomA', code: 'AAAAAA', createdAt: now }).run();
	db.insert(rooms).values({ id: 'roomB', code: 'BBBBBB', createdAt: now }).run();

	// Each room is playing something different, at a different position, in a different key.
	db.insert(playbackState)
		.values({ roomId: 'roomA', currentEntryId: 'entryA', positionSec: 12, isPlaying: true, keyShift: 2 })
		.run();
	db.insert(playbackState)
		.values({ roomId: 'roomB', currentEntryId: 'entryB', positionSec: 99, isPlaying: false, keyShift: -3 })
		.run();

	// Both rows coexist — not one shared 'singleton' row that the second write overwrote.
	expect(db.select().from(playbackState).all()).toHaveLength(2);

	// Boot-hydrate reads each room's OWN playback, independently.
	const a = hydrate(db, 'roomA').playback;
	const b = hydrate(db, 'roomB').playback;
	expect(a?.currentEntryId).toBe('entryA');
	expect(a?.positionSec).toBe(12);
	expect(a?.isPlaying).toBe(true);
	expect(a?.keyShift).toBe(2);
	expect(b?.currentEntryId).toBe('entryB');
	expect(b?.positionSec).toBe(99);
	expect(b?.isPlaying).toBe(false);
	expect(b?.keyShift).toBe(-3);
});

// #655 BLOCKING FIX — the EXISTING-database upgrade path. Every other test in this file builds a
// FRESH db (openDb + runMigrations), which is exactly the coverage gap that let an in-place baseline
// edit pass: a rewritten 0000 is never re-applied to a db that already ran it (Drizzle keys on the
// journal `when`, not the file hash), so `room_id` would never appear and boot hydrate() would throw.
// This test models the real upgrade: apply ONLY the baseline (a pre-#655 deployment), write the
// old-shape 'singleton' row, THEN run the full migration set so 0002 actually runs — and asserts the
// column arrives, the row is re-keyed onto the active room (not dropped), and persist/hydrate work.
test('#655: an EXISTING singleton database upgrades — 0002 adds room_id and re-keys the row onto the active room', () => {
	const { db, sqlite } = openDb(':memory:');

	// Phase 1 — a pre-#655 box: apply ONLY 0000 (baseline), with real Drizzle bookkeeping, by pointing
	// the migrator at a temp folder that holds just the baseline + its snapshot + a one-entry journal.
	const real = join(import.meta.dir, '..', '..', '..', 'drizzle');
	const baseDir = mkdtempSync(join(tmpdir(), 'encore-mig-base-'));
	mkdirSync(join(baseDir, 'meta'), { recursive: true });
	cpSync(join(real, '0000_baseline.sql'), join(baseDir, '0000_baseline.sql'));
	cpSync(join(real, 'meta', '0000_snapshot.json'), join(baseDir, 'meta', '0000_snapshot.json'));
	const fullJournal = JSON.parse(readFileSync(join(real, 'meta', '_journal.json'), 'utf8'));
	const baseJournal = {
		...fullJournal,
		entries: fullJournal.entries.filter((e: { tag: string }) => e.tag === '0000_baseline')
	};
	writeFileSync(join(baseDir, 'meta', '_journal.json'), JSON.stringify(baseJournal));
	runMigrations(db, baseDir);

	// The old-shape data a running party would already hold: the deployment-wide singleton row, plus
	// two rooms (the older is the active one #654's ensureActive resolves to).
	sqlite.run(`INSERT INTO rooms (id, code, created_at) VALUES ('roomA','AAAAAA',1000)`);
	sqlite.run(`INSERT INTO rooms (id, code, created_at) VALUES ('roomB','BBBBBB',2000)`);
	sqlite.run(
		`INSERT INTO playback_state (id, current_entry_id, position_sec, is_playing, key_shift) VALUES ('singleton','qOLD',77,1,3)`
	);

	// Phase 2 — deploy #655: run the FULL migration set. 0000+0001 already recorded, so only 0002 runs.
	runMigrations(db, real);

	// The column arrived (proving 0002 was actually applied, not skipped like an in-place baseline edit).
	const cols = sqlite.query(`PRAGMA table_info(playback_state)`).all() as { name: string }[];
	expect(cols.some((c) => c.name === 'room_id')).toBe(true);
	expect(cols.some((c) => c.name === 'id')).toBe(false);

	// The singleton row was RE-KEYED onto the active (oldest) room, carrying its playback state — not
	// dropped. This is the party keeping its place across the upgrade.
	const row = sqlite
		.query(`SELECT room_id, current_entry_id, position_sec, is_playing, key_shift FROM playback_state`)
		.all() as {
		room_id: string;
		current_entry_id: string;
		position_sec: number;
		is_playing: number;
		key_shift: number;
	}[];
	expect(row).toHaveLength(1);
	expect(row[0]!.room_id).toBe('roomA');
	expect(row[0]!.current_entry_id).toBe('qOLD');
	expect(row[0]!.position_sec).toBe(77);
	expect(row[0]!.key_shift).toBe(3);

	// And the running code can now read + write that room's playback through the real paths.
	const h = hydrate(db, 'roomA');
	expect(h.playback?.positionSec).toBe(77);
	expect(h.playback?.currentEntryId).toBe('qOLD');
});
