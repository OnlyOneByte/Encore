// guard: the design system's own rules, enforced against the components rather than the token file.
//
// THE BUG THIS EXISTS FOR. `contrast.test.ts` proves the TOKENS are sound, but it only ever reads
// app.css — so every violation written INSIDE a component was invisible to it. SongRow shipped
// `background: #14322a` while `--ok-bg` held that exact value; a `--warn-bg` that had never been
// defined silently painted a "no worker connected" banner transparent; and a `#2f2440` sat one shade
// off `--card-tint2`, which is precisely how a theme swap breaks. Ten audits and 1100 green tests did
// not catch any of it, because nothing scanned the components.
//
// WHY NOT "no colour literals at all": several are legitimate and must stay. Pure white lyric text
// over video is contrast-critical (a token would LOWER it), a QR code's cells must be true white and
// true black to scan, mask-image stops are opacity ramps rather than colours, and a colour picker
// necessarily computes in raw hue values. A blanket ban would force those into fake tokens, or force
// an allowlist that every new file silently escapes -- the maintenance model the audit criticised.
//
// So this asserts the DECIDABLE thing instead: a literal must not duplicate a value that already has
// a token. That names the real defect ("you hard-coded something the palette already owns"), permits
// genuinely token-less colour, and needs no hand-maintained list -- add a token and the guard starts
// enforcing it everywhere by itself.
import { test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appSrc, at, repoRoot } from '@encore/test-support';
import { svelteFiles, styleFiles } from '$lib/test-helpers';

const SRC = appSrc;
// Repo root, for the breakpoint scan which must reach packages/*/src as well as apps/*/src.
const REPO = repoRoot;
// Read app.css comment-stripped: the `defined`-token set and the palette are built from this text and
// compared against comment-stripped component source, so a token or colour that exists only inside a
// comment in app.css must NOT count as real (the asymmetric-stripping hole).
const css = stripComments(readFileSync(join(SRC, 'app.css'), 'utf8'));

/** Every .svelte under src, recursively. */

/**
 * Strip comments before scanning. A comment explaining WHY a literal was kept must not itself trip
 * the guard -- that would punish the documentation the rest of this codebase relies on.
 *
 * BLANK comments (replace their non-newline characters with spaces) rather than DELETE them, so the
 * byte offsets lineOf reports stay true -- a delete shifted every reported file:line after the first
 * comment. Also strip // line comments, sparing https://: without it a `// var(--x)` line was read
 * as live source, so a token that existed only inside a comment satisfied "is defined" and a
 * commented-out declaration could hide the --warn-bg transparent-banner defect this file's own header
 * names. Mirrors ui/icons.test.ts, stage-scale.test.ts, gates.test.ts, contract.test.ts.
 */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src
		.replace(/<!--[\s\S]*?-->/g, blank) // markup comments
		.replace(/\/\*[\s\S]*?\*\//g, blank) // block comments, in <script> and <style>
		.replace(/(^|[^:'"\\])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length))); // line comments, sparing https://
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

/**
 * The full guest-visible .svelte surface, computed ONCE. Every scan below iterates it; a
 * `.filter(bad).toEqual([])` / `missing.toEqual([])` scan passes vacuously if the walk returns
 * nothing, so pin a floor here. If a refactor moves files out of src/, this reds
 * loudly instead of silently guarding nothing. 25 files today; floor well below that.
 */
const FILES = svelteFiles(SRC);
test('the design-system scan actually reads the component surface', () => {
	expect(FILES.length).toBeGreaterThan(15); // @nvf-floor FILES.length
});

test('no component hard-codes a colour the palette already owns', () => {
	const known = palette();
	expect(known.size).toBeGreaterThan(10); // the parser still works if app.css is reformatted
	const offences: string[] = [];

	// Pure white and pure black are UNIVERSAL, not owned by any token. `--on-accent` happens to equal
	// #ffffff, but it means "the ink that may sit on --accent" -- so demanding it for a QR cell,
	// a letterbox bar, or contrast-critical lyric text over video would assert a relationship that is
	// not there, and would break the moment --on-accent stopped being white.
	//
	// MADE THAT LAST CLAUSE LIVE. `--on-accent` is no longer a constant: it is the current stop's
	// `on_fill`, and across the 48-stop registry that is 36 DARK / 12 white. It reads #ffffff today only
	// because the seeded stop's ink is white. So the carve-out is not a convenience -- it is what keeps
	// every unrelated white in the tree from being rewritten into a token that will stop being white.
	const UNIVERSAL = new Set(['#ffffff', '#000000']);

	// A colour inside an SVG paint attribute is markup built as a STRING (a data: URI), and a CSS
	// custom property cannot resolve in one. Nothing to convert it to.
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
	// SIBLING of the #hex scan above, for the rgb()/rgba() FORM. The hex scan is blind to functional
	// notation, which is exactly how the attract-screen fade drifted: `linear-gradient(..., rgba(3,3,8,
	// 0.9), ...)` in tv/+page.svelte duplicates `--bg` (#0b0b12 fades to a different black than its twin
	// TvLobby fade, which was converted to color-mix(var(--bg)) for this reason) while the #hex guard
	// never sees it. This scan owns the rgb()/rgba() form: a literal whose R,G,B equals a palette
	// token's is an offence regardless of its alpha (the alpha is a fade depth, the RGB is the colour
	// that must track the theme). Comment-stripped source only, same as the hex scan.
	const byRgb = new Map<string, string>();
	for (const [hex, name] of palette()) {
		const h = hex.slice(1);
		const r = parseInt(h.slice(0, 2), 16);
		const g = parseInt(h.slice(2, 4), 16);
		const b = parseInt(h.slice(4, 6), 16);
		byRgb.set(`${r},${g},${b}`, name);
	}
	expect(byRgb.size).toBeGreaterThan(10);
	// #ffffff / #000000 are universal (see the hex scan); rgb(255,255,255)/rgb(0,0,0) are not owned.
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
				`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: ${m[0]} duplicates var(--${tokenName}); use color-mix(in srgb, var(--${tokenName}) ...) so it tracks the theme`
			);
		}
	}
	expect(offences).toEqual([]);
});

test('every token a component references is actually defined', () => {
	// A typo resolves to nothing and paints transparent rather than erroring, which is how /metrics'
	// worker-down banner -- the one state that invalidates every number under it -- rendered as bare
	// text. An explicit `var(--x, fallback)` is a deliberate default and is allowed.
	const defined = new Set([...css.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]!));
	const missing: string[] = [];

	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		// Locally-scoped custom properties (set via style= or a parent rule) are legitimate; collect
		// what this file declares so they are not reported as typos.
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
 * The declarations inside a named at-rule or selector block, brace-matched rather than regexed.
 *
 * WHY BRACE-MATCHED. Every other scan in this file reads app.css as one flat string, which is correct
 * for "does this token exist anywhere". It is WRONG for the question the two tests below ask, because
 * app.css has two token blocks that mean different things -- `:root`, whose declarations the browser
 * emits as custom properties, and `@theme inline`, whose declarations only tell Tailwind which utility
 * classes to mint. A flat regex cannot tell them apart.
 *
 * `head` is matched at the start of a line so `:root` inside the @media overrides is collected too
 * (there are two, raising --max-w), while the `:root` written inside a comment cannot match -- comments
 * are blanked to spaces before this runs, and a blanked line has no `:root` left on it.
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
	// THE BUG THIS EXISTS FOR, AND IT IS ARMED RATHER THAN HISTORICAL. `@theme inline` is not a place
	// custom properties live -- it is Tailwind's configuration input, and its keys are NOT emitted into
	// the stylesheet. Verified against the built bundle: `--spacing-tap` and `--text-tv-label` have been
	// in that block since the Tailwind v4 migration and appear NOWHERE in any built asset. So `var(--spacing-tap)` in a
	// component resolves to nothing and paints nothing -- the exact failure mode of the undefined
	// `--warn-bg` that rendered /metrics' worker-down banner transparent, which is the defect the
	// sibling test above was written for.
	//
	// AND THAT SIBLING CANNOT CATCH THIS ONE. It builds `defined` with /--([a-z0-9-]+):/g over the whole
	// file, which is block-blind: a bridge key satisfies `defined.has(name)` identically to a real
	// `:root` token, so the reference short-circuits and is never reported. It asks "is this name
	// written in app.css", and the question here is "is this name EMITTED".
	//
	// makes the trap materially easier to step on, which is why the guard lands with it: the
	// bridge keys it adds are deliberate near-homophones of their `:root` sources (--spacing-sm beside
	// --space-sm, --text-ph-sm beside --ph-text-sm, --duration-fast beside --motion-fast). The spelling
	// has to differ -- a bridge entry naming itself is a self-reference that resolves to nothing -- so
	// the pairs cannot be made distinct by renaming, and a scan is the only thing that closes it.
	const bridgeOnly = new Set([...THEME_TOKENS].filter((t) => !ROOT_TOKENS.has(t)));
	// Not vacuous: the bridge exists and every key in it is by construction spelled differently from the
	// `:root` token it forwards to, so this set is the whole block. If it empties, the scan below is
	// checking nothing and this reds first.
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
				`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: var(--${name}) is declared only in @theme, which mints a utility but emits no custom property — it paints nothing. Use the :root token it forwards to.`
			);
		}
	}
	// The var() walk must have read a real population, or a regex slip would report zero offences from
	// zero readings. The tree carries hundreds of var() references.
	expect(bridgeRefsScanned).toBeGreaterThanOrEqual(200); // @nvf-floor bridgeRefsScanned
	expect(offences).toEqual([]);
});

