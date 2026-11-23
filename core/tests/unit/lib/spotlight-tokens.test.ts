import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { at } from '$test';
import { contrastRatio, parseHex } from '$lib/contract/presentation/colors';
import { PALETTE_STOPS } from '$lib/contract/presentation/player-palette';

// The Spotlight tokens (redesign step 2): roles hold WCAG AA in both themes, and every rung has a caller.
const appCss = readFileSync(at('src/app.css'), 'utf8');
const tokens = readFileSync(at('src/tokens.css'), 'utf8');

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');

/** `--name: value;` pairs of one block. */
function decls(block: string): Map<string, string> {
	return new Map([...strip(block).matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}
const rootBlock = (css: string) => /:root\s*\{([\s\S]*?)\n\}/.exec(css)![1]!;
const dark = new Map([...decls(rootBlock(appCss)), ...decls(rootBlock(tokens))]);
const light = new Map([...dark, ...decls(/\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/.exec(tokens)![1]!)]);

/** Follow `var(--x)` to a hex, the way the cascade does for a custom property declared on one element. */
function hex(theme: Map<string, string>, name: string): string {
	let v = theme.get(name);
	for (let i = 0; v && i < 8; i++) {
		const ref = /^var\((--[a-z0-9-]+)\)$/.exec(v);
		if (!ref) break;
		v = theme.get(ref[1]!);
	}
	if (!v || !parseHex(v)) throw new Error(`${name} does not resolve to a hex (${v})`);
	return v;
}

/** `ink` at `alpha` over `bg`, composited in sRGB as the browser paints opacity. */
function over(ink: string, bg: string, alpha: number): string {
	const [a, b] = [parseHex(ink)!, parseHex(bg)!];
	return (
		'#' +
		a
			.map((c, i) =>
				Math.round(c * alpha + b[i]! * (1 - alpha))
					.toString(16)
					.padStart(2, '0')
			)
			.join('')
	);
}

const TEXT = 4.5;
const NON_TEXT = 3;
const PAIRS: [string, string, number][] = [
	['--role-ink', '--role-ground', TEXT],
	['--role-ink', '--role-raise', TEXT],
	['--role-ink-dim', '--role-ground', TEXT],
	['--role-ink-dim', '--role-raise', TEXT],
	['--role-accent-ink', '--role-ground', TEXT],
	['--role-accent-ink', '--role-raise', TEXT],
	['--role-on-accent', '--role-accent', TEXT],
	['--role-danger', '--role-ground', TEXT],
	['--role-danger', '--role-danger-surface', TEXT],
	['--role-ink', '--role-danger-surface', TEXT],
	['--on-spot', '--spot', TEXT],
	['--role-control', '--role-ground', NON_TEXT],
	['--role-control', '--role-raise', NON_TEXT],
	['--role-focus', '--role-ground', NON_TEXT],
	['--role-focus', '--role-raise', NON_TEXT],
	['--role-ok', '--role-ground', NON_TEXT],
	['--role-warn', '--role-ground', NON_TEXT]
];

test('every colour role clears WCAG AA against the surfaces it sits on, dark and light', () => {
	for (const [name, theme] of [
		['dark', dark],
		['light', light]
	] as const) {
		const fails = PAIRS.map(([ink, bg, min]) => [ink, bg, contrastRatio(hex(theme, ink), hex(theme, bg)), min] as const)
			.filter(([, , r, min]) => r < min)
			.map(([ink, bg, r]) => `${name} ${ink} on ${bg}: ${r.toFixed(2)}`);
		expect(fails).toEqual([]);
	}
});

test('dark roles alias the names today’s screens spell, so adopting a role moves no pixel', () => {
	expect(dark.get('--role-ground')).toBe('var(--bg)');
	expect(dark.get('--role-ink')).toBe('var(--ink)');
	expect(dark.get('--role-accent')).toBe('var(--accent)');
	expect(hex(dark, '--spot')).toBe(hex(dark, '--accent'));
	// Light is opt-in: nothing in src sets data-theme but the dev story.
	const setters = readdirSync(at('src'), { recursive: true, encoding: 'utf8' })
		.filter((p) => /\.(svelte|ts)$/.test(p))
		.filter((p) => readFileSync(at(`src/${p}`), 'utf8').includes('data-theme'));
	expect(setters).toEqual(['routes/components/spotlight/+page.svelte']);
});

test('a lit Spotlight is readable in every singer colour, its dimmed meta line included', () => {
	// The card inks itself in the stop's certified on_fill; `.meta span` dims it to 80% opacity.
	const fails = PALETTE_STOPS.flatMap((s) => {
		const full = contrastRatio(s.on_fill, s.fill);
		const dim = contrastRatio(over(s.on_fill, s.fill, 0.8), s.fill);
		return full < TEXT || dim < TEXT ? [`${s.name}: ${full.toFixed(2)} / ${dim.toFixed(2)}`] : [];
	});
	expect(fails).toEqual([]);
	expect(readFileSync(at('src/lib/ui/Spotlight.svelte'), 'utf8')).toMatch(/\.meta span \{\s*opacity: 0\.8;/);
});

test('every type and step rung is read by a rule outside tokens.css, and none is spelled undeclared', () => {
	const declared = [...decls(rootBlock(tokens)).keys()].filter((n) => /^--(type|step)-/.test(n));
	const reads = new Set<string>();
	for (const p of readdirSync(at('src'), { recursive: true, encoding: 'utf8' })) {
		if (!/\.(css|svelte|ts)$/.test(p) || p === 'tokens.css') continue;
		for (const m of strip(readFileSync(at(`src/${p}`), 'utf8')).matchAll(/var\((--(?:type|step)-[a-z0-9]+)\)/g))
			reads.add(m[1]!);
	}
	expect(declared.filter((n) => !reads.has(n))).toEqual([]);
	expect([...reads].filter((n) => !declared.includes(n))).toEqual([]);
});

test('the queue’s motion is tokens now, at the values it had as literals', () => {
	expect(dark.get('--motion-pop')).toBe('0.22s');
	expect(dark.get('--motion-slide')).toBe('160ms');
	expect(dark.get('--motion-roll')).toBe('180ms');
	expect(dark.get('--ease-pop')).toBe('cubic-bezier(0.2, 0.9, 0.3, 1.3)');
	expect(dark.get('--ease-slide')).toBe('cubic-bezier(0.32, 0.72, 0, 1)');
	const literal = /(animation|transition):[^;]*\b(0\.22s|160ms|180ms)/;
	const left = readdirSync(at('src'), { recursive: true, encoding: 'utf8' })
		.filter((p) => /\.(css|svelte)$/.test(p))
		.filter((p) => literal.test(strip(readFileSync(at(`src/${p}`), 'utf8'))));
	expect(left).toEqual([]);
});

test('app.css imports the tokens', () => {
	expect(appCss).toContain("@import './tokens.css';");
});
