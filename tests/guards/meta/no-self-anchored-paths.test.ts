// guard: no test under `tests/` may derive a path from its own location — docs/ux/04-verification.md XR-VER-05.
//
// THE DEFECT THIS EXISTS FOR, AND IT IS NOT HYPOTHETICAL. The reorganisation moved 141 guards out of
// `src` into `tests/guards/`. Four separate agents moved files correctly and left their path
// arithmetic pointing at the old depth, so `join(import.meta.dir, '..')` — which had meant
// `src` — now meant `tests/guards/`. Sixty-one files ended up in that state.
//
// WHY NOTHING CAUGHT IT. Those sixty-one ran 207 pass / 1 fail. A guard whose scan root is wrong does not
// error: it walks the wrong tree, finds no violations there, and reports green. The agents had been told
// to confirm each file still passed, and it did — which is the whole problem, because passing is not
// evidence about WHERE a guard looked.
//
// AND THEIR NON-VACUITY FLOORS DID NOT CATCH IT EITHER. This is the part worth remembering: a floor
// protects against an EMPTY walk, not against a walk over the WRONG tree. `expect(files.length)
// .toBeGreaterThan(15)` is satisfied perfectly well by fifteen files in `tests/guards/`. XR-VER-05 closes
// the "scanned nothing" hole; it says nothing about "scanned the wrong thing". This guard closes that one.
//
// THE RULE. A test under `tests/` names its subject from the repo root, through `@encore/test-support`,
// never from where the test itself happens to sit. That is what makes the next reorganisation a `git mv`
// rather than a project, and it is the only form under which a wrong path fails LOUDLY: `read()` and
// `filesUnder()` throw on a miss, by design and for exactly this reason.

import { test, expect } from 'bun:test';
import { filesUnder, read, relative, at } from '@encore/test-support';
import { existsSync } from 'node:fs';

/**
 * Source with comments removed.
 *
 * Required, and the reason is on display in this very tree: four moved guards carry a COMMENT explaining
 * that they used to say `dirname(fileURLToPath(import.meta.url))` and no longer do. A raw text scan reads
 * those explanations as the defect they document. That trap has been hit repeatedly across this work, so
 * the stripper comes with a mutation arm below proving it does not also blind the scan.
 */
function codeOnly(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/(^|[\s;{(])\/\/[^\n]*/g, '$1 ');
}

/** The location-deriving idioms, all of them. A grep for one spelling misses the others. */
const SELF_ANCHOR = /import\.meta\.(?:dir|path|url)/;

/**
 * This file excludes itself, by path, and it has to.
 *
 * The mutation arms below carry the banned idioms as STRING LITERALS — that is how they prove the scan
 * still catches real code. A comment-stripper cannot help, because a fixture is not a comment; it is the
 * evidence. So the exemption is by path, documented, and singular: the same shape
 * `task-number-hygiene.test.ts` uses for the identical reason, where a guard must contain the pattern it
 * forbids in order to demonstrate that it works.
 *
 * The cost of the exemption is that this one file's own paths are unguarded. It has none: every path it
 * touches comes from `@encore/test-support`, which is the rule it enforces.
 */
const SELF = 'tests/guards/meta/no-self-anchored-paths.test.ts';

test('no test under tests/ derives a path from its own location', () => {
	const files = filesUnder('tests', ['.test.ts']);
	/*
	 * Non-vacuity: the walk reached the tree. Note what this floor can and cannot do — it proves the walk
	 * found FILES, not that it found the RIGHT files. That limit is exactly the gap this guard was written
	 * to cover, so it would be incoherent to lean on the floor alone here.
	 */
	expect(files.length).toBeGreaterThan(100); // @nvf-floor files.length

	const offenders = files
		.map((f) => relative(f))
		.filter((rel) => rel !== SELF && SELF_ANCHOR.test(codeOnly(read(rel))));

	// The exemption must stay exactly one file wide. An exemption list is how a ban stops meaning anything.
	expect(files.map((f) => relative(f)).filter((r) => r === SELF)).toHaveLength(1);

	expect(
		offenders,
		'a test under tests/ resolves a path from its own location. That silently re-points at the wrong ' +
			'tree the moment the file moves, and a wrong scan root does not error — it finds nothing and ' +
			'passes. Name the subject from the repo root instead: `at(...)`, `read(...)`, `filesUnder(...)` ' +
			'from @encore/test-support, all of which throw when the path is wrong.'
	).toEqual([]);
});

test('the scan reads code and not the comments that describe the defect', () => {
	/*
	 * Both directions in one arm. Four guards in this tree explain in prose that they USED to derive paths
	 * from their own location; those must not red. Real code must still be caught, including on a line that
	 * also carries a comment.
	 */
	const prose = "// was `join(import.meta.dir, '..')` before the move\nconst SRC = appSrc;";
	expect(SELF_ANCHOR.test(codeOnly(prose))).toBe(false);

	const block = '/*\n * `dirname(fileURLToPath(import.meta.url))` meant the routes dir it sat in.\n */\nconst X = at("apps");';
	expect(SELF_ANCHOR.test(codeOnly(block))).toBe(false);

	const real = "const SRC = join(import.meta.dir, '..');";
	expect(SELF_ANCHOR.test(codeOnly(real))).toBe(true);

	const mixed = "const SRC = join(import.meta.dir, '..'); // the source root";
	expect(SELF_ANCHOR.test(codeOnly(mixed))).toBe(true);

	// …and the other two spellings, which a grep for `import.meta.dir` alone would miss.
	expect(SELF_ANCHOR.test(codeOnly('const p = fileURLToPath(import.meta.url);'))).toBe(true);
	expect(SELF_ANCHOR.test(codeOnly('const self = import.meta.path;'))).toBe(true);
});

test('the anchors this guard points people at fail loudly rather than quietly', () => {
	/*
	 * The rule above is only safe because the replacement throws. If `read()` returned '' on a miss, moving
	 * a file would swap a loud error for a silent empty scan — the same defect in a new place. Pinned here
	 * so a future convenience overload cannot quietly remove the property this guard depends on.
	 */
	expect(() => read('src/does-not-exist.ts')).toThrow(/no file at/);
	expect(() => filesUnder('src/nope', ['.ts'])).toThrow(/no directory at/);
	expect(existsSync(at('bunfig.toml'))).toBe(true);
});
