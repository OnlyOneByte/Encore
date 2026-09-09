// Shared helpers for the source-scanning guard tests under src/lib and e2e/.
//
// Dedup batch (#626, follows #618/#455): the recursive `.svelte` walker below was hand-copied
// verbatim into every guard that scans the component tree (motion, contrast, design-system,
// icon-centring, settings-scopes, singer-color, touch-targets, tv/stage-scale, …), and the 44px
// touch-target threshold `TAP` was re-declared in each touch guard. It is single-sourced here — and
// since #831 it is READ FROM `app.css` rather than hand-written, so the guards and the components
// resolve the same token instead of two numbers that merely agreed.
import { join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
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

/**
 * THE STANDARD ITSELF, as a number the design committed to (WCAG 2.5.8 is 24; the app set itself the
 * stricter 44). This is the one place 44 is written down outside `app.css`, and it is deliberately a
 * FLOOR rather than an equality: raising `--tap` is a design decision the guards must allow, lowering
 * it below the commitment is the regression they exist to catch.
 */
export const TAP_FLOOR = 44;

/**
 * The app's minimum interactive touch-target size, in px, READ OUT OF `app.css` (issue #831, XR-PH-01).
 *
 * It used to be a hand-written `44` here, and the comment above said outright that no production
 * constant existed. That made every touch guard measure against a number the design layer did not
 * supply: `--tap: 48px` in `app.css` left this at 44, so a control still spelling the old literal
 * measured GREEN against a standard that had moved. The number was pinned; the BINDING was not.
 *
 * Parsing it here is what makes `var(--tap)` in a component and `TAP` in a guard the same fact. Two
 * consequences the guards rely on, both intentional:
 *
 *   - Changing `--tap` in `app.css` alone stays GREEN, because every control names the token and this
 *     constant follows it. That is the point: the value is the design's to choose.
 *   - Reverting any one control to a bare `44px` REDS, because `expressesTap` below asks for the token
 *     rather than for the number. That is the expression being bound rather than coincidentally equal.
 *
 * `TAP_FLOOR` keeps the other direction honest: a `--tap` edited BELOW the commitment reds too, since
 * a derived constant on its own would happily lower the bar and report success.
 */
export const TAP = readTapToken();

function readTapToken(): number {
	const css = readFileSync(join(import.meta.dir, '..', 'app.css'), 'utf8');
	const m = css.match(/--tap:\s*([0-9.]+)px\s*;/);
	// not a soft fallback to 44: a missing declaration means the token layer moved and every touch
	// guard downstream would silently measure against a number nothing declares any more.
	if (!m) throw new Error('app.css declares no `--tap: <n>px` token — the touch guards have no standard to read');
	return Number(m[1]);
}

/**
 * Does a CSS rule body express a box dimension as the TOKEN rather than as the token's number?
 *
 * The two forms that count are `var(--tap)` on its own and `clamp(var(--tap), …)`, which is how the TV
 * expresses the same floor while still scaling with the room. A bare `44px` does not count even while
 * 44 is what `--tap` happens to hold — that equality is the coincidence this predicate refuses to
 * accept as a binding.
 */
export function expressesTap(body: string): boolean {
	return /(?:min-)?(?:width|height)\s*:[^;]*var\(--tap\)/.test(body);
}

/**
 * Does a CSS rule body size a box with the token's number written as a BARE px literal? This is the
 * offender shape for XR-PH-01: the control is the right size today and drifts the moment `--tap` moves.
 */
export function restatesTapNumber(body: string, tap: number = TAP): boolean {
	return new RegExp(`(?:min-)?(?:width|height)\\s*:[^;]*(?<![0-9.])${tap}px`).test(body);
}

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
