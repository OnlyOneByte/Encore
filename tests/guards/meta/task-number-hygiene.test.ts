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
import { repoRoot, at } from '@encore/test-support';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';

// import.meta.dir === apps/core/src/lib. Two roots up is apps/core; four up is the repo root, which is
// how the worker (Python) source is reached — CWD-independent, since `bun test` runs from apps/core.
// import.meta.dir === apps/core/src/lib; four levels up is the repo root.
// Repo-root anchored; `git ls-files` is run with -C REPO, so this must be the real root.
const REPO = repoRoot;

// The task-id families, plus GitHub issue refs in test prose.
//
// `T-<n>` is the live convention and must stay absent from source; `B-<n>` and `M<n>-C<n>` are the
// retired schemes this sweep cleared. `\b` on both ends is what keeps `T-<n>` from firing inside, say, a
// hyphenated identifier, and what makes the bare-number timestamp constants (`T1`) unreachable.
//
// `#<n>` NOW APPLIES REPO-WIDE. It began scoped to `*.test.ts`, and that scope was recorded here as a
// finding rather than a convenience: THE RULE above says task ids belong in a PR, a commit message, or
// docs, so an issue number in a test name was noise by that reasoning — but production source and docs
// carried ~1,800 and ~235 more, and banning those was a separate decision with a separate cost.
//
// That decision has since been made: the references are gone from source, docs, migrations and config too,
// so the scope is lifted and the guard now covers every tracked file. The measured totals at the time were
// 2,198 references across 343 files; 957 came out mechanically and the remainder by hand, because most of
// what was left sat in SUBJECT position where deleting the number leaves a sentence without one.
//
// THE DIGIT RANGE WAS ALSO WRONG. It matched `#[0-9]{3,4}`, so two-digit references were invisible to it —
// `#88` and `#64` sat in banned files while this guard passed. It is now `{1,4}`, which brings in the
// 1- and 2-digit references and, with them, two conventions that are NOT GitHub issues and must survive:
//
//   * `Finding #4` — a numbered REVIEW finding. A different scheme, never ruled on, and stripping it would
//     destroy a reference a reader can actually resolve (the findings are listed in the review).
//   * ordinals — `socket 0`, `sample #0`, `frame #1`. Not references at all: they count things. There are
//     8 in the tree, and a ban that ate them would rewrite `socket 0 drops` into nonsense.
//
// Both are excluded by pattern rather than by an exemption list, because they are shapes rather than sites:
// a new `Finding #7` or `slot #3` should be allowed without anyone editing this file.
//
// DISCRIMINATING AN ISSUE FROM A COLOUR. There is no syntactic difference between the issue `#913` and
// the three-digit hex colour `#913`, so the only signal is the CLOSING quote: a colour is written as a
// string literal (`'#000'`), while an issue reference in prose is followed by space or punctuation.
// A six-digit colour matters too — `#7254e6` opens with four digits — which is what the trailing
// `[0-9a-fA-F]` exclusion covers.
//
// An earlier version excluded a quote on EITHER side, which looked symmetrical and was wrong — it made
// the pattern blind to exactly the case this ban exists for, a test name opening `test('…`, where
// the quote sits immediately before the `#`. Only the trailing quote may be excluded. The mutation arm
// at the bottom of this file pins both halves so that cannot regress.
const ORDINAL_NOUNS = 'socket|sample|slot|step|entry|row|frame|attempt|worker|stop|revision|track|stem|tier|pass';
const PATTERNS: { re: RegExp; family: string; only?: (rel: string) => boolean }[] = [
	{ re: /\bT-[0-9]+\b/, family: 'T-<n>' },
	{ re: /\bB-[0-9]+\b/, family: 'B-<n> (retired)' },
	{ re: /\bM[0-9]+-C[0-9]+\b/, family: 'M<n>-C<n> (retired)' },
	{
		re: new RegExp(
			// not preceded by a hex digit, a `#`, `Finding `, or an ordinal noun…
			`(?<![0-9a-fA-F#])(?<!\\bFinding )(?<!\\bFinding #[0-9]{1,4}/)(?<!\\b(?:${ORDINAL_NOUNS}) )` +
				// …one to four decimal digits…
				// A LEADING ZERO makes it a colour, not an issue. Issue numbers start at 1 and never carry one,
				// while `#000` in prose (`both are >4.5:1 vs #000 by construction`) is a three-digit hex value
				// written unquoted — which the trailing-quote exclusion below cannot see. This is the
				// discriminator that covers the unquoted case.
				`#(?!0)[0-9]{1,4}` +
				// …and not closing a quoted parenthetical VALUE. `"Lady Gaga — Telephone (243s, #1)"` is
				// production data — the lyrics registry's own same-title disambiguator — and the trailing
				// character there is `)`, not a quote, so the exclusion below does not reach it. A reference
				// in prose is never followed by `)` immediately before a string ends.
				`(?!\\)['"])` +
				// …not followed by a hex digit or a closing quote (either would make it a colour).
				`(?![0-9a-fA-F'"])`
		),
		family: 'GitHub issue #<n>'
	}
];

