/*
 * guard: each scan helper has exactly one definition (XR-VER-14).
 *
 * ── WHAT THIS IS FOR ───────────────────────────────────────────────────────────────────────────────
 *
 * The helpers in ./test-helpers.ts decide WHAT A GUARD CAN SEE. Four of the five were per-file copies
 * before this landed: `styleFiles` in components/motion.test.ts, `markupControls` in
 * touch-targets.test.ts, and `allSvelte` + `classPresent` in e2e/contract.test.ts. `allSvelte` was a
 * VERBATIM copy of `svelteFiles` under a different name.
 *
 * A copy that drifts — a different glob, a missed directory, an extra exclusion — silently narrows one
 * guard's population while every other copy keeps its own answer. The guard keeps passing, on a
 * smaller surface, and nothing says so. That is not hypothetical here: `motion.test.ts` needed its
 * scope widened in isolation precisely because its `styleFiles` was private, and no other
 * guard's scope moved with it.
 *
 * Consolidating is a REFACTOR, so `bun test` cannot tell whether it happened: reverting any one file
 * back to its local copy leaves every existing assertion green. This file is what makes the
 * consolidation observable, in the shape §3 of the coding brief prescribes for a change with no
 * runtime signature — a source scan over the real production files.
 *
 * Two arms, and they fail on different regressions:
 *   1. NO LOCAL DECLARATION of a helper name outside its single home.
 *   2. THE SHARED WALK CARRIES ITS EXCLUSION SET, and carries no directory allowlist that a new
 *      source directory could fall outside of.
 *
 * KNOWN LIMIT, stated so nobody reads more into a green run than it means. Arm 1 is keyed on the five
 * NAMES, so a rival walker reintroduced under a DIFFERENT name is not caught. Three consumers carry
 * exactly such a walker today — `tsSources` (components/motion.test.ts), `tsFiles`
 * (ui/icons.test.ts), `allDrivers` (e2e/contract.test.ts) — and this file is green with all three
 * present. Banning any second recursive directory walk in a consumer is the arm that would close it,
 * and it cannot land until those three are consolidated or carried on an annotated baseline; that is
 * reported as its own issue rather than fixed here.
 */
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { at } from '@encore/test-support';
import { SKIP_DIRS, classPresent, markupControls, styleFiles, svelteFiles } from '$lib/test-helpers';

/*
 * REPO-ROOT anchored, and the consumer list is repo-relative.
 *
 * This was `CORE = join(import.meta.dir, '..', '..')` — apps/core — with each consumer named relative to
 * it. The reorganisation moved nine of the ten consumers into `tests/guards/**`, i.e. clean out of the
 * tree this file could address at all, so the list had to become repo-relative rather than merely be
 * re-pointed. Every entry is asserted to exist below, which is what turns a stale path into a red rather
 * than into a quietly shorter list.
 */
const HOME = 'apps/core/src/lib/test-helpers.ts';

/** The five helpers XR-VER-14 names, and the one module allowed to declare them. */
const HELPERS = ['svelteFiles', 'styleFiles', 'markupControls', 'allSvelte', 'classPresent'];

/**
 * Every file that consumed one of these helpers, read as REAL SOURCE (not a fixture). Kept as an
 * explicit list rather than a walk so that a file dropping out of it is a visible edit here: the
 * point of this guard is that a copy cannot come back unnoticed, and a walk that stopped finding a
 * file would take the check with it. The floor below pins the list's own size.
 */
const CONSUMERS = [
	'tests/guards/motion/motion.test.ts',
	'tests/guards/a11y/touch-targets.test.ts',
	'tests/guards/a11y/contrast.test.ts',
	'tests/guards/design-system/design-system.test.ts',
	'tests/guards/hygiene/icon-centring.test.ts',
	'tests/guards/hygiene/settings-scopes.test.ts',
	'tests/guards/design-system/singer-color.test.ts',
	'tests/guards/layout/stage-scale.test.ts',
	'tests/guards/hygiene/icons.test.ts',
	'tests/guards/hygiene/contract.test.ts'
];

