import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	GUIDE_DEADBAND_SEC,
	GUIDE_MAX_RATE_TRIM,
	GUIDE_PREROLL_ALIGN_SEC,
	GUIDE_RATE_GAIN,
	GUIDE_RESEEK_SEC,
	SEEK_JUMP_SEC,
	guideCorrection,
	prerollSeekTarget,
	seekPlan
} from './guide-sync';

/*
 * These tests exist for one reported defect: the guiding track crackled. The cause was that drift was
 * corrected by seeking (`vocals.currentTime = ...`) on the master's ~4Hz timeupdate with a 40ms
 * tolerance — so an unlockable pair of media elements produced a decoder flush every few hundred ms.
 *
 * The invariant worth defending is therefore not "drift is small" but "ordinary drift does not
 * produce a seek". That is what the first block pins.
 */

it('guideCorrection holds inside the deadband — ordinary drift never seeks', () => {
	expect(guideCorrection(10, 10).kind).toBe('hold');
	expect(guideCorrection(10 + GUIDE_DEADBAND_SEC / 2, 10).kind).toBe('hold');
	expect(guideCorrection(10 - GUIDE_DEADBAND_SEC / 2, 10).kind).toBe('hold');
});

it('guideCorrection trims rather than seeks across the whole band that used to seek — ordinary drift never seeks', () => {
	// 40ms was the OLD seek threshold. Every one of these once flushed the decoder.
	// Kept just inside the reseek boundary: `10 + 0.3 - 10` is 0.30000000000000071 in binary
	// floating point, which is genuinely over the threshold, so testing the exact edge would be
	// asserting against float representation rather than against the policy.
	for (const drift of [0.02, 0.04, 0.08, 0.15, 0.25, GUIDE_RESEEK_SEC - 0.005]) {
		expect(guideCorrection(10 + drift, 10).kind).toBe('trim');
		expect(guideCorrection(10 - drift, 10).kind).toBe('trim');
	}
});

it('guideCorrection only seeks once the guide is genuinely lost — ordinary drift never seeks', () => {
	expect(guideCorrection(10 + GUIDE_RESEEK_SEC + 0.01, 10).kind).toBe('reseek');
	expect(guideCorrection(12, 10).kind).toBe('reseek');
	// A seek returns to neutral tempo; leaving a trim on after a reseek would fight the next tick.
	expect(guideCorrection(12, 10).rate).toBe(1);
});

it('guideCorrection slows a guide that is ahead — the trim converges in the right direction', () => {
	expect(guideCorrection(10.1, 10).rate).toBeLessThan(1);
});

it('guideCorrection speeds up a guide that is behind — the trim converges in the right direction', () => {
	expect(guideCorrection(9.9, 10).rate).toBeGreaterThan(1);
});

it('guideCorrection never exceeds the trim ceiling, so the stretcher stays transparent — the trim converges in the right direction', () => {
	for (const drift of [0.05, 0.1, 0.2, GUIDE_RESEEK_SEC - 0.005]) {
		for (const signed of [drift, -drift]) {
			const { rate } = guideCorrection(10 + signed, 10);
			expect(Math.abs(rate - 1)).toBeLessThanOrEqual(GUIDE_MAX_RATE_TRIM + 1e-9);
		}
	}
});

it('guideCorrection is symmetric — the same drift either way asks for the same magnitude of trim, and the trim converges in the right direction', () => {
	const ahead = guideCorrection(10.1, 10).rate;
	const behind = guideCorrection(9.9, 10).rate;
	expect(Math.abs(ahead - 1)).toBeCloseTo(Math.abs(behind - 1), 12);
});

it('guideCorrection holds on a non-finite playhead rather than seeking on a guess — degenerate playheads', () => {
	expect(guideCorrection(NaN, 10).kind).toBe('hold');
	expect(guideCorrection(10, NaN).kind).toBe('hold');
	expect(guideCorrection(Infinity, 10).kind).toBe('hold');
});

/*
 * ── the SEEK path: a discontinuity is not drift ──────────────────────────────────────────────────
 *
 * The reported defect: restarting a song left the guide out of sync with the instrumental. The seek
 * path repositioned only the master, so the guide kept playing from wherever it already was, and
 * recovery fell to the governor above — which is built for continuous drift and deliberately prefers
 * a tempo trim over a seam. A trim closes 60s of discontinuity at 2%, so the guide crawls; and any
 * residual that lands back inside the trim band never hard-resyncs at all.
 *
 * The invariant these tests defend is the issue's own done-when, stated as a property rather than as
 * one worked example: WHENEVER THE MASTER MOVES, THE GUIDE ENDS WITHIN THE PREROLL TOLERANCE OF IT —
 * immediately, not eventually. A single "restart from 60s" case would pass for a fix that special-
 * cased restart and left every other jump wrong, which is this repo's documented recurring shape
 * (transitions handled where steady state was).
 */

