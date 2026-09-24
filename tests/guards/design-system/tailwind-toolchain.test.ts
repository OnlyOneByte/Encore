/*
 * guard: the four Tailwind install decisions are still in force — no PLAYER HUE in `@theme`, Preflight out,
 * utilities minted from one directory, and the copy-in target in guard scope. Every one fails by producing
 * a quietly different app rather than an error. Arms 1-3 read app.css as TEXT with comments stripped, so
 * its own notes about `--color-accent` and `preflight.css` neither satisfy nor trip an arm.
 * See docs/GUARDS.md#tailwind-v4-toolchain.
 */
import { expect, it } from 'bun:test';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, srcDir } from '@encore/test-support';
import { svelteFiles, styleFiles, SKIP_DIRS } from '@encore/test-support/scan';

const SRC = srcDir;
const REPO = repoRoot;
const APP_CSS_PATH = join(SRC, 'app.css');
const APP_CSS = readFileSync(APP_CSS_PATH, 'utf8');

/**
 * Blank CSS block-comment interiors, preserving length and newlines. STRING-AWARE, and not as defensive
 * programming: the `@source` glob's recursive-directory wildcard followed by an extension wildcard spells a
 * literal, legal, EMPTY CSS COMMENT, so a quote-blind stripper blanks the middle of the glob.
 */
function stripCssComments(src: string): string {
	let out = '';
	let quote: string | null = null;
	for (let i = 0; i < src.length; i++) {
		const c = src[i]!;
		if (quote) {
			out += c;
			if (c === '\\') {
				// an escape consumes the next character, so a \" cannot close the string
				if (i + 1 < src.length) out += src[++i];
			} else if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			out += c;
			continue;
		}
		if (c === '/' && src[i + 1] === '*') {
			const end = src.indexOf('*/', i + 2);
			const stop = end === -1 ? src.length : end + 2;
			// blank it, keeping newlines so line numbers survive
			out += src.slice(i, stop).replace(/[^\n]/g, ' ');
			i = stop - 1;
			continue;
		}
		out += c;
	}
	return out;
}

const CSS = stripCssComments(APP_CSS);

