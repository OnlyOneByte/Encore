import { expect, it } from 'bun:test';
import { read } from '@encore/test-support';
import { PLAYHEAD_ALIGN_SEC, SEEK_JUMP_SEC, resumeSeekTarget, seekPlan } from '$lib/tv/playhead-sync';

/*
 * WHAT THIS FILE REPLACED, because the deletion is the subject.
 *
 * This was `guide-sync.test.ts`, and most of it defended a drift governor that held a SECOND media
 * element (the isolated vocals) against the instrumental: a deadband that must not seek, a tempo trim
 * that must converge, a reseek escalation, a pre-roll lock-on taken on the guide's `canplay`, and a
 * measured per-song offset folded in at three call sites. Every one of those tests passed. The feature
 * was still audibly wrong in the room, and it could not be fixed by tuning any of them.
 *
 * The reason is worth keeping in the repo: the governor compared the two elements' reported
 * `currentTime`, which is the spec's official playback position and EXCLUDES each element's output
 * latency. Two independent decoders differ in exactly that quantity, so the governor read "aligned"
 * (drift inside the deadband → hold) while the ear heard an offset, and then correctly stopped
 * correcting. A green suite over a blind measurement is what let it ship.
 *
 * The guide now rides inside the master as channels 2/3 of one 4-channel file, so what remains to test
 * is the part that was never about the guide: whether a reported position is a real JUMP the master
 * should follow, or telemetry it should ignore. The last block guards the DELETION itself.
 */

const TV_PLAYER = 'src/lib/tv/TvPlayer.svelte';

// ── the jump decision ─────────────────────────────────────────────────────────────────────────────

it('seekPlan moves the master on a real jump', () => {
	for (const [from, to] of [
		[60, 0], // restart
		[10, 90], // scrub forward
		[90, 10], // scrub back
		[0, 30], // jump out of the intro
		[120, 118] // small but still a real jump (> SEEK_JUMP_SEC)
	] as const) {
		expect(seekPlan(from, to)).toBe(true);
	}
});

it('seekPlan ignores a sub-threshold position, so ~4Hz telemetry never fights the playhead', () => {
	for (const target of [10, 10.5, 11, 11.4, 9, 8.7]) {
		expect(seekPlan(10, target)).toBe(false);
	}
});

it('seekPlan uses the jump threshold as its boundary', () => {
	expect(seekPlan(10, 10 + SEEK_JUMP_SEC - 0.01)).toBe(false);
	expect(seekPlan(10, 10 + SEEK_JUMP_SEC + 0.01)).toBe(true);
});

it('seekPlan restarts a song playing under the jump threshold — the target-0 rewind is not telemetry', () => {
	// A `restart` sets the reported position to 0 while the song plays on. From a currentTime UNDER
	// SEEK_JUMP_SEC the move |masterSec - 0| is below the telemetry threshold, so the plain distance test
	// never rewinds and the restart does nothing. Positions keyed to the constants so lowering
	// SEEK_JUMP_SEC cannot silently route these through the DISTANCE clause and leave this rule untested.
	for (const masterSec of [
		PLAYHEAD_ALIGN_SEC + 0.01, // just past the tolerance, the smallest real rewind
		SEEK_JUMP_SEC / 3,
		SEEK_JUMP_SEC / 2,
		SEEK_JUMP_SEC - 0.01
	]) {
		expect(seekPlan(masterSec, 0)).toBe(true);
	}
});

it('seekPlan does not read ordinary telemetry as a restart just because 0 is nearby', () => {
	// Telemetry can only report 0 when the song is genuinely at ~0, where moving is a no-op.
	expect(seekPlan(0, 0)).toBe(false);
	expect(seekPlan(PLAYHEAD_ALIGN_SEC / 2, 0)).toBe(false);
	expect(seekPlan(PLAYHEAD_ALIGN_SEC, 0)).toBe(false); // the > boundary
	// A NON-ZERO sub-threshold target distinguishes the rule (`target === 0`) from the banned
	// relaxation (`target < SEEK_JUMP_SEC`): the latter would fire here, the rule must not.
	expect(seekPlan(0.9, 0.5)).toBe(false);
	expect(seekPlan(1.0, 0.4)).toBe(false);
});

it('seekPlan holds on a non-finite playhead or target rather than seeking on a guess', () => {
	// A NaN reaching `currentTime` throws.
	expect(seekPlan(NaN, 0)).toBe(false);
	expect(seekPlan(10, NaN)).toBe(false);
	expect(seekPlan(10, Infinity)).toBe(false);
});

// ── the cold-mount resume ─────────────────────────────────────────────────────────────────────────

