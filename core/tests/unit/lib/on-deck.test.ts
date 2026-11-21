import { test, expect } from 'bun:test';
import {
	deckEntryOf,
	notYetTarget,
	minutesLeft,
	buzzOnce,
	rearmBuzz,
	deckBump,
	deckStep,
	NO_DECK,
	HEADS_UP_BUZZ,
	type DeckMemo
} from '$lib/on-deck';
import { deckBumpNotice } from '$lib/phrasing/turn-phrasing';
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

test('an entry that lost On deck is re-armed: its heads-up buzzes again when its turn comes back', () => {
	const calls: number[][] = [];
	const vibrate = (p: number[]) => (calls.push(p), true);
	expect(buzzOnce('x2', vibrate)).toBe(true);
	rearmBuzz('x2');
	expect(buzzOnce('x2', vibrate)).toBe(true);
	expect(calls).toEqual([HEADS_UP_BUZZ, HEADS_UP_BUZZ]);
});

// ---- proposal 14: the bumped notice --------------------------------------------------------------------------
// Maya sings. Ana's `cook` is ahead of Theo's `theo1` and still cooking, so Theo is On deck; then it finishes.
const bumpQ = [e('cook', 'ana'), e('theo1', 'theo'), e('ana2', 'ana')];
/** A stand-in for `nextPlayableEntryId`: the first entry in `list` the room would actually play. */
const nextOf =
	(playable: (x: QueueEntry) => boolean = all) =>
	(list: QueueEntry[]) =>
		list.find(playable)?.id ?? null;
const bump = (over: Partial<Parameters<typeof deckBump>[0]> = {}) =>
	deckBump({
		wasDeckId: 'theo1',
		wasDeferred: false,
		queued: bumpQ,
		nextPlayableOf: nextOf(),
		nowSingerId: 'maya',
		meId: 'theo',
		selfCaused: false,
		...over
	});

test('a song ahead finishing being made: Theo hears who goes first, and that he is right behind', () => {
	expect(bump()).toEqual({ singerId: 'ana', youreNext: true });
});

test('not right behind: the second line is about the key instead', () => {
	const q = [e('cook', 'ana'), e('bob1', 'bob'), e('theo1', 'theo')];
	expect(bump({ queued: q })).toEqual({ singerId: 'ana', youreNext: false });
});

test('a song still cooking between us does not count: I am still the next to SING after Ana', () => {
	const q = [e('cook', 'ana'), e('bob1', 'bob'), e('theo1', 'theo')];
	expect(bump({ queued: q, nextPlayableOf: nextOf((x) => x.id !== 'bob1') })).toEqual({
		singerId: 'ana',
		youreNext: true
	});
});

test('a song the room will SKIP (failed on the TV) is never "next": both answers use the one rule passed in', () => {
	// #994's skip, stubbed: the failed song heads the queue but the rule skips it, so Bob is On deck, then me.
	const q = [e('failed', 'ana'), e('bob1', 'bob'), e('theo1', 'theo')];
	expect(bump({ queued: q, nextPlayableOf: nextOf((x) => x.id !== 'failed') })).toEqual({
		singerId: 'bob',
		youreNext: true
	});
});

test('silent when I caused it: my own Not yet or move is in flight', () => {
	expect(bump({ selfCaused: true })).toBeNull();
});

test('silent when my Not yet came from another tab: the flag flipped since last time', () => {
	const q = [e('cook', 'ana'), e('theo1', 'theo', { deferred: true }), e('ana2', 'ana')];
	expect(bump({ queued: q })).toBeNull();
	// ...but a Not yet spent long ago does not silence a real bump later.
	expect(bump({ queued: q, wasDeferred: true })).toEqual({ singerId: 'ana', youreNext: true });
});

test('silent when nothing changed, when my song started or left, and when nobody else is singing', () => {
	expect(bump({ nextPlayableOf: nextOf((x) => x.id !== 'cook') })).toBeNull(); // still On deck
	expect(bump({ queued: bumpQ.filter((x) => x.id !== 'theo1') })).toBeNull(); // it is playing now, or removed
	expect(bump({ nowSingerId: undefined })).toBeNull(); // idle room
	expect(bump({ nowSingerId: 'theo' })).toBeNull(); // my own song is on
	expect(bump({ wasDeckId: null })).toBeNull(); // I was not On deck
});

test('silent when my OTHER song is On deck now: I still go next', () => {
	const q = [e('theo0', 'theo'), e('theo1', 'theo')];
	expect(bump({ queued: q })).toBeNull();
});

test('the bumped notice names who goes first, never who moved it', () => {
	expect(deckBumpNotice('Ana', true)).toBe('Ana’s going first. You’re next.');
	expect(deckBumpNotice('Ana', false)).toBe('Ana’s going first. Your key is saved.');
});

// ---- deckStep: one room update, as the layout applies it ---------------------------------------------------------
/** Theo's phone, Maya singing: one update of `queued`, where `cook` counts as next only once `cookReady`. */
const step = (memo: DeckMemo, queued: QueueEntry[], cookReady: boolean, pendingIds: string[] = []) =>
	deckStep(memo, {
		queued,
		nextPlayableOf: nextOf((x) => cookReady || x.id !== 'cook'),
		nowSingerId: 'maya',
		meId: 'theo',
		selfCaused: false,
		pendingIds: new Set(pendingIds)
	});

test('a Not yet spent long ago is REMEMBERED, so the real bump that follows still speaks', () => {
	// Theo spent Not yet on theo1 in an earlier round; it is On deck again while Ana's song cooks ahead of it.
	const q = [e('cook', 'ana'), e('theo1', 'theo', { deferred: true }), e('ana2', 'ana')];
	const first = step(NO_DECK, q, false);
	expect(first.memo).toEqual({ id: 'theo1', deferred: true });
	expect(step(first.memo, q, true).bump).toEqual({ singerId: 'ana', youreNext: true });
});

test('the update that loses On deck re-arms that entry`s buzz, once', () => {
	const first = step(NO_DECK, bumpQ, false);
	const lost = step(first.memo, bumpQ, true);
	expect(lost.rearm).toBe('theo1');
	expect(step(lost.memo, bumpQ, true).rearm).toBeNull();
});

test('my own add the phone predicts On deck is not remembered, so the server placing it elsewhere is no bump', () => {
	const predicted = [e('cook', 'ana'), e('theo-new', 'theo'), e('ana2', 'ana')];
	const first = step(NO_DECK, predicted, false, ['theo-new']);
	expect(first.memo).toEqual(NO_DECK);
	// The server clamped it behind Ana's song, which is now ready.
	const committed = [e('cook', 'ana'), e('ana2', 'ana'), e('theo-new', 'theo')];
	expect(step(first.memo, committed, true).bump).toBeNull();
});

test('a cross-singer move-to-index keeps the moved entry`s key and guide (what the repro saw survive)', () => {
	const q = [e('theo1', 'theo', { keyShift: -1, guideLevel: 0.3 }), e('ana1', 'ana'), e('ana2', 'ana')].map((x, i) => ({
		...x,
		rotationSeq: i
	}));
	const after = applyAndReseq(q, { op: 'move-to-index', id: 'ana2', toIdx: 0 });
	expect(after.find((x) => x.id === 'theo1')).toMatchObject({ keyShift: -1, guideLevel: 0.3 });
});
