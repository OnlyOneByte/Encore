import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	tvScreen,
	lobbyRoster,
	lobbyLine,
	lobbyOverdue,
	statusOverdue,
	lyricsAdvancing,
	processStep,
	waitingProgress,
	PROCESS_STEPS
} from '$lib/tv/screen';
import { overallProcessPct } from '$lib/process-progress';
import type { MediaStatus, QueueEntry } from '$lib/contract';
import { at } from '$test';

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
		// `inRoomCount` counts away singers too: a party where every phone has locked itself is not an empty
		// room, and dropping to attract mid-evening was the original defect.
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
		// After a restart the queue is back before any phone re-opens its socket, and falling back to "scan to
		// join" there would imply the queue was lost.
		expect(tvScreen({ playerState: 'attract', current: null, entries: [entry('e1')], inRoomCount: 0 })).toBe('lobby');
	});
});

describe('lyricsAdvancing', () => {
	it('advances while a song plays and the element is actually running', () => {
		expect(lyricsAdvancing('playing', 'playing', true, true)).toBe(true);
	});

	it('does NOT advance while paused, even though the screen is still playing (Bug B)', () => {
		// A paused song is still `current`, so the old screen-only gate kept the reel and ball scrolling with
		// no audio. The room's play/pause INTENT must freeze them.
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

	// The fourth input exists because `isPlaying` is the SERVER's word, not the element's: the room can
	// intend to play while the master is not advancing, and without it the reel swept forward on wall-clock
	// over a silent stage. Both reachable triggers reduce to the same shape, `elementAdvancing === false`.
	it('does NOT advance when the room intends to play but the element is not running', () => {
		expect(lyricsAdvancing('playing', 'playing', true, false)).toBe(false);
	});

	it('freezes when autoplay was refused — silent behind the "tap to start" hint (trigger 1)', () => {
		// A TV wall registers no gesture, master.play() rejects with NotAllowedError and the room stays silent,
		// but the server frame still reports isPlaying: true. The element never fired `play`, so it never
		// reported advancing.
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
		['a', { id: 'a', displayName: 'Dana', color: '#7c5cff' }],
		['m', { id: 'm', displayName: 'Maya', color: '#ff5cae' }],
		['d', { id: 'd', displayName: 'Devon', color: '#33d6a6' }]
	]);

	it('lists singers who are here, in arrival order, with their colors', () => {
		const { shown, overflow } = lobbyRoster(['a', 'm', 'd'], [], dir);
		expect(shown.map((s) => s.displayName)).toStrictEqual(['Dana', 'Maya', 'Devon']);
		expect(shown[0].color).toBe('#7c5cff');
		expect(shown.every((s) => s.state === 'here')).toBe(true);
		expect(overflow).toBe(0);
	});

	it('lists away singers too, tagged so the TV can grey them', () => {
		// A locked phone must not erase its owner from the roster.
		const { shown } = lobbyRoster(['a'], ['m'], dir);
		expect(shown.map((s) => [s.displayName, s.state])).toEqual([
			['Dana', 'here'],
			['Maya', 'away']
		]);
	});

	it('puts here before away, so the cap sheds the unreachable first', () => {
		const { shown, overflow } = lobbyRoster(['d'], ['a', 'm'], dir, 2);
		expect(shown.map((s) => s.displayName)).toStrictEqual(['Devon', 'Dana']);
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
		expect(shown.map((s) => s.displayName)).toStrictEqual(['Dana']);
		expect(overflow).toBe(0);
	});
});

// The value fed to `lyricsAdvancing`'s fourth input must be the MASTER element's real play/pause state, not
// the room's intent a second time. Blank comments first so prose describing the wiring cannot satisfy a scan.
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
		// Passing `isPlaying` again would compile and stay green on the pure tests above while reintroducing
		// the exact defect: intent gating itself.
		expect(route).toMatch(/lyricsAdvancing\(\s*screen\s*,\s*tvState\s*,\s*isPlaying\s*,\s*masterAdvancing\s*\)/);
		// A reactive `$state`, so a callback write actually re-runs the derived.
		expect(route).toMatch(/let\s+masterAdvancing\s*=\s*\$state\(false\)/);
	});

	it('sets masterAdvancing from onplayingchange on BOTH player slots', () => {
		// Two slots (visible + hidden pre-warm); each must report, or the signal goes stale across a swap.
		const wires = [...route.matchAll(/onplayingchange=\{\(\w+\)\s*=>\s*\(masterAdvancing\s*=\s*\w+\)\}/g)];
		expect(wires.length).toBe(2);
	});

	it("TvPlayer reports the MASTER element's own play/pause, gated on active+visible", () => {
		// The honest source is the <audio>'s native events, never a re-derivation of the intent prop. Gating on
		// active+visible mirrors onautoplayblocked, so the hidden pre-warm slot — deliberately paused — cannot
		// report the room as stopped.
		expect(player).toMatch(/onplayingchange\?:\s*\(playing:\s*boolean\)\s*=>\s*void/);
		expect(player).toMatch(/onplay=\{\(\)\s*=>\s*active\s*&&\s*visible\s*&&\s*onplayingchange\?\.\(true\)\}/);
		expect(player).toMatch(/onpause=\{\(\)\s*=>\s*active\s*&&\s*visible\s*&&\s*onplayingchange\?\.\(false\)\}/);
		// onended reports a stop too: the element pauses at track end without firing `pause` in every engine.
		expect(player).toMatch(/if\s*\(active\s*&&\s*visible\)\s*onplayingchange\?\.\(false\)/);
	});
});

