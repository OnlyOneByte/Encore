// Guard: the TV page's full-screen affordance (owner ruling C).
//
// NB filename: SvelteKit reserves `+`-prefixed names inside routes/, so this cannot be
// `+page.test.ts`; it colocates with the page it guards without being treated as a route.
//
// WHAT THE FULLSCREEN AFFORDANCE ADDED. `/tv` is `position: fixed; inset: 0` and already owns the whole VIEWPORT, but not
// the browser's own chrome (URL bar / tab strip), which eats the top of a TV browser or an
// HDMI-plugged laptop. The owner ruled C: a dedicated `f` hotkey PLUS a self-hiding corner button,
// both toggling the Fullscreen API, with the existing autoplay-recovery tap requesting fullscreen as a
// free rider. `requestFullscreen()` requires TRANSIENT USER ACTIVATION, so every path here is anchored
// to a real gesture on the TV itself — there is no autofullscreen on load, and a phone cannot trigger
// it (a realtime message carries no activation).
//
// WHY A SOURCE SCAN. Encore has no jsdom/happy-dom, so every /tv UI invariant is a scan over the
// component text — the same shape as autoplay-recovery.test.ts and lyrics-clamp.test.ts. The
// properties under test (that the toggle is gated rather than one-way, that the hotkey and button call
// it, that the free rider is wired, that the button sits in the right z tier) are properties of the
// source and are decidable without a browser. The RENDERED proof — the button visible, fading after
// idle, and the toggle firing — lives in the PR body via the repo's CDP driver.
//
// Each test below pins a DISTINCT production hunk, so reverting any one hunk individually reds a
// NAMED test rather than relying on a union revert, the shape that hides a mutation-blind hunk.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

/**
 * Blank out block, line and markup comments, PRESERVING newlines so reported line numbers stay true.
 *
 * LOAD-BEARING: the page documents this very feature in prose (the z-index scheme names `.fs-btn`, and
 * the script carries a comment block about `requestFullscreen`). A scan that read comments would stay
 * green with the wiring commented out — which is exactly the mutation this guard has to catch.
 */
function stripComments(s: string): string {
	return s
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1 + '');
}

// The TV page named explicitly. This guard used to sit in src/routes/tv, where the page was
// `at('src/routes/tv/+page.svelte')` — "the page next to me", not inferable from tests/.
const raw = read('src/routes/tv/+page.svelte');
const src = stripComments(raw);

/** The <script> body with comments stripped, so a match cannot come from markup or <style>. */
function scriptBody(s: string): string {
	const m = /<script[^>]*>([\s\S]*?)<\/script>/.exec(s);
	expect(m).not.toBeNull();
	return m![1]!;
}
const script = stripComments(scriptBody(raw));

