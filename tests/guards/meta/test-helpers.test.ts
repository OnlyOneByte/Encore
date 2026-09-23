/*
 * guard: each scan helper has exactly one definition, because these helpers decide WHAT A GUARD CAN SEE.
 *
 * Four of the five were per-file copies, one a verbatim rename of another. A copy that drifts — a different
 * glob, a missed directory, an extra exclusion — silently narrows one guard's population while it stays
 * green on the smaller surface. Consolidating is a refactor no existing assertion notices, so this source
 * scan is what makes it observable. KNOWN LIMIT: arm 1 is keyed on the five NAMES, so a rival walker under
 * a different name is not caught; three exist today. See docs/GUARDS.md#the-hygiene-and-meta-guards.
 */
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { at } from '@encore/test-support';
import { SKIP_DIRS, classPresent, markupControls, styleFiles, svelteFiles } from '@encore/test-support/scan';

/** The one module allowed to declare these helpers. Consumer paths below are repo-relative. */
const HOME = 'tests/support/src/scan.ts';

/**
 * Where THE walk lives, as distinct from the module that filters it: `scan.ts` names the extension filters,
 * `tree.ts` owns the one `readdirSync` and the one skip-set test that decide scope for every guard.
 */
const WALK_HOME = 'tests/support/src/tree.ts';

/** The five helpers the standard names, and the one module allowed to declare them. */
const HELPERS = ['svelteFiles', 'styleFiles', 'markupControls', 'allSvelte', 'classPresent'];

/**
 * REAL SOURCE, and an explicit list rather than a walk: a file dropping out of scrutiny has to be a visible
 * edit here, since a walk that stopped finding a file would take the check with it. The floor pins its size.
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
 * Blank comments, preserving newlines so reported offsets stay true. Load-bearing: the consumers NAME the
 * helpers they no longer declare, and prose about a helper must neither satisfy nor trip an assertion.
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
	// Non-vacuity: the consumer list is real and on disk. A typo'd path would drop a file from scrutiny.
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
		const imported = new Set<string>();
		for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@encore\/test-support\/scan'/g)) {
			for (const part of m[1]!.split(',')) {
				const name = part
					.trim()
					.split(/\s+as\s+/)[0]!
					.trim();
				if (name) imported.add(name);
			}
		}
		for (const h of HELPERS) {
			// a bare call with no import is a local copy (arm 1) or an unresolved reference the typecheck gate catches.
			if (new RegExp(`\\b${h}\\s*\\(`).test(src) && !imported.has(h)) {
				offenders.push(`${rel}: calls \`${h}\` without importing it from ${HOME}`);
			}
		}
	}
	expect(offenders).toEqual([]);
});

test('the shared walk excludes built and vendored trees, and allowlists no directory', () => {
	// Asserted on the exported set rather than the source text, so it pins the value the walk consults.
	for (const d of ['node_modules', 'build', '.svelte-kit', 'dist', '.git']) {
		expect(SKIP_DIRS.has(d)).toBe(true);
	}

	// `src/lib/components/ui/` — the design-library copy-in target — must be in scope BY CONSTRUCTION, and
	// cannot be asserted by walking for it because it does not exist yet. What is assertable: exactly one
	// `readdirSync` in the module that owns the walk, and no directory-name test other than the skip set.
	const walkHome = stripComments(readFileSync(at(WALK_HOME), 'utf8'));
	expect([...walkHome.matchAll(/readdirSync\(/g)]).toHaveLength(1);
	const dirTests = [...walkHome.matchAll(/(\w+)\.(?:has|includes)\(\w+\.name\)/g)].map((m) => m[1]);
	expect(dirTests).toEqual(['SKIP_DIRS']);

	// …and the filter module must not have grown a second walk of its own.
	const home = stripComments(readFileSync(at(HOME), 'utf8'));
	expect([...home.matchAll(/readdirSync\(/g)]).toHaveLength(0);
});

test('the shared walk actually skips a directory in the exclusion set', () => {
	// Behavioural arm, so the assertions above cannot pass over a SKIP_DIRS the walk never reads. node_modules
	// holds .svelte and .css files, so a walk ignoring SKIP_DIRS returns far more than the source tree.
	const src = svelteFiles(at('src'));
	const fromCore = svelteFiles(at('.'));
	expect(src.length).toBeGreaterThanOrEqual(20);
	expect(fromCore.some((f) => f.includes(`${join('', 'node_modules', '')}`))).toBe(false);
	expect(styleFiles(at('.')).some((f) => f.includes(`${join('', 'node_modules', '')}`))).toBe(false);
	// …and the walk is otherwise unfiltered: `styleFiles` is `svelteFiles` widened to `.css`, never narrowed,
	// so it is a strict superset. A drift that narrowed either reds here.
	const style = new Set(styleFiles(at('src')));
	expect(src.every((f) => style.has(f))).toBe(true);
	expect(style.size).toBeGreaterThan(src.length);
});

test('the shared markupControls and classPresent are the ones the guards behaved with', () => {
	// The two helpers that are not scan walks. Pin their behaviour at the shared home so the move is not a
	// silent semantic change and a later edit cannot quietly weaken every consumer at once.
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