test('every @theme bridge entry forwards to a real :root token, and never to itself', () => {
	// A bridge entry is `--spacing-sm: var(--space-sm)` — a DIFFERENT name on each side, forwarding to a
	// token `:root` really declares. Two ways that breaks, both silent, both invisible to either side
	// read alone:
	//
	//   SELF-REFERENCE — `--radius-sm: var(--radius-sm)`, the exact shape app.css's own comment warns
	//   about for the radius scale. The property resolves to itself, the utility mints, and it paints
	//   nothing. This is why the bridge keys are spelled differently from their sources at all, so it is
	//   the invariant that keeps that spelling rule honest rather than merely conventional.
	//
	//   DANGLING FORWARD — `var(--space-smm)`. `:root` has no such token, so the utility mints and paints
	//   nothing. The sibling "every token a component references is actually defined" scan reads
	//   COMPONENTS, never app.css, so nothing else in the tree looks at the right-hand side of these
	//   declarations.
	const offences: string[] = [];
	let forwardsChecked = 0;
	for (const [name, value] of THEME_DECLS) {
		for (const ref of value.matchAll(/var\(\s*--([a-z0-9-]+)\s*[,)]/g)) {
			forwardsChecked++;
			const target = ref[1]!;
			if (target === name) {
				offences.push(`--${name} forwards to itself — it resolves to nothing and paints nothing`);
			} else if (!ROOT_TOKENS.has(target)) {
				offences.push(`--${name} forwards to var(--${target}), which :root never declares`);
			}
		}
	}
	// Every bridge entry is a forward, so this counts the block. A parser slip that read no values would
	// otherwise report zero offences from zero readings.
	expect(forwardsChecked).toBeGreaterThanOrEqual(30); // @nvf-floor forwardsChecked
	expect(ROOT_TOKENS.size).toBeGreaterThanOrEqual(50);
	expect(offences).toEqual([]);
});