it('seekPlan repositions the guide on a restart, not just the master — whenever the master jumps, the guide goes with it', () => {
	// The reported trigger: `{ cmd: 'restart' }` sets positionSec 0 while the song is at 60s.
	expect(seekPlan(60, 60, 0)).toEqual({ master: true, guide: true });
});

it('seekPlan repositions the guide on every jump, not only on a restart — whenever the master jumps, the guide goes with it', () => {
	// A fix that keys on "target === 0" would pass the test above and fail this one.
	for (const [from, to] of [
		[60, 0], // restart
		[10, 90], // scrub forward
		[90, 10], // scrub back
		[0, 30], // jump out of the intro
		[120, 118] // small but still a real jump (> SEEK_JUMP_SEC)
	] as const) {
		expect(seekPlan(from, from, to)).toEqual({ master: true, guide: true });
	}
});

/*
 * THE PROPERTY. Exhaustive over a grid rather than over hand-picked cases, because the failure this
 * closes was not a wrong number — it was a whole branch of the state space where the guide was
 * simply never considered.
 */
it('seekPlan leaves the guide within the preroll tolerance of the master after ANY jump it makes — whenever the master jumps, the guide goes with it', () => {
	const playheads = [0, 0.02, 0.5, 1.5, 3, 10, 59.98, 60, 60.03, 90, 240];
	let jumps = 0;
	for (const masterSec of playheads) {
		for (const guideSec of playheads) {
			for (const targetSec of playheads) {
				const plan = seekPlan(masterSec, guideSec, targetSec);
				if (!plan.master) continue; // the master stayed put; nothing was discontinuous
				jumps++;
				const masterAfter = targetSec;
				const guideAfter = plan.guide ? targetSec : guideSec;
				expect(Math.abs(guideAfter - masterAfter)).toBeLessThanOrEqual(GUIDE_PREROLL_ALIGN_SEC);
			}
		}
	}
	// Guard the guard: an empty grid would make the assertion above vacuous.
	expect(jumps).toBeGreaterThan(100);
});

/*
 * The opposite failure mode, and the reason `guide` is gated on `master` rather than computed
 * independently. The ~4Hz position telemetry and every pause/resume carry a position, so `seekSec`
 * changes constantly by small amounts that the master deliberately ignores. A guide that chased
 * those would seek AWAY from a master that never moved — manufacturing the very desync this fixes,
 * and flushing the decoder on every telemetry frame (the crackle the governor exists to avoid).
 */
it('seekPlan never moves the guide on a sub-threshold position the master ignores — whenever the master jumps, the guide goes with it', () => {
	for (const target of [10, 10.5, 11, 11.4, 9, 8.7]) {
		const plan = seekPlan(10, 10, target);
		expect(plan.master).toBe(false);
		expect(plan.guide).toBe(false);
	}
});

it('seekPlan does not flush the guide decoder when the guide is already at the target — whenever the master jumps, the guide goes with it', () => {
	// The master jumps to where the guide already sits. Re-seeking it would be a decoder flush for
	// no correction — the exact cost `guideCorrection` refuses to pay on ordinary drift.
	expect(seekPlan(60, 0, 0)).toEqual({ master: true, guide: false });
	expect(seekPlan(60, GUIDE_PREROLL_ALIGN_SEC / 2, 0)).toEqual({ master: true, guide: false });
});

it('seekPlan uses the jump threshold as its boundary, so telemetry never seeks — whenever the master jumps, the guide goes with it', () => {
	expect(seekPlan(10, 10, 10 + SEEK_JUMP_SEC - 0.01).master).toBe(false);
	expect(seekPlan(10, 10, 10 + SEEK_JUMP_SEC + 0.01).master).toBe(true);
});

