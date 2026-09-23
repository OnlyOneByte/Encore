// guard: the isomorphic contract cannot reach into the app.
//
// `src/lib/contract` is browser-bundled and imported by BOTH halves, so it must not depend on `$lib`
// (the UI consuming it) or `$app`/`$env` (a runtime the server half does not have). Nothing in the
// toolchain polices either. `$lib/server` is deliberately NOT this guard's business: SvelteKit fails the
// build on it, transitively. Relative escapes (`../lib/x`) are refused too, since they resolve to exactly
// the modules an alias ban names. See docs/GUARDS.md#the-hygiene-and-meta-guards.

import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { filesUnder, relative, sharedSrc } from '@encore/test-support';

/**
 * Aliases reaching code this tree must not depend on. `$lib/server` is absent as its own entry because
 * SvelteKit enforces it at build time and transitively (`$lib` matches it as a prefix regardless). The
 * `$lib/contract/` carve-out exists because the contract now lives under `$lib`, so a blanket prefix ban
 * read a module reaching its own sibling as a violation. The lookahead requires the trailing SLASH so the
 * bare barrel `'$lib/contract'` still reds — that is a cycle, not a boundary crossing — while
 * `'$lib/contract/core/types'` does not.
 */
const FORBIDDEN_ALIAS = /(?:from|import)\s*\(?\s*['"]((?:\$app|\$env|\$lib(?!\/contract\/))(?:\/[^'"]*)?)['"]/;
/** A relative path that climbs out of `src/lib/contract` — the way round an alias ban. */
const ESCAPING_RELATIVE = /(?:from|import)\s*\(?\s*['"](\.\.\/(?:\.\.\/)*)(lib|routes)\//;

function code(abs: string): string {
	// Comments are stripped because several modules describe in prose what they deliberately do NOT import,
	// and a raw scan reads those as violations.
	return readFileSync(abs, 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

test('no file in the isomorphic contract imports server, lib, app or env code', () => {
	const files = filesUnder(relative(sharedSrc), ['.ts']);
	// Non-vacuity: an empty walk would report a clean boundary.
	expect(files.length).toBeGreaterThan(20); // @nvf-floor files.length

	const offenders: string[] = [];
	for (const abs of files) {
		const src = code(abs);
		const alias = FORBIDDEN_ALIAS.exec(src);
		if (alias) {
			offenders.push(
				`${relative(abs)} imports \`${alias[1]}\`. This tree is browser-bundled and is imported by ` +
					`BOTH halves of the app, so depending on \`${alias[1]}\` makes the authoritative side ` +
					`depend on the UI (or, for \`$app\`/\`$env\`, on a runtime the server half does not have). ` +
					`It was impossible while this was a separate package with no aliases and no dependency on ` +
					`the app; this test is what replaced that guarantee.`
			);
		}
		const rel = ESCAPING_RELATIVE.exec(src);
		if (rel) {
			offenders.push(
				`${relative(abs)} climbs out of the contract with \`${rel[1]}${rel[2]}/\`. That resolves to the ` +
					`same modules the aliases name, so banning only the alias would be a rule with a hole in it.`
			);
		}
	}
	expect(offenders).toEqual([]);
});

test('the ban catches both spellings, and does not catch a legitimate import', () => {
	// Mutation arms both ways, alias and relative halves separately — a fix to one has broken the other.
	expect(FORBIDDEN_ALIAS.test("import { db } from '$lib/server/db';")).toBe(true);
	expect(FORBIDDEN_ALIAS.test("import { page } from '$app/state';")).toBe(true);
	expect(FORBIDDEN_ALIAS.test("import { PUBLIC_X } from '$env/dynamic/public';")).toBe(true);
	// The relative escape is spelled through `lib`; server code reaching the browser is the framework's job.
	expect(ESCAPING_RELATIVE.test("import { x } from '../lib/components/SongRow.svelte';")).toBe(true);
	expect(ESCAPING_RELATIVE.test("import { db } from '../../lib/server/db';")).toBe(true);

	// …and the things this tree legitimately does.
	expect(FORBIDDEN_ALIAS.test("import { rotation } from '$lib/contract/queue/rotation';")).toBe(false);
	expect(FORBIDDEN_ALIAS.test("import { test } from 'bun:test';")).toBe(false);
	// Importing its OWN barrel is forbidden too, and that is a circular import rather than a boundary crossing.
	expect(FORBIDDEN_ALIAS.test("import type { Media } from '$lib/contract';")).toBe(true);
	expect(FORBIDDEN_ALIAS.test("import type { Media } from '$lib/contract/core/types';")).toBe(false);
	// The carve-out is a SLASH-BOUNDED prefix, not a substring: this arm reds if the lookahead loosens.
	expect(FORBIDDEN_ALIAS.test("import { x } from '$lib/contract-helpers/x';")).toBe(true);
	expect(FORBIDDEN_ALIAS.test("import { x } from '$lib/contractual/x';")).toBe(true);
	// Exactly one level deep: every other `$lib` subpath is still refused however contract-ish it reads.
	expect(FORBIDDEN_ALIAS.test("import { overallProcessPct } from '$lib/process-progress';")).toBe(true);
	expect(ESCAPING_RELATIVE.test("import { x } from '$lib/contract/presentation/colors';")).toBe(false);
	expect(ESCAPING_RELATIVE.test("import { y } from '$lib/contract/core/types';")).toBe(false);
	// `$lib/server` is not this guard's business any more — pinned as a deliberate non-assertion.
	expect(
		FORBIDDEN_ALIAS.test("import { db } from '$lib/server/db';"),
		'matches only because `$lib` is a prefix of it — SvelteKit is what actually enforces this one'
	).toBe(true);
});

test('the comment stripper does not blind the scan', () => {
	// Stripping must remove an EXPLANATION of a banned import without removing a real one nearby. The
	// transforms are mirrored inline here and must stay identical to the ones in `code()`.
	const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

	const withRealImport = strip(
		[
			"// This module must never import from '$lib/server/db' — it is browser-bundled.",
			"import { rotation } from '$lib/contract/queue/rotation';",
			"/* nor '../lib/server/state' by the relative route */",
			"import { db } from '$lib/server/db';"
		].join('\n')
	);
	expect(FORBIDDEN_ALIAS.test(withRealImport), 'the real import on the last line must survive').toBe(true);

	const commentsOnly = strip(["// mentions '$lib/server/db'", "/* and '../lib/x' */"].join('\n'));
	expect(FORBIDDEN_ALIAS.test(commentsOnly)).toBe(false);
	expect(ESCAPING_RELATIVE.test(commentsOnly)).toBe(false);
});
