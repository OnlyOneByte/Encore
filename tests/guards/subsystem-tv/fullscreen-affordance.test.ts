// Guard: the TV page's full-screen affordance.
//
// `/tv` is `position: fixed; inset: 0` and already owns the whole VIEWPORT, but not the browser's own chrome
// (URL bar / tab strip), which eats the top of a TV browser or an HDMI-plugged laptop. An `f` hotkey plus a
// self-hiding corner button both toggle the Fullscreen API, with the autoplay-recovery tap riding along free.
// `requestFullscreen()` requires TRANSIENT USER ACTIVATION, so every path is anchored to a real gesture on the
// TV itself: no autofullscreen on load, and a phone cannot trigger it — a realtime message carries no activation.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

/**
 * Blank comments, PRESERVING newlines so reported line numbers stay true. LOAD-BEARING: the page documents
 * this very feature in prose (its z-index scheme names `.fs-btn`, and the script carries a comment block about
 * `requestFullscreen`), so a scan reading comments would stay green with the wiring commented out.
 */
function stripComments(s: string): string {
	return s
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1 + '');
}

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
	// ONE control serves both directions, so the request must be gated on `document.fullscreenElement`: without
	// the gate a second `f` press is a no-op instead of leaving fullscreen, and the corner button could never
	// restore the windowed view. Both arms are asserted so an enter-only half cannot pass.
	expect(script).toMatch(/function\s+toggleFullscreen\s*\(/);
	expect(script).toMatch(/document\.fullscreenElement/);
	expect(script).toMatch(/document\.documentElement\.requestFullscreen\s*\(/);
	expect(script).toMatch(/document\.exitFullscreen/);
});

test('an `f` keydown handler calls toggleFullscreen (hotkey)', () => {
	// A keydown is itself a real user activation, which is what makes the hotkey a legal fullscreen trigger.
	expect(script).toMatch(/addEventListener\(\s*['"]keydown['"]/);
	expect(script).toMatch(/e\.key\s*===\s*['"]f['"]/);
	expect(script).toMatch(/toggleFullscreen\s*\(\s*\)/);
});

test('the autoplay-recovery tap requests fullscreen as a free rider (ruling C)', () => {
	// Asserted INSIDE the .autoplay-hint element, not merely somewhere in the file: the tap that authorises audio
	// is specifically the one that also asks for fullscreen. The block-clearing assignment is pinned alongside so
	// the rider cannot be added by REPLACING the recovery behaviour.
	const btn = /class="autoplay-hint"[\s\S]*?<\/button>/.exec(src);
	expect(btn).not.toBeNull();
	expect(btn![0]).toMatch(/toggleFullscreen\s*\(\s*\)/);
	expect(btn![0]).toMatch(/autoplayBlocked\s*=\s*false/);
});

test('a fading corner button (.fs-btn) is wired to controlsVisible and the toggle', () => {
	// `class:shown={controlsVisible}` is what makes the button self-hide after idle rather than becoming permanent
	// chrome on a wall. The $state declaration is asserted separately so the fade cannot be faked with a constant.
	const btn = /class="fs-btn"[\s\S]*?<\/button>/.exec(src);
	expect(btn).not.toBeNull();
	expect(btn![0]).toMatch(/class:shown=\{controlsVisible\}/);
	expect(btn![0]).toMatch(/onclick=\{toggleFullscreen\}/);
	expect(script).toMatch(/let\s+controlsVisible\s*=\s*\$state\(/);
});

test('.fs-btn sits on the --z-tv-card tier — above the reel and video, below the overlays and the hint', () => {
	// The persistent-chrome tier (7) is above the lyrics reel (6) and the player slots (1/2) so the button stays
	// tappable during a song, and below the transient overlays (8) and the autoplay hint (10) so those always
	// cover it — it must not occlude the lower-third or the join QR. Read from the RULE BODY inside <style> so a
	// stray `z-index: 7` elsewhere cannot satisfy it.
	const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(raw);
	expect(style).not.toBeNull();
	const rule = /\.fs-btn\s*\{([^}]*)\}/.exec(style![1]!);
	expect(rule).not.toBeNull();
	expect(rule![1]!).toMatch(/z-index\s*:\s*var\(--z-tv-card\)\s*;/);
});

test('.fs-btn and the corner join QR do NOT share the same bottom-right anchor', () => {
	// Caught: the fullscreen button and the during-playback join QR are BOTH --z-tv-card and both
	// position:absolute, and both anchored to `right: var(--tv-safe-x); bottom: var(--tv-safe-y)` — so at equal
	// z-index the later-in-DOM button painted its translucent tile over the QR card's "Scan to join" text. The
	// button is pinned TOP-right so the two never share a corner. Non-vacuous by construction: both rules MUST be
	// found (a rename reds here rather than passing silently) and both MUST carry --z-tv-card, since this guard
	// only speaks to same-tier chrome.
	const fsStyle = /<style[^>]*>([\s\S]*?)<\/style>/.exec(raw);
	expect(fsStyle).not.toBeNull();
	const fsRule = /\.fs-btn\s*\{([^}]*)\}/.exec(fsStyle![1]!);
	expect(fsRule).not.toBeNull();
	const fsBody = fsRule![1]!;
	expect(fsBody).toMatch(/z-index\s*:\s*var\(--z-tv-card\)\s*;/);

	const joinRaw = read('src/lib/tv/JoinBadge.svelte');
	const joinStyle = /<style[^>]*>([\s\S]*?)<\/style>/.exec(joinRaw);
	expect(joinStyle).not.toBeNull();
	// `.corner:not(.badqr)` — the during-playback QR card treatment, NOT the unreachable-join notice.
	const cornerRule = /\.corner:not\(\.badqr\)\s*\{([^}]*)\}/.exec(joinStyle![1]!);
	expect(cornerRule).not.toBeNull();
	const cornerBody = cornerRule![1]!;
	expect(cornerBody).toMatch(/z-index\s*:\s*var\(--z-tv-card\)\s*;/);

	// An absolutely-positioned box anchors via `right` plus one of `bottom`|`top`. Read them from each
	// rule's OWN body so the comparison is between the two real anchors.
	function anchor(body: string): { right: string | null; vert: string | null } {
		const right = /(?:^|[;{]|\s)right\s*:\s*([^;]+);/.exec(body);
		const bottom = /(?:^|[;{]|\s)bottom\s*:\s*([^;]+);/.exec(body);
		const top = /(?:^|[;{]|\s)top\s*:\s*([^;]+);/.exec(body);
		return {
			right: right ? right[1]!.trim() : null,
			// Tagged, so `bottom: X` and `top: X` (same length, different edge) never compare equal.
			vert: bottom ? `bottom:${bottom[1]!.trim()}` : top ? `top:${top[1]!.trim()}` : null
		};
	}
	const fsAnchor = anchor(fsBody);
	const cornerAnchor = anchor(cornerBody);

	// Both boxes anchor to the right edge by design; what must differ is the VERTICAL edge, so the button
	// leaves the QR's slot entirely rather than relying on z-index or DOM order.
	expect(fsAnchor.right).not.toBeNull();
	expect(cornerAnchor.right).not.toBeNull();
	expect(fsAnchor.vert).not.toBeNull();
	expect(cornerAnchor.vert).not.toBeNull();

	const fsPair = `${fsAnchor.right} | ${fsAnchor.vert}`;
	const cornerPair = `${cornerAnchor.right} | ${cornerAnchor.vert}`;
	expect(fsPair).not.toBe(cornerPair);
});