it('seekPlan restarts a song playing under the jump threshold — the target-0 rewind is not telemetry (#95) — whenever the master jumps, the guide goes with it', () => {
	// A `restart` sets the reported position to 0 while the song plays on. From a currentTime UNDER
	// SEEK_JUMP_SEC the move |masterSec - 0| is below the telemetry threshold, so the plain distance
	// test never rewinds and the restart does nothing — the master playhead does not move. Positions
	// keyed to the constant so lowering SEEK_JUMP_SEC cannot silently route these through the
	// DISTANCE clause and leave the restart clause untested.
	for (const masterSec of [
		GUIDE_PREROLL_ALIGN_SEC + 0.01, // just past the pre-roll tolerance, the smallest real rewind
		SEEK_JUMP_SEC / 3,
		SEEK_JUMP_SEC / 2,
		SEEK_JUMP_SEC - 0.01 // the top of the window #95 names
	]) {
		expect(seekPlan(masterSec, masterSec, 0)).toEqual({ master: true, guide: true });
	}
	// The guide half still respects the pre-roll tolerance: a guide already at 0 is not flushed.
	expect(seekPlan(SEEK_JUMP_SEC / 2, 0, 0)).toEqual({ master: true, guide: false });
});

it('seekPlan does not read ordinary telemetry as a restart just because 0 is nearby (#95) — whenever the master jumps, the guide goes with it', () => {
	// Telemetry can only report a target of 0 when the song is genuinely at ~0, in which case the
	// master is already there and the target-0 clause must NOT fire (moving is a no-op, but the
	// clause keys on masterSec > GUIDE_PREROLL_ALIGN_SEC precisely so it stays a plain no-move).
	expect(seekPlan(0, 0, 0).master).toBe(false);
	expect(seekPlan(GUIDE_PREROLL_ALIGN_SEC / 2, GUIDE_PREROLL_ALIGN_SEC / 2, 0).master).toBe(false);
	expect(seekPlan(GUIDE_PREROLL_ALIGN_SEC, GUIDE_PREROLL_ALIGN_SEC, 0).master).toBe(false); // the > boundary
	// A NON-ZERO sub-threshold target with the master past the pre-roll tolerance is the case that
	// distinguishes the fix (target === 0) from the banned relaxation (target < SEEK_JUMP_SEC): the
	// latter would fire here, the fix must not. This is the coverage the earlier ≥-threshold targets
	// could not exercise.
	expect(seekPlan(0.9, 0.9, 0.5).master).toBe(false);
	expect(seekPlan(1.0, 1.0, 0.4).master).toBe(false);
	// And a non-zero sub-threshold telemetry frame around a mid-song playhead is still ignored.
	for (const target of [10, 10.5, 11, 9, 8.7]) {
		expect(seekPlan(10, 10, target).master).toBe(false);
	}
});

it('seekPlan holds on a non-finite playhead or target rather than seeking on a guess — whenever the master jumps, the guide goes with it', () => {
	// Matches guideCorrection's policy above. A NaN target reaching `currentTime` throws.
	expect(seekPlan(NaN, 10, 0)).toEqual({ master: false, guide: false });
	expect(seekPlan(10, 10, NaN)).toEqual({ master: false, guide: false });
	expect(seekPlan(10, NaN, 0)).toEqual({ master: true, guide: true });
	expect(seekPlan(10, 10, Infinity)).toEqual({ master: false, guide: false });
});

/*
 * A source guard, because the defect lived in WIRING, not in a decision.
 *
 * `seekPlan` being correct proves nothing about the component: the original bug was a seek effect that
 * moved `master.currentTime` and never mentioned the guide at all, and a pure function sitting unused
 * beside it would be this repo's most-repeated defect (built, unit-tested, never wired). These
 * assertions fail if the seek effect stops consulting the plan or stops acting on its `guide` half.
 */
const src = readFileSync(join(import.meta.dir, 'TvPlayer.svelte'), 'utf8');
/*
 * RE-ANCHORED — and this is not cosmetic, so do not move it back.
 *
 * This slice used to be `.split('if (!master || !media || !isPlayable(media) || seekSec ===
 * undefined) return;')[1]`, i.e. THE DELIMITER WAS THE DEFECTIVE LINE. Two consequences, both bad:
 *
 *   1. Blind to the defect. The tracked `media` / `isPlayable(media)` reads that caused the seek-back defect landed
 *      in the DISCARDED prefix (`[0]`), so every assertion in this block ran on the text after them
 *      and was structurally incapable of observing them — while the block's own comment claimed the
 *      effect's deps were "seekSec and seekRev". That is why four rounds of review passed it.
 *   2. Load-bearing AGAINST the fix. Removing that line makes the delimiter vanish and the slice
 *      collapse to '', reddening several assertions here — including `not.toBe('')`, whose comment
 *      said it "fails if that tracked read is removed". It does. For the wrong reason. So the cheap
 *      way out of fixing the seek-back defect was to weaken this block.
 *
 * Both anchors below are things the fix does NOT move: the extracted `applySeek` declaration, and
 * the call site the triggering effect makes. A future correctness fix to either the guard condition
 * or the dependency set therefore cannot silence these.
 */
