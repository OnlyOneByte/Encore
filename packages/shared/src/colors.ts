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

/**
 * The surfaces a dot has to stay visible against: the live values of `--bg` and `--card`.
 *
 * LITERALS rather than a read of `apps/core/src/app.css`, because this module is browser-bundled and
 * has no filesystem at runtime. That duplication is the risk — change a token and
 * `isLegibleSingerColor` starts accepting colours that are invisible on the real card — so the pair
 * is EXPORTED and `colors.test.ts` asserts it still equals the tokens `app.css` declares. It cannot
 * drift away from the surfaces the app actually paints without reddening a named test. Same price,
 * for the same reason, as `DEFAULT_STAGE_COLOR` below.
 */
export const SURFACES = ['#0b0b12', '#1a1a28'] as const; // --bg, --card
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
/**
 * OKLCH -> sRGB (0-255 per channel) plus whether the colour was IN GAMUT before clamping. Exported
 * so the design guard can verify hueToHex fully reduces chroma to a gamut-fitting value rather than
 * returning a clipped colour (the no-clip guarantee this module promises).
 */
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
	// Reduce chroma until the colour is in gamut. The step is fixed but the loop is bounded by chroma
	// REACHING ZERO, not by a fixed iteration count — an earlier `for (i < 40)` covered only 0.20 of
	// chroma, so a caller passing c > 0.20 (e.g. 0.3) exited still out of gamut and returned exactly
	// the clipped, hue-shifted colour this function exists to prevent. At c=0 grey is always in gamut,
	// so the loop terminates.
	let chroma = c;
	while (chroma > 0) {
		const { rgb, inGamut } = oklchToRgb(l, chroma, hue);
		if (inGamut) return toHex(rgb);
		chroma -= 0.005;
	}
	return toHex(oklchToRgb(l, 0, hue).rgb);
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
// SCREEN, and for a make-karaoke song it sits directly behind word-timed lyrics. Painting the dot
// palette across that field washes the reel out, so the stage is generated far darker and far less
// saturated.
//
// WHAT THIS TIER NO LONGER DOES, and the change is deliberate (#425). It used to be the room's only
// way to name a stage colour: the room stored a HUE ANGLE and every stage went through
// `stageHueToHex`, so the tier doubled as a LEGIBILITY BOUND that no picker could escape. The owner
// retired that bound and replaced the job it was doing with a different mechanism — the lyric reel
// now carries its own `-webkit-text-stroke` outline (#750, `b764d92`), so the words survive any
// field instead of the field being restricted to keep them readable. Protecting the reel beats
// restricting the choice, and a stroke works over a music video too, which a bound on the stage
// colour never could.
//
// So the tier still generates every colour the room does NOT pick by hand — the `singer` glow (whose
// hue comes from someone's identity dot) and the visualizer palettes (built by hue arithmetic around
// the room's colour) — and those keep the bound, because nobody chose them and nobody can see why
// they came out bright. The room's own `solid` colour is stored verbatim and rendered verbatim.

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

/**
 * The stage colour a room starts with — what the old `tvBackgroundHue: 240` default became when #425
 * replaced the hue angle with a real colour, so an existing box renders byte-identically.
 *
 * A LITERAL rather than a `stageHueToHex(240)` call, because the SQLite column default and the 0005
 * migration's backfill need these exact bytes and SQL cannot run an OKLCH conversion. That duplication
 * is the risk, so `colors.test.ts` asserts the literal still equals `stageHueToHex(240)` — the
 * constant cannot drift away from the value it was derived from without reddening a named test.
 */
export const DEFAULT_STAGE_COLOR = '#001d31';

/**
 * The hue angle of an arbitrary colour, in degrees (0–359): the direction of its OKLab chromatic
 * vector, independent of lightness and chroma. Greys have no direction, so they return 0.
 *
 * Needed because #425 made the room's stored stage value a real colour while the VISUALIZERS still
 * need an ANGLE: every renderer in `apps/core/src/lib/tv/visualizers.ts` builds its palette by hue
 * ARITHMETIC (`stageHueToHex(hue + deg)`) around the room's colour, which a hex cannot express.
 *
 * `nearestSingerHue` cannot serve here, and that was MEASURED rather than assumed: it compares OKLab
 * (a, b) by euclidean distance against candidates generated at the WHEEL's tier (L 0.70 / C 0.16),
 * so a stage-tier colour (L 0.22 / C 0.07) has a much shorter chromatic vector and snaps to the wrong
 * stop for 15 of the 24 legal hues — 135° came back as 180°, 240° as 210°. Using it would have
 * silently re-coloured the visualizer of every room that had picked one. An `atan2` of the same two
 * axes is scale-free and round-trips `stageHueToHex(h)` to within 4.2° across all 24 stops, the
 * residual being 8-bit quantisation of a deliberately dark colour rather than a modelling error.
 */
