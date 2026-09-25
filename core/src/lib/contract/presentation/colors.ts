// Two OKLCH tiers, SINGER and STAGE. Guests choose a HUE only; lightness and chroma are pinned.
// Rules: docs/SERVER.md#colour-tiers.

/** PRESETS, and the fallback for unparseable input. They sit deliberately OUTSIDE the wheel's lightness
 *  band, which is why the validator tests legibility and never membership. */
export const SINGER_COLORS = [
	'#7c5cff', // violet (accent)
	'#ff5cae', // pink (accent2)
	'#33d6a6', // green (ok)
	'#ffb84d', // amber (warn)
	'#5cb8ff', // sky
	'#ff7c5c', // coral
	'#b15cff', // purple
	'#5cffd6' // mint
] as const;

/** Chosen so every hue clears 3:1 on --bg and --card. */
export const SINGER_L = 0.7;
/** Clamped down per hue where it would leave the sRGB gamut. */
export const SINGER_C = 0.16;
/** Coarse enough that two guests cannot land a degree apart and look identical. */
export const SINGER_HUE_STEP = 15;

/** PINNED LITERALS held equal to their CSS tokens by a parity assertion, because a browser bundle cannot
 *  read `src/app.css`. */
export const SURFACES = ['#0b0b12', '#1a1a28'] as const; // --bg, --card
/** The non-text UI bar, because a singer colour is only ever a fill. */
const MIN_DOT_CONTRAST = 3;

