import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import { paletteSlice } from '../src/lib/contract/presentation/palette-slice';

const PALETTE_JSON = /\/player-palette-48\.json(?:\?|$)/;

/** The bundle gets only the palette fields the app reads, whatever the import's query; bun test and the generator's
 *  guard still see the whole file (#1246). */
export function paletteSlicePlugin(): Plugin {
	return {
		name: 'encore-palette-slice',
		enforce: 'pre',
		transform(code, id) {
			if (!PALETTE_JSON.test(id)) return;
			const [file, query = ''] = id.split('?');
			const params = new URLSearchParams(query);
			if (params.has('raw')) return `export default ${JSON.stringify(paletteSlice(readFileSync(file!, 'utf8')))};`;
			// A URL or inlined asset would ship the whole file; nothing needs one.
			if (params.has('url') || params.has('inline')) this.error(`import ${file} through player-palette.ts`);
			return paletteSlice(code);
		}
	};
}