const seekEffect = src.split('function applySeek(seekTarget: number): void {')[1]?.split('\n\t}')[0] ?? '';
/** The TRIGGERING effect — the part whose tracked reads are the dependency set the seek-back defect is about. */
const seekTrigger = (() => {
	const upto = src.split('applySeek(target);')[0];
	const i = upto.lastIndexOf('$effect(() => {');
	return i < 0 ? '' : upto.slice(i);
})();

it('TvPlayer applies the seek plan to BOTH elements: the seek decision comes from seekPlan, not from an inline threshold', () => {
	expect(src).toContain('seekPlan(');
	// The old shape, with its magic 1.5 and no guide: this is the regression being banned.
	expect(src).not.toContain('Math.abs(master.currentTime - seekSec) > 1.5');
});

it('TvPlayer applies the seek plan to BOTH elements: the seek effect repositions the guide', () => {
	expect(seekEffect).not.toBe('');
	expect(seekEffect).toContain('guideEl.currentTime = seekTarget');
});

it('TvPlayer applies the seek plan to BOTH elements: the seek effect returns the guide to neutral tempo, so a stale trim cannot survive the jump', () => {
	// The governor re-derives a trim from real drift on its next tick. Carrying the pre-jump trim
	// across a discontinuity means correcting a drift that no longer exists.
	expect(seekEffect).toContain('guideEl.playbackRate = 1');
});

/*
 * The guide's playhead is an INPUT to the decision, never a reason to re-take it. Reading the
 * element's `$state` as a tracked dependency would make the guide MOUNTING re-run this effect, and a
 * mount coinciding with a stale reported position would then yank the MASTER to that stale position
 * — a regression introduced BY the fix rather than closed by it. `untrack` keeps the guide's
 * mounting out of the effect's dependency set; the effect's real deps are the two
 * `playback:state`-derived values (`seekSec` and `seekRev`), pinned by the next test.
 */
it('TvPlayer applies the seek plan to BOTH elements: reads the guide element untracked, so the fix adds no new re-run trigger', () => {
	expect(seekEffect).toContain('untrack(() => vocals)');
});

it('TvPlayer applies the seek plan to BOTH elements: the master and the guide are moved from the SAME plan, not from two conditions', () => {
	// Two copies of one condition is how the guide's transport drifted from the master's before.
	expect(seekEffect).toContain('el.currentTime = seekTarget');
	expect(src.split('seekPlan(').length - 1).toBe(1);
});

/*
 * THE MECHANISM, and the reason this is not merely a tidier spelling of what the governor already
 * did as a fallback.
 *
 * Left alone, a jump WAS eventually recovered — by `syncGuide`'s reseek branch, which fires on the
 * master's post-seek `timeupdate` and assigns `vocals.currentTime = master.currentTime`. That aligns
 * the guide to a MOVING target: the master keeps advancing while the guide's seek flushes its
 * decoder, so the operation lands short by roughly the guide's seek latency. A residual of that size
 * falls in the governor's TRIM band (0.015–0.3s), where policy is a ≤2% tempo trim — so it is then
 * closed over seconds rather than at once. That is the reported "crawls back".
 *
 * Both elements are now assigned the SAME FIXED target, so there is no residual to trim. This
 * assertion bans the moving-target form from the seek path; the governor keeps it, correctly,
 * because for continuous drift the master's live playhead IS the right reference.
 */
it('TvPlayer applies the seek plan to BOTH elements: aligns the guide to the fixed seek target, never to the master’s moving playhead', () => {
	expect(seekEffect).not.toContain('guideEl.currentTime = master.currentTime');
	expect(seekEffect).not.toContain('vocals.currentTime = master.currentTime');
	// The same ban in the post-fix spelling, where the master element is a local `el`.
	expect(seekEffect).not.toContain('guideEl.currentTime = el.currentTime');
});

