// 'waiting' and 'skipped' were two EntryStatus members that never had a writer anywhere in the
// repo (only three values are ever minted: queued/playing/done). Removing them is a pure vocabulary
// deletion, so nothing BEHAVIOURAL reds if a member comes back — this source-scan guard is the
// load-bearing regression trap. It reads the two contract files, ISOLATES the specific declaration
// (so a same-named string elsewhere — e.g. the unrelated TvState 'waiting', or the prose word "skip"
// — can neither satisfy nor trip a check), strips comments (so a comment naming a removed member
// cannot fool an absence assertion), and asserts each removed member is gone while the three live
// members survive. It also pins the two isTerminal readers so a future edit cannot re-introduce a
// 'skipped' arm that reads a value nothing writes.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

const stripComments = (s: string): string =>
	s
		.replace(/\/\*[\s\S]*?\*\//g, '') // block comments
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (avoid eating http://)

// `readSrc` was `readFileSync(at('apps/core/src/shared/queue'))`, so all four subjects were spelled as
// offsets from this file's old home in apps/core/src/shared/queue — including a `../../../../apps/core`
// climb out of the package entirely. They are named from the repo root now, and `read` throws when one
// is missing: load-bearing here, because every REMOVED-member assertion is an ABSENCE check that an
// empty read would satisfy while proving nothing.
const readSrc = (rel: string): string => read(rel);

const REMOVED = ["'waiting'", "'skipped'"] as const;
const LIVE = ["'queued'", "'playing'", "'done'"] as const;

test('the EntryStatus union in types.ts holds exactly queued/playing/done', () => {
	const src = stripComments(readSrc('apps/core/src/shared/core/types.ts'));
	const m = src.match(/export type EntryStatus =[^;]*;/);
	expect(m).not.toBeNull(); // not-vacuous: the declaration must exist
	const decl = m![0];
	for (const dead of REMOVED) expect(decl).not.toContain(dead);
	for (const live of LIVE) expect(decl).toContain(live); // survival: not satisfiable by deleting the type
});

test('the drizzle queue_entries.status enum mirrors exactly queued/playing/done', () => {
	// schema.ts lives in apps/core, named from the repo root (was a four-level `../../../../` climb).
	const src = stripComments(readSrc('apps/core/src/server/db/schema.ts'));
	// isolate the status column's own enum:[...] array, not any other enum in the file.
	const m = src.match(/status:\s*text\('status',\s*\{\s*enum:\s*\[([^\]]*)\]/);
	expect(m).not.toBeNull(); // not-vacuous
	const arr = m![1];
	for (const dead of REMOVED) expect(arr).not.toContain(dead);
	for (const live of LIVE) expect(arr).toContain(live);
});

test('the two isTerminal predicates carry no dead "skipped" arm', () => {
	// The shared canonical predicate. A SIBLING READ before the move — `./rotation.ts`, "the rotation\n	// next to me" — which is apps/core/src/shared/queue/rotation.ts, the queue module that exports the one
	// canonical isTerminal. Named explicitly now, since nothing can infer it from tests/guards/.
	const rot = stripComments(readSrc('apps/core/src/shared/queue/rotation.ts'));
	const rm = rot.match(/export function isTerminal\([^)]*\)[^{]*\{([^}]*)\}/);
	expect(rm).not.toBeNull(); // not-vacuous
	const body = rm![1];
	expect(body).toContain("=== 'done'"); // survival: still terminal on done
	expect(body).not.toContain("'skipped'");

	// leave.ts must NOT re-introduce a hand-duplicated local copy — it imports the shared one.
	const leave = stripComments(readSrc('apps/core/src/server/singers/leave.ts'));
	expect(leave).toMatch(/import\s*\{[^}]*\bisTerminal\b[^}]*\}\s*from\s*'\$shared'/); // uses the shared predicate
	expect(leave).not.toMatch(/const isTerminal\s*=/); // no local re-definition
});
