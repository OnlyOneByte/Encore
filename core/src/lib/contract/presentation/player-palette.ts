// The 48-stop player palette. The JSON beside this file is GENERATED and MEASURED, and a guard regenerates
// it byte-identically; this module is the ONLY place the app reads it. Vite bundles only `palette-slice.ts`'s
// cut of it, so read nothing here beyond `variants.uniform.stops` and the `PaletteStop` fields.
//
// IT MUST READ THE `uniform` VARIANT: `chromatic` spans a wide lightness range for the TV, where a stop is a
// whole field, while `uniform` pins every stop in the band `hueToHex` emits at `SINGER_L` — which is what
// makes any two stops equally visible as a small identity DOT.
// `with { type: 'json' }` is REQUIRED, not decorative. Vite and Bun resolve a bare JSON import via
// `resolveJsonModule`, but Node's own ESM loader refuses it — and the contract BARREL re-exports this module,
// so any Node-side consumer that touches `$lib/contract` at runtime dies on
// `needs an import attribute of "type: json"`. That is exactly what happened: the whole Playwright suite
// failed to load because two specs imported from `$lib` modules that reach this file through the barrel — one a
// function from `$lib/tv/lyrics`, which p6-lyrics.spec.ts still does, the other a constant from `$lib/sheet-snap`,
// a module since deleted with the now-playing sheet. One live example is enough to keep the hazard real.
import registry from './player-palette-48.json' with { type: 'json' };
import { SINGER_COLORS, canonicalHex, hueDistance, hueOfColor } from './colors';

/** A SUBSET of the JSON's per-stop fields: the rest are generator inputs, and naming them here would invite
 *  a consumer to depend on a generator detail. */
export interface PaletteStop {
	/** 1-based, so `aria-valuenow` matches what a guest counts. */
	readonly i: number;
	/** The whole reason this is a registry and not a hue calculation. */
	readonly name: string;
	/** Degrees. The axis the ring is ordered by, and what a nearest-stop match uses. */
	readonly hue: number;
	/** ≈0.72 for every uniform stop; read by the guard that pins the band. */
	readonly L: number;
	/** Canonical 6-digit lowercase hex — what gets stored and sent. */
	readonly fill: string;
	/** The ink that clears AA on top of `fill`. Unused by the ring, but part of the pair. */
	readonly on_fill: string;
	/** `fill` adjusted where it could not be its own AA text colour on `--card`. */
	readonly accent_ink: string;
	/** The figure the picker shows as "N:1 on card". */
	readonly r_dot_card: number;
	readonly r_dot_bg: number;
}

/** In hue order. The only colours the ring can produce. */
export const PALETTE_STOPS: readonly PaletteStop[] = registry.variants.uniform.stops;

/** 7.5° at 48 stops. */
export const PALETTE_STOP_ARC_DEG = 360 / PALETTE_STOPS.length;

/**
 * Where stop 0 starts, as a `conic-gradient` `from` angle. THIS CONSTANT IS WHY THE ANGLE MATHS LIVES HERE:
 * `from` rotates the PAINT while a `rotate()`-positioned knob knows nothing about that rotation, so a knob
 * placed at a stop's gradient angle points away from the colour it claims. Both `paletteConicGradient` and
 * `paletteRingAngle` read this one constant, so paint and knob cannot disagree.
 */
export const PALETTE_RING_FROM_DEG = -90;

const BY_FILL = new Map<string, PaletteStop>(PALETTE_STOPS.map((s) => [s.fill, s]));

/** Hue is CYCLICAL, so stop 48 and stop 0 are neighbours. */
function wrapIndex(index: number): number {
	const n = PALETTE_STOPS.length;
	return ((Math.round(index) % n) + n) % n;
}

/** The stop at a 0-based ring position, wrapping. */
export function paletteStopAt(index: number): PaletteStop {
	return PALETTE_STOPS[wrapIndex(index)]!;
}

/** Exact, not nearest — for a caller that needs to know.
 *  @knipignore Pinned as public surface by `tests/unit/contract/barrel-surface.test.ts`; the palette's lookups
 *  ship as a set so a caller never has to reach past the barrel. */
export function paletteStopByFill(input: string): PaletteStop | null {
	const hex = canonicalHex(input);
	return hex ? (BY_FILL.get(hex) ?? null) : null;
}

/**
 * EXACT first, then nearest by HUE ANGLE. The exact path is what makes a stop round-trip: a value the ring
 * produced must map back to the same index, or the knob drifts a stop on every re-derive.
 *
 * HUE ANGLE and NOT OKLab distance: a euclidean (a, b) comparison against candidates generated at ONE
 * lightness snaps a colour from a different tier to the wrong stop, while `atan2` is scale-free.
 */
export function nearestPaletteStop(input: string): PaletteStop {
	const hex = canonicalHex(input);
	const exact = hex ? BY_FILL.get(hex) : undefined;
	if (exact) return exact;
	const hue = hueOfColor(hex ?? '');
	let best = PALETTE_STOPS[0]!;
	let bestGap = Infinity;
	for (const s of PALETTE_STOPS) {
		const gap = hueDistance(s.hue, hue);
		if (gap < bestGap) {
			bestGap = gap;
			best = s;
		}
	}
	return best;
}

/**
 * The colour a guest gets when they never touch the ring: the free stop whose HUE is farthest from every colour
 * already held, so each default is as far as possible from the others on the TV. An empty room starts at the
 * first preset, and a full ring (no stop free) falls back to it. Held colours are compared by stop, as the ring's
 * taken pips are. Chosen at join time by the server, so guests who opened the join screen together still differ.
 */
export function freeSingerColor(taken: readonly string[]): string {
	const first = nearestPaletteStop(SINGER_COLORS[0]);
	const held = taken.map((c) => nearestPaletteStop(c).hue);
	if (!held.length) return first.fill;
	let best = first;
	let bestGap = 0;
	for (const s of PALETTE_STOPS) {
		const gap = Math.min(...held.map((h) => hueDistance(s.hue, h)));
		if (gap > bestGap) {
			bestGap = gap;
			best = s;
		}
	}
	return best.fill;
}

/** So the emitted CSS reads 7.5 rather than 7.500000001. */
function deg(n: number): string {
	return String(Number(n.toFixed(3)));
}

/** A HARD sector per stop, each naming its own start and end angle, because a blended band shows colours
 *  the ring cannot return — a guest aims at one and gets its neighbour. */
export function paletteConicGradient(): string {
	const arc = PALETTE_STOP_ARC_DEG;
	const sectors = PALETTE_STOPS.map((s, k) => `${s.fill} ${deg(k * arc)}deg ${deg((k + 1) * arc)}deg`);
	return `conic-gradient(from ${deg(PALETTE_RING_FROM_DEG)}deg, ${sectors.join(', ')})`;
}

/** Clockwise from 12 o'clock, where a stop's knob or pip belongs. INCLUDES the `from` offset, which is the
 *  half everything gets wrong. */
export function paletteRingAngle(index: number): number {
	const arc = PALETTE_STOP_ARC_DEG;
	return Number((wrapIndex(index) * arc + arc / 2 + PALETTE_RING_FROM_DEG).toFixed(3));
}

/** The inverse: what a tap or drag on the band resolves to. */
export function paletteStopAtRingAngle(compassDeg: number): PaletteStop {
	const arc = PALETTE_STOP_ARC_DEG;
	return paletteStopAt(Math.round((compassDeg - PALETTE_RING_FROM_DEG - arc / 2) / arc));
}
