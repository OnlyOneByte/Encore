// guard: AN HTML COMMENT MAY NOT CONTAIN `/*` — the trap that makes guards LIE rather than fail. Half this repo's
// guards strip comments before scanning, C-style FIRST, because a `<style>` block's comments are C-style. A markup
// comment that spells a glob contains `/*` plus a star, so the stripper opens a C comment there and runs to the
// NEXT `*/` anywhere in the file, blanking hundreds of lines of real markup on the way; four guards then reported
// failures about markup that was still perfectly present. Nothing errors — svelte-check is happy, the app renders,
// the build is fine — so only the guards see the mangled text. Write the path in prose instead.
// See docs/GUARDS.md#why-guards-are-written-this-way.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { srcDir, repoRoot } from '@encore/test-support';
import { svelteFiles } from '@encore/test-support/scan';

const SRC = srcDir;

/**
 * The stripper shape this ban exists for: a C-style comment removal, non-greedy to the next terminator. Matched
 * against guard SOURCE, so it is spelled as the text those files contain.
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

	// Non-vacuity: the walk really found HTML comments. This tree is heavily commented, so a low count means the scan
	// broke rather than that the comments went away.
	expect(commentsSeen, 'found almost no HTML comments — the walk or the pattern broke').toBeGreaterThan(50);

	expect(
		offenders,
		'an HTML comment contains `/*`, which makes every comment-stripping guard swallow the markup ' +
			'between it and the next `*/`. The guards then fail with messages about unrelated, still-present ' +
			'markup. Write the path in prose instead of using a `/**` glob.'
	).toEqual([]);
});

test('the comment-stripping guards this protects really do strip C-style comments first', () => {
	// The premise, asserted rather than trusted: with no guard stripping C-style comments this ban would forbid
	// something harmless, and the honest response would be to retire it rather than keep a rule nobody needs.
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
