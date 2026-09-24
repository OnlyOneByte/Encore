// A JobType missing from PIPELINE_JOB_TYPES is a silently un-cancellable process. See docs/GUARDS.md#jobs
// The exhaustiveness lives in the `Record<JobType, true>` witness, which `bun test` cannot assert directly, so
// the union is parsed out of the contract as TEXT — an INDEPENDENT source, not the runtime array.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '@encore/test-support';

const cancelSrc = readFileSync(at('src/lib/server/jobs/cancel.ts'), 'utf8');
const typesSrc = readFileSync(at('src/lib/contract/core/types.ts'), 'utf8');

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
		// Isolate the record body so a key mentioned elsewhere cannot vacuously satisfy the check.
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
		expect(/CANCELLABLE_JOB_TYPES\s*:\s*Record<JobType,\s*true>\s*=/.test(cancelNoComments)).toBe(true);
		// PIPELINE_JOB_TYPES must be DERIVED from its keys; a bare array literal re-opens the silent hole.
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
