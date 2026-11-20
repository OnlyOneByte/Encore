// The colour a guest joins with when they never touch the ring.
import { PALETTE_STOPS, SINGER_COLORS, nearestPaletteStop } from '$lib/contract';

/**
 * The first PRESET whose ring stop nobody in the room holds, snapped to the ring. A fixed default gave every guest
 * who skipped the ring the same colour, which made the TV's colour coding say nothing. Presets first because they
 * are spread round the wheel, so two defaults never land on neighbouring stops; then any free stop; with every stop
 * taken, the first preset again. Compared by STOP, the same way the ring draws its taken pips.
 */
export function defaultJoinColor(taken: readonly string[]): string {
	const held = new Set(taken.map((c) => nearestPaletteStop(c).i));
	const presets = SINGER_COLORS.map((c) => nearestPaletteStop(c));
	const free = [...presets, ...PALETTE_STOPS].find((s) => !held.has(s.i));
	return (free ?? presets[0]!).fill;
}
