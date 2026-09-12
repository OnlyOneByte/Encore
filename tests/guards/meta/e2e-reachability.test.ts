// guard: every e2e driver and probe is reachable from a command, or is recorded as not being — XR-VER-05.
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
 * Files no command reaches, each kept deliberately. Recorded as a flat list rather than per-file comments
 * so the COUNT is visible: nineteen unrun probes is a fact about this suite, and a reader should meet it
 * as one number rather than discovering it nineteen times.
 *
 * WHY THEY ARE KEPT. Every one is a written investigation of a real defect — the tap-to-start recovery,
 * the gapless seam, the playhead-versus-cook interaction — and each is runnable by hand with
 * `bun run <path>`. Deleting them would discard the analysis; wiring them all into a command would add
 * ~12,000 lines of browser-driving to a gate that currently takes 30 seconds. Neither is obviously right,
 * so the decision stays open and visible instead of being made by accident.
 */
const UNRUN = [
	'tests/e2e/fake-align-worker.mjs',
	'tests/e2e/probes/admin-delete-639.mjs',
	'tests/e2e/probes/p1-gapless.mjs',
	'tests/e2e/probes/p10-scaling.mjs',
	'tests/e2e/probes/p14-playhead-vs-cook.mjs',
	'tests/e2e/probes/p15-phone-reflow.mjs',
	'tests/e2e/probes/p15-reload-resume.mjs',
	'tests/e2e/probes/p16-hero-live-controls.mjs',
	'tests/e2e/probes/p2-guiding-track.mjs',
	'tests/e2e/probes/p3-key-shift.mjs',
	'tests/e2e/probes/p5-cook-lifecycle.mjs',
	'tests/e2e/probes/p6-lyrics.mjs',
	'tests/e2e/probes/p8-presence-resilience.mjs',
	'tests/e2e/probes/p9-settings.mjs',
	'tests/e2e/probes/preflight-diff.mjs',
	'tests/e2e/probes/preflight-reset-audit.mjs',
	'tests/e2e/probes/tv-audiocontext-resume.mjs',
	'tests/e2e/probes/tv-scrim-empty-lobby-736.mjs',
	'tests/e2e/shoot-913.mjs'
] as const;

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
	const scripts = Object.values(
		(JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts
	).join(' ');
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
	const importedSomewhere = files.some((f) =>
		/from\s*'[^']*fake-stems-worker/.test(readFileSync(at(f), 'utf8'))
	);
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
