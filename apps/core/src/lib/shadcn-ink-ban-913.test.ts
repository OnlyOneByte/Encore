/*
 * THE INK BAN, MOVED FROM EXISTENCE TO USE (#913 restructure, XR-COL-14 successor).
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
 * accent-as-ink leaving scope as a UNIVERSAL fact and becoming per-stop across #840's 48 stops.
 */
import { describe, expect, test } from 'bun:test';
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
	return [...svelteFiles(LIB), ...svelteFiles(ROUTES), ...styleFiles(LIB)];
}

describe('#913 a semantic fill is never minted into app source as ink', () => {
	const files = sources();

	test('no app file uses a banned ink utility', () => {
		const offenders: string[] = [];
		for (const f of files) {
			// The pristine registry components are exempt BY PATH: they are vendored verbatim so
			// `--overwrite` stays safe, and `ui/_encore/` is where our own overrides live. A stock
			// component's own `text-primary` on its own `bg-primary` surface is the legal pairing.
			if (f.includes(VENDORED)) continue;
			for (const m of readFileSync(f, 'utf8').matchAll(bannedRe)) {
				offenders.push(`${f.slice(f.indexOf('src/'))}: ${m[0]}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test('the legal pairing is not caught by the ban', () => {
		// The mutation that proves the regex is not simply matching everything.
		expect('text-primary-foreground'.match(bannedRe)).toBeNull();
		expect('bg-primary'.match(bannedRe)).toBeNull();
		expect([...'text-primary'.matchAll(bannedRe)].length).toBe(1);
		expect([...'hover:text-destructive'.matchAll(bannedRe)].length).toBe(1);
	});

	test('non-vacuity: the scan reached app source outside the vendored tree', () => {
		expect(files.filter((f) => !f.includes(VENDORED)).length).toBeGreaterThanOrEqual(20);
	});
});
