// guard: a path a document cites resolves to a tracked file, so a `Check` field a reader follows to decide
// whether a rule is defended is never unverifiable. A document cannot fail on its own, so this fails for it;
// it does NOT check that the cited test asserts what the row claims. Exemptions are keyed on CONTENT, never
// on `path:line`, because a line-keyed registry breaks the moment a sibling edit shifts an entry by one.

import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { at, filesUnder, relative } from '@encore/test-support';

/** Every path tracked by git, which is the only definition of "exists" that survives a rename. */
const TRACKED = new Set(
	execFileSync('git', ['ls-files'], { cwd: at('.'), encoding: 'utf8' })
		.split('\n')
		.filter(Boolean)
);

// Source-file references in prose. This prefix list is the guard's WHOLE REACH, so getting it wrong makes
// the guard pass by seeing nothing — the last tree rename put every citation outside it and three arms went
// quietly green.
const CITED = /\b((?:src|worker|tests)\/[A-Za-z0-9_./-]+\.(?:test\.ts|harness\.svelte|svelte|ts|py|css|json))\b/g;

/**
 * Documents whose references are DELIBERATELY historical — a spike that records a measurement taken at a
 * moment in time, where repointing the citation would make the record FALSE rather than current. Empty
 * today; the declaration and the arm that keeps each entry honest stay, since the shape will be wanted again.
 */
const HISTORICAL: { doc: string; why: string }[] = [];

test('every source path cited in a document resolves to a tracked file', () => {
	const docs = filesUnder('docs', ['.md']);
	// An empty walk yields an empty offender list, which reads exactly like a tree with no stale references.
	// The floor tracks the population and must never be lowered to accommodate a walk that stopped finding files.
	expect(docs.length).toBeGreaterThan(6); // @nvf-floor docs.length

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

	// A regex that stopped matching would make the loop above trivially clean while every path rotted.
	expect(citationsChecked).toBeGreaterThan(100); // @nvf-floor citationsChecked

	expect(offenders).toEqual([]);
});

test('every exempt document still exists and still carries its stale reference', () => {
	/*
	 * An exemption outlives its subject silently, and the next stale path added to that file inherits a free
	 * pass nobody granted it.
	 */
	for (const { doc, why } of HISTORICAL) {
		expect(TRACKED.has(doc), `exempt document \`${doc}\` is gone — delete its entry. Reason on record: ${why}`).toBe(
			true
		);
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
	expect(find('see `src/lib/clock.ts` for the derivation')).toEqual(['src/lib/clock.ts']);
	expect(find('`tests/guards/a11y/contrast.test.ts` pins it')).toEqual(['tests/guards/a11y/contrast.test.ts']);
	expect(find('`src/lib/contract/queue/rotation.ts`')).toEqual(['src/lib/contract/queue/rotation.ts']);
	expect(find('`worker/src/separate.py`')).toEqual(['worker/src/separate.py']);
	// not citations: a bare directory, a glob, and a package name that merely starts the same way
	expect(find('everything under src is in scope')).toEqual([]);
	expect(find('the `src/**/*.ts` glob')).toEqual([]);
	expect(find('srcfoo/tracking.ts is unrelated')).toEqual([]);
});
