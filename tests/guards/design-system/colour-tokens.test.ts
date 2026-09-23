/*
 * guard: the colour token layer against the 48-stop palette registry. See
 * docs/GUARDS.md#colour-tokens-and-the-48-stop-palette. Four claims, each of which fails silently:
 *
 *  - `--accent-strong` is retired. Its failure mode is a token lingering in one forgotten rule and
 *    quietly re-introducing a second accent with no rule for which wins.
 *  - `--accent-ink` stays a REQUIRED, DISTINCT token: it differs from `fill` for 13 of 48 stops, so
 *    collapsing the two downgrades those 13 to sub-AA text.
 *  - `--on-accent` is per-stop (36 dark / 12 white), so a fill and its ink must be EMITTED AS ONE PAIR.
 *  - all four per-stop roles reach CSS as CUSTOM PROPERTIES, or a component needing `on_fill` reaches
 *    for a literal.
 *
 * Not in `contrast.test.ts` because that file is deliberately a pure token-VALUE guard that does not know
 * the registry exists; these claims are about the relationship between the two. Ratios are recomputed
 * from the hex values rather than read out of the registry's `r_*` fields, because a test that trusts the
 * numbers the generator printed cannot catch a generator that measured the wrong thing.
 */
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { read, srcDir } from '@encore/test-support';
// A subpath import, not `$lib/contract`: that package's `exports` map carries only `"."`. It fails loudly
// with `Cannot find module` rather than silently reading nothing.
import registry from '$lib/contract/presentation/player-palette-48.json';
import { svelteFiles } from '@encore/test-support/scan';

const SRC = srcDir;
const APP_CSS = read('src/app.css');

/** Every `.svelte` file that can carry a rule block or a style binding. */
const FILES = [...svelteFiles(join(SRC, 'lib')), ...svelteFiles(join(SRC, 'routes'))];

/**
 * `variants.chromatic` is the ratified palette. The artifact also carries `uniform`, the comparison it
 * was rejected against, so reading the wrong key measures a palette the app never ships.
 */
const STOPS = registry.variants.chromatic.stops;

/** WCAG AA for normal-size text. */
const AA = 4.5;

function channels(hex: string): [number, number, number] {
	let h = hex.replace('#', '');
	if (h.length === 3)
		h = h
			.split('')
			.map((c) => c + c)
			.join('');
	return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
	const [r, g, b] = channels(hex).map((v) => {
		const c = v / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
}

/** Pull a `--name: #hex;` token out of `app.css`. Throws rather than defaulting. */
function token(name: string): string {
	const m = APP_CSS.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`));
	if (!m) throw new Error(`token --${name} not found in app.css (renamed? then update this guard)`);
	return m[1]!;
}

/** Comments blanked, length preserved, so app.css's own prose can neither satisfy nor trip a scan. */
function stripCssComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** As above for `.svelte`, which carries both markup and CSS comments. */
function stripSvelteComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
}

/**
 * Both halves of the retirement. A declaration left behind is a second accent nothing rules between; a
 * `var()` read left behind resolves to NOTHING and paints the element's inherited background, which on a
 * dark surface is an invisible button rather than a visible error. Comments are stripped first, because
 * app.css and this file both NAME the retired token in order to explain why it is gone.
 */
test('--accent-strong is retired, not carried forward: nothing declares or reads it, anywhere in the token layer or the components', () => {
	const offenders: string[] = [];

	if (/--accent-strong\s*:/.test(stripCssComments(APP_CSS))) {
		offenders.push('src/app.css: still DECLARES --accent-strong');
	}

	for (const f of [join(SRC, 'app.css'), ...FILES]) {
		const raw = readFileSync(f, 'utf8');
		const src = f.endsWith('.css') ? stripCssComments(raw) : stripSvelteComments(raw);
		for (const m of src.matchAll(/var\(\s*--accent-strong\s*\)/g)) {
			offenders.push(`${f.replace(SRC, 'src')}:${src.slice(0, m.index!).split('\n').length}: reads it`);
		}
	}

	expect(offenders).toEqual([]);
});

/** Non-vacuity: the scan above reports offenders from a file walk, so an empty walk proves nothing. */
test('--accent-strong is retired, not carried forward: the retirement scan actually reads the component surface', () => {
	expect(FILES.length).toBeGreaterThan(15);
});

/**
 * The job did not vanish, it MOVED: `--accent` must carry a label on its own, which is the claim that
 * made the darkened sibling redundant. If this reds, the retirement was premature.
 */
test('--accent-strong is retired, not carried forward: the fill it was darkened from now carries its ink at AA on its own', () => {
	expect(ratio(token('on-accent'), token('accent'))).toBeGreaterThanOrEqual(AA);
});

/**
 * `--grad`'s second stop is asserted through `--accent2` rather than by parsing the gradient: the
 * gradient is DEFINED as `var(--accent), var(--accent2)`, so the custom property IS the second stop and
 * pinning that composition is what makes the claim true rather than incidental.
 */
test('every per-stop role reaches CSS as a custom property: the fill, its ink, the accent ink and the gradient second stop are all declared', () => {
	const css = stripCssComments(APP_CSS);
	const missing = (['accent', 'on-accent', 'accent-ink', 'accent2'] as const).filter(
		(name) => !new RegExp(`--${name}:\\s*#[0-9a-fA-F]{3,8}\\s*;`).test(css)
	);
	expect(missing).toEqual([]);

	// and the gradient really is composed from the two custom properties, not from literals
	expect(css).toMatch(/--grad:\s*linear-gradient\([^;]*var\(--accent\)[^;]*var\(--accent2\)[^;]*\);/);
});

