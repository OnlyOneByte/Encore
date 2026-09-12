import adapter from 'svelte-adapter-bun';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Encore core — SvelteKit on Bun. `svelte-adapter-bun` is the one non-first-party seam
// (docs/ARCHITECTURE.md); if it proves rough, swap to @sveltejs/adapter-node under the Bun runtime.
export default defineConfig({
	// bun:sqlite is a Bun built-in — keep it external so the adapter bundler doesn't try to resolve it
	ssr: { external: ['bun:sqlite'] },
	build: { rollupOptions: { external: ['bun:sqlite'] } },
	plugins: [
		/*
		 * Tailwind v4 through its FIRST-PARTY VITE PLUGIN, not PostCSS.
		 *
		 * The plugin was the open question, not the default: this app runs Vite 8, and `@tailwindcss/vite`
		 * only widened its peer range to `^8` in 4.2.2 — every release up to 4.2.1 declares `^5.2.0 || ^6
		 * || ^7` and would have installed against Vite 8 with an unmet peer. 4.3.3 declares `^8`, and the
		 * PostCSS fallback the issue authorised is therefore unused; the verdict is recorded in the PR and
		 * in docs/DECISIONS.md rather than only here.
		 *
		 * Ordered BEFORE `sveltekit()` as Tailwind's own SvelteKit guidance specifies.
		 */
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force Svelte 5 runes mode project-wide (except node_modules libs).
				runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
			},
			adapter: adapter(),
			alias: {
				// The isomorphic contract — imported by BOTH `src/lib` (client) and `src/lib/server`
				// (authoritative). That is what "shared" means here: client↔server within one app, never
				// app↔worker, since the worker is Python and cannot import TypeScript at all.
				//
				// Pointing at the DIRECTORY, not at `index.ts`. The old workspace package's `exports` map
				// carried only `"."`, so a subpath import did not resolve and tests reached the palette
				// registry through `'../../../../packages/shared/…json'`. A directory alias gives SvelteKit
				// both `$shared` and `$shared/*`, so those relative reaches can go.
				$shared: 'src/shared'
				//
				// THERE IS NO `$server` ALIAS, and its absence is the point.
				//
				// Server-only code lives at `src/lib/server`, reached as `$lib/server` — a path SvelteKit
				// gives MEANING to: it refuses to bundle anything under it into client code, and fails the
				// build saying so. The previous `$server: 'src/lib/server'` was only a name; nothing stopped a
				// Svelte component importing the database through it, and that was held by a test instead.
				//
				// Re-adding an alias here would create a second route to the same modules that the framework
				// does not police, which is exactly the hole the move closed. It stays gone.
			}
		})
	]
});
