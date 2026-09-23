// guard: the test tree's own dependencies stay in lockstep with the package they test.
//
// Node resolves a bare specifier by walking UP from the importing file, so moving these tests into `tests/`
// broke `drizzle-orm` for two of them. Two hazards are pinned here: a package the test tree imports but no
// manifest declares resolves today only by where node_modules happens to be hoisted, and a test asserting
// behaviour against a different version than the app runs would be green about the wrong library.

import { test, expect } from 'bun:test';
import { filesUnder, read, relative } from '@encore/test-support';

/** Bare package specifiers, excluding builtins, path aliases and relative imports. */
function externalImports(src: string): string[] {
	/*
	 * STATEMENT-BASED, deliberately, after two regex attempts failed on this corpus: these guards hold
	 * import-shaped text as DATA (mutation fixtures, regex literals), and scanning for `from '…'` anywhere
	 * reported `${wanted}`, `$lib\` and a fragment of another guard's body as packages. An import is a
	 * STATEMENT, so its line begins with `import`/`export`; a fixture begins with `const` or `expect(`.
	 */
	const out: string[] = [];
	const push = (spec: string): void => {
		if (/^[./]/.test(spec)) return; // relative
		if (/^(node:|bun:)/.test(spec)) return; // builtin
		if (/^(\$lib|\$lib\/contract|\$app|\$env|\$routes|\$setup|\$e2e)/.test(spec)) return; // path alias; $lib covers $lib/server
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

// ONE manifest: the app's package.json is the root manifest, so a test resolves a package by walking up.
const manifest = JSON.parse(read('package.json')) as {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
};

const declared = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };

test('every external package the test tree imports is declared somewhere it can resolve from', () => {
	const files = filesUnder('tests', ['.test.ts', '.svelte']);
	// Non-vacuity: the walk found FILES, not necessarily the right ones — hence naming the packages below.
	expect(files.length).toBeGreaterThan(200); // @nvf-floor files.length

	const seen = new Set<string>();
	for (const f of files) for (const p of externalImports(read(relative(f)))) seen.add(p);

	const undeclared = [...seen].filter((p) => !(p in declared)).sort();

	expect(
		undeclared,
		'the test tree imports a package the root manifest does not declare. ' +
			'It resolves today only by where node_modules happens to be hoisted, and will stop the moment the ' +
			'dependency graph shifts — which is exactly how moving these tests broke drizzle-orm. Declare it ' +
			'in tests/package.json, where the import lives.'
	).toEqual([]);
});

test('the scan reads import STATEMENTS and not import-shaped fixtures', () => {
	// Both directions: a real statement is caught, and the same text as a fixture, comment or regex is not.
	const q = String.fromCharCode(39);
	const stmt = (spec: string) => 'import { x } from ' + q + spec + q + ';';

	// real statements
	expect(externalImports(stmt('drizzle-orm'))).toEqual(['drizzle-orm']);
	expect(externalImports(stmt('@scope/pkg/deep/path'))).toEqual(['@scope/pkg']);
	expect(externalImports('const m = await import(' + q + 'some-pkg' + q + ');')).toEqual(['some-pkg']);

	// the exclusions
	expect(externalImports(stmt('bun:test'))).toEqual([]);
	expect(externalImports(stmt('$lib/foo'))).toEqual([]);
	expect(externalImports(stmt('$lib/contract'))).toEqual([]);
	expect(externalImports(stmt('./sibling'))).toEqual([]);

	// import-shaped text that is NOT a statement — the cases that broke two earlier versions
	expect(externalImports('// was ' + stmt('vite') + ' before the move')).toEqual([]);
	expect(externalImports(' * ' + stmt('vite'))).toEqual([]);
	expect(externalImports('const fixture = "' + stmt('drizzle-orm') + '";')).toEqual([]);
	expect(externalImports('const re = /from ' + q + '@encore\\/shared' + q + '/;')).toEqual([]);
	expect(externalImports('expect(scan(' + q + 'x' + q + ')).toEqual([]);')).toEqual([]);
});
