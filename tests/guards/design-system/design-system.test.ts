// guard: the design system's rules, enforced against the components rather than the token file.
//
// Caught: SongRow shipping `background: #14322a` while `--ok-bg` held that exact value, an undefined
// `--warn-bg` painting the /metrics "no worker connected" banner transparent, and a `#2f2440` one shade off
// `--card-tint2`. The decidable rule is "a literal must not duplicate a value that already has a token",
// not "no literals": white lyric text over video is contrast-critical, a QR cell must be true black and
// white, and a colour picker computes in raw hue values.
// See docs/GUARDS.md#colour-tokens-and-the-48-stop-palette.
import { test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { at, repoRoot, srcDir } from '@encore/test-support';
import { svelteFiles, styleFiles } from '@encore/test-support/scan';

const SRC = srcDir;
// Repo root, for the breakpoint scan which must reach beyond src/.
const REPO = repoRoot;
// app.css read comment-stripped, symmetrically with the component reads below: a token or colour that
// exists only inside a comment must not count as defined (the asymmetric-stripping hole).
const css = stripComments(readFileSync(join(SRC, 'app.css'), 'utf8'));

/**
 * Strip comments, BLANKING rather than deleting so `lineOf` offsets stay true. `//` is stripped too, sparing
 * `https://` — without it a commented-out declaration satisfied "is defined" and could hide the `--warn-bg`
 * transparent-banner defect this file exists for.
 */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src
		.replace(/<!--[\s\S]*?-->/g, blank)
		.replace(/\/\*[\s\S]*?\*\//g, blank)
		.replace(/(^|[^:'"\\])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)));
}

function lineOf(src: string, index: number): number {
	return src.slice(0, index).split('\n').length;
}

/** #abc and #AABBCC normalise to the same key so a shade match cannot hide behind formatting. */
function normaliseHex(hex: string): string {
	let h = hex.replace('#', '').toLowerCase();
	if (h.length === 3)
		h = h
			.split('')
			.map((c) => c + c)
			.join('');
	return `#${h}`;
}

/** The palette as value -> token name, built from app.css so it can never go stale. */
function palette(): Map<string, string> {
	const m = new Map<string, string>();
	for (const t of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
		m.set(normaliseHex(t[2]!), t[1]!);
	}
	return m;
}

/** The guest-visible .svelte surface, computed once. Every scan below iterates it. */
const FILES = svelteFiles(SRC);
test('the design-system scan actually reads the component surface', () => {
	expect(FILES.length).toBeGreaterThan(15); // @nvf-floor FILES.length
});

test('no component hard-codes a colour the palette already owns', () => {
	const known = palette();
	expect(known.size).toBeGreaterThan(10); // the parser survives a reformat of app.css
	const offences: string[] = [];

	// Pure white and black are UNIVERSAL, owned by no token: `--on-accent` is the current stop's `on_fill`
	// (36 dark / 12 white) and reads #ffffff only because the seeded stop's ink is white, so demanding it
	// for a QR cell asserts a relationship that is not there.
	const UNIVERSAL = new Set(['#ffffff', '#000000']);

	// A colour in an SVG paint attribute is markup built as a data: URI string, where a custom property cannot resolve.
	const SVG_PAINT = /(fill|stroke|stop-color)=["']$/;

	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const m of src.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
			const hex = normaliseHex(m[0]);
			if (UNIVERSAL.has(hex)) continue;
			if (SVG_PAINT.test(src.slice(Math.max(0, m.index! - 14), m.index!))) continue;
			const tokenName = known.get(hex);
			if (!tokenName) continue;
			offences.push(`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: ${m[0]} is var(--${tokenName})`);
		}
	}

	expect(offences).toEqual([]);
});

test('no component hard-codes an rgb()/rgba() colour the palette already owns', () => {
	// The hex scan is blind to functional notation, which is how the attract-screen fade drifted: `rgba(3,3,8,0.9)`
	// duplicates `--bg` while fading to a different black than its converted twin. The alpha is a fade depth; the RGB is
	// the colour that must track the theme, so a match is an offence regardless of alpha.
	const byRgb = new Map<string, string>();
	for (const [hex, name] of palette()) {
		const h = hex.slice(1);
		const r = parseInt(h.slice(0, 2), 16);
		const g = parseInt(h.slice(2, 4), 16);
		const b = parseInt(h.slice(4, 6), 16);
		byRgb.set(`${r},${g},${b}`, name);
	}
	expect(byRgb.size).toBeGreaterThan(10);
	const UNIVERSAL_RGB = new Set(['255,255,255', '0,0,0']);
	const offences: string[] = [];
	const RGB_RE = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,[^)]*)?\)/g;
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const m of src.matchAll(RGB_RE)) {
			const key = `${Number(m[1])},${Number(m[2])},${Number(m[3])}`;
			if (UNIVERSAL_RGB.has(key)) continue;
			const tokenName = byRgb.get(key);
			if (!tokenName) continue;
			offences.push(
				`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: ${m[0]} duplicates var(--${tokenName}); use color-mix(in srgb, var(--${tokenName})...) so it tracks the theme`
			);
		}
	}
	expect(offences).toEqual([]);
});

