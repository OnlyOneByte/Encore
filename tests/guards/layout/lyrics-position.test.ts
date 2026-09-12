// guard: the lyrics reel draws from a PURE function of the playback position, so a backgrounded tab
// (throttled/stopped rAF) has no loop-carried state to lose. See lyrics-position.ts for the purity rule.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';
import { drawPosition } from '$lib/tv/lyrics-position';

// --- the property this bug is about: PATH INDEPENDENCE ---------------------------------------------
//
// The detector for "derived state accumulated instead of computed" is that render(t) must be
// path-independent: reaching the same authoritative position by different histories must draw the same
// place. The defocus-while-paused bug is exactly a path that reaches position P but draws position 0.

test('paused: the drawn position is the authoritative position, independent of history', () => {
	const P = 42.5;
	// History A: paused here after playing up to P (a big wall-clock gap while backgrounded).
	const viaPlaythenPause = drawPosition({ positionSec: P, playing: false, anchoredAtMs: 1_000, nowMs: 999_999 });
	// History B: paused here after seeking straight to P (no elapsed wall time).
	const viaSeek = drawPosition({ positionSec: P, playing: false, anchoredAtMs: 500_000, nowMs: 500_000 });
	// History C: backgrounded and returned — the rAF loop never ran, "now" is far in the future.
	const viaBackground = drawPosition({ positionSec: P, playing: false, anchoredAtMs: 0, nowMs: 10_000_000 });
	expect(viaPlaythenPause).toBe(P);
	expect(viaSeek).toBe(P);
	expect(viaBackground).toBe(P);
	// All three histories draw the identical offset — and it is never 0 (the top-of-reel snap).
	expect(new Set([viaPlaythenPause, viaSeek, viaBackground]).size).toBe(1);
});

test('paused: no wall-clock reading can move the drawn position off the anchor', () => {
	const P = 17;
	// Sweep an arbitrary set of clock pairs; paused output must be P for every one of them.
	for (const [anchoredAtMs, nowMs] of [
		[0, 0],
		[0, 60_000],
		[1000, 0],
		[999_999, 1],
		[1, 999_999]
	] as const) {
		expect(drawPosition({ positionSec: P, playing: false, anchoredAtMs, nowMs })).toBe(P);
	}
});

test('playing: extrapolates forward from the anchor by the elapsed wall time', () => {
	// 3s after the anchor at position 10 → draw 13.
	expect(drawPosition({ positionSec: 10, playing: true, anchoredAtMs: 5_000, nowMs: 8_000 })).toBe(13);
	// At the instant of the anchor, draw the anchor exactly.
	expect(drawPosition({ positionSec: 10, playing: true, anchoredAtMs: 5_000, nowMs: 5_000 })).toBe(10);
});

test('playing: the elapsed term is floored at 0 so the draw position never dips below the anchor', () => {
	// A clock that reads BEFORE the anchor (backwards jump / anchor captured slightly ahead) must not
	// pull the reel back — the floor is the anchor, never 0.
	expect(drawPosition({ positionSec: 30, playing: true, anchoredAtMs: 9_000, nowMs: 1_000 })).toBe(30);
});

// --- structural guards: the component must actually USE the pure function --------------------------
//
// The pure test above can prove the function is path-independent, but not that LyricsOverlay draws
// from it. These guards fail if the accumulator ever comes back.

// Was a sibling read of the component this guard sat beside in apps/core/src/lib/tv — the lyrics
// overlay, named from the repo root now that the guard no longer lives next to it.
const OVERLAY = read('apps/core/src/lib/tv/LyricsOverlay.svelte');
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src
		.replace(/<!--[\s\S]*?-->/g, blank)
		.replace(/\/\*[\s\S]*?\*\//g, blank)
		.replace(/\/\/[^\n]*/g, '');
}
const CODE = stripComments(OVERLAY);

test('LyricsOverlay imports and consumes drawPosition from the pure module', () => {
	expect(/from '\.\/lyrics-position'/.test(CODE)).toBe(true);
	expect(/drawPosition\s*\(/.test(CODE)).toBe(true);
});

test('the drawn position is not a mutable $state accumulator that a stopped rAF would lose', () => {
	// The bug shape: the drawn position kept as a mutable `$state(0)` that a requestAnimationFrame
	// tick rewrites every frame — so a throttled/stopped rAF (backgrounded tab) drifts it back to 0.
	// The invariant is BEHAVIOURAL, not a name: the drawn position must be a $derived DIRECTLY over the
	// pure `drawPosition(...)`, and the rAF tick may advance only the clock, never a drawn-position
	// accumulator. Pin both properties so a rename (`shownPos`) or a re-declared tick walks through
	// neither.
	const FLAT = CODE.replace(/\s+/g, ' ');

	// (1) POSITIVE invariant: the drawn position is $derived straight from the pure function. This is
	// the load-bearing assertion — it reds any accumulator, whatever it is named, because an
	// accumulator derives `displayPos` from a $state local (`$derived(shownPos)`), not from drawPosition.
	expect(/\$derived\(\s*drawPosition\s*\(/.test(FLAT)).toBe(true);

	// (2) The old name-pinned negative, kept as a cheap belt-and-suspenders check (no longer load-bearing).
	expect(
		/let\s+\w+\s*=\s*\$state\s*\(\s*0\s*\)\s*;[\s\S]*?const\s+displayPos\s*=\s*\$derived\s*\(\s*\w+\s*\)/.test(CODE)
	).toBe(false);

	// (3) Inspect the rAF tick body — matched in EITHER form (`const tick = () => {…}` OR
	// `function tick() {…}` OR `const tick = function () {…}`) so a re-declaration cannot make the scan
	// silently match nothing. A `files.length`-style sentinel makes a zero-match a FAILURE, not a
	// vacuous pass: the component must have exactly the one tick closure we expect to inspect.
	const tickBodies = [
		...CODE.matchAll(/const\s+tick\s*=\s*(?:\(\s*\)\s*=>|function\s*\(\s*\))\s*\{([\s\S]*?)\n\t\t\}/g),
		...CODE.matchAll(/function\s+tick\s*\(\s*\)\s*\{([\s\S]*?)\n\t\t\}/g)
	].map((m) => m[1]!);
	expect(tickBodies.length).toBeGreaterThan(0);
	for (const body of tickBodies) {
		// The tick may advance a clock (`now = …`), never a drawn-position accumulator.
		expect(/\b(displayPos|shownPos|cuePos|drawPos|drawnPos|reelPos|scrollPos)\s*=[^=]/.test(body)).toBe(false);
	}
});
