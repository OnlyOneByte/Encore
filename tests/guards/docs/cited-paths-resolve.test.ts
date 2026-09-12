// guard: a path a document cites resolves to a file that exists — XR-VER-07.
//
// WHY THIS EXISTS. The requirement register's `Check` field names the test that enforces each row. That
// makes a path in a document load-bearing: a reader follows it to decide whether a rule is actually
// defended. When the test tree was reorganised, 38 such references across 11 documents went stale in one
// commit — including 19 in `04-verification.md`, the one document whose subject IS the test inventory.
//
// Nothing noticed, because a document cannot fail. The register kept describing a tree that no longer
// existed, and every `Check` field in it silently became unverifiable.
//
// WHAT THIS DOES NOT DO. It does not check that the cited test asserts what the row claims — no static
// check can. It closes the narrower and more common failure: the path does not resolve at all.
//
// EXEMPTIONS ARE KEYED ON CONTENT, NOT ON `path:line`. An earlier registry in this suite was keyed on
// line numbers and broke within the hour when a sibling edit shifted two entries by one line.

import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { at, filesUnder, relative } from '@encore/test-support';

/** Every path tracked by git, which is the only definition of "exists" that survives a rename. */
const TRACKED = new Set(
	execFileSync('git', ['ls-files'], { cwd: at('.'), encoding: 'utf8' }).split('\n').filter(Boolean)
);

/** Source-file references in prose: repo-relative, pointing into a real source or test tree. */
const CITED = /\b((?:apps|packages|tests)\/[A-Za-z0-9_./-]+\.(?:test\.ts|harness\.svelte|svelte|ts|py|css|json))\b/g;

/*
 * Documents whose references are DELIBERATELY historical, with the reason each one is exempt.
 *
 * A research spike records a measurement that was taken at a moment in time. Repointing its command line
 * at a file that never produced those numbers would make the record FALSE rather than current, which is
 * strictly worse than leaving it stale — so the document is annotated in place and exempted here.
 */
const HISTORICAL: { doc: string; why: string }[] = [
	{
		doc: 'docs/research/827-queuesheet-drawer-spike.md',
		why: 'a spike record. The file it measured was deleted with the dead drawer surface it pinned; the command is kept verbatim because the document records a measurement that happened, and is annotated in place to say so.'
	}
];

test('every source path cited in a document resolves to a tracked file', () => {
	const docs = filesUnder('docs', ['.md']);
	// Non-vacuity: the walk found the documents. An empty walk yields an empty offender list, which reads
	// exactly like a tree with no stale references — the failure mode this whole suite keeps re-learning.
	expect(docs.length).toBeGreaterThan(20); // @nvf-floor docs.length

	const exempt = new Set(HISTORICAL.map((h) => h.doc));
	const offenders: string[] = [];
	let citationsChecked = 0;

	for (const abs of docs) {
		const rel = relative(abs);
		if (exempt.has(rel)) continue;
		const src = readFileSync(abs, 'utf8');
		for (const m of src.matchAll(CITED)) {
			const cited = m[1]!;
			citationsChecked += 1;
			if (TRACKED.has(cited)) continue;
			// A row may legitimately name a test that does not exist YET, but it has to say so at the site.
			const line = src.slice(src.lastIndexOf('\n', m.index!) + 1, src.indexOf('\n', m.index!));
			if (/does not exist|to be written|would need|not yet|deleted|no longer/i.test(line)) continue;
			offenders.push(
				`${rel}: cites \`${cited}\`, which is not a tracked file. A Check field naming a path that ` +
					`does not resolve is unverifiable, and a reader following it cannot tell whether the rule is ` +
					`defended. Repoint it, or say at the site that the file does not exist yet.`
			);
		}
	}

	// Non-vacuity: citations were actually examined. A regex that stopped matching would make the loop
	// above trivially clean while every path in the register rotted.
	expect(citationsChecked).toBeGreaterThan(100); // @nvf-floor citationsChecked

	expect(offenders).toEqual([]);
});

test('every exempt document still exists and still carries its stale reference', () => {
	/*
	 * An exemption outlives its subject silently. If the spike record were deleted, or edited to drop the
	 * reference, this entry would sit here forever describing nothing — and the next stale path added to
	 * that file would inherit a free pass nobody granted it.
	 */
	for (const { doc, why } of HISTORICAL) {
		expect(TRACKED.has(doc), `exempt document \`${doc}\` is gone — delete its entry. Reason on record: ${why}`).toBe(true);
		const src = readFileSync(at(doc), 'utf8');
		const stale = [...src.matchAll(CITED)].filter((m) => !TRACKED.has(m[1]!));
		expect(
			stale.length,
			`\`${doc}\` no longer cites any missing path, so its exemption is dead and should be removed.`
		).toBeGreaterThan(0);
	}
});

test('the citation pattern reads paths and not prose that resembles them', () => {
	const find = (s: string): string[] => [...s.matchAll(CITED)].map((m) => m[1]!);
	// real citations
	expect(find('see `apps/core/src/lib/clock.ts` for the derivation')).toEqual(['apps/core/src/lib/clock.ts']);
	expect(find('`tests/guards/a11y/contrast.test.ts` pins it')).toEqual(['tests/guards/a11y/contrast.test.ts']);
	expect(find('`apps/core/src/lib/contract/queue/rotation.ts`')).toEqual(['apps/core/src/lib/contract/queue/rotation.ts']);
	expect(find('`apps/worker/src/separate.py`')).toEqual(['apps/worker/src/separate.py']);
	// not citations: a bare directory, a glob, and a package name that merely starts the same way
	expect(find('everything under apps/core/src is in scope')).toEqual([]);
	expect(find('the `apps/**/*.ts` glob')).toEqual([]);
	expect(find('appsflyer/tracking.ts is unrelated')).toEqual([]);
});
