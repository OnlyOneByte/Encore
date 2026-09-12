/*
 * ── THE TAILWIND TOOLCHAIN'S OWN GUARDS ───────────────────────────────────────────────
 *
 * Installing Tailwind into an app with ~4,950 lines of hand-written CSS required three decisions, and
 * each one is silent when it breaks. That is what this file is for. None of these arms tests Tailwind;
 * they test that the four choices the install made are still the choices in force, because every one of them
 * fails by producing a *quietly different app* rather than an error:
 *
 *   1. NO COLOUR IN `@theme`. Registering a colour mints the whole utility family with no per-family
 *      opt-out, so `--color-accent` hands out `text-accent` beside `bg-accent` — and `--accent` as ink
 *      measures 3.10:1 on `--card2`, below AA, which is why `--accent-ink` exists as a distinct token.
 *      The 48-stop palette makes that ink-vs-fill split load-bearing for all 48. A colour added here
 *      would be a legal-looking class that fails contrast.
 *   2. PREFLIGHT STAYS OUT. Measured cost of letting it in: 9,892 computed-value changes and 2,696
 *      moved boxes across 8 surfaces (`e2e/probes/preflight-reset-audit.mjs`). Re-adding the import is
 *      a one-line change that no other test would notice.
 *   3. UTILITIES ARE MINTED FROM ONE DIRECTORY. Auto-detection scanned the whole repo — tests and
 *      markdown included — and collided with two class names the app really applies (`.underline` and
 *      `.block`, both `ball` marker styles; the first painted a real underline on the lyrics ball).
 *   4. THE COPY-IN TARGET IS IN GUARD SCOPE. An earlier ruling claimed `src/lib/components/ui/` is in scope "by
 *      construction"; until this issue the directory did not exist, so the claim was untested.
 *
 * Arms 1-3 read app.css as TEXT rather than parsing CSS, for the same reason the other guards here do:
 * the question is what the file SAYS, and a parser would need the whole Tailwind pipeline to answer it.
 * Comments are stripped first, so the long explanatory notes in app.css — which necessarily mention
 * `--color-accent` and `preflight.css` in order to explain why they are absent — can neither satisfy
 * nor trip an arm. That strip is load-bearing: without it arm 2 fails on app.css's own prose.
 */
import { expect, it } from 'bun:test';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appSrc, repoRoot } from '@encore/test-support';
import { svelteFiles, styleFiles, SKIP_DIRS } from '$lib/test-helpers';

// Was `at('apps/core/src')` (apps/core/src, from this guard's old home in apps/core/src/lib)
// and `join(SRC, '..', '..', '..')` for the repo root that the tailwind.config.* walk starts from. Both
// are now the shared anchors, so neither depends on where this file sits.
const SRC = appSrc;
// repo root — used to walk for any tailwind.config.*.
const REPO = repoRoot;
const APP_CSS_PATH = join(SRC, 'app.css');
const APP_CSS = readFileSync(APP_CSS_PATH, 'utf8');

