// Migrate a temp db and round-trip one row of each table.
import { test, expect } from 'bun:test';
import { openDb } from '$lib/server/db/index';
import { runMigrations, hydrate } from '$lib/server/db/migrate';
import {
	rooms,
	singers,
	media,
	queueEntries,
	playbackState,
	jobs,
	jobAttempts,
	roomSettings
} from '$lib/server/db/schema';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { at, read } from '@encore/test-support';
import { sqlitePersistence } from '$lib/server/state/persistence';
import { SingerRepository } from '$lib/server/singers/repository';
import { SettingsRepository } from '$lib/server/state/settings-repository';
import { MediaRepository } from '$lib/server/media/repository';
import { DEFAULT_STAGE_COLOR, STAGE_BG_C, STAGE_BG_L, hueToHex, stageHueToHex, guidePath } from '$lib/contract';
import type { PlaybackState, QueueEntry } from '$lib/contract';

/**
 * The real migration folder. Was `at('drizzle')` at seven sites,
 * counted out from this test's old home in src/lib/server/db; it is drizzle, named once
 * here and anchored on the repo root.
 */
const DRIZZLE = at('drizzle');

test('migrations create all tables and every entity round-trips', () => {
	// in-memory bun:sqlite — no disk, fully isolated per test run
	const { db } = openDb(':memory:');
	runMigrations(db);

	const now = 1_700_000_000_000;

	db.insert(rooms).values({ id: 'room1', code: 'PARTY', createdAt: now }).run();
	db.insert(singers)
		.values({ id: 's1', displayName: 'Maya', color: '#ff5cae', sessionToken: 'tok', joinedAt: now, roomId: 'room1' })
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
		.values({
			id: 'q1',
			mediaId: 'm1',
			singerId: 's1',
			status: 'queued',
			rotationSeq: 0,
			addedAt: now,
			roomId: 'room1'
		})
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

// media.lyrics_override_ref arrives via migration 0010 (not a baseline edit), defaults null
// ("no human override → the ranking decides"), and round-trips a stored ref. RED on base: the media
// baseline has no lyrics_override_ref column, so this insert/read cannot preserve it.
test('media.lyrics_override_ref defaults null and round-trips a stored ref', () => {
	const { db, sqlite } = openDb(':memory:');
	runMigrations(db);
	const cols = (sqlite.query('PRAGMA table_info(media)').all() as { name: string }[]).map((c) => c.name);
	expect(cols).toContain('lyrics_override_ref'); // the migration added it
	db.insert(media).values({ id: 'o0', source: 'youtube', sourceRef: 'a', title: 'A', durationSec: 200 }).run();
	db.insert(media)
		.values({
			id: 'o1',
			source: 'youtube',
			sourceRef: 'b',
			title: 'B',
			durationSec: 200,
			lyricsOverrideRef: 'derived/lyrics/o1-manual-word.json'
		})
		.run();
	const byId = new Map(
		db
			.select()
			.from(media)
			.all()
			.map((r) => [r.id, r.lyricsOverrideRef])
	);
	expect(byId.get('o0')).toBeNull(); // no override
	expect(byId.get('o1')).toBe('derived/lyrics/o1-manual-word.json');
});

// media.lyrics_override_text arrives via migration 0011 (not a baseline edit), defaults null ("no
// pasted text → the pin names a candidate already on disk"), and round-trips the words behind a pasted
// override. It is the column that makes a paste survive a restart between enqueue and dispatch, where
// `assignParams` re-derives the align job's `pinnedText` from this row. RED on base: the media table has
// no lyrics_override_text column, so this insert/read cannot preserve it.
test('media.lyrics_override_text defaults null and round-trips pasted words', () => {
	const { db, sqlite } = openDb(':memory:');
	runMigrations(db);
	const cols = (sqlite.query('PRAGMA table_info(media)').all() as { name: string }[]).map((c) => c.name);
	expect(cols).toContain('lyrics_override_text'); // the migration added it
	db.insert(media).values({ id: 't0', source: 'youtube', sourceRef: 'a', title: 'A', durationSec: 200 }).run();
	db.insert(media)
		.values({
			id: 't1',
			source: 'youtube',
			sourceRef: 'b',
			title: 'B',
			durationSec: 200,
			lyricsOverrideRef: 'derived/lyrics/t1-manual-word.json',
			lyricsOverrideText: 'hello darkness my old friend\nive come to talk with you again'
		})
		.run();
	const byId = new Map(
		db
			.select()
			.from(media)
			.all()
			.map((r) => [r.id, r.lyricsOverrideText])
	);
	expect(byId.get('t0')).toBeNull(); // no pasted text — a ref pick, or no pin at all
	// Newlines survive: the worker splits the paste into one line per lyric line.
	expect(byId.get('t1')).toBe('hello darkness my old friend\nive come to talk with you again');
});

// the room_settings.lyrics_ball COLUMN default is 'off' (owner decision C — flip the marker
// default to No marker, keep the styles). This pins the SQLite column default itself: a raw insert
// that omits lyrics_ball must read back 'off'. Reverting schema.ts's .default('off') -> 'bounce'
// reds this. (The app read path never hits this default — getRoom returns DEFAULT_ROOM_SETTINGS for
// a no-row room and setRoom writes every column — so this guards the migration / hand-edited-DB path
// the column default actually governs.)
test('room_settings column defaults: lyrics_ball is off', () => {
	const { db } = openDb(':memory:');
	runMigrations(db);
	db.insert(roomSettings).values({ roomId: 'r1' }).run();
	const row = db.select().from(roomSettings).all()[0]!;
	expect(row.lyricsBall).toBe('off');
});

// — the job_attempts.selection column must arrive as an INCREMENTAL migration (0001), not an edit
// to the baseline. An existing deployment restarts and re-runs runMigrations; drizzle replays only
// migrations it has not recorded, so a new column belongs in a new numbered file. Editing 0000 in place
// makes an existing DB replay the baseline and throw on CREATE TABLE of an already-existing table (an
// availability failure, reproduced by the reviewer in code review). This pins the column reaches the schema
// through migration and round-trips. RED on base: no 0001, so the column is absent and the insert throws.
test('job_attempts.selection is added by migration and round-trips', () => {
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
			processingId: 'c1',
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
			processingId: 'c1',
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

// playback_state is KEYED BY ROOM. Two rooms each hold their own now-playing / position /
// key-shift / background — the mechanism is the `room_id` primary key replacing the single
// 'singleton' row. On base this REDS: the old table has one PK-'singleton' row, so the second
// insert collides on the primary key (one shared row per deployment) and hydrate can only ever
// return one room's playback for both.
test('two rooms hold independent playback state, keyed by room_id', () => {
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

// queue_entries is KEYED BY ROOM. Two rooms each hold their own queue + rotation — the mechanism
// is the `room_id` column plus the write-behind sink and boot-hydrate both scoping by room_id. On base
// this REDS: queue_entries has no room_id, so the two rooms' entries land in ONE undifferentiated
// table and hydrate(roomA)/hydrate(roomB) each return BOTH rooms' entries — a shared deployment queue.
test('two rooms hold independent queues, keyed by room_id (persist + hydrate)', () => {
	const { db } = openDb(':memory:');
	runMigrations(db);
	const now = 1_700_000_000_000;
	db.insert(rooms).values({ id: 'roomA', code: 'AAAAAA', createdAt: now }).run();
	db.insert(rooms).values({ id: 'roomB', code: 'BBBBBB', createdAt: now }).run();

	const idle: PlaybackState = {
		currentEntryId: null,
		positionSec: 0,
		isPlaying: false,
		keyShift: 0,
		background: null,
		guideLevel: null
	};
	const qe = (id: string, singerId: string, seq: number): QueueEntry => ({
		id,
		mediaId: 'm-' + id,
		singerId,
		status: 'queued',
		rotationSeq: seq,
		addedAt: now + seq
	});

	// Each room persists its OWN queue through the real write-behind path, bound to its own room id.
	sqlitePersistence(db, 'roomA').persist({ entries: [qe('a1', 'ana', 0), qe('a2', 'ana', 1)], playback: idle });
	sqlitePersistence(db, 'roomB').persist({ entries: [qe('b1', 'ben', 0)], playback: idle });

	// The rows coexist in one table but are partitioned by room_id — not one shared queue.
	expect(db.select().from(queueEntries).all()).toHaveLength(3);

	// Boot-hydrate reads each room's OWN queue, independently. A song queued in A never appears in B.
	expect(
		hydrate(db, 'roomA')
			.entries.map((e) => e.id)
			.sort()
	).toEqual(['a1', 'a2']);
	expect(hydrate(db, 'roomB').entries.map((e) => e.id)).toEqual(['b1']);

	// AND a room's write-behind replace only clears ITS OWN rows: re-persisting roomA's queue must not
	// wipe roomB's. A global `delete` in the sink (the pre-0003 shape) would fail this.
	sqlitePersistence(db, 'roomA').persist({ entries: [qe('a3', 'ana', 0)], playback: idle });
	expect(hydrate(db, 'roomA').entries.map((e) => e.id)).toEqual(['a3']);
	expect(hydrate(db, 'roomB').entries.map((e) => e.id)).toEqual(['b1']); // roomB untouched
});