test('every token a component references is actually defined', () => {
	// A typo resolves to nothing and paints TRANSPARENT rather than erroring, which is how /metrics' worker-down
	// banner rendered as bare text. An explicit `var(--x, fallback)` is a deliberate default.
	const defined = new Set([...css.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]!));
	const missing: string[] = [];

	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		// Locally-scoped properties (set via style= or a parent rule) are legitimate.
		const local = new Set([...src.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
		for (const m of src.matchAll(/var\(\s*--([a-z0-9-]+)\s*\)/g)) {
			const name = m[1]!;
			if (defined.has(name) || local.has(name)) continue;
			missing.push(`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: var(--${name}) is never defined`);
		}
	}

	expect(missing).toEqual([]);
});

/**
 * The declarations inside a named at-rule or selector block, brace-matched because app.css has two token
 * blocks that mean different things — `:root`, whose declarations the browser emits as custom properties,
 * and `@theme inline`, whose keys only mint utility classes — and a flat regex cannot tell them apart.
 * `head` is line-anchored so the `:root` blocks inside @media overrides are collected.
 */
function blockDecls(head: RegExp, src: string): Array<[string, string]> {
	const decls: Array<[string, string]> = [];
	for (const m of src.matchAll(head)) {
		const open = src.indexOf('{', m.index!);
		if (open === -1) continue;
		let depth = 0;
		let end = -1;
		for (let i = open; i < src.length; i++) {
			if (src[i] === '{') depth++;
			else if (src[i] === '}') {
				depth--;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}
		if (end === -1) continue;
		for (const d of src.slice(open + 1, end).matchAll(/--([a-z0-9-]+)\s*:\s*([^;]*);/g)) {
			decls.push([d[1]!, d[2]!.trim()]);
		}
	}
	return decls;
}

const ROOT_DECLS = blockDecls(/^:root\b/gm, css);
const THEME_DECLS = blockDecls(/^@theme\b/gm, css);
const ROOT_TOKENS = new Set(ROOT_DECLS.map(([n]) => n));
const THEME_TOKENS = new Set(THEME_DECLS.map(([n]) => n));

test('a component never references a token that exists only in the @theme bridge', () => {
	// `@theme inline` is Tailwind's configuration input: its keys are NOT emitted, so `var(--spacing-tap)`
	// in a component paints nothing. The sibling "is actually defined" scan is block-blind — a bridge key
	// satisfies it identically to a real `:root` token — because it asks "is this name WRITTEN in app.css"
	// while this asks "is it EMITTED". See docs/GUARDS.md#tailwind-v4-toolchain.
	const bridgeOnly = new Set([...THEME_TOKENS].filter((t) => !ROOT_TOKENS.has(t)));
	// Every bridge key is spelled differently from the token it forwards to, so this set is the whole block;
	// if it empties, the scan below is checking nothing.
	expect(bridgeOnly.size).toBeGreaterThanOrEqual(10);

	const offences: string[] = [];
	let bridgeRefsScanned = 0;
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		const local = new Set([...src.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
		for (const m of src.matchAll(/var\(\s*--([a-z0-9-]+)\s*[,)]/g)) {
			bridgeRefsScanned++;
			const name = m[1]!;
			if (local.has(name)) continue; // the file declares it itself, so it resolves
			if (!bridgeOnly.has(name)) continue;
			offences.push(
				`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: var(--${name}) is declared only in @theme, which mints a utility but emits no custom property — it paints nothing. Use the:root token it forwards to.`
			);
		}
	}
	// Or a regex slip reports zero offences from zero readings.
	expect(bridgeRefsScanned).toBeGreaterThanOrEqual(200); // @nvf-floor bridgeRefsScanned
	expect(offences).toEqual([]);
});

test('every @theme bridge entry forwards to a real:root token, and never to itself', () => {
	// A bridge entry is `--spacing-sm: var(--space-sm)` — a DIFFERENT name each side. Two silent breaks: SELF-REFERENCE
	// resolves to itself and paints nothing, which is why the spellings differ at all, and a DANGLING FORWARD mints a
	// utility that paints nothing. The component-side scan never reads the right-hand side of these declarations.
	const offences: string[] = [];
	let forwardsChecked = 0;
	for (const [name, value] of THEME_DECLS) {
		for (const ref of value.matchAll(/var\(\s*--([a-z0-9-]+)\s*[,)]/g)) {
			forwardsChecked++;
			const target = ref[1]!;
			if (target === name) {
				offences.push(`--${name} forwards to itself — it resolves to nothing and paints nothing`);
			} else if (!ROOT_TOKENS.has(target)) {
				offences.push(`--${name} forwards to var(--${target}), which:root never declares`);
			}
		}
	}
	// Every bridge entry is a forward, so this counts the block.
	expect(forwardsChecked).toBeGreaterThanOrEqual(30); // @nvf-floor forwardsChecked
	expect(ROOT_TOKENS.size).toBeGreaterThanOrEqual(50);
	expect(offences).toEqual([]);
});

/*
 * The five non-colour dimension scans below enforce the colour scans' rule — a literal must not duplicate a
 * value that already has a token — now that five dimensions have tokens. None flags a NEAR miss (7px beside
 * a 6px and an 8px step): that needs a snapped scale, which changes rendered pixels. The value map is built
 * from app.css at run time, so adding a step starts enforcing it.
 */

/** The steps of one `:root` scale, as rendered-value -> token name, built from app.css. */
function scale(prefix: RegExp, normalise: (v: string) => string | null): Map<string, string> {
	const m = new Map<string, string>();
	for (const [name, value] of ROOT_DECLS) {
		if (!prefix.test(name)) continue;
		const key = normalise(value);
		if (key === null) continue;
		if (!m.has(key)) m.set(key, name);
	}
	return m;
}

/**
 * The declaration blocks of one component, as [selector, body, offset]. Shared by the scans below so each
 * reports the rule it found an offence in, and so a property name in a SELECTOR (or in a Svelte expression
 * outside any rule) cannot be read as a declaration.
 */
function rules(src: string): Array<[string, string, number]> {
	const out: Array<[string, string, number]> = [];
	for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push([m[1]!.trim(), m[2]!, m.index!]);
	return out;
}

test('no component hard-codes a spacing value the scale already owns', () => {
	// gap/margin/padding only: a positional offset places a box against its container rather than spacing one
	// from another. UNSIGNED ONLY, since a negative nudge means the opposite of any step and no step is
	// negative — `(?<![\w.-])` excludes it, and also stops `14px` matching inside `114px`.
	const steps = scale(/^space-/, (v) => (/^\d+px$/.test(v) ? v : null));
	expect(steps.size).toBeGreaterThanOrEqual(8);
	const PROPS =
		/^(gap|row-gap|column-gap|margin|margin-(top|right|bottom|left|inline|block)|padding|padding-(top|right|bottom|left|inline|block))$/;
	const offences: string[] = [];
	let spacingDeclsSeen = 0;
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const [sel, body, at] of rules(src)) {
			for (const d of body.matchAll(/([a-z-]+)\s*:\s*([^;]+)/g)) {
				if (!PROPS.test(d[1]!)) continue;
				spacingDeclsSeen++;
				for (const n of d[2]!.matchAll(/(?<![\w.-])(\d+px)\b/g)) {
					const token = steps.get(n[1]!);
					if (!token) continue;
					offences.push(
						`${f.replace(SRC, 'src')}:${lineOf(src, at)}: ${sel} { ${d[1]}: … ${n[1]} … } is var(--${token})`
					);
				}
			}
		}
	}
	expect(spacingDeclsSeen).toBeGreaterThanOrEqual(200); // @nvf-floor spacingDeclsSeen
	expect(offences).toEqual([]);
});