/**
 * Blank CSS block-comment interiors, preserving length and newlines so reported offsets stay true.
 *
 * app.css is a plain stylesheet, so CSS block comments are the only comment form it can carry — there
 * is no `//` in CSS and no `<!-- -->` outside markup. Deliberately NOT imported from `test-helpers`:
 * the shared `stripComments` helpers there are the `.svelte` variants and are known to diverge on
 * whether they strip at all, which is why the single-sourcing batch left `stripComments` out.
 *
 * STRING-AWARE, and that is not defensive programming — a naive version broke this file's own subject.
 * The `@source` glob ends with a recursive-directory wildcard followed by an extension wildcard, and
 * that junction spells slash-star-star-slash: a literal, legal, EMPTY CSS COMMENT. A stripper that does
 * not know it is inside a quoted string blanks the middle of the glob and hands the arm below
 * `'../src/lib/components/ui    *.svelte'` to assert against. So quotes are tracked, and a comment
 * opener inside a string is left alone.
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

/*
 * ── THE COLOUR-TOKEN VOCABULARY (XR-COL-14) ────────────────────────────────────────────
 *
 * The value-bridge arm below must red on a `@theme` entry that FORWARDS to one of the app's own colour
 * tokens (`--color-x: var(--accent)` mints `text-accent` just as surely as a literal hex does). The
 * original regex anchored the family list immediately after `--`:
 *
 *     var\(\s*--(?:accent|grad|ok|warn|danger|ink|bg|card|line|focus|scrim|track|stage)
 *
 * which the palette investigation flagged as leaky in exactly the direction the 48-stop palette
 * makes load-bearing: the per-stop INK tokens are named `--on-accent` and — under the 48-stop palette —
 * `--on-fill-N`, and both begin `--on`, so the anchored alternation never reaches `accent`/`fill` and
 * they slip straight through. Those are the tokens whose whole point is that ink ≠ fill; a minted
 * `text-*` off one of them is the precise class this rule exists to forbid.
 *
 * So the vocabulary is matched as a WHOLE `--token` word (bounded, not prefix-anchored) and the ink
 * names are named explicitly:
 *   - the incumbent fill/surface families, now including `accent2`;
 *   - the ink tokens: `--on-accent`, `--accent-ink`, and any `--on-fill-N` per-stop ink;
 *   - any `--on-*` ink token and any `--fill-N` / `--hue-N` player-hue stop, so a future stop token
 *     minted from that palette is caught the day it is bridged, not the day someone remembers to add
 *     it to a list.
 */
