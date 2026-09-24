/*
 * THE ALWAYS-OPEN SHEET MUST NOT TAKE FOCUS FROM THE PAGE UNDERNEATH IT. Reported as "I can't type in the song
 * search bar and I can't even see the cursor": the caret landed on the input and was taken away a frame later.
 *
 * `Drawer.Content` renders `bits-ui`'s `Dialog.Content`, which defaults `trapFocus = true`. While the trap is on,
 * `FocusScope` keeps a DOCUMENT-LEVEL `focusin` capture listener for as long as the scope is `enabled` — and
 * `enabled` is the dialog's `open`, permanently true for a sheet that never closes — so every focus landing
 * outside the content is yanked back to the container, which IS focusable (`tabindex: -1`). `modal={false}` does
 * not cover it: that prop reaches vaul's DISMISSAL handlers only. The geometry half is
 * tests/unit/lib/sheet-snap.test.ts, and the rendered proof is an e2e measurement, because this component cannot
 * be mounted on the mount rung (`bind:clientHeight` needs a `ResizeObserver`).
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf8');

/**
 * Blank every comment, preserving newlines so a reported line number still points at the right line. REQUIRED:
 * this component's prose contains the very words the bans below look for (a sentence about `aria-labelledby`
 * winning the name cascade uses "inert"), so the bans must read CODE only.
 */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src
		.replace(/<!--[\s\S]*?-->/g, blank)
		.replace(/\/\*[\s\S]*?\*\//g, blank)
		.replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)));
}

const DRAWER_RAW = read('src/lib/components/NowPlayingDrawer.svelte');
const DRAWER = stripComments(DRAWER_RAW);
const VENDORED_CONTENT = read('src/lib/components/ui/drawer/drawer-content.svelte');

const CONTENT_TAG = (() => {
	const at = DRAWER_RAW.indexOf('<Drawer.Content');
	expect(at, 'the sheet must still render a vaul Content').toBeGreaterThan(-1);
	return DRAWER_RAW.slice(at, DRAWER_RAW.indexOf('>', at) + 1);
})();

const ROOT_TAG = (() => {
	const at = DRAWER_RAW.indexOf('<Drawer.Root');
	expect(at, 'the sheet must still be a vaul Root').toBeGreaterThan(-1);
	return DRAWER_RAW.slice(at, DRAWER_RAW.indexOf('>', at) + 1);
})();

test('the sheet switches the focus TRAP off, and does it on the element that owns the trap', () => {
	// ON THE CONTENT, NOT THE ROOT: `trapFocus` belongs to `bits-ui`'s `Dialog.Content` and vaul's Root has no such
	// prop, so the same text one element up would be a stray attribute that silently does nothing.
	expect(CONTENT_TAG).toContain('trapFocus={false}');
	expect(ROOT_TAG).not.toContain('trapFocus');

	// …AND `modal={false}` STAYS: never the fix, but what keeps the page beneath interactive and un-scrimmed.
	expect(ROOT_TAG).toContain('modal={false}');
	expect(ROOT_TAG).toContain('snapPoints=');
	expect(CONTENT_TAG).toContain('class="np-drawer"');
});

test('the sheet stays USABLE — the fix is a trap switched off, not a surface switched out of reach', () => {
	// THE CHEAP WRONG FIXES, BANNED BY NAME. Each also stops the theft, and each costs a keyboard user the
	// transport, the slider, the ± keycaps and "More about this song": `inert`/`aria-hidden` take the subtree out of
	// the tab order and the a11y tree, and `pointer-events: none` would kill the handle's drag (banned anywhere in
	// this component's CSS — the sheet is a surface you use). `aria-hidden` on the tag only, because vaul renders
	// its own inside the Handle.
	expect(DRAWER).toContain('<Drawer.Content');
	expect(DRAWER).toContain('trapFocus={false}');
	expect(CONTENT_TAG).not.toContain('inert');
	expect(CONTENT_TAG).not.toContain('aria-hidden');
	expect(CONTENT_TAG).not.toContain('tabindex');
	expect(DRAWER).not.toMatch(/\binert\b/);
	expect(DRAWER).not.toContain('pointer-events: none');

	// NOR IS THE CONTAINER'S OWN FOCUSABILITY TAKEN AWAY: `FocusScope` gives the content `tabindex: -1`
	// unconditionally, so a `0` here would make the container a dead stop before its children, and re-stating `-1`
	// is a second writer of a bits-ui value.
	expect(DRAWER).not.toMatch(/tabindex=/);
});

test('the vendored Content does not swallow the prop on its way to bits-ui', () => {
	// THE ONE LINK IN THIS CHAIN THAT IS OURS: `trapFocus` travels composition site → vendored
	// `ui/drawer/drawer-content.svelte` → vaul's Content → `bits-ui`'s `Dialog.Content`. The middle hop forwards by
	// spreading `restProps`, and the spread must come AFTER the hard-coded props — both `mergeProps` and Svelte
	// spreads are last-wins, so a `trapFocus` above the spread beats the caller's and the fix dies silently.
	const at = VENDORED_CONTENT.indexOf('<DrawerPrimitive.Content');
	expect(at, 'the vendored Content must still wrap vaul').toBeGreaterThan(-1);
	const tag = VENDORED_CONTENT.slice(at, VENDORED_CONTENT.indexOf('>', at) + 1);
	expect(tag).toContain('{...restProps}');
	expect(tag).not.toContain('trapFocus');
	// …and it really does collect a rest, so the spread above is not spreading an empty object.
	expect(VENDORED_CONTENT).toContain('...restProps');
});
