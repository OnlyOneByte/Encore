// guard: the join screen's colour ring is the MEASURED palette, and its paint agrees with its knob. Caught
// a knob drawn at a stop's GRADIENT angle sitting 90° from the colour it claims (knob 161.25°, Turquoise
// painted 71.25°), because a `conic-gradient`'s `from` rotates the paint while a `rotate()` knob measures
// from 12 o'clock. Every returnable stop must also clear `isLegibleSingerColor`; palette-registry.test.ts
// measures the CHROMATIC variant against the role floors, this the UNIFORM variant against the app's gate.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { srcDir } from '$test';
import {
	PALETTE_RING_FROM_DEG,
	PALETTE_STOPS,
	PALETTE_STOP_ARC_DEG,
	SINGER_COLORS,
	SINGER_L,
	isLegibleSingerColor,
	nearestPaletteStop,
	paletteConicGradient,
	paletteRingAngle,
	paletteStopAt,
	paletteStopAtRingAngle
} from '$lib/contract';

const SRC = srcDir;
const RING = readFileSync(join(SRC, 'lib/components/ColourRing.svelte'), 'utf8');
const LANDING = readFileSync(join(SRC, 'lib/components/JoinLanding.svelte'), 'utf8');
const SETTINGS = readFileSync(join(SRC, 'routes/settings/+page.svelte'), 'utf8');
// The preset picker's remaining surface, now the ring holds both identity panes.
const GALLERY = readFileSync(join(SRC, 'routes/components/+page.svelte'), 'utf8');

test('every stop the ring can return is a colour a singer may legally be identified by', () => {
	expect(PALETTE_STOPS.length).toBeGreaterThanOrEqual(48); // @nvf-floor PALETTE_STOPS.length
	const illegible = PALETTE_STOPS.filter((s) => !isLegibleSingerColor(s.fill)).map((s) => `${s.name} ${s.fill}`);
	expect(illegible, 'the ring offers a colour whose identity dot fails the 3:1 non-text floor').toEqual([]);
	// The gate really can reject, or the arm above proves nothing.
	expect(isLegibleSingerColor('#333340')).toBe(false);
});

test('the ring is the wheel’s lightness band, and the eight presets are deliberately outside it', () => {
	// `uniform`, not `chromatic`: every stop sits in the band `hueToHex` emits at SINGER_L, so each dot
	// reads like every other. A stop 0.1 lighter is a guest whose marker is a different weight.
	const outOfBand = PALETTE_STOPS.filter((s) => Math.abs(s.L - SINGER_L) > 0.05).map((s) => `${s.name} L=${s.L}`);
	expect(outOfBand, 'a ring stop sits outside the singer-dot lightness band').toEqual([]);
	// And the presets are NOT in it, which is what makes the ring and ColourPicker two different sets rather
	// than an overlap, and why the validator tests legibility instead of band membership.
	const presetsInBand = SINGER_COLORS.filter((c) => PALETTE_STOPS.some((s) => s.fill === c));
	expect(presetsInBand, 'a preset is now also a ring stop — colors.ts records why they are separate').toEqual([]);
});

test('a stop round-trips: the colour painted at a knob’s angle is the stop the knob is for', () => {
	const wrong: string[] = [];
	for (let i = 0; i < PALETTE_STOPS.length; i++) {
		const landed = paletteStopAtRingAngle(paletteRingAngle(i));
		if (landed.i !== i + 1) wrong.push(`${paletteStopAt(i).name} → ${landed.name}`);
	}
	expect(wrong, 'the knob angle and the paint disagree — the mockup’s error').toEqual([]);
	// The mockup's own mistake, pinned: reading a stop's GRADIENT position as its compass angle lands 90°
	// away, which is 12 stops at 7.5° apart.
	const gradientAngleOfTurquoise = 21 * PALETTE_STOP_ARC_DEG + PALETTE_STOP_ARC_DEG / 2;
	expect(paletteStopAtRingAngle(gradientAngleOfTurquoise).i).not.toBe(22);
	// …and the correct compass angle for it does land on Turquoise.
	expect(paletteStopAtRingAngle(gradientAngleOfTurquoise + PALETTE_RING_FROM_DEG).name).toBe('Turquoise');
});

test('the paint names all 48 fills, in ring order, with hard sector edges', () => {
	const grad = paletteConicGradient();
	// The `from` in the paint is the SAME constant the knob angle is offset by; two copies of this number is
	// precisely how the two frames drift apart.
	expect(grad.startsWith(`conic-gradient(from ${PALETTE_RING_FROM_DEG}deg,`)).toBe(true);
	for (const [k, s] of PALETTE_STOPS.entries()) {
		const from = k * PALETTE_STOP_ARC_DEG;
		const to = (k + 1) * PALETTE_STOP_ARC_DEG;
		// BOTH edges: an interpolated band shows colours the ring cannot return, so a guest aims at one and is
		// handed its neighbour.
		expect(grad, `${s.name} is not painted as its own hard sector`).toContain(`${s.fill} ${from}deg ${to}deg`);
	}
	// Distinct fills, so the sector list cannot be 48 copies of one colour.
	expect(new Set(PALETTE_STOPS.map((s) => s.fill)).size).toBe(48);
});

