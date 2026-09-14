import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tvScreen, lobbyRoster, lyricsAdvancing, processStep, PROCESS_STEPS } from '$lib/tv/screen';
import type { QueueEntry } from '$lib/contract';
import { at } from '@encore/test-support';

const entry = (id: string, singerId = 's1'): QueueEntry =>
	({ id, mediaId: 'm-' + id, singerId, status: 'queued', rotationSeq: 1, addedAt: 1 }) as QueueEntry;

describe('tvScreen', () => {
	it('empty idle room → attract (the QR owns the screen)', () => {
		expect(tvScreen({ playerState: 'attract', current: null, entries: [], inRoomCount: 0 })).toBe('attract');
	});

	it('people present, nothing queued → lobby (the bug this fixes: it used to read as attract)', () => {
		expect(tvScreen({ playerState: 'attract', current: null, entries: [], inRoomCount: 4 })).toBe('lobby');
	});

	it('everyone away with an empty queue is still a lobby, not an empty room', () => {
		// inRoomCount counts away singers too. A party where every phone has locked itself is not an
		// empty room, and dropping to the attract screen mid-evening was the original defect.
		expect(tvScreen({ playerState: 'attract', current: null, entries: [], inRoomCount: 3 })).toBe('lobby');
	});

	it('a song is current → playing, regardless of how many people are in the room', () => {
		expect(tvScreen({ playerState: 'playing', current: entry('e1'), entries: [entry('e1')], inRoomCount: 0 })).toBe(
			'playing'
		);
		expect(tvScreen({ playerState: 'playing', current: entry('e1'), entries: [entry('e1')], inRoomCount: 9 })).toBe(
			'playing'
		);
	});

	it('waiting (stems still processing) beats the lobby — it is a more specific answer', () => {
		expect(tvScreen({ playerState: 'waiting', current: entry('e1'), entries: [entry('e1')], inRoomCount: 3 })).toBe(
			'waiting'
		);
		// and it still wins with nobody in the room
		expect(tvScreen({ playerState: 'waiting', current: entry('e1'), entries: [entry('e1')], inRoomCount: 0 })).toBe(
			'waiting'
		);
	});

	it('interstitial between songs keeps playing (the video surface stays up)', () => {
		expect(
			tvScreen({ playerState: 'interstitial', current: entry('e2'), entries: [entry('e2')], inRoomCount: 2 })
		).toBe('playing');
	});

	it('a rehydrated queue with nobody reconnected yet shows the lobby, not attract', () => {
		// After a restart the queue is back before any phone re-opens its socket. Falling back to
		// "scan to join" there would imply the queue was lost.
		expect(tvScreen({ playerState: 'attract', current: null, entries: [entry('e1')], inRoomCount: 0 })).toBe('lobby');
	});
});

describe('lyricsAdvancing', () => {
	it('advances while a song plays and the element is actually running', () => {
		expect(lyricsAdvancing('playing', 'playing', true, true)).toBe(true);
	});

	it('does NOT advance while paused, even though the screen is still playing (Bug B)', () => {
		// The bug: a paused song is still `current`, so the old screen-only gate kept the reel and ball
		// scrolling with no audio. The room's play/pause INTENT must freeze them.
		expect(lyricsAdvancing('playing', 'playing', false, false)).toBe(false);
	});

	it('does not advance during the interstitial (a song is not on the words yet)', () => {
		expect(lyricsAdvancing('playing', 'interstitial', true, true)).toBe(false);
	});

	it('does not advance on the idle screens regardless of transport', () => {
		expect(lyricsAdvancing('attract', 'attract', true, true)).toBe(false);
		expect(lyricsAdvancing('lobby', 'attract', true, true)).toBe(false);
		expect(lyricsAdvancing('waiting', 'waiting', true, true)).toBe(false);
	});

	// THE MISSING QUADRANT. The room INTENDS to play (`isPlaying === true`) while the master
	// element is NOT advancing. `isPlaying` is the server's word, not the element's; without the fourth
	// input the reel swept forward on wall-clock over a silent stage. This is the case no prior test
	// covered, which is why "scrolling words, silent room" shipped with the suite green. Each of the two
	// reachable triggers reduces to the SAME shape here: `elementAdvancing === false`.
	it('does NOT advance when the room intends to play but the element is not running', () => {
		expect(lyricsAdvancing('playing', 'playing', true, false)).toBe(false);
	});

	it('freezes when autoplay was refused — silent behind the "tap to start" hint (trigger 1)', () => {
		// A TV wall registers no gesture, master.play() rejects with NotAllowedError, the room stays silent,
		// but the server frame still reports isPlaying: true. The element never fired `play`, so it never
		// reported advancing, and the reel must not sweep.
		expect(lyricsAdvancing('playing', 'playing', true, false)).toBe(false);
	});

	it('freezes when the current entry is not playable / its src has not landed (trigger 2)', () => {
		// transportFor returns `idle` for a not-yet-processed or src-less entry while tvScreen still returns
		// `playing` for any current entry. Same idle element, same frozen reel.
		expect(lyricsAdvancing('playing', 'playing', true, false)).toBe(false);
	});
});

