import adapter from 'svelte-adapter-bun';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Encore core — SvelteKit on Bun. The community `svelte-adapter-bun` is the one non-first-party
// seam (docs/MASTER-DESIGN.md §2a); M0-C1 smoke-tests that a prod build serves under Bun on
// aarch64. Fallback if rough: swap to @sveltejs/adapter-node (still run by the Bun runtime).
export default defineConfig({
	// bun:sqlite is a Bun built-in — keep it external so the adapter bundler doesn't try to resolve it
	ssr: { external: ['bun:sqlite'] },
	build: { rollupOptions: { external: ['bun:sqlite'] } },
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force Svelte 5 runes mode project-wide (except node_modules libs).
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			alias: {
				// the shared realtime contract — imported by both client and server code
				'@encore/shared': '../../packages/shared/src/index.ts',
				// server-only modules (authoritative state, repos) reachable from +server.ts routes
				$server: 'src/server'
			}
		})
	]
});
