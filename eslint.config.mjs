// Flat ESLint config for the Encore monorepo (apps/core + apps/core/src/shared).
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
		// The `.mjs` extension is here deliberately: `tests/e2e/**` is 40 browser-driving drivers run by
		// `bun run`, and they are not in any tsconfig program. When the e2e tree moved under `tests/`, the
		// lint glob covered only `{ts,svelte}` there, so all 40 silently dropped out of coverage — visible
		// only because the warning count fell from 82 to 41. Second time that shape has bitten in this
		// reorganisation, hence the extension list rather than a bare `*.ts`.
		files: ['tests/e2e/**/*.{ts,mjs}', 'apps/core/scripts/**/*.ts', 'apps/core/*.config.ts'],
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

	// The TEST TREE. It has its own tsconfig (tests/tsconfig.json), so the type service resolves here and
	// type-aware rules apply exactly as they do to source — an unawaited promise in a test is as real a
	// defect as one in production.
	//
	// This block exists because the reorganisation moved the tests OUT of `apps/core/src/**`, and every
	// rule customisation was scoped to that path. The tests silently fell back to the recommended
	// defaults, which do not carry this repo's `^_` convention for a deliberately-unused binding — so 24
	// `_m` / `_url` / `_id` parameters read as errors while being exactly what the convention prescribes.
	// The lint script did not glob `tests/` either, so none of it was visible.
	{
		files: ['tests/**/*.ts'],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: { projectService: true },
			globals: { ...globals.node, ...globals.browser, Bun: 'readonly' }
		},
		rules: {
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
		}
	},

	// Test HARNESS components. These are Svelte fixtures a mount test imports; they are not in any
	// tsconfig's program, so the project service cannot resolve them and the type-aware Svelte block
	// above fails to parse them outright. Same treatment as e2e/** and scripts/**: syntactic and
	// unused-variable rules only, no type-aware rules, and no program to build — which is also why this
	// block is cheap.
	{
		files: ['tests/**/*.harness.svelte'],
		languageOptions: {
			parser: svelteParser,
			parserOptions: {
				parser: tseslint.parser,
				projectService: false,
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
