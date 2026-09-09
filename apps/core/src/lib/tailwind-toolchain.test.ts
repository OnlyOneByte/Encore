/*
 * ── THE TAILWIND TOOLCHAIN'S OWN GUARDS (issue #853) ───────────────────────────────────────────────
 *
 * Installing Tailwind into an app with ~4,950 lines of hand-written CSS required three decisions, and
 * each one is silent when it breaks. That is what this file is for. None of these arms tests Tailwind;
 * they test that the four choices #853 made are still the choices in force, because every one of them
 * fails by producing a *quietly different app* rather than an error:
 *
 *   1. NO COLOUR IN `@theme`. Registering a colour mints the whole utility family with no per-family
 *      opt-out, so `--color-accent` hands out `text-accent` beside `bg-accent` — and `--accent` as ink
 *      measures 3.63:1 on `--card2`, below AA, which is why `--accent-ink` exists as a distinct token.
 *      #840's 48-stop palette makes that ink-vs-fill split load-bearing for all 48. A colour added here
 *      would be a legal-looking class that fails contrast.
 *   2. PREFLIGHT STAYS OUT. Measured cost of letting it in: 9,892 computed-value changes and 2,696
 *      moved boxes across 8 surfaces (`e2e/probes/preflight-reset-audit.mjs`). Re-adding the import is
 *      a one-line change that no other test would notice.
 *   3. UTILITIES ARE MINTED FROM ONE DIRECTORY. Auto-detection scanned the whole repo — tests and
 *      markdown included — and collided with two class names the app really applies (`.underline` and
 *      `.block`, both `ball` marker styles; the first painted a real underline on the lyrics ball).
 *   4. THE COPY-IN TARGET IS IN GUARD SCOPE. #841 claimed `src/lib/components/ui/` is in scope "by
 *      construction"; until this issue the directory did not exist, so the claim was untested.
 *
 * Arms 1-3 read app.css as TEXT rather than parsing CSS, for the same reason the other guards here do:
 * the question is what the file SAYS, and a parser would need the whole Tailwind pipeline to answer it.
 * Comments are stripped first, so the long explanatory notes in app.css — which necessarily mention
 * `--color-accent` and `preflight.css` in order to explain why they are absent — can neither satisfy
 * nor trip an arm. That strip is load-bearing: without it arm 2 fails on app.css's own prose.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { svelteFiles, styleFiles, SKIP_DIRS } from './test-helpers';

const SRC = join(import.meta.dir, '..');
const APP_CSS_PATH = join(SRC, 'app.css');
const APP_CSS = readFileSync(APP_CSS_PATH, 'utf8');

/**
 * Blank CSS block-comment interiors, preserving length and newlines so reported offsets stay true.
 *
 * app.css is a plain stylesheet, so CSS block comments are the only comment form it can carry — there
 * is no `//` in CSS and no `<!-- -->` outside markup. Deliberately NOT imported from `test-helpers`:
 * the shared `stripComments` helpers there are the `.svelte` variants and are known to diverge on
 * whether they strip at all, which is why #626 left `stripComments` out of the single-sourcing batch.
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

describe('#853 the @theme block registers no colour', () => {
	it('finds the @theme block at all — the other arm is worthless if this regex stops matching', () => {
		const blocks = themeBlocks(CSS);
		expect(blocks.length).toBeGreaterThanOrEqual(1);
		// and it is not an empty shell: the spacing + type bridge really is in there
		expect(blocks.join('\n')).toContain('--spacing-tap');
		expect(blocks.join('\n')).toContain('--text-tv-lyric');
	});

	it('registers no colour, so no `text-<hue>` utility can be minted', () => {
		/*
		 * Two independent tests per declaration, because a colour can enter by NAME or by VALUE and
		 * either one mints the family:
		 *   - name: anything in Tailwind's `--color-*` namespace.
		 *   - value: a hex, rgb()/hsl()/oklch()/lab()/color-mix(), or a gradient — which is how
		 *     `--grad` would arrive, and `--grad` carries a decoration-only ban that a minted
		 *     `bg-grad`/`text-grad` pair would hand out as ordinary.
		 * The `ball`-marker lesson applies here too: the check is on what the declaration IS, not on
		 * whether its name looks colour-ish.
		 */
		const offenders: string[] = [];
		for (const block of themeBlocks(CSS)) {
			for (const line of block.split('\n')) {
				const decl = /^\s*(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/.exec(line);
				if (!decl) continue;
				const [, name, rawValue] = decl;
				const value = rawValue!.trim();
				if (/^--color-/.test(name!)) {
					offenders.push(`${name}: in Tailwind's --color-* namespace (mints text-* and bg-*)`);
				}
				if (/#[0-9a-fA-F]{3,8}\b/.test(value)) offenders.push(`${name}: hex colour value ${value}`);
				if (/\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix|light-dark)\s*\(/.test(value)) {
					offenders.push(`${name}: colour-function value ${value}`);
				}
				if (/\bgradient\s*\(/.test(value)) offenders.push(`${name}: gradient value ${value}`);
				// a bridge to one of the app's own colour tokens is the same violation wearing a var()
				if (/var\(\s*--(?:accent|grad|ok|warn|danger|ink|bg|card|line|focus|scrim|track|stage)/.test(value)) {
					offenders.push(`${name}: bridges the colour token ${value}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});

describe('#853 Preflight stays out until someone decides otherwise', () => {
	it('does not import preflight.css', () => {
		/*
		 * Both spellings, because either one would bring the reset in: the explicit part import, and
		 * the one-line `@import 'tailwindcss'` whose whole point is that it includes Preflight.
		 * If you are here because this test failed and you MEANT to enable Preflight: #853's
		 * acceptance requires before/after frames of the existing screens and the fallout named, so
		 * run `e2e/probes/preflight-reset-audit.mjs` on both sides and deal with what it reports —
		 * last measured at 2,696 moved boxes — rather than deleting this arm.
		 */
		expect(CSS).not.toMatch(/@import\s+['"]tailwindcss\/preflight\.css['"]/);
		expect(CSS).not.toMatch(/@import\s+['"]tailwindcss['"]\s*;/);
	});

	it('still imports the parts it does want, so the arm above is not passing by Tailwind being absent', () => {
		expect(CSS).toMatch(/@import\s+['"]tailwindcss\/theme\.css['"]\s+layer\(theme\)/);
		expect(CSS).toMatch(/@import\s+['"]tailwindcss\/utilities\.css['"]\s+layer\(utilities\)/);
	});
});

describe('#853 utilities are minted from the copy-in target only', () => {
	it('disables Tailwind source auto-detection', () => {
		/*
		 * `source(none)` is what stops the whole-repo scan. Without it Tailwind harvested 50 utilities
		 * from string literals in tests and markdown, two of which (`.underline`, `.block`) collide
		 * with `ball` marker classes the app applies to real elements.
		 */
		expect(CSS).toMatch(/@import\s+['"]tailwindcss\/utilities\.css['"][^;]*\bsource\(none\)/);
	});

	it('names exactly one source, and it is the copy-in directory restricted to components', () => {
		// The glob's file-extension half matters as much as its directory half. Scoped to the bare
		// directory, `.underline` was minted again — out of `ui/README.md`, which names it in prose
		// precisely to warn about it. A utility can only be USED in a component, so components are
		// what gets scanned.
		const sources = [...CSS.matchAll(/@source\s+(?:not\s+)?['"]([^'"]+)['"]/g)].map((m) => m[1]!);
		expect(sources).toEqual(['../src/lib/components/ui/**/*.svelte']);
		// and the directory that glob is rooted at is the real copy-in target, not a typo
		expect(join(SRC, '../src/lib/components/ui')).toBe(join(SRC, 'lib', 'components', 'ui'));
	});

	it('no class a copied-in component uses is also a class the app applies semantically', () => {
		/*
		 * THE ARM THAT WOULD HAVE CAUGHT THE REAL BUG, and the one that matters going forward.
		 *
		 * The two arms above pin the CONFIGURATION; neither can see the built CSS, and the collision
		 * that shipped was only ever visible there. This one attacks the hazard directly and without
		 * needing Tailwind's vocabulary: a collision requires the SAME TOKEN to be a utility in a
		 * copied-in component AND a semantic class on an app element. So intersect the two sets.
		 *
		 * It is empty today because `ui/` holds no component yet, which is honest rather than vacuous —
		 * the arm exists for the moment #827 copies one in, where a `class="... block ..."` on a shadcn
		 * drawer would otherwise silently re-arm `.block` against the lyrics ball. The floor below
		 * asserts the app side really was collected, so the intersection cannot pass by finding nothing.
		 */
		const uiDir = join(SRC, 'lib', 'components', 'ui');
		const uiComponents = svelteFiles(SRC).filter((f) => f.startsWith(uiDir + '/'));

		/** Every whitespace-separated static class token in a `class="…"`, interpolations blanked. */
		const classTokens = (src: string): Set<string> => {
			const out = new Set<string>();
			for (const m of src.matchAll(/class=(?:"([^"]*)"|'([^']*)')/g)) {
				const raw = (m[1] ?? m[2] ?? '').replace(/\{[^}]*\}/g, ' ');
				for (const t of raw.split(/\s+/)) if (t) out.add(t);
			}
			return out;
		};

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
});

describe('#841 the copy-in target is genuinely in guard scope', () => {
	/*
	 * The claim in `test-helpers.ts` is that a new source directory is in scope BY CONSTRUCTION,
	 * because every walk is unconditionally recursive and there is no include-allowlist. #853 created
	 * `src/lib/components/ui/`, so the claim is testable for the first time.
	 *
	 * This is proven by MATERIALISING a file and walking for it, rather than by asserting a committed
	 * fixture exists. A fixture would rot into ordinary source that someone eventually "cleans up",
	 * and its absence would then look like a passing test. Creating the file inside the test means the
	 * proof is re-derived on every run against whatever the walk currently does. It is removed in a
	 * `finally`, and its name marks it as machinery.
	 */
	const UI_DIR = join(SRC, 'lib', 'components', 'ui');

	it('the directory exists in the repo, so the @source scope is not vacuous in a fresh clone', () => {
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

	it('is not excluded by SKIP_DIRS — no segment of its path is skipped', () => {
		for (const segment of ['lib', 'components', 'ui']) {
			expect(SKIP_DIRS.has(segment)).toBe(false);
		}
	});

	it('svelteFiles and styleFiles both reach a file placed there', () => {
		const probe = join(UI_DIR, '__scope-probe.svelte');
		// NON-VACUITY, established BEFORE the probe exists: the walk currently returns nothing from
		// this directory, so a hit below is the walk arriving rather than the walk being indiscriminate.
		expect(svelteFiles(SRC).filter((f) => f.startsWith(UI_DIR + '/'))).toEqual([]);
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
});
