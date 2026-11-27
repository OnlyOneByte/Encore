import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const ID = 'virtual:toaster-url';
const RESOLVED = `\0${ID}`;
const TOASTER = fileURLToPath(new URL('../src/lib/components/ui/sonner/index.ts', import.meta.url));

/** `virtual:toaster-url` is the URL of the toaster's own chunk. The phone layout imports it by that URL so a retry
 *  can add `?retry=N`: a browser keeps a failed `import()` of one URL failed for the page's life (#1309). */
export function toasterUrlPlugin(): Plugin {
	let serve = false;
	return {
		name: 'encore-toaster-url',
		configResolved: (config) => void (serve = config.command === 'serve'),
		resolveId: (id) => (id === ID ? RESOLVED : undefined),
		load(id, options) {
			if (id !== RESOLVED) return;
			// The dev server serves the module at its own path; the server never loads the toaster.
			if (serve || options?.ssr) return `export default ${JSON.stringify('/src/lib/components/ui/sonner/index.ts')};`;
			const ref = this.emitFile({ type: 'chunk', id: TOASTER });
			return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
		}
	};
}