/*
 * ══ THE FIVE NON-COLOUR DIMENSION RULES ══════════════════════════════════════════════
 *
 * These are the colour scans' siblings, and they enforce the SAME decidable rule for the same reason:
 * a literal must not duplicate a value that already has a token. Nothing above them changed shape --
 * what changed is that five dimensions now HAVE tokens, so the rule finally has something to compare
 * against. Before app.css declared these scales, ~391 literals were not violations this file was
 * missing; they were outside anything it could express, which is why it passed correctly on all of them.
 *
 * WHAT THESE DELIBERATELY DO NOT DO, stated once for all five: they do not flag a NEAR miss. 7px beside
 * a 6px and an 8px step, or 0.78rem beside 0.75rem and 0.8rem, is drift a human can see and a
 * duplication rule cannot -- exactly as a colour with no token is not an offence to the hex scan above.
 * Flagging near misses needs a snapped scale, which changes rendered pixels and therefore needs a design
 * ruling and frames. So this closes "there was no token to compare against" and not "this value sits one
 * step off". The cost is real and is recorded at app.css's own scale block.
 *
 * WHY A VALUE MAP AND NOT A LIST OF PROPERTIES TO BAN: the map is built from app.css at run time, so
 * adding a step to a scale starts enforcing it everywhere by itself and no list here needs touching --
 * the property the colour scans were written for.
 */

/** The steps of one `:root` scale, as rendered-value -> token name. Built from app.css, never a copy. */
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
 * The declaration blocks of one component, as [selector, body] pairs.
 *
 * Shared by the four value-dimension scans below so each reports the rule it found an offence in rather
 * than a bare line number, and so a property name appearing in a SELECTOR (or in a Svelte expression
 * outside any rule) cannot be read as a declaration.
 */
function rules(src: string): Array<[string, string, number]> {
	const out: Array<[string, string, number]> = [];
	for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push([m[1]!.trim(), m[2]!, m.index!]);
	return out;
}

test('no component hard-codes a spacing value the scale already owns', () => {
	// Scope is gap / margin / padding, which is XR-PH-04's own scope ("every gap/margin/padding in a
	// phone surface resolves to a spacing step"). Positional offsets -- top/right/bottom/left/inset -- are
	// deliberately NOT in it: they place a box against its container rather than space one from another,
	// and the incumbent values there are edge offsets whose meaning is positional, not rhythmic.
	//
	// UNSIGNED ONLY. A negative offset (-10px on a slider thumb, -0.85em on a marker) is a nudge in the
	// opposite direction from anything the scale means, and no step is negative, so `-10px` must not be
	// read as a duplicate of `--space-md`. The `(?<![\w.-])` guard is what excludes it -- and also stops
	// `14px` matching inside `114px`.
	const steps = scale(/^space-/, (v) => (/^\d+px$/.test(v) ? v : null));
	expect(steps.size).toBeGreaterThanOrEqual(8);
	const PROPS = /^(gap|row-gap|column-gap|margin|margin-(top|right|bottom|left|inline|block)|padding|padding-(top|right|bottom|left|inline|block))$/;
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
	// The declaration walk must have read a real population, or a regex slip reports zero offences from
	// zero readings. The tree carries hundreds of gap/margin/padding declarations.
	expect(spacingDeclsSeen).toBeGreaterThanOrEqual(200); // @nvf-floor spacingDeclsSeen
	expect(offences).toEqual([]);
});

test('no component hard-codes a phone type size the ladder already owns', () => {
	// rem only. The TV tiers are clamp() expressions and carry no bare literal, so they cannot collide
	// with this; a px font-size on a phone surface is a separate and stricter offence already owned by
	// phone-inventory.test.ts (SC 1.4.4 -- an absolute size does not respond to the browser's text-size
	// setting), and it is left there rather than double-reported here.
	//
	// `.7rem` and `0.7rem` are the same size, so the leading zero is normalised before comparing -- a
	// duplicate must not be able to hide behind formatting, the same argument as normaliseHex above.
	const steps = scale(/^ph-text-/, (v) => (/^[\d.]+rem$/.test(v) ? String(parseFloat(v)) + 'rem' : null));
	expect(steps.size).toBeGreaterThanOrEqual(6);
	// EVERY STEP IS rem, asserted rather than assumed. phone-inventory.test.ts bans absolute font sizes on
	// phone surfaces (SC 1.4.4 — a px size ignores the browser's text-size setting) by scanning the
	// COMPONENTS, so once a component says `font-size: var(--ph-text-sm)` that scan can no longer see what
	// the size is made of. A px step added to the ladder would therefore hand every component naming it an
	// absolute size with nothing reporting it. This is the assertion that keeps that door shut.
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
				offences.push(`${f.replace(SRC, 'src')}:${lineOf(src, at)}: ${sel} { font-size: ${d[1]!.trim()} } is var(--${token})`);
			}
		}
	}
	expect(fontDeclsSeen).toBeGreaterThanOrEqual(60); // @nvf-floor fontDeclsSeen
	expect(offences).toEqual([]);
});