/**
 * Blank comments, preserving newlines so reported offsets stay true. Load-bearing here: the consumers
 * NAME the helpers they no longer declare (`// … was a verbatim copy of svelteFiles`), and prose about
 * a helper must neither satisfy nor trip an assertion about the code.
 */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src
		.replace(/\/\*[\s\S]*?\*\//g, blank)
		.replace(/(^|[^:'"\\`])\/\/[^\n]*/g, (m, p1: string) => p1 + blank(m.slice(p1.length)));
}

/** Every local declaration form a helper could come back as: `function f`, `const f = …`, `let f = …`. */
function declares(src: string, name: string): boolean {
	return (
		new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`).test(src) ||
		new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\b`).test(src)
	);
}

test('no guard declares its own copy of a scan helper', () => {
	// Non-vacuity: the consumer list is real and every file in it is on disk. A typo'd path would
	// otherwise remove a file from scrutiny while this test stayed green.
	expect(CONSUMERS.length).toBeGreaterThanOrEqual(10);

	const offenders: string[] = [];
	for (const rel of CONSUMERS) {
		const src = stripComments(readFileSync(at(rel), 'utf8'));
		for (const h of HELPERS) {
			if (declares(src, h)) offenders.push(`${rel}: declares its own \`${h}\` instead of importing it from ${HOME}`);
		}
	}
	expect(offenders).toEqual([]);
});

test('every consumer that uses a scan helper imports it from the one home', () => {
	const offenders: string[] = [];
	for (const rel of CONSUMERS) {
		const src = stripComments(readFileSync(at(rel), 'utf8'));
		// the specifier differs by depth (./test-helpers, ../test-helpers, ../src/lib/test-helpers)
		const imported = new Set<string>();
		for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']*test-helpers'/g)) {
			for (const part of m[1]!.split(',')) {
				const name = part
					.trim()
					.split(/\s+as\s+/)[0]!
					.trim();
				if (name) imported.add(name);
			}
		}
		for (const h of HELPERS) {
			// a bare call `h(` in code (comments already blanked) with no import of `h` is either a
			// local copy — arm 1 catches that — or an unresolved reference the typecheck gate catches.
			if (new RegExp(`\\b${h}\\s*\\(`).test(src) && !imported.has(h)) {
				offenders.push(`${rel}: calls \`${h}\` without importing it from ${HOME}`);
			}
		}
	}
	expect(offenders).toEqual([]);
});

test('the shared walk excludes built and vendored trees, and allowlists no directory', () => {
	// XR-VER-14 Acceptance, first half, asserted on the exported set rather than on the source text so
	// it pins the value the walk actually consults.
	for (const d of ['node_modules', 'build', '.svelte-kit', 'dist', '.git']) {
		expect(SKIP_DIRS.has(d)).toBe(true);
	}

	// XR-VER-14 Acceptance, second half: `src/lib/components/ui/` — the design-library copy-in target —
	// must be in scope BY CONSTRUCTION. It does not exist yet, so it cannot be asserted by walking for
	// it; what is assertable is that the walk descends into every directory it is not told to skip.
	// The source check is the honest instrument for that: exactly one `readdirSync` in the module, and
	// no membership test on a directory name other than the skip set.
	const home = stripComments(readFileSync(at(HOME), 'utf8'));
	expect([...home.matchAll(/readdirSync\(/g)]).toHaveLength(1);
	const dirTests = [...home.matchAll(/(\w+)\.(?:has|includes)\(ent\.name\)/g)].map((m) => m[1]);
	expect(dirTests).toEqual(['SKIP_DIRS']);
});

test('the shared walk actually skips a directory in the exclusion set', () => {
	// Behavioural arm, so the assertions above cannot pass over a SKIP_DIRS the walk never reads.
	// apps/core/node_modules holds .svelte and .css files from installed packages, so a walk that
	// ignored SKIP_DIRS would return far more than the source tree does — and would report on
	// vendored CSS the app never paints.
	const src = svelteFiles(at('apps/core/src'));
	const fromCore = svelteFiles(at('apps/core'));
	expect(src.length).toBeGreaterThanOrEqual(20);
	expect(fromCore.some((f) => f.includes(`${join('', 'node_modules', '')}`))).toBe(false);
	expect(styleFiles(at('apps/core')).some((f) => f.includes(`${join('', 'node_modules', '')}`))).toBe(
		false
	);
	// …and the walk is otherwise unfiltered: `styleFiles` is `svelteFiles` widened to `.css`, never
	// narrowed, so it is a strict superset. A drift that narrowed either reds here.
	const style = new Set(styleFiles(at('apps/core/src')));
	expect(src.every((f) => style.has(f))).toBe(true);
	expect(style.size).toBeGreaterThan(src.length);
});

test('the shared markupControls and classPresent are the ones the guards behaved with', () => {
	// The two helpers that are NOT scan walks moved here as code organisation (XR-VER-14 names them;
	// a drifted glob is not their failure mode — they take a source string). Pin their behaviour at the
	// new home so the move is not a silent semantic change, and so a later edit to the shared copy
	// cannot quietly weaken every consumer at once.
	const ctrl = markupControls(
		'<button class="gear big" onclick={x}>x</button><a href="/x" class="back">y</a><div class="plain">z</div>'
	);
	expect(ctrl.tags.has('button')).toBe(true);
	expect(ctrl.tags.has('a')).toBe(true);
	expect([...ctrl.classes].sort()).toEqual(['back', 'big', 'gear']);
	// a non-interactive element contributes nothing
	expect(ctrl.classes.has('plain')).toBe(false);

	// exact-token semantics: a hyphen fragment and an interpolated identifier are NOT classes
	expect(classPresent('<div class="badqr-b"></div>', 'b')).toBe(false);
	expect(classPresent('<div class="badqr-b"></div>', 'badqr-b')).toBe(true);
	expect(classPresent('<div class="pill {row.outcome}"></div>', 'row')).toBe(false);
	expect(classPresent('<div class="pill {row.outcome}"></div>', 'pill')).toBe(true);
	// the directive and <style> arms
	expect(classPresent('<div class:active></div>', 'active')).toBe(true);
	expect(classPresent('<style>.chip { color: red }</style>', 'chip')).toBe(true);
});
