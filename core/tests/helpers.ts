// The test tree's path anchors and source-text helpers, reached as `$test` (see tests/tsconfig.json).
//
// This replaces the former `@encore/test-support` — a two-module, 333-line tree under tests/support/src/
// wearing a workspace-package costume it never had (no package.json, no node_modules/@encore; resolution
// was always just a tsconfig path). The guard suite it was built for is gone; what survives is the handful
// of unit tests that cross-check a source file's text alongside their behavioural assertions.
//
// The one load-bearing property kept verbatim: a MISSING PATH THROWS. It is never a skip. A test that
// tolerates an absent subject asserts nothing, and anything gating on `existsSync` reads no file, finds no
// violations and passes GREEN.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Walk UP for `bunfig.toml` rather than counting `../` down from a caller: a path encoding the TEST's
 * location inside a claim about the SOURCE's is wrong the moment either moves.
 */
function findRepoRoot(): string {
	let dir = import.meta.dir;
	for (let hops = 0; hops < 12; hops++) {
		if (existsSync(join(dir, 'bunfig.toml'))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(`tests/helpers.ts: no bunfig.toml above ${import.meta.dir}; every anchor here derives from it.`);
}

export const repoRoot: string = findRepoRoot();
export const srcDir: string = join(repoRoot, 'src');

/** An absolute path from a repo-relative one. Does not check existence — see `read`. */
export function at(...parts: string[]): string {
	return join(repoRoot, ...parts);
}

/** **Throws** when the file is missing, so a broken path is not read as a satisfied invariant. */
export function read(...parts: string[]): string {
	const abs = at(...parts);
	if (!existsSync(abs)) {
		throw new Error(
			`tests/helpers.ts: no file at ${parts.join('/')} (resolved to ${abs}). This is a PATH failure, ` +
				'not a failure of the invariant being asserted — fix the path, do not convert it into a skip.'
		);
	}
	return readFileSync(abs, 'utf8');
}

/** How much of a comment a caller wants gone. Every flag DEFAULTS OFF, so the bare call is the code-comment case. */
export interface StripOptions {
	/** Also strip markup comments. For `.svelte`/`.html`; a `.ts` caller has none to lose. */
	markup?: boolean;
	/** Leave `//` line comments STANDING — for a test that reads its subject's line prose on purpose. */
	keepLine?: boolean;
	/** DELETE comments instead of blanking them: byte offsets and line numbers do NOT survive. */
	drop?: boolean;
}

/**
 * Comments out of source TEXT. Prose mentioning a banned token convicts correct code, and prose mentioning a
 * required one satisfies a presence check — both have happened here.
 *
 * Comments are BLANKED with spaces by default, never deleted, so a caller that reports an offset or slices
 * between two anchors still reads true positions. A `//` preceded by a colon, quote or backtick is NOT a
 * comment — it is the `//` in a URL or a regex — so it is left alone.
 */
export function stripComments(src: string, options: StripOptions = {}): string {
	const { markup = false, keepLine = false, drop = false } = options;
	const wipe = (m: string): string => (drop ? '' : m.replace(/[^\n]/g, ' '));
	let out = src;
	if (markup) out = out.replace(/<!--[\s\S]*?-->/g, wipe);
	out = out.replace(/\/\*[\s\S]*?\*\//g, wipe);
	if (!keepLine) out = out.replace(/(^|[^:'"\\`])\/\/[^\n]*/g, (m, p1: string) => p1 + wipe(m.slice(p1.length)));
	return out;
}

/**
 * A documentation block as ONE line: leading markers off, whitespace collapsed. A match against the raw block
 * matches one LINE-WRAPPING of a sentence rather than the sentence, so re-flowing a paragraph puts a break
 * between two of its words and a live claim reads as deleted.
 *
 * `line: true` also treats a leading `//` as a marker, for a subject whose prose is line comments.
 */
export function flattenDoc(block: string, options: { line?: boolean } = {}): string {
	const marker = options.line ? /^[ \t]*(?:\/\/+|\*)[ \t]?/gm : /^[ \t]*\*[ \t]?/gm;
	return block.replace(marker, ' ').replace(/\s+/g, ' ');
}
