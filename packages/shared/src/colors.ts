// Singer identity colour.
//
// A singer's colour is how they recognise themselves in the queue on their phone and on the shared
// TV. It is drawn ONLY as a small filled dot — never as a text colour, and never as a background
// behind text. That single fact decides everything below: the contrast rule that applies is WCAG's
// 3:1 minimum for non-text UI objects, not the 4.5:1 body-text rule. Getting that wrong would force
// the palette far darker than it needs to be and cost the vividness that makes the dots useful.
//
// Guests pick a hue from a wheel. Lightness and chroma are NOT theirs to choose, and that is the
// whole trick: with L and C pinned, every hue on the circle is a dot that is guaranteed visible
// against the app's dark surfaces and guaranteed distinguishable from its neighbours. A free picker
// would let someone choose near-black — the identity dot vanishes — or land one degree from another
// guest and be indistinguishable on the TV roster, where the dot is the only thing telling them
// apart besides the name.
//
// The tradeoff, stated plainly: no pastels, no charcoal, no dusty tones. For a marker read at a
// glance across a room, legibility beats gamut freedom.

/**
 * The original eight, kept as PRESETS — quick-picks shown above the wheel, and the fallback for
 * unparseable input. Every existing singer row holds one of these.
 *
 * Note they are NOT in the wheel's lightness band: #7c5cff sits at OKLCH L≈0.56 while the wheel
 * emits L≈0.70. That is deliberate and is why the validator below tests LEGIBILITY rather than band
 * membership — a band check would reject all eight of these and every singer who ever joined.
 */
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

/** Perceptual lightness the wheel emits. Chosen so every hue clears 3:1 on --bg and --card. */
export const SINGER_L = 0.7;
/** Chroma the wheel aims for. Clamped down per hue where it would leave the sRGB gamut. */
export const SINGER_C = 0.16;
/**
 * Hue quantisation, in degrees. 24 stops still feels continuous to drag through, but makes it
 * impossible for two guests to land 1° apart and be visually identical on the TV roster.
 */
export const SINGER_HUE_STEP = 15;

/** The surfaces a dot has to stay visible against. */
const SURFACES = ['#0b0b12', '#1a1a28'] as const; // --bg, --card
/** WCAG minimum for a non-text UI object. A dot carries no text, so this is the applicable bar. */
const MIN_DOT_CONTRAST = 3;

// ── sRGB / WCAG ────────────────────────────────────────────────────────────