/** The body of every `@theme` block in app.css, comments already stripped. */
function themeBlocks(css: string): string[] {
	const out: string[] = [];
	const re = /@theme\b[^{]*\{/g;
	// the match object itself is unused — `re.lastIndex` is what the brace walk below needs
	while (re.exec(css) !== null) {
		let depth = 1;
		let i = re.lastIndex;
		while (i < css.length && depth > 0) {
			if (css[i] === '{') depth++;
			else if (css[i] === '}') depth--;
			i++;
		}
		out.push(css.slice(re.lastIndex, i - 1));
	}
	return out;
}

// Matched as a WHOLE `--token` word rather than prefix-anchored: an alternation anchored right after `--`
// never reaches `accent` in `--on-accent`, so the per-stop INK tokens — whose whole point is that ink ≠
// fill — slipped through.
/** The per-stop tokens whose ink/fill split is load-bearing; registering one mints an illegal pairing. */
const PLAYER_HUE_BRIDGE =
	/var\(\s*--(?:accent2|accent-ink|on-accent|on-fill-\d+|fill-\d+|hue-\d+|accent|grad|singer)\b/;
// `--accent` and `--on-accent` stay banned as DIRECT bridge values even though the semantic layer resolves
// to them: `--primary: var(--accent)` lives in `:root`, where nothing is minted, so the indirection is what
// makes the pairing decidable in ONE place.

const COLOUR_TOKEN_RE =
	/var\(\s*--(?:accent2|accent-ink|on-accent|on-fill-\d+|on-[a-z0-9-]+|fill-\d+|hue-\d+|accent|grad|ok|warn|danger|ink|bg|card|line|focus|scrim|track|stage|singer|stage-glow)\b/;
// A global-flag twin for matchAll; `.test()` callers use the non-global one to avoid lastIndex state.
const COLOUR_TOKEN_RE_G = new RegExp(COLOUR_TOKEN_RE.source, 'g');

/** Every offence one `--name: value` declaration commits. Shared by the app.css and config scans. */
function colourOffences(name: string, value: string): string[] {
	const out: string[] = [];
	// A `--color-*` NAME is not an offence by itself: the semantic layer is registered deliberately so vendored
	// components work unedited, and the ink direction is banned by class name in shadcn-ink-ban.test.ts. A
	// PLAYER HUE stays an offence: `onFill`/`ink` differ for 13 of the 48 stops.
	if (/^--color-/.test(name) && PLAYER_HUE_BRIDGE.test(value)) {
		out.push(`${name}: registers a PLAYER HUE (${value}) — mints text-* over a per-stop fill`);
	}
	// A raw colour VALUE is an offence under any name: an alias points at the token that already decided.
	if (/#[0-9a-fA-F]{3,8}\b/.test(value)) out.push(`${name}: raw hex colour value ${value}`);
	if (/\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix|light-dark)\s*\(/.test(value)) {
		out.push(`${name}: raw colour-function value ${value}`);
	}
	if (/\bgradient\s*\(/.test(value)) out.push(`${name}: gradient value ${value}`);
	if (/#[0-9a-fA-F]{3,8}\b/.test(value)) out.push(`${name}: hex colour value ${value}`);
	if (/\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix|light-dark)\s*\(/.test(value)) {
		out.push(`${name}: colour-function value ${value}`);
	}
	if (/\bgradient\s*\(/.test(value)) out.push(`${name}: gradient value ${value}`);
	// a bridge to one of the app's own colour tokens is the same violation wearing a var()
	if (PLAYER_HUE_BRIDGE.test(value)) out.push(`${name}: bridges the per-stop hue token ${value}`);
	return out;
}

/*
 * The scan covers any `tailwind.config.*` as well as app.css. This setup has no such file, but a v3-style
 * config reintroduced later would register the whole colour family entirely outside app.css.
 */
const CONFIG_GLOB = /^tailwind\.config\.(?:c|m)?[jt]s$/;

/** Absolute paths of every tailwind.config.* in the repo, excluding node_modules and build output. */
function tailwindConfigs(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		let entries: import('node:fs').Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				if (SKIP_DIRS.has(e.name) || e.name === 'node_modules' || e.name === 'build') continue;
				walk(p);
			} else if (CONFIG_GLOB.test(e.name)) {
				out.push(p);
			}
		}
	};
	walk(root);
	return out;
}

/** Offences a tailwind.config.* commits by declaring theme colours — the v3 equivalent of `@theme`. */
function configColourOffences(src: string, rel: string): string[] {
	const out: string[] = [];
	// strip JS/TS comments so a `// colors: {…}` note cannot satisfy or trip this
	const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
	const keyRe = /\bcolors?\s*:/g;
	if (!keyRe.test(code)) return out;
	for (const m of code.matchAll(/#[0-9a-fA-F]{3,8}\b/g))
		out.push(`${rel}: registers hex colour ${m[0]} in a theme config`);
	for (const m of code.matchAll(/\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix)\s*\([^)]*\)/g)) {
		out.push(`${rel}: registers colour-function ${m[0]} in a theme config`);
	}
	for (const m of code.matchAll(COLOUR_TOKEN_RE_G))
		out.push(`${rel}: bridges the colour token ${m[0]} in a theme config`);
	// The presence of a colors key IS the violation, so `colors: { accent: someImportedConst }` is caught too.
	out.push(`${rel}: declares a \`colors\` key in a Tailwind config — registers a colour utility family`);
	return out;
}

it('the @theme block registers no colour: finds the @theme block at all — the other arm is worthless if this regex stops matching', () => {
	const blocks = themeBlocks(CSS);
	expect(blocks.length).toBeGreaterThanOrEqual(1);
	// and it is not an empty shell: the spacing + type bridge really is in there
	expect(blocks.join('\n')).toContain('--spacing-tap');
	expect(blocks.join('\n')).toContain('--text-tv-lyric');
});

it('the @theme block registers no colour: registers no PLAYER HUE, so no per-stop `text-<hue>` utility can be minted', () => {
	// A colour can enter by NAME (the `--color-*` namespace) or by VALUE (a hex, a colour function, or a
	// gradient — which is how `--grad` would arrive, whose decoration-only ban a minted `bg-grad`/`text-grad`
	// pair would hand out as ordinary). The check is on what the declaration IS, not on how its name looks.
	const offenders: string[] = [];
	let mintSurfaces = 0;
	for (const block of themeBlocks(CSS)) {
		mintSurfaces++;
		for (const line of block.split('\n')) {
			const decl = /^\s*(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/.exec(line);
			if (!decl) continue;
			const [, name, rawValue] = decl;
			offenders.push(...colourOffences(name!, rawValue!.trim()));
		}
	}
	for (const cfg of tailwindConfigs(REPO)) {
		mintSurfaces++;
		offenders.push(...configColourOffences(readFileSync(cfg, 'utf8'), cfg.slice(REPO.length + 1)));
	}
	expect(offenders).toEqual([]);
	expect(mintSurfaces).toBeGreaterThanOrEqual(1); // @nvf-floor mintSurfaces
});

it('the @theme block registers no colour — MUTATION: registering a player hue in @theme reds the arm above', () => {
	// Splice a player-hue registration into the real app.css `@theme` block in each shape the guard must
	// catch, in-process rather than against a throwaway file on disk.
	const mutate = (decl: string): string[] => {
		const mutated = stripCssComments(APP_CSS).replace(/@theme\b([^{]*)\{/, `@theme$1{\n\t${decl}\n`);
		const found: string[] = [];
		for (const block of themeBlocks(mutated)) {
			for (const line of block.split('\n')) {
				const d = /^\s*(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/.exec(line);
				if (!d) continue;
				found.push(...colourOffences(d[1]!, d[2]!.trim()));
			}
		}
		return found;
	};
	// by-name in the --color-* namespace
	expect(mutate('--color-accent: var(--accent);').length).toBeGreaterThan(0);
	// by-value raw hex (a player hue pasted straight in)
	expect(mutate('--player-hue-3: #7254e6;').length).toBeGreaterThan(0);
	// a bridge to the per-stop ink token, whose name begins `--on` and walked past an anchored alternation
	expect(mutate('--text-hue-41: var(--on-accent);').length).toBeGreaterThan(0);
	expect(mutate('--text-hue-7: var(--on-fill-7);').length).toBeGreaterThan(0);
	// …and an anchored family list genuinely misses the ink bridge, so the whole-word match is load-bearing
	expect(
		/var\(\s*--(?:accent|grad|ok|warn|danger|ink|bg|card|line|focus|scrim|track|stage)/.test('var(--on-accent)')
	).toBe(false);
	expect(COLOUR_TOKEN_RE.test('var(--on-accent)')).toBe(true);
	expect(COLOUR_TOKEN_RE.test('var(--on-fill-7)')).toBe(true);
});

it('the @theme block registers no colour — MUTATION: a v3-shape tailwind.config that registers colours reds the config scan', () => {
	const cfg = "export default { theme: { extend: { colors: { accent: '#7254e6' } } } };";
	expect(configColourOffences(cfg, 'tailwind.config.ts').length).toBeGreaterThan(0);
	// a colours key with no recognisable literal is STILL caught — the family is minted either way
	expect(
		configColourOffences('export default { theme: { colors: { accent: brand } } };', 'tailwind.config.js').length
	).toBeGreaterThan(0);
	// and a config that touches no colours is clean, so the leg is not vacuously red
	expect(
		configColourOffences('export default { theme: { extend: { spacing: { tap: "44px" } } } };', 'tailwind.config.ts')
	).toEqual([]);
});

it('Preflight stays out until someone decides otherwise: does not import preflight.css', () => {
	// Both spellings, because either brings the reset in: the explicit part import, and the one-line
	// `@import 'tailwindcss'` whose whole point is that it includes Preflight. To enable it deliberately, run
	// tests/e2e/probes/preflight-reset-audit.mjs and deal with what it reports rather than deleting this arm.
	expect(CSS).not.toMatch(/@import\s+['"]tailwindcss\/preflight\.css['"]/);
	expect(CSS).not.toMatch(/@import\s+['"]tailwindcss['"]\s*;/);
});

it('Preflight stays out until someone decides otherwise: still imports the parts it does want, so the arm above is not passing by Tailwind being absent', () => {
	expect(CSS).toMatch(/@import\s+['"]tailwindcss\/theme\.css['"]\s+layer\(theme\)/);
	expect(CSS).toMatch(/@import\s+['"]tailwindcss\/utilities\.css['"]\s+layer\(utilities\)/);
});

it('utilities are minted from the copy-in target only: disables Tailwind source auto-detection', () => {
	// `source(none)` is what stops the whole-repo scan: without it Tailwind harvested 50 utilities from string
	// literals in tests and markdown, two of which collide with `ball` marker classes the app really applies.
	expect(CSS).toMatch(/@import\s+['"]tailwindcss\/utilities\.css['"][^;]*\bsource\(none\)/);
});

it('utilities are minted from the copy-in target only: names exactly one source, and it is the copy-in directory restricted to components', () => {
	// The file-extension half matters as much as the directory half: scoped to the bare directory, `.underline`
	// was minted again out of `ui/README.md`, which names it in prose precisely to warn about it.
	const sources = [...CSS.matchAll(/@source\s+(?:not\s+)?['"]([^'"]+)['"]/g)].map((m) => m[1]!);
	expect(sources).toEqual(['../src/lib/components/ui/**/*.svelte']);
	// and the directory that glob is rooted at is the real copy-in target, not a typo
	expect(join(SRC, '../src/lib/components/ui')).toBe(join(SRC, 'lib', 'components', 'ui'));
});

it('utilities are minted from the copy-in target only: no class a copied-in component uses is also a class the app applies semantically', () => {
	// The arms above pin the CONFIGURATION; neither can see the built CSS, where the collision that shipped
	// was only ever visible. A collision needs the SAME TOKEN as a utility in a copied-in component AND as a
	// semantic class on an app element, so the two sets are intersected — no Tailwind vocabulary needed.
	const uiDir = join(SRC, 'lib', 'components', 'ui');
	const uiComponents = svelteFiles(SRC).filter((f) => f.startsWith(uiDir + '/'));

	/** Every whitespace-separated static class token in a `class="…"`, interpolations blanked. */
	const classTokens = (src: string): Set<string> => {
		const out = new Set<string>();
		const code = src.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
		for (const m of code.matchAll(/class=(?:"([^"]*)"|'([^']*)')/g)) {
			const raw = (m[1] ?? m[2] ?? '').replace(/\{[^}]*\}/g, ' ');
			for (const t of raw.split(/\s+/)) if (t) out.add(t);
		}
		return out;
	};

	// The stripper must hide PROSE without hiding CODE, or the scan goes quietly blind.
	expect(classTokens('<!-- <label class="from-a-comment"> -->\n<div class="from-markup">')).toEqual(
		new Set(['from-markup'])
	);
	expect(classTokens('/* class="in-a-block-comment" */ <p class="also-markup">')).toEqual(new Set(['also-markup']));

	const appClasses = new Set<string>();
	for (const f of svelteFiles(SRC)) {
		if (f.startsWith(uiDir + '/')) continue;
		for (const t of classTokens(readFileSync(f, 'utf8'))) appClasses.add(t);
	}
	expect(appClasses.size).toBeGreaterThan(100); // the app side was really collected

	const offenders: string[] = [];
	for (const f of uiComponents) {
		for (const t of classTokens(readFileSync(f, 'utf8'))) {
			if (appClasses.has(t)) {
				offenders.push(`${f.slice(SRC.length + 1)}: \`${t}\` is also a class the app applies`);
			}
		}
	}
	expect(offenders).toEqual([]);
});

/*
 * The copy-in target is in guard scope BY CONSTRUCTION — every walk is unconditionally recursive and there
 * is no include-allowlist. Proven by MATERIALISING a file and walking for it, since a committed fixture
 * rots into ordinary source someone cleans up and its absence then looks like a passing test.
 */
const UI_DIR = join(SRC, 'lib', 'components', 'ui');

it('the copy-in target is genuinely in guard scope: the directory exists in the repo, so the @source scope is not vacuous in a fresh clone', () => {
	// Git does not track empty directories, so `ui/` needs a committed file or it vanishes on clone and
	// `@source` emits no utilities while looking correctly scoped. `ui/README.md` is markdown, so no walk sees it.
	expect(existsSync(UI_DIR)).toBe(true);
	expect(existsSync(join(UI_DIR, 'README.md'))).toBe(true);
});

it('the copy-in target is genuinely in guard scope: is not excluded by SKIP_DIRS — no segment of its path is skipped', () => {
	for (const segment of ['lib', 'components', 'ui']) {
		expect(SKIP_DIRS.has(segment)).toBe(false);
	}
});

it('the copy-in target is genuinely in guard scope: svelteFiles and styleFiles both reach a file placed there', () => {
	const probe = join(UI_DIR, '__scope-probe.svelte');
	// The pre-condition is that the probe is not already there, so the hit below is the walk ARRIVING at this
	// exact path rather than being indiscriminate.
	expect(svelteFiles(SRC)).not.toContain(probe);
	try {
		writeFileSync(probe, '<span class="scope-probe"></span>\n');
		expect(svelteFiles(SRC)).toContain(probe);
		expect(styleFiles(SRC)).toContain(probe);
	} finally {
		rmSync(probe, { force: true });
	}
	// and it is gone again, so a later guard in this same run cannot trip over it
	expect(svelteFiles(SRC)).not.toContain(probe);
});
