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
import { at, filesUnder, read, relative } from '@encore/test-support';
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
 * `createRequire(import.meta.url)` is not a path derivation and must not be read as one.
 *
 * It is the standard way to get a CJS `require` inside ESM, and what it resolves is a PACKAGE
 * ("svelte/package.json"), not a location in this repo. Its answer does not change when the calling
 * file moves, so it carries none of the fragility this guard exists to prevent. Neutralised before
 * matching rather than exempting the whole file, so the rest of that file stays guarded.
 */
function withoutModuleResolution(src: string): string {
	return src.replace(/createRequire\(\s*import\.meta\.url\s*\)/g, 'createRequire(/*pkg*/)');
}

/**
 * The files that legitimately derive their own location, because each one DEFINES a repo-root anchor
 * that everything else imports. They cannot use the anchor they are.
 *
 * This list is the whole reason the ban can be widened past `*.test.ts`: it stays at three because
 * the drivers that used to inline a private copy of the `bunfig.toml` walk — six of them — now share
 * `tests/e2e/lib/repo-root.mjs` instead.
 */
const ANCHORS: readonly string[] = [
	// The harness anchor. Every guard's `at`/`read`/`filesUnder` resolves through this walk.
	'tests/support/src/tree.ts',
	// Bun's test preload. It runs before any alias exists, so it must find the root unaided.
	'tests/setup/svelte-dom-preload.ts',
	// The e2e anchor, for drivers that run under bare `bun run` where the alias does not resolve.
	'tests/e2e/lib/repo-root.mjs'
];

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

test('no file under tests/ derives a path from its own location', () => {
	/*
	 * `.ts` AND `.mjs`, not just `.test.ts`. The narrower walk is how six e2e drivers came to resolve
	 * their repo root one hop short — to `tests/` rather than the root — and stayed that way: none of
	 * them is a `*.test.ts`, so none was ever in this guard's scope. `.ts` subsumes `.test.ts`.
	 */
	const files = filesUnder('tests', ['.ts', '.mjs']);
	/*
	 * Non-vacuity: the walk reached the tree. Note what this floor can and cannot do — it proves the walk
	 * found FILES, not that it found the RIGHT files. That limit is exactly the gap this guard was written
	 * to cover, so it would be incoherent to lean on the floor alone here.
	 *
	 * Raised 100 -> 300 when the walk widened from `.test.ts` (292 files) to `.ts` + `.mjs` (341).
	 * Measured by reading the received count, not incremented by eye.
	 */
	expect(files.length).toBeGreaterThan(300); // @nvf-floor files.length

	const exempt = new Set<string>([SELF, ...ANCHORS]);
	const offenders = files
		.map((f) => relative(f))
		.filter(
			(rel) => !exempt.has(rel) && SELF_ANCHOR.test(withoutModuleResolution(codeOnly(read(rel))))
		);

	// The exemption must stay exactly one file wide. An exemption list is how a ban stops meaning anything.
	expect(files.map((f) => relative(f)).filter((r) => r === SELF)).toHaveLength(1);

	/*
	 * Every exemption must still exist and must still self-anchor. A stale entry is how an exemption
	 * list silently widens: the file it named moved or stopped needing it, and the entry now sits there
	 * excusing nothing while looking load-bearing.
	 */
	for (const anchor of ANCHORS) {
		expect(existsSync(at(anchor)), `exempted anchor ${anchor} does not exist`).toBe(true);
		expect(
			SELF_ANCHOR.test(withoutModuleResolution(codeOnly(read(anchor)))),
			`${anchor} is exempted as a root anchor but no longer derives its own location — drop the exemption`
		).toBe(true);
	}
	expect(ANCHORS).toHaveLength(3);

	expect(
		offenders,
		'a file under tests/ resolves a path from its own location. That silently re-points at the wrong ' +
			'tree the moment the file moves, and a wrong scan root does not error — it finds nothing and ' +
			'passes. Name the subject from the repo root instead: `at(...)`, `read(...)`, `filesUnder(...)` ' +
			'from @encore/test-support, or `repoRoot`/`atRepo(...)` from tests/e2e/lib/repo-root.mjs in a ' +
			'driver that runs under bare `bun run`.'
	).toEqual([]);
});

test('the scan reads code and not the comments that describe the defect', () => {
	/*
	 * Both directions in one arm. Four guards in this tree explain in prose that they USED to derive paths
	 * from their own location; those must not red. Real code must still be caught, including on a line that
	 * also carries a comment.
	 */
	const prose = "// was `join(import.meta.dir, '..')` before the move\nconst SRC = srcDir;";
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

test('module resolution is not mistaken for path arithmetic, and real anchoring still is', () => {
	/*
	 * `createRequire(import.meta.url)` resolves a PACKAGE and is location-independent, so it must not
	 * red. Everything else in a file that uses it stays guarded — hence the narrow neutralisation rather
	 * than a file-level exemption.
	 */
	const pkg = "const require_ = createRequire(import.meta.url);\nconst svelte = require_.resolve('svelte');";
	expect(SELF_ANCHOR.test(withoutModuleResolution(codeOnly(pkg)))).toBe(false);

	// Spaced and multi-line spellings of the same idiom.
	expect(SELF_ANCHOR.test(withoutModuleResolution('createRequire( import.meta.url )'))).toBe(false);

	// A file that uses createRequire AND derives a path is still caught, on the second count.
	const both = "const r = createRequire(import.meta.url);\nconst SRC = join(import.meta.dir, '..', 'src');";
	expect(SELF_ANCHOR.test(withoutModuleResolution(codeOnly(both)))).toBe(true);

	// The neutraliser must not swallow a bare `import.meta.url` that is not inside createRequire().
	expect(SELF_ANCHOR.test(withoutModuleResolution("const d = new URL('../..', import.meta.url);"))).toBe(true);
});

test('the walk covers .mjs, which is where the defect that widened it lived', () => {
	/*
	 * The six probes resolved their root one hop short for as long as this guard read only `*.test.ts`.
	 * Pinned so a future narrowing of the extension list is a visible decision rather than a quiet
	 * regression: every driver under tests/e2e/ must be in scope.
	 */
	const scanned = filesUnder('tests', ['.ts', '.mjs']).map((f) => relative(f));
	expect(scanned).toContain('tests/e2e/driver.mjs');
	expect(scanned).toContain('tests/e2e/probes/p2-guiding-track.mjs');
	expect(scanned).toContain('tests/e2e/gates/measured-design.mjs');
	// and the `.test.ts` tree the narrower walk used to cover, which `.ts` subsumes
	expect(scanned).toContain('tests/guards/meta/non-vacuity-floors.test.ts');

	const mjs = scanned.filter((r) => r.endsWith('.mjs'));
	expect(mjs.length).toBeGreaterThan(30); // @nvf-floor mjs.length
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
