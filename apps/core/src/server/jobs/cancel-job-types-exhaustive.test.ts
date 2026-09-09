/**
 * The cancel path must be able to stop EVERY kind of pipeline job.
 *
 * `cancelJobsForMedia` iterates `PIPELINE_JOB_TYPES` (cancel.ts) and asks the repository whether a
 * live job of each type exists; a type absent from that list is never asked about, so its cook keeps
 * running after a guest taps remove — "a silently un-cancellable cook", the exact failure cancel.ts
 * was written to close. The table's own comment promised the compiler would catch an omitted member,
 * but a `readonly JobType[]` array literal has no exhaustiveness obligation, so that promise was
 * empty: a fifth `JobType` could be dropped and the tree still typechecked green.
 *
 * The real guard is now the type system — `PIPELINE_JOB_TYPES` derives from an exhaustive
 * `Record<JobType, true>`, so a missing member fails `bun run typecheck` AT cancel.ts (proven by
 * mutation in the PR body). A type-level check cannot be asserted from inside `bun test`, so this
 * test guards the same invariant two ways that DO run in the suite, and reds if the fix is reverted:
 *
 *  1. It parses the `JobType` union straight out of packages/shared as TEXT — an INDEPENDENT source,
 *     not the runtime array the code builds — and asserts every member is a key of the Record in
 *     cancel.ts. Drop a member from the Record (or add a JobType without listing it) and this reds.
 *  2. It asserts cancel.ts still uses the exhaustive `Record<JobType, true>` witness and derives the
 *     list from its keys — so a revert to a bare `readonly JobType[] = [...]` array literal (which
 *     re-opens the silent-omission hole) reds here too, even though such a revert typechecks.
 *
 * Reading the sources as text keeps the check independent of how the code assembles the list.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const cancelSrc = readFileSync(join(import.meta.dir, 'cancel.ts'), 'utf8');
const typesSrc = readFileSync(join(import.meta.dir, '../../../../../packages/shared/src/core/types.ts'), 'utf8');

/** Strip line and block comments so prose describing the old layout cannot satisfy or trip a scan. */
function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** The canonical JobType members, parsed from the union declaration in packages/shared as text. */
function jobTypeMembers(): string[] {
	const src = stripComments(typesSrc);
	const m = src.match(/export type JobType\s*=\s*([^;]+);/);
	expect(m, 'JobType union declaration must exist in packages/shared/src/core/types.ts').not.toBeNull();
	const members = m![1]
		.split('|')
		.map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
		.filter((p) => p.length > 0);
	expect(members.length).toBeGreaterThanOrEqual(4); // not vacuous
	return members;
}

describe('cancel.ts job-type table is exhaustive over JobType', () => {
	const cancelNoComments = stripComments(cancelSrc);

	test('every JobType member is a key of the CANCELLABLE_JOB_TYPES record', () => {
		const members = jobTypeMembers();
		// Isolate the record body so a key mentioned elsewhere (e.g. a string literal in the loop)
		// cannot vacuously satisfy the check.
		const rec = cancelNoComments.match(/CANCELLABLE_JOB_TYPES\s*:\s*Record<JobType,\s*true>\s*=\s*\{([\s\S]*?)\}/);
		expect(rec, 'CANCELLABLE_JOB_TYPES: Record<JobType, true> literal must exist in cancel.ts').not.toBeNull();
		const body = rec![1];
		for (const member of members) {
			// key may be bare (fetch:) or quoted ('stems-upgrade':)
			const keyRe = new RegExp(`(^|[\\s,{])['"]?${member.replace(/[-]/g, '\\-')}['"]?\\s*:`);
			expect(keyRe.test(body), `JobType '${member}' must be a key of CANCELLABLE_JOB_TYPES`).toBe(true);
		}
	});

	test('the exhaustive Record<JobType,true> witness is used and drives the list (no bare array literal)', () => {
		// The exhaustive witness must be present...
		expect(/CANCELLABLE_JOB_TYPES\s*:\s*Record<JobType,\s*true>\s*=/.test(cancelNoComments)).toBe(true);
		// ...and PIPELINE_JOB_TYPES must be DERIVED from it, not re-typed as a bare array literal
		// (a bare `const PIPELINE_JOB_TYPES: readonly JobType[] = [...]` re-opens the silent hole).
		expect(
			/const\s+PIPELINE_JOB_TYPES\s*=\s*Object\.keys\(\s*CANCELLABLE_JOB_TYPES\s*\)/.test(cancelNoComments),
			'PIPELINE_JOB_TYPES must be derived from CANCELLABLE_JOB_TYPES keys'
		).toBe(true);
		expect(
			/const\s+PIPELINE_JOB_TYPES\s*:\s*readonly\s+JobType\[\]\s*=\s*\[/.test(cancelNoComments),
			'PIPELINE_JOB_TYPES must NOT be a bare array literal (that re-opens the omission hole)'
		).toBe(false);
	});
});
