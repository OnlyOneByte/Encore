// Shared helpers for the source-scanning guard tests. These decide WHAT A GUARD CAN SEE, so they are single-sourced: a
// drifted per-file copy narrows one guard's population while the others keep their own answer, and it still passes on
// the smaller surface. `test-helpers.test.ts` reds if any of these NAMES is used in a consumer without importing it.
import { filesIn, read } from './tree.ts';

/** The one walk's exclusion set, re-exported because `test-helpers.test.ts` asserts on it here. */
export { SKIP_DIRS } from './tree.ts';

/** Recursively collect every `.svelte` file under `dir` (absolute paths, sorted). */
export function svelteFiles(dir: string): string[] {
	return filesIn(dir, ['.svelte']);
}

/**
 * `svelteFiles` DELIBERATELY WIDENED to `.css`, and it must not be flattened back: the CSS this repo animates lives in
 * component `<style>` blocks AND in `src/app.css`, so a `.svelte`-only walk is blind to `app.css`'s `@keyframes`.
 */
export function styleFiles(dir: string): string[] {
	return filesIn(dir, ['.svelte', '.css']);
}

/**
 * The standard the design committed to (WCAG 2.5.8 asks 24; the app set itself 44). A FLOOR, not an equality: raising
 * `--tap` is the design's to choose, lowering it past the commitment is the regression a derived constant would follow.
 */
export const TAP_FLOOR = 44;

/**
 * The minimum interactive touch-target size in px, READ OUT OF `app.css`, so `var(--tap)` in a component and `TAP` in a
 * guard are one fact. Hence changing `--tap` alone stays green, while reverting one control to a bare `44px` reds:
 * `expressesTap` asks for the token, not the number.
 */
export const TAP = readTapToken();

function readTapToken(): number {
	// Anchored at the repo root via `read()`, never at this file: a `join(import.meta.dir, '..')` hop re-points silently
	// when the module moves, and `read()` throws on a miss rather than returning ''.
	const css = read('src', 'app.css');
	const m = css.match(/--tap:\s*([0-9.]+)px\s*;/);
	// No soft fallback to 44: a missing declaration means the token layer moved, and every touch guard downstream would
	// then measure against a number nothing declares any more.
	if (!m) throw new Error('app.css declares no `--tap: <n>px` token — the touch guards have no standard to read');
	return Number(m[1]);
}

/**
 * Does a rule body express a box dimension as the TOKEN rather than its number? `var(--tap)` and `clamp(var(--tap), …)`
 * count — the latter is how the TV keeps the floor while scaling with the room. A bare `44px` does NOT, even while 44 is
 * what `--tap` holds: that equality is a coincidence, not a binding.
 */
export function expressesTap(body: string): boolean {
	return /(?:min-)?(?:width|height)\s*:[^;]*var\(--tap\)/.test(body);
}

/** The offender shape: right size today, drifts the moment `--tap` moves. */
export function restatesTapNumber(body: string, tap: number = TAP): boolean {
	return new RegExp(`(?:min-)?(?:width|height)\\s*:[^;]*(?<![0-9.])${tap}px`).test(body);
}

// Bare element selectors honoured as controls. `input` is deliberately ABSENT: no box-sizing input rule here is written
// element-only, and matching it would flag `.check input` — an 18px glyph whose real target, the wrapping <label>,
// already passes at var(--tap).
const BARE_CONTROL_TAGS = ['button', 'a', 'select', 'textarea'];

// Derive the interactive-control selector set from each component's MARKUP, never a hand-maintained list: a control
// under a selector nobody remembered to add was silently skipped and shipped undersized green. Interactive = a bare
// interactive tag, or an interaction hook (`onclick`, `role="button"`, `tabindex`). A rule is a control iff the SUBJECT
// of its selector (the last compound, after the final combinator) targets one of those — matched hash-agnostically,
// since Svelte's compile-time `.svelte-xxxxx` scope class is not in authored source.
export function markupControls(src: string): { tags: Set<string>; classes: Set<string> } {
	const tags = new Set<string>();
	const classes = new Set<string>();
	// each opening tag: <tag ...attrs...>  (self-closing or not; we only need the attr text)
	for (const m of src.matchAll(/<([a-zA-Z][\w-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/g)) {
		const tag = m[1]!.toLowerCase();
		const attrs = m[2]!;
		const hasHandler = /(^|\s)onclick[\s=]/.test(attrs);
		const isButtonRole = /(^|\s)role\s*=\s*["']button["']/.test(attrs);
		const isTabbable = /(^|\s)tabindex[\s=]/.test(attrs);
		const isLink = tag === 'a' && /(^|\s)href[\s=]/.test(attrs);
		// A checkbox/radio is a UA glyph whose tap target is delegated to the wrapping <label>, so its own 18px box is
		// not the control and would be a false offender.
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
 * Does `token` appear as a CLASS anywhere in `src`? All three routes count, because a `.token` query matches an element
 * that got the class by any of them: a static `class="a b c"` list, a `class:token` directive, a `.token` <style> rule.
 *
 * The `class="…"` arm compares WHOLE tokens, never a `\b…\b` substring: a word boundary breaks on `-`, so
 * `class="badqr-b"` resolved the bare token `b` and `class="pill {a.outcome}"` resolved `a` — dead classes waved through
 * by the guard whose job is to red on a vanished anchor. Hence blanking `{…}` then an exact whitespace-split match.
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
	// The `class:token` directive and a `.token` <style> rule both name the class in full, so `\b` is exact for them:
	// no `class:foo-bar` or `.foo-bar` can satisfy a query for `foo`.
	if (new RegExp(`class:${t}\\b`).test(src)) return true;
	if (new RegExp(`\\.${t}\\b`).test(src)) return true;
	return false;
}