test('toggleFullscreen toggles via document.fullscreenElement, not a one-way request', () => {
	// PINS the toggle helper hunk. The affordance is ONE control for both directions, so the request
	// must be gated on `document.fullscreenElement`: without that gate pressing `f` twice is a no-op on
	// the second press instead of leaving fullscreen, and the corner button could never restore the
	// windowed view. Both arms are asserted so a half-implementation (enter only) cannot pass.
	expect(script).toMatch(/function\s+toggleFullscreen\s*\(/);
	expect(script).toMatch(/document\.fullscreenElement/);
	expect(script).toMatch(/document\.documentElement\.requestFullscreen\s*\(/);
	expect(script).toMatch(/document\.exitFullscreen/);
});

test('an `f` keydown handler calls toggleFullscreen (hotkey)', () => {
	// PINS the keydown hunk — the half of ruling C that works on a TV with a paired keyboard/remote and
	// needs no visible chrome at all. A keydown is also a real user activation, which is what makes the
	// hotkey a legal fullscreen trigger in the first place.
	expect(script).toMatch(/addEventListener\(\s*['"]keydown['"]/);
	expect(script).toMatch(/e\.key\s*===\s*['"]f['"]/);
	expect(script).toMatch(/toggleFullscreen\s*\(\s*\)/);
});

test('the autoplay-recovery tap requests fullscreen as a free rider (ruling C)', () => {
	// PINS the free-rider hunk. Asserted INSIDE the .autoplay-hint element, not merely somewhere in the
	// file: the ruling is specifically that the tap which authorises audio also asks for fullscreen, so
	// a toggleFullscreen() call anywhere else must not satisfy this. The block-clearing assignment is
	// pinned alongside it so the rider cannot be added by REPLACING the recovery behaviour.
	const btn = /class="autoplay-hint"[\s\S]*?<\/button>/.exec(src);
	expect(btn).not.toBeNull();
	expect(btn![0]).toMatch(/toggleFullscreen\s*\(\s*\)/);
	expect(btn![0]).toMatch(/autoplayBlocked\s*=\s*false/);
});

test('a fading corner button (.fs-btn) is wired to controlsVisible and the toggle', () => {
	// PINS the button markup hunk AND its fade wiring. `class:shown={controlsVisible}` is what makes the
	// button self-hide after idle rather than becoming permanent chrome on a wall — the explicit cost the
	// issue attached to ruling C — and the onclick is what makes it do anything. Both are asserted on the
	// button element itself; the $state declaration is asserted separately so the fade cannot be faked
	// with a constant.
	const btn = /class="fs-btn"[\s\S]*?<\/button>/.exec(src);
	expect(btn).not.toBeNull();
	expect(btn![0]).toMatch(/class:shown=\{controlsVisible\}/);
	expect(btn![0]).toMatch(/onclick=\{toggleFullscreen\}/);
	expect(script).toMatch(/let\s+controlsVisible\s*=\s*\$state\(/);
});

test('.fs-btn sits on the --z-tv-card tier — above the reel and video, below the overlays and the hint', () => {
	// PINS the CSS hunk, which is the constraint the issue spells out: the button must not occlude the
	// lower-third or the join QR, and must sit below the autoplay hint (10). z 7 is the documented
	// persistent-chrome tier — above the lyrics reel (6) and the player slots (1/2) so it stays tappable
	// during a song, and below the transient full-screen overlays (8) and the hint (10) so those always
	// cover it. Read from the RULE BODY inside <style> so a stray `z-index: 7` elsewhere cannot satisfy it.
	const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(raw);
	expect(style).not.toBeNull();
	const rule = /\.fs-btn\s*\{([^}]*)\}/.exec(style![1]!);
	expect(rule).not.toBeNull();
	expect(rule![1]!).toMatch(/z-index\s*:\s*var\(--z-tv-card\)\s*;/);
});

test('.fs-btn and the corner join QR do NOT share the same bottom-right anchor', () => {
	// PINS the corner-collision fix hunk: the fullscreen button and the during-playback join QR are BOTH z-tv-card
	// (tier 7) persistent chrome, and both are position:absolute. Before that fix both anchored to
	// `right: var(--tv-safe-x); bottom: var(--tv-safe-y)`, so at equal z-index the later-in-DOM button
	// painted its translucent tile over the QR card's "Scan to join" text — the readable half of the
	// invitation. The button is now pinned TOP-right (below the status dot) so the two never share a
	// corner. This scans BOTH files (the route + the sibling JoinBadge), reads each rule's OWN anchor
	// declarations, and asserts the resolved (right, bottom|top) anchor pair differs — reverting the
	// fs-btn move (back to bottom: var(--tv-safe-y)) makes the pairs identical and reds this test.

	// Non-vacuous by construction: both rules MUST be found (a rename/removal reds here, not silently
	// passes), and both MUST carry --z-tv-card (this guard only speaks to same-tier chrome).
	const fsStyle = /<style[^>]*>([\s\S]*?)<\/style>/.exec(raw);
	expect(fsStyle).not.toBeNull();
	const fsRule = /\.fs-btn\s*\{([^}]*)\}/.exec(fsStyle![1]!);
	expect(fsRule).not.toBeNull();
	const fsBody = fsRule![1]!;
	expect(fsBody).toMatch(/z-index\s*:\s*var\(--z-tv-card\)\s*;/);

	const joinRaw = read('src/lib/tv/JoinBadge.svelte');
	const joinStyle = /<style[^>]*>([\s\S]*?)<\/style>/.exec(joinRaw);
	expect(joinStyle).not.toBeNull();
	// `.corner:not(.badqr)` — the during-playback QR card treatment (NOT the unreachable-join alert).
	const cornerRule = /\.corner:not\(\.badqr\)\s*\{([^}]*)\}/.exec(joinStyle![1]!);
	expect(cornerRule).not.toBeNull();
	const cornerBody = cornerRule![1]!;
	expect(cornerBody).toMatch(/z-index\s*:\s*var\(--z-tv-card\)\s*;/);

	// The anchor of an absolutely-positioned box is its (right, and one of bottom|top) declarations.
	// Read them from each rule's OWN body so the comparison is between the two real anchors.
	function anchor(body: string): { right: string | null; vert: string | null } {
		const right = /(?:^|[;{]|\s)right\s*:\s*([^;]+);/.exec(body);
		const bottom = /(?:^|[;{]|\s)bottom\s*:\s*([^;]+);/.exec(body);
		const top = /(?:^|[;{]|\s)top\s*:\s*([^;]+);/.exec(body);
		return {
			right: right ? right[1]!.trim() : null,
			// A box pins vertically via bottom OR top; capture whichever it declares, tagged so
			// `bottom: X` and `top: X` (same length, different edge) never compare equal.
			vert: bottom ? `bottom:${bottom[1]!.trim()}` : top ? `top:${top[1]!.trim()}` : null
		};
	}
	const fsAnchor = anchor(fsBody);
	const cornerAnchor = anchor(cornerBody);

	// Both boxes anchor to the right edge (they always shared the horizontal axis; the corner is the
	// right one for both by design). What must differ is the VERTICAL edge, so the button leaves the
	// QR's bottom-right slot entirely rather than merely relying on z-index/DOM order.
	expect(fsAnchor.right).not.toBeNull();
	expect(cornerAnchor.right).not.toBeNull();
	expect(fsAnchor.vert).not.toBeNull();
	expect(cornerAnchor.vert).not.toBeNull();

	const fsPair = `${fsAnchor.right} | ${fsAnchor.vert}`;
	const cornerPair = `${cornerAnchor.right} | ${cornerAnchor.vert}`;
	expect(fsPair).not.toBe(cornerPair);
});
