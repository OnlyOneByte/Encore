// Guard: the dead drawer surface is GONE, and stays gone.
//
// WHY THIS FILE EXISTS. A deletion has no runtime-observable regression by construction — reverting it
// re-adds code nothing calls, so the per-hunk prover reports UNVERIFIED (and on a whole-file deletion it
// cannot revert the hunk at all). That green-when-reverted result IS the finding: zero non-test callers.
// The honest close is a source scan that encodes the invariant the deletion establishes, so the removal
// is PINNED rather than merely done. Without it, the drawer surface could be reintroduced silently and
// every guard retired alongside it would have been retired for nothing.
//
// WHAT WAS DELETED, and why it was dead: the ratified phone design has no drawer. The home-shell change made the queue
// the home screen (inline rows + now-playing hero + docked band), and after it landed QueueSheet.svelte
// and its vaul port QueueSheetDrawer.svelte rendered in exactly ONE place — the /components
// gallery. No guest could reach either, yet a later fix was still spent on the scroll behaviour of one.
//
// WHAT SURVIVED IS THE CONTRACT, NOT THE SHEET. `--dock-h`, published from routes/+page.svelte by
// `.cta-dock` (home) and `.search-dock` (browse), carries the identical band contract: the token equals
// the band's REAL rendered height, and the safe-area inset lives on the band alone so nothing above it
// adds a second env(). The arms below assert that successor is present, which is what stops this guard
// from passing in a tree where the whole docked-band mechanism was also deleted.

import { test, expect } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { appCore, appSrc, at } from '@encore/test-support';

// Repo-root anchors, replacing `at('apps/core/src')` / `join(SRC, '..')`. They mean the same
// two directories this guard has always walked and sliced against — apps/core/src for the source scan,
// apps/core for the package.json read and the `rel` offender strings.
const SRC = appSrc;
const CORE = appCore;

/**
 * Blank comments so prose that NAMES the retired surface — this file's own header, the retirement
 * records in non-vacuity-floors.test.ts, the history notes left at each deletion site — can neither
 * satisfy nor trip a check. Blanks in place so reported line numbers stay true.
 */
function stripComments(s: string): string {
	return s
		.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:])\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Every PRODUCTION source file under apps/core/src — tests excluded, deliberately.
 *
 * A test file is the one place the retired names SHOULD still appear: phone-home-shell-832.test.ts
 * asserts `--peek-h` is absent from the route, and non-vacuity-floors.test.ts's RETIRED map quotes
 * `.sheet-surface > * min-width: 0` as the subject it retired. Both are the opposite of a violation, so
 * scanning them would make this guard red on its own bookkeeping. A test that imported a deleted
 * component would fail on ENOENT anyway, which is a louder signal than this scan.
 */
function sourceFiles(): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			if (ent.name === 'node_modules' || ent.name === 'build' || ent.name === '.svelte-kit') continue;
			const abs = join(dir, ent.name);
			if (ent.isDirectory()) {
				walk(abs);
				continue;
			}
			if (!/\.(svelte|ts|css)$/.test(ent.name)) continue;
			if (/\.test\.ts$/.test(ent.name)) continue;
			// The `abs === at('tests/guards/design-system/drawer-surface-removed-903.test.ts')` self-exclusion that sat here is gone with the move: this
			// guard now lives under tests/, outside the apps/core/src tree it walks, so it cannot read
			// itself. The `.test.ts` filter above already covered it in any case.
			out.push(abs);
		}
	};
	walk(SRC);
	return out;
}

test('both drawer components are gone from disk', () => {
	expect(existsSync(join(SRC, 'lib/components/QueueSheet.svelte'))).toBe(false);
	expect(existsSync(join(SRC, 'lib/components/QueueSheetDrawer.svelte'))).toBe(false);
	// Not vacuous: a sibling component that MUST still exist, so a wrong SRC root (which would make the
	// two assertions above pass for the wrong reason) reds here instead of passing silently.
	expect(existsSync(join(SRC, 'lib/components/QueueRow.svelte'))).toBe(true);
	expect(existsSync(join(SRC, 'lib/components/NowPlayingHero.svelte'))).toBe(true);
});

