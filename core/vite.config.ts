import adapter from 'svelte-adapter-bun';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Encore core — SvelteKit on Bun. `svelte-adapter-bun` is the one non-first-party seam
// (docs/ARCHITECTURE.md); if it proves rough, swap to @sveltejs/adapter-node under the Bun runtime.
export default defineConfig({
	// bun:sqlite is a Bun built-in — keep it external in VITE's SSR build. This does NOT reach the adapter:
	// svelte-adapter-bun re-bundles with its own rolldown call whose externals ignore this config, so
	// `/^bun:/` is added there by patches/svelte-adapter-bun@1.0.1.patch.
	ssr: { external: ['bun:sqlite'] },
	build: { rollupOptions: { external: ['bun:sqlite'] } },
	plugins: [
		// Tailwind v4 through its first-party Vite plugin, not PostCSS. Ordered BEFORE `sveltekit()` as
		// Tailwind's own SvelteKit guidance specifies. Keep it at a release whose peer range admits this
		// app's Vite major — `@tailwindcss/vite` only widened to `^8` in 4.2.2.
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force Svelte 5 runes mode project-wide (except node_modules libs).
				runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
			},
			adapter: adapter(),
			// NO CUSTOM ALIASES. Both internal trees are reached through `$lib`, which SvelteKit provides:
			// `$lib/server` is server-only and SvelteKit REFUSES to bundle it into client code, failing the
			// build — a guarantee, not a convention. `$lib/contract` is the isomorphic contract imported by
			// both sides. Re-adding a `$server`/`$shared` alias would create a second route to the same
			// modules that the framework does not police, which is the hole this restructure closed.
			alias: {}
		})
	]
});
