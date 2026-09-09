// Shared helpers for the source-scanning guard tests under src/lib and e2e/.
//
// Dedup batch (#626, follows #618/#455): the recursive `.svelte` walker below was hand-copied
// verbatim into every guard that scans the component tree (motion, contrast, design-system,
// icon-centring, settings-scopes, singer-color, touch-targets, tv/stage-scale, …), and the 44px
// touch-target threshold `TAP` was re-declared in each touch guard. There is no production
// constant for 44 — the standard lives only in these tests — so it is single-sourced here rather
// than imported from src.
//
// SCOPE IS THE POINT (#841, XR-VER-14). Four of the five named scan helpers were still per-file
// copies: `styleFiles` in components/motion.test.ts, `markupControls` in touch-targets.test.ts,
// `allSvelte` and `classPresent` in e2e/contract.test.ts. These helpers decide WHAT A GUARD CAN
// SEE, so a copy that drifts — a different glob, a missed directory, an extra exclusion — silently
// narrows one guard's population while the others keep their own answer. The guard still passes, on
// a smaller surface, and nothing says so. `motion.test.ts` needed its scope widened in isolation
// (#177) for exactly that reason. They are all defined here now, once, and `test-helpers.test.ts`
// reds if any of these five NAMES is declared or called in a consumer without importing it. That
// guard is name-keyed and does not catch a rival walker under a different name — three consumers
// carry one today (`tsSources`, `tsFiles`, `allDrivers`), which is a separate, reported issue.
import { join } from 'node:path';
import { readdirSync } from 'node:fs';

/**
 * Directories a source walk must never descend into (XR-VER-14 Acceptance).
 *
 * `.svelte-kit/` and `build/` hold BUILT COPIES of every component's CSS. A walk that reaches them
 * reads stale duplicates and reports on colours the app no longer paints — XR-VER-08's failure mode
 * arriving through the scope door. They sit beside `src/` today rather than inside it, so no current
 * caller reaches them; this is the exclusion set being present at the one place scope is decided
 * instead of at the one guard (`telemetry-frame-lean.test.ts`) that happened to carry it.
 *
 * There is deliberately no allowlist of directories to INCLUDE. Every walk below is unconditionally
 * recursive, so a new source directory — `src/lib/components/ui/`, the design-library copy-in target
 * — is in scope by construction rather than by someone remembering to add it.
 */
export const SKIP_DIRS = new Set(['node_modules', 'build', '.svelte-kit', 'dist', '.git']);

/**
 * THE recursive source walk. Every helper below is a named extension filter over this one function,
 * so the walk's scope — what it descends into and what it skips — has exactly one definition and one
 * edit brings every guard's scope with it.
 */
function walk(dir: string, keep: (name: string) => boolean): string[] {
	const out: string[] = [];
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, ent.name);
		if (ent.isDirectory()) {
			if (SKIP_DIRS.has(ent.name)) continue;
			out.push(...walk(p, keep));
		} else if (keep(ent.name)) out.push(p);
	}
	return out;
}

/** Recursively collect every `.svelte` file under `dir` (absolute paths). */
export function svelteFiles(dir: string): string[] {
	return walk(dir, (n) => n.endsWith('.svelte'));
}

/**
 * `svelteFiles` DELIBERATELY WIDENED to `.css` as well — this is not a drifted copy and must not be
 * flattened into `svelteFiles`. The CSS this repo animates lives in two places: component `<style>`
 * blocks (inside `.svelte`) and the shared design system (`src/app.css`), so the motion guard's
 * scan would be blind to `app.css` — including its `@keyframes` — if it walked `.svelte` only. Every
 * caller that must see standalone stylesheets uses this; callers reading markup use `svelteFiles`.
 */
export function styleFiles(dir: string): string[] {
	return walk(dir, (n) => n.endsWith('.svelte') || n.endsWith('.css'));
}

/** The app's self-imposed minimum interactive touch-target size, in px (WCAG 2.5.8 is 24; the app
 *  set itself the stricter 44). Only the touch-target guards reference it. */
export const TAP = 44;