it('resumeSeekTarget resumes a fresh master to the room position, at any distance', () => {
	// NOT subject to the jump threshold: a fresh element has no playhead to protect, so a reload 1s into
	// a song must still resume rather than reading as sub-threshold telemetry.
	expect(resumeSeekTarget(0, 6)).toEqual({ seek: true, target: 6 });
	expect(resumeSeekTarget(0, 1)).toEqual({ seek: true, target: 1 });
	expect(resumeSeekTarget(0, 0.5)).toEqual({ seek: true, target: 0.5 });
});

it('resumeSeekTarget does not flush a master already at the position', () => {
	expect(resumeSeekTarget(6, 6).seek).toBe(false);
	expect(resumeSeekTarget(6, 6 + PLAYHEAD_ALIGN_SEC / 2).seek).toBe(false);
});

it('resumeSeekTarget holds on a non-finite playhead or target', () => {
	expect(resumeSeekTarget(NaN, 6).seek).toBe(false);
	expect(resumeSeekTarget(0, NaN).seek).toBe(false);
});

// ── source guards: the wiring, and the deletion ───────────────────────────────────────────────────

const src = read(TV_PLAYER);
const seekEffect = src.split('function applySeek(seekTarget: number): void {')[1]?.split('\n\t}')[0] ?? '';
/** The TRIGGERING effect — whose tracked reads are the dependency set the playhead-yanking defect is about. */
const seekTrigger = (() => {
	const upto = src.split('applySeek(target);')[0];
	const i = upto.lastIndexOf('$effect(() => {');
	return i < 0 ? '' : upto.slice(i);
})();

it('TvPlayer takes the seek decision from seekPlan, not an inline threshold', () => {
	expect(seekEffect).not.toBe('');
	expect(src).toContain('seekPlan(');
	expect(seekEffect).toContain('el.currentTime = seekTarget');
	// The old shape, with its magic 1.5: banned.
	expect(src).not.toContain('Math.abs(master.currentTime - seekSec) > 1.5');
});

it('TvPlayer reads every applySeek input through untrack, so an input never becomes a trigger', () => {
	// `media` read as a tracked dep here is what once yanked a playing song's playhead back to a stale
	// position whenever an unrelated process churned the catalog.
	expect(seekEffect).toContain('untrack(() => master)');
	expect(seekEffect).toContain('untrack(() => media)');
	expect(seekEffect).toContain('untrack(() => active)');
});

it('TvPlayer re-runs the seek effect on every playback:state via a tracked seekRev', () => {
	// A restart under the jump threshold writes 0 over 0, which a `$state` (strict `===`) never notifies,
	// so `seekSec` alone would leave the effect asleep. Assert on CODE, not comments: a `seekRev`
	// mentioned only in a comment registers no reactive dependency and would be mutation-blind.
	expect(seekTrigger).not.toBe('');
	const effectCode = seekTrigger.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	expect(effectCode).toContain('seekRev');
	expect(src).toContain('seekRev?: number');
	const page = read('src/routes/tv/+page.svelte');
	expect(page).toContain('seekRev = e.rev');
	expect(page).toContain('seekRev={seekRev}');
});

/*
 * THE DELETION GUARD. These are the assertions that keep the two-decoder guide from creeping back in as
 * an `if` somewhere in the player — which is how it arrived the first time. Each one names the artefact
 * whose reappearance would mean the drift class is back.
 */
it('TvPlayer mounts exactly ONE media element — a second <audio> is the two-decoder path returning', () => {
	// Count ELEMENT BINDINGS in CODE. Two things defeat a naive scan: the header prose discusses the
	// deleted second element by name (so a `<audio` substring count reads 22), and two comments quote
	// `<audio bind:this={master}>` while explaining the master's lifetime (so an un-stripped binding scan
	// reads three masters). Strip comments, then match.
	const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	const bindings = [...code.matchAll(/bind:this=\{(\w+)\}/g)].map((m) => m[1]);
	expect(bindings).toEqual(['master']);
});

it('TvPlayer has no drift governor, no pre-roll lock-on and no second graph', () => {
	for (const banned of [
		'guideCorrection', // the governor's policy
		'prerollSeekTarget', // the guide's start alignment
		'alignGuidePreroll',
		'syncGuide', // the ~4Hz correction tick
		'guideGraph', // the second element's PitchShiftGraph
		'guideSettled', // the second buffer's readiness latch
		'guideMountable'
	]) {
		// Comments may DISCUSS the deleted design (they should — that is the record of why). Assert on
		// executable code only, so the history can stay written down without weakening the guard.
		const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
		expect(code).not.toContain(banned);
	}
});

it('TvPlayer applies the guide level as a gain on the ONE split graph, not an element volume', () => {
	const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	expect(code).toContain('setGuideGain(effectiveGuide)');
	// A `.volume` write for the guide implies a second element to write it on.
	expect(code).not.toContain('vocals.volume');
});

it('the drift-governor module is gone, not merely unimported', () => {
	// A dangling `guide-sync.ts` would let a future edit re-import the governor and reopen the class.
	expect(() => read('src/lib/tv/guide-sync.ts')).toThrow();
});
