// guard: the TV must HOLD THE SCREEN AWAKE while a song is on stage, and release it when idle.
//
// THE DEFECT. Nothing in the app held the screen on — a full-state search for wake/awake/screensaver
// returned zero hits — so the OS screensaver blanked the room mid-song. A long instrumental break with
// no input was enough to lose the lyrics.
//
// THE FIX (owner ruling: Wake Lock only, all in the /tv route). An $effect takes a Screen Wake Lock
// while the room is showing a song and releases it in the effect's cleanup, exactly mirroring the
// ResizeObserver effect in the same file (acquire a platform resource, free it in the returned
// cleanup). Three parts are load-bearing and pinned below:
//   1. It requests 'screen' via navigator.wakeLock while playing, and releases the sentinel on cleanup.
//   2. A feature-detect guard makes it INERT where navigator.wakeLock is absent — which is EVERY
//      plain-HTTP LAN room, because the API is secure-context only. This is by design: blanking on a
//      plain-HTTP LAN TV stays a deployment concern (disable the OS screensaver), per the ruling.
//   3. It re-acquires on `visibilitychange`, because the platform drops the lock whenever the document
//      hides and never restores it on its own — without this it works once and then stops.
//
// WHY A SOURCE SCAN (not a mount). The mount rung landed a happy-dom + Svelte-loader harness that CAN mount leaf
// components (it stubs navigator.AudioContext and still reds on real defects), and a follow-up aliased the
// `$app`/`$env` virtual modules, so apps/core/src/routes/tv/+page.svelte now IMPORTS fine under the
// harness — pinned by apps/core/src/lib/mount-rung.test.ts. Two things still stand between that import
// and a mount of THIS route, and neither is in this file's scope: the component destructures a `data`
// prop supplied by +page.server.ts's load (mounting it means constructing that payload), and it reads
// `el.offsetHeight` for the card band, which THROWS on the mount rung — that follow-up made all six geometry
// APIs raise an error naming the rung instead of returning happy-dom's fabricated zero
// (docs/ux/04-verification.md, XR-VER-03), so a mount here would fail at that read rather than
// silently measure nothing. So the invariants here stay source scans over the component text, like
// autoplay-recovery.test.ts: which API is called, that it is guarded, that the lock is released on
// cleanup, and that a visibilitychange handler re-acquires it — all decidable from the source.
// Promoting them to a real mount is its own issue, and navigator.wakeLock being absent in the env is a
// stub's job there, not a reason to avoid mounting.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

// Blank out block, line, and HTML comments, PRESERVING newlines, so a commented-out line of wiring —
// or the explanatory prose above the effect, which names every token below — can never satisfy a guard.
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1 + '');
}

// The /tv route, named from the repo root so this guard's own location cannot move it.
const TV_ROUTE = 'apps/core/src/routes/tv/+page.svelte';

function tvSource(): string {
	return stripComments(read(TV_ROUTE));
}

test('the /tv route acquires a screen wake lock and releases it on cleanup', () => {
	const src = tvSource();
	// It requests the SCREEN wake lock — the only lock type that keeps the display on.
	expect(src).toMatch(/navigator\.wakeLock\b[\s\S]*?\.request\(\s*['"]screen['"]\s*\)/);
	// The acquire is inside an $effect that returns a cleanup — the ResizeObserver idiom. Locate the
	// effect that mentions wakeLock and scope every remaining check to ITS region, so a stray future
	// `.release()` or `return () =>` elsewhere in this large file cannot satisfy the guard.
	const acquireIdx = src.indexOf('navigator.wakeLock');
	expect(acquireIdx, 'wakeLock acquire not found').toBeGreaterThan(-1);
	const effectStart = src.lastIndexOf('$effect(', acquireIdx);
	expect(effectStart, 'wakeLock acquire is not inside an $effect').toBeGreaterThan(-1);
	const region = src.slice(effectStart, acquireIdx + 1400);
	// The held sentinel is released WITHIN this effect — its cleanup frees the platform resource when
	// the room goes idle or the component tears down. Scoped to the region, so reverting THIS effect's
	// release (not some unrelated one) is what reds it.
	expect(region).toMatch(/\.release\(\)/);
	// The effect returns a `() =>` cleanup.
	expect(region).toMatch(/return\s*\(\)\s*=>/);
});

test('the wake-lock effect is FEATURE-DETECT guarded so it is inert without the API', () => {
	const src = tvSource();
	// The guard bails when the API is absent — secure-context only, so undefined on every plain-HTTP
	// LAN room and during SSR (no navigator). Removing the guard reds this; it mirrors the
	// `typeof ResizeObserver === 'undefined'` guard already in this file.
	expect(src).toMatch(
		/if\s*\(\s*typeof\s+navigator\s*===\s*['"]undefined['"]\s*\|\|\s*!navigator\.wakeLock\s*\)\s*return/
	);
});

test('the wake-lock is gated on being on-stage, not held forever', () => {
	const src = tvSource();
	// The effect reads the on-stage flag (!isAttract) and returns early when idle, so attract/lobby
	// release the lock rather than pinning the screen awake with nothing playing. `!isAttract` is the
	// same flag the player slots and stage background gate on. Reverting the `if (!playing) return`
	// (or the `!isAttract` read) reds this — the lock would then be taken on the idle screens too.
	const acquireIdx = src.indexOf('navigator.wakeLock');
	const effectStart = src.lastIndexOf('$effect(', acquireIdx);
	const region = src.slice(effectStart, acquireIdx + 1200);
	expect(region).toMatch(/!isAttract/);
	expect(region).toMatch(/if\s*\(\s*!playing\s*\)\s*return/);
});

test('the wake-lock is RE-ACQUIRED on visibilitychange', () => {
	const src = tvSource();
	// The platform drops the lock when the document hides and does not restore it — so a listener
	// re-requests when the page becomes visible again. No visibilitychange handler existed in this file
	// before this fix landed; removing the listener registration reds this.
	expect(src).toMatch(/addEventListener\(\s*['"]visibilitychange['"]/);
	// And the listener is torn down on cleanup — a matching removeEventListener — so a re-run does not
	// stack a second handler.
	expect(src).toMatch(/removeEventListener\(\s*['"]visibilitychange['"]/);
	// The load-bearing part of the fix ("without this it works once and then stops"): the HANDLER BODY must
	// re-acquire, gated on the page being visible again (a hide event also fires visibilitychange).
	// A token-only check would stay green if someone kept the listener + the visible check but deleted
	// the acquire() call inside — the exact half-fixed regression. So isolate the handler's body and
	// assert it both checks visibility AND calls acquire(). Anchor on the visibilitychange handler arrow.
	const onVisIdx = src.search(/const\s+onVisibility\s*=\s*\(\)\s*=>/);
	expect(onVisIdx, 'a named visibilitychange handler (onVisibility) not found').toBeGreaterThan(-1);
	const body = src.slice(onVisIdx, onVisIdx + 240);
	expect(body).toMatch(/visibilityState\s*===\s*['"]visible['"]/);
	expect(body, 'the visibilitychange handler must call acquire() — not just check visibility').toMatch(/acquire\(\)/);
});