// Bare element selectors we honour as controls. `input` is deliberately absent: no box-sizing
// input rule in these surfaces is written element-only — text inputs carry a class
// (.name-input / .text), the range slider is attribute-targeted (input[type='range']), and a
// checkbox/radio is a UA glyph inside a <label> that owns the tap target. Matching bare `input`
// would flag `.check input` (an 18px checkbox glyph) whose real target — the label — already
// passes at var(--tap).
const BARE_CONTROL_TAGS = ['button', 'a', 'select', 'textarea'];

/*
 * Derive the interactive-control selector set from the MARKUP of each component, not from a
 * hand-maintained literal list. The old `CONTROL` allowlist decided what counted as a control by a
 * regex someone had to remember to extend; a control introduced under any selector nobody added was
 * silently skipped and shipped undersized green (issue #400 — a renamed strip's `.pills`/`.pill`
 * escaped 44px scrutiny entirely). The FILES tree-walk already closed the file dimension; this closes
 * the selector dimension by the same principle: read what the markup says is interactive.
 *
 * An element is interactive if it is a bare interactive tag (`<button>`, `<a href>`, `<input>`,
 * `<select>`, `<textarea>`) or carries an interaction hook (`onclick`, `role="button"`, `tabindex`).
 * We collect the CLASS TOKENS of every such element plus which bare tags appeared. A CSS rule is then
 * a control iff the SUBJECT of its selector (the last compound, after the final combinator) targets a
 * bare interactive tag or any interactive class token — matched hash-agnostically, since Svelte adds a
 * `.svelte-xxxxx` scope class at compile time that never appears in authored source.
 */
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
		// a checkbox/radio is a platform glyph sized by the UA; its tap target is delegated to the
		// wrapping <label> (see `.check` in settings, which itself carries min-height: var(--tap)), so
		// its own 18px box is not the control and would be a false offender.
		const isGlyphInput = tag === 'input' && /(^|\s)type\s*=\s*["'](?:checkbox|radio)["']/.test(attrs);
		const isFormControl = (tag === 'input' || tag === 'select' || tag === 'textarea') && !isGlyphInput;
		if (!(hasHandler || isButtonRole || isTabbable || isLink || isFormControl)) continue;
		// only honour a BARE element selector for tags whose box rules are written element-only here
		if (BARE_CONTROL_TAGS.includes(tag)) tags.add(tag);
		if (isLink) tags.add('a');
		const cls = attrs.match(/(?:^|\s)class\s*=\s*"([^"]*)"/);
		if (cls) for (const t of cls[1]!.trim().split(/\s+/)) if (t) classes.add(t);
	}
	return { tags, classes };
}

/**
 * Does `token` appear as a CLASS anywhere in `src`? A class is reached three ways in Svelte source —
 * a static `class="a b c"` list, a `class:token` directive, or a `.token` rule in <style> — and the
 * flow's `.token` query matches an element that got the class by ANY of them, so all three count.
 *
 * The class="..." arm compares WHOLE tokens, not a `\b…\b` substring (#682). A word boundary treats
 * `-` as a break, so `class="badqr-b"` used to resolve the bare token `b`, and a Svelte
 * interpolation `class="pill {a.outcome}"` used to resolve the JS identifier `a` — both are dead
 * classes no element carries, yet the guard whose job is to red on a vanished anchor waved them
 * through. So split the quoted value into real tokens: blank out `{…}` interpolations first (the
 * expression names a variable, not a static class), then split on whitespace and match `token`
 * exactly. The `class:token` directive and `.token` <style> arms already name the class in full, so
 * a `\b` boundary is exact for them (it only differs from an exact match on a following `-`, and no
 * `class:foo-bar` / `.foo-bar` rule can satisfy a query for `foo`); they are unchanged.
 */
export function classPresent(src: string, token: string): boolean {
	const t = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	// inside a class="..." attribute: exact token match against the whitespace-split value, with
	// `{…}` interpolations blanked so an interpolated expression cannot masquerade as a static class.
	for (const m of src.matchAll(/class="([^"]*)"/g)) {
		const tokens = m[1]!
			.replace(/\{[^}]*\}/g, ' ')
			.split(/\s+/)
			.filter(Boolean);
		if (tokens.includes(token)) return true;
	}
	// class:token directive
	if (new RegExp(`class:${t}\\b`).test(src)) return true;
	// a .token rule in <style>
	if (new RegExp(`\\.${t}\\b`).test(src)) return true;
	return false;
}
