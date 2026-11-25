// What of the generated palette registry the app ships: the `uniform` stops and only the fields `PaletteStop`
// names. The rest (`chromatic`, stats, generator inputs) is the generator's record, ~4.9 KB gz on every route (#1246).
import type { PaletteStop } from './player-palette';

export const PALETTE_STOP_FIELDS = [
	'i',
	'name',
	'hue',
	'L',
	'fill',
	'on_fill',
	'accent_ink',
	'r_dot_card',
	'r_dot_bg'
] as const satisfies readonly (keyof PaletteStop)[];
// A field added to PaletteStop but not listed above would be undefined in the browser: refuse to compile.
const everyField: Exclude<keyof PaletteStop, (typeof PALETTE_STOP_FIELDS)[number]> extends never ? true : never = true;
void everyField;

export function paletteSlice(registryJson: string): string {
	const stops = (JSON.parse(registryJson) as { variants: { uniform: { stops: Record<string, unknown>[] } } }).variants
		.uniform.stops;
	const slim = stops.map((s) => Object.fromEntries(PALETTE_STOP_FIELDS.map((k) => [k, s[k]])));
	return JSON.stringify({ variants: { uniform: { stops: slim } } });
}
