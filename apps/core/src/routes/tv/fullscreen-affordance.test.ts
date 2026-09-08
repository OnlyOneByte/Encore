// Guard: the TV page's full-screen affordance (#424, owner ruling C).
//
// NB filename: SvelteKit reserves `+`-prefixed names inside routes/, so this cannot be
// `+page.test.ts`; it colocates with the page it guards without being treated as a route.
//
// WHAT #424 ADDED. `/tv` is `position: fixed; inset: 0` and already owns the whole VIEWPORT, but not
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
// NAMED test rather than relying on a union revert (the #224 failure mode).
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

// import.meta.dir === apps/core/src/routes/tv, so the page sits alongside this file.
const PAGE = join(import.meta.dir, '+page.svelte');
const raw = readFileSync(PAGE, 'utf8');
const src = stripComments(raw);

/** The <script> body with comments stripped, so a match cannot come from markup or <style>. */
function scriptBody(s: string): string {
	const m = /<script[^>]*>([\s\S]*?)<\/script>/.exec(s);
	expect(m).not.toBeNull();
	return m![1]!;
}
const script = stripComments(scriptBody(raw));

test('toggleFullscreen toggles via document.fullscreenElement, not a one-way request (#424)', () => {
	// PINS the toggle helper hunk. The affordance is ONE control for both directions, so the request
	// must be gated on `document.fullscreenElement`: without that gate pressing `f` twice is a no-op on
	// the second press instead of leaving fullscreen, and the corner button could never restore the
	// windowed view. Both arms are asserted so a half-implementation (enter only) cannot pass.
	expect(script).toMatch(/function\s+toggleFullscreen\s*\(/);
	expect(script).toMatch(/document\.fullscreenElement/);
	expect(script).toMatch(/document\.documentElement\.requestFullscreen\s*\(/);
	expect(script).toMatch(/document\.exitFullscreen/);
});

test('an `f` keydown handler calls toggleFullscreen (#424 hotkey)', () => {
	// PINS the keydown hunk — the half of ruling C that works on a TV with a paired keyboard/remote and
	// needs no visible chrome at all. A keydown is also a real user activation, which is what makes the
	// hotkey a legal fullscreen trigger in the first place.
	expect(script).toMatch(/addEventListener\(\s*['"]keydown['"]/);
	expect(script).toMatch(/e\.key\s*===\s*['"]f['"]/);
	expect(script).toMatch(/toggleFullscreen\s*\(\s*\)/);
});

test('the autoplay-recovery tap requests fullscreen as a free rider (#424 ruling C)', () => {
	// PINS the free-rider hunk. Asserted INSIDE the .autoplay-hint element, not merely somewhere in the
	// file: the ruling is specifically that the tap which authorises audio also asks for fullscreen, so
	// a toggleFullscreen() call anywhere else must not satisfy this. The block-clearing assignment is
	// pinned alongside it so the rider cannot be added by REPLACING the recovery behaviour.
	const btn = /class="autoplay-hint"[\s\S]*?<\/button>/.exec(src);
	expect(btn).not.toBeNull();
	expect(btn![0]).toMatch(/toggleFullscreen\s*\(\s*\)/);
	expect(btn![0]).toMatch(/autoplayBlocked\s*=\s*false/);
});

test('a fading corner button (.fs-btn) is wired to controlsVisible and the toggle (#424)', () => {
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

test('.fs-btn sits at z-index 7 — above the reel and video, below the overlays and the hint (#424)', () => {
	// PINS the CSS hunk, which is the constraint the issue spells out: the button must not occlude the
	// lower-third or the join QR, and must sit below the autoplay hint (10). z 7 is the documented
	// persistent-chrome tier — above the lyrics reel (6) and the player slots (1/2) so it stays tappable
	// during a song, and below the transient full-screen overlays (8) and the hint (10) so those always
	// cover it. Read from the RULE BODY inside <style> so a stray `z-index: 7` elsewhere cannot satisfy it.
	const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(raw);
	expect(style).not.toBeNull();
	const rule = /\.fs-btn\s*\{([^}]*)\}/.exec(style![1]!);
	expect(rule).not.toBeNull();
	expect(rule![1]!).toMatch(/z-index\s*:\s*7\s*;/);
});
