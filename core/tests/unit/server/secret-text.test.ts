// Core reads a token exactly as the worker does (worker/tests/test_token_clean.py has the same cases).
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanToken, codePoints } from '$lib/server/secret-text';
import { adminTokenProblem, HostKey } from '$lib/server/host-key';
import { workerTokenProblem } from '$lib/server/jobs/worker-token';

const BOM = String.fromCodePoint(0xfeff);
const ZWSP = String.fromCodePoint(0x200b);

// [raw, cleaned]: the same table as the worker test.
const CASES: [string, string][] = [
	[`${BOM}s3cret`, 's3cret'],
	[`s3${ZWSP}cret`, 's3cret'],
	['  s3cret\t\n', 's3cret'],
	[' s3cret ', 's3cret'],
	['\x1cs3cret\x85', 's3cret'],
	['s3 cr&t=/', 's3 cr&t=/'],
	[`${ZWSP}${BOM} `, '']
];

test('cleanToken matches the worker', () => {
	for (const [raw, cleaned] of CASES) expect(cleanToken(raw), JSON.stringify(raw)).toBe(cleaned);
});

test('the 24-character floor counts real characters', () => {
	expect(codePoints('🎤'.repeat(12))).toBe(12);
	for (const problem of [adminTokenProblem, workerTokenProblem]) {
		expect(problem('x'.repeat(23) + ZWSP)).toContain('23 characters');
		expect(problem('🎤'.repeat(12))).toContain('12 characters');
		expect(problem(BOM + 'x'.repeat(24))).toBeNull();
	}
});

test('a token of only invisible characters is refused, but blank still means unset', () => {
	for (const problem of [adminTokenProblem, workerTokenProblem]) {
		expect(problem(ZWSP.repeat(24))).toContain('no visible characters');
		expect(problem('\t\x1c')).toContain('no visible characters');
		for (const blank of [undefined, null, '', '   ']) expect(problem(blank)).toBeNull();
	}
});

test('a fixed host key pasted with a BOM still matches the clean key', () => {
	const key = new HostKey({} as never, BOM + 'k'.repeat(24));
	expect(key.matches('k'.repeat(24))).toBe(true);
	expect(key.matches('k'.repeat(24) + ZWSP)).toBe(true);
	expect(key.matches(ZWSP)).toBe(false);
});

test('server.ts prints every refusal before it exits', () => {
	const server = readFileSync(join(resolve(import.meta.dir, '../../..'), 'server.ts'), 'utf8');
	expect(server).toContain('for (const refusal of refusals) console.error(');
	expect(server.indexOf('if (refusals.length) process.exit(1);')).toBeGreaterThan(
		server.indexOf('for (const refusal of refusals)')
	);
});
