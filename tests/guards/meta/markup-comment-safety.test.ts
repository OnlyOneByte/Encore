//
// Guard 3 of 3 from the shadcn migration's own near-misses: AN HTML COMMENT MAY NOT CONTAIN `/*`.
//
// THE BUG THIS BOUNDS, and it is the most confusing of the three because it makes guards lie rather
// than fail. Half this repo's guards strip comments before scanning, and they strip C-style comments
// FIRST — `.replace(/\/\*[\s\S]*?\*\//g, ' ')` — because a `<style>` block's comments are C-style.
//
// A markup comment explaining Tailwind's `@source` glob wrote the path with its wildcards:
//
//     <!-- Tailwind scans only `components/ui/**`, so a utility written here … -->
//
// `/**` is `/*` plus a star. The stripper opened a C comment there and ran to the NEXT `*/` anywhere in
// the file, blanking hundreds of lines of real markup on its way. Four guards then reported failures
// about markup that was still perfectly present — a missing back button, a missing transport handler —
// and the source they were shown had simply had those regions deleted out from under them.
//
// Nothing errors. `svelte-check` is happy, the app renders correctly, the build is fine. Only the
// guards see the mangled text, and what they report is a lie about a different part of the file.
//
// THE RULE. No `/*` inside an HTML comment, anywhere in the tree. Write the glob in prose ("the
// components/ui directory") or drop the wildcards. This is cheap to obey and expensive to debug.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { srcDir, repoRoot } from '@encore/test-support';
import { svelteFiles } from '@encore/test-support/scan';

const SRC = srcDir;

/**
 * The stripper shape this ban exists for: a C-style comment removal, non-greedy up to the next comment terminator.
 * Matched against guard SOURCE, so it is spelled as the text those files contain.
 */
const C_COMMENT_STRIP = /\/\\\*\[\\s\\S\]\*\?\\\*\\\//;

test('no HTML comment contains a C-style comment opener', () => {
	const offenders: string[] = [];
	let commentsSeen = 0;

	for (const f of svelteFiles(SRC)) {
		const src = readFileSync(f, 'utf8');
		for (const m of src.matchAll(/<!--([\s\S]*?)-->/g)) {
			commentsSeen++;
			const body = m[1]!;
			if (!body.includes('/*')) continue;
			// Report the line so the fix is one jump away rather than a hunt through a long comment.
			const line = src.slice(0, m.index! + body.indexOf('/*')).split('\n').length;
			offenders.push(
				`${f.slice(SRC.length + 1)}:${line} — an HTML comment contains \`/*\`. ` +
					'Guards that strip C-style comments first will swallow markup from here to the next `*/`.'
			);
		}
	}

	// Non-vacuity: the walk really found HTML comments. This tree is heavily commented, so a low count
	// means the scan broke, not that the comments went away.
	expect(commentsSeen, 'found almost no HTML comments — the walk or the pattern broke').toBeGreaterThan(50);

	expect(
		offenders,
		'an HTML comment contains `/*`, which makes every comment-stripping guard swallow the markup ' +
			'between it and the next `*/`. The guards then fail with messages about unrelated, still-present ' +
			'markup. Write the path in prose instead of using a `/**` glob.'
	).toEqual([]);
});

test('the comment-stripping guards this protects really do strip C-style comments first', () => {
	// The premise, asserted rather than trusted: if no guard stripped C-style comments, this ban would
	// be forbidding something harmless, and the honest response would be to retire it rather than keep a
	// rule nobody needs. Checked against the guards' own source.
	const strippers: string[] = [];
	const walk = (dir: string) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.endsWith('.test.ts') && C_COMMENT_STRIP.test(readFileSync(p, 'utf8'))) strippers.push(p);
		}
	};
	walk(join(repoRoot, 'tests', 'guards'));

	expect(
		strippers.length,
		'no guard strips C-style comments any more, so this ban may be retired on the record'
	).toBeGreaterThan(0);
});
