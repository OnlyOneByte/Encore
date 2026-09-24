// guard: a task/ticket number must never live in source, a comment, a test, or fixture data. They belong in a
// PR, a commit message, or docs/ — where a reader chasing the history looks. In a comment they are noise: six
// months on nobody has the backlog in their head, and a ticket code says strictly less than the behavioural
// sentence it replaced. The live convention is `T-<n>`; `B-<n>` and `M<n>-C<n>` are retired families.
//
// This scan deliberately does NOT strip comments — a task ref in a comment is the exact thing banned — and it
// covers every GIT-TRACKED file, including .md/.txt/.yml and the worker's config basenames, because the
// retired families lived mostly in docs and in the Dockerfile. This file is the sole exception, by path,
// because it carries the patterns as regex literals and prose.
import { test, expect } from 'bun:test';
import { at, repoRoot } from '@encore/test-support';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';

// Repo-root anchored: `git ls-files` runs with -C REPO and paths come from `at()`, so this encodes no depth.
const REPO = repoRoot;

// The task-id families, plus GitHub issue refs.
//
// THE HYPHEN IS LOAD-BEARING. A bare-number scheme cannot be guarded: `T1` already occurs ~320 times as a
// timestamp constant in play-log.test.ts, so `\bT[0-9]+\b` would fire on data that has nothing to do with a
// ticket. The hyphenated `T-<n>` occurs zero times outside an intended reference.
//
// `#<n>` APPLIES REPO-WIDE, at one to four digits — it was `{3,4}` and scoped to `*.test.ts`, which left
// two-digit references sitting in banned files. Widening it brings in two conventions that are NOT issue numbers
// and must survive, excluded by PATTERN rather than by a site list so a new one needs no edit here: a numbered
// review `Finding #4`, and ordinals that count things (`socket 0`, `frame #1`) — a ban that ate those would
// rewrite `socket 0 drops` into nonsense.
//
// DISCRIMINATING AN ISSUE FROM A COLOUR: there is no syntactic difference between a three-digit issue and a
// three-digit hex colour, so the only signal is the CLOSING quote — a colour is a string literal, while a
// reference in prose is followed by space or punctuation. Only the TRAILING quote may be excluded; excluding a
// quote on either side looked symmetrical and blinded the pattern to a test name opening `test('#…`.
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
				// A LEADING ZERO makes it a colour, not an issue: issue numbers start at 1 and never carry one, while an
				// unquoted `#0xx` in prose is a hex value the trailing-quote exclusion cannot see.
				`#(?!0)[0-9]{1,4}` +
				// …and not closing a quoted parenthetical VALUE. `"Lady Gaga — Telephone (243s, #1)"` is production
				// data (the lyrics registry's same-title disambiguator), and a reference in prose is never followed by
				// `)` immediately before a string ends.
				`(?!\\)['"])` +
				// …not followed by a hex digit or a closing quote, either of which makes it a colour — EXCEPT a
				// possessive. `'` alone excused a match, which let `#836's drag` sit in src/ with this guard green,
				// because a possessive apostrophe is indistinguishable from a closing quote. A colour literal is never
				// followed by `s`.
				`(?![0-9a-fA-F])(?!['"](?!s\\b))`
		),
		family: 'GitHub issue #<n>'
	}
];

/**
 * Lines where an issue number is the SUBJECT of an assertion, not prose about one: each reads a source file or a
 * doc and requires a specific reference to still be present, enforcing the convention in the OPPOSITE direction
 * from the ban above. Stripping these would break the guard rather than tidy it. Keyed per line with a reason so
 * a new entry is a conscious act.
 */
