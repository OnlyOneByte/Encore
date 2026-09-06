// guard: a task/ticket number must never live in source, a comment, a test, or fixture data.
//
// THE RULE. Task IDs belong in a PR, a commit message, or docs/ — the places a reader who is chasing
// the history goes looking. In a comment they are noise: six months on, nobody has the backlog in
// their head, and `shipped in M6-C1` says strictly less than the behavioural sentence it replaced.
// The convention is `T-<n>`; two retired families (`B-<n>`, `M<n>-C<n>`) predate it and are what this
// sweep removed.
//
// WHY THE HYPHEN IS LOAD-BEARING. A bare-number scheme cannot be guarded: `T1` (and `T0`) already
// occur ~320 times as timestamp constants in play-log.test.ts, so `\bT[0-9]+\b` would fire on data
// that has nothing to do with a ticket. The hyphenated form `T-<n>` occurs zero times outside an
// intended reference, so the hyphen is the thing that makes this decidable — the guard keys on it.
//
// WHY A SOURCE SCAN, AND WHY IT READS COMMENTS. The defect is a property of the source text, so it is
// decidable without running anything. Unlike the emoji guard (icons.test.ts), this scan deliberately
// does NOT strip comments first: a task ref in a comment is the exact thing being banned, so blanking
// comments would blind the guard to its whole purpose. This file is the sole exception — it carries
// the patterns as regex literals and prose, so it excludes itself by path.
//
// WHY IT ALSO SCANS docs/ AND CONFIG. The retired families lived mostly in docs (a ROADMAP and an
// archive, both since deleted) and in the worker's Dockerfile / requirements.txt / .env.example — not
// in .ts source. Task tracking is GitHub issues now, so the scan covers .md, .txt, .yml and those
// config basenames as well, and a re-added ticket code in any of them reds this guard.
import { test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';

// import.meta.dir === apps/core/src/lib. Two roots up is apps/core; four up is the repo root, which is
// how the worker (Python) source is reached — CWD-independent, since `bun test` runs from apps/core.
// import.meta.dir === apps/core/src/lib; four levels up is the repo root.
const REPO = join(import.meta.dir, '..', '..', '..', '..');

// The three retired/current task-id families. `T-<n>` is the live convention and must stay absent from
// source; `B-<n>` and `M<n>-C<n>` are the retired schemes this sweep cleared. `\b` on both ends is
// what keeps `T-<n>` from firing inside, say, a hyphenated identifier, and what makes the bare-number
// timestamp constants (`T1`) unreachable.
const PATTERNS: { re: RegExp; family: string }[] = [
	{ re: /\bT-[0-9]+\b/, family: 'T-<n>' },
	{ re: /\bB-[0-9]+\b/, family: 'B-<n> (retired)' },
	{ re: /\bM[0-9]+-C[0-9]+\b/, family: 'M<n>-C<n> (retired)' }
];

const SCANNED_EXT = ['.ts', '.svelte', '.py', '.js', '.mjs', '.md', '.txt', '.yml', '.yaml'];
// Extensionless / dotfile config that carried retired task tokens (M<n>-C<n>, B-<n>) and must stay clean.
const SCANNED_NAMES = new Set(['Dockerfile', '.env.example', '.npmrc']);

// This guard is the one file that must contain the patterns (as literals + prose), so it excludes
// itself. Nothing else is exempt: source, comments, tests and fixtures are all in scope.
const SELF = join(import.meta.dir, 'task-number-hygiene.test.ts');

// The scanned set is the GIT-TRACKED files only. `git ls-files` lists exactly what is under version
// control, so an untracked / .gitignore'd path (the repo-root agent-state tree of operational
// markdown, and anything similar added later) is never in scope — the guard polices the repo, not the
// working directory. This also removes the need to hand-maintain a SKIP_DIRS prune list: generated and
// vendored trees (node_modules, build, .svelte-kit, dist, media, __pycache__) are all untracked.
function trackedScannedFiles(): string[] {
	const listed = execFileSync('git', ['-C', REPO, 'ls-files', '-z'], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	});
	const rels = listed.split('\0').filter((r) => r.length > 0);
	return rels
		.filter((rel) => SCANNED_EXT.some((e) => rel.endsWith(e)) || SCANNED_NAMES.has(basename(rel)))
		.map((rel) => join(REPO, rel));
}

/**
 * Every scanned TRACKED file in the repo — source, comments, tests and fixtures alike, across the TS
 * core, the shared packages, and the Python worker (its src AND its tests). Driving off `git ls-files`
 * (rather than a raw filesystem walk) is what keeps the coverage matching this guard's name AND its
 * scope: a task ref that lands in `packages/` or `apps/worker/tests/` is the same defect and must not
 * hide, but a ref inside an untracked / git-ignored operational tree is not a repo defect and must not
 * red this guard.
 */
function scannedFiles(): string[] {
	return trackedScannedFiles().filter((f) => f !== SELF);
}

test('no task/ticket number appears in source, comments, tests or fixtures', () => {
	const offenders: string[] = [];
	const files = scannedFiles();
	// Non-vacuity floor (issue #453): the walk was unanchored — if `git ls-files` returned nothing
	// (guard run outside the git tree, or the ext/name filter matched none), the scan iterated zero
	// files and passed while guarding nothing. Pin a floor well below the true count (hundreds).
	expect(files.length).toBeGreaterThan(50);
	for (const file of files) {
		const lines = readFileSync(file, 'utf8').split('\n');
		lines.forEach((line, i) => {
			for (const { re, family } of PATTERNS) {
				const m = line.match(re);
				if (m) {
					const rel = file.replace(REPO + '/', '');
					offenders.push(
						`${rel}:${i + 1}: "${m[0]}" (${family}) — task numbers live in the PR/commit/docs, ` +
							`not here; state the reason instead`
					);
				}
			}
		});
	}
	expect(offenders).toEqual([]);
});

// guard: the paths retired in the repo-cleanup sweep stay retired.
//
// The cleanup deleted the docs ROADMAP (open work is GitHub issues now), the whole docs/archive tree
// and docs/specs/ (old specs folded into ARCHITECTURE / DECISIONS), and two dead screenshot trees.
// A pure deletion cannot be pinned by a behavioural test — the suite stays green whether the file is
// there or not — so this existence check is the only thing that reds when one is re-added by a stray
// `git mv`, a revert, or a rebase resurrecting it. Each entry is a real regression, not a style nit:
// re-adding ROADMAP.md reinstates a second what-to-build-next authority beside the issue tracker, and
// re-adding an archive spec resurrects a doc whose citations were all repointed to ARCHITECTURE.
test('the paths retired by the repo-cleanup stay absent from the tree', () => {
	const RETIRED = [
		'docs/ROADMAP.md',
		'docs/archive',
		'docs/specs',
		'docs/shots',
		'temp-screenshots/per-song-word-clamp'
	];
	const present = RETIRED.filter((rel) => existsSync(join(REPO, rel)));
	expect(present).toEqual([]);
});
