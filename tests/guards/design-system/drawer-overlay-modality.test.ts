// The drawer's scrim and its modality are ONE decision, pinned as one.
//
// THE DEFECT. `NowPlayingDrawer` sets `modal={false}` — it must, being a permanently-mounted sheet whose
// collapsed height is the docked band on every phone surface, so a scrim and a focus trap would cover the
// page the guest is using. `vaul-svelte` gates the overlay on exactly that flag
// (`use-drawer-overlay.svelte.js`: `shouldRender = ctx.modal.current`), so the `<DrawerOverlay />` the
// vendored `drawer-content.svelte` rendered could never mount. Measured on the running app: no
// `[data-slot='drawer-overlay']` in the DOM at either snap point.
//
// Three things were therefore describing a scrim that does not exist — the render, the Root's
// `fadeFromIndex={1}` ("so there is no scrim while the band is just sitting there", implying one appears
// when it is not), and ~50 lines of hand-written fade CSS with two `-global-` keyframes in the overlay
// component. All three are gone.
//
// WHY A GUARD AND NOT JUST A COMMENT. The coupling is invisible in both directions: setting `modal={true}`
// later would silently ship a modal dialog with NO scrim (the overlay is no longer rendered), and a
// `shadcn-svelte add drawer --overwrite` would silently restore the render, putting the dead fade back in
// a file whose header says it was deleted. Either way `bun test` should say so, which is what this does.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

const CONTENT = read('src/lib/components/ui/drawer/drawer-content.svelte');
const OVERLAY = read('src/lib/components/ui/drawer/drawer-overlay.svelte');
const DRAWER = read('src/lib/components/NowPlayingDrawer.svelte');

/** Blank comments, so a rule that survives only in prose does not count as live source. */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
}

test('the app drawer is non-modal — the premise everything below rests on', () => {
	// Whole-line, not a substring: `modal={false}` inside a longer expression would not be the prop vaul
	// reads. This is also the non-vacuity floor for the rest of the file — if this ever flips, every
	// assertion below is about the wrong world and must be re-decided rather than adjusted.
	expect(stripComments(DRAWER), 'NowPlayingDrawer must set modal={false} as its own prop').toMatch(
		/^\s*modal=\{false\}\s*$/m
	);
});

test('a non-modal drawer renders no overlay, because vaul would render nothing anyway', () => {
	expect(
		stripComments(CONTENT),
		'drawer-content must not render an overlay while the app drawer is non-modal'
	).not.toMatch(/<DrawerOverlay/);
});

test('the inert fadeFromIndex is gone, and does not come back without an overlay', () => {
	const live = stripComments(DRAWER);
	expect(live, 'fadeFromIndex fades an overlay that is not rendered — re-add it only with the render').not.toMatch(
		/fadeFromIndex/
	);
});

test('the overlay component carries no fade rule while nothing renders it', () => {
	/*
	 * The rule was `:global([data-slot='drawer-overlay'])` plus two `-global-` keyframes. No element has
	 * carried that slot since the render went, so the selector matched nothing and the keyframes were
	 * emitted for nobody — dead code that reads as live, in the one directory a re-vendor overwrites.
	 */
	expect(OVERLAY, 'the overlay must declare no fade while it is unrendered').not.toMatch(/@keyframes/);
	expect(OVERLAY, 'and no animation to go with it').not.toMatch(/animation:/);
	// Still VENDORED though, so a future modal drawer is one import away rather than a re-download. Its
	// deviation header is what tells the next reader why it has no consumer.
	expect(OVERLAY, 'the component itself stays, with its reason recorded').toMatch(/ENCORE DEVIATIONS/);
	expect(OVERLAY).toMatch(/DrawerPrimitive\.Overlay/);
});

test('the sheet still has an EDGE, since it has no scrim to separate it from the page', () => {
	// With no dimming, the only thing distinguishing an open sheet from the page behind it is its own top
	// border and surface. `border-border` is itself a defect fix recorded in that file (the class list sets
	// only border-WIDTH, so the colour fell through to `currentColor` and every sheet drew a white
	// hairline), and losing it now would leave the boundary to the popover background alone.
	const live = stripComments(CONTENT);
	expect(live).toMatch(/border-border/);
	expect(live).toMatch(/data-\[vaul-drawer-direction=bottom\]:border-t/);
});