const ISSUE_SUBJECT_EXEMPT: { file: string; contains: string; why: string }[] = [
	{
		file: 'tests/guards/design-system/lyrics-singer-colour-wiring.test.ts',
		contains: '`--reel-now` is deliberately NOT overridden',
		why: 'asserts the TvPlayer source still carries the prose explaining why --reel-now is not overridden'
	},
	{
		file: 'tests/guards/subsystem-realtime/dangling-current-entry.test.ts',
		contains: 'Self-heal a persisted DANGLING currentEntryId',
		why: 'asserts the store still carries the self-heal comment naming the defect it repairs'
	},
	{
		file: 'tests/guards/hygiene/room-cookie.test.ts',
		contains: 'const inAComment =',
		why: 'planted fixture: a comment replayed verbatim to prove the reading-verb matcher still fires'
	},
	{
		file: 'tests/guards/hygiene/room-cookie.test.ts',
		contains: 'The room-scoping chain reads it:',
		why: 'planted fixture: the first of the two base comments, replayed verbatim'
	},
	{
		file: 'tests/guards/hygiene/room-cookie.test.ts',
		contains: 'sets the identity; the chain that scopes',
		why: 'planted fixture: the second base comment, replayed verbatim'
	},
	{
		file: 'tests/guards/hygiene/room-cookie.test.ts',
		contains: 'also set a second cookie naming the room',
		why: 'planted fixture: the honest correction, which must survive the matcher as a denial'
	}
];

/**
 * Is this line a recorded exempt site? KEYED ON CONTENT, NOT A LINE NUMBER: the first version keyed `path:line`
 * and broke within the hour when a sibling edit two lines above shifted two exemptions off their sites while a
 * third began pointing at ordinary prose. A line number is a fact about everything ABOVE a site.
 */
function isExemptSite(rel: string, line: string): boolean {
	return ISSUE_SUBJECT_EXEMPT.some((e) => e.file === rel && line.includes(e.contains));
}

test('every recorded exemption still has a subject', () => {
	// An exemption whose site is gone is PERMISSIVE — it simply never matches — so nothing failed when one rotted,
	// and seven had rotted by the time anyone looked. A list that only ever grows stops describing the tree.
	const orphans = ISSUE_SUBJECT_EXEMPT.filter((e) => {
		const abs = at(e.file);
		return !existsSync(abs) || !readFileSync(abs, 'utf8').includes(e.contains);
	}).map((e) => `${e.file} no longer contains \`${e.contains}\` — ${e.why}`);

	expect(
		orphans,
		'a recorded exemption has no subject. The assertion it exempted was deleted or reworded, so DELETE the ' +
			'entry — do not re-point it at whatever the line says now, which is how an exemption ends up ' +
			'covering something nobody granted it for.'
	).toEqual([]);

	expect(ISSUE_SUBJECT_EXEMPT.length).toBeGreaterThan(3); // @nvf-floor ISSUE_SUBJECT_EXEMPT.length
});

const SCANNED_EXT = ['.ts', '.svelte', '.py', '.js', '.mjs', '.md', '.txt', '.yml', '.yaml'];
const SCANNED_NAMES = new Set(['Dockerfile', '.env.example', '.npmrc']);

// This guard is the one file that must contain the patterns, so it excludes itself — named from the root, so
// moving the file cannot silently switch off its own self-exemption.
const SELF = at('tests/guards/meta/task-number-hygiene.test.ts');

/*
 * THE PATH EXEMPTIONS, EMPTY — the ban has no carve-out at all. The map stays declared, with its sentinel below,
 * because an exemption is the kind of thing that will be wanted again. Any future prefix is a DIRECTORY with a
 * trailing slash, which is load-bearing: a bare `docs/loop` would also swallow a sibling such as docs/loopback.md.
 */
const EXEMPT_PREFIXES: Record<string, string> = {};

/** Is this repo-relative path under a documented exemption? */
function isExempt(rel: string): boolean {
	return Object.keys(EXEMPT_PREFIXES).some((prefix) => rel.startsWith(prefix));
}

