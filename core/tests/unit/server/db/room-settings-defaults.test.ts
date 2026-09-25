// Done-when: every `room_settings` column default equals the contract default for the same field, so the two
// cannot drift apart again.
//
// WHY THIS GUARD EXISTS. Every column in the table carries a `.default()`, and NONE of them is reachable at
// runtime: `SettingsRepository.setRoom` inserts `.values({ roomId, ...next })` where `next` is a fully
// normalised `RoomSettings`, so every column is named on every write, and a room with no row at all resolves
// through `DEFAULT_ROOM_SETTINGS` in `getRoom` rather than through the DDL. The defaults are therefore
// belt-and-braces for a hand-written INSERT or a future migration that backfills a row — worth keeping, and
// worth keeping HONEST, because an unreachable value is exactly the kind that rots unnoticed.
//
// AND IT DID ROT. Two had drifted: `lyrics_lead_ms` said 300 while `DEFAULT_LYRICS_LEAD_MS` is 0, and
// `tv_progress_style` said 'card' while the contract says 'edge'. The lead one cost real time — a fuzz driver
// read the wrong path for the setting, fell back to a hardcoded 0.3, and the stale 300 in this file made that
// number look corroborated rather than wrong, so I4's window ran 300ms off-centre. See the note in
// tests/playwright/specs/flow/fuzz.spec.ts.
//
// READS THE COLUMN OBJECTS, not the generated SQL and not a hand-copied list: a list would be a third place to
// forget. `maxQualityRank` is the one field whose contract default is `null` and whose column declares no
// default at all, which reads back as `undefined` — the same absence, spelled two ways, so it is treated as
// agreement rather than special-cased away.
import { test, expect } from 'bun:test';
import { roomSettings } from '$lib/server/db/schema';
import { DEFAULT_ROOM_SETTINGS } from '$lib/contract';

/** Drizzle's column builders expose the declared default on the built column; untyped, so narrowed here. */
type Col = { name: string; default?: unknown; hasDefault?: boolean };
const columns = roomSettings as unknown as Record<string, Col | undefined>;

test('every room_settings column default equals its contract default', () => {
	const mismatches: string[] = [];
	for (const [field, want] of Object.entries(DEFAULT_ROOM_SETTINGS)) {
		const col = columns[field];
		if (!col) {
			mismatches.push(`${field}: no such column`);
			continue;
		}
		const got = col.default;
		// A contract `null` against a column with no `.default()` is the same absence spelled two ways.
		const agrees = got === want || (want === null && got === undefined);
		if (!agrees) mismatches.push(`${field}: column=${JSON.stringify(got)} contract=${JSON.stringify(want)}`);
	}
	expect(
		mismatches,
		'a `room_settings` default disagrees with DEFAULT_ROOM_SETTINGS. The contract is the source of truth — ' +
			'change the column to match it and run `bun --bun drizzle-kit generate`, never the reverse, because ' +
			'nothing reads the column default at runtime and the contract is what a fresh room actually resolves to'
	).toEqual([]);
});

test('the table covers every contract field, so a new setting cannot be persisted nowhere', () => {
	const missing = Object.keys(DEFAULT_ROOM_SETTINGS).filter((f) => !columns[f]);
	expect(missing, 'a RoomSettings field has no column in `room_settings`').toEqual([]);
});

test('the guard is not vacuous: it compares a real, non-trivial set of fields', () => {
	// Cheap protection against a future refactor that empties DEFAULT_ROOM_SETTINGS or renames the export into
	// something this file imports as `{}` — both would make the assertions above pass over nothing.
	expect(Object.keys(DEFAULT_ROOM_SETTINGS).length).toBeGreaterThanOrEqual(20);
	expect(columns.lyricsLeadMs?.default).toBe(DEFAULT_ROOM_SETTINGS.lyricsLeadMs);
});