test('no component hard-codes a phone type size the ladder already owns', () => {
	// rem only: the TV tiers are clamp() expressions with no bare literal, and a px font-size on a phone
	// surface is the stricter SC 1.4.4 offence owned elsewhere. `.7rem` normalises to `0.7rem` first, so a
	// duplicate cannot hide behind formatting.
	const steps = scale(/^ph-text-/, (v) => (/^[\d.]+rem$/.test(v) ? String(parseFloat(v)) + 'rem' : null));
	expect(steps.size).toBeGreaterThanOrEqual(6);
	// EVERY STEP IS rem, asserted rather than assumed: the SC 1.4.4 ban scans COMPONENTS, so once one says
	// `var(--ph-text-sm)` it cannot see what the size is made of and a px step would hand every namer an
	// absolute size unreported.
	const ladder = ROOT_DECLS.filter(([n]) => /^ph-text-/.test(n));
	expect(ladder.length).toBeGreaterThanOrEqual(6);
	expect(ladder.filter(([, v]) => !/^[\d.]+rem$/.test(v.trim()))).toEqual([]);
	const offences: string[] = [];
	let fontDeclsSeen = 0;
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const [sel, body, at] of rules(src)) {
			for (const d of body.matchAll(/(?<![\w-])font-size\s*:\s*([^;]+)/g)) {
				fontDeclsSeen++;
				const lit = d[1]!.trim().match(/^([\d.]+)rem$/);
				if (!lit) continue;
				const token = steps.get(String(parseFloat(lit[1]!)) + 'rem');
				if (!token) continue;
				offences.push(
					`${f.replace(SRC, 'src')}:${lineOf(src, at)}: ${sel} { font-size: ${d[1]!.trim()} } is var(--${token})`
				);
			}
		}
	}
	expect(fontDeclsSeen).toBeGreaterThanOrEqual(60); // @nvf-floor fontDeclsSeen
	expect(offences).toEqual([]);
});

test('no component hard-codes a line height the scale already owns', () => {
	// Unitless only, which is the whole scale: it resolves against the element's own font-size and survives
	// any type step, while a `line-height: 20px` pins the line box instead and has no token.
	const steps = scale(/^lh-/, (v) => (/^[\d.]+$/.test(v) ? String(parseFloat(v)) : null));
	expect(steps.size).toBeGreaterThanOrEqual(4);
	const offences: string[] = [];
	let leadingDeclsSeen = 0;
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const [sel, body, at] of rules(src)) {
			for (const d of body.matchAll(/(?<![\w-])line-height\s*:\s*([^;]+)/g)) {
				leadingDeclsSeen++;
				const lit = d[1]!.trim();
				if (!/^[\d.]+$/.test(lit)) continue;
				const token = steps.get(String(parseFloat(lit)));
				if (!token) continue;
				offences.push(`${f.replace(SRC, 'src')}:${lineOf(src, at)}: ${sel} { line-height: ${lit} } is var(--${token})`);
			}
		}
	}
	expect(leadingDeclsSeen).toBeGreaterThanOrEqual(8); // @nvf-floor leadingDeclsSeen
	expect(offences).toEqual([]);
});

