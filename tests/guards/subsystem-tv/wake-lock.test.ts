// guard: the TV must HOLD THE SCREEN AWAKE while a song is on stage, and release it when idle.
//
// Caught: nothing in the app held the screen on, so the OS screensaver blanked the room mid-song — a long
// instrumental break with no input was enough to lose the lyrics. An $effect now takes a Screen Wake Lock
// while a song is on stage and releases it in the effect's cleanup, mirroring the ResizeObserver effect in
// the same file.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

// Blank comments, PRESERVING newlines: the explanatory prose above the effect names every token asserted
// below, so an unstripped scan could pass on the documentation with the wiring commented out.
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1 + '');
}

const TV_ROUTE = 'src/routes/tv/+page.svelte';

function tvSource(): string {
	return stripComments(read(TV_ROUTE));
}

test('the /tv route acquires a screen wake lock and releases it on cleanup', () => {
	const src = tvSource();
	// 'screen' is the only lock type that keeps the display on.
	expect(src).toMatch(/navigator\.wakeLock\b[\s\S]*?\.request\(\s*['"]screen['"]\s*\)/);
	// Every remaining check is scoped to the region of the effect that mentions wakeLock, so a stray future
	// `.release()` or `return () =>` elsewhere in this large file cannot satisfy the guard.
	const acquireIdx = src.indexOf('navigator.wakeLock');
	expect(acquireIdx, 'wakeLock acquire not found').toBeGreaterThan(-1);
	const effectStart = src.lastIndexOf('$effect(', acquireIdx);
	expect(effectStart, 'wakeLock acquire is not inside an $effect').toBeGreaterThan(-1);
	const region = src.slice(effectStart, acquireIdx + 1400);
	expect(region).toMatch(/\.release\(\)/);
	expect(region).toMatch(/return\s*\(\)\s*=>/);
});

test('the wake-lock effect is FEATURE-DETECT guarded so it is inert without the API', () => {
	const src = tvSource();
	// Wake Lock is secure-context only, so `navigator.wakeLock` is undefined on every plain-HTTP LAN room
	// and during SSR. Being inert there is deliberate: blanking on such a TV stays a deployment concern
	// (disable the OS screensaver). Mirrors the `typeof ResizeObserver === 'undefined'` guard beside it.
	expect(src).toMatch(
		/if\s*\(\s*typeof\s+navigator\s*===\s*['"]undefined['"]\s*\|\|\s*!navigator\.wakeLock\s*\)\s*return/
	);
});

test('the wake-lock is gated on being on-stage, not held forever', () => {
	const src = tvSource();
	// `!isAttract` is the same flag the player slots and the stage background gate on; without both reads the
	// lock is taken on the idle screens too, pinning the screen awake with nothing playing.
	const acquireIdx = src.indexOf('navigator.wakeLock');
	const effectStart = src.lastIndexOf('$effect(', acquireIdx);
	const region = src.slice(effectStart, acquireIdx + 1200);
	expect(region).toMatch(/!isAttract/);
	expect(region).toMatch(/if\s*\(\s*!playing\s*\)\s*return/);
});

test('the wake-lock is RE-ACQUIRED on visibilitychange', () => {
	const src = tvSource();
	// The platform DROPS the lock whenever the document hides and never restores it, so without this the
	// feature works exactly once. The listener is torn down on cleanup so a re-run cannot stack a second one.
	expect(src).toMatch(/addEventListener\(\s*['"]visibilitychange['"]/);
	expect(src).toMatch(/removeEventListener\(\s*['"]visibilitychange['"]/);
	// The handler BODY must both check visibility (a hide also fires visibilitychange) AND call acquire(): a
	// token-only check stays green if someone keeps the listener and the visible test but deletes the acquire.
	const onVisIdx = src.search(/const\s+onVisibility\s*=\s*\(\)\s*=>/);
	expect(onVisIdx, 'a named visibilitychange handler (onVisibility) not found').toBeGreaterThan(-1);
	const body = src.slice(onVisIdx, onVisIdx + 240);
	expect(body).toMatch(/visibilityState\s*===\s*['"]visible['"]/);
	expect(body, 'the visibilitychange handler must call acquire() — not just check visibility').toMatch(/acquire\(\)/);
});
