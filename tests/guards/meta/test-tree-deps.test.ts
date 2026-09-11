// guard: the test tree's own dependencies stay in lockstep with the package they test — XR-VER-05.
//
// WHY THIS EXISTS. Moving the tests into `tests/` moved them out of the reach of `apps/core/node_modules`.
// Node resolves a bare specifier by walking UP from the importing file, so a test at
// `apps/core/src/server/media/` found `drizzle-orm` and the same test at `tests/unit/core/server/media/`
// did not. Two tests failed with `Cannot find package 'drizzle-orm'`, which was the loud, honest version
// of the problem.
//
// The fix was to make `tests/` a workspace member that DECLARES what it imports. That introduces a new
// hazard in exchange: two manifests can now disagree about a version. A test asserting behaviour against a
// different drizzle than the app actually runs is worse than no test — it would be green about the wrong
// library. So the two declarations are pinned together here.
//
// This guard also refuses a SECOND thing, which is the more likely drift: a package imported by the test
// tree but declared nowhere. That resolves today only by accident of hoisting, and stops resolving the
// moment the dependency graph shifts.

import { test, expect } from 'bun:test';
import { read, filesUnder, relative } from '@encore/test-support';

/** Bare package specifiers, excluding builtins, path aliases and relative imports. */
function externalImports(src: string): string[] {
	/*
	 * STATEMENT-BASED, deliberately, after two regex attempts failed on this corpus.
	 *
	 * Scanning the whole file for `from '…'` does not work here, because these guards contain import-shaped
	 * text as DATA: mutation arms hold `import { sql } from 'drizzle-orm';` as a fixture, and other guards
	 * carry regex literals like `/from '@encore\/shared'/` as patterns. The first version reported
	 * `${wanted}`, `$lib\`, and a fragment of another guard's test body as packages.
	 *
	 * An import is a STATEMENT, so a line that is one begins with `import` or `export`. A fixture never
	 * does — it begins with `const`, `expect(`, or similar. That single structural fact separates the two
	 * cleanly, where no amount of string-blanking did. Dynamic `await import('x')` is allowed anywhere on a
	 * line, since it is genuinely a call rather than a statement.
	 */
	const out: string[] = [];
	const push = (spec: string): void => {
		if (/^[./]/.test(spec)) return; // relative
		if (/^(node:|bun:)/.test(spec)) return; // builtin
		if (/^(\$lib|\$server|\$app|\$env)/.test(spec)) return; // tsconfig path alias
		if (/^@encore\//.test(spec)) return; // workspace sibling, resolved by alias
		out.push(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);
	};
	for (const raw of src.split('\n')) {
		const line = raw.trim();
		if (line.startsWith('//') || line.startsWith('*')) continue;
		if (/^(?:import|export)\b/.test(line)) {
			const m = /from\s*'([^']+)'/.exec(line) ?? /^import\s*'([^']+)'/.exec(line);
			if (m) push(m[1]!);
			continue;
		}
		// a dynamic import is a call, so it can sit anywhere — but only count it outside a quoted fixture
		for (const m of line.matchAll(/(?<!['"`].{0,200})\bawait import\(\s*'([^']+)'\s*\)/g)) push(m[1]!);
	}
	return out;
}

const testsManifest = JSON.parse(read('tests/package.json')) as {
	devDependencies?: Record<string, string>;
};
const coreManifest = JSON.parse(read('apps/core/package.json')) as {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
};
const rootManifest = JSON.parse(read('package.json')) as {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
};

const declaredForTests = testsManifest.devDependencies ?? {};
const coreAll = { ...(coreManifest.dependencies ?? {}), ...(coreManifest.devDependencies ?? {}) };
const rootAll = { ...(rootManifest.dependencies ?? {}), ...(rootManifest.devDependencies ?? {}) };

test('every external package the test tree imports is declared somewhere it can resolve from', () => {
	const files = filesUnder('tests', ['.test.ts', '.svelte']);
	// Non-vacuity: the walk found the tree. As ever this proves it found FILES, not the right ones — which
	// is why the assertion below names the packages rather than counting them.
	expect(files.length).toBeGreaterThan(200); // @nvf-floor files.length

	const seen = new Set<string>();
	for (const f of files) for (const p of externalImports(read(relative(f)))) seen.add(p);

	const undeclared = [...seen]
		.filter((p) => !(p in declaredForTests) && !(p in rootAll))
		.sort();

	expect(
		undeclared,
		'the test tree imports a package that neither tests/package.json nor the root manifest declares. ' +
			'It resolves today only by where node_modules happens to be hoisted, and will stop the moment the ' +
			'dependency graph shifts — which is exactly how moving these tests broke drizzle-orm. Declare it ' +
			'in tests/package.json, where the import lives.'
	).toEqual([]);
});

test('a package declared for the tests matches the version the app under test runs', () => {
	// Non-vacuity: there is something to compare. An emptied tests manifest would make this vacuous.
	expect(Object.keys(declaredForTests).length).toBeGreaterThanOrEqual(1); // @nvf-floor Object.keys(declaredForTests).length

	const drifted = Object.entries(declaredForTests)
		.filter(([name]) => name in coreAll)
		.filter(([name, range]) => coreAll[name] !== range)
		.map(([name, range]) => `${name}: tests wants ${range}, apps/core runs ${coreAll[name]}`);

	expect(
		drifted,
		'the test tree and the app disagree on a package version. A test asserting behaviour against a ' +
			'different library than the app runs is worse than no test: it is green about the wrong thing. ' +
			'Move both declarations together.'
	).toEqual([]);
});

test('the scan reads import STATEMENTS and not import-shaped fixtures', () => {
	/*
	 * The corpus this scans deliberately contains import-shaped text as data, so both directions matter.
	 * A real statement is caught; the same text as a fixture, a comment or a regex literal is not.
	 */
	const q = String.fromCharCode(39);
	const stmt = (spec: string) => 'import { x } from ' + q + spec + q + ';';

	// real statements
	expect(externalImports(stmt('drizzle-orm'))).toEqual(['drizzle-orm']);
	expect(externalImports(stmt('@scope/pkg/deep/path'))).toEqual(['@scope/pkg']);
	expect(externalImports('const m = await import(' + q + 'some-pkg' + q + ');')).toEqual(['some-pkg']);

	// the exclusions
	expect(externalImports(stmt('bun:test'))).toEqual([]);
	expect(externalImports(stmt('$lib/foo'))).toEqual([]);
	expect(externalImports(stmt('@encore/shared'))).toEqual([]);
	expect(externalImports(stmt('./sibling'))).toEqual([]);

	// import-shaped text that is NOT a statement — the cases that broke two earlier versions
	expect(externalImports('// was ' + stmt('vite') + ' before the move')).toEqual([]);
	expect(externalImports(' * ' + stmt('vite'))).toEqual([]);
	expect(externalImports('const fixture = "' + stmt('drizzle-orm') + '";')).toEqual([]);
	expect(externalImports('const re = /from ' + q + '@encore\\/shared' + q + '/;')).toEqual([]);
	expect(externalImports('expect(scan(' + q + 'x' + q + ')).toEqual([]);')).toEqual([]);
});
