// guard: no test under `tests/` may derive a path from its own location — XR-VER-md.
//
// Caught 61 guards left aimed at the old depth after a move: `join(import.meta.dir, '..')` silently
// re-pointed at the wrong tree, and a guard with a wrong scan root finds nothing and passes GREEN. A
// non-vacuity floor cannot catch that — it proves a walk found FILES, not the RIGHT files. Tests name
// their subject from the repo root through `@encore/test-support`, whose `read`/`filesUnder` throw on a
// miss. See docs/GUARDS.md#the-hygiene-and-meta-guards.

import { test, expect } from 'bun:test';
import { at, filesUnder, read, relative } from '@encore/test-support';
import { existsSync } from 'node:fs';

/**
 * Source with comments removed. Required: four moved guards explain IN A COMMENT that they used to say
 * `dirname(fileURLToPath(import.meta.url))`, and a raw text scan reads those explanations as the defect
 * they document. The mutation arm below proves the stripper does not also blind the scan.
 */
function codeOnly(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[\s;{(])\/\/[^\n]*/g, '$1 ');
}

/** The location-deriving idioms, all of them. A grep for one spelling misses the others. */
const SELF_ANCHOR = /import\.meta\.(?:dir|path|url)/;

/**
 * `createRequire(import.meta.url)` resolves a PACKAGE, not a location, so its answer does not change when
 * the calling file moves. Neutralised narrowly rather than exempting the file, so the rest stays guarded.
 */
function withoutModuleResolution(src: string): string {
	return src.replace(/createRequire\(\s*import\.meta\.url\s*\)/g, 'createRequire(/*pkg*/)');
}

/** The files that may self-anchor: each DEFINES a repo-root anchor, so it cannot use the anchor it is. */
const ANCHORS: readonly string[] = [
	// The harness anchor. Every guard's `at`/`read`/`filesUnder` resolves through this walk.
	'tests/support/src/tree.ts',
	// Bun's test preload: it runs before any alias exists, so it must find the root unaided.
	'tests/setup/svelte-dom-preload.ts',
	// The e2e anchor, for drivers that run under bare `bun run` where the alias does not resolve.
	'tests/e2e/lib/repo-root.mjs'
];

/**
 * Self-exempt BY PATH, because the mutation arms below carry the banned idioms as STRING FIXTURES — that
 * is how they prove the scan still catches real code, and a comment-stripper cannot spare a fixture. Every
 * path this file touches comes from `@encore/test-support` anyway, which is the rule it enforces.
 */
const SELF = 'tests/guards/meta/no-self-anchored-paths.test.ts';

test('no file under tests/ derives a path from its own location', () => {
	// `.ts` AND `.mjs`, not just `.test.ts`: six e2e drivers are neither, so for as long as the walk read
	// only `*.test.ts` they resolved their repo root one hop short and stayed that way.
	const files = filesUnder('tests', ['.ts', '.mjs']);
	// Non-vacuity: the walk reached the tree. It proves FILES were found, not the RIGHT ones — the very gap
	// this guard covers, so the floor alone would be incoherent here.
	expect(files.length).toBeGreaterThan(300); // @nvf-floor files.length

	const exempt = new Set<string>([SELF, ...ANCHORS]);
	const offenders = files
		.map((f) => relative(f))
		.filter((rel) => !exempt.has(rel) && SELF_ANCHOR.test(withoutModuleResolution(codeOnly(read(rel)))));

	// The exemption must stay exactly one file wide. An exemption list is how a ban stops meaning anything.
	expect(files.map((f) => relative(f)).filter((r) => r === SELF)).toHaveLength(1);

	// Every exemption must still exist and still self-anchor — a stale entry excuses nothing while looking
	// load-bearing, which is how an exemption list silently widens.
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
	// Both directions: prose describing the old idiom must not red, and real code must, including on a line
	// that also carries a comment.
	const prose = "// was `join(import.meta.dir, '..')` before the move\nconst SRC = srcDir;";
	expect(SELF_ANCHOR.test(codeOnly(prose))).toBe(false);

	const block =
		'/*\n * `dirname(fileURLToPath(import.meta.url))` meant the routes dir it sat in.\n */\nconst X = at("apps");';
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
	// `createRequire(import.meta.url)` is location-independent and must not red; everything else in such a
	// file stays guarded, hence the narrow neutralisation.
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

test('the walk covers.mjs, which is where the defect that widened it lived', () => {
	// Pinned so a future narrowing of the extension list is a visible decision: the `.mjs` drivers, which is
	// where the defect that widened this walk lived, must stay in scope.
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
	// The rule is only safe because the replacement throws. A `read()` that returned '' on a miss would swap
	// a loud error for a silent empty scan — the same defect in a new place.
	expect(() => read('src/does-not-exist.ts')).toThrow(/no file at/);
	expect(() => filesUnder('src/nope', ['.ts'])).toThrow(/no directory at/);
	expect(existsSync(at('bunfig.toml'))).toBe(true);
});