test('no component hard-codes a motion duration the scale already owns', () => {
	// Compared in MILLISECONDS, so `0.12s` and `120ms` are one value. A duration token says nothing about
	// reduced motion — motion/motion.test.ts owns that.
	const ms = (v: string) => {
		const m = v.match(/^([\d.]+)(ms|s)$/);
		return m ? String(m[2] === 's' ? parseFloat(m[1]!) * 1000 : parseFloat(m[1]!)) : null;
	};
	const steps = scale(/^motion-/, ms);
	expect(steps.size).toBeGreaterThanOrEqual(3);
	const offences: string[] = [];
	let motionDeclsSeen = 0;
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const [sel, body, at] of rules(src)) {
			for (const d of body.matchAll(/(?<![\w-])(transition|animation)(-duration)?\s*:\s*([^;]+)/g)) {
				motionDeclsSeen++;
				for (const n of d[3]!.matchAll(/(?<![\w.-])([\d.]+m?s)\b/g)) {
					const token = steps.get(ms(n[1]!)!);
					if (!token) continue;
					offences.push(
						`${f.replace(SRC, 'src')}:${lineOf(src, at)}: ${sel} { ${d[1]}: … ${n[1]} … } is var(--${token})`
					);
				}
			}
		}
	}
	expect(motionDeclsSeen).toBeGreaterThanOrEqual(10); // @nvf-floor motionDeclsSeen
	expect(offences).toEqual([]);
});

test('every z-index in a component names a paint-order tier, never a bare integer', () => {
	// A TOTAL BAN, not a duplication rule: a bare integer is only meaningful RELATIVE to the others in its
	// stacking context, so the number alone cannot say what it sits above — `9` and `10` once meant the TV
	// status dot and tap affordance in one file and a sheet's scrim and surface in another. A duplication
	// rule could not express it either, since the two ladders SHARE values by design. Inline `style=` is in
	// scope: TvPlayer picks its slot tier from an expression.
	const tiers = new Set([...ROOT_TOKENS].filter((t) => /^z-/.test(t)));
	expect(tiers.size).toBeGreaterThanOrEqual(10);
	const offences: string[] = [];
	let zDeclsSeen = 0;
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		// To end-of-line rather than to a quote, because one lives in a Svelte expression whose value contains
		// quotes and braces; stopping at `;` keeps sibling declarations out.
		for (const m of src.matchAll(/z-index\s*:\s*([^;\n]*)/g)) {
			zDeclsSeen++;
			const value = m[1]!.trim();
			if (/var\(\s*--z-/.test(value)) continue; // names a tier
			offences.push(
				`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: z-index: ${value} is a bare integer — name the tier it means (one of ${[...tiers].slice(0, 3).join(', ')}, …)`
			);
		}
	}
	expect(zDeclsSeen).toBeGreaterThanOrEqual(15); // @nvf-floor zDeclsSeen
	expect(offences).toEqual([]);
});

test('each paint-order ladder still climbs in its documented order', () => {
	// Naming the tiers moved every ordering fact into app.css, and the ordering IS the whole content of a
	// z-index: a guard asserting `var(--z-tv-card)` pins WHICH tier but not where the tier sits, so the
	// ladder could be reordered and the autoplay hint would paint under the cards it exists to cover.
	// Asserted as a strictly increasing sequence, so RE-SPACING stays legal while RE-ORDERING cannot.
	const value = (t: string) => {
		const d = ROOT_DECLS.find(([n]) => n === t);
		expect(d, `--${t} must be declared in:root`).toBeDefined();
		const n = Number(d![1]);
		expect(Number.isInteger(n), `--${t} must be an integer, got ${d![1]}`).toBe(true);
		return n;
	};
	const LADDERS: Record<string, string[]> = {
		// bottom to top; the two shared tiers are documented at app.css
		'TV stage': [
			'z-tv-bg',
			'z-tv-video',
			'z-tv-video-active',
			'z-tv-screen',
			'z-tv-reel',
			'z-tv-card',
			'z-tv-interstitial',
			'z-tv-status',
			'z-tv-affordance'
		],
		phone: ['z-header', 'z-band-control', 'z-row-lifted', 'z-dock']
	};
	let rungsChecked = 0;
	for (const [name, ladder] of Object.entries(LADDERS)) {
		for (let i = 1; i < ladder.length; i++) {
			rungsChecked++;
			expect(value(ladder[i]!), `${name}: --${ladder[i]} must paint above --${ladder[i - 1]}`).toBeGreaterThan(
				value(ladder[i - 1]!)
			);
		}
	}
	// Every tier belongs to exactly one ladder, so one added without a place in the order reds here rather
	// than joining the scheme unordered.
	const laddered = new Set(Object.values(LADDERS).flat());
	const unplaced = [...ROOT_TOKENS].filter((t) => /^z-/.test(t) && !laddered.has(t));
	expect(unplaced).toEqual([]);
	expect(rungsChecked).toBeGreaterThanOrEqual(10); // @nvf-floor rungsChecked
});

test('the phone type ladder never reaches a TV surface', () => {
	// A ban on the SURFACE, not a threshold on the value: the ten-foot floor scans for literal font sizes
	// and cannot see through a token, so `font-size: var(--ph-text-2xs)` is an idiomatic, fully green way to
	// write a 10.88px font on a wall. A phone size on the stage is wrong at ANY value, because the stage's
	// sizes are viewing-distance functions and the phone's are not. `--lh-*` is unitless and carries no
	// distance, so it is surface-neutral and deliberately not banned. See docs/GUARDS.md#ten-foot-stage-scale.
	const TV = FILES.filter((f) => /\/(lib|routes)\/tv\//.test(f));
	expect(TV.length).toBeGreaterThanOrEqual(5); // @nvf-floor TV.length
	const offences: string[] = [];
	for (const f of TV) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const m of src.matchAll(/var\(\s*(--ph-[a-z0-9-]+)\s*[,)]/g)) {
			offences.push(
				`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: ${m[1]} is a PHONE size on a TV surface — the stage reads from three metres and has its own ladder (--tv-*), and the ten-foot floor in tv/stage-scale.test.ts cannot see through a token`
			);
		}
	}
	expect(offences).toEqual([]);
});