function srgbToLinear(c: number): number {
	const u = c / 255;
	return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(u: number): number {
	const v = u <= 0.0031308 ? 12.92 * u : 1.055 * u ** (1 / 2.4) - 0.055;
	return Math.round(Math.min(1, Math.max(0, v)) * 255);
}

/** Null for anything else, including rgb()/oklch()/named colours. */
export function parseHex(input: string): [number, number, number] | null {
	const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec((input ?? '').trim());
	if (!m) return null;
	let h = m[1]!;
	if (h.length === 3)
		h = h
			.split('')
			.map((c) => c + c)
			.join('');
	return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex([r, g, b]: [number, number, number]): string {
	return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Canonical 6-digit lowercase hex, or null for anything that is not a hex colour. THE one spelling of
 *  "parse it, then re-emit it": every normaliser below needs it, and so does the palette's stop lookup. */
export function canonicalHex(input: string): string | null {
	const rgb = parseHex(input);
	return rgb ? toHex(rgb) : null;
}

/** WCAG 2.x relative luminance. */
function luminance(rgb: [number, number, number]): number {
	const [r, g, b] = rgb.map(srgbToLinear) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colours. Returns 1 if either fails to parse. */
export function contrastRatio(a: string, b: string): number {
	const ra = parseHex(a);
	const rb = parseHex(b);
	if (!ra || !rb) return 1;
	const [hi, lo] = [luminance(ra), luminance(rb)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
}

/** The in-gamut flag lets a caller reduce chroma instead of accepting a clip, which SHIFTS a hue rather
 *  than desaturating it. */
export function oklchToRgb(L: number, C: number, hueDeg: number): { rgb: [number, number, number]; inGamut: boolean } {
	const h = (hueDeg * Math.PI) / 180;
	const a = C * Math.cos(h);
	const bb = C * Math.sin(h);

	const l_ = L + 0.3963377774 * a + 0.2158037573 * bb;
	const m_ = L - 0.1055613458 * a - 0.0638541728 * bb;
	const s_ = L - 0.0894841775 * a - 1.291485548 * bb;

	const l = l_ ** 3;
	const m = m_ ** 3;
	const s = s_ ** 3;

	const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
	const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
	const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

	const inGamut = [lr, lg, lb].every((v) => v >= -0.001 && v <= 1.001);
	return { rgb: [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)] as [number, number, number], inGamut };
}

/** Canonical 6-digit hex — the form SQLite, the wire and a `style` attribute all accept. */
export function hueToHex(hueDeg: number, l: number = SINGER_L, c: number = SINGER_C): string {
	const hue = ((hueDeg % 360) + 360) % 360;
	// Bounded by chroma REACHING ZERO, never by an iteration count: a fixed count covers a fixed span, so a
	// larger `c` would exit still out of gamut.
	let chroma = c;
	while (chroma > 0) {
		const { rgb, inGamut } = oklchToRgb(l, chroma, hue);
		if (inGamut) return toHex(rgb);
		chroma -= 0.005;
	}
	return toHex(oklchToRgb(l, 0, hue).rgb);
}

/** What the picker renders, and the only hues it can produce. */
export const SINGER_HUES: readonly number[] = Array.from(
	{ length: Math.round(360 / SINGER_HUE_STEP) },
	(_, i) => i * SINGER_HUE_STEP
);

// The STAGE tier is the whole screen behind word-timed lyrics, so far darker and less saturated.

export const STAGE_BG_L = 0.22;
export const STAGE_BG_C = 0.07;

/** The active-word colour and the centre of the guard band. PINNED, like `SURFACES`. */
export const ACCENT2 = '#ff5cae';

const ACCENT2_HUE = nearestSingerHue(ACCENT2);

/** Deliberately a RAMP and not a threshold, which would put a cliff between two adjacent stops. */
const ACCENT2_GUARD_DEG = 60;

/** The worst case: a stage hue sitting exactly on the active-word hue. */
const STAGE_BG_L_GUARDED = 0.13;

/** Shortest angular distance, in degrees (0–180). Exported because the palette ring measures the same
 *  angle to find a guest's nearest stop, and two copies of a wrap-around subtraction drift. */
export function hueDistance(a: number, b: number): number {
	const d = Math.abs((((a - b) % 360) + 360) % 360);
	return Math.min(d, 360 - d);
}

/** `STAGE_BG_L` except inside the guard band, ramping linearly to `STAGE_BG_L_GUARDED`. */
export function stageLightnessForHue(hueDeg: number): number {
	const hue = ((hueDeg % 360) + 360) % 360;
	const dist = hueDistance(hue, ACCENT2_HUE);
	if (dist >= ACCENT2_GUARD_DEG) return STAGE_BG_L;
	const t = dist / ACCENT2_GUARD_DEG; // 0 at the collision, 1 at the edge of the band
	return STAGE_BG_L_GUARDED + t * (STAGE_BG_L - STAGE_BG_L_GUARDED);
}

/** A hue near `--accent2` steals the active word's cue, so the guard gives up only BRIGHTNESS. */
export function stageHueToHex(hueDeg: number): string {
	return hueToHex(hueDeg, stageLightnessForHue(hueDeg), STAGE_BG_C);
}

/** A LITERAL because a SQLite column DEFAULT and a migration backfill need these exact bytes, and SQL
 *  cannot run an OKLCH conversion. */
export const DEFAULT_STAGE_COLOR = '#001d31';

/** Scale-free, so it reads both tiers on the same terms. `nearestSingerHue` CANNOT serve here. */
export function hueOfColor(input: string): number {
	const rgb = parseHex(input);
	if (!rgb) return 0;
	const { a, b } = rgbToOklabAb(rgb);
	const deg = (Math.atan2(b, a) * 180) / Math.PI;
	return ((deg % 360) + 360) % 360;
}

/** Tests LEGIBILITY on both surfaces, never list membership — an allowlist silently rewrites every non-preset hue. */
export function isLegibleSingerColor(input: string): boolean {
	const hex = canonicalHex(input);
	if (!hex) return false;
	return SURFACES.every((s) => contrastRatio(hex, s) >= MIN_DOT_CONTRAST);
}

/** `null` leaves the room accent. MUST stay separate from `normalizeSingerColor`. */
export function lyricHighlightColor(input: string | null | undefined): string | null {
	if (typeof input !== 'string') return null;
	const hex = canonicalHex(input);
	if (!hex) return null;
	return isLegibleSingerColor(hex) ? hex : null;
}

/** Canonical 6-digit lowercase hex is load-bearing — see docs/SERVER.md#colour-tiers. */
export function normalizeSingerColor(input: string): string {
	const hex = canonicalHex(input);
	if (hex && isLegibleSingerColor(hex)) return hex;
	return SINGER_COLORS[0];
}

/** DELIBERATELY NO LEGIBILITY GATE, unlike its singer sibling; unparseable input keeps the room's colour. */
export function normalizeStageColor(input: unknown, fallback: string): string {
	return (typeof input === 'string' ? canonicalHex(input) : null) ?? fallback;
}

// The dimmer is a LIGHTNESS control, never an opacity layer over the video.

export const MIN_STAGE_DIM = 0;
export const MAX_STAGE_DIM = 1;
export const DEFAULT_STAGE_DIM = 0;

/** Rounded to a hundredth like `guideLevelDefault`, so the two room fractions compare alike. */
export function normalizeStageDim(input: unknown, fallback: number): number {
	if (typeof input !== 'number' || !Number.isFinite(input)) return fallback;
	return Math.round(Math.min(MAX_STAGE_DIM, Math.max(MIN_STAGE_DIM, input)) * 100) / 100;
}

/** Darkened, never composited. Unparseable input returns VERBATIM — a CSS variable cannot be
 *  arithmetic-dimmed without a DOM. */
export function dimTowardBlack(hex: string, dim: number): string {
	const rgb = parseHex(hex);
	if (!rgb) return hex;
	const f = 1 - Math.min(MAX_STAGE_DIM, Math.max(MIN_STAGE_DIM, dim));
	return toHex(rgb.map((c) => Math.round(c * f)) as [number, number, number]);
}

/** Keeps the swatches and the slider two VIEWS OF ONE SELECTION. Valid ONLY at the wheel tier. */
export function nearestSingerHue(input: string): number {
	const rgb = parseHex(input);
	if (!rgb) return 0;
	const target = rgbToOklabAb(rgb);
	let best = 0;
	let bestDist = Infinity;
	for (const h of SINGER_HUES) {
		const cand = rgbToOklabAb(parseHex(hueToHex(h))!);
		const d = (cand.a - target.a) ** 2 + (cand.b - target.b) ** 2;
		if (d < bestDist) {
			bestDist = d;
			best = h;
		}
	}
	return best;
}

/** Hue lives in (a, b); lightness is deliberately ignored here. */
function rgbToOklabAb([r, g, b]: [number, number, number]): { a: number; b: number } {
	const lr = srgbToLinear(r);
	const lg = srgbToLinear(g);
	const lb = srgbToLinear(b);
	const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
	const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
	const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
	return {
		a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
	};
}

/** In the order parts first APPEAR. Every colour must clear `isLegibleSingerColor` rather than being a
 *  hard-coded pair, and THE FALLBACK IS BY ABSENCE: no part returns an EMPTY map, which the reel reads as
 *  the single-colour path. */
export function duetPartColors(lines: readonly { part?: string }[] | null | undefined): Map<string, string> {
	const out = new Map<string, string>();
	if (!lines) return out;
	const legible = (SINGER_COLORS as readonly string[]).filter((c) => isLegibleSingerColor(c));
	let next = 0;
	for (const line of lines) {
		const part = line?.part;
		if (typeof part !== 'string' || !part.trim()) continue;
		if (out.has(part)) continue;
		if (next >= legible.length) continue; // palette exhausted — leave later parts uncoloured
		out.set(part, legible[next]!);
		next += 1;
	}
	return out;
}
