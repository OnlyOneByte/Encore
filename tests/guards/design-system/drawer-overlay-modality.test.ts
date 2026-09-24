// guard: the drawer's scrim and its modality are ONE decision. `NowPlayingDrawer` is `modal={false}`, and
// `vaul-svelte` gates its overlay on exactly that flag, so `<DrawerOverlay />` could never mount and the
// render, `fadeFromIndex` and the fade CSS were all describing a scrim that does not exist. The coupling is
// invisible both ways: `modal={true}` later ships a modal dialog with NO scrim, and
// `shadcn-svelte add drawer --overwrite` restores the dead render.
// See docs/GUARDS.md#vendored-component-seams.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';
import { stripComments } from '@encore/test-support/scan';

const CONTENT = read('src/lib/components/ui/drawer/drawer-content.svelte');
const OVERLAY = read('src/lib/components/ui/drawer/drawer-overlay.svelte');
const DRAWER = read('src/lib/components/NowPlayingDrawer.svelte');

test('the app drawer is non-modal — the premise everything below rests on', () => {
	// Whole-line, not a substring: `modal={false}` inside a longer expression is not the prop vaul reads.
	// Also the floor for the rest of the file — if this flips, every assertion below is about the wrong
	// world and must be re-decided rather than adjusted.
	expect(
		stripComments(DRAWER, { markup: true, keepLine: true }),
		'NowPlayingDrawer must set modal={false} as its own prop'
	).toMatch(/^\s*modal=\{false\}\s*$/m);
});

test('a non-modal drawer renders no overlay, because vaul would render nothing anyway', () => {
	expect(
		stripComments(CONTENT, { markup: true, keepLine: true }),
		'drawer-content must not render an overlay while the app drawer is non-modal'
	).not.toMatch(/<DrawerOverlay/);
});

test('the inert fadeFromIndex is gone, and does not come back without an overlay', () => {
	const live = stripComments(DRAWER, { markup: true, keepLine: true });
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
	const live = stripComments(CONTENT, { markup: true, keepLine: true });
	expect(live).toMatch(/border-border/);
	expect(live).toMatch(/data-\[vaul-drawer-direction=bottom\]:border-t/);
});