test('every @media width literal in source is a declared breakpoint', () => {
	// MEMBERSHIP, NOT EQUALITY: a review pass's eyeballing widths and these switch widths are different lists on purpose,
	// so this asserts only that every literal is a MEMBER of the declared `--bp-*` set, read from app.css at run time.
	// `max-height` queries are out of scope — the one in source is a landscape guard, not a responsive width.
	const BP = new Map<number, string>();
	for (const [name, value] of ROOT_DECLS) {
		const m = /^bp-/.test(name) && /^(\d+)px$/.exec(value.trim());
		if (m) BP.set(Number(m[1]), name);
	}
	// Non-vacuous on the DECLARATION side: an emptied `--bp-*` block makes every literal below a false
	// offence rather than letting the scan pass with nothing to compare against.
	expect(BP.size).toBeGreaterThanOrEqual(4);
	// 320px (WCAG 2.2 SC 1.4.10 Reflow) is a declared member even though no rule branches at it.
	expect(BP.has(320)).toBe(true);

	// styleFiles walks .svelte + .css, since the widths live in component <style> blocks AND app.css;
	// *.test.* files are excluded, because a width in guard prose is not a query.
	const roots = [join(REPO, 'src')].filter((d) => existsSync(d));
	const WIDTH_RE = /@media[^{]*?\b(?:min|max)-width\s*:\s*(\d+)px/g;
	const offences: string[] = [];
	let literalsFound = 0;
	for (const root of roots) {
		for (const f of styleFiles(root)) {
			if (/\.test\./.test(f)) continue;
			const src = stripComments(readFileSync(f, 'utf8'));
			for (const m of src.matchAll(WIDTH_RE)) {
				literalsFound++;
				const w = Number(m[1]);
				if (!BP.has(w)) {
					offences.push(
						`${f.replace(REPO + '/', '')}:${lineOf(src, m.index!)}: @media width ${w}px is not a declared breakpoint — ` +
							`add --bp-${w} to app.css:root, or move this query onto an existing --bp-* width. Declared: ${[...BP.keys()].sort((a, b) => a - b).join('/')}px`
					);
				}
			}
		}
	}
	// The scan derives its own scope by walking, so an empty walk finds zero literals and passes.
	expect(literalsFound).toBeGreaterThanOrEqual(7); // @nvf-floor literalsFound
	expect(offences).toEqual([]);
});

test('the colour picker has exactly one name per shared preset colour', () => {
	// The picker names its swatches BY POSITION — PRESET_NAMES[i] announces SINGER_COLORS[i] — and that index
	// is the only thing tying a screen-reader label to a hex. A rename is caught by the e2e contract; nothing
	// noticed the two arrays ceasing to be the same LENGTH, which announces a preset as `undefined`. Order
	// correspondence is undecidable here, since nothing in a hex says "violet".
	const picker = readFileSync(join(SRC, 'lib/components/ColourPicker.svelte'), 'utf8');
	const shared = readFileSync(at('src/lib/contract/presentation/colors.ts'), 'utf8');

	const names = /PRESET_NAMES\s*=\s*\[([^\]]*)\]/.exec(picker)?.[1];
	expect(names).toBeDefined();
	const nameCount = names!.split(',').filter((s) => s.trim()).length;

	const colours = /SINGER_COLORS\s*=\s*\[([^\]]*)\]/.exec(shared)?.[1];
	expect(colours).toBeDefined();
	const colourCount = [...colours!.matchAll(/#[0-9a-fA-F]{3,8}/g)].length;

	expect(nameCount).toBe(colourCount);
});

test('the colour picker wires its swatch tabindex to presetTabStopIndex', () => {
	// The tab-stop decision lives in the unit-tested `presetTabStopIndex`, but the one line that READS it is
	// a template expression: reverting to `tabindex={value === c ? 0 : -1}` leaves every gate green and drops
	// all eight presets out of the tab order after any wheel pick.
	const picker = readFileSync(join(SRC, 'lib/components/ColourPicker.svelte'), 'utf8');
	expect(picker).toContain('tabindex={i === presetTabStopIndex(value) ? 0 : -1}');
});

test('the colour picker anchors arrow movement on nextSwatchIndex, not a bare indexOf', () => {
	// A bare `SINGER_COLORS.indexOf(value)` is -1 for any wheel hex, so after a hue pick focus sat on swatch 0 while
	// movement started from -1: the first ArrowRight did not move and ArrowLeft skipped mint. `nextSwatchIndex` shares
	// the tab stop's anchor; this pins the call site, which the helper's own unit tests never exercise.
	const picker = stripComments(readFileSync(join(SRC, 'lib/components/ColourPicker.svelte'), 'utf8'));
	// The import is pinned too: reverting it alone leaves a call to an unimported symbol, which is a build
	// break bun test does not see.
	expect(picker).toMatch(/import \{[^}]*\bnextSwatchIndex\b[^}]*\} from '\$lib\/contract';/);
	expect(picker).toMatch(/const next = nextSwatchIndex\(value, step\);/);
	expect(picker).not.toMatch(/indexOf\(value\)/);
});

