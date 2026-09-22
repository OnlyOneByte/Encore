// guard: every e2e driver and probe is reachable from a command, or is recorded as not being.
//
// WHY THIS EXISTS. Moving `e2e/` into `tests/e2e/` would otherwise have laundered dead code into
// a tidier address. 19 of the 38 files here are reachable from NOTHING: no npm script, no import, not even
// a basename mentioned by a file that is reachable. Together they are ~12,000 lines carrying 226
// severity-tagged assertions that no command has run.
//
// That is not automatically wrong — a probe kept for manual investigation is a legitimate thing to own. It
// is wrong for it to be INDISTINGUISHABLE from a probe that runs, which is what an unlisted orphan is. So
// the list below is closed: a new orphan fails, and an orphan that becomes reachable fails too, because a
// stale entry would excuse the next one.
//
// REACHABILITY IS BY NAME, NOT ONLY BY IMPORT. These drivers spawn each other as subprocesses by path
// string — `fake-stems-worker` is launched, never imported — so a static import graph reports files as dead
// that are demonstrably alive. The walk below follows a basename mentioned anywhere in a reachable file,
// which is why `fake-stems-worker.mjs` is correctly absent from the list and `fake-align-worker.mjs` is on
// it: its only mention is inside `p9-settings.mjs`, which is itself unreachable.

import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { at, read, relative } from '@encore/test-support';

/**
 * Files no command reaches, each kept deliberately.
 *
 * EMPTY, AND THAT IS THE POINT. It used to hold nineteen drivers — the whole probe tree bar the four
 * flows wired to `e2e*` scripts. They were kept because each is a written investigation of a real
 * defect, and the recorded objection to fixing it was that wiring ~12,000 lines of browser-driving
 * into a gate that finishes in about a minute would be the wrong trade.
 *
 * That objection conflated two different things. `bun run tests/e2e/run-probes.mjs` (the `e2e:probes`
 * script) now names every one of them, so they are REACHABLE — discoverable, listed with their
 * subject, runnable in one step, with the runner booting the shared seeded server the `serves` group
 * used to need by hand. None of them is in `bun run gates`, so the gate is unchanged.
 *
 * The cost of the old list was not theoretical. Everything it held was unexecuted, and unexecuted is
 * where six probes came to resolve their repo root one hop short, two came to call a `spawnChild`
 * defined in no scope, and one came to test for a build directory under a path that could not exist.
 * A list like that does not preserve an investigation; it preserves the appearance of one.
 *
 * An entry here is still the right answer for a driver that genuinely cannot be reached — it just has
 * to come with the reason, because an unrun probe nobody recorded is indistinguishable from one that
 * runs.
 */
const UNRUN: readonly string[] = [];

function e2eFiles(): string[] {
	return execFileSync('git', ['-C', at('.'), 'ls-files', 'tests/e2e'], { encoding: 'utf8' })
		.split('\n')
		.filter((f) => f.endsWith('.mjs') || f.endsWith('.ts'));
}

function stem(rel: string): string {
	return rel.slice(rel.lastIndexOf('/') + 1).replace(/\.(mjs|ts)$/, '');
}

/** Files reachable from a root package.json script, following imports AND spawned basenames. */
function reachable(files: string[]): Set<string> {
	const scripts = Object.values((JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts).join(
		' '
	);
	const seen = new Set<string>();
	const stack = files.filter((f) => scripts.includes(f) || scripts.includes(stem(f)));
	while (stack.length > 0) {
		const cur = stack.pop()!;
		if (seen.has(cur)) continue;
		seen.add(cur);
		let src: string;
		try {
			src = readFileSync(at(cur), 'utf8');
		} catch {
			continue;
		}
		for (const other of files) {
			if (seen.has(other)) continue;
			if (new RegExp(`(?<![\\w-])${stem(other)}(?![\\w-])`).test(src)) stack.push(other);
		}
	}
	return seen;
}

test('every e2e file is reachable from a command, or is on the unrun list', () => {
	const files = e2eFiles();
	// Non-vacuity: the enumeration found the tree. An empty list makes every assertion below trivially
	// true, which is the failure this suite keeps re-learning.
	expect(files.length).toBeGreaterThan(30); // @nvf-floor files.length

	const live = reachable(files);
	// …and the walk actually reached something. A broken roots filter would report every file unrun and
	// the list would then be "complete" for the wrong reason.
	expect(live.size).toBeGreaterThan(10); // @nvf-floor live.size

	const orphans = files.filter((f) => !live.has(f)).sort();
	const listed = [...UNRUN].sort();

	const newOrphans = orphans.filter((f) => !listed.includes(f as (typeof UNRUN)[number]));
	expect(
		newOrphans,
		'an e2e file is reachable from no command and is not on the unrun list. Wire it into a script, or ' +
			'add it to UNRUN with the reason — an unrun probe that nobody recorded is indistinguishable from ' +
			'one that runs, which is exactly what moving this tree would otherwise have hidden.'
	).toEqual([]);

	const revived = listed.filter((f) => !orphans.includes(f));
	expect(
		revived,
		'a file on the unrun list IS now reachable. Delete its entry: a stale exemption is what excuses the ' +
			'next orphan, and the count is the thing this guard exists to keep honest.'
	).toEqual([]);
});

test('reachability follows a spawned basename, not only a static import', () => {
	/*
	 * The load-bearing case, and the reason a naive import graph is wrong here. `fake-stems-worker.mjs` is
	 * launched as a subprocess by name and imported by nobody; if the walk only followed imports it would
	 * be reported dead while being demonstrably alive, and it would land on the unrun list by mistake.
	 */
	const files = e2eFiles();
	const worker = files.find((f) => f.endsWith('fake-stems-worker.mjs'));
	expect(worker, 'the fixture this arm reasons about is gone — re-pick one or delete the arm').toBeDefined();
	expect(reachable(files).has(worker!)).toBe(true);

	// It is genuinely not imported anywhere, so import-following alone could not have found it.
	const importedSomewhere = files.some((f) => /from\s*'[^']*fake-stems-worker/.test(readFileSync(at(f), 'utf8')));
	expect(importedSomewhere).toBe(false);
});

test('the unrun list holds only paths that exist', () => {
	// An entry for a deleted file would sit here forever describing nothing, and would silently absorb a
	// future file that happened to reuse the path.
	const tracked = new Set(e2eFiles());
	const gone = UNRUN.filter((f) => !tracked.has(f));
	expect(gone, 'unrun entries name files that are no longer tracked — delete them').toEqual([]);
	void relative;
});