describe('lobbyRoster', () => {
	const dir = new Map([
		['a', { id: 'a', displayName: 'Angelo', color: '#7c5cff' }],
		['m', { id: 'm', displayName: 'Maya', color: '#ff5cae' }],
		['d', { id: 'd', displayName: 'Devon', color: '#33d6a6' }]
	]);

	it('lists singers who are here, in arrival order, with their colors', () => {
		const { shown, overflow } = lobbyRoster(['a', 'm', 'd'], [], dir);
		expect(shown.map((s) => s.displayName)).toStrictEqual(['Angelo', 'Maya', 'Devon']);
		expect(shown[0].color).toBe('#7c5cff');
		expect(shown.every((s) => s.state === 'here')).toBe(true);
		expect(overflow).toBe(0);
	});

	it('lists away singers too, tagged so the TV can grey them', () => {
		// The whole point: a locked phone must not erase its owner from the roster.
		const { shown } = lobbyRoster(['a'], ['m'], dir);
		expect(shown.map((s) => [s.displayName, s.state])).toEqual([
			['Angelo', 'here'],
			['Maya', 'away']
		]);
	});

	it('puts here before away, so the cap sheds the unreachable first', () => {
		const { shown, overflow } = lobbyRoster(['d'], ['a', 'm'], dir, 2);
		expect(shown.map((s) => s.displayName)).toStrictEqual(['Devon', 'Angelo']);
		expect(overflow).toBe(1); // Maya, who could not have taken a turn anyway
	});

	it('shows only who is in the room — a gone singer in the directory is not listed', () => {
		const { shown } = lobbyRoster(['m'], [], dir);
		expect(shown.map((s) => s.displayName)).toStrictEqual(['Maya']);
	});

	it('caps the chips and reports the overflow so a 20-person party cannot flood the screen', () => {
		const many = new Map(
			Array.from({ length: 12 }, (_, i) => [`s${i}`, { id: `s${i}`, displayName: `P${i}`, color: '#fff' }])
		);
		const { shown, overflow } = lobbyRoster([...many.keys()], [], many, 8);
		expect(shown).toHaveLength(8);
		expect(overflow).toBe(4);
	});

	it('skips an id we have no name for yet rather than rendering a nameless chip', () => {
		// membership can arrive before the queue:sync singer directory does
		const { shown, overflow } = lobbyRoster(['a', 'unknown-id'], ['also-unknown'], dir);
		expect(shown.map((s) => s.displayName)).toStrictEqual(['Angelo']);
		expect(overflow).toBe(0);
	});
});

/*
 * the wiring — the honest element-advancing signal reaches the gate.
 *
 * `lyricsAdvancing`'s fourth input is unit-pinned above, but the pure function is only half the fix:
 * the value fed to it must be the MASTER element's real play/pause state, not the room's intent a
 * second time. That plumbing lives in two .svelte files with no unit harness, so it is pinned by a
 * source scan here — the same shape as the an earlier change autoplay guard and the catalog-boundary guard.
 * Blank comments first so prose describing the wiring cannot satisfy a scan.
 */
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

