// guard: the isomorphic contract cannot reach into the app — XR-VER-07.
//
// THIS GUARD REPLACES A STRUCTURAL GUARANTEE, AND THAT IS A DOWNGRADE WORTH STATING PLAINLY.
//
// `src/shared` was `packages/shared`, its own workspace package. Two facts made this rule unbreakable
// rather than merely unbroken:
//
//   * its `tsconfig.json` carried `paths: []` — zero aliases, so `$server` and `$lib` did not exist here
//   * its `package.json` declared no dependency on `apps/core`
//
// A shared module therefore could not import server code because the import was UNRESOLVABLE. Nobody had
// to remember the rule; the module graph enforced it.
//
// Folding the package into `apps/core/src/shared` destroys that. Every alias the app has is now in scope,
// so `import { db } from '$server/db'` in a file here would compile, typecheck, and pass every other test
// in this suite. What it would also do is ship the database client to every phone in the room, because
// `colors.ts` states the stake in its own header: this code is BROWSER-BUNDLED.
//
// So the boundary is now a test. A test can be deleted where a missing dependency cannot be wished away —
// that is the real cost of the fold, and it is recorded here rather than left for someone to discover.
//
// BOTH SPELLINGS ARE CLOSED. An alias ban alone is trivially defeated by `../server/db`, which resolves to
// exactly the same module, so relative escapes out of this directory are refused too.

import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { sharedSrc, filesUnder, relative } from '@encore/test-support';

/** Aliases that reach code this tree must not depend on. `$shared` itself is obviously fine. */
const FORBIDDEN_ALIAS = /(?:from|import)\s*\(?\s*['"](\$server|\$lib|\$app|\$env)(?:\/[^'"]*)?['"]/;
/** A relative path that climbs out of `src/shared` — the way round an alias ban. */
const ESCAPING_RELATIVE = /(?:from|import)\s*\(?\s*['"](\.\.\/(?:\.\.\/)*)(server|lib|routes)\//;

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
					`while this was a separate package with no aliases and no dependency on apps/core; this test ` +
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
	expect(FORBIDDEN_ALIAS.test("import { db } from '$server/db';")).toBe(true);
	expect(FORBIDDEN_ALIAS.test("import { page } from '$app/state';")).toBe(true);
	expect(FORBIDDEN_ALIAS.test("import { PUBLIC_X } from '$env/dynamic/public';")).toBe(true);
	expect(ESCAPING_RELATIVE.test("import { db } from '../server/db';")).toBe(true);
	expect(ESCAPING_RELATIVE.test("import { x } from '../../server/state/store';")).toBe(true);

	// …and the things this tree legitimately does.
	expect(FORBIDDEN_ALIAS.test("import { rotation } from './queue/rotation';")).toBe(false);
	expect(FORBIDDEN_ALIAS.test("import { test } from 'bun:test';")).toBe(false);
	expect(FORBIDDEN_ALIAS.test("import type { Media } from '$shared';")).toBe(false);
	expect(ESCAPING_RELATIVE.test("import { x } from './presentation/colors';")).toBe(false);
	expect(ESCAPING_RELATIVE.test("import { y } from '../core/types';")).toBe(false);
});

test('the comment stripper does not blind the scan', () => {
	// The other half of the prose trap: stripping must remove an EXPLANATION of the banned import without
	// also removing a real one nearby. `code()` takes a path, so the transforms are mirrored inline here
	// against text — kept identical to the ones above, which is what this arm is really pinning.
	const strip = (s: string): string =>
		s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

	const withRealImport = strip(
		[
			"// This module must never import from '$server/db' — it is browser-bundled.",
			"import { rotation } from './queue/rotation';",
			"/* nor '../server/state' by the relative route */",
			"import { db } from '$server/db';"
		].join('\n')
	);
	expect(FORBIDDEN_ALIAS.test(withRealImport), 'the real import on the last line must survive').toBe(true);

	const commentsOnly = strip(["// mentions '$server/db'", "/* and '../server/x' */"].join('\n'));
	expect(FORBIDDEN_ALIAS.test(commentsOnly)).toBe(false);
	expect(ESCAPING_RELATIVE.test(commentsOnly)).toBe(false);
});
