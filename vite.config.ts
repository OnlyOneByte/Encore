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
			// NO CUSTOM ALIASES. Both of this app's internal trees are now reached through `$lib`, which
			// SvelteKit provides:
			//
			//   $lib/server    server-only. SvelteKit REFUSES to bundle it into client code and fails the
			//                  build saying so — a guarantee, not a convention.
			//   $lib/contract  the isomorphic contract, imported by both `lib` (client) and `lib/server`.
			//                  "Contract", not "shared": the name `shared` was read as app↔worker three
			//                  separate times, and the Python worker cannot import TypeScript at all.
			//
			// The previous `$server` and `$shared` aliases were only names. Nothing stopped a component
			// importing the database through `$server`, and that was held by a test instead. Re-adding
			// either would create a second route to the same modules that the framework does not police,
			// which is precisely the hole this restructure closed.
			alias: {}
		})
	]
});
