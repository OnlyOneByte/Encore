// guard: the token palette satisfies WCAG AA, and --grad never carries a label. Ratios are computed from
// the hex values in app.css, so a browser would add only flake. See docs/GUARDS.md#contrast.
//
// Caught: `color:#fff` on `var(--grad)` measuring 2.84:1 on the pink stop — below even the 3:1 non-text
// floor — shipping on every primary button in the app for months while the suite stayed green.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SINGER_COLORS } from '$lib/contract';
import { read, srcDir } from '@encore/test-support';
import { svelteFiles } from '@encore/test-support/scan';

const SRC = srcDir;
const css = read('src/app.css');

/** Pull a `--name: #hex;` token out of app.css. Throws rather than silently defaulting. */
function token(name: string): string {
	const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`));
	if (!m) throw new Error(`token --${name} not found in app.css (renamed? then update this guard)`);
	return m[1]!;
}

/** As `token`, but for a `var(--x)` scraped out of a rule: `--x` may be a runtime property, a
 *  gradient, or a colour set per-instance, none of which app.css declares as a hex. */
function tokenOrNull(name: string): string | null {
	const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`));
	return m ? m[1]! : null;
}

function channels(hex: string): [number, number, number] {
	let h = hex.replace('#', '');
	if (h.length === 3)
		h = h
			.split('')
			.map((c) => c + c)
			.join('');
	return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG 2.x relative luminance: sRGB → linear light, then the luma weights. */
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

/**
 * What `fg` paints as inside a subtree an ancestor renders at `alpha` over `behind`. An ancestor `opacity` flattens the
 * whole subtree into one buffer and composites it once, so the glyph's pixel is a straight `alpha` lerp toward the page
 * background — the card surface underneath is in the same buffer and does not shield it. Cross-checked against painted
 * pixels: `--warn` at 0.55 over `--bg` predicts rgb(145,106,50) and measured rgb(145,106,50).
 */
function composite(fg: string, alpha: number, behind: string): string {
	const b = channels(behind);
	return (
		'#' +
		channels(fg)
			.map((v, i) => Math.round(alpha * v + (1 - alpha) * b[i]!))
			.map((v) => v.toString(16).padStart(2, '0'))
			.join('')
	);
}

/** Blank comments so a scan never matches prose ABOUT a declaration — the components below carry a
 *  comment naming the very `opacity` this file bans. */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
}

/** `selector` targets the class `name`, not merely a longer class that contains its text. */
function targets(selector: string, name: string): boolean {
	return new RegExp(`\\.${name}(?![\\w-])`).test(selector);
}

/**
 * `selector` styles a card root ITSELF rather than something inside one. Load-bearing for the surface half
 * below: `.up .seq` targets the root class `.up`, but what it paints is the sequence bubble's own background,
 * not a surface the root's text is drawn on.
 */
function stylesRootItself(selector: string, roots: string[]): boolean {
	return selector.split(',').some((part) => {
		const last =
			part
				.trim()
				.split(/[\s>+~]+/)
				.filter(Boolean)
				.pop() ?? '';
		return roots.some((c) => targets(last, c));
	});
}

/** A transient interaction state, not the resting render a contrast floor is about. */
function isInteractionState(selector: string): boolean {
	return /:(hover|active|focus|focus-visible|focus-within)\b/.test(selector);
}

/** Rule blocks as selector + body. Flat by design: a nested `@media` wrapper's own body contains
 *  braces so it never matches, while the rules inside it do. */
function rules(src: string): { selector: string; body: string }[] {
	return [...src.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
}

/**
 * Every class that can land on a CARD ROOT — an element carrying the shared `card list-row` pair. Static
 * names and `class:x={…}` directives both count, since `pending` reaches the root only as a directive.
 */
function cardRootClasses(src: string): string[] {
	const out = new Set<string>();
	for (const tag of src.matchAll(/<[a-z][\w-]*\b[^>]*>/gi)) {
		const t = tag[0]!;
		const names = (t.match(/\bclass="([^"]*)"/)?.[1] ?? '').split(/\s+/).filter(Boolean);
		if (!(names.includes('card') && names.includes('list-row'))) continue;
		for (const n of names) out.add(n);
		for (const d of t.matchAll(/\bclass:([\w-]+)/g)) out.add(d[1]!);
	}
	return [...out];
}

/**
 * CSS regions only, never whole-file text: a vendored shadcn component puts Tailwind CLASS NAMES in a
 * `<script>` string (`outline-none select-none …`), where the declaration patterns below matched and reported
 * a whole variant map as a bad outline colour. The fix is scope, not a weaker pattern.
 */
const cssOf = (src: string, file: string) =>
	file.endsWith('.css') ? src : [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]!).join('\n');

