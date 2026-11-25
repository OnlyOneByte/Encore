import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PALETTE_STOPS } from '$lib/contract/presentation/player-palette';
import { PALETTE_STOP_FIELDS, paletteSlice } from '$lib/contract/presentation/palette-slice';

const REPO = join(import.meta.dir, '../../..');
const committed = readFileSync(join(REPO, 'src/lib/contract/presentation/player-palette-48.json'), 'utf8');

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
