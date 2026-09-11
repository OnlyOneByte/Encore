// 3 singers interleave fairly; new joiner slots into next gap.
// Plus the held-slot rule (not-ready media is skipped but keeps its position).
import { test, expect } from 'bun:test';
import { reseq, nextPlayable, upNextAfter, isEntryReady } from './index';
import type { QueueEntry, Media } from '@encore/shared';
import { EMPTY_SONG_PROFILE, applyAndReseq } from '@encore/shared';

const e = (id: string, singerId: string, addedAt: number, mediaId = 'm-' + id): QueueEntry => ({
	id,
	mediaId,
	singerId,
	status: 'queued',
	rotationSeq: -1,
	addedAt
});
const m = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'x',
	title: id,
	durationSec: 100,
	stemStatus: 'ready',
	lyricsStatus: 'ready',
	instrumentalRef: 'derived/stems/i-instrumental.flac',
	songProfile: EMPTY_SONG_PROFILE,
	...over
});

// Fairness is decided at INSERT time now (#856): the queue is a stored ordered list, and `reseq`
// only renumbers it. So these drive real adds through the shared reducer and assert the resulting
// stored list, rather than handing `reseq` a pile of entries and expecting it to sort them.
const insertAll = (adds: QueueEntry[], order: 'fair' | 'fcfs' = 'fair') =>
	adds.reduce<QueueEntry[]>((q, entry) => applyAndReseq(q, { op: 'add', entry }, { order }), []);

test('three singers interleave fairly as they are added', () => {
	const entries = [e('a1', 'a', 1), e('a2', 'a', 2), e('b1', 'b', 3), e('c1', 'c', 4), e('b2', 'b', 5)];
	expect(insertAll(entries).map((x) => x.id)).toEqual(['a1', 'b1', 'c1', 'a2', 'b2']);
});

test('new joiner slots into the next gap', () => {
	const entries = [e('a1', 'a', 1), e('a2', 'a', 2), e('a3', 'a', 3), e('b1', 'b', 4)];
	expect(insertAll(entries).map((x) => x.id)).toEqual(['a1', 'b1', 'a2', 'a3']);
});

test('reseq renumbers the stored order and does not re-sort it', () => {
	// a queue somebody rearranged: b1 stored ahead of a1. reseq must preserve that and tidy positions.
	const rearranged = [
		{ ...e('a1', 'a', 1), rotationSeq: 5 },
		{ ...e('b1', 'b', 2), rotationSeq: 2 }
	];
	expect(reseq(rearranged).map((x) => [x.id, x.rotationSeq])).toEqual([
		['b1', 0],
		['a1', 1]
	]);
});

test('nextPlayable returns the soonest ready entry', () => {
	const entries = [e('a1', 'a', 1), e('b1', 'b', 2)];
	const media = new Map([
		['m-a1', m('m-a1')],
		['m-b1', m('m-b1')]
	]);
	expect(nextPlayable(entries, media).next?.id).toBe('a1');
});

test('HELD SLOT: a not-ready (processing) entry is skipped but keeps its position', () => {
	// a1 is a process file still processing; b1 is a ready iframe.
	const entries = [e('a1', 'a', 1), e('b1', 'b', 2)];
	const media = new Map([
		['m-a1', m('m-a1', { stemStatus: 'queued' })], // processing
		['m-b1', m('m-b1')] // ready
	]);
	const { next, held } = nextPlayable(entries, media);
	expect(next?.id).toBe('b1'); // skipped a1, played b1
	expect(held.map((x) => x.id)).toEqual(['a1']); // a1 held
	// a1 keeps rotationSeq 0 (its fair position) so it slots back when ready
	expect(reseq(entries).find((x) => x.id === 'a1')!.rotationSeq).toBe(0);

	// once a1's stems are ready, it becomes the next playable again at its held position
	media.set(
		'm-a1',
		m('m-a1', { stemStatus: 'ready', lyricsStatus: 'ready', instrumentalRef: 'derived/stems/i-instrumental.flac' })
	);
	expect(nextPlayable(entries, media).next?.id).toBe('a1');
});

test('isEntryReady: ready ONLY with an instrumental — nothing plays unprocessed', () => {
	const media = new Map([
		['none', m('none', { stemStatus: 'none', instrumentalRef: undefined })],
		['queued', m('queued', { stemStatus: 'queued', instrumentalRef: undefined })],
		['skewed', m('skewed', { stemStatus: 'ready', lyricsStatus: 'ready', instrumentalRef: undefined })],
		[
			'processed',
			m('processed', { stemStatus: 'ready', lyricsStatus: 'ready', instrumentalRef: 'derived/stems/i-instrumental.flac' })
		]
	]);
	// An unseparated song is a process candidate, not something the room can sing — this is the change
	// from the embed era, where a YouTube entry was always immediately playable.
	expect(isEntryReady(e('x', 'a', 1, 'none'), media)).toBe(false);
	expect(isEntryReady(e('x', 'a', 1, 'queued'), media)).toBe(false);
	// status ahead of artifact: rotation must not hand the TV a ref that is not on disk
	expect(isEntryReady(e('x', 'a', 1, 'skewed'), media)).toBe(false);
	expect(isEntryReady(e('x', 'a', 1, 'processed'), media)).toBe(true);
});

test('upNextAfter skips the current entry and returns the next ready one', () => {
	const entries = [e('a1', 'a', 1), e('b1', 'b', 2), e('a2', 'a', 3)];
	const media = new Map([
		['m-a1', m('m-a1')],
		['m-b1', m('m-b1')],
		['m-a2', m('m-a2')]
	]);
	// fair order a1,b1,a2 — after a1, up next is b1
	expect(upNextAfter('a1', entries, media)?.id).toBe('b1');
});
