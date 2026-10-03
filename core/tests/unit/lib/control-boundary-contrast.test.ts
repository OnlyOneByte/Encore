import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { at } from '$test';
import { contrastRatio } from '$lib/contract';
import { cn } from '$lib/utils';

/*
 * guard: the boundary that IDENTIFIES a form control clears SC 1.4.11's 3:1, and the decorative card hairline
 * stays where it is. The two used to be one token: `--line` was both every card's edge and every field's
 * border, and at 1.13:1 on the `--card2` field fill the six room-code boxes on the join screen read as
 * featureless slabs. The obvious fix — brighten `--line` — is the WRONG one, because 17 files spell it
 * decoratively and 1.4.11 exempts a purely decorative boundary, so raising it would brighten the whole app to
 * fix six borders. Hence `--control-line`, and hence assertion 2 below, which forbids the wrong fix.
 */

const appCss = readFileSync(at('src/app.css'), 'utf8');

/** Pull a `--name: #hex;` declaration out of `app.css`. Throws rather than defaulting, so a renamed token
 *  reds instead of leaving the suite measuring a value nothing declares. */
function token(name: string): string {
	const m = appCss.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`));
	if (!m) throw new Error(`token --${name} not found in src/app.css (renamed? then update this guard)`);
	return m[1]!;
}

/** SC 1.4.11 non-text contrast. */
const NON_TEXT = 3;

/** Files under `src/` that spell a needle literally. Used to pin the file COUNT three comments quote, so the
 *  number cannot rot the way the contrast margin did. */
function filesSpelling(needle: string): string[] {
	return readdirSync(at('src'), { recursive: true, encoding: 'utf8' })
		.filter((p) => /\.(css|svelte|ts)$/.test(p))
		.filter((p) => readFileSync(at(`src/${p}`), 'utf8').includes(needle));
}

/** Every surface token `app.css` declares as a flat fill, so the boundary is safe on a surface no field sits
 *  on yet — a field moved onto `--ok-bg` later must not quietly drop under the floor. `--track-bg` is in the
 *  list because it IS a flat fill (Bars, TvProgress, slider, SongRow, tv/+page all paint it as a background),
 *  and it is the binding one: at 3.131 it is the worst surface in the app, below `--ok-bg`'s 3.196. Leaving it
 *  out is what let the token's comment claim a >=3.20 margin it does not have. It is also the one entry that is
 *  no longer hypothetical — the slider rail's own ring sits on it, so the floor is now paid, not reserved. */
const SURFACES = [
	'bg',
	'bg2',
	'card',
	'card2',
	'card-tint',
	'card-tint2',
	'ok-bg',
	'warn-bg',
	'danger-bg',
	'stage-glow',
	'track-bg'
] as const;

test('--control-line identifies a control on every surface app.css declares (SC 1.4.11, 3:1)', () => {
	const control = token('control-line');
	// Collected rather than asserted one at a time, so a regression names the surface AND the number.
	const weak = SURFACES.map((s) => [s, contrastRatio(control, token(s))] as const)
		.filter(([, r]) => r < NON_TEXT)
		.map(([s, r]) => `${s}:${r.toFixed(3)}`);
	expect(weak).toEqual([]);
	// The binding pair, stated explicitly: `--card2` is the fill of .encore-field and .encore-textarea, so it is
	// the surface the criterion is actually measured against in the shipped app.
	expect(contrastRatio(control, token('card2'))).toBeGreaterThanOrEqual(3.5);
	// The MARGIN app.css states in prose, pinned so the prose cannot drift from the palette a second time: the
	// floor is --track-bg at 3.13, and --ok-bg at 3.20 is the next rung up. A palette edit that reorders these
	// reds here instead of quietly falsifying the token's comment.
	const ranked = SURFACES.map((s) => [s, contrastRatio(control, token(s))] as const).sort((a, b) => a[1] - b[1]);
	expect(ranked[0]![0]).toBe('track-bg');
	expect(ranked[0]![1]).toBeCloseTo(3.13, 2);
	expect(ranked[1]![0]).toBe('ok-bg');
});

/** `#rrggbb` -> integer HSL percentages, the form app.css's colour notes reason in. */
function hsl(hex: string): { h: number; s: number; l: number } {
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
	const mx = Math.max(r, g, b);
	const mn = Math.min(r, g, b);
	const d = mx - mn;
	const l = (mx + mn) / 2;
	const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
	let h = 0;
	if (d !== 0) h = mx === r ? 60 * (((g - b) / d + 6) % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
	return { h, s: s * 100, l: l * 100 };
}

test('--control-line is the ROUNDED interpolation app.css says it is, not the interpolated figure', () => {
	// The token's comment derives its saturation by interpolating between --line-strong and --ink-dim at l=54, then
	// ships a whole-percent hsl(). Those are two different numbers and the comment used to print the first while
	// presenting the second as if it were the same value. Both halves are pinned here so neither can drift alone.
	const strong = hsl(token('line-strong'));
	const dim = hsl(token('ink-dim'));
	const control = hsl(token('control-line'));
	// The family's own line: same hue, and the boundary sits BETWEEN the two on lightness.
	for (const c of [strong, dim, control]) expect(Math.round(c.h)).toBe(240);
	expect(control.l).toBeGreaterThan(strong.l);
	expect(control.l).toBeLessThan(dim.l);
	// The interpolation, re-derived from the two DECLARATIONS rather than copied, and deliberately from the exact
	// saturations rather than the reading-rounded 19/15 the note prints beside them: 16.50 at l=54. The note used to
	// quote 16.3, which is what interpolating the rounded triples gives — a figure no hex in this file produces.
	const interpolated = strong.s + ((54 - strong.l) / (dim.l - strong.l)) * (dim.s - strong.s);
	expect(interpolated).toBeCloseTo(16.5, 1);
	// And what actually ships: the whole percent ABOVE it.
	expect(Math.round(control.s)).toBe(17);
	expect(17).toBeGreaterThan(interpolated);
	expect(Math.round(control.l)).toBe(54);
	// The DIRECTION of that step, which is the clause the note now states: on the floor surface the shipped 17%
	// measures slightly HIGHER than 16.5% would, so the rounding is in the safe direction rather than a silent cost.
	// `#76769d` is hsl(240 16.5% 54%) rounded to a byte — one channel away from what ships.
	const shipped = contrastRatio(token('control-line'), token('track-bg'));
	const asInterpolated = contrastRatio('#76769d', token('track-bg'));
	expect(shipped).toBeCloseTo(3.131, 3);
	expect(asInterpolated).toBeCloseTo(3.126, 3);
	expect(shipped).toBeGreaterThan(asInterpolated);
	expect(shipped - asInterpolated).toBeCloseTo(0.0044, 4);
	// And it clears the floor, which is the reason it stays.
	expect(shipped).toBeGreaterThanOrEqual(NON_TEXT);
});

test('--line is unchanged and still fails 3:1, so the fix cannot have been a global brightening', () => {
	// 17 files spell --line for a card edge, a list-row rule, a table rule, the spinner and the skeleton
	// shimmer. All of that is decoration, which SC 1.4.11 exempts; brightening it to pass a criterion it is
	// exempt from would brighten every card in the app. If this reds, someone took the shortcut.
	expect(token('line')).toBe('#2a2a3e');
	expect(contrastRatio(token('line'), token('card2'))).toBeLessThan(NON_TEXT);
	// The COUNT itself, pinned: app.css, FRONTEND.md and the header above all quote 17, and a literal grep has to
	// agree with them. app.css is one of the 17 — it keeps the token for `.card`'s edge and for the --border /
	// --input aliases. It was 18 until `keycap` moved to --control-line, which is the last control that spelled it.
	expect(filesSpelling('var(--line)').length).toBe(17);
});

/** Every rule below targets an element its own file renders, so reading the source is sound here: there is no
 *  chance of a selector that survives the source read but is dropped from the build. `needle` defaults to the
 *  authored-CSS spelling; the two Button variants are Tailwind utilities (legal, because `src/lib/components/ui/`
 *  is the one directory app.css scans) and carry their own. */
const CSS_BOUNDARY = 'border: 1px solid var(--control-line);';
const BOUNDARIES: { file: string; why: string; needle?: string }[] = [
	{ file: 'src/lib/components/ui/input/input.svelte', why: '.encore-field, fill --card2 (--card on `join`)' },
	{ file: 'src/lib/components/ui/textarea/textarea.svelte', why: '.encore-textarea, fill --card2' },
	{ file: 'src/lib/components/ui/native-select/native-select.svelte', why: '.encore-field, fill --card2' },
	// The wrapper IS the field's boundary: `.findbox input` is `border: 0`.
	{ file: 'src/lib/ui/FindField.svelte', why: '.findbox, fill --card' },
	// The review's headline symptom, and NOT reachable through any form primitive: the boxes are
	// `class="segment card"` and take app.css's `.card` hairline unless `.segment` overrides it.
	{ file: 'src/lib/components/CodeEntry.svelte', why: '.segment room-code box, fill --card' },
	{ file: 'src/routes/settings/+page.svelte', why: "input[type='color'].colour" },
	// A SLIDER'S RAIL, and the one boundary whose INNER neighbour is the floor surface below: the ring sits on
	// --track-bg (3.131) as well as on the --card outside it (3.972). Only the rail's filled half identified
	// anything before — --accent is 3.376:1 on --card, the unfilled --track-bg remainder 1.269:1.
	{ file: 'src/lib/components/ui/slider/slider.svelte', why: '.encore-slider-track, fill --track-bg on --card' },
	// A BUTTON is a control too, and these are the two variants whose border is the whole of it. `keycap` is
	// `bg-transparent`; `outline`'s only fill is `bg-background` (--bg), 1.14:1 on the --card surfaces it ships on.
	// Every other variant paints a fill that identifies it (--accent, --primary, --card2, --destructive/10).
	{
		file: 'src/lib/components/ui/button/button.svelte',
		why: 'keycap, bg-transparent on the drawer --card',
		needle: 'enabled:border-[var(--control-line)]'
	},
	{
		file: 'src/lib/components/ui/button/button.svelte',
		why: "outline, replacing the registry's border-border",
		needle: 'border-[var(--control-line)] bg-background'
	},
	// THE TRANSPORT, which this list did not reach until it was audited a second time. `.btn` shares one rule
	// with `.disc`, and `.disc` then sets `border-color: transparent` — so the shared declaration is the two
	// skip buttons' boundary and nothing else's. Its --card2 fill identifies nothing at either surface the band
	// ships on: 1.24:1 against --bg, and 1.09:1 against the --card that `.band` declares for the gallery (in the
	// real app `.band-slot` suppresses that and the sheet paints instead, which is why this is a bracket rather
	// than one number). So the border is the whole of it, and it sat on --line-strong — 1.44:1, the INERT token —
	// while every field around it had already moved to --control-line's 3.65:1.
	{ file: 'src/lib/components/NowPlayingBand.svelte', why: '.btn transport, fill --card2' }
];

test('every control boundary in the tree spells --control-line', () => {
	// A plain loop, not test.each: bun's each is printf-style and would print the substitution literally.
	for (const { file, why, needle } of BOUNDARIES) {
		const src = readFileSync(at(file), 'utf8');
		expect(src.includes(needle ?? CSS_BOUNDARY), `${file} (${why})`).toBe(true);
	}
});

test('the transport splits live from inert, and --line-strong survives only on the inert half', () => {
	const src = readFileSync(at('src/lib/components/NowPlayingBand.svelte'), 'utf8');
	const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
	// The shared `.btn, .disc` rule carries the LIVE boundary...
	expect(code).toContain(CSS_BOUNDARY);
	// ...and `:disabled` is the only thing that may put it back on --line-strong. Asserted as a rule rather than
	// as a substring count because the hover mix also names --control-line: what must not come back is an
	// UNQUALIFIED --line-strong border, which is what this file shipped before the second audit.
	expect(code).toMatch(/\.btn:disabled \{\s*border-color: var\(--line-strong\);/);
	expect(code).not.toMatch(/border: 1px solid var\(--line-strong\)/);
	// `.disc` must keep opting out, or the constant above starts describing three controls instead of two — and
	// the disc's border is transparent BECAUSE the progress arc sits outside its tap box.
	expect(code).toMatch(/\.disc \{[^}]*border-color: transparent;/);
});

test('the retargeted Button variants do not also keep a --line-valued border alongside it', () => {
	// `dark:` here is the plain prefers-color-scheme media query — no `.dark` class exists in this app — so a
	// surviving `dark:border-input` would put the boundary back on --line for exactly the users who asked for a
	// dark UI, while the non-prefixed utility kept the guard above green. Same for a re-vendored `border-border`.
	const src = readFileSync(at('src/lib/components/ui/button/button.svelte'), 'utf8');
	// Comments name both spellings as the registry diff to re-apply, so comments are stripped first and only the
	// code is scanned. `bg-input/30` is untouched by these patterns: --input stays aliased to --line as a FILL.
	const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
	expect(code).toContain('border-[var(--control-line)]');
	expect(code).not.toMatch(/border-border|border-input|border-\[var\(--line\)\]/);
});

test('tailwind-merge drops the base `border-transparent` for the variant boundary', () => {
	// LOAD-BEARING, and not obvious from the source: Tailwind emits `.border-transparent` AFTER
	// `.border-[var(--control-line)]` in the built sheet, and both are one class. So the variant wins only
	// because `cn()` REMOVES the base's `border-transparent` from the class list — not because it outranks it.
	// If tailwind-merge ever stopped classifying `border-[var(--css-var)]` as a border-COLOR (it could plausibly
	// read it as a border-WIDTH), every bordered variant would paint a transparent edge and no source read would
	// show it. Measured in a real browser at the time of writing: `outline` on /settings resolved to
	// rgb(118,118,158) with `border-transparent` absent from the element's class list.
	expect(cn('border border-transparent', 'border-[var(--control-line)]')).not.toContain('border-transparent');
	// The `enabled:` form does NOT conflict with an unprefixed class, so `keycap` relies on its OWN unprefixed
	// `border-[var(--line-strong)]` to evict the base, then outranks it at (0,2,0) when enabled.
	expect(cn('border border-transparent', 'border-[var(--line-strong)]')).not.toContain('border-transparent');
});

/** The ONE live control boundary still on the --line family, and FRONTEND.md names it as such. Pinned rather
 *  than left implicit, because the doc quotes its ratio: if someone fixes the checkbox, this reds and the doc
 *  gets updated in the same change instead of going stale in the other direction. */
test('the vendored checkbox is the only documented exception, and still measures what the doc says', () => {
	const src = readFileSync(at('src/lib/components/ui/checkbox/checkbox.svelte'), 'utf8');
	expect(src).toContain('border-input');
	// --input is aliased to --line, and the box's fill is the --card surface it sits on.
	expect(appCss).toMatch(/--input:\s*var\(--line\);/);
	expect(contrastRatio(token('line'), token('card'))).toBeCloseTo(1.23, 2);
});

/** The third boundary the review named, and the one that took a RING rather than a repaint. It is worth its own
 *  test because the tempting fix is to brighten --track-bg, which would repaint Bars, TvProgress, SongRow and /tv
 *  for one control — the same shortcut the --line assertion above forbids. */
test('the slider rail identifies the control, and a rail FILL could not have done it', () => {
	// Every figure below is quoted in the component's comment and in FRONTEND.md, so they are pinned to the digit
	// the prose states rather than merely bounded. The half that always complied: the --accent range on --card.
	expect(contrastRatio(token('accent'), token('card'))).toBeCloseTo(3.376, 3);
	// The half that did not, and at a low value it is MOST of the rail. --track-bg keeps this value: it is a
	// SURFACE, and the ranking above measures the boundary against it.
	expect(contrastRatio(token('track-bg'), token('card'))).toBeCloseTo(1.269, 3);
	// The ring, against BOTH neighbours. The inner figure is the floor the first test ranks first, and this rail is
	// what makes it load-bearing: before it, no boundary in the tree sat on --track-bg.
	expect(contrastRatio(token('control-line'), token('card'))).toBeCloseTo(3.972, 3);
	expect(contrastRatio(token('control-line'), token('track-bg'))).toBeCloseTo(3.131, 3);
	// WHY NO FILL WOULD SERVE, as a measurement rather than as prose: on --card, 3:1 arrives between #666 and
	// #6a6a6a, so any compliant rail FILL is a mid-grey bar — not a dark app's slider track.
	expect(contrastRatio('#666666', token('card'))).toBeCloseTo(2.99, 2);
	expect(contrastRatio('#666666', token('card'))).toBeLessThan(NON_TEXT);
	expect(contrastRatio('#6a6a6a', token('card'))).toBeCloseTo(3.18, 2);
	expect(contrastRatio('#6a6a6a', token('card'))).toBeGreaterThanOrEqual(NON_TEXT);
	// The rule is on the BASE class, so both variants take it — `guiding` only overrides height and radius.
	const slider = readFileSync(at('src/lib/components/ui/slider/slider.svelte'), 'utf8');
	expect(slider).toMatch(/\.encore-slider-track \{[^}]*border: 1px solid var\(--control-line\);/);
	expect(slider).not.toMatch(/\[data-variant='guiding'\] \{[^}]*border:/);
	// `*{box-sizing:border-box}` means the declared height INCLUDES the ring, so both rails grew 2px to keep the
	// painted fill they had: 4px inside the guiding rail, 6px inside the field rail.
	expect(appCss).toMatch(/\*\s*\{[^}]*box-sizing: border-box;/);
	expect(slider).toMatch(/\[data-variant='guiding'\] \{\s*height: 6px;/);
	expect(slider).toMatch(/\.encore-slider-track \{\s*height: 8px;/);
});

test('--line-strong bounds nothing but INERT controls, which 1.4.11 exempts by name', () => {
	// The review flagged --line-strong (1.57:1 on --card) "where it bounds a control". Both such sites are
	// disabled states — the dashed `keycap` and the slider thumb's `data-disabled:` — and 1.4.11's exception list
	// starts with "inactive user interface components". If a LIVE control reaches for it, that reasoning is gone.
	expect(contrastRatio(token('line-strong'), token('card'))).toBeLessThan(NON_TEXT);
	const button = readFileSync(at('src/lib/components/ui/button/button.svelte'), 'utf8');
	// `border-dashed border-[var(--line-strong)]` is the RESTING state, upgraded by `enabled:` — so the only way
	// it paints is on a disabled button.
	expect(button).toContain('border-dashed border-[var(--line-strong)]');
	expect(button).toContain('enabled:border-solid enabled:border-[var(--control-line)]');
	const slider = readFileSync(at('src/lib/components/ui/slider/slider.svelte'), 'utf8');
	expect(slider).toContain('data-disabled:border-[var(--line-strong)]');
});

test('app.css `.card` is one unlayered class, which is the specificity CodeEntry.segment has to outrank', () => {
	// `.segment` composes `.card` and overrides its border. Svelte compiles `.segment` to
	// `.segment.svelte-<hash>` (0,2,0); this asserts the rule it beats is a bare single class (0,1,0) written
	// outside every @layer, so the override cannot be flipped by stylesheet order.
	expect(appCss).toMatch(/\.card \{[^}]*border: 1px solid var\(--line\);/);
	const layerBlocks = appCss.match(/@layer\s+\w+\s*\{/g) ?? [];
	// One `@layer base` block exists (the form-element reset). The `.card` rule must sit after it closes, not
	// inside it — a layered rule loses to every unlayered one regardless of specificity.
	const cardAt = appCss.indexOf('\n.card {');
	expect(cardAt).toBeGreaterThan(-1);
	for (const block of layerBlocks) {
		const open = appCss.indexOf(block);
		const close = appCss.indexOf('\n}', open);
		expect(cardAt > close || cardAt < open).toBe(true);
	}
});
