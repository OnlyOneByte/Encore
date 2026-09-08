// guard (#690): the ?tag= filter is WIRED through the phone page — a tag chip row that narrows the
// library server-side. Same defect class as #689 (a mechanism built + unit-tested but never CALLED
// from the render path); the lines that thread it live in a Svelte component bun test never imports
// (no jsdom), so this is a source scan on the render seams:
//   1. facets state carries a `tags` array (so the rail has data to render),
//   2. browseFilter can hold a `tag` (so a tag can be the active filter),
//   3. setBrowse handles the 'tag' kind (so a chip click sets that filter),
//   4. loadLibrary sends ?tag= to the server (so the narrowing happens server-side, not client-side),
//   5. a tag rail renders from facets.tags with a setBrowse('tag', …) click.
// Delete any of them and the tag filter silently never works while the server tests stay green.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src
		.replace(/<!--[\s\S]*?-->/g, blank)
		.replace(/\/\*[\s\S]*?\*\//g, blank)
		.replace(/\/\/[^\n]*/g, blank);
}
const PAGE = stripComments(readFileSync(join(import.meta.dir, '+page.svelte'), 'utf8'));

test('facets state carries a tags array (#690)', () => {
	expect(PAGE).toMatch(/tags\s*:\s*\{\s*tag\s*:\s*string\s*;\s*count\s*:\s*number\s*\}\[\]/);
});

test('browseFilter can hold a tag (#690)', () => {
	expect(PAGE).toMatch(/browseFilter\s*=\s*\$state<\{[^}]*\btag\?\s*:\s*string\b[^}]*\}\s*\|\s*null>/);
});

test("setBrowse handles the 'tag' kind (#690)", () => {
	// the signature accepts 'tag'
	const sig = PAGE.match(/function\s+setBrowse\(kind:\s*([^)]*)\)/);
	expect(sig).not.toBeNull(); // non-vacuous
	expect(sig![1]).toMatch(/'tag'/);
	// and it builds a { tag: value } filter
	expect(PAGE).toMatch(/\{\s*tag\s*:\s*value\s*\}/);
});

test('loadLibrary sends ?tag= to the server, not a client-side filter (#690)', () => {
	expect(PAGE).toMatch(/\?tag=\$\{encodeURIComponent\(browseFilter\.tag\)\}/);
});

test('a tag rail renders from facets.tags with a setBrowse(tag, …) click (#690)', () => {
	// iterate the tag facets, keyed
	expect(PAGE).toMatch(/\{#each\s+facets\.tags\s+as\s+f\s*\(f\.tag\)\}/);
	// each chip narrows to that tag
	expect(PAGE).toMatch(/setBrowse\(\s*'tag'\s*,\s*f\.tag\s*\)/);
});
