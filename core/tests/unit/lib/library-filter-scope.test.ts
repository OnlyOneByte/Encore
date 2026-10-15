import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '$test';

/*
 * guard: /library's THREE SCOPES stay apart, and its two zero-state sentences stay well-formed.
 *
 * Geometry and runtime are not assertable here — `bun test` has no layout and this tree mounts no components
 * (see bunfig.toml). What IS assertable, and what each of these three defects actually was, is the WIRING and
 * the STRINGS in this route's source:
 *
 *  1. The field's X reached outside the field. `clearable={dirty}` drew it whenever a facet chip was picked, so
 *     an X sat inside a visibly empty input, and `onclear={clearFilters}` un-pressed that chip when it was
 *     tapped — measured: artist chip + the typo "wonderwll" + one tap on the X took the count from "0 of 133"
 *     to "133 songs" and the eyebrow from "Sort & filter · Blur" back to "Sort & filter".
 *  2. The filtered-to-nothing sentence was built inline across two lines, and Svelte trims the leading
 *     whitespace of a branch fragment's first text node — so it rendered "Nothing here matches“zzqq”." with the
 *     glyph rects 0.00px apart.
 *  3. A failed /api/library fetch rendered the EMPTY-library copy. The arms are ordered, so the only thing that
 *     keeps "No karaoke tracks yet" off that path is the failure arm sitting above it.
 */

const route = readFileSync(at('src/routes/library/+page.svelte'), 'utf8');
const home = readFileSync(at('src/routes/+page.svelte'), 'utf8');
const readiness = readFileSync(at('src/lib/readiness.ts'), 'utf8');

/** The body of a top-level `function <name>() { … }` in the route's `<script>`, brace-matched. */
function fn(name: string): string {
	const start = route.indexOf(`function ${name}() {`);
	expect(start).toBeGreaterThan(-1);
	let depth = 0;
	for (let i = route.indexOf('{', start); i < route.length; i++) {
		if (route[i] === '{') depth++;
		else if (route[i] === '}' && --depth === 0) return route.slice(start, i + 1);
	}
	throw new Error(`unbalanced braces in ${name}()`);
}

test('the field X is scoped to the BOX — both the gate and the handler', () => {
	// The gate reads the live `query` only. Either facet term back in it puts the X over an empty field again.
	expect(route).toMatch(/const boxHasText = \$derived\(query\.trim\(\)\.length > 0\);/);
	expect(route).not.toContain('const dirty = $derived');
	// And it is `query`, not `appliedQuery`: the documented reason the gate exists at all is that the X must
	// appear on keystroke 1 rather than 150ms after the last one.
	expect(route).not.toMatch(/const boxHasText = \$derived\(appliedQuery/);

	// Wired to the field-scoped handler. These two lines live in a multi-line attribute list prettier reflows,
	// so they are asserted individually rather than as one block.
	expect(route).toContain('clearable={boxHasText}');
	expect(route).toContain('onclear={clearQuery}');
	expect(route).not.toContain('onclear={clearFilters}');

	// The handler clears the TEXT and nothing else. A facet reset here is the whole defect.
	const clearQuery = fn('clearQuery');
	expect(clearQuery).toContain("query = ''");
	expect(clearQuery).not.toContain('pickedArtist');
	expect(clearQuery).not.toContain('pickedTag');
	// Both behaviours that were already correct and must not regress with the narrowing: the pending timer is
	// cancelled FIRST (or the in-flight keystroke re-applies 150ms later), and focus returns to the input.
	expect(clearQuery.indexOf('clearTimeout(filterTimer)')).toBeLessThan(clearQuery.indexOf("query = ''"));
	expect(clearQuery).toContain('queryEl?.focus()');

	// `/`'s twin is the idiom this restores — the same component, wired to its query alone.
	expect(home).toContain('clearable={searchActive}');
});

test('clearing EVERYTHING is still what the zero-state control does', () => {
	// The other scope is unchanged and still reachable: `clearFilters` resets the box AND the facets, which is
	// correct for the filtered-to-nothing button and is why the two handlers are not one.
	const clearFilters = fn('clearFilters');
	expect(clearFilters).toContain('pickedArtist = null');
	expect(clearFilters).toContain('pickedTag = null');
	expect(route).toContain('onclick={clearFilters}');
});

test('the filtered-to-nothing sentence carries its space, and holds no inline branch', () => {
	// The literal, with U+0020 between "matches" and U+201C. Derived rather than copied: the assertion builds the
	// expected text from the codepoints so a lookalike (U+00A0, or the quote jammed back against the "s") reds.
	const expected = `Nothing here matches ${String.fromCodePoint(0x201c)}\${appliedQuery.trim()}${String.fromCodePoint(0x201d)}.`;
	expect(route).toContain(expected);
	// The no-query branch must not render a dangling quote pair.
	expect(route).toContain("'Nothing here matches.'");
	// And the markup is ONE expression: an inline `{#if}` across two lines is what ate the space.
	expect(route).toContain('<Empty.Description>{emptyLabel}</Empty.Description>');
	expect(route).not.toContain('&ldquo;');

	// Spelled the same as the sibling sentence `/` renders through `noRowsState`, so two surfaces describing the
	// same outcome do not disagree about punctuation. readiness.ts is NOT edited by this guard — only read.
	expect(readiness).toContain(`Nothing matches ${String.fromCodePoint(0x201c)}`);
});

test('a failed fetch is checked BEFORE the empty-library arm, and keeps existing rows', () => {
	const failed = route.indexOf('{:else if libraryFailed && library.length === 0}');
	const empty = route.indexOf('{:else if library.length === 0}');
	expect(failed).toBeGreaterThan(-1);
	expect(empty).toBeGreaterThan(-1);
	// Ordered, because these are `{:else if}` arms: below the empty arm it would be unreachable, and the page
	// would still claim "No karaoke tracks yet" over a library it simply could not ask about.
	expect(failed).toBeLessThan(empty);
	// The skeleton still wins over both, so a request in flight is never an error.
	expect(route.indexOf('{#if !libraryLoaded}')).toBeLessThan(failed);

	// `library.length === 0` is load-bearing: `refreshLibrary()` also runs on every `media:status` ready event,
	// and one of those failing must not replace a working shelf with an apology.
	expect(route).not.toContain('{:else if libraryFailed}');

	const arm = route.slice(failed, empty);
	expect(arm).toContain("Couldn't reach the server — your library didn't load.");
	expect(arm).toContain('void room.refreshLibrary()');
	expect(arm).toContain('Try again');
	// Description-only with a retry, the register `/`'s own search-failure arm uses — no Empty.Title, because a
	// failure is not a named state of the library.
	expect(arm).not.toContain('Empty.Title');
	expect(home).toContain("Couldn't reach the server — your search didn't run.");

	// And the arrival repair, which is what makes a later tab tap recover a blip that happened at join.
	expect(route).toContain('if (room.libraryFailed) void room.refreshLibrary();');
	expect(route).toContain('libraryFailed = room.libraryFailed;');
});
