/*
 * Dead-code detection config. Run it with `bun run deadcode`.
 *
 * WHY THIS FILE EXISTS. Unconfigured, knip reported 479 findings here of which ~7 were real — a 98%
 * false-positive rate, which makes the tool worse than nothing because the signal is unfindable. Two
 * causes, both fixed below:
 *
 *   1. It does not know SvelteKit's conventions, so every `+page.svelte` / `+server.ts` /
 *      `+layout.svelte` read as unreachable. Worse, imports INSIDE a file knip thinks is unreachable
 *      are not counted either, so the whole dependency graph collapsed: that is where the phantom
 *      "99 unused files" and all four "unused dependencies" came from. `entry` below names the real
 *      entry points.
 *   2. It does not parse `.svelte` on its own, so an import written inside a component's `<script>`
 *      block is invisible. Every remaining false positive traced to that — `$lib/contract` re-exports
 *      consumed by `settings/+page.svelte`, a type consumed by `SongRow.svelte`. The `compilers.svelte`
 *      hook hands knip just the script contents, which is what closes it.
 *
 * WHY .ts AND NOT .json. `compilers` takes a function, so this config cannot be JSON. Everything else
 * here would have fit in `knip.json`; the compiler is the one thing that does not, and without it the
 * report keeps five false positives that each look exactly like real dead code.
 *
 * With both fixed the report is 3 findings, and each one is explainable — see docs in this file's
 * commit. Keep it that way: a finding that is NOT real belongs in this config as an ignore WITH a
 * reason, so the next reader can tell a deliberate exemption from an oversight.
 */
import type { KnipConfig } from 'knip';

const config: KnipConfig = {
	// SvelteKit's real entry points. `server.ts`, `vite.config.ts`, `drizzle.config.ts` and
	// `eslint.config.mjs` are deliberately absent: knip auto-detects those and listing them is
	// reported back as a redundant pattern.
	entry: [
		'src/service-worker.ts',
		'src/app.html',
		'src/routes/**/+page.{svelte,ts}',
		'src/routes/**/+page.server.ts',
		'src/routes/**/+layout.{svelte,ts}',
		'src/routes/**/+server.ts',
		// Test entry points. The e2e drivers are SPAWNED BY NAME, never imported, so nothing in a static
		// import graph reaches them — the same reason tests/guards/meta/e2e-reachability.test.ts walks
		// basenames rather than imports.
		'tests/setup/**/*.ts',
		'tests/**/*.test.ts',
		'tests/e2e/**/*.mjs',
		'tests/e2e/contract.ts'
	],
	project: ['src/**/*.{ts,svelte}', 'tests/**/*.{ts,mjs}'],
	// shadcn-generated. A component library exposes its whole surface on purpose and a re-vendor
	// (`shadcn-svelte add <name>`) rewrites these, so unused re-exports here are the intended state,
	// not drift. 56 exports + 6 types came from this one directory.
	ignore: ['src/lib/components/ui/**'],
	// Both are real, and neither is ever imported: `shadcn-svelte` is the CLI that re-vendors
	// components/ui (see its README), and `svelte-check` is invoked by `bun run check` /
	// `typecheck:app` through `bun --bun`, which knip cannot see.
	ignoreDependencies: ['shadcn-svelte', 'svelte-check'],
	// The worker is Python; `python3` is spawned by the gates, not resolved as a JS binary.
	ignoreBinaries: ['python3'],
	// SvelteKit/Vite virtual modules — synthesised at build time, and under `bun test` mapped to real
	// files by KIT_STUBS in tests/setup/svelte-dom-preload.ts.
	ignoreUnresolved: [/^\$app\//, /^\$env\//, /^\$service-worker$/],
	// An export used inside its own file is over-exported, not dead. Reporting those buries the ones
	// that genuinely have no reader.
	ignoreExportsUsedInFile: true,
	// A `/** @knipignore */` tag at the declaration exempts it, so the REASON lives at the site
	// instead of in a list here that drifts from it. Two exports carry it today; see each one.
	// A clean run is therefore ZERO findings, which is what makes a non-zero run worth reading.
	tags: ['-knipignore'],
	compilers: {
		// See cause 2 in the header. Concatenate every `<script>` block so the imports and the module
		// script are both visible; everything outside them is markup and carries no module graph.
		svelte: (text: string) =>
			[...text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
	}
};

export default config;
