// Guard for the phone home page's own controls. SvelteKit reserves `+`-prefixed names inside routes/, so this cannot
// be `+page.test.ts`. Separate from touch-targets.test.ts because that repo-wide guard only flags a control
// declaring an explicit height BELOW the standard; one sized purely by `padding` slips its net entirely. The Undo
// button in the remove toast was exactly that — `padding: 6px 12px`, no height, ~30px tall: the one control under
// the app's 44px floor and the one on a 5-second timer.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { TAP } from '@encore/test-support/scan';
import { at } from '@encore/test-support';

const PAGE = at('src/routes/+page.svelte');
const SONNER = at('src/lib/components/ui/sonner/sonner.svelte');

/** Body of the first `<style>`-scoped rule whose selector matches `sel`. */
function ruleBody(src: string, sel: string): string | null {
	const re = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`, 's');
	const m = src.match(re);
	return m ? m[1]! : null;
}

test('the Undo toast control reaches the tap floor (padding-only guard gap)', () => {
	const src = readFileSync(SONNER, 'utf8');
	const body = ruleBody(src, ':global([data-sonner-toast] [data-button])');
	expect(body).not.toBeNull();
	// The floor must come from a height the box actually reserves, not from padding the structural guard cannot resolve.
	const heights = [...body!.matchAll(/(?:min-)?height:\s*([0-9.]+)px/g)].map((x) => Number(x[1]));
	const tokened = /(?:min-)?height:\s*var\(--tap\)/.test(body!);
	expect(tokened || heights.some((h) => h >= TAP)).toBe(true);
});

// The error toast was drawn across the Undo button (5s timer, un-tappable): two independent defects, neither visible
// to a guard that reads one selector in isolation.

test('the docked toast declares a width a phone can actually use (S5, was the left:50% gap)', () => {
	const src = readFileSync(PAGE, 'utf8');
	// Caught two hand-rolled toasts that were `position: fixed` with `left: 50%; transform: translateX(-50%)` and
	// `right: auto`, which shrink-to-fit into 50vw and make a declared `max-width` inert — every real "title - artist"
	// then wrapped at half the viewport and collided with the toast above. Positioning is sonner's now, whose default
	// width is a fixed 356px box, so the claim is re-aimed: viewport-relative.
	const at = src.indexOf('<Toaster');
	expect(at, 'the page no longer renders a <Toaster>').toBeGreaterThan(-1);
	const toaster = src.slice(at, src.indexOf('/>', at));
	expect(toaster, 'the Toaster must declare --width').toContain('--width:');
	expect(/[0-9]+vw/.test(toaster), 'the width must be viewport-relative, not a fixed pixel box').toBe(true);
});