test('no live code imports, renders or reads the deleted drawer surface', () => {
	const files = sourceFiles();
	const offenders: string[] = [];
	let scanned = 0;

	for (const abs of files) {
		const code = stripComments(readFileSync(abs, 'utf8'));
		scanned++;
		const rel = abs.slice(CORE.length + 1);

		// An import of, or an element instantiation of, either deleted component.
		for (const name of ['QueueSheet', 'QueueSheetDrawer']) {
			if (new RegExp(`from\\s+['"][^'"]*${name}\\.svelte['"]`).test(code)) {
				offenders.push(`${rel}: imports ${name}.svelte, which was deleted`);
			}
			if (new RegExp(`<${name}[\\s/>]`).test(code)) {
				offenders.push(`${rel}: renders <${name}>, which was deleted`);
			}
		}

		// A read of, or a declaration of, the retired band token. `--dock-h` is its successor.
		if (/var\(\s*--peek-h/.test(code)) offenders.push(`${rel}: reads var(--peek-h); the live token is --dock-h`);
		if (/--peek-h\s*:/.test(code)) offenders.push(`${rel}: declares --peek-h, now retired`);

		// The retired paint tiers and the sheet chrome they dressed.
		for (const tier of ['--z-sheet-scrim', '--z-sheet']) {
			if (new RegExp(`${tier}\\s*:`).test(code)) offenders.push(`${rel}: declares ${tier}, now retired`);
			if (new RegExp(`var\\(\\s*${tier}\\b`).test(code)) offenders.push(`${rel}: reads ${tier}, now retired`);
		}
		for (const cls of ['sheet-scrim', 'sheet-surface']) {
			if (new RegExp(`\\.${cls}\\s*[{,>]`).test(code)) offenders.push(`${rel}: still declares .${cls} chrome`);
		}

		// The vaul dependency the port pulled in.
		if (/from\s+['"]vaul-svelte['"]/.test(code)) offenders.push(`${rel}: imports vaul-svelte, now removed`);
	}

	expect(offenders).toEqual([]);
	// Non-vacuity floor (XR-VER-05): the walk must have READ a real population. An empty walk — a wrong
	// root, a broken extension filter, a test-file exclusion that swallowed everything — reports zero
	// offenders over zero files, which is the exact failure this arm exists to prevent. Measured, not
	// counted by eye: 140 production .svelte/.ts/.css files under apps/core/src today, floored at 100 so
	// ordinary growth and deletion do not touch it but a collapsed walk reds.
	expect(scanned).toBeGreaterThanOrEqual(100); // @nvf-floor scanned
});

test('vaul-svelte stays gone, and bits-ui is present only because something imports it', () => {
	/*
	 * RE-SCOPED BY S3 (XR-VER-07). This asserted all THREE packages stay absent: `vaul-svelte`,
	 * `bits-ui` and `@internationalized/date`. That was right when written — bits-ui was there for
	 * NOTHING, satisfying an import vaul-svelte failed to declare, with zero consumers in src.
	 *
	 * S3 brings it back for a real reason: shadcn's Slider, Checkbox, Tabs and Collapsible are built on
	 * Bits UI, so it is a direct, declared, USED dependency now. That is a different fact about the
	 * world, not a relaxation — so the assertion becomes the two halves that still matter:
	 *   1. `vaul-svelte` stays absent. The drawer is dead and the ratified design has no place for one.
	 *   2. `bits-ui` may be present ONLY while something actually imports it, which is what stops it
	 *      drifting back into the dead weight the deletion removed.
	 */
	const pkg = JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf8')) as {
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};
	const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

	expect(Object.keys(declared)).not.toContain('vaul-svelte');

	if ('bits-ui' in declared) {
		const needle = 'bits-ui';
		const importers = sourceFiles().filter((f) => readFileSync(f, 'utf8').includes(needle));
		expect(importers.length).toBeGreaterThanOrEqual(1);
	}
});

test('the band contract SURVIVED the deletion — --dock-h is still published and measured', () => {
	// This is the arm that stops the file above from being satisfied by deleting everything. The
	// invariant the deletion preserved is the band contract; if the successor mechanism goes too, that is a
	// regression, not a further cleanup.
	const page = stripComments(readFileSync(join(SRC, 'routes/+page.svelte'), 'utf8'));
	expect(page).toMatch(/documentElement\.style\.setProperty\(\s*['"]--dock-h['"]/);
	expect(page).toMatch(/removeProperty\(\s*['"]--dock-h['"]\s*\)/);
	// Since the one-band change there is exactly ONE band — the search dock, docked on home for a joined singer and
	// present in both views (the `+ Add a turn` `.cta-dock` it replaced is gone). It carries the
	// safe-area inset itself.
	for (const cls of ['search-dock']) {
		const rule = page.match(new RegExp(`\\.${cls}\\s*\\{[^}]*\\}`, 's'));
		expect(rule, `.${cls} must still exist as the docked band`).not.toBeNull();
		expect(rule![0]).toMatch(/env\(safe-area-inset-bottom/);
	}
	// The retired band must not linger, or the one-band contract has forked again.
	expect(page).not.toContain('cta-dock');
});
