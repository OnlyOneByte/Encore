// Shared helpers for the source-scanning guard tests. These decide WHAT A GUARD CAN SEE, so they are single-sourced: a
// drifted per-file copy narrows one guard's population and still passes on the smaller surface.
import { filesIn, read } from './tree.ts';

/** The one walk's exclusion set, re-exported because `test-helpers.test.ts` asserts on it here. */
export { SKIP_DIRS } from './tree.ts';

/** How much of a comment a caller wants gone. Every flag DEFAULTS OFF, so the bare call is the code-comment case. */
export interface StripOptions {
	/** Also strip markup comments. For `.svelte`/`.html`; a `.ts` caller has none to lose. */
	markup?: boolean;
	/** Leave `//` line comments STANDING — for a guard that reads its subject's line prose on purpose. */
	keepLine?: boolean;
	/** DELETE comments instead of blanking them: shorter text, and byte offsets and line numbers do NOT survive. */
	drop?: boolean;
}

/**
 * THE comment stripper. A guard scans source TEXT, so prose mentioning a banned token convicts correct code and
 * prose mentioning a required one satisfies a presence arm — both have happened here. The hand-rolled per-file
 * copies had drifted into a dozen shapes, one of which stripped markup and block comments but NOT `//`, which is
 * how a line comment leaked into an absence arm and reddened it on production prose.
 *
 * Comments are BLANKED with spaces by default, never deleted, so a caller that reports an offset, counts a line or
 * slices between two anchors still reads true positions. `drop` is for the callers whose assertions were written
 * against the collapsed text instead.
 *
 * A `//` preceded by a colon, a quote or a backtick is NOT a comment — it is the `//` in a URL or in a pattern —
 * so it is left alone. An unguarded strip ate the rest of the line and took real code with it.
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
 * A documentation block as ONE line: the leading markers off, whitespace collapsed. Every prose guard needs this,
 * because a match against the raw block matches one LINE-WRAPPING of a sentence rather than the sentence —
 * re-flowing a paragraph then puts a break between two of its words and a live claim reads as deleted.
 *
 * `line: true` also treats a `//` at the start of a line as a marker, for a guard whose subject's prose is line
 * comments rather than a block. Without it a re-flow puts `//` BETWEEN two words of a sentence, and a negation
 * that wraps across two comment lines reads as its own opposite.
 *
 * No `.trim()`: a caller that wants one says so, and the callers disagree about it.
 */
export function flattenDoc(block: string, options: { line?: boolean } = {}): string {
	const marker = options.line ? /^[ \t]*(?:\/\/+|\*)[ \t]?/gm : /^[ \t]*\*[ \t]?/gm;
	return block.replace(marker, ' ').replace(/\s+/g, ' ');
}

export function svelteFiles(dir: string): string[] {
	return filesIn(dir, ['.svelte']);
}

/**
 * DELIBERATELY WIDENED to `.css` and it must not be flattened back: the CSS this repo animates lives in component
 * `<style>` blocks AND in `src/app.css`, so a `.svelte`-only walk is blind to `app.css`'s `@keyframes`.
 */
export function styleFiles(dir: string): string[] {
	return filesIn(dir, ['.svelte', '.css']);
}

/**
 * The standard the design committed to (WCAG 2.5.8 asks 24; the app set itself 44). A FLOOR, not an equality: raising
 * `--tap` is the design's to choose, lowering it past the commitment is the regression.
 */
export const TAP_FLOOR = 44;

/**
 * READ OUT OF `app.css`, so `var(--tap)` in a component and `TAP` in a guard are one fact: changing `--tap` alone stays
 * green, while reverting one control to a bare `44px` reds, because `expressesTap` asks for the token.
 */
export const TAP = readTapToken();

function readTapToken(): number {
	// Anchored at the repo ROOT, never at this file: a `join(import.meta.dir, '..')` hop re-points silently on a move.
	const css = read('src', 'app.css');
	const m = css.match(/--tap:\s*([0-9.]+)px\s*;/);
	// No soft fallback to 44: a missing declaration means every touch guard downstream measures an undeclared number.
	if (!m) throw new Error('app.css declares no `--tap: <n>px` token — the touch guards have no standard to read');
	return Number(m[1]);
}

