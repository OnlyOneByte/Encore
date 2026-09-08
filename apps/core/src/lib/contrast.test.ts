// guard: the token palette must satisfy WCAG AA, and --grad must never carry a label.
//
// This computes real contrast ratios from the hex values in app.css rather than eyeballing them,
// because the defect it exists to catch was invisible to every other gate: `color:#fff` on
// `var(--grad)` measured 2.84:1 on the pink stop — below even the 3:1 non-text floor — and shipped
// on every primary button in the app for months while the suite stayed green.
//
// Why a source scan and not a rendered check: contrast is a property of the token VALUES, so it is
// decidable from the stylesheet. A browser is not needed and would only add flake.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SINGER_COLORS } from '@encore/shared';
import { svelteFiles } from './test-helpers';

const SRC = join(import.meta.dir, '..');
const css = readFileSync(join(SRC, 'app.css'), 'utf8');

/** Pull a `--name: #hex;` token out of app.css. Fails loudly rather than silently defaulting. */
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
 * What `fg` actually paints as, when it sits inside a subtree an ancestor renders at `alpha` over
 * `behind`. An ancestor `opacity` flattens the whole subtree into one buffer and composites that
 * buffer once, so the glyph's own pixel is a straight `alpha` lerp toward the page background --
 * the card surface underneath it is inside the same buffer and does not shield it.
 *
 * Cross-checked against painted pixels (#735, headless Chromium 151 at 390px, deviceScaleFactor 1):
 * `--warn` at 0.55 over `--bg` predicts rgb(145,106,50) and measured rgb(145,106,50); the pending
 * card surface predicts rgb(19,19,30) and measured rgb(19,19,30).
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

/** Blank out CSS and markup comments so a scan never matches prose ABOUT a declaration. The
 *  components below carry a comment naming the very `opacity` this file bans. */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
}

/** `selector` targets the class `name` (not merely a longer class that contains its text). */
function targets(selector: string, name: string): boolean {
	return new RegExp(`\\.${name}(?![\\w-])`).test(selector);
}

/**
 * `selector` styles a card root ITSELF, rather than something inside one. Load-bearing for the
 * surface half below: `.up .seq` targets the root class `.up`, but what it paints is the sequence
 * bubble's own background, which is not a surface the root's text is drawn on.
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
 * Every class that can land on a CARD ROOT in this file -- an element carrying the shared
 * `card list-row` pair (QueueRow, ProcessingCard, SongRow). Static names and `class:x={...}`
 * directives both count: `pending` reaches the root only as a directive.
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

test('--on-accent passes AA on --accent-strong (the actionable pair)', () => {
	const r = ratio(token('on-accent'), token('accent-strong'));
	expect(r).toBeGreaterThanOrEqual(AA_TEXT);
});

/*
 * THE GAP THIS CLOSES. The accent tokens exist to be BACKGROUNDS that carry --on-accent. Used the
 * other way round -- as a text colour on a dark surface -- they both fail AA outright:
 *
 *   --accent        on --card = 3.95:1
 *   --accent-strong on --card = 3.52:1   (worse, because "strong" means darker, for white ON it)
 *
 * That is counter-intuitive enough that it already happened once: the /metrics "slowest cooks" links
 * shipped as `color: var(--accent)` and the suite stayed green, because every other test here checks
 * whether a PAIR is safe and none checked whether this pair was in USE. A reviewer then proposed
 * "fix" it by switching to --accent-strong, which would have made the contrast worse while looking
 * like a remedy. So this test asserts the pairs are unusable AND scans for anyone using them, the
 * same belt-and-braces shape as the --grad usage scan.
 */