/**
 * Lines where an issue number is the SUBJECT of an assertion, not prose about one.
 *
 * Nine assertions read a source file or a doc and require a specific issue reference to still be present
 * in it — so they enforce the convention in the OPPOSITE direction from the ban above. Stripping these
 * would not tidy the test, it would break the guard.
 *
 * Recorded per line with a reason, in the shape EXEMPT_PREFIXES uses, so a tenth entry is a conscious act
 * a reviewer sees. Note the standing consequence: if production source and docs are ever cleaned of issue
 * references, every one of these nine reds — which is the correct signal, and the reason the wider
 * cleanup needs its own ruling rather than being folded in here.
 */
const ISSUE_SUBJECT_EXEMPT: { file: string; contains: string; why: string }[] = [
	{
		file: 'docs/ux/05-concurrency.md',
		contains: "You're #3 · after Sam",
		why: 'PRODUCT COPY, not prose about the codebase. This is the position line a phone renders to a guest — `#3` means THIRD IN LINE, the one meaning of `#N` this product ships to a user. Quoting it in the requirement that specifies it is the whole point of the row, so the string has to survive verbatim.'
	},
	{
		file: 'tests/guards/design-system/lyrics-singer-colour-wiring.test.ts',
		contains: '`--reel-now` is deliberately NOT overridden',
		why: 'asserts the TvPlayer source still carries the prose explaining why --reel-now is not overridden'
	},
	{
		file: 'tests/guards/hygiene/browse-screen-833.test.ts',
		contains: "expect(RAW).toContain('DELETED HERE",
		why: 'asserts the raw route still carries its DELETED-HERE marker, which names the direction ruled on'
	},
	{
		file: 'tests/guards/hygiene/browse-screen-833.test.ts',
		contains: "expect(PAGE).not.toContain('DELETED HERE",
		why: 'the paired negative — the marker must be absent from the rendered page'
	},
	{
		file: 'tests/guards/subsystem-media/library-tag-filter.test.ts',
		contains: 'expect(doc).toMatch(/#798/)',
		why: 'asserts a doc still cites the change whose ruling the filter implements'
	},
	{
		file: 'tests/guards/subsystem-realtime/dangling-current-entry.test.ts',
		contains: 'Self-heal a persisted DANGLING currentEntryId',
		why: 'asserts the store still carries the self-heal comment naming the defect it repairs'
	},
	{
		file: 'tests/guards/wiring/nowplaying-single-source.test.ts',
		contains: 'expect(preamble).toMatch(/#803/)',
		why: 'asserts the single-source preamble still cites the change that established it'
	},
	{
		file: 'tests/guards/wiring/nowplaying-single-source.test.ts',
		contains: 'expect(preamble).toMatch(/#848/)',
		why: 'asserts the preamble also cites the follow-up that extended it'
	},
	{
		file: 'tests/guards/docs/wrong-song-axis-prose-806.test.ts',
		contains: 'expect(doc).toMatch(/#806/)',
		why: 'asserts the prose doc still cites the axis it documents'
	},
	{
		file: 'tests/guards/docs/wrong-song-axis-prose-806.test.ts',
		contains: 'expect(coverage).toMatch(/#806/)',
		why: 'asserts the coverage table still cites the same axis'
	},
	{
		file: 'tests/guards/hygiene/room-cookie-797.test.ts',
		contains: 'const inAComment =',
		why: 'planted fixture: a comment replayed verbatim to prove the reading-verb matcher still fires'
	},
	{
		file: 'tests/guards/hygiene/room-cookie-797.test.ts',
		contains: 'The room-scoping chain reads it:',
		why: 'planted fixture: the first of the two base comments, replayed verbatim'
	},
	{
		file: 'tests/guards/hygiene/room-cookie-797.test.ts',
		contains: 'sets the identity; the chain that scopes',
		why: 'planted fixture: the second base comment, replayed verbatim'
	},
	{
		file: 'tests/guards/hygiene/room-cookie-797.test.ts',
		contains: 'also set a second cookie naming the room',
		why: 'planted fixture: the honest correction, which must survive the matcher as a denial'
	}
];