/*
 * THE #95 COMPLETION. `seekPlan` admitting a restart-to-0 as a jump is necessary but not enough: on
 * #95's own repro the song starts at position 0, so `seekSec` is already 0, and a restart under the
 * jump threshold publishes positionSec 0 AGAIN. Writing 0 over 0 into a `$state` (strict `===`)
 * notifies nothing, so an effect whose only dep is `seekSec` never re-runs and the master never
 * moves — the reported symptom, upstream of the threshold. The server `rev` moves on EVERY
 * `playback:state` (bumped by `setPlayback`) but never on position telemetry (`setPosition` leaves
 * rev alone and does not broadcast), so tracking it re-takes the seek decision on an equal-position
 * restart WITHOUT reopening telemetry-chasing. This guard fails if that tracked read is removed.
 */
it('TvPlayer applies the seek plan to BOTH elements: re-runs the seek effect on every playback:state via a tracked seekRev, so an equal-position restart still fires (#95)', () => {
	expect(seekTrigger).not.toBe('');
	// Strip comments before asserting: a `seekRev` mentioned only in a comment does NOT register a
	// reactive dependency, so a guard that matched comment text would be mutation-blind (it would
	// stay green with the executable read deleted). Assert on CODE.
	const effectCode = seekTrigger.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	// The effect must READ seekRev in executable position (a bare read registers the dep in runes mode).
	expect(effectCode).toContain('seekRev');
	// And the prop must exist and be plumbed from playback:state's rev on the page.
	expect(src).toContain('seekRev?: number');
	const page = readFileSync(join(import.meta.dir, '..', '..', 'routes', 'tv', '+page.svelte'), 'utf8');
	expect(page).toContain('seekRev = e.rev');
	expect(page).toContain('seekRev={seekRev}');
});

/*
 * -- the PRE-ROLL path: the start is not drift ---------------------------------------------
 *
 * The reported defect: the guide starts BEHIND the instrumental and stays behind. The pre-roll used
 * to align the guide to master.currentTime at EFFECT time and then call play(); the guide decoder
 * spin-up let the master advance before the first guide frame emerged, so the guide entered late by
 * that latency. A residual that size lands in the governor TRIM band, closed at ~15s per e-fold --
 * starts late and stays late.
 *
 * prerollSeekTarget owns the decision, taken when the guide can actually play. The invariant: given
 * the two playheads AT THAT MOMENT, the guide locks onto the master within the pre-roll tolerance in
 * ONE seek -- immediately, not over the trim band.
 */

it('prerollSeekTarget seeks to the master playhead when the guide is outside the pre-roll tolerance -- the guide locks onto the master at once, not over the trim band', () => {
	// The reported sizes: a guide 150-250ms behind must be pulled to the master NOW, not trimmed.
	for (const behind of [0.15, 0.2, 0.25, 0.5, 2]) {
		const plan = prerollSeekTarget(10 - behind, 10);
		expect(plan.seek).toBe(true);
		expect(plan.target).toBe(10);
		// After the seek the guide is AT the master -- residual zero, nothing left for the governor.
		expect(Math.abs(plan.target - 10)).toBeLessThanOrEqual(GUIDE_PREROLL_ALIGN_SEC);
	}
});

it('prerollSeekTarget does not flush a guide already inside the tolerance -- the guide locks onto the master at once, not over the trim band', () => {
	// The same cost guideCorrection refuses on ordinary drift: no seek for a residual that small.
	for (const off of [0, GUIDE_PREROLL_ALIGN_SEC / 2, -GUIDE_PREROLL_ALIGN_SEC / 2]) {
		expect(prerollSeekTarget(10 + off, 10).seek).toBe(false);
	}
});

it('prerollSeekTarget holds on a non-finite playhead rather than seeking on a guess -- the guide locks onto the master at once, not over the trim band', () => {
	expect(prerollSeekTarget(NaN, 10).seek).toBe(false);
	expect(prerollSeekTarget(10, NaN).seek).toBe(false);
	expect(prerollSeekTarget(Infinity, 10).seek).toBe(false);
});

/*
 * THE SETTLE-TIME RELATIONSHIP (the late-guide report, part 2). Written against the CONSTANTS, not a hard-coded 38.75s, so
 * a deliberate retune of the band updates one expectation here instead of hitting a wall. The point
 * of the late-guide report is that leaving a residual to the trim band is slow: this pins HOW slow, as a fact about
 * the policy, so the value of taking the pre-roll seek at once (prerollSeekTarget) is measurable.
 *
 * The trim is rate = 1 + (-drift * GUIDE_RATE_GAIN) inside the band, i.e. d(drift)/dt = -drift/tau
 * with tau = 1 / GUIDE_RATE_GAIN. So a residual decays exponentially with that time-constant, and
 * the time to fall from an initial drift d0 to the deadband is tau * ln(d0 / GUIDE_DEADBAND_SEC).
 */
