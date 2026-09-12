// guard: the isomorphic contract cannot reach into the app — XR-VER-07.
//
// WHAT THIS STILL GUARDS, AND WHAT THE FRAMEWORK TOOK BACK.
//
// `src/lib/contract` was `packages/shared`, its own workspace package, and two facts made the rule unbreakable
// rather than merely unbroken: its `tsconfig.json` carried `paths: []`, and its `package.json` declared no
// dependency on `.`. A shared module could not import server code because the import was
// UNRESOLVABLE. Folding it into `src/lib/contract` destroyed that, and this guard replaced it.
//
// THE SERVER HALF IS NOW A BUILD-TIME GUARANTEE AGAIN, and a better one than the original. Server-only
// code moved from `src/server` to `src/lib/server`, a path SvelteKit gives meaning to: importing anything
// under it from code that reaches the browser fails the BUILD with
//
//     Cannot import $lib/server/app.ts into code that runs in the browser,
//     as this could leak sensitive information
//
// and it holds TRANSITIVELY — a component importing this contract, which imported `$lib/server`, is caught.
// Verified by planting exactly that import in `SongRow.svelte`: `bun run build` exits 1 with the message
// above. That beats the old package boundary, which relied on resolution merely failing, and it beats this
// test, which can be deleted.
//
// WHAT IS LEFT HERE IS THE PART NOTHING IN THE TOOLCHAIN POLICES: `$lib` (client code — the contract must
// not depend on the UI consuming it) and `$app` / `$env` (SvelteKit's own runtime, which would make a
// module unusable from the server half). No build step objects to either, so they stay guarded here.
//
// BOTH SPELLINGS ARE CLOSED. An alias ban alone is trivially defeated by `../lib/x`, which resolves to
// exactly the same module, so relative escapes out of this directory are refused too.

import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { sharedSrc, filesUnder, relative } from '@encore/test-support';

/**
 * Aliases reaching code this tree must not depend on.
 *
 * `$lib/server` is deliberately ABSENT as its own entry: it is the one case SvelteKit enforces itself, at
 * build time and transitively, so naming it here would duplicate a stronger check and rot quietly if the
 * framework's rule ever changed. (`$lib` matches it as a prefix anyway — a harmless overlap, not the
 * load-bearing part.)
 */
const FORBIDDEN_ALIAS = /(?:from|import)\s*\(?\s*['"](\$lib|\$app|\$env)(?:\/[^'"]*)?['"]/;
/** A relative path that climbs out of `src/lib/contract` — the way round an alias ban. */
const ESCAPING_RELATIVE = /(?:from|import)\s*\(?\s*['"](\.\.\/(?:\.\.\/)*)(lib|routes)\//;

function code(abs: string): string {
	// Comments are stripped because this file's own neighbours explain the rule in prose, and several
	// modules describe what they deliberately do NOT import. A raw scan reads those as violations — the
	// trap every text-scanning guard in this suite has to survive.
	return readFileSync(abs, 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

test('no file in the isomorphic contract imports server, lib, app or env code', () => {
	const files = filesUnder(relative(sharedSrc), ['.ts']);
	// Non-vacuity: the walk found the tree. An empty walk reports a clean boundary, which is precisely the
	// shape that let 61 mis-anchored guards pass earlier in this reorganisation.
	expect(files.length).toBeGreaterThan(20); // @nvf-floor files.length

	const offenders: string[] = [];
	for (const abs of files) {
		const src = code(abs);
		const alias = FORBIDDEN_ALIAS.exec(src);
		if (alias) {
			offenders.push(
				`${relative(abs)} imports \`${alias[1]}\`. This tree is browser-bundled: reaching ${alias[1]} ` +
					`ships app — and in the \`$server\` case, database — code to every phone. It was impossible ` +
					`while this was a separate package with no aliases and no dependency on .; this test ` +
					`is what replaced that guarantee.`
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
	/*
	 * Mutation arms in both directions. The alias half and the relative half are checked separately because
	 * a fix to one has repeatedly broken the other in this suite.
	 */
	expect(FORBIDDEN_ALIAS.test("import { db } from '$lib/server/db';")).toBe(true);
	expect(FORBIDDEN_ALIAS.test("import { page } from '$app/state';")).toBe(true);
	expect(FORBIDDEN_ALIAS.test("import { PUBLIC_X } from '$env/dynamic/public';")).toBe(true);
	// The relative escape is now spelled through `lib`, because that is where the server tree lives. The
	// dangerous direction (server code reaching the browser) is the framework's job; this arm is about the
	// contract depending on the UI at all.
	expect(ESCAPING_RELATIVE.test("import { x } from '../lib/components/SongRow.svelte';")).toBe(true);
	expect(ESCAPING_RELATIVE.test("import { db } from '../../lib/server/db';")).toBe(true);

	// …and the things this tree legitimately does.
	expect(FORBIDDEN_ALIAS.test("import { rotation } from './queue/rotation';")).toBe(false);
	expect(FORBIDDEN_ALIAS.test("import { test } from 'bun:test';")).toBe(false);
	// A contract module importing its OWN barrel is forbidden too, and that is not an accident of banning
	// `$lib` wholesale — it is a circular import. Sibling modules here reach each other relatively.
	expect(FORBIDDEN_ALIAS.test("import type { Media } from '$lib/contract';")).toBe(true);
	expect(FORBIDDEN_ALIAS.test("import type { Media } from './core/types';")).toBe(false);
	expect(ESCAPING_RELATIVE.test("import { x } from './presentation/colors';")).toBe(false);
	expect(ESCAPING_RELATIVE.test("import { y } from '../core/types';")).toBe(false);
	// …and `$lib/server` is NOT this guard's business any more: the build refuses it. Pinned as a
	// deliberate non-assertion so nobody re-adds it thinking it was an oversight.
	expect(
		FORBIDDEN_ALIAS.test("import { db } from '$lib/server/db';"),
		'matches only because `$lib` is a prefix of it — SvelteKit is what actually enforces this one'
	).toBe(true);
});

test('the comment stripper does not blind the scan', () => {
	// The other half of the prose trap: stripping must remove an EXPLANATION of the banned import without
	// also removing a real one nearby. `code()` takes a path, so the transforms are mirrored inline here
	// against text — kept identical to the ones above, which is what this arm is really pinning.
	const strip = (s: string): string =>
		s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

	const withRealImport = strip(
		[
			"// This module must never import from '$lib/server/db' — it is browser-bundled.",
			"import { rotation } from './queue/rotation';",
			"/* nor '../lib/server/state' by the relative route */",
			"import { db } from '$lib/server/db';"
		].join('\n')
	);
	expect(FORBIDDEN_ALIAS.test(withRealImport), 'the real import on the last line must survive').toBe(true);

	const commentsOnly = strip(["// mentions '$lib/server/db'", "/* and '../lib/x' */"].join('\n'));
	expect(FORBIDDEN_ALIAS.test(commentsOnly)).toBe(false);
	expect(ESCAPING_RELATIVE.test(commentsOnly)).toBe(false);
});
