/*
 * THE INK BAN, MOVED FROM EXISTENCE TO USE (the shadcn restructure, XR-COL-14 successor).
 *
 * `app.css`'s `@theme` used to register no colour at all, so `text-primary` could not be minted. That
 * prevented the class from EXISTING — and it also made every vendored shadcn component unusable
 * unedited, a cost paid once per component across the whole registry migration.
 *
 * The measurement that justified the old ban is unchanged and still the reason this file exists:
 * `--accent` (#7254e6) as INK measures 3.85:1 on `--bg`, 3.38 on `--card`, 3.10 on `--card2` and 2.90 on
 * `--card-tint2`. Four AA failures. What changed is that the hazard was never the class existing — it is
 * the class being USED. So the semantic colours are now registered, and these NAMES are banned in app
 * source instead.
 *
 * The precedent is in this repo already: `components/motion.test.ts`'s net arm bans `transition-all` by
 * name while Tailwind mints it freely, for exactly this reason — "what IS decidable is that these
 * utility NAMES do not occur in source at all".
 *
 * The per-stop half of the invariant is enforced elsewhere and deliberately: `contrast.test.ts` records
 * accent-as-ink leaving scope as a UNIVERSAL fact and becoming per-stop across all 48 palette stops.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { svelteFiles, styleFiles } from './test-helpers';

const LIB = join(import.meta.dir);
const ROUTES = join(import.meta.dir, '..', 'routes');
const VENDORED = join('components', 'ui') + '/';

/**
 * Utilities that would paint a semantic FILL as ink. `bg-*` is legal for all of these — a fill on its
 * own surface is the pairing the design system is built around. It is the ink direction that fails.
 */
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
	// `.svelte` + `.css` covers every place a class list can be written as markup or a style rule.
	// A utility composed in a `.ts` constant is the net arm's job in motion.test.ts, not this file's.
	//
	// DEDUPED, because `styleFiles` already returns `.svelte` as well as `.css`. Composing it with
	// `svelteFiles(LIB)` counted 24 files twice — the non-vacuity floor below read 57 where the truth is
	// 33, which is a floor that would still pass with a third of the tree unreachable, and offender
	// strings were reported twice.
	//
	// `src/app.css` is included DELIBERATELY: it is the shared design system and by far the likeliest
	// home for an `@apply text-primary`, and it sits outside both LIB and ROUTES so the earlier list
	// never read it at all.
	const appCss = join(LIB, '..', 'app.css');
	return [
		...new Set([
			...svelteFiles(LIB),
			...svelteFiles(ROUTES),
			...styleFiles(LIB),
			...styleFiles(ROUTES),
			appCss
		])
	].sort();
}

/**
 * Source with comments removed, so PROSE cannot red the suite.
 *
 * Without this the guard criminalises its own documentation: a CSS comment that merely NAMES
 * `text-primary` to explain why it is banned changes no behaviour and yet fails the build. That makes
 * the rule unwritable next to the code it governs. Stripping comments first is the established convention
 * here — roughly a hundred test files on main already do it, and `tailwind-toolchain` needed this same fix
 * earlier on this very branch. The mutation arm below proves the stripper does not also BLIND the scan,
 * which is the half that is easy to get wrong.
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
		// The pristine registry components are exempt BY PATH: they are vendored verbatim so
		// `--overwrite` stays safe, and `ui/_encore/` is where our own overrides live. A stock
		// component's own `text-primary` on its own `bg-primary` surface is the legal pairing.
		if (f.includes(VENDORED)) continue;
		for (const m of withoutComments(readFileSync(f, 'utf8')).matchAll(bannedRe)) {
			offenders.push(`${f.slice(f.indexOf('src/'))}: ${m[0]}`);
		}
	}
	expect(offenders).toEqual([]);
});

test('a semantic fill is never minted into app source as ink: the legal pairing is not caught by the ban', () => {
	// The mutation that proves the regex is not simply matching everything.
	expect('text-primary-foreground'.match(bannedRe)).toBeNull();
	expect('bg-primary'.match(bannedRe)).toBeNull();
	expect([...'text-primary'.matchAll(bannedRe)].length).toBe(1);
	expect([...'hover:text-destructive'.matchAll(bannedRe)].length).toBe(1);
});

test('a semantic fill is never minted into app source as ink — non-vacuity: the scan reached app source outside the vendored tree', () => {
	// Deduped count. Every entry is a distinct file, so this number means what it says.
	const scanned = files.filter((f) => !f.includes(VENDORED));
	expect(scanned.length).toBeGreaterThanOrEqual(30); // @nvf-floor scanned.length
	expect(new Set(scanned).size).toBe(scanned.length);
	// …and the shared stylesheet is in scope, which is where an `@apply` would most likely land.
	expect(scanned.some((f) => f.endsWith('app.css'))).toBe(true);
});

test('a semantic fill is never minted into app source as ink: a comment naming the ban does not red the suite, but real usage still does', () => {
	// Both directions in one arm: the stripper must remove prose WITHOUT blinding the scan. The
	// second half is what stops this becoming a hole rather than a fix.
	const prose = `<!-- text-primary is banned: 3.10:1 on --card2 -->\n<p class="ink">x</p>`;
	expect([...withoutComments(prose).matchAll(bannedRe)].length).toBe(0);

	const cssProse = `/* never @apply text-destructive here */\n.x { color: var(--ink); }`;
	expect([...withoutComments(cssProse).matchAll(bannedRe)].length).toBe(0);

	const real = `<p class="text-primary">x</p>`;
	expect([...withoutComments(real).matchAll(bannedRe)].length).toBe(1);

	// A banned utility on the same LINE as a trailing comment must still be seen.
	const mixed = `.x { color: red; } // text-primary explained\n.y { @apply text-primary; }`;
	expect([...withoutComments(mixed).matchAll(bannedRe)].length).toBe(1);
});
