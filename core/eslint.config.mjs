// Flat ESLint config. Structural rules are errors; pervasive stylistic ones are `warn`, and
// `bun run lint` fails only on errors.
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
			'build/**',
			'.svelte-kit/**',
			'dist/**',
			'**/*.d.ts'
		]
	},
	js.configs.recommended,
	...tseslint.configs.recommended,

	// Typed TypeScript: everything in the app tsconfig's program, where type-aware rules work.
	{
		files: ['src/**/*.ts'],
		// The service worker must be excluded HERE, not merely covered by a later block: flat config
		// applies every matching block, so `no-floating-promises` would still reach a file SvelteKit keeps
		// out of the program, and eslint crashes rather than skipping it.
		ignores: ['src/service-worker.ts'],
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

	// Files in no tsconfig program: syntactic and unused-variable rules only. `server.ts` belongs to
	// `tsconfig.server.json` and the service worker is excluded by SvelteKit, so both are type-checked
	// elsewhere. The `tests/e2e/**/*.mjs` glob that used to head this list is gone with that tree — the
	// Playwright suite is `.ts` under `tests/playwright/`, which the type-aware `tests/**/*.ts` block below
	// already covers, so those specs get the stronger rules rather than these.
	{
		files: ['*.config.ts', 'src/service-worker.ts', 'server.ts'],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: { projectService: false },
			globals: { ...globals.node, ...globals.browser, Bun: 'readonly' }
		},
		rules: {
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
		}
	},

	// No type gate covers `.mjs` at all, so `no-undef` earns its keep here. Probes run Node-side but embed
	// page.evaluate() strings, so the browser globals are in scope too.
	{
		files: ['**/*.mjs'],
		languageOptions: {
			globals: { ...globals.node, ...globals.browser, Bun: 'readonly' }
		},
		rules: {
			// A `\\s` inside a page.evaluate() template is a correct escape for the string that reaches the
			// browser, but reads as useless to the .mjs parser. Real useless escapes in `.ts` still error.
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

	// RUNE MODULES (`*.svelte.ts`), which `svelte.configs.recommended` above claims with the Svelte parser alone — so
	// the first one in the tree failed to parse at its first `interface`, before any rule ran. The fix is the nested
	// TypeScript parser, the same pairing the `.svelte` block uses, plus the type-aware rules that block drops: the
	// typed-source block at the top of this file matches these files too, but flat config applies every matching block
	// and the LAST `languageOptions` wins, so the rules have to be restated here rather than inherited.
	// NOTE FOR ANYONE EDITING THESE COMMENTS: a glob holding `*` followed by `/` cannot go in a `/* */` comment — it
	// closes it, and eslint then dies with a parse error in its own config.
	{
		files: ['**/*.svelte.ts'],
		languageOptions: {
			parser: svelteParser,
			parserOptions: {
				parser: tseslint.parser,
				projectService: true,
				extraFileExtensions: ['.svelte']
			},
			globals: { ...globals.browser, ...globals.node }
		},
		rules: {
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
		}
	},

	// The test tree has its own tsconfig, so type-aware rules apply exactly as they do to source — an
	// unawaited promise in a test is as real a defect as one in production. It needs its own block to
	// carry the repo's `^_` convention for a deliberately-unused binding.
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

	// Pervasive and non-structural: kept visible as warnings rather than swept.
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
