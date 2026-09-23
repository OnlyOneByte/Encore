// guard: the now-playing sheet's head and body share ONE measure, and both keep it. See
// docs/GUARDS.md#vendored-component-seams.
//
// THE DEFECT. The head and body were capped and centred by one rule with two selectors, and a new rule
// inserted BETWEEN them silently dropped the head out of the list: it picked up the declarations of the
// rule that now followed its comma and went FULL-BLEED above `--max-w`, so on a 1639px window the song
// title sat pinned to the window edges while the transport was centred 280px inside them.
//
// Nothing caught it. A class-resolution guard asks whether a class matches SOME rule that can reach it,
// and `.np-head` still did — the wrong one. The rendered gate drives phone viewports, where a capped box
// and an uncapped one are the same width. And the head is rendered by a COMPONENT, so its rule must be
// `:global()`, which puts it in exactly the kind of selector list a careless insertion splits.
//
// So the claim is asserted on the DECLARATIONS rather than the text of one rule: each selector must
// resolve to a rule carrying the cap AND the centring, which survives reordering, reformatting and a
// deliberate split into two rules.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

const DRAWER = read('src/lib/components/NowPlayingDrawer.svelte');

/** The `<style>` block with comments blanked, so prose cannot satisfy a declaration check. */
const STYLE = (() => {
	const m = /<style>([\s\S]*)<\/style>/.exec(DRAWER);
	const css = m ? m[1]! : '';
	return css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
})();

/**
 * Every declaration block whose selector list contains `selector`. Split on `}` rather than parsed: these
 * are flat rules with no nesting. The whole prelude is searched, so a selector list spanning newlines —
 * the case that broke — is handled.
 */
function blocksFor(selector: string): string[] {
	const out: string[] = [];
	for (const chunk of STYLE.split('}')) {
		const at = chunk.indexOf('{');
		if (at === -1) continue;
		const prelude = chunk.slice(0, at);
		const body = chunk.slice(at + 1);
		// Word-boundary, so `.np-body` does not satisfy a search for `.np-bod`.
		const hit = prelude
			.split(',')
			.some((s) => new RegExp(`(^|[^\\w-])${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`).test(s));
		if (hit) out.push(body);
	}
	return out;
}

test('the sheet is a real component with a style block — the floor for everything below', () => {
	// A broken extraction makes every `blocksFor` call return [] and turns the arms below into assertions about nothing.
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
	// It is not enough that each is capped SOMEWHERE: a head at `--measure-prose` over a body at `--max-w`
	// passes the two arms above and still shows two columns.
	const cap = (part: string) => /max-width:\s*(var\([^)]+\)|[\w.]+)/.exec(blocksFor(part).join('\n'))?.[1];
	expect(cap('.np-head')).toBe(cap('.np-body'));
});

test('the measured wrapper is NOT capped — one measure, not two', () => {
	// `.np-fit` wraps the head and body so its height can be snap 1's content cap. It stays full-width: the children cap
	// themselves, and a second cap is two rules deciding one column with nothing to say which wins when they drift apart.
	const decls = blocksFor('.np-fit').join('\n');
	expect(decls.length, '.np-fit must exist — it is the block the content cap measures').toBeGreaterThan(0);
	expect(decls, '.np-fit must not carry its own measure').not.toMatch(/max-width:/);
	// And it must not shrink, or the measurement under-reports and the cap clips a control.
	expect(decls).toMatch(/flex:\s*0\s+0\s+auto/);
});
