// #317 — what queue_entries ACTUALLY rejects at the write-behind flush, measured, so the add-arm
// guard's rationale (hub.ts) can never regress back to "the NOT NULL enum column rejects it".
//
// The add-arm guard added by #305 is correct and stays. Its old comment credited the column's
// constraints with rejecting off-enum/non-finite values. That is measurably false: `queue_entries`
// has NO CHECK constraint on `status` (drizzle's `enum:` is compile-time only) and stores a garbage
// `addedAt` past the NOT NULL check — only a MISSING/null value throws. So the guard, not the
// column, is the only thing keeping the value set honest. This test drives real values into a real
// migrated DB to pin that split, and source-scans the corrected comments so the belief cannot creep
// back in (the hazard §3 of the review charter names: a credible-sounding rationale read as fact).
import { test, expect } from 'bun:test';
import { migratedDb } from '../db/test-db';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rooms, singers, media, queueEntries } from '../db/schema';

// A migrated in-memory DB seeded with the FK parents a queue_entries row needs.
function seededDb() {
	const db = migratedDb();
	const now = 1_700_000_000_000;
	db.insert(rooms).values({ id: 'r1', code: 'PARTY', createdAt: now }).run();
	db.insert(singers)
		.values({ id: 's1', displayName: 'Maya', color: '#fff', sessionToken: 'tok', joinedAt: now, roomId: 'r1' })
		.run();
	db.insert(media)
		.values({ id: 'm1', source: 'youtube', sourceRef: 'x', title: 't', durationSec: 100, stemStatus: 'none' })
		.run();
	return db;
}

// Insert one queue_entries row exactly as the write-behind flush would (persistence.ts), with the
// one field under test overridden. Returns 'throw' or the persisted row.
function persist(
	db: ReturnType<typeof seededDb>,
	over: Record<string, unknown>
): { threw: boolean; row: Record<string, unknown> | null } {
	const base = {
		id: 'q1',
		mediaId: 'm1',
		singerId: 's1',
		status: 'queued',
		rotationSeq: 0,
		addedAt: 1,
		roomId: 'r1',
		...over
	};
	try {
		db.insert(queueEntries)
			.values(base as never)
			.run();
	} catch {
		return { threw: true, row: null };
	}
	const row = (db.select().from(queueEntries).all()[0] ?? null) as Record<string, unknown> | null;
	return { threw: false, row };
}

test('the column enforces NOT NULL alone — never the enum, never finiteness (and a missing status DEFAULTs, not throws)', () => {
	// THE THREE THAT CRASH — all by NOT NULL, none by the enum, none by finiteness.
	expect(persist(seededDb(), { addedAt: NaN }).threw).toBe(true);
	expect(persist(seededDb(), { addedAt: undefined }).threw).toBe(true);
	expect(persist(seededDb(), { status: null }).threw).toBe(true);

	// THE THREE THAT PERSIST SILENTLY — the belief the old comment got wrong.
	// Infinity: representable-but-garbage addedAt, coerced past NOT NULL (no throw).
	const inf = persist(seededDb(), { addedAt: Infinity });
	expect(inf.threw).toBe(false);
	// off-enum status: no CHECK constraint, stored VERBATIM.
	const obl = persist(seededDb(), { status: 'obliterated' });
	expect(obl.threw).toBe(false);
	expect(obl.row?.status).toBe('obliterated');
	// undefined status: key omitted, column DEFAULT 'queued' applies (no throw).
	const undef = persist(seededDb(), { status: undefined });
	expect(undef.threw).toBe(false);
	expect(undef.row?.status).toBe('queued');
});

test('the migrated status column has NO CHECK constraint (drizzle enum is compile-time only)', () => {
	const db = seededDb();
	// bun:sqlite: read the table DDL back from sqlite_master and prove there is no CHECK on it.
	const ddl = String(
		(db as unknown as { $client: { query: (s: string) => { get: () => { sql?: string } } } }).$client
			.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='queue_entries'")
			.get()?.sql ?? ''
	);
	expect(ddl.length).toBeGreaterThan(0);
	expect(ddl).toContain('`status`');
	expect(ddl.toUpperCase()).not.toContain('CHECK');
});

// SOURCE SCAN: the corrected rationale is the subject here, so read hub.ts RAW. This pins the
// comment-only production change: reverting either corrected clause reds a named test.
test('hub.ts states the measured mechanism, not the false "enum column rejects it" account', () => {
	const src = readFileSync(join(import.meta.dir, 'hub.ts'), 'utf8');
	// The header block no longer calls the column an enforcing enum, and names it the VALUE LIST source.
	expect(src).toContain('single source of truth for the entry-status VALUE LIST');
	expect(src).toContain('NOT an enforcing enum at runtime');
	expect(src).toMatch(/no\s+CHECK\s+constraint/);
	// The guard block states the split: NOT NULL is the discriminator; off-enum/Infinity persist.
	expect(src).toMatch(/NOT NULL alone — never an enum, never finiteness/);
	expect(src).toContain('persist SILENTLY');
	// And it must NOT reassert the exact false framing the issue flagged.
	expect(src).not.toContain('the NOT NULL enum column an add');
});

// #395 — since #324 the add-arm's ALLOWED set is the bare literal 'queued', NOT derived from the
// column's enumValues; the enumValues import survives only to pick a word ('server-owned' vs
// 'off-enum') in the reject-log string. The #317 header rewrite left one clause generalising the
// classification read into the ALLOWED set ("its enumValues ... allowed set can never drift from the
// column"), which is the false account this pins against. The guard both BANS that false framing and
// affirmatively requires the corrected mechanism, so deleting the header cannot pass vacuously.
test('#395: hub.ts header credits the literal, not enumValues, as the add-arm allowed set', () => {
	const src = readFileSync(join(import.meta.dir, 'hub.ts'), 'utf8');
	// FALSE framing the issue flagged: enumValues defining the allowed set / unable to drift from the column.
	expect(src).not.toContain('allowed set can never drift from the column');
	// AFFIRMATIVE: the header must name the real allowed set (the single literal 'queued') and scope
	// the enumValues read to CLASSIFY-only — so the corrected account is present, not merely the
	// false one absent.
	expect(src).toContain("allowed set is the single literal 'queued'");
	expect(src).toMatch(/enumValues are read below ONLY to CLASSIFY/);
});
