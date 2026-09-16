// The 48-stop player palette, as something code can read.
//
// `player-palette-48.json` beside this file is a GENERATED, MEASURED registry: every stop carries its
// fill, the ink that may sit on it, and the contrast ratios that fill was measured at against the real
// `--bg` / `--card` tokens (see tests/guards/design-system/palette-registry-820.test.ts, which
// regenerates it byte-identically and re-derives every published `r_*` figure). This module is the only
// place the app reads it, so a consumer never has to know the JSON's shape.
//
// WHY `uniform` AND NOT `chromatic`. There are two variants and picking the wrong one is a real defect,
// not a preference. `chromatic` spans L 0.56–0.88 because it is for the TV, where a stop is a whole
// field and lightness variety is the point. `uniform` pins every stop at L≈0.72 — the same band
// `hueToHex` emits at SINGER_L — which is what makes any two stops equally visible as a small identity
// DOT on a dark card, and what makes the ring a hue-only choice. A guest picking off `chromatic` could
// land on a stop that is legible as a field and weak as a dot.
//
// WHAT THIS REPLACES. The join screen used to compute its hues live: `hueToHex` at 24 stops, plus eight
// hand-picked presets. The generated registry is the SAME band with 48 stops that have been measured
// and guard-verified, and it carries two things arithmetic cannot — a NAME per stop (so a screen reader
// says "Turquoise", not "hue 180") and the published contrast figure the picker can show. `colors.ts`
// keeps the wheel maths: it is still what `hueOfColor` and the singer-colour validator are built on, and
// every stop here clears that validator (asserted in tests/guards/design-system/colour-ring-palette.test.ts).
import registry from './player-palette-48.json';
import { hueOfColor, parseHex } from './colors';

/**
 * One stop of the palette. A SUBSET of the JSON's per-stop fields — the ones the app actually paints or
 * says out loud. The registry carries more (`chroma`, `srgb_hue`, `d_danger`…); they are inputs to the
 * generator and its guards rather than anything a component needs, and naming them here would invite a
 * consumer to depend on a generator detail.
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
 * Where stop 0 starts, as a `conic-gradient` `from` angle: −90° puts the first stop at 9 o'clock, which
 * is the ratified mockup's rendering.
 *
 * THIS CONSTANT IS THE WHOLE POINT OF PUTTING THE ANGLE MATHS HERE. A `conic-gradient` measures from 12
 * o'clock and `from` rotates the paint; a knob positioned with `rotate()` measures from 12 o'clock too
 * and does NOT know about the paint's rotation. So a knob placed at a stop's GRADIENT angle sits 90° away
 * from the colour it claims to point at — which is exactly the error in the approved mockup's static
 * markup (its knob is drawn at 161.25° while Turquoise is painted at 71.25°). `paletteConicGradient` and
 * `paletteRingAngle` both read this one constant, so the paint and the knob cannot disagree, and
 * `colour-ring-palette.test.ts` asserts the pair round-trips.
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
 * The stop closest to an arbitrary colour.
 *
 * EXACT FIRST, then nearest by HUE ANGLE. The exact path is what makes a stop round-trip: a value the
 * ring itself produced must map back to the same index, or the knob drifts a stop every time the
 * component re-derives its position. The nearest path exists for a colour the ring did not produce —
 * a legacy `SINGER_COLORS` preset, or a hue from the retired 24-stop wheel — so an existing singer's
 * dot lands on the ring somewhere sensible rather than at stop 0.
 *
 * HUE ANGLE, NOT OKLab DISTANCE, and that is measured rather than stylistic: `nearestSingerHue` in
 * colors.ts compares (a, b) euclidean against candidates generated at ONE lightness, so a colour from a
 * different tier snaps to the wrong stop (its own comment records 15 of 24 hues coming back wrong).
 * `hueOfColor` is an `atan2` of the same axes and is scale-free, so it reads the hue of a preset at
 * L≈0.56 and a stop at L≈0.72 on the same terms.
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
 * The ring's paint: one `conic-gradient` with a hard sector per stop.
 *
 * Hard-edged (each stop names both its start and end angle) rather than interpolated, because the ring
 * is a PICKER of 48 discrete colours, not a continuous field — a blended band would show colours the
 * ring cannot return, and the guest would aim at one and get its neighbour.
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
