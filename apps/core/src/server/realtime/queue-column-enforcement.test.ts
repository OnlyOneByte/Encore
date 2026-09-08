// #317 — what queue_entries ACTUALLY rejects at the write-behind flush, measured, so the add-arm
// guard's rationale (hub.ts) can never regress back to "the NOT NULL enum column rejects it".
//
// The add-arm guard added by #305 is correct and stays. Its old comment credited the column's
// constraints with rejecting off-enum/non-finite values. That is measurably false: `queue_entries`
// has NO CHECK constraint on `status` (drizzle's `enum:` is compile-time only) and stores a garbage
// `addedAt` past the NOT NULL check — only a MISSING/null value throws. So for STATUS the guard, not
// the column, is the only thing keeping the value set honest. addedAt is a different case since #345
// (5acf86d): the server re-stamps every add's addedAt at the applyQueueOp seam, so the guard's
// finiteness reject on it is a SHAPE reject, not the last line of defence against persisting garbage.
// This test drives real values into a real migrated DB to pin the column split, source-scans the
// corrected comments so the belief cannot creep back in (the hazard §3 of the review charter names: a
// credible-sounding rationale read as fact), and pins which client-minted add fields the server owns.
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
		// The flush always binds this key (persistence.ts:38 `pinnedSeq: e.pinnedSeq ?? null`), so an
		// omitted pin reaches the column as an explicit NULL rather than as `undefined`. Setting it in
		// `base` is what lets the pinned_seq arm below override it with one value per row.
		pinnedSeq: null,
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