it('guideCorrection has time-constant tau = 1 / GUIDE_RATE_GAIN -- the trim band closes only asymptotically, which is why the pre-roll seeks', () => {
	const tau = 1 / GUIDE_RATE_GAIN;
	// The trim ramp is linear in drift with slope -GUIDE_RATE_GAIN inside the band: a drift of
	// exactly tau worth of correction asks for rate offset of -drift * GUIDE_RATE_GAIN.
	const drift = 0.1;
	const { rate } = guideCorrection(10 + drift, 10);
	expect(1 - rate).toBeCloseTo(drift / tau, 12);
});

it('guideCorrection takes many seconds per e-fold, so a start residual is slow to close if left to it -- the trim band closes only asymptotically, which is why the pre-roll seeks', () => {
	const tau = 1 / GUIDE_RATE_GAIN;
	// Derived from the constants, never hard-coded: one e-fold is tau seconds.
	expect(tau).toBeCloseTo(GUIDE_RESEEK_SEC / GUIDE_MAX_RATE_TRIM, 12);
	// Time for a 200ms start residual to reach the deadband, as a relationship not a magic number.
	const settle = tau * Math.log(0.2 / GUIDE_DEADBAND_SEC);
	expect(settle).toBeCloseTo(tau * Math.log(0.2 / GUIDE_DEADBAND_SEC), 12);
	// It is many seconds -- the concrete reason the pre-roll must lock on at once instead.
	expect(settle).toBeGreaterThan(30);
});

/*
 * A source guard, because the late-guide defect too lived in WIRING: prerollSeekTarget being correct proves nothing
 * about the component. The original defect was the pre-roll assigning vocals.currentTime =
 * master.currentTime at effect time in the transport effect and the gesture-recovery handler, where
 * the guide decoder flush then outran the master. These assertions fail if the pre-roll stops
 * consulting the helper, reverts to the moving-target form, or stops re-taking the lock on canplay.
 */
const tv = readFileSync(join(import.meta.dir, 'TvPlayer.svelte'), 'utf8');

it('TvPlayer takes the pre-roll lock-on when the guide can play, not at effect time: the pre-roll decision comes from prerollSeekTarget, not an inline tolerance compare', () => {
	expect(tv).toContain('prerollSeekTarget(');
});

it('TvPlayer takes the pre-roll lock-on when the guide can play, not at effect time: aligns the pre-roll to the fixed helper target, never to the master moving playhead', () => {
	// Scope the ban to alignGuidePreroll -- the governor syncGuide LEGITIMATELY reseeks to
	// master.currentTime for continuous drift (the issue keeps that), so a whole-file ban would
	// wrongly red on the governor. The pre-roll helper must seek to the fixed prerollSeekTarget
	// result, not to master.currentTime read inline while the decoder flush lets the master run.
	const align = tv.split('function alignGuidePreroll(): void {')[1]?.split('\n\t}')[0] ?? '';
	expect(align).not.toBe('');
	expect(align).toContain('prerollSeekTarget(');
	expect(align).toContain('plan.target');
	expect(align).not.toContain('vocals.currentTime = master.currentTime');
	// And the two pre-roll call sites route through the helper, not an inline moving-target seek.
	expect(tv).not.toContain('vocals.currentTime = master?.currentTime ?? 0;');
	expect(tv.split('alignGuidePreroll()').length - 1).toBeGreaterThanOrEqual(3);
});

it('TvPlayer takes the pre-roll lock-on when the guide can play, not at effect time: re-takes the lock-on INSIDE the guide canplay handler body, when the buffer is primed', () => {
	// The heart of the fix: the comparison is taken when the guide can actually play, so the
	// seek->audible gap is a primed-buffer flush and the master has not run away from it.
	// A1: a whole-file `toContain('alignGuidePreroll()')` is satisfied by the OTHER two call
	// sites (the transport effect and the gesture handler), so gutting the canplay handler body
	// would leave the old guard green. Slice the `oncanplay={...}` block and assert the call lives
	// INSIDE it, so the on-buffer-primed lock-on cannot be silently removed.
	expect(tv).toContain('oncanplay={');
	// the master <audio> now also has an `oncanplay=` (the cold-mount resume), which precedes
	// the guide's in source order — so anchor on the GUIDE element first, then slice ITS handler,
	// rather than taking the first `oncanplay={` in the file.
	const guideMarkup = tv.split('bind:this={vocals}')[1] ?? '';
	expect(guideMarkup).not.toBe('');
	const canplay = guideMarkup.split('oncanplay={')[1]?.split('}}')[0] ?? '';
	expect(canplay).not.toBe('');
	expect(canplay).toContain('alignGuidePreroll()');
});

