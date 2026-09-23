// guard: the TV must RECOVER from a blocked autoplay, and must do so WITHOUT building a WebAudio graph.
//
// Caught: a plain <audio> in a page that never received a user gesture is refused under the browser's default
// autoplay policy with NotAllowedError — the state a set-and-forget TV wall is always in — and TvPlayer treated that
// refusal as terminal, with no gesture handler anywhere on /tv to lift it. The recovery is a bare element.play()
// re-attempt on a document-wide gesture listener; it must NOT wrap the element in a MediaElementAudioSourceNode to
// "solve" autoplay, because that capture is PERMANENT and at keyShift===0 there must be no AudioContext at all.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '@encore/test-support';

// Blank comments, PRESERVING newlines, so a commented-out line of wiring cannot satisfy a guard below.
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1 + '');
}

const TV_PLAYER = at('src/lib/tv/TvPlayer.svelte');
const TV_ROUTE = at('src/routes/tv/+page.svelte');

test('TvPlayer latches recovery on NotAllowedError SPECIFICALLY, not on every rejection', () => {
	const src = stripComments(readFileSync(TV_PLAYER, 'utf8'));
	// Only autoplay refusal is gesture-liftable, so a blanket catch would arm the hint on an AbortError from a real
	// src change too.
	expect(src).toMatch(/name\s*===\s*['"]NotAllowedError['"]/);
	expect(src).toMatch(/autoplayBlocked\s*=\s*true/);
	// Any other rejection must STILL degrade to the logged "silent room", never be read as a blocked autoplay.
	expect(src).toContain('the room will be silent');
});

test('TvPlayer arms a document-wide gesture listener that re-attempts playback', () => {
	const src = stripComments(readFileSync(TV_PLAYER, 'utf8'));
	// A gesture anywhere authorises playback for the document, so the listener is on window and covers a tap AND a
	// keypress — a remote or keyboard is a valid gesture on a TV.
	expect(src).toMatch(/window\.addEventListener\(\s*['"]pointerdown['"]/);
	expect(src).toMatch(/window\.addEventListener\(\s*['"]keydown['"]/);
	// The listener is armed UNCONDITIONALLY: gating its effect on the latch means a TV whose autoplay succeeded
	// has no gesture listener at all, so its AudioContext is never resumed and every ± press degrades silently.
	// The play() nudge stays latch-gated INSIDE the handler, read at gesture time, so a tap cannot start a room
	// somebody deliberately paused.
	expect(src).not.toMatch(/if\s*\(\s*!autoplayBlocked\s*\)\s*return/);
	expect(src).toMatch(/if\s*\(\s*autoplayBlocked\s*\)\s*\{/);
	expect(src).toContain('tryPlayMaster');
	// And the gesture re-drives a transpose that could not route for want of activation.
	expect(src).toContain('retryPitchAfterGesture');
	expect(src).toMatch(/autoplayBlocked\s*=\s*false/);
	expect(src).toContain('onautoplayrecovered');
	// A real $state, not a plain `let`: the hint's {#if} and the gesture effect both track it.
	expect(src).toMatch(/let\s+autoplayBlocked\s*=\s*\$state\(false\)/);
	// Each callback must appear in the DESTRUCTURE list (trailing comma OR end-of-list), so the parent's handlers
	// are the ones invoked and a later prop does not falsify the guard.
	expect(src).toMatch(/onautoplayblocked\s*,/);
	expect(src).toMatch(/onautoplayrecovered\s*[,\n]/);
});

test('the gesture recovery path builds NO AudioContext / MediaElementSource — keyShift===0 invariant', () => {
	const src = stripComments(readFileSync(TV_PLAYER, 'utf8'));
	const tryStart = src.indexOf('async function tryPlayMaster');
	expect(tryStart, 'tryPlayMaster helper not found').toBeGreaterThan(-1);
	// The region ends at `const shift = …`, the first executable line of the pitch-shift effect (the only
	// sanctioned `new PitchShiftGraph`), rather than a comment banner — stripComments blanks those.
	const pitchEffect = src.indexOf('const shift = active ? keyShift : 0');
	expect(pitchEffect, 'pitch-shift effect not found').toBeGreaterThan(tryStart);
	const recoveryRegion = src.slice(tryStart, pitchEffect);
	expect(recoveryRegion).not.toContain('new PitchShiftGraph');
	expect(recoveryRegion).not.toContain('new AudioContext');
	expect(recoveryRegion).not.toContain('createMediaElementSource');
});

test('the /tv route surfaces the hint gated on the block, and wires both slots', () => {
	const src = stripComments(readFileSync(TV_ROUTE, 'utf8'));
	expect(src).toMatch(/let\s+autoplayBlocked\s*=\s*\$state\(false\)/);
	// Read the gate's whole expression, not one spelling: the idle-room term beside it belongs to the test below.
	expect(src).toMatch(/\{#if\s+[^}]*autoplayBlocked[^}]*\}/);
	const blocked = src.match(/onautoplayblocked=/g) ?? [];
	const recovered = src.match(/onautoplayrecovered=/g) ?? [];
	expect(blocked.length, 'both TvPlayer slots must wire onautoplayblocked').toBe(2);
	expect(recovered.length, 'both TvPlayer slots must wire onautoplayrecovered').toBe(2);
	// A real, focusable <button>, so a keypress — one of the recovery gestures — can reach it.
	expect(src).toMatch(/class="autoplay-hint"/);
	const rule = src.match(/\.autoplay-hint\s*\{([^}]*)\}/);
	expect(rule, 'the .autoplay-hint style rule must exist').not.toBeNull();
	const body = rule ? rule[1] : '';
	// `position` is load-bearing: `inset` is ignored on a statically-positioned box and `z-index` applies
	// only to a positioned box, so both assertions below are inert without it.
	expect(body).toMatch(/position:\s*absolute/);
	expect(body).toMatch(/inset:\s*0/);
	expect(body).toMatch(/z-index:\s*var\(--z-tv-affordance\)/);
});

// Caught: `{#if autoplayBlocked}` alone gated the full-screen tap-to-start scrim. The latch's only two writers are
// per-slot props, so when the room DRAINS both players unmount and neither can fire again — the scrim then sat over
// the lobby of an empty room, blocking the join card while promising to start music with nothing queued. Fixed by
// also gating on `!isAttract`, NOT by clearing the latch: the block is a real property of a never-tapped TV.
test('the /tv autoplay hint is scoped to the on-stage band, so it cannot outlive the room', () => {
	const src = stripComments(readFileSync(TV_ROUTE, 'utf8'));

	// Non-vacuity: the room's one definition of "idle" must exist rather than be re-derived at the overlay.
	expect(src).toMatch(/const\s+isAttract\s*=\s*\$derived\(/);

	// Read the whole {#if} expression and check each term separately, so the guard is independent of the order
	// they are written in and of any later third term.
	const gate = src.match(/\{#if\s+([^}]*autoplayBlocked[^}]*)\}/);
	expect(gate, 'the autoplay hint must still be gated on the block').not.toBeNull();
	const expr = gate ? gate[1] : '';
	expect(expr).toContain('autoplayBlocked');
	expect(expr, 'the hint must also require the room to be on-stage').toMatch(/!\s*isAttract/);

	// The affirmative cannot catch a re-added unconditional copy elsewhere, so the bare form is banned outright —
	// the arm that reds if the production hunk is reverted.
	expect(src, 'no {#if} may gate the hint on the latch alone — that is the defect').not.toMatch(
		/\{#if\s+autoplayBlocked\s*\}/
	);

	// The SAME band the players use, not a parallel notion of idleness. Two slots, one each.
	const slotGates = src.match(/visible=\{\s*visible\s*===\s*'[AB]'\s*&&\s*!isAttract\s*\}/g) ?? [];
	expect(slotGates.length, 'both player slots gate visibility on the same !isAttract band').toBe(2);
});

// The else branch of the play()-rejection catch (a decode failure, an AbortError from a real src change) is
// the ONE silent-room case a tap cannot lift, and its only trace was a console.warn nobody at a party reads.
test('TvPlayer FIRES onplaybackfailed from the non-recoverable else branch, active+visible only', () => {
	const src = stripComments(readFileSync(TV_PLAYER, 'utf8'));
	expect(src).toMatch(/onplaybackfailed\s*[,\n]/);
	// Gated on active+visible like onautoplayblocked, so the hidden pre-warming slot cannot report a phantom failure.
	const silentLog = src.indexOf('the room will be silent');
	expect(silentLog, 'the else-branch marker not found').toBeGreaterThan(-1);
	const elseRegion = src.slice(silentLog);
	expect(elseRegion).toMatch(/if\s*\(\s*active\s*&&\s*visible\s*\)\s*onplaybackfailed\?\.\(/);
});

test('the /tv route renders an on-screen silent-room panel fed only by the slots, and clears it', () => {
	const src = stripComments(readFileSync(TV_ROUTE, 'utf8'));
	expect(src).toMatch(/let\s+playbackFailedReason\s*:\s*string\s*\|\s*null\s*=\s*\$state\(null\)/);
	expect(src).toMatch(/\{#if\s+playbackFailedReason\s*\}/);
	const failed = src.match(/onplaybackfailed=/g) ?? [];
	expect(failed.length, 'both TvPlayer slots must wire onplaybackfailed').toBe(2);
	// The failure is non-recoverable, so the honest clear point is a NEW song (onready), not a resume of the failed one.
	const clears = src.match(/playbackFailedReason\s*=\s*null/g) ?? [];
	expect(clears.length, 'the panel must be cleared on onready in BOTH slots').toBe(2);
	// `position` again carries `inset` and `z-index`. The interstitial tier sits BELOW the affordance tier,
	// so a genuinely gesture-liftable autoplay block always wins if both somehow raise.
	const rule = src.match(/\.silent-room\s*\{([^}]*)\}/);
	expect(rule, 'the .silent-room style rule must exist').not.toBeNull();
	const body = rule ? rule[1] : '';
	expect(body).toMatch(/position:\s*absolute/);
	expect(body).toMatch(/inset:\s*0/);
	expect(body).toMatch(/z-index:\s*var\(--z-tv-interstitial\)/);
});
