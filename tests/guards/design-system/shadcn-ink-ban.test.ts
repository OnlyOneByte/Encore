/*
 * guard: a semantic FILL is never used as ink in app source. See docs/GUARDS.md#tailwind-v4-toolchain.
 *
 * `--accent` (#7254e6) as INK measures 3.85:1 on `--bg`, 3.38 on `--card`, 3.10 on `--card2` and 2.90 on
 * `--card-tint2` — four AA failures. Refusing to REGISTER the colour prevented the class from existing and
 * also made every vendored shadcn component unusable unedited, a cost paid once per component across the
 * registry migration; the hazard was never the class existing but the class being USED. So the semantic
 * colours are registered and these NAMES are banned in app source, the same mechanism motion.test.ts's net
 * arm uses for `transition-all`. The per-stop half is in a11y/contrast.test.ts.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { at } from '@encore/test-support';
import { svelteFiles, styleFiles } from '@encore/test-support/scan';

const LIB = at('src/lib');
const ROUTES = at('src/routes');
const VENDORED = join('components', 'ui') + '/';

/** Utilities that paint a semantic FILL as ink. `bg-*` is legal for all of these — a fill on its own
 *  surface is the pairing the design system is built around; it is the ink direction that fails. */
const BANNED = [
	'text-primary',
	'text-secondary',
	'text-destructive',
	'text-muted',
	'border-primary',
	'ring-primary',
	'decoration-primary',
	'caret-primary'
];
/** `text-primary-foreground` is the LEGAL pairing and must not be caught by a prefix match. */
const bannedRe = new RegExp(`\\b(?:dark:|hover:|focus:|active:|disabled:)*(?:${BANNED.join('|')})(?![\\w-])`, 'g');

function sources(): string[] {
	// `.svelte` + `.css` covers every place a class list can be written as markup or a style rule; a utility
	// composed in a `.ts` constant is motion.test.ts's net arm's job.
	//
	// DEDUPED, because `styleFiles` already returns `.svelte` as well as `.css`: composing the two counted
	// 24 files twice, so the floor below read 57 where the truth is 33 — a floor that would still pass with
	// a third of the tree unreachable.
	//
	// `src/app.css` is included deliberately: it is the shared design system, the likeliest home for an
	// `@apply text-primary`, and it sits outside both trees.
	const appCss = at('src/app.css');
	return [
		...new Set([...svelteFiles(LIB), ...svelteFiles(ROUTES), ...styleFiles(LIB), ...styleFiles(ROUTES), appCss])
	].sort();
}

/**
 * Source with comments removed, so PROSE cannot red the suite: a CSS comment that merely NAMES
 * `text-primary` in order to explain why it is banned changes no behaviour and yet fails the build, which
 * makes the rule unwritable next to the code it governs. The mutation arm below proves the stripper does
 * not also BLIND the scan, which is the half that is easy to get wrong.
 */
function withoutComments(src: string): string {
	return src
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/(^|[\s;{])\/\/[^\n]*/g, '$1 ');
}

const files = sources();

test('a semantic fill is never minted into app source as ink: no app file uses a banned ink utility', () => {
	const offenders: string[] = [];
	for (const f of files) {
		// The registry components are exempt BY PATH: they are vendored verbatim so `--overwrite` stays safe,
		// and a stock component's `text-primary` on its own `bg-primary` surface is the legal pairing.
		if (f.includes(VENDORED)) continue;
		for (const m of withoutComments(readFileSync(f, 'utf8')).matchAll(bannedRe)) {
			offenders.push(`${f.slice(f.indexOf('src/'))}: ${m[0]}`);
		}
	}
	expect(offenders).toEqual([]);
});

test('a semantic fill is never minted into app source as ink: the legal pairing is not caught by the ban', () => {
	// Proof the regex is not simply matching everything.
	expect('text-primary-foreground'.match(bannedRe)).toBeNull();
	expect('bg-primary'.match(bannedRe)).toBeNull();
	expect([...'text-primary'.matchAll(bannedRe)].length).toBe(1);
	expect([...'hover:text-destructive'.matchAll(bannedRe)].length).toBe(1);
});

test('a semantic fill is never minted into app source as ink — non-vacuity: the scan reached app source outside the vendored tree', () => {
	// Deduped, so every entry is a distinct file and this number means what it says.
	const scanned = files.filter((f) => !f.includes(VENDORED));
	expect(scanned.length).toBeGreaterThanOrEqual(30); // @nvf-floor scanned.length
	expect(new Set(scanned).size).toBe(scanned.length);
	// …and the shared stylesheet is in scope, where an `@apply` would most likely land.
	expect(scanned.some((f) => f.endsWith('app.css'))).toBe(true);
});

test('a semantic fill is never minted into app source as ink: a comment naming the ban does not red the suite, but real usage still does', () => {
	// Both directions: the stripper must remove prose WITHOUT blinding the scan, which is what stops it
	// becoming a hole rather than a fix.
	const prose = `<!-- text-primary is banned: 3.10:1 on --card2 -->\n<p class="ink">x</p>`;
	expect([...withoutComments(prose).matchAll(bannedRe)].length).toBe(0);

	const cssProse = `/* never @apply text-destructive here */\n.x { color: var(--ink); }`;
	expect([...withoutComments(cssProse).matchAll(bannedRe)].length).toBe(0);

	const real = `<p class="text-primary">x</p>`;
	expect([...withoutComments(real).matchAll(bannedRe)].length).toBe(1);

	// …including on the same LINE as a trailing comment.
	const mixed = `.x { color: red; } // text-primary explained\n.y { @apply text-primary; }`;
	expect([...withoutComments(mixed).matchAll(bannedRe)].length).toBe(1);
});