/** Every file that can carry a rule, app.css first. */
const styledFiles = () => [join(SRC, 'app.css'), ...svelteFiles(join(SRC, 'lib')), ...svelteFiles(join(SRC, 'routes'))];

const AA_TEXT = 4.5; // body text
const AA_LARGE = 3.0; // large text, icons, and other non-text UI

test('body text passes AA on every surface it is drawn on', () => {
	const fails: string[] = [];
	for (const ink of ['ink', 'ink-dim']) {
		for (const surface of ['bg', 'card', 'card2', 'card-tint', 'card-tint2']) {
			const r = ratio(token(ink), token(surface));
			if (r < AA_TEXT) fails.push(`--${ink} on --${surface}: ${r.toFixed(2)}`);
		}
	}
	expect(fails).toEqual([]);
});

test('status colors pass AA as text on a card', () => {
	const fails: string[] = [];
	for (const c of ['ok', 'warn', 'danger']) {
		const r = ratio(token(c), token('card'));
		if (r < AA_TEXT) fails.push(`--${c} on --card: ${r.toFixed(2)}`);
	}
	expect(fails).toEqual([]);
});

test('--on-accent passes AA on --accent (the actionable pair)', () => {
	// The per-stop half — all 48 registry pairs clearing AA, and `:root`'s pair being one of them — is in
	// colour-tokens.test.ts, which can import the registry; this file stays a pure token-value guard.
	const r = ratio(token('on-accent'), token('accent'));
	expect(r).toBeGreaterThanOrEqual(AA_TEXT);
});

/*
 * The accent fill is a BACKGROUND that carries --on-accent; as ink on a dark surface it fails AA outright at
 * 3.38:1 on `--card`. Counter-intuitive enough that it shipped — the /metrics "slowest processes" links were
 * `color: var(--accent)` and the suite stayed green, because every other arm checks whether a PAIR is safe
 * and none checked whether the pair was in USE.
 *
 * ── RECORDED RULING FOR THE PALETTE MIGRATION ──────────────────────────────
 *
 * This test opened with a loop asserting the accent-as-ink pairs FAIL AA (`toBeLessThan`), so it would have
 * RED rather than gone quiet the day a palette cleared AA as ink. The ruling made in advance was RE-ANCHOR,
 * DO NOT DELETE: drop the contrast loop only, keep the usage scan verbatim, record the swap.
 *
 * EXECUTED. LEFT SCOPE: "accent-as-ink fails AA" as a UNIVERSAL fact — it is per-stop now and mostly FALSE
 * (35 of 48 fills clear AA on `--card`), so asserting it against whichever stop happens to be seeded says
 * nothing about the palette. The threshold was not relaxed and the arm was not inverted; it was dropped.
 * STILL COVERED: the usage scan below, verbatim, because "the accent fill is a background, not ink" remains a
 * design rule after it stops being a contrast fact. The AA question is answered per stop by
 * colour-tokens.test.ts, and non-vacuity-floors.test.ts holds the machine-checkable half of this record.
 */
test('the accent fill is a background by design, and nothing draws text in it', () => {
	const offenders: string[] = [];
	for (const f of styledFiles()) {
		for (const block of cssOf(readFileSync(f, 'utf8'), f).matchAll(/\{([^{}]*)\}/g)) {
			const body = block[1]!;
			// A `color:` set to the accent fill. A background, border or fill is the intended use.
			if (/(^|[;\s])color:\s*var\(--accent\)/.test(body)) {
				offenders.push(`${f.replace(SRC, 'src')}: text color on var(--accent)`);
			}
		}
	}
	expect(offenders).toEqual([]);
});

test('the focus ring is visible against every surface it can appear on', () => {
	const fails: string[] = [];
	for (const surface of ['bg', 'card', 'card2']) {
		const r = ratio(token('focus'), token(surface));
		if (r < AA_LARGE) fails.push(`--focus on --${surface}: ${r.toFixed(2)}`);
	}
	expect(fails).toEqual([]);
});

