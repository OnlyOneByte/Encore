import { describe, expect, it } from 'bun:test';
import { tvScreen, lobbyRoster } from './screen';
import type { QueueEntry } from '@encore/shared';

const entry = (id: string, singerId = 's1'): QueueEntry =>
	({ id, mediaId: 'm-' + id, singerId, status: 'queued', rotationSeq: 1, addedAt: 1 }) as QueueEntry;

describe('tvScreen', () => {
	it('empty idle room → attract (the QR owns the screen)', () => {
		expect(tvScreen({ playerState: 'attract', current: null, entries: [], onlineCount: 0 })).toBe('attract');
	});

	it('people present, nothing queued → lobby (the bug this fixes: it used to read as attract)', () => {
		expect(tvScreen({ playerState: 'attract', current: null, entries: [], onlineCount: 4 })).toBe('lobby');
	});

	it('a song is current → playing, regardless of how many people are online', () => {
		expect(tvScreen({ playerState: 'playing', current: entry('e1'), entries: [entry('e1')], onlineCount: 0 })).toBe('playing');
		expect(tvScreen({ playerState: 'playing', current: entry('e1'), entries: [entry('e1')], onlineCount: 9 })).toBe('playing');
	});

	it('waiting (stems still cooking) beats the lobby — it is a more specific answer', () => {
		expect(tvScreen({ playerState: 'waiting', current: entry('e1'), entries: [entry('e1')], onlineCount: 3 })).toBe('waiting');
		// and it still wins with nobody online
		expect(tvScreen({ playerState: 'waiting', current: entry('e1'), entries: [entry('e1')], onlineCount: 0 })).toBe('waiting');
	});

	it('interstitial between songs keeps playing (the video surface stays up)', () => {
		expect(tvScreen({ playerState: 'interstitial', current: entry('e2'), entries: [entry('e2')], onlineCount: 2 })).toBe('playing');
	});

	it('a rehydrated queue with nobody reconnected yet shows the lobby, not attract', () => {
		// After a restart the queue is back before any phone re-opens its socket. Falling back to
		// "scan to join" there would imply the queue was lost.
		expect(tvScreen({ playerState: 'attract', current: null, entries: [entry('e1')], onlineCount: 0 })).toBe('lobby');
	});
});

describe('lobbyRoster', () => {
	const dir = new Map([
		['a', { id: 'a', displayName: 'Angelo', color: '#7c5cff' }],
		['m', { id: 'm', displayName: 'Maya', color: '#ff5cae' }],
		['d', { id: 'd', displayName: 'Devon', color: '#33d6a6' }]
	]);

	it('lists present singers in arrival order with their colors', () => {
		const { shown, overflow } = lobbyRoster(['a', 'm', 'd'], dir);
		expect(shown.map((s) => s.displayName)).toEqual(['Angelo', 'Maya', 'Devon']);
		expect(shown[0].color).toBe('#7c5cff');
		expect(overflow).toBe(0);
	});

	it('shows only who is present — an absent singer in the directory is not listed', () => {
		const { shown } = lobbyRoster(['m'], dir);
		expect(shown.map((s) => s.displayName)).toEqual(['Maya']);
	});

	it('caps the chips and reports the overflow so a 20-person party cannot flood the screen', () => {
		const many = new Map(Array.from({ length: 12 }, (_, i) => [`s${i}`, { id: `s${i}`, displayName: `P${i}`, color: '#fff' }]));
		const { shown, overflow } = lobbyRoster([...many.keys()], many, 8);
		expect(shown).toHaveLength(8);
		expect(overflow).toBe(4);
	});

	it('skips a present id we have no name for yet rather than rendering a nameless chip', () => {
		// presence can arrive before the queue:sync singer directory does
		const { shown, overflow } = lobbyRoster(['a', 'unknown-id'], dir);
		expect(shown.map((s) => s.displayName)).toEqual(['Angelo']);
		expect(overflow).toBe(0);
	});
});
