import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GUIDE_PREROLL_ALIGN_SEC, SEEK_JUMP_SEC, resumeSeekTarget } from './guide-sync';

/*
 * — reloading the TV page mid-song desynced audio playback.
 *
 * Measured cause (triage): the room's position (`playback:state.positionSec`) is delivered BEFORE the
 * <audio> master exists on a cold mount, because the element is gated on the `nowplaying:changed` the
 * server sends one frame later. The seek effect fires against a null master and drops the target;
 * position telemetry never bumps `rev`, so `seekPlan`'s effect is never re-woken and the target is
 * never re-offered. The fresh master plays from 0 while the room is at 6s, and the TV's own telemetry
 * then drags the server's position backwards.
 *
 * The fix mirrors the guide pre-roll: hold the last room position, and apply it ONCE on the
 * master's `canplay` via a pure decision function, then clear the held target so catalog churn cannot
 * re-yank a stale position onto a later song (the stale-seek invariant).
 *
 * Two halves are pinned here: (1) `resumeSeekTarget` decides correctly, and (2) TvPlayer.svelte is
 * WIRED to it — the position is held, taken on the master's `canplay`, and consumed. A pure test
 * cannot see the wiring, so the wiring block is a mutation-proof source scan (the same shape as
 * autoplay-recovery.test.ts).
 */

it('resumeSeekTarget — a cold-mounted master resumes to the room position: seeks when the room is meaningfully ahead of a fresh element at 0 (the bug: reload mid-song)', () => {
	// The measured case: room at 6s, fresh master at ~0. Base drops this entirely.
	const plan = resumeSeekTarget(0, 6);
	expect(plan.seek).toBe(true);
	expect(plan.target).toBe(6);
});

it('resumeSeekTarget — a cold-mounted master resumes to the room position: resumes even under SEEK_JUMP_SEC — this is NOT a scrub subject to the jump threshold', () => {
	// A reload 1s into a song. `seekPlan` would read 1s as sub-threshold telemetry and drop it
	// (1 < SEEK_JUMP_SEC = 1.5), leaving the reload stuck at 0. The resume decision must still fire.
	expect(SEEK_JUMP_SEC).toBeGreaterThan(1);
	const plan = resumeSeekTarget(0, 1);
	expect(plan.seek).toBe(true);
	expect(plan.target).toBe(1);
});

it('resumeSeekTarget — a cold-mounted master resumes to the room position: does not flush when the element is already at the room position (within the pre-roll tolerance)', () => {
	// A genuine resume-to-0, or a mount that already landed on the right spot — no decoder flush
	// for nothing, the same cost the pre-roll and drift governor both refuse to pay.
	expect(resumeSeekTarget(0, 0).seek).toBe(false);
	expect(resumeSeekTarget(6, 6).seek).toBe(false);
	expect(resumeSeekTarget(6, 6 + GUIDE_PREROLL_ALIGN_SEC / 2).seek).toBe(false);
});

it('resumeSeekTarget — a cold-mounted master resumes to the room position: never hands a non-finite value to currentTime (NaN reaching the element throws)', () => {
	expect(resumeSeekTarget(NaN, 6).seek).toBe(false);
	expect(resumeSeekTarget(0, NaN).seek).toBe(false);
	expect(resumeSeekTarget(0, Infinity).seek).toBe(false);
});

/*
 * Source-scan wiring guards. A pure decision is worthless if the component never calls it, so these
 * pin the three load-bearing wiring facts and RED if any is removed. `stripComments` blanks comments
 * so a fact asserted in prose above the code cannot pass the scan for it.
 */
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1 + '');
}

const raw = readFileSync(join(import.meta.dir, 'TvPlayer.svelte'), 'utf8');
const src = stripComments(raw);

it('TvPlayer.svelte is wired to resume on a cold mount: imports and calls the resumeSeekTarget decision (not a hand-rolled inline comparison)', () => {
	expect(src).toContain('resumeSeekTarget');
	// The decision is taken inside applyResume, from the held target and the element playhead.
	const fn = src.split('function applyResume(')[1]?.split('\n\tfunction ')[0] ?? '';
	expect(fn).not.toBe('');
	expect(fn).toContain('resumeSeekTarget(');
});

it('TvPlayer.svelte is wired to resume on a cold mount: holds the room position in the seek effect so a cold mount can take it later', () => {
	// The seek effect stashes seekSec into resumeTarget BEFORE applySeek — without the stash, a
	// mount-time frame is lost the moment applySeek early-returns on a null master.
	expect(src).toContain('resumeTarget = target;');
	// applySeek must still run for the warm scrub path.
	const effectBody = src.split('const target = seekSec;')[1]?.split('});')[0] ?? '';
	expect(effectBody).toContain('resumeTarget = target;');
	expect(effectBody).toContain('applySeek(target)');
});

it('TvPlayer.svelte is wired to resume on a cold mount: takes the resume on the master canplay and CONSUMES it (once per load, stale seeks stay shut)', () => {
	// The master <audio> calls applyResume on canplay — the only place the fresh element's buffer
	// is primed and its playhead is where audio will emerge.
	expect(src).toContain('oncanplay={() => applyResume()}');
	// applyResume clears the held target after applying it, so a later element load finds nothing
	// held and cannot re-yank a stale position onto the next song.
	const fn = src.split('function applyResume(')[1]?.split('\n\tfunction ')[0] ?? '';
	expect(fn).toContain('resumeTarget = undefined;');
	// It reads the element through untrack, like applySeek — an input to the decision, never a
	// trigger for it.
	expect(fn).toContain('untrack(() => master)');
});

it('TvPlayer.svelte is wired to resume on a cold mount: guards applyResume on the ACTIVE, playable slot like applySeek — the prewarm regression', () => {
	// The regression the cold-mount fix opened: the prewarming (hidden, INACTIVE) slot reaches
	// canplay, so without applySeek's `active`/playable guard, applyResume parks the NEXT song's
	// element at the outgoing song's position, corrupting the room position on advance. applyResume
	// must carry the same guard, and it must GUARD (early-return) rather than merely skip the seek.
	const fn = src.split('function applyResume(')[1]?.split('\n\tfunction ')[0] ?? '';
	expect(fn).not.toBe('');
	expect(fn).toContain('untrack(() => active)');
	expect(fn).toContain('isPlayable(');
	// The guard must EARLY-RETURN on the inactive/non-playable slot (a no-op that leaves the target
	// held for the slot's own later activation), not fall through to the seek. Assert the return
	// tests !isActive, and that it sits BEFORE the seek that reads the plan.
	expect(fn).toContain('!isActive) return;');
	const guardIdx = fn.indexOf('!isActive) return;');
	const seekIdx = fn.indexOf('resumeSeekTarget(');
	expect(guardIdx).toBeGreaterThan(-1);
	expect(seekIdx).toBeGreaterThan(guardIdx);
});