/** The per-stop tokens whose ink/fill split is load-bearing. Registering one of these mints an illegal pairing. */
const PLAYER_HUE_BRIDGE =
	/var\(\s*--(?:accent2|accent-ink|on-accent|on-fill-\d+|fill-\d+|hue-\d+|accent|grad|singer)\b/;
/*
 * `--accent` and `--on-accent` stay banned as DIRECT bridge values even though the semantic layer
 * ultimately resolves to them. That is not a contradiction: the layer bridges `var(--primary)`, and
 * `--primary: var(--accent)` lives in `:root` where nothing is minted. The indirection is what makes
 * the pairing decidable in one place — a `@theme` entry naming `--accent` outright would mint over a
 * per-stop fill with no such single place.
 */

const COLOUR_TOKEN_RE =
	/var\(\s*--(?:accent2|accent-ink|on-accent|on-fill-\d+|on-[a-z0-9-]+|fill-\d+|hue-\d+|accent|grad|ok|warn|danger|ink|bg|card|line|focus|scrim|track|stage|singer|stage-glow)\b/;
// A global-flag twin for matchAll; `.test()` callers use the non-global one above to avoid lastIndex state.
const COLOUR_TOKEN_RE_G = new RegExp(COLOUR_TOKEN_RE.source, 'g');

/**
 * Every offence a single `--name: value` declaration commits against XR-COL-14, or []. Shared by the
 * app.css `@theme` scan and the tailwind-config scan so the two cannot drift apart.
 */
function colourOffences(name: string, value: string): string[] {
	const out: string[] = [];
	/*
	 * a `--color-*` name is no longer an offence by itself — the semantic layer (`--color-primary`
	 * and friends) is registered deliberately so vendored components work unedited, and the ink
	 * direction is banned by NAME in `shadcn-ink-ban-913.test.ts` instead. What stays an offence is
	 * registering a PLAYER HUE, because those vary per stop and `onFill`/`ink` differ for 13 of the 48 —
	 * a minted `text-<hue>` would offer the illegal pairing for every one of them.
	 */
	if (/^--color-/.test(name) && PLAYER_HUE_BRIDGE.test(value)) {
		out.push(`${name}: registers a PLAYER HUE (${value}) — mints text-* over a per-stop fill`);
	}
	// A raw colour VALUE is an offence under any name: it cannot be a semantic alias, because an alias
	// by definition points at the token that already decided the question.
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
	// a bridge to one of the app's own colour tokens is the same violation wearing a var() — now
	// including the per-stop ink names (`--on-accent`, `--on-fill-N`) that used to slip the anchor.
	if (PLAYER_HUE_BRIDGE.test(value)) out.push(`${name}: bridges the per-stop hue token ${value}`);
	return out;
}

/*
 * ── SCAN ANY TAILWIND CONFIG, NOT JUST app.css ────────────────────────────────────────
 *
 * This setup is Tailwind v4 CSS-first: the theme lives in app.css's `@theme` block and there is no
 * `tailwind.config.*` (a JS config would be the v3 shape — app.css says so at its bridge comment). But
 * the palette investigation flagged that the original guard reads ONLY app.css, so a v3-style config file
 * reintroduced later — `theme: { extend: { colors: { accent: '#7254e6' } } }` — would register the
 * whole colour family completely outside the guard's sight. XR-COL-14 must hold "given a Tailwind
 * config exists in the tree", whatever its shape.
 *
 * So the guard walks the repo for `tailwind.config.{js,cjs,mjs,ts,cts,mts}` and text-scans each for a
 * `colors`/`color` key inside a `theme` block. A JS config is not CSS, so the by-name `--color-*` and
 * by-value literal checks are applied to the STRING VALUES a colour key would carry; a text scan is the
 * right tool for the same reason the app.css arms text-scan rather than parse — the question is what the
 * file SAYS registers a colour, and answering it by executing the config would need the whole toolchain.
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

/**
 * Offences a tailwind.config.* commits by declaring theme colours. Scans for a `colors`/`color` key
 * under a `theme` (or `theme.extend`) block and reports every colour literal or app-token bridge it
 * hands to the palette — the config-file equivalent of a `--color-*` registration in `@theme`.
 */
function configColourOffences(src: string, rel: string): string[] {
	const out: string[] = [];
	// strip JS/TS comments so a `// colors: {…}` note or block comment cannot satisfy or trip this
	const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
	// a colors/color key anywhere in the config is a v3 colour registration; each mints text-* + bg-*
	const keyRe = /\bcolors?\s*:/g;
	if (!keyRe.test(code)) return out;
	// any colour literal in the file body is a registered palette value
	for (const m of code.matchAll(/#[0-9a-fA-F]{3,8}\b/g))
		out.push(`${rel}: registers hex colour ${m[0]} in a theme config`);
	for (const m of code.matchAll(/\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix)\s*\([^)]*\)/g)) {
		out.push(`${rel}: registers colour-function ${m[0]} in a theme config`);
	}
	for (const m of code.matchAll(COLOUR_TOKEN_RE_G))
		out.push(`${rel}: bridges the colour token ${m[0]} in a theme config`);
	// the mere presence of a colors key is itself the violation — the family is minted with or without a
	// value the scans above recognise, so report it so a `colors: { accent: someImportedConst }` is caught
	out.push(`${rel}: declares a \`colors\` key in a Tailwind config — registers a colour utility family (XR-COL-14)`);
	return out;
}

it('the @theme block registers no colour: finds the @theme block at all — the other arm is worthless if this regex stops matching', () => {
	const blocks = themeBlocks(CSS);
	expect(blocks.length).toBeGreaterThanOrEqual(1);
	// and it is not an empty shell: the spacing + type bridge really is in there
	expect(blocks.join('\n')).toContain('--spacing-tap');
	expect(blocks.join('\n')).toContain('--text-tv-lyric');
});

/*
 * ── RETIRED BY THE REGISTRY RESTRUCTURE, ON THE RECORD (XR-VER-07) ─────────────────────────────────────
 *
 * This arm asserted `@theme` registers NO colour, so `text-<hue>` could never be minted. Its
 * measurement was never wrong: `--accent` as ink is 3.85:1 on --bg, 3.38 on --card, 3.10 on --card2
 * and 2.90 on --card-tint2 — four AA failures.
 *
 * What it could not see is the cost on the other side. Refusing to register the semantic colours
 * made every vendored shadcn component non-functional unedited, which forced a hand-repointing of
 * each one and made `shadcn-svelte add --overwrite` destructive — a price paid once per component
 * across the whole registry migration, to prevent a class from EXISTING when the hazard is the class
 * being USED.
 *
 * SUCCESSOR: `shadcn-ink-ban-913.test.ts` bans those utility NAMES in app source, exempting the
 * vendored tree by path. That is the same mechanism `components/motion.test.ts`'s net arm already
 * uses for `transition-all`. The per-stop half stays with `contrast.test.ts`, which records
 * accent-as-ink leaving scope as a universal fact and becoming per-stop across the palette's 48 stops.
 *
 * The PLAYER HUES are still unregistered and still un-mintable: `--accent2`, `--grad`, `--fill-N`
 * and `--hue-N` appear nowhere in `@theme`, which the arm below now pins directly.
 */
it('the @theme block registers no colour: registers no PLAYER HUE, so no per-stop `text-<hue>` utility can be minted', () => {
	/*
	 * Two independent tests per declaration, because a colour can enter by NAME or by VALUE and
	 * either one mints the family:
	 *   - name: anything in Tailwind's `--color-*` namespace.
	 *   - value: a hex, rgb()/hsl()/oklch()/lab()/color-mix(), or a gradient — which is how
	 *     `--grad` would arrive, and `--grad` carries a decoration-only ban that a minted
	 *     `bg-grad`/`text-grad` pair would hand out as ordinary.
	 * The `ball`-marker lesson applies here too: the check is on what the declaration IS, not on
	 * whether its name looks colour-ish.
	 *
	 * XR-COL-14 widens this two ways over the original: the value-bridge now catches the
	 * per-stop INK tokens (`--on-accent`, `--on-fill-N`) that the anchored family list used to miss,
	 * and the scan covers any `tailwind.config.*` in the tree as well as app.css's `@theme`, since a
	 * v3-shape config would register colours entirely outside app.css. `mintSurfaces` counts every
	 * surface actually examined so the arm cannot pass by looking at nothing (XR-VER-05/06).
	 */
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
	// NON-VACUITY (XR-VER-05/06): the rule is unenforceable if no @theme block and no config were
	// seen, and an empty `offenders` from an empty scan reads identically to a clean tree. Fail
	// LOUDLY here instead — the day Tailwind is uninstalled, or the @theme regex stops matching, is
	// the day this arm must go red rather than green. `blocks.length >= 1` above is the app.css leg;
	// this is the whole-scan leg, and it is the floor registered in non-vacuity-floors.test.ts.
	expect(mintSurfaces).toBeGreaterThanOrEqual(1); // @nvf-floor mintSurfaces
});

it('the @theme block registers no colour — MUTATION: registering a player hue in @theme reds the arm above', () => {
	/*
	 * The arm is only worth its floor if it actually fires. Prove it: take the real app.css, splice
	 * a player-hue registration into its `@theme inline` block in each of the shapes the guard must
	 * catch — a `--color-*` name, a raw hex, and a bridge to the per-stop ink token that used to slip
	 * the anchor — and assert each one produces an offence. This is the mutation the issue asks for,
	 * run in-process against the guard's own logic rather than against a throwaway file on disk.
	 */
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
	// THE HOLE THIS CLOSES: a bridge to the per-stop ink token, whose name begins `--on` and used to
	// walk past the anchored family alternation untouched.
	expect(mutate('--text-hue-41: var(--on-accent);').length).toBeGreaterThan(0);
	expect(mutate('--text-hue-7: var(--on-fill-7);').length).toBeGreaterThan(0);
	// and confirm the OLD anchored regex would have missed the ink bridge, so the widening is real
	expect(
		/var\(\s*--(?:accent|grad|ok|warn|danger|ink|bg|card|line|focus|scrim|track|stage)/.test('var(--on-accent)')
	).toBe(false);
	expect(COLOUR_TOKEN_RE.test('var(--on-accent)')).toBe(true);
	expect(COLOUR_TOKEN_RE.test('var(--on-fill-7)')).toBe(true);
});

it('the @theme block registers no colour — MUTATION: a v3-shape tailwind.config that registers colours reds the config scan', () => {
	// The other half of the widening: prove the config-file leg fires on a reintroduced v3 config. In-process
	// against configColourOffences, so no file is written into the tree.
	const cfg = "export default { theme: { extend: { colors: { accent: '#7254e6' } } } };";
	expect(configColourOffences(cfg, 'tailwind.config.ts').length).toBeGreaterThan(0);
	// a config with a colours key but no recognisable literal is STILL caught — the family is minted
	// regardless of whether the value is a hex the scan can read.
	expect(
		configColourOffences('export default { theme: { colors: { accent: brand } } };', 'tailwind.config.js').length
	).toBeGreaterThan(0);
	// and a config that touches no colours is clean, so the leg is not vacuously red
	expect(
		configColourOffences('export default { theme: { extend: { spacing: { tap: "44px" } } } };', 'tailwind.config.ts')
	).toEqual([]);
});

it('Preflight stays out until someone decides otherwise: does not import preflight.css', () => {
	/*
	 * Both spellings, because either one would bring the reset in: the explicit part import, and
	 * the one-line `@import 'tailwindcss'` whose whole point is that it includes Preflight.
	 * If you are here because this test failed and you MEANT to enable Preflight: the install's
	 * acceptance requires before/after frames of the existing screens and the fallout named, so
	 * run `e2e/probes/preflight-reset-audit.mjs` on both sides and deal with what it reports —
	 * last measured at 2,696 moved boxes — rather than deleting this arm.
	 */
	expect(CSS).not.toMatch(/@import\s+['"]tailwindcss\/preflight\.css['"]/);
	expect(CSS).not.toMatch(/@import\s+['"]tailwindcss['"]\s*;/);
});

it('Preflight stays out until someone decides otherwise: still imports the parts it does want, so the arm above is not passing by Tailwind being absent', () => {
	expect(CSS).toMatch(/@import\s+['"]tailwindcss\/theme\.css['"]\s+layer\(theme\)/);
	expect(CSS).toMatch(/@import\s+['"]tailwindcss\/utilities\.css['"]\s+layer\(utilities\)/);
});

it('utilities are minted from the copy-in target only: disables Tailwind source auto-detection', () => {
	/*
	 * `source(none)` is what stops the whole-repo scan. Without it Tailwind harvested 50 utilities
	 * from string literals in tests and markdown, two of which (`.underline`, `.block`) collide
	 * with `ball` marker classes the app applies to real elements.
	 */
	expect(CSS).toMatch(/@import\s+['"]tailwindcss\/utilities\.css['"][^;]*\bsource\(none\)/);
});

it('utilities are minted from the copy-in target only: names exactly one source, and it is the copy-in directory restricted to components', () => {
	// The glob's file-extension half matters as much as its directory half. Scoped to the bare
	// directory, `.underline` was minted again — out of `ui/README.md`, which names it in prose
	// precisely to warn about it. A utility can only be USED in a component, so components are
	// what gets scanned.
	const sources = [...CSS.matchAll(/@source\s+(?:not\s+)?['"]([^'"]+)['"]/g)].map((m) => m[1]!);
	expect(sources).toEqual(['../src/lib/components/ui/**/*.svelte']);
	// and the directory that glob is rooted at is the real copy-in target, not a typo
	expect(join(SRC, '../src/lib/components/ui')).toBe(join(SRC, 'lib', 'components', 'ui'));
});

it('utilities are minted from the copy-in target only: no class a copied-in component uses is also a class the app applies semantically', () => {
	/*
	 * THE ARM THAT WOULD HAVE CAUGHT THE REAL BUG, and the one that matters going forward.
	 *
	 * The two arms above pin the CONFIGURATION; neither can see the built CSS, and the collision
	 * that shipped was only ever visible there. This one attacks the hazard directly and without
	 * needing Tailwind's vocabulary: a collision requires the SAME TOKEN to be a utility in a
	 * copied-in component AND a semantic class on an app element. So intersect the two sets.
	 *
	 * It is empty today because `ui/` holds no component yet, which is honest rather than vacuous —
	 * the arm exists for the moment a copy-in lands one, where a `class="... block ..."` on a shadcn
	 * drawer would otherwise silently re-arm `.block` against the lyrics ball. The floor below
	 * asserts the app side really was collected, so the intersection cannot pass by finding nothing.
	 */
	const uiDir = join(SRC, 'lib', 'components', 'ui');
	const uiComponents = svelteFiles(SRC).filter((f) => f.startsWith(uiDir + '/'));

	/** Every whitespace-separated static class token in a `class="…"`, interpolations blanked. */
	/*
	 * S3: strip comments FIRST. This scanned raw text, so a component's own documentation
	 * naming a class — `<label class="check">` in the Checkbox's deviation header — was collected as
	 * a class the component USES, and reported as a collision with the app. A guard that criminalises
	 * its own explanation teaches people to stop writing the explanation. The mutation arm below
	 * proves the stripper does not blind the scan.
	 */
	const classTokens = (src: string): Set<string> => {
		const out = new Set<string>();
		const code = src.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
		for (const m of code.matchAll(/class=(?:"([^"]*)"|'([^']*)')/g)) {
			const raw = (m[1] ?? m[2] ?? '').replace(/\{[^}]*\}/g, ' ');
			for (const t of raw.split(/\s+/)) if (t) out.add(t);
		}
		return out;
	};

	// MUTATION: the stripper must hide PROSE without hiding CODE. A class named inside a comment is
	// not a class the file uses; one in markup is. If a future edit widens the stripper into the
	// markup, this reds instead of the scan going quietly blind.
	expect(classTokens('<!-- <label class="from-a-comment"> -->\n<div class="from-markup">')).toEqual(
		new Set(['from-markup'])
	);
	expect(classTokens('/* class="in-a-block-comment" */ <p class="also-markup">')).toEqual(new Set(['also-markup']));

	// the app side: every component OUTSIDE the copy-in target, plus the `ball` marker enum, whose
	// values reach markup through `class="ball {ball}"` and so never appear as static tokens.
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
 * The claim in `test-helpers.ts` is that a new source directory is in scope BY CONSTRUCTION,
 * because every walk is unconditionally recursive and there is no include-allowlist. The Tailwind install created
 * `src/lib/components/ui/`, so the claim is testable for the first time.
 *
 * This is proven by MATERIALISING a file and walking for it, rather than by asserting a committed
 * fixture exists. A fixture would rot into ordinary source that someone eventually "cleans up",
 * and its absence would then look like a passing test. Creating the file inside the test means the
 * proof is re-derived on every run against whatever the walk currently does. It is removed in a
 * `finally`, and its name marks it as machinery.
 */
const UI_DIR = join(SRC, 'lib', 'components', 'ui');

it('the copy-in target is genuinely in guard scope: the directory exists in the repo, so the @source scope is not vacuous in a fresh clone', () => {
	/*
	 * Git does not track empty directories, so `ui/` needs at least one committed file or it would
	 * vanish on clone — and app.css's `@source` would then point at nothing, emitting no utilities
	 * while looking exactly like a correctly-scoped setup with nothing using one yet. That is the
	 * failure mode this arm exists to make loud. `ui/README.md` is the committed file; it is
	 * markdown, so neither walk below picks it up and no design guard has an opinion about it.
	 */
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
	/*
	 * NON-VACUITY, RE-ANCHORED BY S1 (XR-VER-07).
	 *
	 * This previously asserted the walk returns NOTHING from this directory, and used that emptiness
	 * to prove a later hit was the walk arriving rather than the walk being indiscriminate. S1
	 * copied in the first real component (`button/`), so that premise is gone — and it is gone
	 * because the thing it was waiting for happened, which is the good case, not a regression.
	 *
	 * The property still worth pinning is the one the original was reaching for: the walk reaches
	 * THIS EXACT probe path, not merely something in the directory. So the pre-condition becomes
	 * "the probe is not already there", and the assertion below is unchanged.
	 */
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
