// guard: the TV must be able to RECOVER from a blocked autoplay, and must do so WITHOUT building a
// WebAudio graph.
//
// THE DEFECT. A plain <audio> in a page that never received a user gesture is refused under the
// browser's default autoplay policy with a NotAllowedError — which is exactly the state a set-and-
// forget TV wall is in. TvPlayer used to CATCH that rejection, log "the room will be silent", and stop
// there: the refusal was treated as terminal even though it is the one refusal a user gesture can lift,
// and the /tv surface registered no gesture anywhere (grep for click/pointerdown/touchstart returned
// zero handlers). So a real TV sat silent with no on-screen way back.
//
// THE FIX, and the TRAP it must not fall into. The recovery is a bare element.play() re-attempt on a
// document-wide gesture listener plus an on-screen "tap to start" affordance. It must NOT eagerly wrap
// the element in a MediaElementAudioSourceNode to "solve" autoplay: pitch-shift.ts documents that a
// MediaElementSource is a PERMANENT capture, so wrapping the element commits ALL room audio to WebAudio
// forever, and at keyShift===0 there must be NO AudioContext and NO MediaElementSource at all. The
// recovery therefore touches only the plain <audio>; the pitch graph stays built lazily on the first
// non-zero shift, unchanged.
//
// WHY A SOURCE SCAN. Encore has no jsdom/happy-dom — every UI invariant here is a source scan over the
// component text. The behaviour under test (which error latches recovery, that a gesture re-plays the
// element, that no graph is constructed on that path, that the page surfaces the hint) is a property of
// the component source, decidable without rendering. The rendered proof (the hint appears under the
// default policy and a synthetic tap starts playback) lives in the PR body via the CDP driver.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '@encore/test-support';

// Blank out /* */ and // comments and <!-- --> HTML comments, PRESERVING newlines, so a commented-out
// line of wiring can never satisfy a guard below.
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1 + '');
}

// Both subjects are named absolutely. TV_PLAYER used to be `at('apps/core/src/lib/tv/TvPlayer.svelte')` — "the component next to me", which only identified the TV player while this
// test sat in lib/tv/; nothing could infer WHICH component it meant once it moved.
const TV_PLAYER = at('apps/core/src/lib/tv/TvPlayer.svelte');
const TV_ROUTE = at('apps/core/src/routes/tv/+page.svelte');

