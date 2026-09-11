// guard: the register's own index describes the register — XR-VER-07.
//
// WHY THIS EXISTS, and it is a short and honest story: writing the index for these sections, I put
// "**147 requirements**" in a header whose table adds to 127. It survived exactly as long as it took to run
// a count, and nothing in the suite would have caught it.
//
// That is the whole failure mode. A summary count is the first thing a reader trusts and the last thing
// anyone re-derives, so it drifts silently and then gets defended by someone who assumes it was checked.
// The same document already carried a stale "265 files / 2566 cases" against an actual 287 / 2652, and a
// section table listing 14 scan-helper consumers whose membership had changed underneath the correct total.
//
// WHAT IT PINS
//   1. every row count in a README's section table equals the `### XR-` rows in that file
//   2. the headline total equals the sum of the table
//   3. every file in the tree appears in the table, so a new section cannot be added invisibly
//   4. every ID cited anywhere in docs/ or tests/ resolves to a defined row
//   5. no ID is defined twice, across BOTH trees
//
// (4) is the one with teeth beyond bookkeeping: a `Check` field citing a retired requirement, or a test
// claiming to enforce a requirement ID that no row defines, is a claim of coverage that nothing backs.
//
// NOTE ON THIS COMMENT. An earlier draft illustrated that sentence with a made-up ID, and arm (4) flagged
// it — correctly, since it cannot tell a prose example from a real citation. The fix is to describe the
// shape instead of writing one, NOT to exempt this file: an exemption would blind the arm to a genuine
// dangling citation added here later. Every text-scanning guard in this suite has to survive its own
// documentation, and this one is no exception.

import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at, filesUnder, relative } from '@encore/test-support';

const TREES = ['docs/ux', 'docs/arch'] as const;
const ROW = /^### (XR-[A-Z]+-\d+)/gm;
/** `| [`01-tv.md`](01-tv.md) | 20 | Covers … |` */
const TABLE_ROW = /\|\s*\[`(\d\d-[a-z0-9-]+\.md)`\]\([^)]*\)\s*\|\s*(\d+)\s*\|/g;
const HEADLINE = /\*\*(\d+) requirements\*\*/;

function rowsIn(rel: string): string[] {
	return [...readFileSync(at(rel), 'utf8').matchAll(ROW)].map((m) => m[1]!);
}

test("each tree's index table matches the rows in the files it lists", () => {
	const offenders: string[] = [];
	let tablesChecked = 0;

	for (const tree of TREES) {
		const readme = `${tree}/README.md`;
		const src = readFileSync(at(readme), 'utf8');
		const listed = new Map([...src.matchAll(TABLE_ROW)].map((m) => [m[1]!, Number(m[2]!)]));
		tablesChecked += 1;

		// (1) each listed count is right
		for (const [file, claimed] of listed) {
			const actual = rowsIn(`${tree}/${file}`).length;
			if (actual !== claimed) {
				offenders.push(
					`${readme} lists ${file} as ${claimed} rows; it has ${actual}. A count in an index is the ` +
						`first thing a reader trusts and the last thing anyone re-derives.`
				);
			}
		}

		// (3) nothing in the tree is missing from the table
		const onDisk = filesUnder(tree, ['.md'])
			.map((abs) => relative(abs).slice(tree.length + 1))
			.filter((n) => /^\d\d-/.test(n));
		for (const f of onDisk) {
			if (!listed.has(f)) {
				offenders.push(`${readme} does not list ${f}, so a whole section is invisible from the index.`);
			}
		}

		// (2) the headline equals the table
		const head = HEADLINE.exec(src);
		expect(head, `${readme} has no "**N requirements**" headline to check`).not.toBeNull();
		const sum = [...listed.values()].reduce((a, b) => a + b, 0);
		if (Number(head![1]!) !== sum) {
			offenders.push(
				`${readme} claims ${head![1]} requirements; its own table adds to ${sum}. This exact error was ` +
					`made writing this index — 147 against a table of 127 — which is why this arm exists.`
			);
		}
	}

	/*
	 * Two assertions doing two different jobs, and the registry is why they are both here.
	 *
	 * `toBe(TREES.length)` is exactness: it catches a tree being dropped from the list. But it carries no
	 * numeric literal, so the floors registry cannot see a floor in it and reported this one GONE — which
	 * was the correct complaint, not a false alarm. A registered floor has to be a literal, or it cannot be
	 * detected when someone lowers it.
	 */
	expect(tablesChecked).toBeGreaterThanOrEqual(2); // @nvf-floor tablesChecked
	expect(tablesChecked, 'a tree was dropped from TREES, so its index is no longer checked at all').toBe(
		TREES.length
	);
	expect(offenders).toEqual([]);
});

test('every requirement ID cited in a document or a test resolves to a defined row', () => {
	const defined = new Map<string, string>();
	const dupes: string[] = [];
	for (const tree of TREES) {
		for (const abs of filesUnder(tree, ['.md'])) {
			const rel = relative(abs);
			for (const id of rowsIn(rel)) {
				// (5) an ID defined twice makes "the row for X" ambiguous across two trees
				if (defined.has(id)) dupes.push(`${id} is defined in both ${defined.get(id)} and ${rel}.`);
				else defined.set(id, rel);
			}
		}
	}
	expect(dupes).toEqual([]);
	// Non-vacuity: rows were actually found. An empty map would make every citation below "unresolved",
	// so this floor is what stops the arm inverting into noise rather than silence.
	expect(defined.size).toBeGreaterThan(150); // @nvf-floor defined.size

	const cited = new Map<string, string>();
	for (const abs of [...filesUnder('docs', ['.md']), ...filesUnder('tests', ['.ts'])]) {
		const rel = relative(abs);
		for (const m of readFileSync(abs, 'utf8').matchAll(/\b(XR-[A-Z]+-\d+)\b/g)) {
			if (!cited.has(m[1]!)) cited.set(m[1]!, rel);
		}
	}
	expect(cited.size).toBeGreaterThan(100); // @nvf-floor cited.size

	const dangling = [...cited.entries()]
		.filter(([id]) => !defined.has(id))
		.map(([id, where]) => `${where} cites ${id}, which no row defines. A Check field or a test naming a ` +
			`requirement that does not exist is a claim of coverage with nothing behind it.`);
	expect(dangling).toEqual([]);
});

test('the row and table patterns match the real shapes and not near-misses', () => {
	const rows = (s: string): string[] => [...s.matchAll(ROW)].map((m) => m[1]!);
	expect(rows('### XR-TV-01 — Something\n')).toEqual(['XR-TV-01']);
	expect(rows('### XR-TVM-10 — Something\n')).toEqual(['XR-TVM-10']);
	// a mention inside a row body is not a definition, and neither is a deeper heading
	expect(rows('see `XR-TV-01` for the derivation\n')).toEqual([]);
	expect(rows('#### XR-TV-01 — a sub-heading\n')).toEqual([]);
	expect(rows('> ### XR-TV-01 — quoted\n')).toEqual([]);

	const table = (s: string): [string, number][] =>
		[...s.matchAll(TABLE_ROW)].map((m) => [m[1]!, Number(m[2]!)]);
	expect(table('| [`01-tv.md`](01-tv.md) | 20 | Type floor |')).toEqual([['01-tv.md', 20]]);
	// the "how to read a row" table has no filename cell, so it must not be read as a section row
	expect(table('| Field | Content |')).toEqual([]);
	expect(table('| **Statement** | The product has a stated policy |')).toEqual([]);
});
