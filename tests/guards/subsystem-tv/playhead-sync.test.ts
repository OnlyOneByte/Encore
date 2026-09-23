import { expect, it } from 'bun:test';
import { read } from '@encore/test-support';
import { PLAYHEAD_ALIGN_SEC, SEEK_JUMP_SEC, resumeSeekTarget, seekPlan } from '$lib/tv/playhead-sync';

// guard: a reported position is either a real JUMP the master must follow or telemetry it must ignore. The
// guide rides inside the master as channels 2/3 of one file, so there is exactly ONE element and no drift
// governor — reported `currentTime` EXCLUDES each decoder's output latency, so comparing two elements reads
// "aligned" while the ear hears an offset. The last block guards that deletion. See docs/GUARDS.md#tv.

const TV_PLAYER = 'src/lib/tv/TvPlayer.svelte';

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
	// A `restart` sets the reported position to 0 while the song plays on, so from a currentTime UNDER
	// SEEK_JUMP_SEC the move |masterSec - 0| is below the telemetry threshold and the plain distance test never
	// rewinds. Positions keyed to the constants, so lowering SEEK_JUMP_SEC cannot route these through the
	// DISTANCE clause and leave the rule untested.
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
	// A NON-ZERO sub-threshold target separates the rule (`target === 0`) from the banned relaxation
	// (`target < SEEK_JUMP_SEC`), which would fire here.
	expect(seekPlan(0.9, 0.5)).toBe(false);
	expect(seekPlan(1.0, 0.4)).toBe(false);
});

it('seekPlan holds on a non-finite playhead or target rather than seeking on a guess', () => {
	// A NaN reaching `currentTime` throws.
	expect(seekPlan(NaN, 0)).toBe(false);
	expect(seekPlan(10, NaN)).toBe(false);
	expect(seekPlan(10, Infinity)).toBe(false);
});

it('resumeSeekTarget resumes a fresh master to the room position, at any distance', () => {
	// NOT subject to the jump threshold: a fresh element has no playhead to protect, so a reload 1s in must
	// still resume rather than read as sub-threshold telemetry.
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
	// `media` as a tracked dep here once yanked a playing song's playhead back whenever a process churned the catalog.
	expect(seekEffect).toContain('untrack(() => master)');
	expect(seekEffect).toContain('untrack(() => media)');
	expect(seekEffect).toContain('untrack(() => active)');
});

it('TvPlayer re-runs the seek effect on every playback:state via a tracked seekRev', () => {
	// A restart under the jump threshold writes 0 over 0, which a `$state` (strict `===`) never notifies, so
	// `seekSec` alone leaves the effect asleep. Asserted on CODE: a `seekRev` named only in a comment is no dependency.
	expect(seekTrigger).not.toBe('');
	const effectCode = seekTrigger.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	expect(effectCode).toContain('seekRev');
	expect(src).toContain('seekRev?: number');
	const page = read('src/routes/tv/+page.svelte');
	expect(page).toContain('seekRev = e.rev');
	expect(page).toContain('seekRev={seekRev}');
});

// The deletion guard: these keep the two-decoder guide from creeping back as an `if` somewhere in the player,
// which is how it arrived the first time. Each names an artefact whose return would mean the drift class is back.
it('TvPlayer mounts exactly ONE media element — a second <audio> is the two-decoder path returning', () => {
	// Count ELEMENT BINDINGS in CODE: the component's prose names the deleted second element, and two of its
	// comments quote `<audio bind:this={master}>` while explaining the master's lifetime.
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
		// Comments may DISCUSS the deleted design, so assert on executable code only.
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