// #706 — the add-arm rationale must name EVERY field the code server-owns at the add seam. Since #345
// (5acf86d) the seam `{ ...cmd.op.entry, addedAt: deps.state.nextAddedAt() }` re-stamps addedAt, so
// the server owns rotationSeq AND addedAt; the old prose said only rotationSeq. This arm reads hub.ts,
// extracts the fields the CODE rewrites at the seam, extracts the fields the PROSE declares
// server-owned, and asserts code ⊆ prose — self-extending, since a third rewritten field reds it too.
//
// Comment stripping is INVERTED here on purpose: the defect lives in the PROSE, so the code side is
// stripped of comments (to read only what the seam literal actually rewrites) while the prose side is
// read AS comments. In-repo precedent for the inversion: routes/api/leave/doc-accuracy.test.ts and
// lib/tv/pitch-shift-doc-accuracy.test.ts (#567/#581/#622). Stripping is load-bearing: `addedAt`
// occurs many times raw but only once in the seam literal, so a whole-file scan would read it as
// "named" from prose alone.
test('#706: hub.ts prose names every field the add seam server-owns (rotationSeq AND addedAt)', () => {
	const src = readFileSync(join(import.meta.dir, 'hub.ts'), 'utf8');

	// Strip line comments so the CODE side reads only executable text.
	const codeOnly = src
		.split('\n')
		.map((l) => l.replace(/\/\/.*$/, ''))
		.join('\n');

	// SENTINEL 1: the seam and its inputs are present, so this never passes by losing its anchor.
	expect(codeOnly).toContain('nextAddedAt()');
	expect(codeOnly).toMatch(/handleQueueCommand/);

	// Extract fields rewritten at the add seam: the `...cmd.op.entry, <field>: ...` object literal.
	const seam = codeOnly.match(/\{\s*op:\s*'add',\s*entry:\s*\{\s*\.\.\.cmd\.op\.entry\s*,([\s\S]*?)\}\s*\}/);
	expect(seam).not.toBeNull();
	const rewritten = [...seam![1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1]);
	// SENTINEL 3 (load-bearing stripping): the seam literal names addedAt exactly, from CODE.
	expect(rewritten).toContain('addedAt');
	// rotationSeq is server-owned via applyOp (not at this literal); union it in for the subset check.
	const codeServerOwned = new Set([...rewritten, 'rotationSeq']);

	// Extract fields the PROSE declares server-owned. Read comment lines only.
	const prose = src
		.split('\n')
		.filter((l) => /^\s*\/\//.test(l))
		.join('\n');
	// SENTINEL 2: the prose still names rotationSeq, so deleting the server-owned clause reds. The
	// subset loop below asserts it is present as a server-owned field; this only anchors the token.
	expect(prose).toContain('rotationSeq');
	// The corrected prose must declare addedAt server-owned too (this is the red-on-base assertion).
	expect(prose).toMatch(/addedAt[^\n]{0,80}(re-?stamp|server-?own|nextAddedAt)/i);

	// code ⊆ prose: every field the seam server-owns is named by the prose as server-owned.
	for (const field of codeServerOwned) {
		expect(prose).toContain(field);
	}
});

// #706 ARM 2: since addedAt is re-stamped, the prose must NOT reassert that the finiteness reject is
// the ONLY thing keeping a garbage addedAt out of the queue. Base FAILS (the old clause says exactly
// that); fix PASSES (narrowed to a shape reject).
test('#706: hub.ts no longer calls the addedAt reject the last line of defence', () => {
	const src = readFileSync(join(import.meta.dir, 'hub.ts'), 'utf8');
	expect(src).not.toMatch(/ONLY thing keeping[\s\S]{0,140}addedAt out of the queue/);
});

// #738 — pinned_seq is the THIRD field to run through this file's loud/silent taxonomy, and the first
// one the production rationale sorted wrongly. `#724`'s guard is correct and stays; its comment put
// NaN/Infinity/a float in the LOUD "crashes the flush" class, and all three are measurably in the
// SILENT "persists past the column" class. The discriminator at the flush is BINDABILITY, not
// number-ness and not integer-ness: `pinned_seq` is `integer` and NULLABLE with no CHECK
// (schema.ts:175), so NaN binding to NULL violates nothing — which is exactly why it does not throw
// where a NULL `added_at`/`status` does. `pinned_seq` had no row in the table above, which is how the
// belief re-entered the file immediately below the clauses #317/#395/#706 were filed to correct.
//
// ARM 1 (this test) is the ANCHOR: green on base and after. It is what stops the belief returning a
// fourth time, by measuring the split instead of describing it.
test('#738: pinned_seq crashes the flush ONLY on an unbindable shape — NaN/Infinity/a float persist silently', () => {
	// THE CRASH CLASS — bun:sqlite refuses the bind itself. Nothing to do with number-ness.
	expect(persist(seededDb(), { pinnedSeq: {} }).threw).toBe(true);
	expect(persist(seededDb(), { pinnedSeq: [] }).threw).toBe(true);
	expect(persist(seededDb(), { pinnedSeq: [1] }).threw).toBe(true);

	// THE SILENT CLASS — the belief the production comment got wrong. All three bind, so the row
	// persists and the column says nothing. Assert the STORED value, not merely the absence of a throw:
	// each lands differently, and which one it is decides what placePins does with it on the next boot.
	const nan = persist(seededDb(), { pinnedSeq: NaN });
	expect(nan.threw).toBe(false);
	expect(nan.row?.pinnedSeq).toBeNull(); // NaN binds to NULL, and the column is NULLABLE.
	const inf = persist(seededDb(), { pinnedSeq: Infinity });
	expect(inf.threw).toBe(false);
	expect(inf.row?.pinnedSeq).toBe(Infinity); // held as a REAL in an `integer` column.
	const float = persist(seededDb(), { pinnedSeq: 1.5 });
	expect(float.threw).toBe(false);
	expect(float.row?.pinnedSeq).toBe(1.5); // held as a REAL, NOT truncated by the column.

	// A numeric STRING is coerced in by SQLite integer affinity — persists as a number, no throw.
	const str = persist(seededDb(), { pinnedSeq: '0' });
	expect(str.threw).toBe(false);
	expect(str.row?.pinnedSeq).toBe(0);

	// And the two honest cases, so the arm cannot pass by every value behaving identically.
	expect(persist(seededDb(), { pinnedSeq: 3 }).row?.pinnedSeq).toBe(3);
	expect(persist(seededDb(), {}).row?.pinnedSeq).toBeNull();
});

// #738 ARM 2 — the source scan, RED ON BASE. The defect is prose, so this is the arm that pins the
// production change. Same shape as the arms above (#317 at :96-113, #395 at :115-136, #706 at :180-183):
// a negative assertion banning the false framing, paired with positive ones requiring the corrected
// account, so deleting the comment cannot pass vacuously. Scoped to the pinnedSeq clause itself rather
// than the whole file, because "NaN" and "crash" both occur legitimately elsewhere in hub.ts.
test('#738: hub.ts does not sort NaN/Infinity/a float into the pinnedSeq crash class', () => {
	const src = readFileSync(join(import.meta.dir, 'hub.ts'), 'utf8');

	// Extract the add-arm pinnedSeq rationale: its opening anchor through its own guard line.
	const start = src.indexOf('pinnedSeq (#638) is the LAST client-minted field');
	const end = src.indexOf("return 'invalid pinnedSeq'");
	// SENTINEL: both anchors present and in order, so the block can never be silently empty.
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	const clause = src.slice(start, end);
	expect(clause.length).toBeGreaterThan(400);

	// NEGATIVE (matches base): NaN placed in the refused/crash class. On base the clause reads
	// "A non-number binding (object/array/NaN/Infinity/float) is refused by bun:sqlite ... takes the
	// core process down", so a crash word follows NaN within a sentence.
	expect(clause).not.toMatch(/NaN[\s\S]{0,100}(?:refused|crash|process down)/);
	// NEGATIVE: the same false framing stated as a non-number rule rather than a bindability one.
	expect(clause).not.toMatch(/non-number binding/);

	// AFFIRMATIVE: the measured account must be present, not merely the false one absent.
	expect(clause).toMatch(/BINDABILITY/);
	expect(clause).toMatch(/persist SILENTLY/);
	expect(clause).toMatch(/NULLABLE with no CHECK/);
	expect(clause).toMatch(/NaN lands as NULL/); // the NaN → NULL measurement
	expect(clause).toMatch(/REAL in the integer/); // the Infinity/float → REAL measurement
	// AFFIRMATIVE: the ruling that keeps the guard broad, so a later reader cannot use this clause to
	// justify narrowing it to only the crashing shapes (which the issue explicitly rules out).
	expect(clause).toMatch(/must not be narrowed/);
});