test('every focus outline is drawn in --focus, not --accent or the surface colour', () => {
	// The arm above proves --focus is SAFE on every surface a ring can land on but never looks at what colour
	// a rule draws a ring IN, so a ring in --accent (3.10:1 on --card2 against --focus's 5.08:1) or in the
	// surface colour itself sailed past it. The queue peek and every Trend column once rang in --accent.
	const offenders: string[] = [];
	// A shorthand `outline:` or longhand `outline-color:` carrying a colour. Not matched: outline-offset,
	// -width and -style (no colour), and a bare `outline: none|0` reset, which draws no ring.
	const outlineRule = /(?:^|[;\s])outline(?:-color)?:\s*([^;]+?)\s*(?:;|$)/g;
	for (const f of styledFiles()) {
		for (const block of cssOf(readFileSync(f, 'utf8'), f).matchAll(/\{([^{}]*)\}/g)) {
			const body = block[1]!;
			for (const m of body.matchAll(outlineRule)) {
				const value = m[1]!.trim();
				if (/^(none|0|0px|unset|inherit|initial|revert)$/.test(value)) continue; // a reset, no ring
				if (!/\bvar\(--focus\)/.test(value)) {
					offenders.push(`${f.replace(SRC, 'src')}: outline "${value}" is not var(--focus)`);
				}
			}
		}
	}
	expect(offenders).toEqual([]);
});

test('no rule puts a text color on var(--grad)', () => {
	// --grad is decoration; a `color:` in the same rule block means someone put a label back on it. Rule
	// blocks rather than whole files, so this cannot fire on a bar fill near an unrelated declaration.
	//
	// The ban rested on one figure — white on the pink stop, 2.84:1 — and with `accent2` derived per stop this
	// is 48 gradients. Re-measured: a stop's own certified `on_fill` clears AA at BOTH endpoints for only 36
	// of 48 (worst Scarlet, 1.85:1), and those 36 are not a licence either, because the registry certifies
	// the ENDPOINTS while a label sits over the interpolated interior.
	const offenders: string[] = [];
	for (const f of styledFiles()) {
		for (const block of cssOf(readFileSync(f, 'utf8'), f).matchAll(/\{([^{}]*)\}/g)) {
			const body = block[1]!;
			if (!body.includes('var(--grad)')) continue;
			// `-webkit-background-clip:text` with `color:transparent` is the wordmark: the gradient IS the
			// glyph fill against the page background, a different contract, and legitimate.
			if (/background-clip:\s*text/.test(body)) continue;
			if (/(^|[;\s])color:/.test(body)) {
				offenders.push(`${f.replace(SRC, 'src')}: text color on var(--grad)`);
			}
		}
	}
	expect(offenders).toEqual([]);
});

/*
 * ANCESTOR OPACITY — the case this file's own premise misses. Every arm above compares two TOKEN VALUES, which holds
 * only while nothing between the glyph and the page changes its alpha. A card ROOT that dims itself flattens its ENTIRE
 * subtree and composites it against --bg, so a pair certified safe renders below its floor: measured off painted pixels
 * on a pending queue row, `--warn` on `--card` is 9.99:1 as a token pair and 3.77:1 through `opacity: 0.55`; --ink-dim
 * 6.27 -> 2.68; the singer dot 5.97 -> 2.57, under the 3:1 floor the app itself refuses a STORED singer colour for.
 *
 * THE FIX IS NOT A BIGGER NUMBER, which is why this bans the mechanism rather than checking a threshold: the
 * minimum alpha for each pair to reach its own floor over --bg is 0.619 / 0.620 / 0.807, visually
 * indistinguishable from 1.0, so no alpha is both legible and a perceptible state signal. State goes on the
 * SURFACE (background + border), which composites nothing.
 *
 * SCOPE: card ROOTS only — `.who i.dim` and `.act:disabled` each dim ONE leaf, the pattern this steers
 * toward. MUTATION-VERIFIED: re-adding `opacity: 0.55` to either `.pending` rule reds this naming four
 * pairs. The inline-`style=` dimension is layout/phone-inventory.test.ts's.
 */