describe('the element-advancing signal is wired from the master element to the gate', () => {
	const here = at('src/lib/tv');
	const route = stripComments(readFileSync(join(here, '..', '..', 'routes', 'tv', '+page.svelte'), 'utf8'));
	const player = stripComments(readFileSync(join(here, 'TvPlayer.svelte'), 'utf8'));

	it('feeds lyricsAdvancing a real element signal, not the room intent twice', () => {
		// The fourth argument must be `masterAdvancing` — passing `isPlaying` again would compile and stay
		// green on the pure tests while reintroducing the exact defect (intent gating itself).
		expect(route).toMatch(/lyricsAdvancing\(\s*screen\s*,\s*tvState\s*,\s*isPlaying\s*,\s*masterAdvancing\s*\)/);
		// It is a reactive `$state`, so a callback write actually re-runs the derived.
		expect(route).toMatch(/let\s+masterAdvancing\s*=\s*\$state\(false\)/);
	});

	it('sets masterAdvancing from onplayingchange on BOTH player slots', () => {
		// Two slots (visible + hidden pre-warm); each must report, or the signal goes stale across a swap.
		const wires = [...route.matchAll(/onplayingchange=\{\(\w+\)\s*=>\s*\(masterAdvancing\s*=\s*\w+\)\}/g)];
		expect(wires.length).toBe(2);
	});

	it("TvPlayer reports the MASTER element's own play/pause, gated on active+visible", () => {
		// The honest source is the <audio>'s native events, not a re-derivation of the intent prop. Gating on
		// active+visible mirrors onautoplayblocked so the hidden pre-warm slot (deliberately paused) cannot
		// report the room as stopped.
		expect(player).toMatch(/onplayingchange\?:\s*\(playing:\s*boolean\)\s*=>\s*void/);
		expect(player).toMatch(/onplay=\{\(\)\s*=>\s*active\s*&&\s*visible\s*&&\s*onplayingchange\?\.\(true\)\}/);
		expect(player).toMatch(/onpause=\{\(\)\s*=>\s*active\s*&&\s*visible\s*&&\s*onplayingchange\?\.\(false\)\}/);
		// onended reports a stop too (the element pauses at track end without firing `pause` in every engine).
		expect(player).toMatch(/if\s*\(active\s*&&\s*visible\)\s*onplayingchange\?\.\(false\)/);
	});
});

describe('processStep (XR-TV-15)', () => {
	// The still-processing takeover shows THREE steps while the media model has FIVE stages, so the
	// collapse is a real mapping. It must be TOTAL over MediaStatus so the takeover never renders with
	// no step marked, and the labels are guest words shared in shape with the phone.
	it('has exactly three guest-facing step labels', () => {
		expect([...PROCESS_STEPS]).toEqual(['Downloaded', 'Removing vocals', 'Timing the lyrics']);
	});

	it('is total over every MediaStatus — exactly one step is current for any value', () => {
		const all = ['queued', 'downloading', 'separating', 'aligning', 'ready', 'failed', 'canceled'] as const;
		for (const s of all) {
			const step = processStep(s);
			expect(step.index, `${s} maps to a valid step index`).toBeGreaterThanOrEqual(0);
			expect(step.index, `${s} maps to a valid step index`).toBeLessThan(PROCESS_STEPS.length);
			// the fraction is a CSS percentage the bar can consume
			expect(step.fraction).toMatch(/^\d+%$/);
		}
	});

	it('advances the step as the process progresses down MEDIA_STAGES', () => {
		// getting-audio -> removing-vocals -> timing-lyrics: monotonic non-decreasing across the line.
		expect(processStep('queued').index).toBe(0);
		expect(processStep('downloading').index).toBe(0);
		expect(processStep('separating').index).toBe(1);
		expect(processStep('aligning').index).toBe(2);
		expect(processStep('ready').index).toBe(2);
	});

	it('floors an off-the-line status (failed/canceled/undefined) at the first step, never out of range', () => {
		for (const s of ['failed', 'canceled', undefined] as const) {
			expect(processStep(s).index).toBe(0);
		}
	});
});