export function hueOfColor(input: string): number {
	const rgb = parseHex(input);
	if (!rgb) return 0;
	const { a, b } = rgbToOklabAb(rgb);
	const deg = (Math.atan2(b, a) * 180) / Math.PI;
	return ((deg % 360) + 360) % 360;
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
 * The colour the TV lyric highlight should paint for the singer who is up — or `null` to leave the
 * room accent in place (#634).
 *
 * WHY THIS IS A SEPARATE FUNCTION and not a call to `normalizeSingerColor`. That sibling exists to
 * produce a colour that can be STORED, so it must always return something and falls back to a preset.
 * Here a fallback to violet would be actively wrong: the reel's default is `--accent2`, the room's own
 * accent, and silently substituting a preset would hand one guest somebody else's identity colour on
 * the words they are singing. `null` is the honest answer — "no singer colour applies, keep the
 * accent" — and it is the only one the caller can distinguish from a real choice.
 *
 * WHY IT NORMALISES. The value arrives from the wire (`singers.color` on the TV route) and is
 * interpolated straight into a `style` attribute as a custom property. Canonical 6-digit lowercase hex
 * is the shape every downstream reader already assumes, and a 3-digit hex reaching CSS is exactly what
 * silently dropped the phone's avatar halo once already (see `normalizeSingerColor`, and the
 * `singer-color.test.ts` guard). So this is the sanitising boundary, not a convenience.
 *
 * WHY THE LEGIBILITY GATE IS `isLegibleSingerColor` and not a new rule. The owner's ruling on #634 was
 * to keep the singer's hue and let the reel's own `-webkit-text-stroke` (#750) carry legibility over
 * the stage and over video — so there is no per-frame brightness derivation to invent here. What
 * remains is the floor that a colour must clear to be an identity colour at all, and that floor
 * already exists and is tested. A value that fails it is not a legitimate singer colour: it is junk,
 * a legacy row, or an unparseable string, and the reel keeps the accent rather than painting the words
 * in something that cannot be seen.
 */
export function lyricHighlightColor(input: string | null | undefined): string | null {
	if (typeof input !== 'string') return null;
	const rgb = parseHex(input);
	if (!rgb) return null;
	const hex = toHex(rgb);
	return isLegibleSingerColor(hex) ? hex : null;
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
 * Coerce arbitrary input into a STAGE background colour that is safe to store and render.
 *
 * The interesting part is what this does NOT do, and it is the whole of #425: there is deliberately
 * no legibility gate. The sibling `normalizeSingerColor` above rejects an illegible dot because a
 * vanished identity marker is unrecoverable — a guest cannot see that their dot is invisible on
 * someone else's TV. A stage colour is the opposite: the room picked it, the room is looking at it,
 * and the thing it used to endanger (the word-timed lyric reel) now defends itself with a stroked
 * outline (#750, `b764d92`). So the room may pick white, and the words stay readable.
 *
 * What survives from the retired pin is its OTHER stated reason, which was never about brightness:
 * canonical 6-digit lowercase hex. The value is interpolated straight into a `style` attribute, and a
 * 3-digit hex concatenated with alpha digits is exactly what silently dropped the singer halo once
 * already. Everything downstream can assume one shape.
 *
 * Unparseable input returns `fallback` — the room keeps the colour it already chose rather than having
 * an unrelated junk write reset it, matching how every other room setting handles a bad value.
 */
export function normalizeStageColor(input: unknown, fallback: string): string {
	const rgb = typeof input === 'string' ? parseHex(input) : null;
	return rgb ? toHex(rgb) : fallback;
}

// ── stage dim (#782, piece 3 of #425) ──────────────────────────────────────
//
// A room-level 0..1 dimmer for the stage background. The owner ratified Q2 = A: "Dim the stage colour
// toward black — today's geometry, no new layer." It is a LIGHTNESS control by another name, not an
// opacity layer over the video: the stage sits at z-index 0 behind the video on a black floor, so
// blending it toward black is indistinguishable from lowering its lightness and reveals nothing of the
// video (which sits above it). Nothing is added over the players — this only changes the value the
// existing `.stage-bg` layer already paints.

/** No dim — the stage colour is shown at full strength. The default, so an existing box is unchanged. */
export const MIN_STAGE_DIM = 0;
/** Full dim — the stage colour is pulled all the way to black. */
export const MAX_STAGE_DIM = 1;
/**
 * A room ships at 0 — no dim, today's behaviour exactly. So adding the field changes nothing on the TV
 * until someone moves the slider, the same invisible-migration promise every other room setting keeps.
 */
export const DEFAULT_STAGE_DIM = 0;

/**
 * Clamp an untrusted dim fraction into 0..1, rounded to a hundredth. Mirrors the shape
 * `guideLevelDefault` uses (a 0..1 real quantised to 1/100), so the two 0..1 room fractions store and
 * compare the same way. A non-finite or non-number value returns `fallback` — a junk write keeps the
 * dim the room already chose rather than resetting it, matching every other field's rule.
 */
export function normalizeStageDim(input: unknown, fallback: number): number {
	if (typeof input !== 'number' || !Number.isFinite(input)) return fallback;
	return Math.round(Math.min(MAX_STAGE_DIM, Math.max(MIN_STAGE_DIM, input)) * 100) / 100;
}

/**
 * Darken a hex colour toward black by a 0..1 fraction: `dim` 0 returns the colour untouched, `dim` 1
 * returns `#000000`, and values between scale every channel by `(1 - dim)`.
 *
 * This is the whole of Q2 = A. Multiplying the linear-8-bit channels toward zero is the "toward black"
 * the owner named, and because the stage layer sits on a black floor it is exactly what an opacity
 * reduction would have looked like — with no second layer and no reveal of the video. A colour is
 * darkened, not composited.
 *
 * An unparseable input is returned verbatim: the only non-hex stage values this ever receives are the
 * CSS-variable gradient strings the room does NOT pick by hand (`gradient`, and the `singer` glow's
 * outer `var(--bg)` stop), and a token cannot be arithmetic-dimmed by a function with no DOM. The
 * caller applies this only to the concrete colour it resolved (see `background.ts`), so in practice the
 * input is always a hex; the passthrough is a safety net, not a code path a style reaches.
 */
export function dimTowardBlack(hex: string, dim: number): string {
	const rgb = parseHex(hex);
	if (!rgb) return hex;
	const f = 1 - Math.min(MAX_STAGE_DIM, Math.max(MIN_STAGE_DIM, dim));
	return toHex(rgb.map((c) => Math.round(c * f)) as [number, number, number]);
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

/**
 * The swatch an arrow key moves to from the current `value`, wrapping the eight-swatch group.
 *
 * The base MUST be the same anchor the tab stop uses (`presetTabStopIndex`), not a bare
 * `indexOf(value)`: after a hue-wheel pick `value` is not a preset, so `indexOf` returns -1 while the
 * tab stop falls back to swatch 0. If arrow movement started from -1 it would disagree with where the
 * focus ring actually sits — the first ArrowRight computes `(-1 + 1) % 8 === 0` and does not move,
 * and ArrowLeft computes `(-1 - 1 + 8) % 8 === 6`, skipping swatch 7. Anchoring both on the same
 * function keeps them in lockstep. `step` is +1 (ArrowRight/Down) or -1 (ArrowLeft/Up).
 */
export function nextSwatchIndex(value: string, step: number): number {
	const base = presetTabStopIndex(value);
	const n = SINGER_COLORS.length;
	return (base + step + n) % n;
}

/** A singer colour is any legible hex now, not one of eight literals. */
export type SingerColor = string;

// ── duet part colours (#692) ───────────────────────────────────────────────

/**
 * Map the abstract `part` letters a diarized duet carries (#691) onto DISTINCT, LEGIBLE reel
 * colours — the visible half of the duet feature.
 *
 * WHAT IT RETURNS. A `Map<partLabel, hex>`, one legible colour per part, assigned in the order the
 * parts first APPEAR in the song. Content-driven order (not lexical) so "the voice that opens the
 * song" gets the first colour deterministically, and the same doc always yields the same mapping.
 * The colours come from `SINGER_COLORS` — the palette the singer-identity dots already use — so the
 * two-colour reel reads in the app's established vocabulary rather than an invented pair.
 *
 * WHY IT REUSES `isLegibleSingerColor` AND NOT A HARD-CODED PAIR. The owner's ruling on #692 was
 * explicit: over video with a scrim an illegible second colour is worse than one colour, and a
 * hard-coded second colour is rejected because it skips the legibility floor the singer-colour
 * vocabulary already enforces. So every colour handed back has cleared `isLegibleSingerColor`; a
 * palette entry that ever stopped being legible is skipped rather than painted. All eight
 * `SINGER_COLORS` clear the floor today, so the two a duet needs are always available.
 *
 * THE FALLBACK IS BY ABSENCE, matching the worker (`diarize/attribution.py`). When NO line carries a
 * part — a solo, a song diarization could not split, an undiarized cook — this returns an EMPTY map,
 * which the reel reads as "no part colour applies, keep the single-colour path": an undiarized song
 * renders exactly as today. A song with a single part likewise gets one colour. More parts than the
 * palette can legibly cover collapse to whatever it can — but the worker caps a confident duet at two
 * parts (`MAX_PARTS`), so in practice this is A and B.
 *
 * PURE and side-effect-free; safe to call on every render (the caller memoises it per doc).
 */
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