test('no component hard-codes a line height the scale already owns', () => {
	// Unitless only, which is the whole scale: a unitless line-height resolves against the element's own
	// font-size, so it survives being paired with any type step. A `line-height: 20px` is a different
	// thing (it pins the line box against the type) and has no token to duplicate.
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
	// Durations are compared in MILLISECONDS, so `0.12s` and `120ms` are the same value and neither can
	// hide behind the other's unit.
	//
	// A DURATION TOKEN IS NOT A REDUCED-MOTION MECHANISM. This scan says nothing about whether an
	// animation is gated -- components/motion.test.ts owns that, and XR-TV-05's rule that a reduced-motion
	// branch HALTS rather than shortens is unaffected by which token spells the duration it halts.
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
	// THIS ONE IS A TOTAL BAN, NOT A DUPLICATION RULE, and the difference is not an inconsistency.
	//
	// The other four permit a token-less literal because a genuinely un-tokened spacing or size can be
	// legitimate. Paint order has no such case: a bare integer is only meaningful RELATIVE to the other
	// integers in its stacking context, so the number alone cannot say what it sits above -- which is the
	// defect, not a side effect of it. The tree had `9` and `10` meaning the TV's status dot and tap
	// affordance in one file and the phone sheet's scrim and surface in another, and nothing in either
	// said which ladder a reader was looking at. XR-TV-10 asks for exactly this ("each value is a
	// var(--z-tv-…) reference"), and XR-PH-04 for its phone half.
	//
	// A duplication rule could not express it anyway: the two ladders SHARE values by design (--z-header
	// and --z-tv-video are both 1, and --z-sheet matched --z-tv-affordance at 10 before the sheet tiers
	// were retired with the queue sheet), so value -> token is
	// ambiguous and only the author knows which tier was meant.
	//
	// Inline `style=` is in scope too — TvPlayer picks its slot tier from an expression, and a bare
	// integer there is exactly as unreadable as one in a rule.
	const tiers = new Set([...ROOT_TOKENS].filter((t) => /^z-/.test(t)));
	expect(tiers.size).toBeGreaterThanOrEqual(10);
	const offences: string[] = [];
	let zDeclsSeen = 0;
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		// To end-of-line rather than to a quote, because one of these lives in a Svelte expression
		// (`style="z-index:{visible ? 'var(--z-tv-video-active)' : 'var(--z-tv-video)'}"`) whose value
		// legitimately contains quotes and braces. Stopping at `;` keeps a rule's other declarations out.
		for (const m of src.matchAll(/z-index\s*:\s*([^;\n]*)/g)) {
			zDeclsSeen++;
			const value = m[1]!.trim();
			if (/var\(\s*--z-/.test(value)) continue; // names a tier
			offences.push(
				`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: z-index: ${value} is a bare integer — name the tier it means (one of ${[...tiers].slice(0, 3).join(', ')}, …)`
			);
		}
	}
	// Every overlapping surface declares one, so a walk that reads none is a broken scan rather than a
	// tree with no paint order.
	expect(zDeclsSeen).toBeGreaterThanOrEqual(15); // @nvf-floor zDeclsSeen
	expect(offences).toEqual([]);
});

test('each paint-order ladder still climbs in its documented order', () => {
	// THE CLAIM THIS KEEPS ALIVE. Naming the tiers moved every ordering fact out of the components and
	// into app.css -- and the ordering IS the whole content of a z-index. Before the tiers were named, `.fs-btn`'s guard
	// asserted the literal 7 and its own name carried the reason ("above the reel and video, below the
	// overlays and the hint"); the autoplay hint's asserted 10 and the interstitial's 8 the same way. Those
	// assertions now read `var(--z-tv-card)`, which pins WHICH TIER but says nothing about where the tier
	// sits. Without this test the ladder could be reordered in app.css and every one of them would stay
	// green while the hint painted under the cards it exists to cover.
	//
	// Asserted as a strictly increasing sequence in the documented order rather than as a list of
	// numbers, so re-spacing the ladder (the gaps are incumbent values, not meaning) stays legal while
	// re-ORDERING it cannot.
	const value = (t: string) => {
		const d = ROOT_DECLS.find(([n]) => n === t);
		expect(d, `--${t} must be declared in :root`).toBeDefined();
		const n = Number(d![1]);
		expect(Number.isInteger(n), `--${t} must be an integer, got ${d![1]}`).toBe(true);
		return n;
	};
	const LADDERS: Record<string, string[]> = {
		// bottom to top. The two shared tiers (card, interstitial) are documented at app.css.
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
		phone: ['z-header', 'z-row-lifted', 'z-dock']
	};
	let rungsChecked = 0;
	for (const [name, ladder] of Object.entries(LADDERS)) {
		for (let i = 1; i < ladder.length; i++) {
			rungsChecked++;
			expect(
				value(ladder[i]!),
				`${name}: --${ladder[i]} must paint above --${ladder[i - 1]}`
			).toBeGreaterThan(value(ladder[i - 1]!));
		}
	}
	// Every tier in :root belongs to exactly one ladder, so a tier added without a place in the order
	// reds here rather than joining the scheme unordered.
	const laddered = new Set(Object.values(LADDERS).flat());
	const unplaced = [...ROOT_TOKENS].filter((t) => /^z-/.test(t) && !laddered.has(t));
	expect(unplaced).toEqual([]);
	// XR-VER-06 RECORD — this floor went 11 -> 10 when the queue sheet was deleted, and here is what left scope. The INVARIANT is
	// unchanged: every z-* tier in :root belongs to exactly one ladder and each ladder climbs in its
	// documented order. What shrank is the POPULATION: --z-sheet-scrim (9) and --z-sheet (10) were the
	// queue sheet's two tiers, and the drawer surface that was their only reader was deleted, so the
	// phone ladder went from five tiers (four rungs) to three (two rungs). Nothing is unenforced by the
	// drop: the `unplaced` assertion above still proves NO z-* token escapes a ladder, so a re-added
	// sheet tier reds there rather than slipping in un-ordered. TV's eight rungs are untouched.
	expect(rungsChecked).toBeGreaterThanOrEqual(10); // @nvf-floor rungsChecked
});

