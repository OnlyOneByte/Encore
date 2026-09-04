// guard: a functional control must never again be a Unicode codepoint.
//
// THE BUG THIS EXISTS FOR. The transport controls were written as `⏮ ▶ ⏸ ⏭` and on iOS they rendered
// as full-colour Apple emoji. U+23EE, U+23F8 and U+23ED carry `Emoji_Presentation=Yes`, so colour
// emoji IS their Unicode default; the app.css font stack owns none of those glyphs, so the platform's
// last-resort matcher picked the colour emoji font and won. `▶` (U+25B6) is text-default but
// emoji-capable, which is why it rendered inconsistently right next to `⏸`.
//
// WHAT THIS DOES AND DOES NOT BAN. Not all emoji — the pictographs in labels (`🔥 Popular tonight`,
// `🕑 Recently queued`, `✨`, the 🎤 wordmark) are deliberate colour and stay. Two narrower rules:
//
//   1. Codepoints that were replaced by real marks must not come back. A control whose only label is
//      a glyph has its appearance decided by the platform, which is the whole defect.
//   2. Nothing may carry U+FE0F, the emoji-presentation selector. FE0F does not merely permit colour
//      emoji, it explicitly requests it, so it can never be part of an art-directed mark.
//
// WHY A SOURCE SCAN. The defect is a property of the source text, so it is decidable without a
// browser. Comments are stripped first: several of the files below discuss these very codepoints in
// prose explaining why they were removed, and a scan that flagged its own documentation would be
// deleted within a week.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ICON_NAMES, ICON_PATHS } from './icons';

const SRC = join(import.meta.dir, '..', '..');

/** Codepoints that now have a mark in icons.ts. Named so a failure says what to use instead. */
const REPLACED: Record<string, string> = {
	'\u23EE': 'prev',
	'\u23ED': 'next',
	'\u23F8': 'pause',
	'\u25B6': 'play',
	'\u2190': 'arrow-left',
	'\u2192': 'arrow-right',
	'\u2191': 'arrow-up',
	'\u2193': 'arrow-down',
	'\u2715': 'close',
	'\u2713': 'check',
	'\uFF0B': 'plus',
	'\u2303': 'chevron-up',
	'\u25BE': 'chevron-down',
	'\u25B8': 'chevron-right',
	'\u22EE': 'grip',
	'\u2699': 'gear',
	'\u26A0': 'warning'
};

const FE0F = '\uFE0F';

function svelteFiles(dir: string): string[] {
	const out: string[] = [];
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, ent.name);
		if (ent.isDirectory()) out.push(...svelteFiles(p));
		else if (ent.name.endsWith('.svelte')) out.push(p);
	}
	return out;
}

/**
 * Blank out comments, preserving newlines so reported line numbers stay true. Replacing with spaces
 * rather than deleting is what keeps the offset arithmetic honest.
 */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src
		.replace(/<!--[\s\S]*?-->/g, blank) // markup comments
		.replace(/\/\*[\s\S]*?\*\//g, blank) // block comments, in <script> and <style>
		.replace(/(^|[^:'"\\])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length))); // line comments, sparing `https://`
}

function lineOf(src: string, index: number): number {
	return src.slice(0, index).split('\n').length;
}

/** Every .svelte under lib/ and routes/ — the entire surface a guest can see. */
const FILES = [...svelteFiles(join(SRC, 'lib')), ...svelteFiles(join(SRC, 'routes'))];

test('no functional control is a Unicode codepoint (use Icon.svelte)', () => {
	const offenders: string[] = [];
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const [cp, icon] of Object.entries(REPLACED)) {
			let i = src.indexOf(cp);
			while (i !== -1) {
				const cpHex = cp.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
				offenders.push(
					`${f.replace(SRC, 'src')}:${lineOf(src, i)}: U+${cpHex} — use <Icon name="${icon}" />`
				);
				i = src.indexOf(cp, i + 1);
			}
		}
	}
	expect(offenders).toEqual([]);
});

test('nothing forces emoji presentation with U+FE0F', () => {
	const offenders: string[] = [];
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		let i = src.indexOf(FE0F);
		while (i !== -1) {
			offenders.push(`${f.replace(SRC, 'src')}:${lineOf(src, i)}: U+FE0F forces colour emoji`);
			i = src.indexOf(FE0F, i + 1);
		}
	}
	expect(offenders).toEqual([]);
});

/**
 * A glyph in CSS `content:` is the case a markup-only scan cannot see — SongRow's play badge lived
 * there as `content: '▶'` and would have survived a scan that only read attributes and text nodes.
 */
test('no CSS content: declaration draws a glyph', () => {
	const offenders: string[] = [];
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const m of src.matchAll(/content:\s*(['"])([^'"]*)\1/g)) {
			const value = m[2]!;
			// eslint-disable-next-line no-control-regex
			if (/[^\u0000-\u007F]/.test(value)) {
				offenders.push(`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: content: '${value}'`);
			}
		}
	}
	expect(offenders).toEqual([]);
});

test('every icon name resolves to non-empty path data', () => {
	const empty = ICON_NAMES.filter((n) => !ICON_PATHS[n] || ICON_PATHS[n].trim() === '');
	expect(empty).toEqual([]);
});

test('icon path data is markup, not a stray codepoint', () => {
	const bad = ICON_NAMES.filter((n) => !/^<(path|circle|rect|polygon|line)/.test(ICON_PATHS[n]));
	expect(bad).toEqual([]);
});