// GIT-TRACKED files only, so an untracked or .gitignore'd path is never in scope: the guard polices the repo, not the
// working directory, and needs no prune list because generated and vendored trees are all untracked.
function trackedScannedFiles(): string[] {
	const listed = execFileSync('git', ['-C', REPO, 'ls-files', '-z'], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	});
	const rels = listed.split('\0').filter((r) => r.length > 0);
	return rels.filter((rel) => SCANNED_EXT.some((e) => rel.endsWith(e)) || SCANNED_NAMES.has(basename(rel)));
}

/**
 * Every scanned TRACKED file, minus this guard and the documented EXEMPT_PREFIXES. Driving off `git ls-files` is
 * what keeps a ref in `packages/` or `worker/tests/` from hiding while a ref in an untracked operational tree
 * does not red this guard.
 */
function scannedFiles(): string[] {
	return trackedScannedFiles().filter((rel) => join(REPO, rel) !== SELF && !isExempt(rel));
}

/**
 * The offenders in one file's text. PURE — it takes the text rather than reading it — which is what lets the
 * non-vacuity sentinel below plant a token in a scanned path without writing anything into the tree.
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
	// Non-vacuity floor: a `git ls-files` returning nothing (run outside the tree, or an ext filter matching none)
	// iterated zero files and passed while guarding nothing.
	expect(files.length).toBeGreaterThan(50); // @nvf-floor files.length
	for (const rel of files) {
		offenders.push(...offendersIn(rel, readFileSync(join(REPO, rel), 'utf8')));
	}
	expect(offenders).toEqual([]);
});

// NON-VACUITY SENTINEL for the exemption map: without it `EXEMPT_PREFIXES` could be widened to `''`, or the patterns
// hollowed out, and the guard above would still report a serene green.
test('nothing is exempt from the ban, and the guard still bites everywhere', () => {
	// A planted token in a scanned, non-exempt path is still an offender, all three families still match, NOTHING is
	// exempt (asserted for every shape near the one former carve-out, including the `docs/loopback.md` trailing-slash
	// trap), and the walk did not collapse.
	const planted = offendersIn('src/lib/planted.ts', 'const n = 1; // shipped in T-1\n');
	expect(planted).toHaveLength(1);
	expect(planted[0]).toContain('src/lib/planted.ts:1');
	expect(planted[0]).toContain('"T-1"');
	expect(offendersIn('docs/ARCHITECTURE.md', 'closed by B-8')).toHaveLength(1);
	expect(offendersIn('worker/Dockerfile', '# M6-C1')).toHaveLength(1);

	expect(Object.keys(EXEMPT_PREFIXES)).toEqual([]);
	for (const rel of [
		'docs/loop/COMMON.md',
		'docs/ARCHITECTURE.md',
		'docs/loopback.md',
		'docs/loop.md',
		'README.md',
		'src/lib/x.ts',
		'worker/Dockerfile'
	]) {
		expect(isExempt(rel)).toBe(false);
	}

	const files = scannedFiles();
	expect(files.length).toBeGreaterThan(50); // @nvf-floor files.length
	expect(files.some((rel) => rel.startsWith('docs/'))).toBe(true);
});

// guard: the paths retired in the repo-cleanup sweep stay retired. A pure deletion cannot be pinned by a
// behavioural test, so this existence check is the only thing that reds when one is re-added by a stray `git mv`,
// a revert, or a rebase. Each is a real regression: ROADMAP.md reinstates a second what-to-build-next authority
// beside the issue tracker, and an archive spec resurrects a doc whose citations were repointed to ARCHITECTURE.
test('the paths retired by the repo-cleanup stay absent from the tree', () => {
	const RETIRED = [
		'docs/ROADMAP.md',
		'docs/archive',
		'docs/specs',
		'docs/shots',
		'temp-screenshots/per-song-word-clamp',
		// Re-adding this reinstates a second answer to *how work arrives*, beside the polling contract.
		'docs/loop/WEBHOOKS.md'
	];
	const present = RETIRED.filter((rel) => existsSync(join(REPO, rel)));
	expect(present).toEqual([]);
});
