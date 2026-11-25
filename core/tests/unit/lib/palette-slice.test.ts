import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PALETTE_STOPS } from '$lib/contract/presentation/player-palette';
import { PALETTE_STOP_FIELDS, paletteSlice } from '$lib/contract/presentation/palette-slice';
import { paletteSlicePlugin } from '../../../config/palette-slice-plugin';

const REPO = join(import.meta.dir, '../../..');
const JSON_PATH = join(REPO, 'src/lib/contract/presentation/player-palette-48.json');
const committed = readFileSync(JSON_PATH, 'utf8');

test('player-palette.ts is the only module that imports the registry, so nothing reads past the slice', () => {
	const importers = readdirSync(join(REPO, 'src'), { recursive: true, encoding: 'utf8' }).filter(
		(p) => /\.(ts|js|svelte)$/.test(p) && readFileSync(join(REPO, 'src', p), 'utf8').includes('player-palette-48.json')
	);
	expect(importers).toEqual(['lib/contract/presentation/player-palette.ts']);
});

describe('the Vite step slices every import form', () => {
	const ctx = {
		error: (msg: string) => {
			throw new Error(msg);
		}
	};
	const transform = paletteSlicePlugin().transform as (this: typeof ctx, code: string, id: string) => unknown;
	const run = (id: string, code = committed) => transform.call(ctx, code, id);

	test('a plain or query import gets the slice; ?raw gets it as a string; other files pass through', () => {
		const slice = paletteSlice(committed);
		expect(run(JSON_PATH)).toBe(slice);
		expect(run(`${JSON_PATH}?import`)).toBe(slice);
		expect(run(`${JSON_PATH}?raw`, 'export default "<the whole file>"')).toBe(
			`export default ${JSON.stringify(slice)};`
		);
		expect(run(join(REPO, 'package.json'))).toBeUndefined();
	});

	test('a ?url import, which would ship the whole file, fails the build', () => {
		expect(() => run(`${JSON_PATH}?url`)).toThrow('through player-palette.ts');
	});
});

describe('the palette slice Vite bundles (#1246)', () => {
	const sliced = JSON.parse(paletteSlice(committed)) as { variants: Record<string, { stops: object[] }> };

	test('keeps every uniform stop with exactly the PaletteStop fields, and their values', () => {
		expect(Object.keys(sliced.variants)).toEqual(['uniform']);
		const stops = sliced.variants.uniform!.stops;
		expect(stops).toHaveLength(PALETTE_STOPS.length);
		stops.forEach((s, i) => {
			expect(Object.keys(s)).toEqual([...PALETTE_STOP_FIELDS]);
			for (const k of PALETTE_STOP_FIELDS) expect(s).toHaveProperty(k, PALETTE_STOPS[i]![k]);
		});
	});

	test('is much smaller than the registry it is cut from', () => {
		expect(paletteSlice(committed).length).toBeLessThan(committed.length / 4);
	});
});
