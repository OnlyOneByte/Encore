import { describe, expect, it } from 'bun:test';
import { tvScreen, lobbyRoster, lyricsAdvancing } from './screen';
import type { QueueEntry } from '@encore/shared';

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
		expect(tvScreen({ playerState: 'playing', current: entry('e1'), entries: [entry('e1')], inRoomCount: 0 })).toBe('playing');
		expect(tvScreen({ playerState: 'playing', current: entry('e1'), entries: [entry('e1')], inRoomCount: 9 })).toBe('playing');
	});

	it('waiting (stems still cooking) beats the lobby — it is a more specific answer', () => {
		expect(tvScreen({ playerState: 'waiting', current: entry('e1'), entries: [entry('e1')], inRoomCount: 3 })).toBe('waiting');
		// and it still wins with nobody in the room
		expect(tvScreen({ playerState: 'waiting', current: entry('e1'), entries: [entry('e1')], inRoomCount: 0 })).toBe('waiting');
	});

	it('interstitial between songs keeps playing (the video surface stays up)', () => {
		expect(tvScreen({ playerState: 'interstitial', current: entry('e2'), entries: [entry('e2')], inRoomCount: 2 })).toBe('playing');
	});

	it('a rehydrated queue with nobody reconnected yet shows the lobby, not attract', () => {
		// After a restart the queue is back before any phone re-opens its socket. Falling back to
		// "scan to join" there would imply the queue was lost.
		expect(tvScreen({ playerState: 'attract', current: null, entries: [entry('e1')], inRoomCount: 0 })).toBe('lobby');
	});
});

describe('lyricsAdvancing', () => {
	it('advances while a song plays', () => {
		expect(lyricsAdvancing('playing', 'playing', true)).toBe(true);
	});

	it('does NOT advance while paused, even though the screen is still playing (Bug B)', () => {
		// The bug: a paused song is still `current`, so the old screen-only gate kept the reel and ball
		// scrolling with no audio. The transport state must freeze them.
		expect(lyricsAdvancing('playing', 'playing', false)).toBe(false);
	});

	it('does not advance during the interstitial (a song is not on the words yet)', () => {
		expect(lyricsAdvancing('playing', 'interstitial', true)).toBe(false);
	});

	it('does not advance on the idle screens regardless of transport', () => {
		expect(lyricsAdvancing('attract', 'attract', true)).toBe(false);
		expect(lyricsAdvancing('lobby', 'attract', true)).toBe(false);
		expect(lyricsAdvancing('waiting', 'waiting', true)).toBe(false);
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
		expect(shown.map((s) => s.displayName)).toEqual(['Angelo', 'Maya', 'Devon']);
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
		expect(shown.map((s) => s.displayName)).toEqual(['Devon', 'Angelo']);
		expect(overflow).toBe(1); // Maya, who could not have taken a turn anyway
	});

	it('shows only who is in the room — a gone singer in the directory is not listed', () => {
		const { shown } = lobbyRoster(['m'], [], dir);
		expect(shown.map((s) => s.displayName)).toEqual(['Maya']);
	});

	it('caps the chips and reports the overflow so a 20-person party cannot flood the screen', () => {
		const many = new Map(Array.from({ length: 12 }, (_, i) => [`s${i}`, { id: `s${i}`, displayName: `P${i}`, color: '#fff' }]));
		const { shown, overflow } = lobbyRoster([...many.keys()], [], many, 8);
		expect(shown).toHaveLength(8);
		expect(overflow).toBe(4);
	});

	it('skips an id we have no name for yet rather than rendering a nameless chip', () => {
		// membership can arrive before the queue:sync singer directory does
		const { shown, overflow } = lobbyRoster(['a', 'unknown-id'], ['also-unknown'], dir);
		expect(shown.map((s) => s.displayName)).toEqual(['Angelo']);
		expect(overflow).toBe(0);
	});
});
