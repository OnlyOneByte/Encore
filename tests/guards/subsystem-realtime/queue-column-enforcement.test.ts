// guard: what queue_entries ACTUALLY rejects at the write-behind flush, measured, so the add-arm guard's
// rationale in hub.ts can never regress to "the NOT NULL enum column rejects it". `queue_entries` has NO
// CHECK constraint on `status` (drizzle's `enum:` is compile-time only) and stores a garbage `addedAt` past
// the NOT NULL check — only a missing value throws — so for STATUS the guard is the only thing keeping the
// value set honest. The server re-stamps addedAt at the applyQueueOp seam, so its finiteness reject is a
// SHAPE reject rather than the last line of defence.
import { test, expect } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { readFileSync } from 'node:fs';
import { at } from '@encore/test-support';
import { flattenDoc } from '@encore/test-support/scan';
import { rooms, singers, media, queueEntries } from '$lib/server/db/schema';

const HUB = at('src/lib/server/realtime/hub.ts');

/**
 * Comment markers stripped and whitespace collapsed, so every prose arm below matches the SENTENCE rather
 * than one line-wrapping of it — re-flowing a paragraph otherwise puts `//` between two words and the guard
 * reports a live claim as missing. Case is preserved; the arms carry `/i` where the emphasis may move.
 */
function flatProse(src: string): string {
	return flattenDoc(src, { line: true }).trim();
}

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

// Insert one queue_entries row exactly as the write-behind flush would (persistence.ts), with the one
// field under test overridden. Returns 'throw' or the persisted row.
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

// SOURCE SCAN: the corrected rationale is the subject here, so hub.ts is read as PROSE — comment markers
// stripped and whitespace collapsed, or a re-flowed paragraph reads as a deleted claim.
test('hub.ts states the measured mechanism, not the false "enum column rejects it" account', () => {
	const src = flatProse(readFileSync(HUB, 'utf8'));
	// The header block no longer calls the column an enforcing enum, and names it the VALUE LIST source.
	expect(src).toContain('single source of truth for the entry-status VALUE LIST');
	expect(src).toContain('NOT an enforcing enum at runtime');
	expect(src).toMatch(/no\s+CHECK\s+constraint/i);
	// The guard block states the split: NOT NULL is the discriminator; off-enum/Infinity persist.
	expect(src).toMatch(/NOT NULL alone — never an enum, never finiteness/i);
	expect(src).toContain('persist SILENTLY');
	// And it must NOT reassert the exact false framing the issue flagged.
	expect(src).not.toContain('the NOT NULL enum column an add');
});

// The add-arm's ALLOWED set is the bare literal 'queued', NOT derived from the column's enumValues; that
// import survives only to pick a word ('server-owned' vs 'off-enum') for the reject-log string. A header
// clause generalising the classification read into the allowed set is the false account pinned against,
// and it is both BANNED and affirmatively replaced, so deleting the header cannot pass vacuously.
test('hub.ts header credits the literal, not enumValues, as the add-arm allowed set', () => {
	const src = flatProse(readFileSync(HUB, 'utf8'));
	// FALSE framing the issue flagged: enumValues defining the allowed set / unable to drift from the column.
	expect(src).not.toContain('allowed set can never drift from the column');
	// AFFIRMATIVE: the header must name the real allowed set (the single literal 'queued') and scope the
	// enumValues read to CLASSIFY-only, so the corrected account is present and not merely the false one gone.
	expect(src).toContain("allowed set is the single literal 'queued'");
	expect(src).toMatch(/enumValues are read below ONLY to CLASSIFY/i);
});

// The add-arm rationale must name EVERY field the code server-owns at the add seam: the seam
// `{ ...cmd.op.entry, addedAt: deps.state.nextAddedAt() }` re-stamps addedAt, so the server owns
// rotationSeq AND addedAt. Code ⊆ prose, self-extending, so a third rewritten field reds too. Comment
// stripping is INVERTED and load-bearing: `addedAt` occurs many times raw but only once in the seam
// literal, so a whole-file scan would read it as "named" from prose alone.
test('hub.ts prose names every field the add seam server-owns (rotationSeq AND addedAt)', () => {
	const src = readFileSync(HUB, 'utf8');

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

	// Extract fields the PROSE declares server-owned: comment lines only, flattened so the clause below is
	// matched as a sentence rather than as one line-wrapping of it.
	const prose = flatProse(
		src
			.split('\n')
			.filter((l) => /^\s*\/\//.test(l))
			.join('\n')
	);
	// SENTINEL 2: the prose still names rotationSeq, so deleting the server-owned clause reds. The subset loop
	// below asserts it is present as a server-owned field; this only anchors the token.
	expect(prose).toContain('rotationSeq');
	// The corrected prose must declare addedAt server-owned too (this is the red-on-base assertion).
	expect(prose).toMatch(/addedAt.{0,80}?(re-?stamp|server-?own|nextAddedAt)/i);

	// code ⊆ prose: every field the seam server-owns is named by the prose as server-owned.
	for (const field of codeServerOwned) {
		expect(prose).toContain(field);
	}
});

// ARM 2: since addedAt is re-stamped, the prose must NOT reassert that the finiteness reject is the ONLY
// thing keeping a garbage addedAt out of the queue — it is narrowed to a shape reject.
test('hub.ts no longer calls the addedAt reject the last line of defence', () => {
	const src = flatProse(readFileSync(HUB, 'utf8'));
	expect(src).not.toMatch(/ONLY thing keeping[\s\S]{0,140}addedAt out of the queue/i);
});
