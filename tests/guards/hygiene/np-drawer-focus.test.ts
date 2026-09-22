/*
 * ── THE ALWAYS-OPEN SHEET MUST NOT TAKE FOCUS FROM THE PAGE UNDERNEATH IT ─────────────────────────
 *
 * Reported as "I can't type in the song search bar and I can't even see the cursor". The caret really
 * was not there: it landed on the input and was taken away a frame later. This file guards the FOCUS
 * half; the geometry half — the sheet physically covering the box on a short window — is
 * `tests/unit/lib/sheet-snap.test.ts`.
 *
 * WHERE THE THEFT CAME FROM, traced through the dependency chain rather than guessed. `Drawer.Content`
 * renders `bits-ui`'s `Dialog.Content`, which defaults `trapFocus = true` and hands it to `FocusScope`.
 * When the trap is on, `FocusScope` installs a DOCUMENT-LEVEL `focusin` capture listener for as long as
 * the scope is `enabled` — and `enabled` is the dialog's `open`, which for this sheet is permanently
 * true, because the band and the drawer were merged into one sheet that never closes. Every focus
 * landing outside the content is then treated as an escape and yanked back: `e.preventDefault()` then
 * `lastFocused.focus()`, falling through to `(firstTabbable || firstFocusable || container).focus()`.
 * The container is the last resort and it IS focusable — the scope gives it `tabindex: -1` — which is
 * exactly what was measured: after a real click on the search input, `document.activeElement` was
 * `div[data-slot=drawer-content]`. `/find` focuses its box in `onMount`, so this is the first thing a
 * guest sees.
 *
 * WHY `modal={false}` DID NOT COVER IT, which is the trap this file exists to keep shut. That prop
 * reaches vaul's own `onFocusOutside` / `onInteractOutside`, which are the DISMISSAL handlers. The focus
 * trap is a separate mechanism one layer further down, and nothing vaul exposes on its Root touches it —
 * `autoFocus` (already false by default) cancels only the ONE open-autofocus, which is why the collapsed
 * band looked innocent and the bug read as intermittent.
 *
 * WHY THIS RUNG. `NowPlayingDrawer` cannot be mounted on the mount rung at all — its own
 * `bind:clientHeight` needs a `ResizeObserver` the rung refuses to install (see the boundary arm in
 * `hero-live-controls.test.ts`) — and a `focusin` interception is a rendered, event-ordering claim
 * besides. So the mechanism is pinned at its source, and the rendered proof is an e2e measurement: at
 * 1440x900 and 1440x700, sheet pulled up, `document.activeElement` after a real `click` on the search
 * input is that input rather than `div[data-slot=drawer-content]`.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf8');

/**
 * Blank every comment, preserving newlines so a reported line number still points at the right line.
 *
 * REQUIRED HERE, not hygiene: this component's prose is unusually dense and it discusses the very words
 * the bans below look for. "With a song it is inert: `aria-labelledby` wins the accessible-name cascade"
 * is a sentence about the `aria-label` attribute, and an unstripped `\binert\b` ban matches it — so the
 * ban would fail on a component that has never used the attribute, and the only way to make it pass
 * would be to delete an explanation. The bans are about CODE; the prose has to be out of scope.
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

/** The `<Drawer.Content …>` opening tag, so a claim about ITS props cannot be satisfied by the Root's. */
const CONTENT_TAG = (() => {
	const at = DRAWER_RAW.indexOf('<Drawer.Content');
	expect(at, 'the sheet must still render a vaul Content').toBeGreaterThan(-1);
	return DRAWER_RAW.slice(at, DRAWER_RAW.indexOf('>', at) + 1);
})();

/** The `<Drawer.Root …>` opening tag, for the same reason in reverse. */
const ROOT_TAG = (() => {
	const at = DRAWER_RAW.indexOf('<Drawer.Root');
	expect(at, 'the sheet must still be a vaul Root').toBeGreaterThan(-1);
	return DRAWER_RAW.slice(at, DRAWER_RAW.indexOf('>', at) + 1);
})();

