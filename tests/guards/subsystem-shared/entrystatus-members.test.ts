// 'waiting' and 'skipped' were EntryStatus members no code ever wrote — only queued/playing/done are minted —
// so removing them is a pure vocabulary deletion that nothing BEHAVIOURAL reds on if one returns. Each
// declaration is ISOLATED (the unrelated TvState 'waiting' and the prose word "skip" must neither satisfy nor
// trip a check) and comments are stripped, so a comment naming a removed member cannot fool an absence check.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';
import { stripComments } from '@encore/test-support/scan';

// `read` throws on a missing path, which is load-bearing here: every REMOVED-member assertion is an ABSENCE
// check that an empty read would satisfy while proving nothing.
const readSrc = (rel: string): string => read(rel);

const REMOVED = ["'waiting'", "'skipped'"] as const;
const LIVE = ["'queued'", "'playing'", "'done'"] as const;

test('the EntryStatus union in types.ts holds exactly queued/playing/done', () => {
	const src = stripComments(readSrc('src/lib/contract/core/types.ts'), { drop: true });
	const m = src.match(/export type EntryStatus =[^;]*;/);
	expect(m).not.toBeNull(); // not-vacuous: the declaration must exist
	const decl = m![0];
	for (const dead of REMOVED) expect(decl).not.toContain(dead);
	for (const live of LIVE) expect(decl).toContain(live); // survival: not satisfiable by deleting the type
});

test('the drizzle queue_entries.status enum mirrors exactly queued/playing/done', () => {
	const src = stripComments(readSrc('src/lib/server/db/schema.ts'), { drop: true });
	// isolate the status column's own enum:[...] array, not any other enum in the file.
	const m = src.match(/status:\s*text\('status',\s*\{\s*enum:\s*\[([^\]]*)\]/);
	expect(m).not.toBeNull(); // not-vacuous
	const arr = m![1];
	for (const dead of REMOVED) expect(arr).not.toContain(dead);
	for (const live of LIVE) expect(arr).toContain(live);
});

test('the two isTerminal predicates carry no dead "skipped" arm', () => {
	// rotation.ts exports the one canonical isTerminal.
	const rot = stripComments(readSrc('src/lib/contract/queue/rotation.ts'), { drop: true });
	const rm = rot.match(/export function isTerminal\([^)]*\)[^{]*\{([^}]*)\}/);
	expect(rm).not.toBeNull(); // not-vacuous
	const body = rm![1];
	expect(body).toContain("=== 'done'"); // survival: still terminal on done
	expect(body).not.toContain("'skipped'");

	// leave.ts must import the shared predicate rather than re-declare a local copy. Either spelling of the
	// barrel counts: the server tree imports the contract RELATIVELY because `$lib` resolves only through the
	// generated .svelte-kit tsconfig, which the runtime image never copies.
	const leave = stripComments(readSrc('src/lib/server/singers/leave.ts'), { drop: true });
	expect(leave).toMatch(/import\s*\{[^}]*\bisTerminal\b[^}]*\}\s*from\s*'(?:\$lib\/contract|(?:\.\.\/)+contract)'/); // uses the shared predicate
	expect(leave).not.toMatch(/const isTerminal\s*=/); // no local re-definition
});