/**
 * The `:root` seed is a REGISTRY PAIR, not two independently chosen hexes — the assertion that makes
 * "read from the single source" enforceable in a stylesheet, which cannot import JSON.
 *
 * It deliberately does NOT pin WHICH stop: re-seeding the brand default is a design decision, while
 * taking fill from one stop and ink from another is a defect, and only the second is refused.
 */
test('a fill and its ink are emitted as one pair: the seeded --accent / --on-accent pair is one stop from the registry', () => {
	const fill = token('accent').toLowerCase();
	const ink = token('on-accent').toLowerCase();

	const owning = STOPS.filter((s) => s.fill.toLowerCase() === fill);
	expect(
		owning.length,
		`--accent ${fill} is not any chromatic stop's fill — the token layer has drifted off the registry`
	).toBeGreaterThan(0);

	const paired = owning.filter((s) => s.on_fill.toLowerCase() === ink);
	expect(
		paired.map((s) => s.name),
		`--on-accent ${ink} is not the on_fill of the stop --accent came from ` +
			`(expected ${owning.map((s) => `${s.name}:${s.on_fill}`).join(', ')})`
	).not.toEqual([]);
});

/**
 * SETTING the property is the site this is about, not READING it: a rule painting `background: var(--accent)` inherits
 * whatever ink is in force and is fine, while a site that ASSIGNS `--accent: <a stop's fill>` without assigning
 * `--on-accent` in the same place has created a combination the registry never certified. Both assignment forms are
 * scanned — a CSS declaration in a rule block, and a Svelte inline `style="--accent:…"` / `style:--accent` binding.
 */
