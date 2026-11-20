import { test, expect } from 'bun:test';
import { deckEntryOf, notYetTarget, minutesLeft, buzzOnce, HEADS_UP_BUZZ } from '$lib/on-deck';
import { applyAndReseq, type QueueEntry } from '$lib/contract';

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

/** Press Not yet on `id` the way the card does, and return the queue the server commits. */
function pressNotYet(q: QueueEntry[], id: string, playable: (x: QueueEntry) => boolean = all) {
	const queue = q.map((x, i) => ({ ...x, rotationSeq: i }));
	const t = notYetTarget(queue, id, playable);
	if (!t) return null;
	const after = applyAndReseq(queue, { op: 'not-yet', id, toIdx: t.toIdx });
	return { named: t.singerId, order: after.map((x) => x.id), next: after.find(playable)?.singerId };
}

test('Not yet lets the NEXT OTHER singer go first, even with my own next pick in between', () => {
	// The bug: [maya1, maya2, theo1] became [maya2, theo1, maya1] — Maya still next, Theo never let through.
	expect(pressNotYet([e('maya1', 'maya'), e('maya2', 'maya'), e('theo1', 'theo')], 'maya1')).toEqual({
		named: 'theo',
		order: ['theo1', 'maya1', 'maya2'],
		next: 'theo'
	});
});

test('Not yet skips a song still cooking, and the singer it names is the one who sings next', () => {
	const r = pressNotYet([e('a', 'maya'), e('b', 'theo'), e('c', 'maya'), e('d', 'ana')], 'a', (x) => x.id !== 'b');
	// Theo's cooking song keeps its place; both of Maya's picks step behind Ana.
	expect(r).toEqual({ named: 'ana', order: ['b', 'd', 'a', 'c'], next: 'ana' });
});

test('the on-deck card is for my next song while SOMEONE ELSE sings — never during my own song, never idle', () => {
	const q = [e('a', 'maya'), e('b', 'theo')];
	expect(deckEntryOf(q, 'a', 'theo', 'maya')?.id).toBe('a');
	expect(deckEntryOf(q, 'a', 'maya', 'maya')).toBeUndefined();
	expect(deckEntryOf(q, 'a', undefined, 'maya')).toBeUndefined();
	expect(deckEntryOf(q, 'b', 'ana', 'maya')).toBeUndefined();
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
