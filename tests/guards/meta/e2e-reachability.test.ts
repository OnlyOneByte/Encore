// guard: every e2e driver and probe is reachable from a command, or is recorded as not being.
//
// 19 of 38 files here once reached from NOTHING — ~12,000 lines carrying 226 severity-tagged assertions no
// command ran, which is where six probes came to resolve their repo root one hop short and two to call a
// function defined in no scope. Reachability is BY NAME, not only by import: these drivers spawn each other
// as subprocesses by path string, so a static import graph reports live files as dead. The UNRUN list is
// closed both ways — a new orphan reds, and so does a listed file that became reachable.

import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { at, read, relative } from '@encore/test-support';

/**
 * Files no command reaches, each kept deliberately AND with its reason. Empty today:
 * `bun run tests/e2e/run-probes.mjs` (`e2e:probes`) names every probe, so each is discoverable and runnable
 * in one step, and none of them is in `bun run gates`.
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
	// Non-vacuity: the enumeration found the tree. An empty list makes every assertion below trivially true.
	expect(files.length).toBeGreaterThan(30); // @nvf-floor files.length

	const live = reachable(files);
	// …and the walk reached something: a broken roots filter would report every file unrun, and the list would
	// then be "complete" for the wrong reason.
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
	// The load-bearing case: `fake-stems-worker.mjs` is launched as a subprocess by name and imported by
	// nobody, so an import-only walk would report it dead and land it on the unrun list by mistake.
	const files = e2eFiles();
	const worker = files.find((f) => f.endsWith('fake-stems-worker.mjs'));
	expect(worker, 'the fixture this arm reasons about is gone — re-pick one or delete the arm').toBeDefined();
	expect(reachable(files).has(worker!)).toBe(true);

	// It is genuinely not imported anywhere, so import-following alone could not have found it.
	const importedSomewhere = files.some((f) => /from\s*'[^']*fake-stems-worker/.test(readFileSync(at(f), 'utf8')));
	expect(importedSomewhere).toBe(false);
});

test('the unrun list holds only paths that exist', () => {
	// An entry for a deleted file would sit here describing nothing, and would absorb a future file that
	// happened to reuse the path.
	const tracked = new Set(e2eFiles());
	const gone = UNRUN.filter((f) => !tracked.has(f));
	expect(gone, 'unrun entries name files that are no longer tracked — delete them').toEqual([]);
	void relative;
});