test('no component leaks a stray comment terminator into the page', () => {
	// A rebase left a bare `-->` with no `<!--` opening it. Svelte treats an unmatched terminator as ordinary
	// TEXT, so it rendered on screen while svelte-check reported 0 errors and the e2e drove past it.
	const offences: string[] = [];

	for (const f of FILES) {
		const src = readFileSync(f, 'utf8');
		let depth = 0;
		let line = 1;
		for (let i = 0; i < src.length;) {
			if (src.startsWith('<!--', i)) {
				depth++;
				i += 4;
				continue;
			}
			if (src.startsWith('-->', i)) {
				if (depth === 0) offences.push(`${f.replace(SRC, 'src')}:${line}: stray --> renders as text`);
				else depth--;
				i += 3;
				continue;
			}
			if (src[i] === '\n') line++;
			i++;
		}
		if (depth > 0) offences.push(`${f.replace(SRC, 'src')}: ${depth} unclosed <!-- comment(s)`);
	}

	expect(offences).toEqual([]);
});

test('form controls never sit below the 16px iOS zoom threshold', () => {
	// iOS Safari zooms the page in when a focused input computes under 16px, and does not zoom back out.
	// Settings shipped `select,.text { font-size: 0.9rem }` (14.4px) and a 0.86rem LAN field.
	//
	// A var() is FOLLOWED to its `:root` declaration, because tokenising the controls made a literal-only
	// scan blind rather than red — a vacuous pass on the one WCAG-adjacent rule here. It also means a ladder
	// step retuned below 16px reds every control that names it.
	const offences: string[] = [];
	const CONTROL = /(^|[\s,>])(input|select|textarea)\b/;
	let controlSizesResolved = 0;

	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const m of src.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
			const [sel, body] = [m[1]!, m[2]!];
			if (!CONTROL.test(sel)) continue;
			// A range slider has no text, so the zoom rule cannot apply.
			if (/type=['"]?range/.test(sel)) continue;
			const decl = body.match(/font-size:\s*([^;]+)/);
			if (!decl) continue;
			// One hop is enough, and asserted below: the ladder's steps are plain lengths.
			let value = decl[1]!.trim();
			const ref = value.match(/^var\(\s*(--[a-z0-9-]+)\s*\)$/);
			if (ref) {
				const target = ROOT_DECLS.find(([n]) => '--' + n === ref[1]);
				if (!target) continue; // not a:root token — the @theme-only scan above owns that defect
				value = target[1]!.trim();
				controlSizesResolved++;
			}
			const fs = value.match(/^([0-9.]+)(rem|px|em)$/);
			if (!fs) continue;
			const [n, unit] = [Number(fs[1]), fs[2]];
			const px = unit === 'px' ? n : n * 16;
			if (px < 16) {
				offences.push(
					`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: ${sel.trim()} is ${decl[1]!.trim()} (${px}px)`
				);
			}
		}
	}

	// At least one control takes its size through the ladder, exercising the resolution path.
	expect(controlSizesResolved).toBeGreaterThanOrEqual(1);
	expect(offences).toEqual([]);
});