/*
 * A source guard, because the mount/readiness split lives in WIRING: the mount condition and the readiness/level gate are
 * two things that must be DIFFERENT expressions. The defect was one `wantsGuide` derived (level-gated)
 * driving BOTH the {#if} mount AND the ready-report, so a guide-level slider drag through 0 (step="1"
 * from min="0") flipped the mount false-then-true and UNMOUNTED/REMOUNTED the guide <audio> mid-song,
 * re-paying the canplay pre-roll lock-on. The fix splits mount-worthiness (level-independent) from the
 * level gate, and — trap #1 of the late-guide report — keeps the ready-report on the level-gated condition so a level-0
 * room never waits on the guide buffer. These assertions red on base (single level-gated wantsGuide
 * driving the mount) and pin the split.
 */
const tvForMountGate = readFileSync(join(import.meta.dir, 'TvPlayer.svelte'), 'utf8');

it('TvPlayer mounts the guide on mount-worthiness, gates readiness on the level: mount-worthiness is a distinct, level-INDEPENDENT derived', () => {
	// A named mount-worthiness derived exists and does NOT read the level. Reds on base, where the
	// only guide condition is a single level-gated `wantsGuide`.
	expect(tvForMountGate).toContain('guideMountable');
	const decl = tvForMountGate.split('const guideMountable = $derived(')[1]?.split(');')[0] ?? '';
	expect(decl).not.toBe('');
	// Mount-worthiness is "a playable song has a guide ref" — it must NOT consult the level, or a
	// drag through 0 would still unmount.
	expect(decl).toContain('guideRef');
	expect(decl).toContain('isPlayable(media)');
	expect(decl).not.toContain('effectiveGuide');
	expect(decl).not.toContain('guideLevel');
});

it('TvPlayer mounts the guide on mount-worthiness, gates readiness on the level: the guide <audio> mounts on mount-worthiness, not on the level gate', () => {
	// The markup {#if} that wraps the guide element must gate on guideMountable — so passing the
	// level through 0 never tears the element down. Reds on base: there the {#if} is `wantsGuide`.
	expect(tvForMountGate).toContain('{#if guideMountable && guideRef}');
	expect(tvForMountGate).not.toContain('{#if wantsGuide && guideRef}');
});

it('TvPlayer mounts the guide on mount-worthiness, gates readiness on the level: the level gate stays on effectiveGuide > 0 and still guards the ready-report (trap #1)', () => {
	// wantsGuide keeps its level meaning...
	const wg = tvForMountGate.split('const wantsGuide = $derived(')[1]?.split(');')[0] ?? '';
	expect(wg).not.toBe('');
	expect(wg).toContain('effectiveGuide > 0');
	// ...and the two ready-report effects + the guide-settle timeout still gate on the LEVEL
	// (wantsGuide), never on the relaxed mount condition — a level-0 room must not wait on the
	// guide buffer to announce ready. Guarding these on guideMountable is exactly trap #1.
	expect(tvForMountGate).toContain('(guideSettled || !wantsGuide) && !prewarmedFired');
	expect(tvForMountGate).toContain('(guideSettled || !wantsGuide) && !visibleReadyFired');
	expect(tvForMountGate).toContain('if (!wantsGuide || guideSettled) return;');
});

/*
 * The measured guide offset. The alignment ZERO POINT is `master + guideOffsetSec`, applied at
 * the three sites in TvPlayer so guide-sync.ts stays a pure policy function. Two things are pinned:
 *
 *   1. The policy functions still behave correctly WHEN the zero point is shifted — a stem held at a
 *      non-zero offset holds, drifts and locks on relative to THAT point, not to raw master. This is
 *      just the existing pure-function behaviour re-read at a shifted origin, but it is the invariant
 *      the feature rests on, so it is asserted directly.
 *   2. A SOURCE GUARD, because — exactly like the seek-back and late-guide defects — the offset lives in WIRING. guideOffsetSec
 *      being correct proves nothing about the component: a call site that ignored it would leave a
 *      shifted stem misaligned while every unit test on the pure functions stayed green. These
 *      assertions fail if any of the three sites stops folding the offset into its master zero point.
 */
