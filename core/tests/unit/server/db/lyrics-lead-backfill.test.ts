// Done-when: a room that existed BEFORE `0001_lyrics_lead_default` reads the measured 40 ms display lead
// after the upgrade, and a room that chose its own lead keeps it.
//
// WHY THIS GUARD EXISTS (W5 review r1-spec-15 / r1-tests-18). The migration changed only the COLUMN DEFAULT,
// and nothing reads a column default at runtime: `SettingsRepository.setRoom` writes every column on every
// save, and `getRoom` returns the stored row verbatim (`normalizeRoomSettings` treats 0 as a valid value, not
// a missing one). So every room that had ever touched a TV or lyrics setting held `lyrics_lead_ms = 0` — the
// OLD default — and kept rendering at an effective lead of zero, while `DEFAULT_LYRICS_LEAD_MS`' docstring and
// docs/FRONTEND.md describe 40 ms as what a real TV runs with. The whole measured gain (73.2% -> 78.6% of
// published word onsets inside ITU-R BT.1359's asymmetric band) reached only rooms created afterwards, with
// two rooms on one install rendering differently and nothing saying why. `0001` carries the backfill now.
//
// STAGED IN TWO RUNS, because that is the only shape in which the bug exists: the baseline alone, then a row,
// then the real folder. A single `runMigrations` creates the table with the new default and proves nothing.
// The staged folder is a COPY of the repo's own `0000_baseline.sql` and a journal holding just its entry, so
// the SQL under test is the shipped file rather than a hand-written imitation of it.
import { test, expect } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '$lib/server/db/index';
import { runMigrations } from '$lib/server/db/migrate';
import { SettingsRepository } from '$lib/server/state/settings-repository';
import { DEFAULT_LYRICS_LEAD_MS } from '$lib/contract';

const DRIZZLE = join(import.meta.dir, '..', '..', '..', '..', 'drizzle');

/** A migrations folder holding the baseline and nothing else: the tree as it stood before W5. */
function baselineOnly(): string {
	const dir = mkdtempSync(join(tmpdir(), 'encore-drizzle-'));
	mkdirSync(join(dir, 'meta'), { recursive: true });
	copyFileSync(join(DRIZZLE, '0000_baseline.sql'), join(dir, '0000_baseline.sql'));
	const journal = JSON.parse(readFileSync(join(DRIZZLE, 'meta', '_journal.json'), 'utf8')) as {
		entries: { tag: string }[];
	};
	journal.entries = journal.entries.filter((e) => e.tag === '0000_baseline');
	expect(journal.entries.length, 'the baseline entry must be found by tag').toBe(1);
	writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(journal));
	return dir;
}

test('a room saved before the migration gets the measured display lead, and a chosen lead survives', () => {
	const { db, sqlite } = openDb(':memory:');
	runMigrations(db, baselineOnly());

	// Two pre-upgrade rooms: one at the old default (which is also what a deliberate 0 looked like, and the
	// reason the backfill is defensible only in the pre-release window), one with a lead someone picked.
	sqlite.exec("INSERT INTO room_settings (room_id, lyrics_lead_ms) VALUES ('old-default', 0)");
	sqlite.exec("INSERT INTO room_settings (room_id, lyrics_lead_ms) VALUES ('chose-120', 120)");
	const before = new SettingsRepository(db);
	expect(before.getRoom('old-default').lyricsLeadMs).toBe(0);

	runMigrations(db, DRIZZLE);

	const after = new SettingsRepository(db);
	expect(
		after.getRoom('old-default').lyricsLeadMs,
		'an existing room must not be left at an effective lead of zero while the docs claim 40 ms'
	).toBe(DEFAULT_LYRICS_LEAD_MS);
	expect(after.getRoom('chose-120').lyricsLeadMs, 'a backfill may not overwrite a choice').toBe(120);
	// The rest of the row survived the table rebuild the default change costs in SQLite.
	expect(after.getRoom('chose-120').lyricsHighlight).toBe('word');
});

test('a room created after the migration resolves to the same default', () => {
	const { db } = openDb(':memory:');
	runMigrations(db, DRIZZLE);
	const settings = new SettingsRepository(db);

	expect(settings.getRoom('fresh').lyricsLeadMs).toBe(DEFAULT_LYRICS_LEAD_MS);
	expect(settings.setRoom({ lyricsScalePct: 110 }, 'fresh').lyricsLeadMs).toBe(DEFAULT_LYRICS_LEAD_MS);
});
