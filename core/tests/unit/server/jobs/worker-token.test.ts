// The role=worker upgrade gate (server.ts) compares ENCORE_WORKER_TOKEN in constant time.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { workerTokenMatches } from '$lib/server/jobs/worker-token';

test('only the exact token matches, whatever the lengths', () => {
	expect(workerTokenMatches('s3 cr&t=/', 's3 cr&t=/')).toBe(true);
	expect(workerTokenMatches('s3 cr&t', 's3 cr&t=/')).toBe(false); // shorter: no length throw
	expect(workerTokenMatches('s3 cr&t=/x', 's3 cr&t=/')).toBe(false);
	expect(workerTokenMatches('', 's3 cr&t=/')).toBe(false);
	expect(workerTokenMatches(null, 's3 cr&t=/')).toBe(false);
});

test('server.ts gates the upgrade through it, not a plain string compare', () => {
	const server = readFileSync(join(resolve(import.meta.dir, '../../../..'), 'server.ts'), 'utf8');
	expect(server).toContain("!workerTokenMatches(url.searchParams.get('token'), WORKER_TOKEN)");
	expect(server).not.toMatch(/get\('token'\)\s*!==/);
});