test('the phone type ladder never reaches a TV surface', () => {
	// THE HAZARD THIS CLOSES, AND THE PHONE TYPE LADDER IS WHAT OPENED IT. `tv/stage-scale.test.ts` enforces a ten-foot
	// floor by scanning the TV tree for `font-size: <number><rem|px>` and rejecting anything under 24px.
	// That scan cannot see through a token — and it currently matches ZERO declarations, because every TV
	// font-size is already a `var(--tv-*)`, a `clamp()` or an `em`.
	//
	// So the moment a phone ladder existed, `font-size: var(--ph-text-2xs)` became an idiomatic, one-token,
	// fully green way to write a 10.88px font ON A WALL — which is the exact defect that guard's header
	// describes ("the room-state labels, the song title … rendered at 12–19px — on a wall"). Only
	// `--ph-text-2xl` (1.5rem = 24px) clears the floor at all. Tokenisation made the defect cheaper to
	// write and invisible to the thing watching for it, which is a coverage regression rather than a
	// neutral refactor, so the ban ships with the ladder that created it.
	//
	// A BAN ON THE SURFACE, NOT A THRESHOLD ON THE VALUE. Comparing resolved px would pass `--ph-text-2xl`
	// and re-red every time a step is retuned; but a phone size on the stage is wrong at ANY value,
	// because the stage's sizes are viewing-distance functions (`clamp(px, vh, px)`) and the phone's are
	// not. The scale to use there exists and is `--tv-*`.
	//
	// LINE HEIGHT IS DELIBERATELY NOT BANNED: `--lh-*` is unitless and carries no distance, so it is
	// surface-neutral by construction and the TV uses it in four places. That asymmetry is the whole
	// reason the leading scale is not `--ph-`-prefixed.
	const TV = FILES.filter((f) => /\/(lib|routes)\/tv\//.test(f));
	// The TV tree exists and was walked. Without this the ban is a scan over an empty list.
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
	// THE SIXTH NON-COLOUR DIMENSION (the tokenisation pass named it, this scan lands it). The defect this closes: the seven
	// `@media` width queries in source branch at four widths (380/520/768/1200), the reviewer checklist
	// names three others (390/820/1440), and NOTHING compared either list against a declaration — so a
	// new `@media (min-width: 900px)` could ship at a width no token knows about and no reviewer checks.
	//
	// MEMBERSHIP, NOT EQUALITY — the owner's Q1-C ruling. The reviewer widths are eyeballing
	// widths; these are switch widths. The two are DIFFERENT lists on purpose, so this asserts only
	// that every `@media` width literal is a MEMBER of the declared `--bp-*` set. It does NOT touch
	// `docs/loop/REVIEW-PASSES.md` and does NOT assert the two lists are equal.
	//
	// The set is read from app.css's `:root` at run time (never a copy here), so adding a `--bp-*`
	// step starts permitting that width by itself — the same self-updating property the colour and
	// spacing scans have. `max-height` queries are out of scope (the one at +page.svelte is a landscape
	// guard, not a responsive width); comments are stripped so a width mentioned in prose cannot count.
	const BP = new Map<number, string>();
	for (const [name, value] of ROOT_DECLS) {
		const m = /^bp-/.test(name) && /^(\d+)px$/.exec(value.trim());
		if (m) BP.set(Number(m[1]), name);
	}
	// Non-vacuous on the DECLARATION side: if the `--bp-*` block is renamed or emptied this set goes
	// empty and every literal below becomes a false offence, so pin it here rather than let the scan
	// pass by having nothing to compare against.
	expect(BP.size).toBeGreaterThanOrEqual(4);
	// 320px (WCAG 2.2 SC 1.4.10 Reflow) is a declared member even though no rule branches at it — the
	// "320 is a member, or one line says why not" half of XR-VER-21's acceptance.
	expect(BP.has(320)).toBe(true);

	// Collect `@media (min-width|max-width: Npx)` literals across apps/*/src AND packages/*/src, per the
	// acceptance's scope. styleFiles walks .svelte + .css (the widths live in component <style> blocks
	// AND in app.css), and *.test.* files are excluded — the 5000px in motion.test.ts and the 380px in
	// song-row-sparkle-sibling.test.ts are guard prose about queries, not queries.
	const roots = [join(REPO, 'apps')].filter((d) => existsSync(d));
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
							`add --bp-${w} to app.css :root, or move this query onto an existing --bp-* width. Declared: ${[...BP.keys()].sort((a, b) => a - b).join('/')}px`
					);
				}
			}
		}
	}
	// NON-VACUITY FLOOR (registered in non-vacuity-floors.test.ts). The scan derives its own
	// scope by walking, so an empty walk (a moved src/ dir, a renamed extension) would find zero
	// literals and pass while examining nothing — the exact vacuity that dimension's floors guard. Seven
	// width queries exist today; the floor sits at 7 so a walk that stops seeing `@media` reds instead.
	expect(literalsFound).toBeGreaterThanOrEqual(7); // @nvf-floor literalsFound
	expect(offences).toEqual([]);
});

test('the colour picker has exactly one name per shared preset colour', () => {
	// THE BUG THIS BOUNDS. The picker names its swatches BY POSITION: PRESET_NAMES[i] is the announced
	// name of SINGER_COLORS[i], and that is the only thing tying a screen-reader label to a hex. The
	// existing e2e contract compares PRESET_NAMES against its own copy of the names, so a RENAME is
	// caught -- but nothing noticed if the two arrays stopped being the same LENGTH, which is how a
	// preset ends up announced as `undefined`, or a name ends up describing no colour at all.
	//
	// What this cannot decide: whether the ORDER still corresponds. Nothing in a hex says "violet", so
	// reordering both arrays consistently is indistinguishable from reordering one. (The trailing
	// comments in colors.ts are not a contract either -- index 4 reads `// sky` while the picker
	// announces `blue`.) Length parity plus the contract's name check bound the blast radius to a
	// same-length reorder, which a human reading either file can still see.
	const picker = readFileSync(join(SRC, 'lib/components/ColourPicker.svelte'), 'utf8');
	const shared = readFileSync(at('apps/core/src/shared/presentation/colors.ts'), 'utf8');

	const names = /PRESET_NAMES\s*=\s*\[([^\]]*)\]/.exec(picker)?.[1];
	expect(names).toBeDefined();
	const nameCount = names!.split(',').filter((s) => s.trim()).length;

	const colours = /SINGER_COLORS\s*=\s*\[([^\]]*)\]/.exec(shared)?.[1];
	expect(colours).toBeDefined();
	const colourCount = [...colours!.matchAll(/#[0-9a-fA-F]{3,8}/g)].length;

	expect(nameCount).toBe(colourCount);
});

