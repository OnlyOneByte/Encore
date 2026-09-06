import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	GUIDE_DEADBAND_SEC,
	GUIDE_MAX_RATE_TRIM,
	GUIDE_PREROLL_ALIGN_SEC,
	GUIDE_RESEEK_SEC,
	SEEK_JUMP_SEC,
	guideCorrection,
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

describe('guideCorrection — ordinary drift never seeks', () => {
	it('holds inside the deadband', () => {
		expect(guideCorrection(10, 10).kind).toBe('hold');
		expect(guideCorrection(10 + GUIDE_DEADBAND_SEC / 2, 10).kind).toBe('hold');
		expect(guideCorrection(10 - GUIDE_DEADBAND_SEC / 2, 10).kind).toBe('hold');
	});

	it('trims rather than seeks across the whole band that used to seek', () => {
		// 40ms was the OLD seek threshold. Every one of these once flushed the decoder.
		// Kept just inside the reseek boundary: `10 + 0.3 - 10` is 0.30000000000000071 in binary
		// floating point, which is genuinely over the threshold, so testing the exact edge would be
		// asserting against float representation rather than against the policy.
		for (const drift of [0.02, 0.04, 0.08, 0.15, 0.25, GUIDE_RESEEK_SEC - 0.005]) {
			expect(guideCorrection(10 + drift, 10).kind).toBe('trim');
			expect(guideCorrection(10 - drift, 10).kind).toBe('trim');
		}
	});

	it('only seeks once the guide is genuinely lost', () => {
		expect(guideCorrection(10 + GUIDE_RESEEK_SEC + 0.01, 10).kind).toBe('reseek');
		expect(guideCorrection(12, 10).kind).toBe('reseek');
		// A seek returns to neutral tempo; leaving a trim on after a reseek would fight the next tick.
		expect(guideCorrection(12, 10).rate).toBe(1);
	});
});

describe('guideCorrection — the trim converges in the right direction', () => {
	it('slows a guide that is ahead', () => {
		expect(guideCorrection(10.1, 10).rate).toBeLessThan(1);
	});

	it('speeds up a guide that is behind', () => {
		expect(guideCorrection(9.9, 10).rate).toBeGreaterThan(1);
	});

	it('never exceeds the trim ceiling, so the stretcher stays transparent', () => {
		for (const drift of [0.05, 0.1, 0.2, GUIDE_RESEEK_SEC - 0.005]) {
			for (const signed of [drift, -drift]) {
				const { rate } = guideCorrection(10 + signed, 10);
				expect(Math.abs(rate - 1)).toBeLessThanOrEqual(GUIDE_MAX_RATE_TRIM + 1e-9);
			}
		}
	});

	it('is symmetric — the same drift either way asks for the same magnitude of trim', () => {
		const ahead = guideCorrection(10.1, 10).rate;
		const behind = guideCorrection(9.9, 10).rate;
		expect(Math.abs(ahead - 1)).toBeCloseTo(Math.abs(behind - 1), 12);
	});
});