/**
 * The TOKEN rather than its number. `var(--tap)` and `clamp(var(--tap), …)` count; a bare `44px` does NOT, even while 44
 * is what `--tap` holds, because that equality is a coincidence rather than a binding.
 */
export function expressesTap(body: string): boolean {
	return /(?:min-)?(?:width|height)\s*:[^;]*var\(--tap\)/.test(body);
}

/** The offender shape: right size today, drifts the moment `--tap` moves. */
export function restatesTapNumber(body: string, tap: number = TAP): boolean {
	return new RegExp(`(?:min-)?(?:width|height)\\s*:[^;]*(?<![0-9.])${tap}px`).test(body);
}

// Bare element selectors honoured as controls. `input` is deliberately ABSENT: matching it would flag `.check input`,
// an 18px glyph whose real target is the wrapping <label>, which already passes at var(--tap).
const BARE_CONTROL_TAGS = ['button', 'a', 'select', 'textarea'];

// Derived from each component's MARKUP, never a hand-maintained list, which silently skips a control under a selector
// nobody remembered to add. Interactive = a bare interactive tag, or an interaction hook (`onclick`, `role="button"`,
// `tabindex`); a rule is a control iff the SUBJECT of its selector targets one, matched hash-agnostically because
// Svelte's compile-time `.svelte-xxxxx` class is not in authored source.
export function markupControls(src: string): { tags: Set<string>; classes: Set<string> } {
	const tags = new Set<string>();
	const classes = new Set<string>();
	for (const m of src.matchAll(/<([a-zA-Z][\w-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/g)) {
		const tag = m[1]!.toLowerCase();
		const attrs = m[2]!;
		const hasHandler = /(^|\s)onclick[\s=]/.test(attrs);
		const isButtonRole = /(^|\s)role\s*=\s*["']button["']/.test(attrs);
		const isTabbable = /(^|\s)tabindex[\s=]/.test(attrs);
		const isLink = tag === 'a' && /(^|\s)href[\s=]/.test(attrs);
		// A checkbox/radio delegates its target to the wrapping <label>, so its own 18px box is a false offender.
		const isGlyphInput = tag === 'input' && /(^|\s)type\s*=\s*["'](?:checkbox|radio)["']/.test(attrs);
		const isFormControl = (tag === 'input' || tag === 'select' || tag === 'textarea') && !isGlyphInput;
		if (!(hasHandler || isButtonRole || isTabbable || isLink || isFormControl)) continue;
		if (BARE_CONTROL_TAGS.includes(tag)) tags.add(tag);
		if (isLink) tags.add('a');
		const cls = attrs.match(/(?:^|\s)class\s*=\s*"([^"]*)"/);
		if (cls) for (const t of cls[1]!.trim().split(/\s+/)) if (t) classes.add(t);
	}
	return { tags, classes };
}

/**
 * Does `token` appear as a CLASS anywhere in `src`? All three routes count — a static `class="a b c"` list, a
 * `class:token` directive, a `.token` <style> rule — because a `.token` query matches an element that got it by any.
 *
 * The `class="…"` arm compares WHOLE tokens, never a `\b…\b` substring: a word boundary breaks on `-`, so
 * `class="badqr-b"` satisfies a query for `b` and `class="pill {a.outcome}"` one for `a`.
 */
export function classPresent(src: string, token: string): boolean {
	const t = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	for (const m of src.matchAll(/class="([^"]*)"/g)) {
		const tokens = m[1]!
			.replace(/\{[^}]*\}/g, ' ')
			.split(/\s+/)
			.filter(Boolean);
		if (tokens.includes(token)) return true;
	}
	// The directive and the <style> rule both name the class in full, so `\b` is exact for them.
	if (new RegExp(`class:${t}\\b`).test(src)) return true;
	if (new RegExp(`\\.${t}\\b`).test(src)) return true;
	return false;
}
