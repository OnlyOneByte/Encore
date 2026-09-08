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
// config basenames as well, and a re-added ticket code in any of them reds this guard. THE RULE's
// "or docs/" is honoured by exactly one documented carve-out — see EXEMPT_PREFIXES below, which is
// docs/loop/ and nothing else, and which has its own non-vacuity sentinel at the bottom of this file.
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
// itself.
const SELF = join(import.meta.dir, 'task-number-hygiene.test.ts');

// THE ONE PATH EXEMPTION, and the reason lives here — the shape page-header.test.ts:24-27 uses, so
// adding a second entry is a conscious act a reviewer sees rather than a drive-by widening.
//
// This resolves a contradiction inside this very file: THE RULE above says task IDs belong "in a PR, a
// commit message, or docs/" — one of the places a reader chasing the history goes looking — and then
// the scan banned them in docs/ anyway. docs/loop/ is where that bites. Those briefs quote the retired
// LOOP.md / FLEET.md texts VERBATIM in order to reconcile them, and you cannot record "the scope fence
// on the four large tickets is described three contradictory ways" without naming the tickets. A
// reconciliation that paraphrases its sources can no longer be checked against them, which is the
// artifact's whole value.
//
// Exempt by DIRECTORY, not by file list. docs/loop/ churns: today's two hits are COMMON.md and
// PR-BOT.md, while the DRIFT.md that issue #764 was filed against has already been deleted — so a file
// list is a treadmill that reds main again on the next brief that cites a ticket. Everything else stays
// scanned, the REST of docs/ included, which is the coverage the retired B-<n> / M<n>-C<n> families
// (they lived mostly in docs) exist for. The trailing slash is load-bearing: a bare `docs/loop` prefix
// would also swallow a sibling such as docs/loopback.md.
const EXEMPT_PREFIXES: Record<string, string> = {
	'docs/loop/':
		'pipeline steering — quotes the retired briefs verbatim, so the task ids ARE the artifact being reconciled'
};

/** Is this repo-relative path under a documented exemption? */
function isExempt(rel: string): boolean {
	return Object.keys(EXEMPT_PREFIXES).some((prefix) => rel.startsWith(prefix));
}

// The scanned set is the GIT-TRACKED files only. `git ls-files` lists exactly what is under version
// control, so an untracked / .gitignore'd path (the repo-root agent-state tree of operational
// markdown, and anything similar added later) is never in scope — the guard polices the repo, not the
// working directory. This also removes the need to hand-maintain a SKIP_DIRS prune list: generated and
// vendored trees (node_modules, build, .svelte-kit, dist, media, __pycache__) are all untracked.
// Paths stay REPO-RELATIVE throughout, because that is the form both the exemption and the offender
// message are written in.
function trackedScannedFiles(): string[] {
	const listed = execFileSync('git', ['-C', REPO, 'ls-files', '-z'], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	});
	const rels = listed.split('\0').filter((r) => r.length > 0);
	return rels.filter((rel) => SCANNED_EXT.some((e) => rel.endsWith(e)) || SCANNED_NAMES.has(basename(rel)));
}

/**
 * Every scanned TRACKED file in the repo — source, comments, tests and fixtures alike, across the TS
 * core, the shared packages, and the Python worker (its src AND its tests) — minus this guard itself
 * and the documented EXEMPT_PREFIXES. Driving off `git ls-files` (rather than a raw filesystem walk) is
 * what keeps the coverage matching this guard's name AND its scope: a task ref that lands in
 * `packages/` or `apps/worker/tests/` is the same defect and must not hide, but a ref inside an
 * untracked / git-ignored operational tree is not a repo defect and must not red this guard.
 */
function scannedFiles(): string[] {
	return trackedScannedFiles().filter((rel) => join(REPO, rel) !== SELF && !isExempt(rel));
}

/**
 * The offenders in one file's text, in the form the guard reports them. Pure — it takes the text rather
 * than reading it — which is what lets the non-vacuity sentinel below plant a token in a scanned path
 * without writing anything into the tree.
 */
function offendersIn(rel: string, text: string): string[] {
	const found: string[] = [];
	text.split('\n').forEach((line, i) => {
		for (const { re, family } of PATTERNS) {
			const m = line.match(re);
			if (m) {
				found.push(
					`${rel}:${i + 1}: "${m[0]}" (${family}) — task numbers live in the PR/commit/docs, ` +
						`not here; state the reason instead`
				);
			}
		}
	});
	return found;
}

test('no task/ticket number appears in source, comments, tests or fixtures', () => {
	const offenders: string[] = [];
	const files = scannedFiles();
	// Non-vacuity floor (issue #453): the walk was unanchored — if `git ls-files` returned nothing
	// (guard run outside the git tree, or the ext/name filter matched none), the scan iterated zero
	// files and passed while guarding nothing. Pin a floor well below the true count (hundreds).
	expect(files.length).toBeGreaterThan(50);
	for (const rel of files) {
		offenders.push(...offendersIn(rel, readFileSync(join(REPO, rel), 'utf8')));
	}
	expect(offenders).toEqual([]);
});

// NON-VACUITY SENTINEL for the exemption above (issue #764). An exemption that quietly stops the guard
// biting anywhere is strictly worse than the red it silenced, so pin the three properties it must keep.
// Without this, `EXEMPT_PREFIXES` could be widened to `''` — or the patterns hollowed out — and the
// guard above would still report a serene green.
test('the docs/loop/ exemption stays narrow and the guard still bites everywhere else', () => {
	// 1. The patterns still fire. A planted token in a scanned, non-exempt path is still an offender,
	//    and all three families still match — so the exemption did not arrive with a quiet regex
	//    narrowing or with `.md` dropped from SCANNED_EXT.
	const planted = offendersIn('apps/core/src/lib/planted.ts', 'const n = 1; // shipped in T-1\n');
	expect(planted).toHaveLength(1);
	expect(planted[0]).toContain('apps/core/src/lib/planted.ts:1');
	expect(planted[0]).toContain('"T-1"');
	expect(offendersIn('docs/ARCHITECTURE.md', 'closed by B-8')).toHaveLength(1);
	expect(offendersIn('apps/worker/Dockerfile', '# M6-C1')).toHaveLength(1);

	// 2. The exemption covers docs/loop/ and nothing adjacent. `docs/loopback.md` is the trailing-slash
	//    trap: a bare `docs/loop` prefix would swallow it.
	expect(isExempt('docs/loop/COMMON.md')).toBe(true);
	expect(isExempt('docs/loop/PR-BOT.md')).toBe(true);
	for (const rel of [
		'docs/ARCHITECTURE.md',
		'docs/loopback.md',
		'docs/loop.md',
		'README.md',
		'apps/core/src/lib/x.ts',
		'apps/worker/Dockerfile'
	]) {
		expect(isExempt(rel)).toBe(false);
	}

	// 3. The walk did not collapse to (or around) the exempt set: hundreds of files are still scanned,
	//    the rest of docs/ among them, and no docs/loop/ path survives the filter.
	const files = scannedFiles();
	expect(files.length).toBeGreaterThan(50);
	expect(files.some((rel) => rel.startsWith('docs/') && !rel.startsWith('docs/loop/'))).toBe(true);
	expect(files.filter((rel) => rel.startsWith('docs/loop/'))).toEqual([]);
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