it('guideCorrection holds a stem at its measured offset, not at zero: a guide sitting exactly at the offset is HELD — the offset is the zero point, not drift', () => {
	// Vocals at 10.030, master at 10.000, measured offset +30ms → zero point 10.030. Drift is 0, so
	// hold. Without the offset the same reading is 30ms of drift, which is a trim — the misalignment
	// the feature removes. This is guideCorrection re-read at the shifted origin the client passes.
	const offsetSec = 0.03;
	expect(guideCorrection(10.03, 10.0 + offsetSec).kind).toBe('hold');
	// And the SAME reading with no offset is NOT a hold — proving the offset is what makes it one.
	expect(guideCorrection(10.03, 10.0).kind).not.toBe('hold');
});

it('guideCorrection holds a stem at its measured offset, not at zero: drift is measured from master+offset, so a stem at raw master is now OFF by the offset', () => {
	// A +300ms offset with the guide sitting at raw master (10.0) is 300ms of drift from the zero
	// point 10.3 — a reseek, the largest correction. That is correct: a stem that SHOULD sit 300ms
	// ahead but sits at master is genuinely lost.
	expect(guideCorrection(10.0, 10.0 + 0.3).kind).toBe('reseek');
});

const tvForOffsetSites = readFileSync(join(import.meta.dir, 'TvPlayer.svelte'), 'utf8');

it('TvPlayer folds the measured offset into the guide zero point at all three sites: derives guideOffsetSecValue from the media snapshot via the shared helper', () => {
	// The offset must come from the shared pure helper (absent → 0), not an inline read that could
	// forget the default and feed NaN into an alignment. guideOffsetSec is imported and the derived
	// value reads it.
	expect(tvForOffsetSites).toContain('guideOffsetSec');
	const derived = tvForOffsetSites.split('const guideOffsetSecValue = $derived(')[1]?.split(');')[0] ?? '';
	expect(derived).not.toBe('');
	expect(derived).toContain('guideOffsetSec(media)');
});

it('TvPlayer folds the measured offset into the guide zero point at all three sites: the pre-roll lock-on aligns to master + offset, not raw master', () => {
	const align = tvForOffsetSites.split('function alignGuidePreroll(): void {')[1]?.split('\n\t}')[0] ?? '';
	expect(align).not.toBe('');
	// The helper's masterSec argument is master.currentTime + the offset. Reds if a future edit drops
	// the `+ guideOffsetSecValue`, which would lock a shifted stem onto raw master and start it off.
	expect(align).toContain('master.currentTime + guideOffsetSecValue');
});

it('TvPlayer folds the measured offset into the guide zero point at all three sites: the drift governor measures drift and reseeks against master + offset', () => {
	const sync = tvForOffsetSites.split('function syncGuide(): void {')[1]?.split('\n\t}')[0] ?? '';
	expect(sync).not.toBe('');
	// The zero point is computed once and both the correction and the reseek use it — so a stem held
	// at an offset is not perpetually corrected toward raw master.
	expect(sync).toContain('master.currentTime + guideOffsetSecValue');
	expect(sync).toContain('guideCorrection(vocals.currentTime, zero)');
	expect(sync).toContain("if (correction.kind === 'reseek') vocals.currentTime = zero;");
	// The pre-offset form — drift measured against raw master — must be gone, or a shifted stem is
	// chased back to the wrong point every governor tick.
	expect(sync).not.toContain('guideCorrection(vocals.currentTime, master.currentTime)');
});

it('TvPlayer folds the measured offset into the guide zero point at all three sites: the jump path seeks the guide to target + offset while leaving the master on target', () => {
	const seekEffect =
		tvForOffsetSites.split('function applySeek(seekTarget: number): void {')[1]?.split('\n\t}')[0] ?? '';
	expect(seekEffect).not.toBe('');
	// The master half is unchanged (on seekTarget); only the guide gets the offset. A stem shifted in
	// its samples must land at target+offset, or a scrub re-introduces the misalignment.
	expect(seekEffect).toContain('el.currentTime = seekTarget');
	expect(seekEffect).toContain('guideEl.currentTime = seekTarget + offset');
	// The guide's own tolerance comparison is taken against its shifted zero point (guide - offset vs
	// target ≡ guide vs target+offset), so seekPlan stays a pure single-target function.
	expect(seekEffect).toContain('guideEl.currentTime - offset');
});