describe('processStep', () => {
	// The still-processing takeover shows THREE steps while the media model has FIVE stages, so the collapse
	// is a real mapping. It must be TOTAL over MediaStatus or the takeover renders with no step marked, and
	// the labels are guest words shared in shape with the phone.
	it('has exactly three guest-facing step labels', () => {
		expect([...PROCESS_STEPS]).toEqual(['Downloaded', 'Removing vocals', 'Timing the lyrics']);
	});

	it('is total over every MediaStatus — exactly one step is current for any value', () => {
		const all = ['queued', 'downloading', 'separating', 'aligning', 'ready', 'failed', 'canceled'] as const;
		for (const s of all) {
			const step = processStep(s);
			expect(step.index, `${s} maps to a valid step index`).toBeGreaterThanOrEqual(0);
			expect(step.index, `${s} maps to a valid step index`).toBeLessThan(PROCESS_STEPS.length);
		}
	});

	it('advances the step as the process progresses down MEDIA_STAGES', () => {
		// Monotonic non-decreasing across the line.
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

// F4: the waiting takeover drew `processStep('separating')`'s fixed 62% whatever the song's real progress.
describe('waitingProgress', () => {
	it("is the phone's own overall figure off the LIVE status, so the wall and the phone agree", () => {
		for (const [status, pct] of [
			['queued', 0],
			['downloading', 50],
			['separating', 10],
			['separating', 80],
			['aligning', 50],
			['ready', 100]
		] as [MediaStatus, number][]) {
			expect(waitingProgress({ status, pct })).toEqual({
				index: processStep(status).index,
				pct: overallProcessPct(status, pct)
			});
		}
		// Two real figures in one stage are two bars, not one representative one.
		expect(waitingProgress({ status: 'separating', pct: 10 })!.pct).toBeLessThan(
			waitingProgress({ status: 'separating', pct: 80 })!.pct
		);
	});

	it('draws nothing with no live status, or off the line, rather than invent a figure', () => {
		expect(waitingProgress(undefined)).toBeNull();
		expect(waitingProgress({ status: 'failed', pct: 40 })).toBeNull();
		expect(waitingProgress({ status: 'canceled', pct: 40 })).toBeNull();
		// The phone's stalled card: a status the server has said nobody can run draws no bar.
		expect(waitingProgress({ status: 'queued', pct: 0, unservable: true })).toBeNull();
	});

	it("the TV page passes the song's liveStatus, never a literal stage", () => {
		const page = readFileSync(join(import.meta.dir, '../../../../src/routes/tv/+page.svelte'), 'utf8');
		expect(page).not.toMatch(/processStep\(\s*['"]/);
		expect(page).toMatch(/waitingProgress\(current \? liveStatus\.get\(current\.mediaId\) : undefined\)/);
		// The bar draws that figure, and the slot hides whenever there is none.
		expect(page).toMatch(/<div class="process-bar"><i style="width: \{proc\?\.pct \?\? 0\}%"><\/i><\/div>/);
		expect(page).toMatch(/class=\{\{ 'process-slot': true, unknown: !proc \}\}/);
		// The figure is only real while every `media:status` lands in that map.
		expect(page).toMatch(/liveStatus = new Map\(liveStatus\)\.set\(e\.mediaId, e\);/);
	});
});

// The TV must say what the singer's phone says: once core calls a song overdue (`etaSec < 0`) the phone card reads
// "Taking longer than usual", and the lobby may no longer promise "this takes a minute" (proposal 05).
describe('the lobby line, and an overdue song', () => {
	it('promises a minute while the song is on time', () => {
		expect(lobbyLine(3, true, false)).toBe('3 in the room · making the karaoke, this takes a minute');
		expect(lobbyLine(0, true, false)).toBe('Making the karaoke — this takes a minute');
	});

	it('says it is taking longer than usual once the song is overdue, and no longer promises a minute', () => {
		expect(lobbyLine(3, true, true)).toBe('3 in the room · making the karaoke, taking longer than usual');
		expect(lobbyLine(0, true, true)).toBe('Making the karaoke — taking longer than usual');
		expect(lobbyLine(3, true, true)).not.toContain('a minute');
	});

	it('asks for a song when nothing is being made, overdue or not', () => {
		for (const overdue of [false, true]) {
			expect(lobbyLine(2, false, overdue)).toBe('2 in the room · search on your phone and pick a song');
			expect(lobbyLine(0, false, overdue)).toBe('Scan to join, then search on your phone and pick a song');
		}
	});

	it('names a stuck turn\'s way out in place of "pick a song", but never over a song being made', () => {
		const next = 'Theo, try again or pick another on your phone';
		expect(lobbyLine(2, false, false, next)).toBe(next);
		expect(lobbyLine(0, false, true, next)).toBe(next);
		expect(lobbyLine(2, true, false, next)).toBe('2 in the room · making the karaoke, this takes a minute');
		expect(lobbyLine(2, false, false, null)).toBe('2 in the room · search on your phone and pick a song');
	});

	it('calls the lobby overdue only while a song still being made is one of the overdue ones', () => {
		const making = [entry('a'), entry('b')];
		expect(lobbyOverdue(making, new Set(['m-b']))).toBe(true);
		expect(lobbyOverdue(making, new Set(['m-gone']))).toBe(false);
		expect(lobbyOverdue(making, new Set())).toBe(false);
	});

	it('counts a status as overdue only while its song is still being made', () => {
		for (const status of ['queued', 'downloading', 'separating', 'aligning'] as const) {
			expect(statusOverdue({ status, etaSec: -1 })).toBe(true);
			expect(statusOverdue({ status, etaSec: 30 })).toBe(false);
			expect(statusOverdue({ status })).toBe(false);
		}
		// A ready, failed or canceled song is overdue no longer, whatever etaSec it still carries.
		for (const status of ['ready', 'failed', 'canceled'] as const) {
			expect(statusOverdue({ status, etaSec: -1 })).toBe(false);
		}
	});

	it('is wired: the TV page notes each media:status and asks only about songs still being made', () => {
		const route = stripComments(readFileSync(join(at('src/routes/tv'), '+page.svelte'), 'utf8'));
		const lobby = stripComments(readFileSync(join(at('src/lib/tv'), 'TvLobby.svelte'), 'utf8'));
		expect(route).toMatch(/if \(e\.type === 'media:status'\) noteOverdue\(e\.mediaId, statusOverdue\(e\)\);/);
		expect(route).toMatch(/if \(isOverdue\) overdueMedia\.add\(mediaId\);\s*else overdueMedia\.delete\(mediaId\);/);
		expect(route).toMatch(/const pending = \$derived\(\s*entries\.filter\(\(e\) => \{[^}]*!isPlayable\(m\);\s*\}\)/);
		// The lobby's COUNT is the fold's `making`; `pending` (every unplayable turn) only scopes the overdue question.
		expect(route).toMatch(/pendingCount=\{waiting\.making\}/);
		expect(route).toMatch(/const overdue = \$derived\(lobbyOverdue\(pending, overdueMedia\)\);/);
		expect(route).toMatch(/<TvLobby[^>]*\boverdue=\{overdue\}/);
		expect(lobby).toMatch(/lobbyLine\(count, processing, overdue, stuck\?\.next\)/);
	});
});