describe('guideCorrection — degenerate playheads', () => {
	it('holds on a non-finite playhead rather than seeking on a guess', () => {
		expect(guideCorrection(NaN, 10).kind).toBe('hold');
		expect(guideCorrection(10, NaN).kind).toBe('hold');
		expect(guideCorrection(Infinity, 10).kind).toBe('hold');
	});
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

describe('seekPlan — whenever the master jumps, the guide goes with it', () => {
	it('repositions the guide on a restart, not just the master', () => {
		// The reported trigger: `{ cmd: 'restart' }` sets positionSec 0 while the song is at 60s.
		expect(seekPlan(60, 60, 0)).toEqual({ master: true, guide: true });
	});

	it('repositions the guide on every jump, not only on a restart', () => {
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
	it('leaves the guide within the preroll tolerance of the master after ANY jump it makes', () => {
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
	it('never moves the guide on a sub-threshold position the master ignores', () => {
		for (const target of [10, 10.5, 11, 11.4, 9, 8.7]) {
			const plan = seekPlan(10, 10, target);
			expect(plan.master).toBe(false);
			expect(plan.guide).toBe(false);
		}
	});

	it('does not flush the guide decoder when the guide is already at the target', () => {
		// The master jumps to where the guide already sits. Re-seeking it would be a decoder flush for
		// no correction — the exact cost `guideCorrection` refuses to pay on ordinary drift.
		expect(seekPlan(60, 0, 0)).toEqual({ master: true, guide: false });
		expect(seekPlan(60, GUIDE_PREROLL_ALIGN_SEC / 2, 0)).toEqual({ master: true, guide: false });
	});

	it('uses the jump threshold as its boundary, so telemetry never seeks', () => {
		expect(seekPlan(10, 10, 10 + SEEK_JUMP_SEC - 0.01).master).toBe(false);
		expect(seekPlan(10, 10, 10 + SEEK_JUMP_SEC + 0.01).master).toBe(true);
	});

	it('restarts a song playing under the jump threshold — the target-0 rewind is not telemetry (#95)', () => {
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

	it('does not read ordinary telemetry as a restart just because 0 is nearby (#95)', () => {
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

	it('holds on a non-finite playhead or target rather than seeking on a guess', () => {
		// Matches guideCorrection's policy above. A NaN target reaching `currentTime` throws.
		expect(seekPlan(NaN, 10, 0)).toEqual({ master: false, guide: false });
		expect(seekPlan(10, 10, NaN)).toEqual({ master: false, guide: false });
		expect(seekPlan(10, NaN, 0)).toEqual({ master: true, guide: true });
		expect(seekPlan(10, 10, Infinity)).toEqual({ master: false, guide: false });
	});
});

/*
 * A source guard, because the defect lived in WIRING, not in a decision.
 *
 * `seekPlan` being correct proves nothing about the component: the original bug was a seek effect that
 * moved `master.currentTime` and never mentioned the guide at all, and a pure function sitting unused
 * beside it would be this repo's most-repeated defect (built, unit-tested, never wired). These
 * assertions fail if the seek effect stops consulting the plan or stops acting on its `guide` half.
 */
describe('TvPlayer applies the seek plan to BOTH elements', () => {
	const src = readFileSync(join(import.meta.dir, 'TvPlayer.svelte'), 'utf8');
	// The seek effect's body ONLY — anchored on its own guard line and cut at the first effect close —
	// so a match in the play path, the governor, or a nearby comment block cannot satisfy these.
	const seekEffect =
		src
			.split('if (!master || !media || !isPlayable(media) || seekSec === undefined) return;')[1]
			?.split('\n\t});')[0] ?? '';

	it('the seek decision comes from seekPlan, not from an inline threshold', () => {
		expect(src).toContain('seekPlan(');
		// The old shape, with its magic 1.5 and no guide: this is the regression being banned.
		expect(src).not.toContain('Math.abs(master.currentTime - seekSec) > 1.5');
	});

	it('the seek effect repositions the guide', () => {
		expect(seekEffect).not.toBe('');
		expect(seekEffect).toContain('guideEl.currentTime = seekSec');
	});

	it('the seek effect returns the guide to neutral tempo, so a stale trim cannot survive the jump', () => {
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
	it('reads the guide element untracked, so the fix adds no new re-run trigger', () => {
		expect(seekEffect).toContain('untrack(() => vocals)');
	});

	it('the master and the guide are moved from the SAME plan, not from two conditions', () => {
		// Two copies of one condition is how the guide's transport drifted from the master's before.
		expect(seekEffect).toContain('master.currentTime = seekSec');
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
	it('aligns the guide to the fixed seek target, never to the master’s moving playhead', () => {
		expect(seekEffect).not.toContain('guideEl.currentTime = master.currentTime');
		expect(seekEffect).not.toContain('vocals.currentTime = master.currentTime');
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
	it('re-runs the seek effect on every playback:state via a tracked seekRev, so an equal-position restart still fires (#95)', () => {
		expect(seekEffect).not.toBe('');
		// Strip comments before asserting: a `seekRev` mentioned only in a comment does NOT register a
		// reactive dependency, so a guard that matched comment text would be mutation-blind (it would
		// stay green with the executable read deleted). Assert on CODE.
		const effectCode = seekEffect
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/\/\/.*$/gm, '');
		// The effect must READ seekRev in executable position (a bare read registers the dep in runes mode).
		expect(effectCode).toContain('seekRev');
		// And the prop must exist and be plumbed from playback:state's rev on the page.
		expect(src).toContain('seekRev?: number');
		const page = readFileSync(join(import.meta.dir, '..', '..', 'routes', 'tv', '+page.svelte'), 'utf8');
		expect(page).toContain('seekRev = e.rev');
		expect(page).toContain('seekRev={seekRev}');
	});
});
