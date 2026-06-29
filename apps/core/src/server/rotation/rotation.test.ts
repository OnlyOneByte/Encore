// M1-C2 done-when: 3 singers interleave fairly; new joiner slots into next gap.
// Plus the held-slot rule (not-ready media is skipped but keeps its position).
import { test, expect } from 'bun:test';
import { reseq, nextPlayable, upNextAfter, isEntryReady } from './index';
import type { QueueEntry, Media } from '@encore/shared';

const e = (id: string, singerId: string, addedAt: number, mediaId = 'm-' + id): QueueEntry => ({
	id, mediaId, singerId, status: 'queued', rotationSeq: -1, addedAt
});
const m = (id: string, over: Partial<Media> = {}): Media => ({
	id, source: 'youtube', sourceRef: 'x', title: id, durationSec: 100,
	stemStatus: 'none', playMode: 'iframe', ...over
});

test('reseq: three singers interleave fairly', () => {
	const entries = [e('a1', 'a', 1), e('a2', 'a', 2), e('b1', 'b', 3), e('c1', 'c', 4), e('b2', 'b', 5)];
	expect(reseq(entries).map((x) => x.id)).toEqual(['a1', 'b1', 'c1', 'a2', 'b2']);
});

test('new joiner slots into the next gap', () => {
	const entries = [e('a1', 'a', 1), e('a2', 'a', 2), e('a3', 'a', 3), e('b1', 'b', 4)];
	expect(reseq(entries).map((x) => x.id)).toEqual(['a1', 'b1', 'a2', 'a3']);
});

test('nextPlayable returns the soonest ready entry', () => {
	const entries = [e('a1', 'a', 1), e('b1', 'b', 2)];
	const media = new Map([[ 'm-a1', m('m-a1') ], [ 'm-b1', m('m-b1') ]]);
	expect(nextPlayable(entries, media).next?.id).toBe('a1');
});

test('HELD SLOT: a not-ready (cooking) entry is skipped but keeps its position', () => {
	// a1 is a make-karaoke file still processing; b1 is a ready iframe.
	const entries = [e('a1', 'a', 1), e('b1', 'b', 2)];
	const media = new Map([
		['m-a1', m('m-a1', { playMode: 'file', stemStatus: 'queued' })], // cooking
		['m-b1', m('m-b1')] // ready
	]);
	const { next, held } = nextPlayable(entries, media);
	expect(next?.id).toBe('b1'); // skipped a1, played b1
	expect(held.map((x) => x.id)).toEqual(['a1']); // a1 held
	// a1 keeps rotationSeq 0 (its fair position) so it slots back when ready
	expect(reseq(entries).find((x) => x.id === 'a1')!.rotationSeq).toBe(0);

	// once a1's stems are ready, it becomes the next playable again at its held position
	media.set('m-a1', m('m-a1', { playMode: 'file', stemStatus: 'ready' }));
	expect(nextPlayable(entries, media).next?.id).toBe('a1');
});

test('isEntryReady: iframe always ready; file ready only when stems ready/none', () => {
	const media = new Map([
		['if', m('if', { playMode: 'iframe', stemStatus: 'queued' })],
		['fq', m('fq', { playMode: 'file', stemStatus: 'queued' })],
		['fr', m('fr', { playMode: 'file', stemStatus: 'ready' })]
	]);
	expect(isEntryReady(e('x', 'a', 1, 'if'), media)).toBe(true);
	expect(isEntryReady(e('x', 'a', 1, 'fq'), media)).toBe(false);
	expect(isEntryReady(e('x', 'a', 1, 'fr'), media)).toBe(true);
});

test('upNextAfter skips the current entry and returns the next ready one', () => {
	const entries = [e('a1', 'a', 1), e('b1', 'b', 2), e('a2', 'a', 3)];
	const media = new Map([
		['m-a1', m('m-a1')], ['m-b1', m('m-b1')], ['m-a2', m('m-a2')]
	]);
	// fair order a1,b1,a2 — after a1, up next is b1
	expect(upNextAfter('a1', entries, media)?.id).toBe('b1');
});
