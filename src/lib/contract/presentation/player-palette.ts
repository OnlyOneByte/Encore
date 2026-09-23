// The 48-stop player palette. The JSON beside this file is GENERATED and MEASURED — every stop carries its
// fill, the ink that may sit on it, and measured contrast against the real surface tokens — and a guard
// regenerates it byte-identically. This module is the ONLY place the app reads it.
//
// IT MUST READ THE `uniform` VARIANT: `chromatic` spans a wide lightness range for the TV, where a stop is a
// whole field, while `uniform` pins every stop in the band `hueToHex` emits at `SINGER_L`, which is what makes
// any two stops equally visible as a small identity DOT. A `chromatic` stop can read as a field and fail as a
// dot. The registry also buys what hue arithmetic cannot: a spoken NAME per stop, and a publishable figure.
import registry from './player-palette-48.json';
import { hueOfColor, parseHex } from './colors';

/**
 * One stop. A SUBSET of the JSON's per-stop fields — the ones the app paints or says out loud. The registry
 * carries more, but those are generator inputs, and naming them here would invite a consumer to depend on a
 * generator detail.
 */
export interface PaletteStop {
	/** 1-based position on the ring. What `aria-valuenow` reports, so it matches what a guest counts. */
	readonly i: number;
	/** The spoken name — the whole reason this is a registry and not a hue calculation. */
	readonly name: string;
	/** OKLCH hue angle in degrees. The axis the ring is ordered by, and what a nearest-stop match uses. */
	readonly hue: number;
	/** OKLCH lightness. ≈0.72 for every uniform stop; read by the guard that pins the band. */
	readonly L: number;
	/** The identity colour itself, canonical 6-digit lowercase hex — what gets stored and sent. */
	readonly fill: string;
	/** The ink that clears AA on top of `fill`. Not used by the ring (a dot carries no text) but part of the pair. */
	readonly on_fill: string;
	/** `fill` adjusted where it could not be its own AA text colour on `--card`. */
	readonly accent_ink: string;
	/** Measured contrast of the dot against `--card` — the figure the picker shows as "N:1 on card". */
	readonly r_dot_card: number;
	/** Measured contrast of the dot against `--bg`. */
	readonly r_dot_bg: number;
}

/** The 48 stops, in hue order. The only colours the ring can produce. */
export const PALETTE_STOPS: readonly PaletteStop[] = registry.variants.uniform.stops;

/** Degrees of ring occupied by one stop — 7.5° at 48 stops. */
export const PALETTE_STOP_ARC_DEG = 360 / PALETTE_STOPS.length;

/**
 * Where stop 0 starts, as a `conic-gradient` `from` angle.
 *
 * THIS CONSTANT IS WHY THE ANGLE MATHS LIVES HERE. A `conic-gradient` measures from 12 o'clock and `from`
 * rotates the PAINT, while a knob positioned with `rotate()` measures from 12 o'clock and knows nothing
 * about that rotation — so a knob placed at a stop's gradient angle points 90° away from the colour it
 * claims. Both `paletteConicGradient` and `paletteRingAngle` read this one constant, so paint and knob
 * cannot disagree.
 */
export const PALETTE_RING_FROM_DEG = -90;

/** Canonical 6-digit lowercase hex, or null for anything that is not a hex colour. */
function canonHex(input: string): string | null {
	const rgb = parseHex(input);
	if (!rgb) return null;
	return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
}

const BY_FILL = new Map<string, PaletteStop>(PALETTE_STOPS.map((s) => [s.fill, s]));

/** Wrap an index into range. Hue is CYCLICAL, so stop 48 and stop 0 are neighbours. */
function wrapIndex(index: number): number {
	const n = PALETTE_STOPS.length;
	return ((Math.round(index) % n) + n) % n;
}

/** The stop at a 0-based ring position, wrapping. */
export function paletteStopAt(index: number): PaletteStop {
	return PALETTE_STOPS[wrapIndex(index)]!;
}

/** The stop whose `fill` is exactly this colour, or null. Exact, not nearest — for a caller that needs to know. */
export function paletteStopByFill(input: string): PaletteStop | null {
	const hex = canonHex(input);
	return hex ? (BY_FILL.get(hex) ?? null) : null;
}

/** Shortest angular distance between two hues, in degrees (0–180). */
function hueGap(a: number, b: number): number {
	const d = Math.abs((((a - b) % 360) + 360) % 360);
	return Math.min(d, 360 - d);
}

/**
 * The stop closest to an arbitrary colour: EXACT first, then nearest by HUE ANGLE.
 *
 * The exact path is what makes a stop round-trip — a value the ring produced must map back to the same
 * index, or the knob drifts a stop each time the component re-derives its position. The nearest path serves
 * a colour the ring did not produce, such as a legacy preset.
 *
 * HUE ANGLE and NOT OKLab distance, which is measured rather than stylistic: a euclidean (a, b) comparison
 * against candidates generated at ONE lightness snaps a colour from a different tier to the wrong stop,
 * while `hueOfColor`'s `atan2` is scale-free and reads both tiers on the same terms.
 */
export function nearestPaletteStop(input: string): PaletteStop {
	const hex = canonHex(input);
	const exact = hex ? BY_FILL.get(hex) : undefined;
	if (exact) return exact;
	const hue = hueOfColor(hex ?? '');
	let best = PALETTE_STOPS[0]!;
	let bestGap = Infinity;
	for (const s of PALETTE_STOPS) {
		const gap = hueGap(s.hue, hue);
		if (gap < bestGap) {
			bestGap = gap;
			best = s;
		}
	}
	return best;
}

/** Trim a computed degree to a short decimal, so the emitted CSS is readable rather than 7.500000001. */
function deg(n: number): string {
	return String(Number(n.toFixed(3)));
}

/**
 * The ring's paint: one `conic-gradient` with a HARD sector per stop — each naming both its start and end
 * angle — because the ring is a picker of discrete colours and not a continuous field. A blended band shows
 * colours the ring cannot return, so a guest aims at one and gets its neighbour.
 */
export function paletteConicGradient(): string {
	const arc = PALETTE_STOP_ARC_DEG;
	const sectors = PALETTE_STOPS.map((s, k) => `${s.fill} ${deg(k * arc)}deg ${deg((k + 1) * arc)}deg`);
	return `conic-gradient(from ${deg(PALETTE_RING_FROM_DEG)}deg, ${sectors.join(', ')})`;
}

/**
 * The COMPASS angle (clockwise from 12 o'clock) at which a stop's sector centre is painted — where its
 * knob or pip belongs. Includes the `from` offset, which is the half everything gets wrong.
 */
export function paletteRingAngle(index: number): number {
	const arc = PALETTE_STOP_ARC_DEG;
	return Number((wrapIndex(index) * arc + arc / 2 + PALETTE_RING_FROM_DEG).toFixed(3));
}

/** The inverse: which stop is painted at a compass angle. What a tap or drag on the band resolves to. */
export function paletteStopAtRingAngle(compassDeg: number): PaletteStop {
	const arc = PALETTE_STOP_ARC_DEG;
	return paletteStopAt(Math.round((compassDeg - PALETTE_RING_FROM_DEG - arc / 2) / arc));
}
