import { test, expect } from 'bun:test';
import { notYetTarget, minutesLeft, buzzOnce, HEADS_UP_BUZZ } from '$lib/on-deck';
import type { QueueEntry } from '$lib/contract';

const e = (id: string, singerId: string, over: Partial<QueueEntry> = {}): QueueEntry => ({
	id,
	mediaId: `m-${id}`,
	singerId,
	status: 'queued',
	rotationSeq: 0,
	addedAt: 0,
	...over
});
const all = () => true;

test('Not yet steps behind the next singer, landing right after them', () => {
	const q = [e('a', 'maya'), e('b', 'theo'), e('c', 'ana')];
	expect(notYetTarget(q, 'a', all)).toEqual({ toIdx: 1, singerId: 'theo' });
});

test('Not yet skips a song still cooking, and my own next pick', () => {
	const q = [e('a', 'maya'), e('b', 'theo'), e('c', 'maya'), e('d', 'ana')];
	expect(notYetTarget(q, 'a', (x) => x.id !== 'b')).toEqual({ toIdx: 3, singerId: 'ana' });
});

test('Not yet hides when nobody is behind, and once it is spent', () => {
	expect(notYetTarget([e('a', 'maya')], 'a', all)).toBeNull();
	expect(notYetTarget([e('a', 'maya', { deferred: true }), e('b', 'theo')], 'a', all)).toBeNull();
});

test('minutesLeft', () => {
	expect(minutesLeft(null)).toBeNull();
	expect(minutesLeft(40)).toBe('under a minute');
	expect(minutesLeft(130)).toBe('~2 min');
});

test('the heads-up buzzes once per entry, and not at all without vibrate', () => {
	const calls: number[][] = [];
	const vibrate = (p: number[]) => (calls.push(p), true);
	expect(buzzOnce('x1', undefined)).toBe(false);
	expect(buzzOnce('x1', vibrate)).toBe(true);
	expect(buzzOnce('x1', vibrate)).toBe(false);
	expect(calls).toEqual([HEADS_UP_BUZZ]);
});
