import { expect, it } from 'bun:test';
import { read } from '@encore/test-support';
import { PLAYHEAD_ALIGN_SEC, SEEK_JUMP_SEC, resumeSeekTarget } from '$lib/tv/playhead-sync';

// Caught: reloading the TV page mid-song desynced playback. The room's position arrives BEFORE the <audio> master
// exists on a cold mount (the element is gated on the `nowplaying:changed` the server sends a frame later), so the
// seek effect fires against a null master and drops the target — and position telemetry never bumps `rev`, so the
// effect is never re-woken and the target never re-offered. The fresh master plays from 0 while the room is at 6s,
// and the TV's own telemetry then drags the server's position backwards.
//
// The fix holds the last room position and applies it ONCE on the master's `canplay` via a pure decision, then
// clears the held target so catalog churn cannot re-yank a stale position onto a later song.

it('resumeSeekTarget — a cold-mounted master resumes to the room position: seeks when the room is meaningfully ahead of a fresh element at 0 (the bug: reload mid-song)', () => {
	const plan = resumeSeekTarget(0, 6);
	expect(plan.seek).toBe(true);
	expect(plan.target).toBe(6);
});

it('resumeSeekTarget — a cold-mounted master resumes to the room position: resumes even under SEEK_JUMP_SEC — this is NOT a scrub subject to the jump threshold', () => {
	// A reload 1s into a song: `seekPlan` would read 1s as sub-threshold telemetry and drop it, leaving the
	// reload stuck at 0. The resume decision must still fire.
	expect(SEEK_JUMP_SEC).toBeGreaterThan(1);
	const plan = resumeSeekTarget(0, 1);
	expect(plan.seek).toBe(true);
	expect(plan.target).toBe(1);
});

it('resumeSeekTarget — a cold-mounted master resumes to the room position: does not flush when the element is already at the room position (within the pre-roll tolerance)', () => {
	// No decoder flush for nothing — the same cost the pre-roll and the drift governor both refused to pay.
	expect(resumeSeekTarget(0, 0).seek).toBe(false);
	expect(resumeSeekTarget(6, 6).seek).toBe(false);
	expect(resumeSeekTarget(6, 6 + PLAYHEAD_ALIGN_SEC / 2).seek).toBe(false);
});

it('resumeSeekTarget — a cold-mounted master resumes to the room position: never hands a non-finite value to currentTime (NaN reaching the element throws)', () => {
	expect(resumeSeekTarget(NaN, 6).seek).toBe(false);
	expect(resumeSeekTarget(0, NaN).seek).toBe(false);
	expect(resumeSeekTarget(0, Infinity).seek).toBe(false);
});

// A pure decision is worthless if the component never calls it. `stripComments` blanks comments so a fact
// asserted in prose above the code cannot pass the scan for it.
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1 + '');
}

const raw = read('src/lib/tv/TvPlayer.svelte');
const src = stripComments(raw);

it('TvPlayer.svelte is wired to resume on a cold mount: imports and calls the resumeSeekTarget decision (not a hand-rolled inline comparison)', () => {
	expect(src).toContain('resumeSeekTarget');
	const fn = src.split('function applyResume(')[1]?.split('\n\tfunction ')[0] ?? '';
	expect(fn).not.toBe('');
	expect(fn).toContain('resumeSeekTarget(');
});

it('TvPlayer.svelte is wired to resume on a cold mount: holds the room position ONLY when there is no element to take it', () => {
	// THIS ASSERTION IS INVERTED FROM ITS FIRST FORM, which required an unconditional `resumeTarget = target;` in the
	// effect body and so actively pinned the defect: an unconditional hold survives a DECLINED (sub-threshold) seek,
	// and any later `canplay` — which fires on every readyState rise, not once per mount — then applies it and rewinds
	// the song. Behavioural proof: tests/unit/lib/tv/playhead-canplay-jump.test.ts. The hold also lives inside
	// `applySeek`, beside the `master` read it depends on, not in the effect body whose dependency set the
	// playhead-isolation guard keeps down to what a playback command asked for.
	const fn = src.split('function applySeek(')[1]?.split('\n\tfunction ')[0] ?? '';
	expect(fn).not.toBe('');
	// Held when there is no element, CLEARED when there is one.
	expect(fn).toMatch(/resumeTarget\s*=\s*el\s*\?\s*undefined\s*:\s*seekTarget/);
	expect(fn).toContain('untrack(() => master)');
	const effectBody = src.split('const target = seekSec;')[1]?.split('});')[0] ?? '';
	expect(effectBody).toContain('applySeek(target)');
	expect(effectBody).not.toMatch(/resumeTarget\s*=/);
});

it('TvPlayer.svelte is wired to resume on a cold mount: takes the resume on the master canplay and CONSUMES it (once per load, stale seeks stay shut)', () => {
	// `canplay` is the only moment the fresh element's buffer is primed and its playhead is where audio will emerge,
	// and applyResume clears the held target after applying it so a later load finds nothing held.
	expect(src).toContain('oncanplay={() => applyResume()}');
	const fn = src.split('function applyResume(')[1]?.split('\n\tfunction ')[0] ?? '';
	expect(fn).toContain('resumeTarget = undefined;');
	// The element is read through untrack, like applySeek — an input to the decision, never a trigger for it.
	expect(fn).toContain('untrack(() => master)');
});

it('TvPlayer.svelte is wired to resume on a cold mount: guards applyResume on the ACTIVE, playable slot like applySeek — the prewarm regression', () => {
	// The prewarming (hidden, INACTIVE) slot also reaches canplay, so without applySeek's active/playable guard
	// applyResume parks the NEXT song's element at the outgoing song's position, corrupting the room position on
	// advance. It must EARLY-RETURN, leaving the target held for the slot's own later activation, rather than fall
	// through to the seek — so the return is asserted to sit BEFORE it.
	const fn = src.split('function applyResume(')[1]?.split('\n\tfunction ')[0] ?? '';
	expect(fn).not.toBe('');
	expect(fn).toContain('untrack(() => active)');
	expect(fn).toContain('isPlayable(');
	expect(fn).toContain('!isActive) return;');
	const guardIdx = fn.indexOf('!isActive) return;');
	const seekIdx = fn.indexOf('resumeSeekTarget(');
	expect(guardIdx).toBeGreaterThan(-1);
	expect(seekIdx).toBeGreaterThan(guardIdx);
});
