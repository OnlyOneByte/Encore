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
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..');
const css = readFileSync(join(SRC, 'app.css'), 'utf8');

/** Pull a `--name: #hex;` token out of app.css. Fails loudly rather than silently defaulting. */
function token(name: string): string {
	const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`));
	if (!m) throw new Error(`token --${name} not found in app.css (renamed? then update this guard)`);
	return m[1]!;
}

function channels(hex: string): [number, number, number] {
	let h = hex.replace('#', '');
	if (h.length === 3) h = h.split('').map((c) => c + c).join('');
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

	const files = [
		join(SRC, 'app.css'),
		...svelteFiles(join(SRC, 'lib')),
		...svelteFiles(join(SRC, 'routes'))
	];
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

/**
 * The regression that motivated this file. --grad is decoration; a `color:` in the same rule block
 * means someone put a label back on it. Scanning rule blocks rather than whole files keeps this from
 * firing on a bar fill that merely sits near an unrelated color declaration.
 */
test('no rule puts a text color on var(--grad)', () => {
	const files = [
		join(SRC, 'app.css'),
		...svelteFiles(join(SRC, 'lib')),
		...svelteFiles(join(SRC, 'routes'))
	];
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

function svelteFiles(dir: string): string[] {
	const out: string[] = [];
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, ent.name);
		if (ent.isDirectory()) out.push(...svelteFiles(p));
		else if (ent.name.endsWith('.svelte')) out.push(p);
	}
	return out;
}
