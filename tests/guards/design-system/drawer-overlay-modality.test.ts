// guard: the drawer's scrim and its modality are ONE decision. See
// docs/GUARDS.md#vendored-component-seams.
//
// `NowPlayingDrawer` must be `modal={false}`, being a permanently-mounted sheet whose collapsed height is
// the docked band on every phone surface — a scrim and a focus trap would cover the page in use. But
// `vaul-svelte` gates its overlay on exactly that flag (`shouldRender = ctx.modal.current`), so the
// `<DrawerOverlay />` the vendored content rendered could never mount: measured on the running app, no
// `[data-slot='drawer-overlay']` in the DOM at either snap point. So the render, the Root's
// `fadeFromIndex`, and ~50 lines of fade CSS with two `-global-` keyframes were all describing a scrim
// that does not exist, and all three are gone.
//
// The coupling is invisible in both directions: setting `modal={true}` later silently ships a modal dialog
// with NO scrim, and `shadcn-svelte add drawer --overwrite` silently restores the render, putting the dead
// fade back in a file whose header says it was deleted.
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
	// Whole-line, not a substring: `modal={false}` inside a longer expression is not the prop vaul reads.
	// Also the floor for the rest of the file — if this flips, every assertion below is about the wrong
	// world and must be re-decided rather than adjusted.
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
	// No element has carried that slot since the render went, so the selector matched nothing and the keyframes were
	// emitted for nobody — dead code that reads as live, in the one directory a re-vendor overwrites.
	expect(OVERLAY, 'the overlay must declare no fade while it is unrendered').not.toMatch(/@keyframes/);
	expect(OVERLAY, 'and no animation to go with it').not.toMatch(/animation:/);
	// Still VENDORED, so a future modal drawer is one import away rather than a re-download; its deviation
	// header is what tells the next reader why it has no consumer.
	expect(OVERLAY, 'the component itself stays, with its reason recorded').toMatch(/ENCORE DEVIATIONS/);
	expect(OVERLAY).toMatch(/DrawerPrimitive\.Overlay/);
});

test('the sheet still has an EDGE, since it has no scrim to separate it from the page', () => {
	// With no dimming, the only thing distinguishing an open sheet from the page behind it is its own top
	// border and surface. `border-border` is itself a fix — the class list sets only border-WIDTH, so the
	// colour fell through to `currentColor` and every sheet drew a white hairline.
	const live = stripComments(CONTENT);
	expect(live).toMatch(/border-border/);
	expect(live).toMatch(/data-\[vaul-drawer-direction=bottom\]:border-t/);
});