test('the sheet switches the focus TRAP off, and does it on the element that owns the trap', () => {
	/*
	 * ON THE CONTENT, NOT THE ROOT, and that placement is the whole substance rather than a style point.
	 * `trapFocus` belongs to `bits-ui`'s `Dialog.Content`; vaul's Root has no such prop, so the same text
	 * written one element up would be a stray attribute that silently does nothing — which is the exact
	 * shape of the `modal={false}` mistake this fix had to get past.
	 */
	expect(CONTENT_TAG).toContain('trapFocus={false}');
	expect(ROOT_TAG).not.toContain('trapFocus');

	/*
	 * …AND `modal={false}` IS STILL THERE, because it was never the fix and it is still load-bearing for
	 * its own job — a non-modal sheet is what keeps the page beneath it interactive and un-scrimmed while
	 * the band just sits there. Pinned so that "the focus bug is fixed" cannot be taken as licence to
	 * delete it, and so a future reader sees the two props are answers to two different questions.
	 */
	expect(ROOT_TAG).toContain('modal={false}');
	// Non-vacuous: the tag slices really contain the props they are being read for.
	expect(ROOT_TAG).toContain('snapPoints=');
	expect(CONTENT_TAG).toContain('class="np-drawer"');
});

test('the sheet stays USABLE — the fix is a trap switched off, not a surface switched out of reach', () => {
	/*
	 * THE CHEAP WRONG FIXES, BANNED BY NAME. Every one of these also stops the sheet stealing focus, and
	 * every one of them costs a keyboard user the transport, the guiding-track slider, the ± keycaps and
	 * "More about this song" — controls that exist nowhere else on the phone once the hero was retired.
	 * `inert` and `aria-hidden` take the whole subtree out of the tab order and out of the accessibility
	 * tree; `pointer-events: none` on the content would additionally kill the drag the handle depends on.
	 *
	 * Read on the whole component rather than the Content tag, because a stylesheet rule reaches the same
	 * element from the bottom of the file — and on the COMMENT-STRIPPED source, so the prose above the
	 * markup (which discusses `aria-labelledby` being "inert") cannot trip a ban it is only describing.
	 * `aria-hidden` is checked on the tag only: vaul renders its own `aria-hidden` hit-area span inside
	 * `Drawer.Handle`, so a component-wide ban would be a ban on something that has to be there.
	 */
	// Not vacuous: stripping really left the markup behind, so the bans below are reading something.
	expect(DRAWER).toContain('<Drawer.Content');
	expect(DRAWER).toContain('trapFocus={false}');
	expect(CONTENT_TAG).not.toContain('inert');
	expect(CONTENT_TAG).not.toContain('aria-hidden');
	expect(CONTENT_TAG).not.toContain('tabindex');
	expect(DRAWER).not.toMatch(/\binert\b/);
	// `pointer-events: none` nowhere in this component's own CSS — the sheet is a surface you use.
	expect(DRAWER).not.toContain('pointer-events: none');

	/*
	 * NOR IS THE CONTAINER'S OWN FOCUSABILITY TAKEN AWAY. `FocusScope` gives the content `tabindex: -1`
	 * unconditionally — it is not part of the trap — and that is what lets the sheet be focused
	 * programmatically. This component must not write a `tabindex` of its own over it, in either
	 * direction: a `0` would put the container itself in the tab order as a dead stop before its own
	 * children, and re-stating `-1` would be a second writer of a value bits-ui already owns.
	 */
	expect(DRAWER).not.toMatch(/tabindex=/);
});

test('the vendored Content does not swallow the prop on its way to bits-ui', () => {
	/*
	 * THE ONE LINK IN THIS CHAIN THAT IS OURS. `trapFocus` has to travel composition site → vendored
	 * `ui/drawer/drawer-content.svelte` → `vaul-svelte`'s Content → `bits-ui`'s `Dialog.Content`, and the
	 * middle hop is a shadcn copy-in this repo has already had to fix three separate defects in. It
	 * forwards by spreading `restProps`, and the spread must come AFTER the hard-coded props — `mergeProps`
	 * and Svelte spreads both resolve last-wins, so a `trapFocus` written above the spread would beat the
	 * caller's and the fix would silently stop working with nothing failing out loud.
	 *
	 * The two dependency hops are deliberately NOT asserted here: a guard reaching into `node_modules`
	 * would be pinning a version rather than this repo's behaviour, and the e2e measurement named in the
	 * header is what actually proves the whole chain carries.
	 */
	const at = VENDORED_CONTENT.indexOf('<DrawerPrimitive.Content');
	expect(at, 'the vendored Content must still wrap vaul').toBeGreaterThan(-1);
	const tag = VENDORED_CONTENT.slice(at, VENDORED_CONTENT.indexOf('>', at) + 1);
	expect(tag).toContain('{...restProps}');
	expect(tag).not.toContain('trapFocus');
	// …and it really does collect a rest, so the spread above is not spreading an empty object.
	expect(VENDORED_CONTENT).toContain('...restProps');
});
