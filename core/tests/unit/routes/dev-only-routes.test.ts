// The /components stories stay out of the build because every route file under it is `.devsvelte`, an extension only
// `vite dev` treats as a route (#1143). A `+page.svelte` or `+page.server.ts` there would ship with every build.
import { test, expect } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dir, '../../../src/routes/components');

test('every file under /components is a dev-only .devsvelte route', () => {
	const files = readdirSync(DIR, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
	expect(files.length).toBeGreaterThan(0);
	expect(files.map((e) => e.name).filter((n) => !n.endsWith('.devsvelte'))).toEqual([]);
});
