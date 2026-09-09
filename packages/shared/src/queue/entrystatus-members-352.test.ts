// #352: 'waiting' and 'skipped' were two EntryStatus members that never had a writer anywhere in the
// repo (only three values are ever minted: queued/playing/done). Removing them is a pure vocabulary
// deletion, so nothing BEHAVIOURAL reds if a member comes back — this source-scan guard is the
// load-bearing regression trap. It reads the two contract files, ISOLATES the specific declaration
// (so a same-named string elsewhere — e.g. the unrelated TvState 'waiting', or the prose word "skip"
// — can neither satisfy nor trip a check), strips comments (so a comment naming a removed member
// cannot fool an absence assertion), and asserts each removed member is gone while the three live
// members survive. It also pins the two isTerminal readers so a future edit cannot re-introduce a
// 'skipped' arm that reads a value nothing writes.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const stripComments = (s: string): string =>
	s
		.replace(/\/\*[\s\S]*?\*\//g, '') // block comments
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (avoid eating http://)

const readSrc = (rel: string): string => readFileSync(join(import.meta.dir, rel), 'utf8');

const REMOVED = ["'waiting'", "'skipped'"] as const;
const LIVE = ["'queued'", "'playing'", "'done'"] as const;

test('#352: the EntryStatus union in types.ts holds exactly queued/playing/done', () => {
	const src = stripComments(readSrc('../core/types.ts'));
	const m = src.match(/export type EntryStatus =[^;]*;/);
	expect(m).not.toBeNull(); // not-vacuous: the declaration must exist
	const decl = m![0];
	for (const dead of REMOVED) expect(decl).not.toContain(dead);
	for (const live of LIVE) expect(decl).toContain(live); // survival: not satisfiable by deleting the type
});

test('#352: the drizzle queue_entries.status enum mirrors exactly queued/playing/done', () => {
	// schema.ts lives in apps/core; reach it relative to this shared test file.
	const src = stripComments(readSrc('../../../../apps/core/src/server/db/schema.ts'));
	// isolate the status column's own enum:[...] array, not any other enum in the file.
	const m = src.match(/status:\s*text\('status',\s*\{\s*enum:\s*\[([^\]]*)\]/);
	expect(m).not.toBeNull(); // not-vacuous
	const arr = m![1];
	for (const dead of REMOVED) expect(arr).not.toContain(dead);
	for (const live of LIVE) expect(arr).toContain(live);
});

test('#352: the two isTerminal predicates carry no dead "skipped" arm', () => {
	// The shared canonical predicate.
	const rot = stripComments(readSrc('./rotation.ts'));
	const rm = rot.match(/export function isTerminal\([^)]*\)[^{]*\{([^}]*)\}/);
	expect(rm).not.toBeNull(); // not-vacuous
	const body = rm![1];
	expect(body).toContain("=== 'done'"); // survival: still terminal on done
	expect(body).not.toContain("'skipped'");

	// leave.ts must NOT re-introduce a hand-duplicated local copy — it imports the shared one.
	const leave = stripComments(readSrc('../../../../apps/core/src/server/singers/leave.ts'));
	expect(leave).toMatch(/import\s*\{[^}]*\bisTerminal\b[^}]*\}\s*from\s*'@encore\/shared'/); // uses the shared predicate
	expect(leave).not.toMatch(/const isTerminal\s*=/); // no local re-definition
});
