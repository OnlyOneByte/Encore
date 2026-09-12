// Guard for the phone home page's own controls (sibling of +page.svelte).
//
// NB filename: SvelteKit reserves `+`-prefixed names inside routes/, so this cannot be
// `+page.test.ts`; `page.test.ts` colocates with the page it guards without being treated as a route.
//
// WHY THIS EXISTS SEPARATELY FROM touch-targets.test.ts. That repo-wide guard only flags a control
// that declares an explicit `height`/`min-height` BELOW the standard; a control sized purely by
// `padding` slips through its net entirely. The Undo button in the remove toast was exactly that —
// `padding: 6px 12px`, no height, ~30px tall — the one interactive control on the phone under the
// app's 44px floor and the one on a 5-second timer, yet invisible to the structural guard. This pins
// it by name and closes the padding-only escape hatch for THIS control.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { TAP } from '$lib/test-helpers';
import { at } from '@encore/test-support';

// Both subjects are named absolutely. PAGE used to be `at('src/routes/+page.svelte')`
// — "the page next to me", which identified the phone home page only while this test sat in routes/.
const PAGE = at('src/routes/+page.svelte');
const SONNER = at('src/lib/components/ui/sonner/sonner.svelte');

/** Body of the first `<style>`-scoped rule whose selector matches `sel`. */
function ruleBody(src: string, sel: string): string | null {
	/*
	 * S5: escape EVERY regex metacharacter, not just `.` and `\`. An attribute selector such as
	 * `[data-sonner-toast] [data-button]` was otherwise compiled with its brackets intact and matched as
	 * a character class, so the rule was reported missing from a file that plainly declares it.
	 */
	const re = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`, 's');
	const m = src.match(re);
	return m ? m[1]! : null;
}

test('the Undo toast control reaches the tap floor (padding-only guard gap)', () => {
	/*
	 * S5: the control moved into ui/sonner, so this reads THERE. Undo is a real toast ACTION now
	 * rather than a button this page positions, and sonner renders it with its own `[data-button]`
	 * attribute — which is what the rule is keyed on, because sonner's own attribute survives a
	 * re-vendor where a class of ours would not.
	 *
	 * The claim is unchanged, and so is the reason it exists: this is the one interactive control on the
	 * phone that fell under the app's own tap floor, and it sits on a five-second timer, which makes it
	 * the hardest to hit in time.
	 */
	const src = readFileSync(SONNER, 'utf8');
	const body = ruleBody(src, ':global([data-sonner-toast] [data-button])');
	expect(body).not.toBeNull();
	// The floor must come from a height the box actually reserves, not from padding the structural guard
	// cannot resolve. Pre-fix this rule had only `padding` and no height → this assertion is RED.
	// Accepts the TOKEN as well as a literal at or above the floor, because the control now names
	// var(--tap) — the number-only regex here would have failed the correct spelling.
	const heights = [...body!.matchAll(/(?:min-)?height:\s*([0-9.]+)px/g)].map((x) => Number(x[1]));
	const tokened = /(?:min-)?height:\s*var\(--tap\)/.test(body!);
	expect(tokened || heights.some((h) => h >= TAP)).toBe(true);
});

// ── The error toast was drawn across the Undo button (5s timer, un-tappable). ─────────────────────
// Two independent defects composed it, and neither is visible to any rule-body guard that reads one
// selector in isolation — so both are pinned here structurally.

test('the docked toast declares a width a phone can actually use (S5, was the left:50% gap)', () => {
	const src = readFileSync(PAGE, 'utf8');
	/*
	 * THE BUG THIS EXISTS FOR. Encore's two hand-rolled toasts were `position: fixed` with
	 * `left: 50%; transform: translateX(-50%)` and `right: auto`, which shrink-to-fits into
	 * (containing block - left offset) = 50vw and makes a declared `max-width` inert. Every real
	 * "title - artist" then wrapped at half the viewport and grew tall enough to collide with the toast
	 * above it.
	 *
	 * S5 handed positioning to sonner, so the two rules this used to read are gone -- but the
	 * hazard belongs to ANY centred fixed toast, not to those rules, and sonner's own default width is a
	 * fixed 356px box. So the claim is re-aimed rather than retired: the Toaster must declare a
	 * VIEWPORT-RELATIVE width, which is what stops a long title wrapping into a tall stack on a narrow
	 * phone.
	 */
	const at = src.indexOf('<Toaster');
	expect(at, 'the page no longer renders a <Toaster>').toBeGreaterThan(-1);
	const toaster = src.slice(at, src.indexOf('/>', at));
	expect(toaster, 'the Toaster must declare --width').toContain('--width:');
	expect(/[0-9]+vw/.test(toaster), 'the width must be viewport-relative, not a fixed pixel box').toBe(true);
});

/*
 * RETIRED BY S5 (XR-VER-07): 'the error toast docks off the undo toast MEASURED height'.
 *
 * It pinned `--error-dock: calc(... + var(--undo-h) ...)` against a real bug -- the undo toast's height
 * is content-dependent and unbounded, so ANY fixed px reserve is the same overlap at a longer title.
 * Its premise was that there are TWO independently positioned toasts, one of which must offset off the
 * other's measured height.
 *
 * Sonner stacks its own toasts, so there is no second surface to offset and no height to publish:
 * `--error-dock`, `--undo-h`, the `bind:clientHeight` and the `setProperty` effect are all deleted
 * rather than ported. A guard for the offset BETWEEN two surfaces cannot fail when there is one, and
 * the overlap it existed to prevent is now structurally impossible instead of merely pinned.
 *
 * The tap-floor arm and the width arm are what remain of this trio, both re-aimed at the new
 * implementation rather than deleted.
 */
