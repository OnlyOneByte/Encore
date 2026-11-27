// The phone layout loads its <Toaster> only when `$lib/ui/toast` says a toast is wanted (#1309), so a `toast`
// imported straight from 'svelte-sonner' would push into a store no Toaster shows until some other toast loads it.
import { test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '../../../src');
const sources = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((p) => /\.(ts|svelte)$/.test(p));
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

test("nothing but $lib/ui/toast imports `toast` from 'svelte-sonner'", () => {
	const direct = sources.filter((p) => /import\s*\{[^}]*\btoast\b[^}]*\}\s*from\s*'svelte-sonner'/.test(read(p)));
	expect(direct).toEqual(['lib/ui/toast.ts']);
});

test('only the phone layout mounts the toaster, and only once a toast is wanted', () => {
	const mounts = sources.filter((p) => read(p).includes("'$lib/components/ui/sonner'"));
	expect(mounts).toEqual(['routes/(phone)/+layout.svelte']);
	const layout = read('routes/(phone)/+layout.svelte');
	expect(layout).toContain("import('$lib/components/ui/sonner')");
	expect(layout).toContain('whenToastNeeded(load);');
	expect(layout).not.toMatch(/import \{ Toaster \} from/);
});
