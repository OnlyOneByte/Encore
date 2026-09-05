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