test('the accent tokens are not safe as text, and nothing uses them that way', () => {
	for (const t of ['accent', 'accent-strong']) {
		expect(ratio(token(t), token('card'))).toBeLessThan(AA_TEXT);
	}

	const files = [join(SRC, 'app.css'), ...svelteFiles(join(SRC, 'lib')), ...svelteFiles(join(SRC, 'routes'))];
	const offenders: string[] = [];
	for (const f of files) {
		for (const block of readFileSync(f, 'utf8').matchAll(/\{([^{}]*)\}/g)) {
			const body = block[1]!;
			// A `color:` set to an accent token. A background, border or fill is the intended use.
			if (/(^|[;\s])color:\s*var\(--accent(-strong)?\)/.test(body)) {
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

/*
 * The test above proves --focus is SAFE on every surface a ring can land on, but it never looks at
 * what colour any rule actually draws a ring IN -- so a rule ringing in --accent (a darker
 * background token, 3.63:1 on --card2 vs --focus's 5.08:1) or, worse, in the surface colour itself
 * (an invisible ring) sailed past it. #149: the queue peek and every Trend column rang in --accent.
 * This closes the class in the same belt-and-braces shape as the --grad and --accent scans: every
 * `outline`/`outline-color` that names a colour must name --focus. A bare reset (`outline: none`,
 * `outline: 0`) draws no ring and is allowed; `outline-offset` and `outline-width` set no colour.
 * MUTATION-VERIFIED against #149: recolouring either ring to var(--accent) or var(--card2) reds this.
 */
test('every focus outline is drawn in --focus, not --accent or the surface colour', () => {
	const files = [join(SRC, 'app.css'), ...svelteFiles(join(SRC, 'lib')), ...svelteFiles(join(SRC, 'routes'))];
	const offenders: string[] = [];
	// A shorthand `outline:` or a longhand `outline-color:` that carries a colour. Not matched:
	// outline-offset / outline-width / outline-style (no colour), and a bare `outline: none|0` reset.
	const outlineRule = /(?:^|[;\s])outline(?:-color)?:\s*([^;]+?)\s*(?:;|$)/g;
	for (const f of files) {
		for (const block of readFileSync(f, 'utf8').matchAll(/\{([^{}]*)\}/g)) {
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

/**
 * The regression that motivated this file. --grad is decoration; a `color:` in the same rule block
 * means someone put a label back on it. Scanning rule blocks rather than whole files keeps this from
 * firing on a bar fill that merely sits near an unrelated color declaration.
 */
test('no rule puts a text color on var(--grad)', () => {
	const files = [join(SRC, 'app.css'), ...svelteFiles(join(SRC, 'lib')), ...svelteFiles(join(SRC, 'routes'))];
	const offenders: string[] = [];
	for (const f of files) {
		for (const block of readFileSync(f, 'utf8').matchAll(/\{([^{}]*)\}/g)) {
			const body = block[1]!;
			if (!body.includes('var(--grad)')) continue;
			// `-webkit-background-clip:text` with `color:transparent` is the wordmark: the gradient IS
			// the glyph fill against the page background, a different contract, and legitimate.
			if (/background-clip:\s*text/.test(body)) continue;
			if (/(^|[;\s])color:/.test(body)) {
				offenders.push(`${f.replace(SRC, 'src')}: text color on var(--grad)`);
			}
		}
	}
	expect(offenders).toEqual([]);
});

/*
 * ANCESTOR OPACITY -- the case this file's own stated premise misses (#735).
 *
 * Every test above compares two TOKEN VALUES, which the header justifies with "contrast is a
 * property of the token VALUES, so it is decidable from the stylesheet". That holds only while
 * nothing between the glyph and the page changes its alpha. A card ROOT that dims itself with
 * `opacity` flattens its ENTIRE subtree -- the text that explains the state included -- and
 * composites it against --bg, so a pair certified safe above renders below its floor. Measured off
 * painted pixels on a pending queue row: `--warn` on `--card` is 9.99:1 as a token pair (asserted by
 * `status colors pass AA as text on a card`) and 3.77:1 through `opacity: 0.55`; --ink-dim 6.27:1 ->
 * 2.68:1; the singer identity dot 5.97:1 -> 2.57:1, under the 3:1 floor colors.ts:51's
 * MIN_DOT_CONTRAST refuses a STORED singer colour for. The dim silently pushed an already-certified
 * colour under the app's own gate.
 *
 * THE FIX IS NOT A BIGGER NUMBER, and that is why this guard bans the mechanism rather than checking
 * a threshold. Minimum alpha for each pair to reach its own floor over --bg: --warn 0.619, the dot
 * 0.620, --ink-dim 0.807. The value that saves the byline is visually indistinguishable from 1.0, so
 * no alpha is both legible and a perceptible state signal. State therefore goes on the SURFACE
 * (background + border), which composites nothing -- the guard below it pins that replacement.
 *
 * SCOPE: card ROOTS only, deliberately. `.who i.dim` (opacity 0.5 on the away dot) and
 * `.act:disabled` each dim one leaf, which is the in-repo pattern this steers toward. The away dot's
 * own 2.42:1 is pre-existing and an owner proposal (#735 §6), not this guard's business.
 *
 * MUTATION-VERIFIED: re-adding `opacity: 0.55` to either `.pending` rule reds this naming four pairs.
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

		// Surfaces this card root paints on ITSELF, plus the shared `.card` default from app.css.
		const surfaces = new Set(['card']);
		// Text tokens the subtree draws in, plus the body ink it inherits. Two exclusions: a rule that
		// sets BOTH a colour and a background carries its own surface (the .seq bubble), and an
		// interaction state (:active on the remove button) is not a resting render -- and is anyway
		// unreachable while pending, which hides the action cluster.
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
	// Non-vacuity: the scan must still be FINDING card roots. Renaming the shared `card list-row`
	// pair would otherwise turn this test green by discovering nothing.
	expect(rootsScanned).toBeGreaterThanOrEqual(3);
});

/*
 * The replacement mechanism, pinned. With the dim gone, "not yet committed" is a warn-tinted SURFACE
 * (`--warn-bg` + `--warn-line`), and the whole point is that the subtree keeps full opacity -- so
 * every ink a pending card draws has to clear its floor on that surface, singer dot included. This
 * is the pair-value half the test above cannot cover, because after the fix it finds no opacity to
 * composite. --warn-bg is also already the /metrics "no worker connected" banner's surface.
 */
test('--warn-bg carries every ink a pending card draws on it', () => {
	const fails: string[] = [];
	for (const ink of ['ink', 'ink-dim', 'warn']) {
		const r = ratio(token(ink), token('warn-bg'));
		if (r < AA_TEXT) fails.push(`--${ink} on --warn-bg: ${r.toFixed(2)}`);
	}
	// The dot is non-text UI, so 3:1 -- the same floor colors.ts's isLegibleSingerColor enforces on
	// --bg and --card, now also required on the surface a pending card paints under it.
	for (const dot of SINGER_COLORS) {
		const r = ratio(dot, token('warn-bg'));
		if (r < AA_LARGE) fails.push(`singer dot ${dot} on --warn-bg: ${r.toFixed(2)}`);
	}
	expect(fails).toEqual([]);
});