test('TvPlayer latches recovery on NotAllowedError SPECIFICALLY, not on every rejection', () => {
	const src = stripComments(readFileSync(TV_PLAYER, 'utf8'));
	// It must branch on the error NAME being NotAllowedError — a blanket catch that latches on any
	// rejection would arm the hint on an AbortError from a real src change too. The distinction is the
	// whole point: only autoplay refusal is gesture-liftable.
	expect(src).toMatch(/name\s*===\s*['"]NotAllowedError['"]/);
	// Inside that branch it raises the latch that drives the hint + the gesture listener.
	expect(src).toMatch(/autoplayBlocked\s*=\s*true/);
	// A non-NotAllowedError rejection must STILL degrade to the logged "silent room" — the catch keeps
	// its else branch, so a decode failure is not silently swallowed nor mistaken for a blocked autoplay.
	expect(src).toContain('the room will be silent');
});

test('TvPlayer arms a document-wide gesture listener that re-attempts playback', () => {
	const src = stripComments(readFileSync(TV_PLAYER, 'utf8'));
	// A user gesture ANYWHERE authorises playback for the document, so the listener is on window and
	// covers a tap AND a keypress (a remote / keyboard is a valid gesture on a TV).
	expect(src).toMatch(/window\.addEventListener\(\s*['"]pointerdown['"]/);
	expect(src).toMatch(/window\.addEventListener\(\s*['"]keydown['"]/);
	// The listener is armed only while blocked (its effect early-returns otherwise) and re-attempts the
	// master's play via the tracking helper — the ONE place a play() promise is resolved.
	expect(src).toMatch(/if\s*\(\s*!autoplayBlocked\s*\)\s*return/);
	expect(src).toContain('tryPlayMaster');
	// On recovery the latch clears and the page is told — so the hint retracts and the listener's effect
	// cleanup removes it.
	expect(src).toMatch(/autoplayBlocked\s*=\s*false/);
	expect(src).toContain('onautoplayrecovered');
	// The latch is a real $state, not a plain let — the hint's {#if} and the gesture effect both track
	// it, so reactivity is load-bearing. Pins hunk #3 (the state declaration); a plain `let` would leave
	// the effect and the callbacks reading a non-reactive value.
	expect(src).toMatch(/let\s+autoplayBlocked\s*=\s*\$state\(false\)/);
	// The two callbacks are actually DESTRUCTURED from props (not merely declared in the interface), so
	// the parent's handlers are the ones invoked. Pins hunk #2. Each must appear in the destructure list
	// as its own entry — trailing comma OR end-of-list — so a later prop (onplayingchange now sits
	// after onautoplayrecovered) does not falsify the guard while the destructuring it checks still holds.
	expect(src).toMatch(/onautoplayblocked\s*,/);
	expect(src).toMatch(/onautoplayrecovered\s*[,\n]/);
});

test('the gesture recovery path builds NO AudioContext / MediaElementSource — keyShift===0 invariant', () => {
	const src = stripComments(readFileSync(TV_PLAYER, 'utf8'));
	// Isolate the recovery helper + the gesture-listener effect and prove neither constructs a graph.
	// The ONLY sanctioned graph construction in this file is the lazy `new PitchShiftGraph(...)` inside
	// the pitch-shift effect, which is gated on needsShift(shift). The recovery path must contain no
	// `new PitchShiftGraph`, no `new AudioContext`, and no createMediaElementSource.
	const tryStart = src.indexOf('async function tryPlayMaster');
	expect(tryStart, 'tryPlayMaster helper not found').toBeGreaterThan(-1);
	// From the helper to the pitch-shift effect's first CODE line is the recovery region: the helper,
	// then the gesture $effect. Anchor on `const shift = active ? keyShift : 0;` — the first executable
	// line of the pitch-shift effect (the one legitimate graph builder) — rather than a comment banner,
	// since stripComments blanks comments. That effect is the only sanctioned `new PitchShiftGraph`.
	const pitchEffect = src.indexOf('const shift = active ? keyShift : 0');
	expect(pitchEffect, 'pitch-shift effect not found').toBeGreaterThan(tryStart);
	const recoveryRegion = src.slice(tryStart, pitchEffect);
	expect(recoveryRegion).not.toContain('new PitchShiftGraph');
	expect(recoveryRegion).not.toContain('new AudioContext');
	expect(recoveryRegion).not.toContain('createMediaElementSource');
});

test('the /tv route surfaces the hint gated on the block, and wires both slots', () => {
	const src = stripComments(readFileSync(TV_ROUTE, 'utf8'));
	// A page-level latch, fed only by the slots' callbacks.
	expect(src).toMatch(/let\s+autoplayBlocked\s*=\s*\$state\(false\)/);
	// The hint renders ONLY when blocked, so a TV that autoplays fine never shows it. Read the gate's
	// whole expression rather than pinning one exact spelling: the block term is what THIS test owns, and
	// the idle-room term it now sits beside is owned by the on-stage-band test below.
	expect(src).toMatch(/\{#if\s+[^}]*autoplayBlocked[^}]*\}/);
	// Both TvPlayer slots report the block up and the recovery back down. Two of each — one per slot.
	const blocked = src.match(/onautoplayblocked=/g) ?? [];
	const recovered = src.match(/onautoplayrecovered=/g) ?? [];
	expect(blocked.length, 'both TvPlayer slots must wire onautoplayblocked').toBe(2);
	expect(recovered.length, 'both TvPlayer slots must wire onautoplayrecovered').toBe(2);
	// The affordance is a real, focusable control (a <button>) so a keypress — one of the recovery
	// gestures — can reach it, and it is dismissable.
	expect(src).toMatch(/class="autoplay-hint"/);
	// The affordance must actually be STYLED as a full-screen top-of-stack overlay, not an unstyled
	// button that a viewer cannot see or tap. Pins hunk #11 (the .autoplay-hint CSS): the rule must exist,
	// cover the viewport (inset: 0), and sit above every other layer (z-index: 10) so a tap anywhere lands.
	// Match against the comment-stripped `src` computed above: a live CSS rule is neither a /* */ nor an
	// <!-- --> comment, so stripComments leaves it intact, while a commented-out copy of the selector is
	// blanked to spaces — so the first regex match is always the real rule, not a decoy comment above it.
	const rule = src.match(/\.autoplay-hint\s*\{([^}]*)\}/);
	expect(rule, 'the .autoplay-hint style rule must exist').not.toBeNull();
	const body = rule ? rule[1] : '';
	// position is the load-bearing declaration: inset is ignored on a statically-positioned box and
	// z-index applies only to a positioned box, so both assertions below are inert without it. Dropping
	// `position` shrinks the affordance to normal-flow ~26% of the viewport with those two still present.
	expect(body).toMatch(/position:\s*absolute/);
	expect(body).toMatch(/inset:\s*0/);
	expect(body).toMatch(/z-index:\s*var\(--z-tv-affordance\)/);
});

// ─────────────────────────────────────────────────────────────────────────────
// the hint must not outlive the room.
//
// THE DEFECT. `{#if autoplayBlocked}` was the ONLY gate on the full-screen tap-to-start overlay — it
// carried no term for "there is something to play". The latch has exactly two writers, both per-slot
// props (onautoplayblocked -> true, onautoplayrecovered -> false), so when the room DRAINS — a skip at
// the last entry, where player.ts advance() finds no nextPlayable and sets currentEntryId null /
// isPlaying false — both players unmount and NEITHER callback can fire again. The 82%-opaque
// full-viewport scrim (inset: 0, z-index: 10, pinned above) then sat over the lobby of an EMPTY room
// indefinitely: measured 1920x1080 with elementFromPoint over the join card returning the hint's own
// child, so nobody could join off the TV, while its text still promised to "start the music" with
// nothing queued. Reached gestureless with two inputs and no tap, which is the state a TV wall lives in.
//
// THE FIX. Gate the overlay on `!isAttract` too — the SAME derived the player slots, the stage
// background and the wake lock already use — so it is scoped to the band where a song is on stage. NOT
// by clearing the latch: the block is a real property of a TV that has still never been tapped, so it
// must be announced again the moment something reaches the stage, which requires the latch to survive
// the idle window.
//
// Source scan for the same reason as the guards above: no jsdom, so which terms gate a markup
// block is a property of the component text. The rendered proof (the scrim is gone and the join card is
// the topmost element at its own centre after the drain) is the CDP capture in the PR body.

test('the /tv autoplay hint is scoped to the on-stage band, so it cannot outlive the room', () => {
	const src = stripComments(readFileSync(TV_ROUTE, 'utf8'));

	// Non-vacuity: the derived this guard requires the overlay to consult must exist, and be the room's
	// one definition of "idle" rather than a second predicate re-derived at the overlay.
	expect(src).toMatch(/const\s+isAttract\s*=\s*\$derived\(/);

	// The overlay's gate must carry BOTH terms. Read the whole {#if} expression and check each term
	// separately so the guard is independent of which order they are written in and of any later third
	// term, while still requiring the idle-room one to be present and NEGATED.
	const gate = src.match(/\{#if\s+([^}]*autoplayBlocked[^}]*)\}/);
	expect(gate, 'the autoplay hint must still be gated on the block').not.toBeNull();
	const expr = gate ? gate[1] : '';
	expect(expr).toContain('autoplayBlocked');
	expect(expr, 'the hint must also require the room to be on-stage').toMatch(/!\s*isAttract/);

	// The affirmative above cannot by itself catch a REGRESSION that re-adds an unconditional copy of
	// the overlay elsewhere in the file, so ban the bare form outright: after the fix no {#if} anywhere
	// in the route gates on the latch alone. This is the arm that reds if the production hunk is reverted.
	expect(src, 'no {#if} may gate the hint on the latch alone — that is the defect').not.toMatch(
		/\{#if\s+autoplayBlocked\s*\}/
	);

	// It is the SAME band the players use, not a parallel notion of idleness — the overlay was the one
	// full-screen layer that did not consult the flag every other layer already did. Two slots, one each.
	const slotGates = src.match(/visible=\{\s*visible\s*===\s*'[AB]'\s*&&\s*!isAttract\s*\}/g) ?? [];
	expect(slotGates.length, 'both player slots gate visibility on the same !isAttract band').toBe(2);
});

// ─────────────────────────────────────────────────────────────────────────────
// the silent-room case must be VISIBLE to the operator, not just logged.
//
// THE DEFECT. The else branch of the play()-rejection catch (a decode failure, an AbortError from a
// real src change — anything NOT NotAllowedError) is the ONE case where the room goes silent with no
// recovery: a tap cannot lift it. Its only trace was `console.warn('… the room will be silent')`,
// which lands in the TV's devtools console that nobody at a party is looking at. There was no latch,
// no callback, and no on-screen state — a user-visible failure with zero operator signal.
//
// THE FIX. TvPlayer fires a new `onplaybackfailed(reason)` from that else branch (active+visible slot
// only, mirroring onautoplayblocked so the hidden pre-warming slot cannot raise a phantom), and the
// /tv route renders an on-screen "the room is silent" panel from a `playbackFailedReason` $state fed
// only by those callbacks. These are source-scan guards for the same reason as the ones above:
// no jsdom, so the wiring is a property of the component text.

test('TvPlayer FIRES onplaybackfailed from the non-recoverable else branch, active+visible only', () => {
	const src = stripComments(readFileSync(TV_PLAYER, 'utf8'));
	// The callback is a real destructured prop, not merely declared in the interface — so the parent's
	// handler is the one invoked. A trailing comma OR end-of-list entry.
	expect(src).toMatch(/onplaybackfailed\s*[,\n]/);
	// It fires from the else branch — the region AFTER the NotAllowedError branch closes — and is gated
	// on active+visible exactly like onautoplayblocked, so the hidden slot cannot report a phantom
	// failure. Slice from the else's own log line (the anchor that marks the non-recoverable branch) to
	// the end of the catch, and prove the guarded fire lives there.
	const silentLog = src.indexOf('the room will be silent');
	expect(silentLog, 'the else-branch marker not found').toBeGreaterThan(-1);
	const elseRegion = src.slice(silentLog);
	expect(elseRegion).toMatch(/if\s*\(\s*active\s*&&\s*visible\s*\)\s*onplaybackfailed\?\.\(/);
});

test('the /tv route renders an on-screen silent-room panel fed only by the slots, and clears it', () => {
	const src = stripComments(readFileSync(TV_ROUTE, 'utf8'));
	// A page-level latch holding the failure reason — a real $state so the {#if} tracks it.
	expect(src).toMatch(/let\s+playbackFailedReason\s*:\s*string\s*\|\s*null\s*=\s*\$state\(null\)/);
	// The panel renders ONLY when a failure is latched, so a healthy room never shows it.
	expect(src).toMatch(/\{#if\s+playbackFailedReason\s*\}/);
	// Both TvPlayer slots report the failure up — one per slot.
	const failed = src.match(/onplaybackfailed=/g) ?? [];
	expect(failed.length, 'both TvPlayer slots must wire onplaybackfailed').toBe(2);
	// The latch is CLEARED so the next song retracts the panel: on onready (a fresh song loaded), one
	// per slot. The else-branch failure is non-recoverable by definition (a tap cannot lift it — that is
	// what separates it from the NotAllowedError branch), so the honest clear point is a NEW song, not a
	// resume of the failed one. Two occurrences — one per TvPlayer slot's onready.
	const clears = src.match(/playbackFailedReason\s*=\s*null/g) ?? [];
	expect(clears.length, 'the panel must be cleared on onready in BOTH slots').toBe(2);
	// The panel must be an actual STYLED full-screen overlay, not an unstyled span a wall viewer cannot
	// read. Pins the .silent-room CSS: it must exist, cover the viewport (inset: 0), and be positioned
	// (z-index applies only to a positioned box). It sits at z 8 (transient-overlay tier) so a genuinely
	// gesture-liftable autoplay block (z 10) always wins if both somehow raise.
	const rule = src.match(/\.silent-room\s*\{([^}]*)\}/);
	expect(rule, 'the .silent-room style rule must exist').not.toBeNull();
	const body = rule ? rule[1] : '';
	expect(body).toMatch(/position:\s*absolute/);
	expect(body).toMatch(/inset:\s*0/);
	expect(body).toMatch(/z-index:\s*var\(--z-tv-interstitial\)/);
});
