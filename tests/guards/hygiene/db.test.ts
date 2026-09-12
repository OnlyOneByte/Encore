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
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { at, read } from '@encore/test-support';
import { sqlitePersistence } from '$lib/server/state/persistence';
import { SingerRepository } from '$lib/server/singers/repository';
import { SettingsRepository } from '$lib/server/state/settings-repository';
import { DEFAULT_STAGE_COLOR, STAGE_BG_C, STAGE_BG_L, hueToHex, stageHueToHex } from '$lib/contract';
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

// guide_offset_ms is added by migration 0006, NULLABLE with no default — a row that omits it
// reads back null ("never measured", which the client maps to 0), and a stored signed value (0
// included, a measured "aligned") round-trips. RED on base: the media baseline has no guide_offset_ms
// column, so this insert/read cannot preserve it.
test('media.guide_offset_ms defaults null and round-trips a signed value (0 included)', () => {
	const { db } = openDb(':memory:');
	runMigrations(db);
	db.insert(media).values({ id: 'g0', source: 'youtube', sourceRef: 'a', title: 'A', durationSec: 200 }).run();
	db.insert(media)
		.values({ id: 'g1', source: 'youtube', sourceRef: 'b', title: 'B', durationSec: 200, guideOffsetMs: 30 })
		.run();
	db.insert(media)
		.values({ id: 'g2', source: 'youtube', sourceRef: 'c', title: 'C', durationSec: 200, guideOffsetMs: -25 })
		.run();
	db.insert(media)
		.values({ id: 'g3', source: 'youtube', sourceRef: 'd', title: 'D', durationSec: 200, guideOffsetMs: 0 })
		.run();
	const byId = new Map(db.select().from(media).all().map((r) => [r.id, r.guideOffsetMs]));
	expect(byId.get('g0')).toBeNull(); // never measured
	expect(byId.get('g1')).toBe(30);
	expect(byId.get('g2')).toBe(-25);
	expect(byId.get('g3')).toBe(0); // measured, aligned — distinct from null
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
	const byId = new Map(db.select().from(media).all().map((r) => [r.id, r.lyricsOverrideRef]));
	expect(byId.get('o0')).toBeNull(); // no override
	expect(byId.get('o1')).toBe('derived/lyrics/o1-manual-word.json');
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

// BLOCKING FIX — the EXISTING-database upgrade path. Every other test in this file builds a
// FRESH db (openDb + runMigrations), which is exactly the coverage gap that let an in-place baseline
// edit pass: a rewritten 0000 is never re-applied to a db that already ran it (Drizzle keys on the
// journal `when`, not the file hash), so `room_id` would never appear and boot hydrate() would throw.
// This test models the real upgrade: apply ONLY the baseline (a pre-0002 deployment), write the
// old-shape 'singleton' row, THEN run the full migration set so 0002 actually runs — and asserts the
// column arrives, the row is re-keyed onto the active room (not dropped), and persist/hydrate work.
test('an EXISTING singleton database upgrades — 0002 adds room_id and re-keys the row onto the active room', () => {
	const { db, sqlite } = openDb(':memory:');

	// Phase 1 — a pre-0002 box: apply ONLY 0000 (baseline), with real Drizzle bookkeeping, by pointing
	// the migrator at a temp folder that holds just the baseline + its snapshot + a one-entry journal.
	const real = DRIZZLE;
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
	// two rooms (the older is the active one ensureActive resolves to).
	sqlite.run(`INSERT INTO rooms (id, code, created_at) VALUES ('roomA','AAAAAA',1000)`);
	sqlite.run(`INSERT INTO rooms (id, code, created_at) VALUES ('roomB','BBBBBB',2000)`);
	sqlite.run(
		`INSERT INTO playback_state (id, current_entry_id, position_sec, is_playing, key_shift) VALUES ('singleton','qOLD',77,1,3)`
	);

	// Phase 2 — deploy 0002: run the FULL migration set. 0000+0001 already recorded, so only 0002 runs.
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

// BLOCKING FIX — the EXISTING-database upgrade path (the trap the earlier room-keying migrations warned about, and the
// one drizzle-kit's bare `ALTER TABLE ... ADD room_id NOT NULL` would fail on a DB with rows). Every
// other test builds a FRESH db; this models the real upgrade: apply migrations up to 0002 (a pre-0003
// box), write old-shape roomless queue + singer rows, THEN run the full set so 0003 actually runs —
// and asserts the columns arrive, the rows are RE-KEYED onto the active (oldest) room, and hydrate works.
test('an EXISTING roomless database upgrades — 0003 adds room_id to queue_entries + singers and re-keys rows onto the active room', () => {
	const { db, sqlite } = openDb(':memory:');

	// Phase 1 — a pre-0003 box: apply only 0000..0002 by pointing the migrator at a temp folder holding
	// just those files + their snapshots + a three-entry journal (the same idiom the 0002 upgrade test uses).
	const real = DRIZZLE;
	const baseDir = mkdtempSync(join(tmpdir(), 'encore-mig-656-'));
	mkdirSync(join(baseDir, 'meta'), { recursive: true });
	const priorTags = ['0000_baseline', '0001_add_job_attempts_selection', '0002_room_keyed_playback'];
	const fullJournal = JSON.parse(readFileSync(join(real, 'meta', '_journal.json'), 'utf8'));
	for (const e of fullJournal.entries as { idx: number; tag: string }[]) {
		if (!priorTags.includes(e.tag)) continue;
		cpSync(join(real, `${e.tag}.sql`), join(baseDir, `${e.tag}.sql`));
		cpSync(
			join(real, 'meta', `${String(e.idx).padStart(4, '0')}_snapshot.json`),
			join(baseDir, 'meta', `${String(e.idx).padStart(4, '0')}_snapshot.json`)
		);
	}
	const baseJournal = {
		...fullJournal,
		entries: fullJournal.entries.filter((e: { tag: string }) => priorTags.includes(e.tag))
	};
	writeFileSync(join(baseDir, 'meta', '_journal.json'), JSON.stringify(baseJournal));
	runMigrations(db, baseDir);

	// The old-shape data a running party would already hold: two rooms (older is the active one), plus a
	// roomless queue entry and a roomless singer — the deployment-wide shape before this migration.
	sqlite.run(`INSERT INTO rooms (id, code, created_at) VALUES ('roomA','AAAAAA',1000)`);
	sqlite.run(`INSERT INTO rooms (id, code, created_at) VALUES ('roomB','BBBBBB',2000)`);
	sqlite.run(
		`INSERT INTO singers (id, display_name, color, session_token, joined_at) VALUES ('sOLD','Maya','#fff','tokOLD',500)`
	);
	sqlite.run(
		`INSERT INTO queue_entries (id, media_id, singer_id, status, rotation_seq, added_at) VALUES ('qOLD','mOLD','sOLD','queued',0,500)`
	);

	// Phase 2 — deploy 0003: run the FULL migration set. 0000..0002 already recorded, so only 0003 runs.
	runMigrations(db, real);

	// The columns arrived (proving 0003 was actually applied, not skipped like an in-place baseline edit).
	const qCols = (sqlite.query(`PRAGMA table_info(queue_entries)`).all() as { name: string }[]).map((c) => c.name);
	const sCols = (sqlite.query(`PRAGMA table_info(singers)`).all() as { name: string }[]).map((c) => c.name);
	expect(qCols).toContain('room_id');
	expect(sCols).toContain('room_id');

	// The old rows were RE-KEYED onto the active (oldest) room, carrying their data — not dropped.
	const q = sqlite.query(`SELECT id, room_id, media_id, singer_id FROM queue_entries`).all() as {
		id: string;
		room_id: string;
		media_id: string;
		singer_id: string;
	}[];
	expect(q).toHaveLength(1);
	expect(q[0]!.id).toBe('qOLD');
	expect(q[0]!.room_id).toBe('roomA'); // the oldest room ensureActive() resolves to
	const sg = sqlite.query(`SELECT id, room_id, session_token FROM singers`).all() as {
		id: string;
		room_id: string;
		session_token: string;
	}[];
	expect(sg).toHaveLength(1);
	expect(sg[0]!.room_id).toBe('roomA');
	expect(sg[0]!.session_token).toBe('tokOLD'); // the unique index survived the table rebuild

	// The running code can now read that room's queue + roster through the real paths.
	expect(hydrate(db, 'roomA').entries.map((e) => e.id)).toEqual(['qOLD']);
	expect(hydrate(db, 'roomB').entries).toHaveLength(0);
	expect(new SingerRepository(db).listPublic('roomA').map((s) => s.id)).toEqual(['sOLD']);
	expect(new SingerRepository(db).listPublic('roomB')).toHaveLength(0);
});

// BLOCKING FIX -- the EXISTING-database upgrade path for room_settings. Before the active-room re-key every reader
// AND the writer route defaulted to DEFAULT_ROOM_ID ('main'), so a configured box wrote its
// room_settings row under 'main'. That change moved every reader (and the writer fallback) onto the active
// room -- a minted ULID, not 'main' -- so without a re-key an upgraded box would look up the active
// room, find no row, and silently serve defaults. This models the real upgrade: apply migrations up to
// 0003 (a pre-0004 box), write an old-shape 'main' room_settings row, THEN run the full set so 0004
// runs -- and asserts the row is RE-KEYED onto the active (oldest) room, carrying every value.
test('an EXISTING main-keyed database upgrades -- 0004 re-keys room_settings onto the active room', () => {
	const { db, sqlite } = openDb(':memory:');

	const real = DRIZZLE;
	const baseDir = mkdtempSync(join(tmpdir(), 'encore-mig-728-'));
	mkdirSync(join(baseDir, 'meta'), { recursive: true });
	const priorTags = [
		'0000_baseline',
		'0001_add_job_attempts_selection',
		'0002_room_keyed_playback',
		'0003_room_keyed_queue'
	];
	const fullJournal = JSON.parse(readFileSync(join(real, 'meta', '_journal.json'), 'utf8'));
	for (const e of fullJournal.entries as { idx: number; tag: string }[]) {
		if (!priorTags.includes(e.tag)) continue;
		cpSync(join(real, e.tag + '.sql'), join(baseDir, e.tag + '.sql'));
		cpSync(
			join(real, 'meta', String(e.idx).padStart(4, '0') + '_snapshot.json'),
			join(baseDir, 'meta', String(e.idx).padStart(4, '0') + '_snapshot.json')
		);
	}
	const baseJournal = {
		...fullJournal,
		entries: fullJournal.entries.filter((e: { tag: string }) => priorTags.includes(e.tag))
	};
	writeFileSync(join(baseDir, 'meta', '_journal.json'), JSON.stringify(baseJournal));
	runMigrations(db, baseDir);

	sqlite.run("INSERT INTO rooms (id, code, created_at) VALUES ('roomA','AAAAAA',1000)");
	sqlite.run("INSERT INTO rooms (id, code, created_at) VALUES ('roomB','BBBBBB',2000)");
	sqlite.run("INSERT INTO room_settings (room_id, song_intro_ms, presence_grace_minutes) VALUES ('main', 7000, 5)");

	runMigrations(db, real);

	const rows = sqlite.query('SELECT room_id, song_intro_ms, presence_grace_minutes FROM room_settings').all() as {
		room_id: string;
		song_intro_ms: number;
		presence_grace_minutes: number;
	}[];
	expect(rows).toHaveLength(1);
	expect(rows[0]!.room_id).toBe('roomA');
	expect(rows[0]!.song_intro_ms).toBe(7000);
	expect(rows[0]!.presence_grace_minutes).toBe(5);
	expect(rows.some((r) => r.room_id === 'main')).toBe(false);
});

// guard: a pre-rooms DB (a 'main' row but no rooms yet) has no active room to carry it onto, so
// the re-key is guarded off and the row stays put rather than being dropped or the migration throwing.
test('0004 leaves the main row untouched when no room exists yet (pre-rooms DB)', () => {
	const { db, sqlite } = openDb(':memory:');

	const real = DRIZZLE;
	const baseDir = mkdtempSync(join(tmpdir(), 'encore-mig-728b-'));
	mkdirSync(join(baseDir, 'meta'), { recursive: true });
	const priorTags = [
		'0000_baseline',
		'0001_add_job_attempts_selection',
		'0002_room_keyed_playback',
		'0003_room_keyed_queue'
	];
	const fullJournal = JSON.parse(readFileSync(join(real, 'meta', '_journal.json'), 'utf8'));
	for (const e of fullJournal.entries as { idx: number; tag: string }[]) {
		if (!priorTags.includes(e.tag)) continue;
		cpSync(join(real, e.tag + '.sql'), join(baseDir, e.tag + '.sql'));
		cpSync(
			join(real, 'meta', String(e.idx).padStart(4, '0') + '_snapshot.json'),
			join(baseDir, 'meta', String(e.idx).padStart(4, '0') + '_snapshot.json')
		);
	}
	const baseJournal = {
		...fullJournal,
		entries: fullJournal.entries.filter((e: { tag: string }) => priorTags.includes(e.tag))
	};
	writeFileSync(join(baseDir, 'meta', '_journal.json'), JSON.stringify(baseJournal));
	runMigrations(db, baseDir);

	// a stray 'main' row and NO rooms row (pre-rooms shape)
	sqlite.run("INSERT INTO room_settings (room_id, song_intro_ms) VALUES ('main', 7000)");

	// deploy the re-key: only 0004 runs, but with no room its guard drops the UPDATE.
	runMigrations(db, real);

	const rows = sqlite.query('SELECT room_id, song_intro_ms FROM room_settings').all() as {
		room_id: string;
		song_intro_ms: number;
	}[];
	expect(rows).toHaveLength(1);
	expect(rows[0]!.room_id).toBe('main');
	expect(rows[0]!.song_intro_ms).toBe(7000);
});

// — the EXISTING-database upgrade path for `tv_background_hue` → `tv_background_color`. Every
// other test in this file that touches room_settings builds a FRESH db, which is exactly the coverage
// gap that lets an in-place baseline edit pass: a rewritten 0000 is never re-applied to a db that
// already ran it (drizzle keys on the journal `when`, not the file hash), so the new column would never
// appear and the first `getRoom()` would throw at boot. Two earlier migrations each shipped that. This models the
// real upgrade: apply only 0000..0004 (a pre-0005 box), write old-shape rows carrying INTEGER hues, THEN
// run the full set so 0005 actually runs.
//
// What it has to prove is the party keeping its look across the upgrade, not merely that a column
// arrived: each row's stored hue must land on the colour that hue was ALREADY rendering as, which is
// `stageHueToHex(hue)`. Those expectations are computed from the shared function rather than transcribed
// here, so the test cannot agree with a wrong migration by copying the same wrong literals — the exact
// derive-your-own-expectation trap that has let a defect ship here before.
test('an EXISTING hue database upgrades — 0005 replaces tv_background_hue with the colour that hue rendered as', () => {
	const { db, sqlite } = openDb(':memory:');

	const real = DRIZZLE;
	const baseDir = mkdtempSync(join(tmpdir(), 'encore-mig-425-'));
	mkdirSync(join(baseDir, 'meta'), { recursive: true });
	const priorTags = [
		'0000_baseline',
		'0001_add_job_attempts_selection',
		'0002_room_keyed_playback',
		'0003_room_keyed_queue',
		'0004_rekey_room_settings'
	];
	const fullJournal = JSON.parse(readFileSync(join(real, 'meta', '_journal.json'), 'utf8'));
	for (const e of fullJournal.entries as { idx: number; tag: string }[]) {
		if (!priorTags.includes(e.tag)) continue;
		cpSync(join(real, e.tag + '.sql'), join(baseDir, e.tag + '.sql'));
		cpSync(
			join(real, 'meta', String(e.idx).padStart(4, '0') + '_snapshot.json'),
			join(baseDir, 'meta', String(e.idx).padStart(4, '0') + '_snapshot.json')
		);
	}
	const baseJournal = {
		...fullJournal,
		entries: fullJournal.entries.filter((e: { tag: string }) => priorTags.includes(e.tag))
	};
	writeFileSync(join(baseDir, 'meta', '_journal.json'), JSON.stringify(baseJournal));
	runMigrations(db, baseDir);

	// Sanity: this really IS the old shape, so the test cannot pass by having skipped phase 1.
	const before = sqlite.query('PRAGMA table_info(room_settings)').all() as { name: string }[];
	expect(before.some((c) => c.name === 'tv_background_hue')).toBe(true);
	expect(before.some((c) => c.name === 'tv_background_color')).toBe(false);

	// Three configured rooms a running party would already hold: a room on the untouched default, one on
	// a hue inside the accent2 guard band (where the tier's lightness ramp bites, so its colour is NOT
	// simply the flat tier), and one at a stop far from it.
	sqlite.run("INSERT INTO rooms (id, code, created_at) VALUES ('roomA','AAAAAA',1000)");
	sqlite.run("INSERT INTO rooms (id, code, created_at) VALUES ('roomB','BBBBBB',2000)");
	sqlite.run("INSERT INTO rooms (id, code, created_at) VALUES ('roomC','CCCCCC',3000)");
	sqlite.run(
		"INSERT INTO room_settings (room_id, tv_background_style, tv_background_hue) VALUES ('roomA','solid',240)"
	);
	sqlite.run(
		"INSERT INTO room_settings (room_id, tv_background_style, tv_background_hue) VALUES ('roomB','solid',345)"
	);
	sqlite.run(
		"INSERT INTO room_settings (room_id, tv_background_style, tv_background_hue, song_intro_ms) VALUES ('roomC','visualizer',120,7000)"
	);

	// Deploy 0005: 0000..0004 are already recorded, so only 0005 runs.
	runMigrations(db, real);

	// The column swap actually happened — proving 0005 was applied rather than skipped the way an
	// in-place baseline edit would have been.
	const after = sqlite.query('PRAGMA table_info(room_settings)').all() as { name: string }[];
	expect(after.some((c) => c.name === 'tv_background_color')).toBe(true);
	expect(after.some((c) => c.name === 'tv_background_hue')).toBe(false);

	// Every room still shows the colour it was showing before the upgrade.
	const rows = sqlite
		.query(
			'SELECT room_id, tv_background_style, tv_background_color, song_intro_ms FROM room_settings ORDER BY room_id'
		)
		.all() as {
		room_id: string;
		tv_background_style: string;
		tv_background_color: string;
		song_intro_ms: number;
	}[];
	expect(rows.map((r) => r.room_id)).toEqual(['roomA', 'roomB', 'roomC']);
	expect(rows[0]!.tv_background_color).toBe(stageHueToHex(240));
	expect(rows[1]!.tv_background_color).toBe(stageHueToHex(345));
	expect(rows[2]!.tv_background_color).toBe(stageHueToHex(120));
	// non-vacuous: the three colours are genuinely different, so a migration that wrote one constant
	// everywhere (the plausible bug) could not pass the three assertions above.
	expect(new Set(rows.map((r) => r.tv_background_color)).size).toBe(3);
	// the guard band really is exercised — roomB's hue sits ON accent2, so its colour is the ramped one
	expect(stageHueToHex(345)).not.toBe(hueToHex(345, STAGE_BG_L, STAGE_BG_C));
	// and unrelated columns are untouched by the swap
	expect(rows[2]!.tv_background_style).toBe('visualizer');
	expect(rows[2]!.song_intro_ms).toBe(7000);

	// The running code can now read those rooms through the real path — the thing that threw on the
	// earlier room-keying upgrade.
	const repo = new SettingsRepository(db);
	expect(repo.getRoom('roomA').tvBackgroundColor).toBe(stageHueToHex(240));
	expect(repo.getRoom('roomB').tvBackgroundColor).toBe(stageHueToHex(345));
	expect(repo.getRoom('roomC').tvBackgroundStyle).toBe('visualizer');
});

// companion: a hand-edited DB holding an OFF-STEP hue has no colour to carry, so it must land on
// the default rather than on NULL — the column is NOT NULL, so there is no third outcome, and silently
// defaulting an illegal value is what the settings validator already does with one. Split from the test
// above because this exercises the CASE's ELSE arm, which the 24 legal values never reach.
test('0005 defaults an off-step or out-of-range hue instead of leaving it unmapped', () => {
	const { db, sqlite } = openDb(':memory:');

	const real = DRIZZLE;
	const baseDir = mkdtempSync(join(tmpdir(), 'encore-mig-425b-'));
	mkdirSync(join(baseDir, 'meta'), { recursive: true });
	const priorTags = [
		'0000_baseline',
		'0001_add_job_attempts_selection',
		'0002_room_keyed_playback',
		'0003_room_keyed_queue',
		'0004_rekey_room_settings'
	];
	const fullJournal = JSON.parse(readFileSync(join(real, 'meta', '_journal.json'), 'utf8'));
	for (const e of fullJournal.entries as { idx: number; tag: string }[]) {
		if (!priorTags.includes(e.tag)) continue;
		cpSync(join(real, e.tag + '.sql'), join(baseDir, e.tag + '.sql'));
		cpSync(
			join(real, 'meta', String(e.idx).padStart(4, '0') + '_snapshot.json'),
			join(baseDir, 'meta', String(e.idx).padStart(4, '0') + '_snapshot.json')
		);
	}
	const baseJournal = {
		...fullJournal,
		entries: fullJournal.entries.filter((e: { tag: string }) => priorTags.includes(e.tag))
	};
	writeFileSync(join(baseDir, 'meta', '_journal.json'), JSON.stringify(baseJournal));
	runMigrations(db, baseDir);

	sqlite.run("INSERT INTO rooms (id, code, created_at) VALUES ('roomA','AAAAAA',1000)");
	// 7 is not a wheel stop; 999 is out of range. Neither can be produced by the validator, only by hand.
	sqlite.run("INSERT INTO room_settings (room_id, tv_background_hue) VALUES ('roomA',7)");
	sqlite.run("INSERT INTO room_settings (room_id, tv_background_hue) VALUES ('roomZ',999)");

	runMigrations(db, real);

	const rows = sqlite.query('SELECT room_id, tv_background_color FROM room_settings ORDER BY room_id').all() as {
		room_id: string;
		tv_background_color: string;
	}[];
	expect(rows).toHaveLength(2);
	for (const r of rows) {
		expect(r.tv_background_color).toBe(DEFAULT_STAGE_COLOR);
		expect(r.tv_background_color).not.toBeNull();
	}
});

// advisory: the 0005 migration's CASE backfills each of the 24 legal stored hues to the colour
// `stageHueToHex` renders it as, transcribed as literals because SQL cannot run OKLCH. The migration
// comment claims "a guard test asserts each of these 24 pairs still equals stageHueToHex(hue)" — this
// IS that guard. It parses every `WHEN <hue> THEN '<hex>'` arm out of the .sql and re-derives each
// with stageHueToHex, so a change to the stage tier that leaves the migration behind reds here rather
// than silently shipping a wrong backfill on the 23 rows the upgrade test does not spot-check.
test('every WHEN arm of the 0005 backfill CASE equals stageHueToHex(hue)', () => {
	const sql = read('drizzle/0005_tv_background_color.sql');
	const arms = [...sql.matchAll(/WHEN\s+(\d+)\s+THEN\s+'(#[0-9a-fA-F]{6})'/g)].map((m) => ({
		hue: Number(m[1]),
		hex: m[2]!.toLowerCase()
	}));
	// The wheel has exactly 24 stops (360 / SINGER_HUE_STEP), so the CASE must carry all 24 — no more,
	// no fewer — or a legal stored hue would fall through to the ELSE default instead of its colour.
	expect(arms.length).toBe(24);
	for (const { hue, hex } of arms) {
		expect(hex).toBe(stageHueToHex(hue));
	}
	// And the default the ELSE arm and the column both use is hue 240's colour, byte-identical.
	expect(sql).toContain("ELSE '#001d31'");
	expect(DEFAULT_STAGE_COLOR).toBe(stageHueToHex(240));
});

// — the EXISTING-database upgrade path for the stage dimmer. Piece 3 of the stage-background work adds
// room_settings.tv_background_dim (a 0..1 REAL, NOT NULL default 0). Every other room_settings test
// builds a FRESH db, the coverage gap that lets an in-place baseline edit pass; this models the real
// upgrade: apply only 0000..0006 (a pre-0007 box), write old-shape rows with NO dim column, THEN run
// the full set so 0007 actually runs. What it must prove: the column arrives, an existing row upgrades
// to 0 (no dim — today's look, byte-identical), and the running code can read it back through the real
// path. RED on base: no 0007, so tv_background_dim is absent and the SELECT below throws.
test('an EXISTING database upgrades — 0007 adds tv_background_dim defaulting to 0 (no dim)', () => {
	const { db, sqlite } = openDb(':memory:');

	const real = DRIZZLE;
	const baseDir = mkdtempSync(join(tmpdir(), 'encore-mig-782-'));
	mkdirSync(join(baseDir, 'meta'), { recursive: true });
	const priorTags = [
		'0000_baseline',
		'0001_add_job_attempts_selection',
		'0002_room_keyed_playback',
		'0003_room_keyed_queue',
		'0004_rekey_room_settings',
		'0005_tv_background_color',
		'0006_add_guide_offset_ms'
	];
	const fullJournal = JSON.parse(readFileSync(join(real, 'meta', '_journal.json'), 'utf8'));
	for (const e of fullJournal.entries as { idx: number; tag: string }[]) {
		if (!priorTags.includes(e.tag)) continue;
		cpSync(join(real, e.tag + '.sql'), join(baseDir, e.tag + '.sql'));
		cpSync(
			join(real, 'meta', String(e.idx).padStart(4, '0') + '_snapshot.json'),
			join(baseDir, 'meta', String(e.idx).padStart(4, '0') + '_snapshot.json')
		);
	}
	const baseJournal = {
		...fullJournal,
		entries: fullJournal.entries.filter((e: { tag: string }) => priorTags.includes(e.tag))
	};
	writeFileSync(join(baseDir, 'meta', '_journal.json'), JSON.stringify(baseJournal));
	runMigrations(db, baseDir);

	// Sanity: this really IS the pre-0007 shape, so the test cannot pass by having skipped phase 1.
	const before = sqlite.query('PRAGMA table_info(room_settings)').all() as { name: string }[];
	expect(before.some((c) => c.name === 'tv_background_color')).toBe(true);
	expect(before.some((c) => c.name === 'tv_background_dim')).toBe(false);

	// Two configured rooms a running party would already hold — a solid stage and a visualizer one, each
	// carrying a colour but of course no dim, since the column does not exist yet.
	sqlite.run("INSERT INTO rooms (id, code, created_at) VALUES ('roomA','AAAAAA',1000)");
	sqlite.run("INSERT INTO rooms (id, code, created_at) VALUES ('roomB','BBBBBB',2000)");
	sqlite.run(
		"INSERT INTO room_settings (room_id, tv_background_style, tv_background_color) VALUES ('roomA','solid','#ffffff')"
	);
	sqlite.run(
		"INSERT INTO room_settings (room_id, tv_background_style, tv_background_color, song_intro_ms) VALUES ('roomB','visualizer','#281600',7000)"
	);

	// Deploy 0007: 0000..0006 are already recorded, so only 0007 runs.
	runMigrations(db, real);

	// The column arrived — proving 0007 was applied, not skipped the way an in-place baseline edit would be.
	const after = sqlite.query('PRAGMA table_info(room_settings)').all() as { name: string }[];
	expect(after.some((c) => c.name === 'tv_background_dim')).toBe(true);

	// Every existing row upgraded to no dim (0), and unrelated columns are untouched by the add.
	const rows = sqlite
		.query('SELECT room_id, tv_background_dim, tv_background_color, song_intro_ms FROM room_settings ORDER BY room_id')
		.all() as { room_id: string; tv_background_dim: number; tv_background_color: string; song_intro_ms: number }[];
	expect(rows.map((r) => r.room_id)).toEqual(['roomA', 'roomB']);
	expect(rows[0]!.tv_background_dim).toBe(0);
	expect(rows[1]!.tv_background_dim).toBe(0);
	expect(rows[0]!.tv_background_color).toBe('#ffffff');
	expect(rows[1]!.tv_background_color).toBe('#281600');
	expect(rows[1]!.song_intro_ms).toBe(7000);

	// The running code can now read those rooms through the real path, and a fresh write of a real dim
	// round-trips — proving getRoom's SELECT and setRoom's write both carry the new field end to end.
	const repo = new SettingsRepository(db);
	expect(repo.getRoom('roomA').tvBackgroundDim).toBe(0);
	expect(repo.setRoom({ tvBackgroundDim: 0.5 }, 'roomA').tvBackgroundDim).toBe(0.5);
	expect(repo.getRoom('roomA').tvBackgroundDim).toBe(0.5);
});