test('a colour the ring cannot produce maps onto the ring by hue, and one it can maps to itself', () => {
	// EXACT first, or the knob drifts by a stop every time the component re-derives from `value`.
	for (const s of PALETTE_STOPS) expect(nearestPaletteStop(s.fill).i).toBe(s.i);
	// A 3-digit hex and an upper-case spelling are the same colour, and both have reached CSS from this app before.
	expect(nearestPaletteStop(PALETTE_STOPS[21]!.fill.toUpperCase()).name).toBe('Turquoise');
	// Then nearest-by-hue for anything else — a preset, or junk.
	expect(PALETTE_STOPS.some((s) => s.fill === SINGER_COLORS[0])).toBe(false);
	const violet = nearestPaletteStop(SINGER_COLORS[0]);
	expect(violet.i).toBeGreaterThan(30); // violet lives in the back half of the ring, not at stop 1
	expect(nearestPaletteStop('not a colour').i).toBeGreaterThanOrEqual(1);
});

test('both identity surfaces render the RING, and the eight-preset picker still has a surface', () => {
	// Both halves, because the absence alone would be satisfied by deleting the picker outright — and it is
	// not deleted. `SEL.swatch` and `SEL.hueSlider` still resolve, so only a pinned split says which surface
	// each belongs to.
	expect(LANDING).toMatch(/<ColourRing\b/);
	expect(LANDING).not.toMatch(/<ColourPicker\b/);
	expect(SETTINGS, 'the settings identity control is the ring now, like the join pane').toMatch(/<ColourRing\b/);
	expect(SETTINGS).not.toMatch(/<ColourPicker\b/);
	expect(GALLERY, 'the preset picker lost its remaining surface — then it is a deletion, not a move').toMatch(
		/<ColourPicker\b/
	);
	// REAL occupancy from the same preview the room sentence is built from, not a sample.
	expect(LANDING).toMatch(/taken=\{preview\?\.colors \?\? \[\]\}/);
	// Settings has no occupancy in its load, so it passes an EMPTY list rather than inventing one — pinned so
	// a sample list has to argue with this line instead of slipping in as a plausible default.
	expect(SETTINGS).toMatch(/taken=\{\[\]\}/);
});

test('the ring declares the slider contract it no longer inherits from a range input', () => {
	// A native `<input type=range>` brought all of this with it. The ring is a div, so each attribute is
	// hand-written and deletable in isolation; the BEHAVIOUR is driven in a unit test.
	expect(RING).toMatch(/role="slider"/);
	expect(RING).toMatch(/tabindex="0"/);
	expect(RING).toMatch(/aria-valuemin=\{1\}/);
	expect(RING).toMatch(/aria-valuemax=\{PALETTE_STOPS\.length\}/);
	expect(RING).toMatch(/aria-valuenow=\{stop\.i\}/);
	// The stop's NAME, not its number: a reader says "Turquoise". The one attribute whose VALUE is the
	// accessibility of the control rather than its wiring.
	expect(RING).toMatch(/aria-valuetext=\{stop\.name\}/);
	// Every key the slider role promises.
	for (const key of ['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'Home', 'End']) {
		expect(RING, `${key} is not handled`).toContain(`'${key}'`);
	}
	// The ring restates the global focus rule to make its outline a circle, so a wrong colour pasted here
	// would be invisible to that rule's own guard.
	expect(RING).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus\)/s);
});

test('the ring sizes itself off --tap, so the band a thumb hits is one tap target wide', () => {
	// The band's width is `d/2 - hole`, both derived from `--tap`, which is what makes "the ring is the touch
	// target" true rather than a coincidence of a screenshot's numbers. `--cr-d` MUST NOT carry a percentage: a
	// percentage height resolves against this pane's auto-height column, so `min(…, 100%)` computed the disc's
	// height to 0 — a 220×0 line with no band and a collapsed hub. Pinning the expression stops that returning.
	expect(RING).toMatch(/--cr-d:\s*calc\(var\(--tap\) \* 5\);/);
	expect(RING, 'a percentage in the diameter resolves to 0 height on an auto-height parent').not.toMatch(
		/--cr-d:[^;]*%/
	);
	expect(RING).toMatch(/--cr-hole:\s*calc\(var\(--cr-d\) \/ 2 - var\(--tap\)\)/);
	expect(RING).toMatch(/\.cr-knob\s*\{[^}]*width:\s*var\(--tap\)[^}]*height:\s*var\(--tap\)/s);
	// No hard-coded length anywhere in the ring's geometry. COMMENT-STRIPPED, because this file's own prose
	// names resolved pixel sizes. `2px` is exempt: it is the focus outline's WIDTH, spelled as app.css's global
	// `:focus-visible` rule spells it, and there is no width token to name instead.
	const style = RING.slice(RING.indexOf('<style>')).replace(/\/\*[\s\S]*?\*\//g, ' ');
	const literals = [...style.matchAll(/(?<![\w.-])(\d+)px\b/g)].map((m) => m[0]).filter((v) => v !== '2px');
	expect(literals, 'the ring hard-codes a length instead of deriving it from a token').toEqual([]);
	// Non-vacuity: the strip did not blank the whole block.
	expect(style).toContain('var(--tap)');
});