test('the phone shell keeps its dynamic viewport and its safe-area insets', () => {
	// `100vh` on iOS resolves to the LARGE viewport, so a full-height shell runs under the browser chrome;
	// without the insets content sits under the notch and the home indicator. Neither is expressible as a
	// component test, so a tidy-up could silently remove either.
	expect(css).toContain('100dvh');
	expect(css).toMatch(/env\(safe-area-inset-/);
});

test('the bottom-docked band clears the home indicator', () => {
	// A `position: fixed; bottom: 0` band sits in the ~34px iOS reserves for the home indicator unless it
	// carries the inset itself. Two halves, because `--dock-h` is bound to the band slot's clientHeight and
	// every other docked control offsets from it with no env() of its own: the BAND carries
	// env(safe-area-inset-bottom) in its own component, and that inset stays INSIDE the element `--dock-h`
	// measures. See docs/GUARDS.md#vendored-component-seams.
	let banded = 0;
	for (const { file, cls } of [{ file: 'lib/components/NowPlayingBand.svelte', cls: 'band' }]) {
		const src = readFileSync(join(SRC, file), 'utf8');
		const rule = src.match(new RegExp(`\\.${cls}\\s*\\{[^}]*\\}`, 's'));
		expect(rule, `.${cls} must still be a rule in ${file}`).not.toBeNull();
		expect(rule![0], `.${cls} must carry env(safe-area-inset-bottom) itself`).toMatch(/env\(safe-area-inset-bottom/);
		banded++;
	}
	// A rename reds above; this stops the list being quietly emptied.
	expect(banded).toBe(1);

	// Comment-stripped: drawer-content.svelte's own prose contains the word `fixed`, and deleting `fixed`
	// from its class list left this arm GREEN against that comment. The vendored copy-in is what fixes the
	// sheet to the bottom edge, and neither utility is obviously load-bearing on sight.
	const content = stripComments(readFileSync(join(SRC, 'lib/components/ui/drawer/drawer-content.svelte'), 'utf8'));
	expect(content, 'the vendored drawer content must still be what fixes the sheet to the viewport').toMatch(
		/\bfixed\b/
	);
	expect(content, 'a bottom-direction drawer must still be pinned to the bottom edge').toMatch(
		/data-\[vaul-drawer-direction=bottom\]:bottom-0/
	);

	// The drawer reaches into the band with a `:global(.band)` rule to suppress its surface paint. If that
	// grows a `padding-bottom`, the inset leaves the measurement and every offset control silently stops
	// clearing the home indicator while the band itself still looks correct.
	const drawer = stripComments(readFileSync(join(SRC, 'lib/components/NowPlayingDrawer.svelte'), 'utf8'));
	expect(drawer, '--dock-h must still be measured off the.band-slot that holds the band').toMatch(
		/class="band-slot"[^>]*bind:clientHeight=\{bandH\}/
	);
	const suppress = drawer.match(/\.band-slot\s+:global\(\.band\)\s*\{([^}]*)\}/);
	expect(suppress, 'the drawer must still suppress the band surface paint via:global(.band)').not.toBeNull();
	expect(
		suppress![1]!,
		'the:global(.band) suppression must not reach the band padding — env(safe-area-inset-bottom) lives there and --dock-h measures it'
	).not.toMatch(/padding/);
});

test('every documentElement custom-property write (--dock-h) tears down on unmount (§14/§17)', () => {
	// An inline custom property on documentElement is app-global mutable state and outranks every stylesheet rule, so a
	// write with no `$effect` cleanup OUTLIVES its component and keeps beating a `@media` rule. Source scan because
	// bun:test has no DOM to mount and unmount. `--dock-h` is written by the ROOT layout, which wraps the television too
	// — and /tv mounts no band, so a stale value pads the stage by a phone band's height.
	const sites: Array<{ file: string; prop: string }> = [{ file: 'routes/+layout.svelte', prop: '--dock-h' }];
	expect(sites.length).toBeGreaterThanOrEqual(1);
	for (const { file, prop } of sites) {
		const src = stripComments(readFileSync(join(SRC, file), 'utf8'));
		const setRe = new RegExp(`documentElement\\.style\\.setProperty\\(\\s*['"]${prop}['"]`);
		const removeRe = new RegExp(`removeProperty\\(\\s*['"]${prop}['"]\\s*\\)`);
		expect(src.match(setRe), `${file} must still be the writer of ${prop}`).not.toBeNull();
		expect(src, `the ${prop} $effect in ${file} must return a cleanup that removeProperty(${prop}) on unmount`).toMatch(
			removeRe
		);
	}
	// ONE WRITER PER PROPERTY, swept rather than assumed: a second writer does not merge with the first, one
	// silently loses, and which one depends on effect order.
	for (const { file, prop } of sites) {
		const writers = FILES.filter((f) =>
			new RegExp(`documentElement\\.style\\.setProperty\\(\\s*['"]${prop}['"]`).test(
				stripComments(readFileSync(f, 'utf8'))
			)
		).map((f) => f.replace(SRC + '/', ''));
		expect(writers, `${prop} must have exactly one writer`).toEqual([file]);
	}
});
test('the phone header truncates a long display name instead of growing the row', () => {
	// The header is a nowrap flex row whose one user-supplied child is the display name. A single unbroken
	// token has a min-content width equal to its full rendered width, so under CSS automatic minimum sizing
	// flex-shrink cannot take it below that: the row grows the document and carries the settings gear off
	// the viewport. Measured: 23 chars overflowed at 390px, 31 pushed the gear off.
	//
	// The fix is `min-width: 0` up the whole flex chain plus overflow/text-overflow/white-space on the name
	// — and text-overflow only fires on a BLOCK box, never an anonymous flex item, so the name must be a
	// styled block span. Each clause below is exactly what a reverted fix drops.
	const page = stripComments(readFileSync(join(SRC, 'routes/+page.svelte'), 'utf8'));

	expect(page).toMatch(/<span class="me-name">\{me\.displayName\}<\/span>/);

	const meName = page.match(/\.me-name\s*\{([^}]*)\}/);
	expect(meName).not.toBeNull();
	const nameBody = meName![1]!;
	expect(nameBody).toMatch(/display:\s*block/); // text-overflow needs a block box
	expect(nameBody).toMatch(/min-width:\s*0/); // so it can shrink below content width
	expect(nameBody).toMatch(/overflow:\s*hidden/);
	expect(nameBody).toMatch(/text-overflow:\s*ellipsis/);
	expect(nameBody).toMatch(/white-space:\s*nowrap/);

	const cluster = page.match(/\.me-cluster\s*\{([^}]*)\}/);
	expect(cluster).not.toBeNull();
	expect(cluster![1]!).toMatch(/min-width:\s*0/);
	// The chain spans two files: the button element by the component, the flex item by the page.
	const slot = page.match(/\.me-slot\s*\{([^}]*)\}/);
	expect(slot).not.toBeNull();
	expect(slot![1]!).toMatch(/min-width:\s*0/);
	// The variant must BOTH free its own minimum and undo the base's `shrink-0`: a non-shrinking button
	// cannot narrow, so text-overflow never fires.
	const button = stripComments(readFileSync(join(SRC, 'lib/components/ui/button/button.svelte'), 'utf8'));
	const identity = button.match(/identity:\s*\n?\s*'([^']*)'/)?.[1] ?? '';
	expect(identity).toMatch(/\bmin-w-0\b/);
	expect(identity).toMatch(/\bshrink\b/);

	// The dot and the gear stay unshrinkable, so the tap target and the colour dot survive.
	const dot = page.match(/\.me-dot\s*\{([^}]*)\}/);
	expect(dot![1]!).toMatch(/flex:\s*0 0 auto/);
	// `size="icon"` IS the tap box: `size-tap` resolves through the `--spacing-tap` bridge to `var(--tap)`,
	// so the token is named rather than a literal, and touch-targets.test.ts owns the spelling.
	expect(page).toMatch(/<Button[^>]*size="icon"[^>]*href="\/settings"/s);
	const iconSize = button.match(/icon:\s*'([^']*)'/)?.[1] ?? '';
	expect(iconSize).toMatch(/size-tap/);
});

