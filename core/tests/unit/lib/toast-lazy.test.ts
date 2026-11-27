// The phone layout loads its <Toaster> only when `$lib/ui/toast` says a toast is wanted (#1309), so a `toast`
// imported straight from 'svelte-sonner' would push into a store no Toaster shows until some other toast loads it,
// and a second eager Toaster would put the whole toaster back on every phone tab.
import { test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '../../../src');
const sources = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((p) => /\.(ts|svelte)$/.test(p));
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');
/** Every value import of `from`: named, namespace, default or dynamic. Type-only imports don't count. */
const importsOf = (code: string, from: string) =>
	[
		...code.matchAll(/import\s+(?!type\b)([^;]*?)\s*from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)
	].filter((m) => (m[2] ?? m[3]) === from);

test("only $lib/ui/toast and the sonner wrapper import 'svelte-sonner'", () => {
	const direct = sources.filter((p) => importsOf(read(p), 'svelte-sonner').length > 0).sort();
	expect(direct).toEqual(['lib/components/ui/sonner/sonner.svelte', 'lib/ui/toast.ts']);
	// The wrapper's only value import from sonner is `toast`; the Toaster comes in through the layout's lazy load.
	expect(importsOf(read('lib/ui/toast.ts'), 'svelte-sonner').map((m) => m[1])).toEqual(['{ toast as sonner }']);
});

test('nothing imports the toaster eagerly; the phone layout loads it by URL, once a toast is wanted', () => {
	const eager = sources.filter((p) => importsOf(read(p), '$lib/components/ui/sonner').length > 0);
	expect(eager).toEqual([]);
	const layout = read('routes/(phone)/+layout.svelte');
	expect(layout).toContain("import type { Toaster as ToasterComponent } from '$lib/components/ui/sonner';");
	expect(layout).toContain("import toasterUrl from 'virtual:toaster-url';");
	expect(layout).toContain('whenToastNeeded(load);');
	// A failed import() stays failed for that URL, so a retry must ask for a new one.
	expect(layout).toContain('`${toasterUrl}?retry=${attempt}`');
});
