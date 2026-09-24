// guard: the lyrics reel draws from a PURE function of the playback position, so a backgrounded tab
// (throttled/stopped rAF) has no loop-carried state to lose. See lyrics-position.ts for the purity rule.
import { test, expect } from 'bun:test';
import { read } from '$test';
import { drawPosition } from '$lib/tv/lyrics-position';

// PATH INDEPENDENCE is the detector for "derived state accumulated instead of computed": reaching the same
// authoritative position by different histories must draw the same place. The defocus-while-paused defect
// is exactly a path that reaches position P but draws position 0.

test('paused: the drawn position is the authoritative position, independent of history', () => {
	const P = 42.5;
	// paused after playing up to P (a big wall-clock gap while backgrounded)…
	const viaPlaythenPause = drawPosition({ positionSec: P, playing: false, anchoredAtMs: 1_000, nowMs: 999_999 });
	// …after seeking straight to P (no elapsed wall time)…
	const viaSeek = drawPosition({ positionSec: P, playing: false, anchoredAtMs: 500_000, nowMs: 500_000 });
	// …and backgrounded and returned, where the rAF loop never ran and "now" is far in the future.
	const viaBackground = drawPosition({ positionSec: P, playing: false, anchoredAtMs: 0, nowMs: 10_000_000 });
	expect(viaPlaythenPause).toBe(P);
	expect(viaSeek).toBe(P);
	expect(viaBackground).toBe(P);
	// All three draw the identical offset, and it is never 0 (the top-of-reel snap).
	expect(new Set([viaPlaythenPause, viaSeek, viaBackground]).size).toBe(1);
});

test('paused: no wall-clock reading can move the drawn position off the anchor', () => {
	const P = 17;
	// Paused output must be P for every clock pair.
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
	expect(drawPosition({ positionSec: 10, playing: true, anchoredAtMs: 5_000, nowMs: 8_000 })).toBe(13);
	// At the instant of the anchor, draw the anchor exactly.
	expect(drawPosition({ positionSec: 10, playing: true, anchoredAtMs: 5_000, nowMs: 5_000 })).toBe(10);
});

test('playing: the elapsed term is floored at 0 so the draw position never dips below the anchor', () => {
	// A clock reading BEFORE the anchor (a backwards jump) must not pull the reel back: the floor is the anchor, never 0.
	expect(drawPosition({ positionSec: 30, playing: true, anchoredAtMs: 9_000, nowMs: 1_000 })).toBe(30);
});

// The arms above prove the function is path-independent, but not that LyricsOverlay draws FROM it.
const OVERLAY = read('src/lib/tv/LyricsOverlay.svelte');
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
	// The defect shape is a drawn position kept as a mutable `$state(0)` that a requestAnimationFrame tick
	// rewrites every frame, so a throttled or stopped rAF drifts it back to 0. The invariant is BEHAVIOURAL
	// rather than a name: the drawn position must be `$derived` DIRECTLY over the pure `drawPosition(...)`,
	// and the tick may advance only the clock.
	const FLAT = CODE.replace(/\s+/g, ' ');

	// The load-bearing assertion: it reds any accumulator whatever it is named, because an accumulator
	// derives from a `$state` local rather than from drawPosition.
	expect(/\$derived\(\s*drawPosition\s*\(/.test(FLAT)).toBe(true);

	// The name-pinned negative, kept as a cheap second check.
	expect(
		/let\s+\w+\s*=\s*\$state\s*\(\s*0\s*\)\s*;[\s\S]*?const\s+displayPos\s*=\s*\$derived\s*\(\s*\w+\s*\)/.test(CODE)
	).toBe(false);

	// The rAF tick body, matched in every declaration form so a re-declaration cannot make the scan silently
	// match nothing; a zero match is a FAILURE rather than a vacuous pass.
	const tickBodies = [
		...CODE.matchAll(/const\s+tick\s*=\s*(?:\(\s*\)\s*=>|function\s*\(\s*\))\s*\{([\s\S]*?)\n\t\t\}/g),
		...CODE.matchAll(/function\s+tick\s*\(\s*\)\s*\{([\s\S]*?)\n\t\t\}/g)
	].map((m) => m[1]!);
	expect(tickBodies.length).toBeGreaterThan(0);
	for (const body of tickBodies) {
		// It may advance a clock (`now = …`), never a drawn-position accumulator.
		expect(/\b(displayPos|shownPos|cuePos|drawPos|drawnPos|reelPos|scrollPos)\s*=[^=]/.test(body)).toBe(false);
	}
});
