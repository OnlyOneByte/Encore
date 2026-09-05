// guard: the lyrics reel draws from a PURE function of the playback position, so a backgrounded tab
// (throttled/stopped rAF) has no loop-carried state to lose. See lyrics-position.ts for issue #54.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { drawPosition } from './lyrics-position';

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
		[0, 0], [0, 60_000], [1000, 0], [999_999, 1], [1, 999_999]
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

const OVERLAY = readFileSync(join(import.meta.dir, 'LyricsOverlay.svelte'), 'utf8');
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, '');
}
const CODE = stripComments(OVERLAY);

test('LyricsOverlay imports and consumes drawPosition from the pure module', () => {
	expect(/from '\.\/lyrics-position'/.test(CODE)).toBe(true);
	expect(/drawPosition\s*\(/.test(CODE)).toBe(true);
});

test('the drawn position is not a mutable $state accumulator that a stopped rAF would lose', () => {
	// The bug shape: `let displayPos = $state(0)` written imperatively inside a requestAnimationFrame
	// tick. The drawn position must instead be a $derived over the pure function. Assert there is no
	// $state-backed position that the reel reads.
	expect(/let\s+displayPos\s*=\s*\$state/.test(CODE)).toBe(false);
	// And there must be no assignment of a position variable from inside the rAF tick callback body:
	// the loop may advance a clock, never the drawn position itself. Inspect only the tick closure.
	const tickBodies = [...CODE.matchAll(/const\s+tick\s*=\s*\(\)\s*=>\s*\{([\s\S]*?)\};/g)].map((m) => m[1]!);
	for (const body of tickBodies) {
		expect(/\b(displayPos|cuePos)\s*=/.test(body)).toBe(false);
	}
});