test('the colour picker wires its swatch tabindex to presetTabStopIndex', () => {
	// THE BUG THIS BOUNDS (pr-bot BLOCKED verdict on the first cut). The tab-stop DECISION was
	// extracted to the pure, unit-tested presetTabStopIndex in $shared so a guard could exercise
	// production logic instead of a reconstructed predicate -- but that closed only the *reconstruction*
	// hazard. It left the *reversion* hazard open: the one line that actually READS the function is a
	// Svelte template expression, and reverting it to the pre-fix `tabindex={value === c ? 0 : -1}`
	// (issue #88's exact bug -- after any wheel pick no swatch is tabbable and the presets fall out of
	// the tab order for good) leaves every gate green, because the three presetTabStopIndex unit tests
	// never touch the caller. This pins the call site itself, mirroring the sibling roving group's guard
	// at settings-scopes.test.ts (`tabindex={tab === t.id ? 0 : -1}`), so the wiring cannot silently
	// regress while the helper stays correct.
	const picker = readFileSync(join(SRC, 'lib/components/ColourPicker.svelte'), 'utf8');
	expect(picker).toContain('tabindex={i === presetTabStopIndex(value) ? 0 : -1}');
});

test('the colour picker anchors arrow movement on nextSwatchIndex, not a bare indexOf', () => {
	// THE BUG THIS BOUNDS. The tab stop reads presetTabStopIndex (falls back to swatch 0 for a
	// wheel value), but the arrow-key handler used to compute its base from a bare
	// `(SINGER_COLORS as ...).indexOf(value)`, which is -1 for any wheel hex. After a hue pick the two
	// disagreed: focus sat on swatch 0 while movement started from -1, so the first ArrowRight did not
	// move and ArrowLeft skipped mint. nextSwatchIndex in $shared shares presetTabStopIndex's
	// anchor and is unit-tested there -- but that closes only the helper; the handler is a Svelte
	// script line the helper tests never exercise. This pins the call site so it cannot revert to the
	// bare-indexOf base while the helper stays correct, mirroring the tab-stop wiring guard above.
	const picker = stripComments(readFileSync(join(SRC, 'lib/components/ColourPicker.svelte'), 'utf8'));
	// It must IMPORT the shared helper (reverting the import alone leaves a call to an unimported
	// symbol — a build break bun test does not see, so the import must be pinned here too)...
	expect(picker).toMatch(/import \{[^}]*\bnextSwatchIndex\b[^}]*\} from '\$shared';/);
	// ...and the arrow handler must derive `next` from that helper...
	expect(picker).toMatch(/const next = nextSwatchIndex\(value, step\);/);
	// ...and must NOT reintroduce the divergent bare-indexOf arrow base (the original defect). Comments are
	// stripped first, so the rationale prose above cannot satisfy or trip this.
	expect(picker).not.toMatch(/indexOf\(value\)/);
});

