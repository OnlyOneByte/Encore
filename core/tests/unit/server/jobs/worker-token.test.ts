// The role=worker upgrade gate (server.ts) compares ENCORE_WORKER_TOKEN in constant time.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { workerTokenMatches, workerTokenProblem } from '$lib/server/jobs/worker-token';

test('a set token shorter than 24 characters is refused; unset or long enough is fine', () => {
	expect(workerTokenProblem('abc')).toContain('at least 24');
	expect(workerTokenProblem('abc')).toContain('openssl rand -base64 24');
	expect(workerTokenProblem('x'.repeat(23))).not.toBeNull();
	expect(workerTokenProblem(`  ${'x'.repeat(23)}  `)).not.toBeNull();
	expect(workerTokenProblem('x'.repeat(24))).toBeNull();
	expect(workerTokenProblem(undefined)).toBeNull();
	expect(workerTokenProblem('   ')).toBeNull();
});

test('server.ts exits before boot on a short worker token', () => {
	const server = readFileSync(join(CORE, 'server.ts'), 'utf8');
	expect(server).toContain('workerTokenProblem(process.env.ENCORE_WORKER_TOKEN)');
});

test('only the exact token matches, whatever the lengths', () => {
	expect(workerTokenMatches('s3 cr&t=/', 's3 cr&t=/')).toBe(true);
	expect(workerTokenMatches('s3 cr&t', 's3 cr&t=/')).toBe(false); // shorter: no length throw
	expect(workerTokenMatches('s3 cr&t=/x', 's3 cr&t=/')).toBe(false);
	expect(workerTokenMatches('', 's3 cr&t=/')).toBe(false);
	expect(workerTokenMatches(null, 's3 cr&t=/')).toBe(false);
});

const CORE = resolve(import.meta.dir, '../../../..');

test('the comparison itself is constant-time: timingSafeEqual over SHA-256 digests', () => {
	// A plain `===` passes every behavioural case above, so the timing property is pinned in the source.
	const helper = readFileSync(join(CORE, 'src/lib/server/jobs/worker-token.ts'), 'utf8');
	const body = helper.slice(helper.indexOf('export function workerTokenMatches'));
	expect(helper).toContain("createHash('sha256')");
	expect(body).toMatch(/timingSafeEqual\(\s*digest\(presented\),\s*digest\(expected\)\s*\)/);
	expect(body).not.toMatch(/presented\s*===?\s*expected/);
});

test('server.ts gates the upgrade through it, not a plain string compare', () => {
	const server = readFileSync(join(CORE, 'server.ts'), 'utf8');
	expect(server).toContain("!workerTokenMatches(url.searchParams.get('token'), WORKER_TOKEN)");
	expect(server).not.toMatch(/get\('token'\)\s*!==/);
});