function srgbToLinear(c: number): number {
	const u = c / 255;
	return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(u: number): number {
	const v = u <= 0.0031308 ? 12.92 * u : 1.055 * u ** (1 / 2.4) - 0.055;
	return Math.round(Math.min(1, Math.max(0, v)) * 255);
}

/** Parse #rgb or #rrggbb. Returns null for anything else — including rgb()/oklch()/named colours. */
export function parseHex(input: string): [number, number, number] | null {
	const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec((input ?? '').trim());
	if (!m) return null;
	let h = m[1]!;
	if (h.length === 3) h = h.split('').map((c) => c + c).join('');
	return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex([r, g, b]: [number, number, number]): string {
	return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
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

// ── OKLCH ──────────────────────────────────────────────────────────────────

/**
 * OKLCH → sRGB, via Björn Ottosson's OKLab matrices. Returns unclamped linear channels alongside the
 * 8-bit result so callers can detect a hue that has left the gamut instead of silently accepting the
 * desaturated clip — clipping is exactly what turns a vivid violet into lavender.
 */
function oklchToRgb(L: number, C: number, hueDeg: number): { rgb: [number, number, number]; inGamut: boolean } {
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

/**
 * A wheel hue as a canonical 6-digit hex.
 *
 * Chroma is reduced until the colour fits in sRGB rather than letting the conversion clip: clipping
 * an out-of-gamut blue does not give you a slightly-less-saturated blue, it gives you a hue-shifted
 * one, so two adjacent wheel stops could collapse onto the same rendered colour.
 *
 * Hex output (not `oklch(...)`) because the value is stored in SQLite, sent over the wire, and
 * interpolated into a style attribute; a plain hex is the form every one of those already accepts.
 */
export function hueToHex(hueDeg: number, l: number = SINGER_L, c: number = SINGER_C): string {
	const hue = ((hueDeg % 360) + 360) % 360;
	let chroma = c;
	for (let i = 0; i < 40; i++) {
		const { rgb, inGamut } = oklchToRgb(l, chroma, hue);
		if (inGamut) return toHex(rgb);
		chroma -= 0.005;
		if (chroma <= 0) return toHex(oklchToRgb(l, 0, hue).rgb);
	}
	return toHex(oklchToRgb(l, Math.max(0, chroma), hue).rgb);
}

/** The wheel's stops, in order. What the picker renders and the only hues it can produce. */
export const SINGER_HUES: readonly number[] = Array.from(
	{ length: Math.round(360 / SINGER_HUE_STEP) },
	(_, i) => i * SINGER_HUE_STEP
);

// ── stage tier ─────────────────────────────────────────────────────────────
//
// The TV stage background is a DIFFERENT tier from the singer dot palette above, and the difference
// is load-bearing rather than taste.
//
// A dot is ~12px of fill on a dark card, so SINGER_L = 0.70 is right for it. The stage is the WHOLE
// SCREEN, and for a make-karaoke song it sits directly behind word-timed lyrics whose only defence
// is `text-shadow: 0 2px 18px rgba(0,0,0,.85)` (LyricsOverlay.svelte) — a glow tuned against black.
// Painting the dot palette across that field would wash the reel out. So the stage is pinned far
// darker and far less saturated, and these two numbers are a LEGIBILITY BOUND: raising them
// regresses the lyrics, which is why they live here in shared code rather than in a picker.

/** Perceptual lightness for a full-screen stage background. */
export const STAGE_BG_L = 0.22;
/** Chroma for a full-screen stage background. */
export const STAGE_BG_C = 0.07;

/**
 * Hue of `--accent2` (#ff5cae) — the "sing this now" active-word colour in the lyrics overlay.
 * Derived, not hardcoded, so it cannot drift away from the token it mirrors.
 */
const ACCENT2_HUE = nearestSingerHue('#ff5cae');

/**
 * Angular width of the guard, in degrees. Inside it, a stage hue gives up brightness on a RAMP.
 *
 * 60° is where the rendered mockups stopped showing any loss. Deliberately a ramp and not a
 * threshold: a binary flip put a cliff in the middle of the wheel, so the two stops either side of
 * it got wildly different stages for a 15° change — and it forced a single answer onto hue 30
 * (coral, which did flatten) and hue 300 (purple, which did not) even though both sit exactly 45°
 * out. No defensible rule distinguishes them by hue angle alone, so both get the same mild
 * reduction rather than one of them getting a fabricated exception.
 */
const ACCENT2_GUARD_DEG = 60;

/** Lightness at the worst case — a stage hue sitting exactly on the active-word hue. */
const STAGE_BG_L_GUARDED = 0.13;

/** Shortest angular distance between two hues, in degrees (0–180). */
function hueDistance(a: number, b: number): number {
	const d = Math.abs((((a - b) % 360) + 360) % 360);
	return Math.min(d, 360 - d);
}

/**
 * Stage lightness for a hue: `STAGE_BG_L` everywhere except inside the guard band, ramping linearly
 * down to `STAGE_BG_L_GUARDED` as the hue closes on the active-word hue.
 */
export function stageLightnessForHue(hueDeg: number): number {
	const hue = ((hueDeg % 360) + 360) % 360;
	const dist = hueDistance(hue, ACCENT2_HUE);
	if (dist >= ACCENT2_GUARD_DEG) return STAGE_BG_L;
	const t = dist / ACCENT2_GUARD_DEG; // 0 at the collision, 1 at the edge of the band
	return STAGE_BG_L_GUARDED + t * (STAGE_BG_L - STAGE_BG_L_GUARDED);
}

/**
 * A stage background colour for a hue.
 *
 * Mostly this is just `hueToHex` at the stage tier. The exception is the guard: a stage generated
 * from a hue NEAR `--accent2` steals the active word's cue, because the highlight and the field it
 * sits on are then the same hue family. Three fixes were rendered; this is the one chosen, because
 * it keeps BOTH the hue and the chroma and gives up only brightness — so "the stage is your colour"
 * stays true for a pink singer, while the pink word wins on lightness contrast instead of hue.
 *
 * Rotating the hue away (the obvious fix) was rejected: it hands a pink singer a purple stage, which
 * defeats the entire point of the option.
 */
export function stageHueToHex(hueDeg: number): string {
	return hueToHex(hueDeg, stageLightnessForHue(hueDeg), STAGE_BG_C);
}


// ── validation ─────────────────────────────────────────────────────────────

/**
 * Is this a colour a singer may actually be identified by?
 *
 * Tests the real requirement — a parseable hex whose dot stays visible on both dark surfaces — rather
 * than membership of a fixed list. This is what lets the wheel exist at all: the previous version was
 * an allowlist of the eight presets, so ANY other hue was silently rewritten to violet, and a guest
 * who carefully picked teal joined as violet with no explanation.
 */
export function isLegibleSingerColor(input: string): boolean {
	const rgb = parseHex(input);
	if (!rgb) return false;
	const hex = toHex(rgb);
	return SURFACES.every((s) => contrastRatio(hex, s) >= MIN_DOT_CONTRAST);
}

/**
 * Coerce arbitrary input into a colour that is safe to store and render.
 *
 * Normalising to canonical 6-digit lowercase hex is load-bearing, not tidiness: callers interpolate
 * the value straight into CSS, and a 3-digit hex used to break the avatar halo when hex alpha digits
 * were concatenated onto it. Everything downstream can now assume one shape.
 */
export function normalizeSingerColor(input: string): string {
	const rgb = parseHex(input);
	if (rgb) {
		const hex = toHex(rgb);
		if (isLegibleSingerColor(hex)) return hex;
	}
	return SINGER_COLORS[0];
}

/**
 * The wheel stop closest to an arbitrary colour, in OKLab a/b terms.
 *
 * Needed so the two pickers stay two VIEWS OF ONE SELECTION rather than two independent controls: tap
 * the violet preset and the hue slider's thumb has to travel to violet, otherwise the thumb sits at
 * hue 0 (red) while displaying violet and the guest cannot tell which one is real.
 */
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

/** sRGB → the OKLab chromatic axes. Hue lives in (a, b); lightness is deliberately ignored here. */
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

/**
 * Which preset index should be the keyboard tab stop, for a currently-selected colour.
 *
 * The preset swatches are a roving-tabindex group: a radiogroup is a SINGLE tab stop, so exactly one
 * swatch carries tabindex 0 and arrow keys move within. Normally that is the swatch matching `value`.
 *
 * But `value` is often NOT a preset — the hue wheel emits colours at a lightness the eight presets
 * are deliberately outside (see SINGER_COLORS above: L≈0.56 vs the wheel's L≈0.70), so the wheel
 * PROVABLY never lands on a preset hex. When nothing matches, this returns 0, keeping the FIRST
 * swatch tabbable so the group stays reachable. Without that fallback a single wheel pick drops all
 * eight presets out of the tab order for good, and the wheel cannot return to one — a keyboard or
 * switch-access guest is then locked out of the only named colours (the presets are what every
 * existing singer holds and the only hues with a spoken name).
 *
 * Returns an index into SINGER_COLORS; the caller sets tabindex 0 on that swatch and -1 on the rest.
 */
export function presetTabStopIndex(value: string): number {
	const i = (SINGER_COLORS as readonly string[]).indexOf(value);
	return i === -1 ? 0 : i;
}

/** A singer colour is any legible hex now, not one of eight literals. */
export type SingerColor = string;
