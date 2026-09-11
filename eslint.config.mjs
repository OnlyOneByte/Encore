// Flat ESLint config for the Encore monorepo (apps/core + packages/shared).
//
// Before this file the repo had NO lint gate — only svelte-check, which is a TYPE gate, not a lint
// gate. ESLint catches what tsc/svelte-check structurally cannot: floating promises, unused vars
// and imports, no-undef in the .mjs scripts and e2e probes that no type gate covers, and
// eslint-plugin-svelte's reactivity/a11y rules.
//
// CALIBRATION: introducing a linter to a mature, previously-unlinted 300-file tree
// surfaces a large tail of pre-existing findings. High-value STRUCTURAL rules are errors and their
// violations are fixed in this change. Rules that are pervasive and stylistic (empty catch blocks
// that are intentional here, a batch of opinionated svelte/* suggestions) are set to `warn` so the
// gate is green and the config diff stays reviewable; those cleanups are follow-up work, not a
// config PR. `bun run lint` fails only on errors.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import svelteParser from 'svelte-eslint-parser';
import globals from 'globals';

export default tseslint.config(
	{
		// Generated, vendored, or non-source trees never get linted.
		ignores: [
			'**/node_modules/**',
			'apps/core/build/**',
			'apps/core/.svelte-kit/**',
			'apps/core/dist/**',
			'**/*.d.ts'
		]
	},
	js.configs.recommended,
	...tseslint.configs.recommended,

	// Typed TypeScript: everything in a tsconfig's program. Type-aware rules (no-floating-promises)
	// need this. e2e/**, scripts/** and *.config.ts are NOT in any tsconfig yet (tracked separately),
	// so they are linted without the type service in the block below.
	{
		files: ['apps/core/src/**/*.ts', 'packages/**/*.ts'],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: { projectService: true },
			globals: { ...globals.node, Bun: 'readonly' }
		},
		rules: {
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
		}
	},

	// Out-of-tsconfig TypeScript (e2e/**, scripts/**, *.config.ts). Syntactic + unused rules only;
	// no type-aware rules because there is no program for these files (follow-up work).
	{
		files: ['apps/core/e2e/**/*.ts', 'apps/core/scripts/**/*.ts', 'apps/core/*.config.ts'],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: { projectService: false },
			globals: { ...globals.node, ...globals.browser, Bun: 'readonly' }
		},
		rules: {
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
		}
	},

	// The .mjs scripts and e2e probes — no type gate covers these at all, so no-undef earns its keep
	// (it just caught a missing SEL import in p10-scaling.mjs). Bun and the browser DOM are both in
	// scope: probes run Node-side but embed page.evaluate() strings that reference DOM.
	{
		files: ['apps/**/*.mjs', 'packages/**/*.mjs'],
		languageOptions: {
			globals: { ...globals.node, ...globals.browser, Bun: 'readonly' }
		},
		rules: {
			// e2e probes embed browser regex inside page.evaluate() template strings, where a `\\s`
			// is a correct escape for the string that reaches the browser but reads as a useless
			// escape to the .mjs parser. Off here; real useless escapes in .ts still error.
			'no-useless-escape': 'off'
		}
	},

	// Svelte components run in the browser.
	...svelte.configs.recommended,
	{
		files: ['**/*.svelte'],
		languageOptions: {
			parser: svelteParser,
			parserOptions: {
				parser: tseslint.parser,
				projectService: true,
				extraFileExtensions: ['.svelte']
			},
			globals: { ...globals.browser, ...globals.node }
		}
	},

	// Repo-wide severity calibration (see header). These are pre-existing, pervasive, and not
	// structural defects; kept visible as warnings rather than swept in a config change.
	{
		rules: {
			'no-empty': 'warn',
			'@typescript-eslint/no-explicit-any': 'warn',
			'svelte/no-navigation-without-resolve': 'warn',
			'svelte/prefer-svelte-reactivity': 'warn',
			'svelte/no-useless-mustaches': 'warn',
			'svelte/prefer-writable-derived': 'warn',
			'svelte/require-each-key': 'warn',
			'svelte/no-at-html-tags': 'warn'
		}
	},

	// Test files legitimately import export-for-test-only symbols and use `any` freely.
	{
		files: ['**/*.test.ts', '**/*.spec.ts'],
		rules: {
			'@typescript-eslint/no-explicit-any': 'off'
		}
	}
);