test('no component leaks a stray comment terminator into the page', () => {
	// THE BUG THIS EXISTS FOR. A rebase auto-merge left a bare `-->` in the phone route with no `<!--`
	// opening it. Svelte treats an unmatched terminator as ordinary TEXT, so it rendered "-->" on
	// screen between the key controls and the rotation -- and nothing caught it: svelte-check reports
	// 0 errors, every unit test passed, and the e2e drove straight past it because no selector cares.
	// Only looking at the running app found it, which is exactly the class of defect a cheap source
	// scan should own instead.
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
	// THE BUG: iOS Safari zooms the page in when a focused input computes under 16px, and does not
	// zoom back out. The settings page shipped `select, .text { font-size: 0.9rem }` (14.4px) and a
	// 0.86rem LAN-address field, so tapping either left the whole surface zoomed and off-centre.
	//
	// THE VALUE IS RESOLVED THROUGH A TOKEN, NOT ONLY READ AS A LITERAL. Before the type ladder
	// existed every control stated its size as a literal and a regex over the declaration was the whole
	// job. Tokenising them made this scan BLIND rather than red: `.searchbox input` became
	// `font-size: var(--ph-text-base)`, the literal match failed, `continue` fired, and the control
	// dropped out of the population silently — a vacuous pass on the one rule here that protects a
	// WCAG-adjacent behaviour. So a var() is followed to its `:root` declaration and judged on that,
	// which also means a future ladder step retuned below 16px reds every control that names it.
	const offences: string[] = [];
	const CONTROL = /(^|[\s,>])(input|select|textarea)\b/;
	let controlSizesResolved = 0;

	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const m of src.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
			const [sel, body] = [m[1]!, m[2]!];
			if (!CONTROL.test(sel)) continue;
			// A range slider has no text, so the zoom rule cannot apply to it.
			if (/type=['"]?range/.test(sel)) continue;
			const decl = body.match(/font-size:\s*([^;]+)/);
			if (!decl) continue;
			// Follow one hop through a token. One hop is enough and is asserted: the ladder's steps are
			// plain lengths, not references to further tokens.
			let value = decl[1]!.trim();
			const ref = value.match(/^var\(\s*(--[a-z0-9-]+)\s*\)$/);
			if (ref) {
				const target = ROOT_DECLS.find(([n]) => '--' + n === ref[1]);
				if (!target) continue; // not a :root token — the @theme-only scan above owns that defect
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

	// At least one control takes its size through the ladder, so the resolution path above is exercised
	// rather than merely present. If every control went back to a literal this reds and the branch can be
	// retired deliberately.
	expect(controlSizesResolved).toBeGreaterThanOrEqual(1);
	expect(offences).toEqual([]);
});

test('the phone shell keeps its dynamic viewport and its safe-area insets', () => {
	// Both are load-bearing on the devices this PWA actually targets and neither is expressible as a
	// component test: `100vh` on iOS resolves to the LARGE viewport, so a full-height shell runs under
	// the browser chrome, and without the insets content sits under the notch and the home indicator.
	// They were correct but unguarded, so a tidy-up could have silently removed either.
	expect(css).toContain('100dvh');
	expect(css).toMatch(/env\(safe-area-inset-/);
});

test('the bottom-docked band clears the home indicator', () => {
	// THE BUG: a band that is `position: fixed; bottom: 0` sits in the ~34px iOS reserves for the home
	// indicator unless it carries the inset itself. The original defect was on the queue sheet's peek,
	// whose inset landed on the sheet's separate scroll body instead — so in the collapsed state the
	// transport controls and the "when am I up?" line rendered under the indicator. That surface was
	// deleted with the sheet and the invariant moved WITH the band contract to the phone home's docked bands.
	//
	// The band is also what --dock-h measures (bound to that element's clientHeight, which includes
	// padding), and every other docked control offsets from --dock-h with no env() of its own. So the
	// inset belonging to the band is a contract, not a detail: move it and the toasts silently stop
	// clearing the indicator too. Today there is ONE band — the search dock, docked on home for a
	// joined singer and present in both views (the `.cta-dock` primary button it replaced is gone); it
	// is a list so the next docked band must comply.
	const page = readFileSync(join(SRC, 'routes/+page.svelte'), 'utf8');
	let banded = 0;
	for (const cls of ['search-dock']) {
		const rule = page.match(new RegExp(`\\.${cls}\\s*\\{[^}]*\\}`, 's'));
		expect(rule, `.${cls} must still be a rule in routes/+page.svelte`).not.toBeNull();
		expect(rule![0], `.${cls} must carry env(safe-area-inset-bottom) itself`).toMatch(/env\(safe-area-inset-bottom/);
		banded++;
	}
	// Non-vacuous: if a rename makes the selector unmatchable the loop above already reds, and this
	// floor stops the list being quietly emptied to nothing.
	expect(banded).toBe(1);
});

test('both documentElement custom-property writes (--undo-h, --dock-h) tear down on unmount (§14/§17)', () => {
	// THE BUG THIS EXISTS FOR (sec.14). A component wrote `--peek-h` onto documentElement in an
	// $effect but returned no cleanup, so the inline property OUTLIVED the component on the root element
	// and kept beating a `@media` rule after it unmounted. A documentElement custom-property write is
	// app-global mutable state; leaving it set is a leak. Source scan because bun:test has no DOM to
	// mount-and-unmount; comments stripped so the rationale prose cannot satisfy or trip it. Reverting
	// any $effect teardown below reds this.
	//
	// SCOPE: the original --peek-h site was the queue sheet, deleted with the drawer surface, so
	// this guard now covers the two writers that remain — routes/+page.svelte's --undo-h (the SAME leak
	// shape: a setProperty $effect with no cleanup, skewing the --error-dock stack after the route
	// unmounts, fixed + pinned in the leak sweep's tail §17) and its --dock-h (the docked band's measured
	// height, the same leak shape on a third site). The leak CLASS is documented in full at --dock-h's
	// declaration in routes/+page.svelte. Each site must both WRITE its property and RETURN a cleanup
	// that removeProperty's it; reverting either teardown reds this.
	/*
	 * S5 RETIRED the `--undo-h` site (XR-VER-07). It was a real instance of this leak class — a
	 * setProperty $effect publishing the undo toast's measured height, skewing the --error-dock stack
	 * after the route unmounted — and it no longer exists: the toasts are sonner's, sonner stacks its
	 * own, and there is no second surface to offset. The property, its measurement and its teardown were
	 * all deleted rather than ported, so a guard for its teardown can no longer fail.
	 *
	 * `--dock-h` is untouched and is still the site this guard protects. The leak CLASS is
	 * documented in full at its declaration in routes/+page.svelte.
	 */
	const sites: Array<{ file: string; prop: string }> = [{ file: 'routes/+page.svelte', prop: '--dock-h' }];
	/*
	 * Non-vacuity floor: an emptied list would pass this test silently.
	 *
	 * It read `>= 2` under the comment "Two live writers today". S5 deleted one of them — `--undo-h`
	 * and the whole measured-height chain it fed went with the hand-rolled toasts — so the floor is
	 * lowered to the ONE writer that remains, on the record, in the same change that removed the other.
	 * That is the required shape: a floor is never nudged to make a suite pass, and a writer whose
	 * premise a slice ends is retired with its reason (XR-VER-07).
	 */
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
});
test('the phone header truncates a long display name instead of growing the row', () => {
	// THE BUG: the header is a nowrap flex row and the ONE child whose width is user-supplied --
	// the display name -- rendered raw with no truncation. A single unbroken token has a min-content
	// width equal to its full rendered width, so with CSS automatic minimum sizing flex-shrink cannot
	// take it below that: the row grows the document instead, and the settings gear -- the only entry
	// point to /settings from the home screen -- is carried off the viewport. Measured live: 23 chars
	// already overflowed at 390px; a 31-char name pushed the gear fully off screen.
	//
	// The fix is the same treatment QueueRow's `.who` carries: min-width:0 up the whole chain so the
	// item can shrink, plus overflow:hidden/text-overflow:ellipsis/white-space:nowrap on the name. And
	// text-overflow only fires on a BLOCK box, not on an anonymous flex item -- so the name must be a
	// styled block span. This guard is a source scan (no layout engine in bun:test), but each clause
	// below is exactly what a reverted fix drops, so it fails red on the pre-fix source.
	const page = stripComments(readFileSync(join(SRC, 'routes/+page.svelte'), 'utf8'));

	// The name is a styled block span (not a bare <span>), so text-overflow can act on it.
	expect(page).toMatch(/<span class="me-name">\{me\.displayName\}<\/span>/);

	const meName = page.match(/\.me-name\s*\{([^}]*)\}/);
	expect(meName).not.toBeNull();
	const nameBody = meName![1]!;
	expect(nameBody).toMatch(/display:\s*block/); // text-overflow needs a block box
	expect(nameBody).toMatch(/min-width:\s*0/); // so it can shrink below content width
	expect(nameBody).toMatch(/overflow:\s*hidden/);
	expect(nameBody).toMatch(/text-overflow:\s*ellipsis/);
	expect(nameBody).toMatch(/white-space:\s*nowrap/);

	// min-width:0 must exist all the way up the flex chain or the name never gets the chance to shrink.
	const cluster = page.match(/\.me-cluster\s*\{([^}]*)\}/);
	expect(cluster).not.toBeNull();
	expect(cluster![1]!).toMatch(/min-width:\s*0/);
	const btn = page.match(/\.me-btn\s*\{([^}]*)\}/);
	expect(btn).not.toBeNull();
	expect(btn![1]!).toMatch(/min-width:\s*0/);

	// The dot and the gear must stay unshrinkable so the tap target and the colour dot survive.
	const dot = page.match(/\.me-dot\s*\{([^}]*)\}/);
	expect(dot![1]!).toMatch(/flex:\s*0 0 auto/);
	const gear = page.match(/\.gear\s*\{([^}]*)\}/);
	// var(--tap), not the number: touch-targets.test.ts owns the spelling rule and this pin must
	// not be the one place a bare literal still satisfies a guard.
	expect(gear![1]!).toMatch(/min-width:\s*var\(--tap\)/);
});

