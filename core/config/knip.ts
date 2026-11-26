/*
 * Dead-code detection config for `bun run deadcode`.
 *
 * It is `.ts` and not `.json` for one reason: `compilers` takes a function. Without that hook knip
 * does not parse `.svelte` at all, so every import written inside a `<script>` block is invisible and
 * the module graph collapses — which reports entry routes and their whole dependency trees as dead.
 *
 * A clean run is ZERO findings, so a non-zero run is worth reading. A finding that is not real belongs
 * here as an ignore with a reason, or gets a `/** @knipignore *\/` tag at its declaration.
 */
import type { KnipConfig } from 'knip';

const config: KnipConfig = {
	// `server.ts`, `vite.config.ts`, `drizzle.config.ts` and `eslint.config.mjs` are deliberately absent:
	// knip auto-detects those and listing them is reported back as a redundant pattern.
	entry: [
		'src/service-worker.ts',
		'src/app.html',
		'src/routes/**/+page.{svelte,ts}',
		'src/routes/**/+page.server.ts',
		'src/routes/**/+layout.{svelte,ts}',
		'src/routes/**/+error.svelte',
		'src/routes/**/+server.ts',
		// The dev-only /components stories, mounted by `+page.devsvelte` routes knip does not parse (#1143).
		'src/lib/gallery/*.svelte',
		'tests/**/*.test.ts',
		// Playwright discovers specs by its own `testDir`, so nothing imports them either. `world/**` IS imported
		// by the specs, so the graph covers it from here. `playwright.config.ts` is auto-detected by knip's
		// Playwright plugin, like the configs above.
		'tests/playwright/**/*.spec.ts'
	],
	project: ['src/**/*.{ts,svelte}', 'tests/**/*.{ts,mjs}'],
	// shadcn-generated: the library exposes its whole surface on purpose and `shadcn-svelte add <name>`
	// rewrites these, so an unused re-export here is the intended state rather than drift.
	ignore: ['src/lib/components/ui/**'],
	// Both are real and neither is ever imported: `shadcn-svelte` is the re-vendoring CLI, and
	// `svelte-check` is invoked through `bun --bun`, which knip cannot see. `node:sqlite` is a Node built-in, not a
	// package: dock-idle-play.spec.ts opens the test DB with it, and knip run under Bun reports it as unlisted.
	ignoreDependencies: ['shadcn-svelte', 'svelte-check', 'node:sqlite'],
	// The worker is Python and uv-managed; the gates call `uv`, which is not a JS binary.
	ignoreBinaries: ['uv'],
	// SvelteKit/Vite virtual modules — synthesised at build time. No test resolves them any more: the
	// component-mount harness that stubbed `$app/*` under `bun test` is gone, and so are the tests that
	// mounted route components.
	ignoreUnresolved: [/^\$app\//, /^\$service-worker$/],
	// An export used inside its own file is over-exported, not dead.
	ignoreExportsUsedInFile: true,
	tags: ['-knipignore'],
	compilers: {
		// Concatenate every `<script>` block: imports and the module script both live there, and
		// everything outside them is markup that carries no module graph.
		svelte: (text: string) =>
			[...text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
	}
};

export default config;