test('no card root dims its own subtree with opacity', () => {
	const files = [...svelteFiles(join(SRC, 'lib')), ...svelteFiles(join(SRC, 'routes'))];
	const bg = token('bg');
	const fails: string[] = [];
	let rootsScanned = 0;

	for (const f of files) {
		const src = stripComments(readFileSync(f, 'utf8'));
		const roots = cardRootClasses(src);
		if (roots.length === 0) continue;
		rootsScanned++;
		const rs = rules(src);

		// Surfaces this root paints on ITSELF, seeded with `card`: the component paints `bg-card`, which
		// resolves through the semantic bridge to the same token, so a card root sits on `--card` either way.
		const surfaces = new Set(['card']);
		// Text tokens the subtree draws in, plus the inherited body ink. Two exclusions: a rule setting BOTH a
		// colour and a background carries its own surface, and an interaction state is not a resting render.
		const inks = new Set(['ink']);
		let drawsSingerDot = false;
		for (const { selector, body } of rs) {
			if (stylesRootItself(selector, roots))
				for (const decl of body.matchAll(/(?:^|[;\s])background(?:-color|-image)?:([^;]*)/g))
					// Every var in the value, not just the first: a `.mine` row paints
					// `linear-gradient(var(--card), var(--card-tint))` and its text sits on both stops.
					for (const m of decl[1]!.matchAll(/var\(--([\w-]+)\)/g)) surfaces.add(m[1]!);
			const hasOwnSurface = /(?:^|[;\s])background(?:-color|-image)?:/.test(body);
			if (!hasOwnSurface && !isInteractionState(selector))
				for (const m of body.matchAll(/(?:^|[;\s])color:\s*var\(--([\w-]+)\)/g)) inks.add(m[1]!);
			if (/background(?:-color)?:\s*var\(--singer\)/.test(body)) drawsSingerDot = true;
		}

		for (const { selector, body } of rs) {
			if (!stylesRootItself(selector, roots)) continue;
			const m = body.match(/(?:^|[;\s])opacity:\s*([\d.]+)/);
			if (!m) continue;
			const alpha = Number(m[1]);
			if (!(alpha < 1)) continue;
			const where = `${f.replace(SRC, 'src')} ${selector} { opacity: ${alpha} }`;
			for (const s of surfaces) {
				const surface = tokenOrNull(s);
				if (!surface) continue; // a runtime property or a gradient, not a hex we can composite
				const dimSurface = composite(surface, alpha, bg);
				for (const i of inks) {
					const ink = tokenOrNull(i);
					if (!ink) continue;
					const r = ratio(composite(ink, alpha, bg), dimSurface);
					if (r < AA_TEXT) fails.push(`${where}: --${i} on --${s} renders ${r.toFixed(2)} (needs ${AA_TEXT})`);
				}
				if (drawsSingerDot)
					for (const dot of SINGER_COLORS) {
						const r = ratio(composite(dot, alpha, bg), dimSurface);
						if (r < AA_LARGE)
							fails.push(`${where}: singer dot ${dot} on --${s} renders ${r.toFixed(2)} (needs ${AA_LARGE})`);
					}
			}
		}
	}

	expect(fails).toEqual([]);
	// Renaming the shared `card list-row` pair would turn this green by discovering nothing.
	expect(rootsScanned).toBeGreaterThanOrEqual(3); // @nvf-floor rootsScanned
});

test('--warn-bg carries every ink a pending card draws on it', () => {
	// The replacement mechanism: "not yet committed" is a warn-tinted SURFACE at full opacity, so every ink a
	// pending card draws has to clear its floor on it. This is the pair-value half the arm above cannot cover,
	// because after the fix it finds no opacity to composite.
	const fails: string[] = [];
	for (const ink of ['ink', 'ink-dim', 'warn']) {
		const r = ratio(token(ink), token('warn-bg'));
		if (r < AA_TEXT) fails.push(`--${ink} on --warn-bg: ${r.toFixed(2)}`);
	}
	// The dot is non-text UI, so 3:1 — the same floor `isLegibleSingerColor` enforces on --bg and --card.
	for (const dot of SINGER_COLORS) {
		const r = ratio(dot, token('warn-bg'));
		if (r < AA_LARGE) fails.push(`singer dot ${dot} on --warn-bg: ${r.toFixed(2)}`);
	}
	expect(fails).toEqual([]);
});