test('every identity-dot rule declares a non-shrinking flex basis', () => {
	// The singer identity dot lives inside `.who`, a deliberately overflowable flex container (nowrap +
	// overflow:hidden so a long name plus a badge cannot change the row's height). A dot is an empty element,
	// so its automatic minimum size is 0 and as a shrinkable flex item it collapsed to 0px under a 32-char
	// name — exactly the profile-name maxlength — losing the singer's colour from their OWN row, where a
	// truncated name least disambiguates them. `flex: 0 0 auto` is the fix.
	//
	// It is ONE shared `.singer-dot` rule in app.css now (it was four byte-identical copies), so the scan
	// reads app.css AND sweeps components in case a local copy is reintroduced.
	const offences: string[] = [];
	const dotRules: { where: string; body: string }[] = [];
	for (const m of css.matchAll(/\.singer-dot\s*\{([^}]*)\}/g)) {
		dotRules.push({ where: `src/app.css:${lineOf(css, m.index!)}.singer-dot`, body: m[1]! });
	}
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const re of [/\.who\s+i\s*\{([^}]*)\}/g, /\.singer-dot\s*\{([^}]*)\}/g]) {
			for (const m of src.matchAll(re)) {
				dotRules.push({ where: `${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}`, body: m[1]! });
			}
		}
	}
	for (const { where, body } of dotRules) {
		const flexShorthand = body.match(/(^|[;{\s])flex:\s*0\s+0\b/);
		const flexShrink0 = body.match(/flex-shrink:\s*0\b/);
		if (!flexShorthand && !flexShrink0) {
			offences.push(
				`${where}: an identity-dot rule must declare flex:0 0 <basis> (or flex-shrink:0) so the dot cannot collapse to 0px`
			);
		}
	}
	// The rule must match something, or a selector rename silently disarms the scan.
	expect(dotRules.length).toBeGreaterThanOrEqual(1); // @nvf-floor dotRules.length
	expect(offences).toEqual([]);
});

test('a route page block that caps its width also centres it under the app-shell', () => {
	// `.app-shell` is a `display:flex; flex-direction:column; margin:0 auto` centred column, and the layout mounts each
	// route's page block as a direct child. A flex item that sets `max-width` with no inline auto margin is laid out at
	// the cross-axis START, so the cap takes width off the RIGHT only and the block hangs LEFT: /stats sat 187px left of
	// centre at 1440px with a 360px void beside it. `width:100%` matters alongside the margin, because a bare auto inline
	// margin removes the stretch. See docs/GUARDS.md#phone-inventories-and-reflow.
	const ROUTES = join(SRC, 'routes');
	const offences: string[] = [];
	let checked = 0;
	for (const f of svelteFiles(ROUTES)) {
		if (!f.endsWith('+page.svelte')) continue;
		const raw = readFileSync(f, 'utf8');
		// The page block is the first top-level classed element, so look only at markup BEFORE <style>.
		const styleAt = raw.indexOf('<style');
		const markup = styleAt === -1 ? raw : raw.slice(0, styleAt);
		const rootClassMatch = markup.match(/<(?:section|main|div|article)\b[^>]*\sclass="([a-z][a-z0-9-]*)/i);
		if (!rootClassMatch) continue; // no single classed root block -> out of scope
		const rootClass = rootClassMatch[1]!;
		const css = stripComments(raw);
		const rule = css.match(new RegExp(`\\.${rootClass}\\s*\\{([^}]*)\\}`));
		if (!rule) continue;
		const body = rule[1]!;
		// A cap is a NUMBER OR A TOKEN: matching only `\d` stopped seeing every dashboard the moment the
		// hand-picked measures collapsed into `var(--measure-grid)`, and the `checked` floor caught that
		// disarm. `none` still must not count — it RELEASES a cap, so there is nothing to re-centre.
		const capsWidth = /(^|[;{\s])max-width:\s*(\d|var\()/.test(body);
		if (!capsWidth) continue; // no cap -> nothing to re-centre; this page fills the shell
		checked++;
		const autoMargin =
			/margin(-inline)?:\s*[^;]*\bauto\b/.test(body) ||
			/margin-inline-(start|end):\s*auto/.test(body) ||
			/margin-(left|right):\s*auto/.test(body);
		if (!autoMargin) {
			offences.push(
				`${f.replace(SRC, 'src')}:.${rootClass} caps its width (max-width) but sets no inline auto margin, so it hangs left of the centred.app-shell — add margin-inline:auto (with width:100% to keep the stretch)`
			);
		}
	}
	// Or a refactor of the routes silently disarms the rule.
	expect(checked).toBeGreaterThanOrEqual(3); // @nvf-floor checked
	expect(offences).toEqual([]);
});
