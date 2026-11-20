// Every hook a Playwright selector names must still exist somewhere in the app source. The guard that used to
// verify this (tests/guards/hygiene/contract.test.ts) is gone, and without one a moved hook makes a spec time
// out against a page that is fine — the shape TL-03 found in two probes. This checks EXISTENCE, not that the
// selector resolves on the right surface: that is still the spec's job.
//
// shortcut: hooks are matched as text anywhere in `src/`, so a name reused elsewhere passes. Upgrade to a
// per-surface check if a rotted selector ever slips through on a reused class.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEL } from '../../playwright/world/selectors';

const SRC = join(import.meta.dir, '../../../src');

function corpus(dir: string): string {
	return readdirSync(dir, { withFileTypes: true, recursive: true })
		.filter((e) => e.isFile() && /\.(svelte|ts|html|css)$/.test(e.name))
		.map((e) => readFileSync(join(e.parentPath, e.name), 'utf8'))
		.join('\n');
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The hooks a CSS selector names: attribute values for the attributes the app publishes, and class names. */
function hooks(selector: string): string[] {
	const out: string[] = [];
	const attrs = /\[(?:data-[\w-]+|aria-label)\s*[~^$*|]?=\s*(["'])(.*?)\1\s*\]/g;
	for (const m of selector.matchAll(attrs)) out.push(m[2]);
	// Classes outside attribute brackets only, so `[href="/x.y"]` never reads as a class `.y`.
	for (const m of selector.replace(/\[[^\]]*\]/g, '').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.push(m[1]);
	return out;
}

function missing(selector: string, source: string): string[] {
	return hooks(selector).filter((h) => !new RegExp(`(?<![\\w-])${escape(h)}(?![\\w-])`).test(source));
}

describe('selector contract', () => {
	test('every class and data/aria hook a SEL string names exists in src/', () => {
		const source = corpus(SRC);
		const strings = Object.entries(SEL).flatMap(([key, sel]): Array<[string, string]> =>
			typeof sel === 'string' ? [[key, sel]] : []
		);
		// Non-vacuity: a parser that stopped finding hooks would pass on any tree.
		expect(strings.flatMap(([, sel]) => hooks(sel)).length).toBeGreaterThan(100);
		const rotted = strings.flatMap(([key, sel]) =>
			missing(sel, source).map((h) => `SEL.${key} (${sel}): "${h}" is in no file under src/`)
		);
		expect(rotted).toEqual([]);
	});

	test('a hook the app does not carry is reported, and one it does is not', () => {
		const source = '<button data-testid="song-add" class="row tp">';
		expect(missing('.row [data-testid="song-add"]', source)).toEqual([]);
		expect(missing('.row [data-testid="song-gone"]', source)).toEqual(['song-gone']);
		expect(missing('.hero .tp', source)).toEqual(['hero']);
		expect(missing('a[href="/library.html"]', source)).toEqual([]);
	});
});
