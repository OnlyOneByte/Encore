// guard: no functional control is a Unicode codepoint, and no UI-visible string carries an emoji.
// Caught the transport controls written as U+23EE/U+23F8/U+23ED/U+25B6: those carry
// Emoji_Presentation=Yes, app.css owns none of them, so iOS's last-resort matcher drew full-colour
// Apple emoji. Comments are stripped before scanning — several scanned files name these codepoints in prose.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { srcDir } from '@encore/test-support';
import { ICON_NAMES, ICON_PATHS } from '$lib/ui/icons';
import { svelteFiles } from '@encore/test-support/scan';

const SRC = srcDir; // src

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

// Emoji are banned outright: one codepoint is a different drawing on Apple/Google/Samsung/Windows and a
// tofu box where no emoji font exists — which is what the TV wordmark rendered as in a screenshot here.
// An emoji is the one mark whose appearance is never the app's to choose.
const EMOJI_RANGES = [
	[0x1f000, 0x1faff], // pictographs, symbols, transport & map, supplemental
	[0x2190, 0x21ff], // ARROWS — the glyphs the arrow-* marks replaced; a bare arrow is a platform-drawn cue
	[0x2600, 0x27bf], // misc symbols + dingbats (☀ ✨ ✅ ➡)
	[0x2b00, 0x2bff], // misc symbols and arrows
	// ‹ › only, not the whole block: these two get pressed into service as nav chevrons that chevron-left/right own.
	[0x2039, 0x203a],
	[0xfe0f, 0xfe0f] // the emoji-presentation selector itself
] as const;

function emojiIn(src: string): { index: number; cp: string }[] {
	const hits: { index: number; cp: string }[] = [];
	for (let i = 0; i < src.length;) {
		const cp = src.codePointAt(i)!;
		const width = cp > 0xffff ? 2 : 1;
		if (EMOJI_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) {
			hits.push({ index: i, cp: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0') });
		}
		i += width;
	}
	return hits;
}

/** Client-side .ts, excluding tests — test files hold emoji as fixtures on purpose. */
function tsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, ent.name);
		if (ent.isDirectory()) out.push(...tsFiles(p));
		else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.test.ts')) out.push(p);
	}
	return out;
}

/** Blank out comments, preserving newlines so reported line numbers stay true. */
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

// Non-vacuity floor: the five ban scans below assert `offenders` empty, so a broken walk returning [] passes silently.
test('the icon ban scans actually read a non-empty surface', () => {
	expect(FILES.length).toBeGreaterThan(15); // @nvf-floor FILES.length
	expect(tsFiles(join(SRC, 'lib')).length).toBeGreaterThan(10); // @nvf-floor tsFiles(join(SRC, 'lib')).length
});

test('no functional control is a Unicode codepoint (use Icon.svelte)', () => {
	const offenders: string[] = [];
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const [cp, icon] of Object.entries(REPLACED)) {
			let i = src.indexOf(cp);
			while (i !== -1) {
				const cpHex = cp.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
				offenders.push(`${f.replace(SRC, 'src')}:${lineOf(src, i)}: U+${cpHex} — use <Icon name="${icon}" />`);
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

test('no emoji in any UI-visible string', () => {
	const offenders: string[] = [];
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const { index, cp } of emojiIn(src)) {
			offenders.push(`${f.replace(SRC, 'src')}:${lineOf(src, index)}: ${cp} — use <Icon /> or drop it from the copy`);
		}
	}
	expect(offenders).toEqual([]);
});

// Copy in .ts (empty states, toasts) cannot hold a component, so the emoji goes and the sentence stands
// alone. `lib/server` is excluded: server files hold emoji as DATA — track-title.ts strips them out of
// scraped titles and its fixtures must keep them.
test('no emoji in user-facing copy in $lib', () => {
	const offenders: string[] = [];
	for (const f of tsFiles(join(SRC, 'lib'))) {
		if (f.includes(`${sep}lib${sep}server${sep}`)) continue;
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const m of src.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
			for (const { cp } of emojiIn(m[2]!)) {
				offenders.push(`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: ${cp} in a string`);
			}
		}
	}
	expect(offenders).toEqual([]);
});

// A glyph in CSS `content:` is invisible to a markup-only scan — SongRow's play badge lived there.
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