test('a fill and its ink are emitted as one pair: no site sets the fill property without setting its ink property too', () => {
	const offenders: string[] = [];

	for (const f of [join(SRC, 'app.css'), ...FILES]) {
		const raw = readFileSync(f, 'utf8');
		const isCss = f.endsWith('.css');
		const src = isCss ? stripCssComments(raw) : stripSvelteComments(raw);
		const where = f.replace(SRC, 'src');

		// (a) a CSS rule block, or the body of an inline style="…" attribute: both are `;`-separated
		//     declaration lists, so one scan covers them if the block delimiters are right.
		const blocks: { body: string; index: number }[] = [];
		for (const m of src.matchAll(/\{([^{}]*)\}/g)) blocks.push({ body: m[1]!, index: m.index! });
		for (const m of src.matchAll(/style="([^"]*)"/g)) blocks.push({ body: m[1]!, index: m.index! });

		for (const b of blocks) {
			// `--accent:` exactly — not `--accent-ink:`, `--accent2:`, and not a var() READ.
			if (!/(^|[;\s"])--accent\s*:/.test(b.body)) continue;
			if (/(^|[;\s"])--on-accent\s*:/.test(b.body)) continue;
			if (b.body.includes(':root')) continue; // defensive;:root's own block is matched above
			offenders.push(`${where}:${src.slice(0, b.index).split('\n').length}: sets --accent without --on-accent`);
		}

		// (b) Svelte's `style:--accent={…}` directive form, which carries no `;` list at all.
		for (const m of src.matchAll(/style:--accent=/g)) {
			const line = src.slice(0, m.index!).split('\n').length;
			// the paired directive has to be on the same element; the tag is the smallest honest scope
			const tagStart = src.lastIndexOf('<', m.index!);
			const tagEnd = src.indexOf('>', m.index!);
			const tag = src.slice(tagStart === -1 ? 0 : tagStart, tagEnd === -1 ? src.length : tagEnd);
			if (!/style:--on-accent=/.test(tag)) {
				offenders.push(`${where}:${line}: style:--accent without style:--on-accent on the same element`);
			}
		}
	}

	expect(offenders).toEqual([]);
});

/** The premise the pairing rule exists FOR: if `on_fill` were one rule rather than 48 facts, adjacency
 *  would be enough and the whole discipline would be over-engineering. */
test('a fill and its ink are emitted as one pair: on_fill is a per-stop fact, not a rule — 36 dark and 12 white', () => {
	const white = STOPS.filter((s) => s.on_fill.toLowerCase() === '#ffffff');
	expect(white.length).toBe(12);
	expect(STOPS.length - white.length).toBe(36);
});

/** Every pair the registry offers is usable, so a wrong PAIRING is the only way to fail. */
test('a fill and its ink are emitted as one pair: every stop carries its own ink at AA', () => {
	const weak = STOPS.filter((s) => ratio(s.on_fill, s.fill) < AA).map(
		(s) => `${s.name}: ${ratio(s.on_fill, s.fill).toFixed(2)}`
	);
	expect(weak).toEqual([]);
});

/** Still declared, and still NOT the fill. Collapsing the two is the failure. */
test('--accent-ink remains a required, distinct token: it is declared, and it is not a copy of the fill', () => {
	expect(token('accent-ink').toLowerCase()).not.toBe(token('accent').toLowerCase());
});

/**
 * The measurement that makes the token REQUIRED rather than tidy: for these 13 the deep fill cannot be
 * its own card ink, so a build resolving both to one value ships 13 sub-AA text colours.
 */
test('--accent-ink remains a required, distinct token: ink differs from fill for exactly the 13 stops that cannot be their own card ink', () => {
	const divergent = STOPS.filter((s) => s.accent_ink.toLowerCase() !== s.fill.toLowerCase()).map((s) => s.name);
	expect(divergent).toEqual([
		'Redline',
		'Scarlet',
		'Cerulean',
		'Cobalt',
		'Denim',
		'Periwinkle',
		'Iris',
		'Violet',
		'Magenta',
		'Fuchsia',
		'Orchid',
		'Rose',
		'Hibiscus'
	]);
});

/** On the surface the registry actually measured: all 48 clear AA as ink on `--card`. */
test('--accent-ink remains a required, distinct token: every stop clears AA as ink on the surface the registry measured', () => {
	const weak = STOPS.filter((s) => ratio(s.accent_ink, token('card')) < AA).map(
		(s) => `${s.name}: ${ratio(s.accent_ink, token('card')).toFixed(2)}`
	);
	expect(weak).toEqual([]);
});

/**
 * THIS TEST ASSERTS A DEFECT STILL EXISTS, so read why before "fixing" it.
 *
 * The registry certifies `accent_ink` against `--card` and all 48 pass there — but the app does not draw
 * accent ink on `--card`. Both `var(--accent-ink)` read sites sit on `--card-tint2`, a surface the
 * registry's `surfaces` block has never contained, where 16 of 48 stops FAIL AA. That is the registry's
 * own defect class one surface further out: figures generated against surfaces the app does not paint.
 *
 * So `--accent-ink` stays at its incumbent value (7.35:1 there) rather than adopting the seeded stop's
 * `accent_ink` (3.99:1 there). Whoever wires it per stop must first close the gap — by regenerating the
 * palette with the tint surfaces in scope, or by moving those two chips onto `--card` — and closing it
 * turns this expectation red, at which point DELETE THIS TEST: its premise will genuinely be gone.
 */
test('--accent-ink remains a required, distinct token: the tint surfaces the app paints ink on are still outside the registry\u2019s measured set', () => {
	expect(Object.keys(registry.surfaces).sort()).toEqual(['bg', 'card', 'card2']);

	const tint2 = token('card-tint2');
	const failing = STOPS.filter((s) => ratio(s.accent_ink, tint2) < AA);
	expect(
		failing.length,
		'stops failing AA as ink on --card-tint2. If this is now 0 the gap is CLOSED — delete this test ' +
			'and wire --accent-ink per stop.'
	).toBe(16);
});