/**
 * Is this line a recorded exempt site?
 *
 * KEYED ON CONTENT, NOT A LINE NUMBER. The first version keyed `path:line` and broke within the hour: a
 * sibling edit two lines above shifted `browse-screen-833.test.ts` from 236/237 to 237/238, so two
 * exemptions silently stopped matching while a third began pointing at ordinary prose. A line number is a
 * fact about everything ABOVE a site rather than about the site itself, which makes it the wrong key for a
 * record meant to outlive edits.
 */
function isExemptSite(rel: string, line: string): boolean {
	return ISSUE_SUBJECT_EXEMPT.some((e) => e.file === rel && line.includes(e.contains));
}

const SCANNED_EXT = ['.ts', '.svelte', '.py', '.js', '.mjs', '.md', '.txt', '.yml', '.yaml'];
// Extensionless / dotfile config that carried retired task tokens (M<n>-C<n>, B-<n>) and must stay clean.
const SCANNED_NAMES = new Set(['Dockerfile', '.env.example', '.npmrc']);

// This guard is the one file that must contain the patterns (as literals + prose), so it excludes
// itself.
// Named from the root rather than from 'wherever I am', so moving this file cannot silently switch
// off its own self-exemption and turn its documented patterns into offenders.
const SELF = at('tests/guards/meta/task-number-hygiene.test.ts');

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
// PR-BOT.md, while the DRIFT.md that was filed against has already been deleted — so a file
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
		for (const { re, family, only } of PATTERNS) {
			if (only && !only(rel)) continue;
			const m = line.match(re);
			if (m) {
				if (isExemptSite(rel, line)) continue;
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
	// Non-vacuity floor: the walk was unanchored — if `git ls-files` returned nothing
	// (guard run outside the git tree, or the ext/name filter matched none), the scan iterated zero
	// files and passed while guarding nothing. Pin a floor well below the true count (hundreds).
	expect(files.length).toBeGreaterThan(50); // @nvf-floor files.length
	for (const rel of files) {
		offenders.push(...offendersIn(rel, readFileSync(join(REPO, rel), 'utf8')));
	}
	expect(offenders).toEqual([]);
});

// NON-VACUITY SENTINEL for the exemption above. An exemption that quietly stops the guard
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
	expect(files.length).toBeGreaterThan(50); // @nvf-floor files.length
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
		'temp-screenshots/per-song-word-clamp',
		// Re-adding this reinstates a second answer to *how work arrives*, beside the polling
		// contract in docs/loop/TRIAGE.md and ARCHITECTURE.md. The webhook ingress it documented
		// was torn down; a revert or a rebase resurrecting the file would put a live-looking
		// mechanism back in front of every lane.
		'docs/loop/WEBHOOKS.md'
	];
	const present = RETIRED.filter((rel) => existsSync(join(REPO, rel)));
	expect(present).toEqual([]);
});
