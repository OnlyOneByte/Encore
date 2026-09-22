// The now-playing sheet's head and body share ONE measure, and both must keep it.
//
// THE DEFECT. `NowPlayingDrawer` caps its head and its body at `--max-w` and centres them, in a single
// rule with two selectors:
//
//     :global(.np-head),
//     .np-body { width: 100%; max-width: var(--max-w); margin-inline: auto; min-width: 0 }
//
// A new rule was inserted BETWEEN those two selectors. The head silently left the list, picked up the
// declarations of the rule that now followed its comma, and went FULL-BLEED at every width above
// `--max-w`: on a 1639px window the song title and the `···` sat pinned to the window edges while the
// transport, the guiding track and the range were centred 280px inside them. The sheet read as two
// different components stacked.
//
// WHY NOTHING CAUGHT IT, which is the reason this file exists rather than a comment:
//   - `app-class-resolution.test.ts` asks whether a class matches SOME rule that can reach it.
//     `.np-head` still did — the wrong one — so it was satisfied.
//   - `gate:measured` drives phone viewports (390/360/430), and below `--max-w` a capped box and an
//     uncapped one are the same width. The bug is invisible at every viewport that gate uses.
//   - the head is rendered by a COMPONENT (`<Drawer.Header class="np-head">`), so its rule must be
//     `:global()` — which puts it in exactly the kind of selector list a careless insertion splits.
//
// So the claim is asserted on the declarations rather than on the text of one rule: each selector must
// resolve to a rule carrying the cap AND the centring. That survives reordering, reformatting and a
// deliberate split into two rules, and fails on a selector that quietly stops carrying them.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

const DRAWER = read('src/lib/components/NowPlayingDrawer.svelte');

/** The component's `<style>` block with comments blanked, so prose cannot satisfy a declaration check. */
const STYLE = (() => {
	const m = /<style>([\s\S]*)<\/style>/.exec(DRAWER);
	const css = m ? m[1]! : '';
	return css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
})();

/**
 * Every declaration block whose selector list contains `selector`, as raw text.
 *
 * Split on `}` rather than parsed: these are flat rules with no nesting, and a real parser would be more
 * machinery than the claim needs. A selector list spanning newlines is handled because the whole prelude
 * is searched, which is the case that broke.
 */
function blocksFor(selector: string): string[] {
	const out: string[] = [];
	for (const chunk of STYLE.split('}')) {
		const at = chunk.indexOf('{');
		if (at === -1) continue;
		const prelude = chunk.slice(0, at);
		const body = chunk.slice(at + 1);
		// Word-boundary match on the class, so `.np-body` does not satisfy a search for `.np-bod`.
		const hit = prelude
			.split(',')
			.some((s) => new RegExp(`(^|[^\\w-])${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`).test(s));
		if (hit) out.push(body);
	}
	return out;
}

test('the sheet is a real component with a style block — the floor for everything below', () => {
	// A broken extraction would make every `blocksFor` call return [] and turn the arms below into
	// assertions about nothing.
	expect(STYLE.length).toBeGreaterThan(500);
	expect(blocksFor('.np-body').length).toBeGreaterThan(0);
	expect(blocksFor('.np-head').length).toBeGreaterThan(0);
});

for (const part of ['.np-head', '.np-body'] as const) {
	test(`${part} is capped at --max-w and centred, wherever that rule lives`, () => {
		const decls = blocksFor(part).join('\n');
		expect(decls, `${part} must cap at the page measure, or it goes full-bleed above --max-w`).toMatch(
			/max-width:\s*var\(--max-w\)/
		);
		expect(decls, `${part} must be centred, or the cap parks it against the left edge`).toMatch(
			/margin-inline:\s*auto/
		);
	});
}

test('the head and the body agree, so the sheet reads as one column', () => {
	/*
	 * The sharpest form of the claim, and the one the defect failed: it is not enough that each is capped
	 * SOMEWHERE — they must be capped at the same thing. A head at `--measure-prose` over a body at
	 * `--max-w` would pass the two arms above and still show two columns.
	 */
	const cap = (part: string) => /max-width:\s*(var\([^)]+\)|[\w.]+)/.exec(blocksFor(part).join('\n'))?.[1];
	expect(cap('.np-head')).toBe(cap('.np-body'));
});

test('the measured wrapper is NOT capped — one measure, not two', () => {
	/*
	 * `.np-fit` wraps the head and the body so its height can be snap 1's content cap. It must stay
	 * full-width: the children cap themselves, and a second cap here would be two rules deciding one
	 * column, with nothing to say which wins when they drift apart.
	 */
	const decls = blocksFor('.np-fit').join('\n');
	expect(decls.length, '.np-fit must exist — it is the block the content cap measures').toBeGreaterThan(0);
	expect(decls, '.np-fit must not carry its own measure').not.toMatch(/max-width:/);
	// And it must not shrink, or the measurement it exists for under-reports and the cap clips a control.
	expect(decls).toMatch(/flex:\s*0\s+0\s+auto/);
});
