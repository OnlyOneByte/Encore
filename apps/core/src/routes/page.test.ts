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
import { join } from 'node:path';

const PAGE = join(import.meta.dir, '+page.svelte');
const TAP = 44;

/** Body of the first `<style>`-scoped rule whose selector matches `sel`. */
function ruleBody(src: string, sel: string): string | null {
	const re = new RegExp(`${sel.replace(/[.\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`, 's');
	const m = src.match(re);
	return m ? m[1]! : null;
}

test('the Undo toast control reaches the 44px floor (padding-only guard gap)', () => {
	const src = readFileSync(PAGE, 'utf8');
	const body = ruleBody(src, '.undo-toast button');
	expect(body).not.toBeNull();
	// 44px must come from a height the box actually reserves, not from padding the structural guard
	// cannot resolve. Pre-fix this rule had only `padding` and no height → this assertion is RED.
	const heights = [...body!.matchAll(/(?:min-)?height:\s*([0-9.]+)px/g)].map((x) => Number(x[1]));
	expect(heights.some((h) => h >= TAP)).toBe(true);
});

// ── Issue #108: the error toast was drawn across the Undo button (5s timer, un-tappable). ─────────
// Two independent defects composed it, and neither is visible to any rule-body guard that reads one
// selector in isolation — so both are pinned here structurally.

test('the docked toasts use the width they declare, not a left:50% shrink-to-fit', () => {
	const src = readFileSync(PAGE, 'utf8');
	// A `position: fixed` box with `left: 50%; transform: translateX(-50%)` and `right: auto`
	// shrink-to-fits into (containing block − left offset) = 50vw, making `max-width: 90vw` inert.
	// Every real "title — artist" then wraps at half the viewport and the toast grows tall enough to
	// collide with the error toast above it. The fix docks both edges (`left:0; right:0`) so the
	// declared width is reachable. Pre-fix each rule had `left: 50%` + `translateX(-50%)` → RED.
	for (const sel of ['.undo-toast', '.error-toast']) {
		const body = ruleBody(src, sel);
		expect(body, `${sel} rule missing`).not.toBeNull();
		expect(body!, `${sel} must not left:50% shrink-to-fit`).not.toMatch(/left:\s*50%/);
		expect(body!, `${sel} must not translateX its own width`).not.toMatch(/translateX\(-50%\)/);
	}
});

test('the error toast docks off the undo toast MEASURED height, not a hand-picked constant', () => {
	const src = readFileSync(PAGE, 'utf8');
	const root = ruleBody(src, ':root');
	expect(root).not.toBeNull();
	const m = root!.match(/--error-dock:\s*([^;]+);/);
	expect(m, '--error-dock token missing').not.toBeNull();
	// The undo toast's height is content-dependent and unbounded (a real title wraps to several
	// lines), so ANY fixed px reserve is the same overlap bug at a longer title. The offset must be
	// expressed against the toast's real measured height, published as --undo-h from its clientHeight.
	// Pre-fix `--error-dock: calc(var(--peek-h) + 70px)` names no measured height → RED.
	expect(m![1]!, '--error-dock must reference the measured --undo-h').toContain('--undo-h');
	// And the page must actually bind that height and publish the token, or --undo-h is a dead ref.
	expect(src, 'undo toast must bind:clientHeight').toMatch(/class="undo-toast"[^>]*bind:clientHeight/);
	expect(src, "--undo-h must be published from script").toMatch(/setProperty\(\s*['"]--undo-h['"]/);
});