test('every identity-dot rule declares a non-shrinking flex basis', () => {
	// THE BUG THIS EXISTS FOR. The singer identity dot (`.who i`) lives inside `.who`, a
	// flex container that QueueRow deliberately makes overflowable (nowrap + overflow:hidden so a long
	// name plus an away/adding badge can't wrap and change the row's height). A dot is an empty element,
	// whose automatic minimum size is 0, so as a shrinkable flex item it collapsed to 0px under a
	// 32-char name (32 is exactly the profile-name maxlength) — the singer's colour vanished from their
	// OWN row, the one place the truncated name is least able to disambiguate them. colors.ts:12-14
	// states that dot is "the only thing telling two singers apart besides the name", so this is a
	// functional loss, not cosmetic. The fix is the same `flex: 0 0 auto` that `.seq`/`.actions` carry;
	// this guard pins it for every identity-dot rule so a future edit can't drop it. ProcessingCard's
	// `.who i` is byte-identical by design, so it must satisfy the same rule.
	const offences: string[] = [];
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const m of src.matchAll(/\.who\s+i\s*\{([^}]*)\}/g)) {
			const body = m[1]!;
			const flexShorthand = body.match(/(^|[;{\s])flex:\s*0\s+0\b/);
			const flexShrink0 = body.match(/flex-shrink:\s*0\b/);
			if (!flexShorthand && !flexShrink0) {
				offences.push(
					`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: .who i must declare flex:0 0 <basis> (or flex-shrink:0) so the identity dot cannot collapse to 0px`
				);
			}
		}
	}
	// The rule must actually match something, or a selector rename would silently disarm it.
	// QueueRow + ProcessingCard both carry a .who i rule.
	let seen = 0;
	for (const f of FILES) {
		seen += [...stripComments(readFileSync(f, 'utf8')).matchAll(/\.who\s+i\s*\{/g)].length;
	}
	expect(seen).toBeGreaterThanOrEqual(2); // @nvf-floor seen
	expect(offences).toEqual([]);
});

test('a route page block that caps its width also centres it under the app-shell', () => {
	// THE BUG THIS EXISTS FOR. The layout mounts each route's page block as a direct child
	// of `.app-shell` (routes/+layout.svelte:12), which is a `display:flex; flex-direction:column;
	// margin:0 auto` centred column. A flex item that sets a `max-width` but no inline auto margin is
	// laid out at the cross-axis START, so the cap takes width off the RIGHT only and the block hangs to
	// the LEFT of a shell whose whole job is to centre. /stats sat 187px left of centre at 1440px with a
	// 360px void beside it; /metrics and /metrics/[mediaId] the same. The repo had already decided this
	// twice — settings `main` and join `.join-main` both cap AND `margin:0 auto` — so this pins the rule
	// for every route root: cap your width if you like, but re-centre it. `width:100%` matters alongside
	// the margin because on a flex item a bare auto inline margin removes the stretch and collapses the
	// block to content width; the guard requires the auto margin (the placement fix) and the presence of
	// the cap is what arms it.
	const ROUTES = join(SRC, 'routes');
	const offences: string[] = [];
	let checked = 0;
	for (const f of svelteFiles(ROUTES)) {
		if (!f.endsWith('+page.svelte')) continue;
		const raw = readFileSync(f, 'utf8');
		// The route's page block is the first top-level element in the template that carries a class —
		// it becomes the direct .app-shell child. Look only at markup BEFORE the <style> block.
		const styleAt = raw.indexOf('<style');
		const markup = styleAt === -1 ? raw : raw.slice(0, styleAt);
		const rootClassMatch = markup.match(/<(?:section|main|div|article)\b[^>]*\sclass="([a-z][a-z0-9-]*)/i);
		if (!rootClassMatch) continue; // a route with no single classed root block (e.g. plain <slot>) is out of scope
		const rootClass = rootClassMatch[1]!;
		const css = stripComments(raw);
		// The rule for that class, at any nesting; take the FIRST base declaration block for the selector.
		const rule = css.match(new RegExp(`\\.${rootClass}\\s*\\{([^}]*)\\}`));
		if (!rule) continue;
		const body = rule[1]!;
		const capsWidth = /(^|[;{\s])max-width:\s*\d/.test(body);
		if (!capsWidth) continue; // no cap -> nothing to re-centre; this page fills the shell
		checked++;
		const autoMargin =
			/margin(-inline)?:\s*[^;]*\bauto\b/.test(body) ||
			/margin-inline-(start|end):\s*auto/.test(body) ||
			/margin-(left|right):\s*auto/.test(body);
		if (!autoMargin) {
			offences.push(
				`${f.replace(SRC, 'src')}: .${rootClass} caps its width (max-width) but sets no inline auto margin, so it hangs left of the centred .app-shell — add margin-inline:auto (with width:100% to keep the stretch)`
			);
		}
	}
	// The rule must actually be exercising something, or a refactor of the routes would silently disarm it.
	// The three dashboards plus the two precedents (settings, join) all cap-and-centre.
	expect(checked).toBeGreaterThanOrEqual(3); // @nvf-floor checked
	expect(offences).toEqual([]);
});
