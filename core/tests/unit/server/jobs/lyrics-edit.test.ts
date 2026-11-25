// The host's lyrics fixes as data (docs/SERVER.md#lyrics-fixes): new words re-time under a new ref, Undo puts
// back the stored state, and Back to automatic leaves the host's words for real.
import { test, expect } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { JobRepository } from '$lib/server/jobs/repository';
import { AuthoritativeState } from '$lib/server/state/store';
import { assignParams } from '$lib/server/jobs/dispatch';
import { editLyricsRef } from '$lib/server/jobs/process';
import {
	parseEditLines,
	pushHistory,
	requestLyricsAuto,
	requestLyricsEdit,
	requestLyricsUndo,
	requestLyricsOffset,
	LYRICS_HISTORY_MAX,
	type LyricsEditResult
} from '$lib/server/jobs/lyrics-edit';
import { forgetEvicted } from '$lib/server/media/retention';
import type { LyricsCandidate, Media } from '$lib/contract';

const T0 = 1_700_000_000_000;
const AUTO = 'derived/lyrics/m1-lrclib-word.json';

const media = (over: Partial<Media> = {}): Media => ({
	id: 'm1',
	source: 'youtube',
	sourceRef: 'vid',
	title: 'song',
	durationSec: 200,
	stemStatus: 'ready',
	instrumentalRef: 'derived/stems/m1-instrumental.flac',
	vocalsRef: 'derived/stems/m1-vocals.flac',
	lyricsStatus: 'ready',
	lyricsRef: AUTO,
	lyricsCandidates: [
		{ ref: AUTO, textSource: 'lrclib', timing: 'word', textConfidence: 'high', createdAt: 1 }
	] as LyricsCandidate[],
	...over
});

function deps(m: Media) {
	let t = T0;
	return {
		jobs: new JobRepository(migratedDb()),
		mediaById: new Map([[m.id, m]]),
		state: new AuthoritativeState(),
		now: () => (t += 1000)
	};
}

function ok(r: LyricsEditResult | string): LyricsEditResult {
	if (typeof r === 'string') throw new Error(r);
	return r;
}

/** What the worker's completion does for a pinned job: the new document joins the set under the pinned ref. */
function published(m: Media) {
	const ref = m.lyricsOverrideRef!;
	m.lyricsCandidates = [
		...(m.lyricsCandidates ?? []),
		{ ref, textSource: 'manual', timing: 'word', textConfidence: 'high', createdAt: 9 }
	];
	m.lyricsRef = ref;
}

test('new words pin a new ref per change and re-time from exactly those words', () => {
	const m = media();
	const d = deps(m);
	const first = ok(requestLyricsEdit('m1', { rev: 0, lines: ['no escape', 'from reality'] }, d, 's1'));
	expect(first.rev).toBe(1);
	expect(first.job?.jobType).toBe('align');
	expect(first.replaced).toMatchObject({ rev: 0 });
	expect(assignParams('align', m)).toMatchObject({
		pinnedRef: editLyricsRef('m1', 1),
		pinnedText: 'no escape\nfrom reality'
	});
	published(m);

	const second = ok(requestLyricsEdit('m1', { rev: 1, lines: ['no escape', 'from reality!'] }, d, 's1'));
	expect(m.lyricsOverrideRef).toBe(editLyricsRef('m1', 2));
	expect(second.job).toBeDefined();
	// Until the re-time lands, the TV keeps the words it has.
	expect(m.lyricsRef).toBe(editLyricsRef('m1', 1));
});

test('the same words again change nothing and start no worker', () => {
	const m = media();
	const d = deps(m);
	ok(requestLyricsEdit('m1', { rev: 0, lines: ['same words'] }, d));
	expect(ok(requestLyricsEdit('m1', { rev: 1, lines: ['same words'] }, d))).toEqual({ rev: 1 });
});

test('a stale rev, an unknown song and new words without a vocals stem are refused and change nothing', () => {
	const m = media();
	const d = deps(m);
	expect(requestLyricsEdit('m1', { rev: 4, lines: ['x'] }, d)).toBe('stale');
	expect(requestLyricsEdit('nope', { rev: 0, lines: ['x'] }, d)).toBe('unknown-media');
	const raw = media({ id: 'raw', vocalsRef: undefined });
	d.mediaById.set('raw', raw);
	expect(requestLyricsEdit('raw', { rev: 0, lines: ['x'] }, d)).toBe('not-processed');
	expect(m.lyricsEditRev).toBeUndefined();
	expect(raw.lyricsEditRev).toBeUndefined();
});

test('Undo puts the previous words back at once when their document is still stored', () => {
	const m = media();
	const d = deps(m);
	const a = ok(requestLyricsEdit('m1', { rev: 0, lines: ['first fix'] }, d));
	published(m);
	const b = ok(requestLyricsEdit('m1', { rev: 1, lines: ['second fix'] }, d));
	published(m);
	const firstRef = editLyricsRef('m1', 1);

	const undo = ok(requestLyricsUndo('m1', 2, b.replaced, d));
	expect(undo.job).toBeUndefined(); // no worker: the rev-1 document is still there
	expect(m).toMatchObject({ lyricsEditRev: 3, lyricsRef: firstRef, lyricsOverrideRef: firstRef });
	expect(m.lyricsOverrideText).toBe('first fix');

	// And once more, back to the automatic words.
	ok(requestLyricsUndo('m1', 3, a.replaced, d));
	expect(m.lyricsOverrideRef).toBeUndefined();
	expect(m.lyricsRef).toBe(AUTO);
	expect(requestLyricsUndo('m1', 4, undefined, d)).toBe('nothing-to-undo');
});

test('Undo to words whose document was evicted times them again', () => {
	const m = media();
	const d = deps(m);
	ok(requestLyricsEdit('m1', { rev: 0, lines: ['kept words'] }, d));
	published(m);
	const b = ok(requestLyricsEdit('m1', { rev: 1, lines: ['other words'] }, d));
	m.lyricsCandidates = [];
	const undo = ok(requestLyricsUndo('m1', 2, b.replaced, d));
	expect(undo.job?.jobType).toBe('align');
	expect(assignParams('align', m)).toMatchObject({ pinnedRef: editLyricsRef('m1', 1), pinnedText: 'kept words' });
});

test("the host's nudge outlives a fix, an Undo, Back to automatic and an eviction", () => {
	const m = media();
	const d = deps(m);
	expect(requestLyricsOffset('m1', -250, d)).toBe(-250);
	const a = ok(requestLyricsEdit('m1', { rev: 0, lines: ['new words'] }, d));
	published(m);
	ok(requestLyricsUndo('m1', 1, a.replaced, d));
	ok(requestLyricsAuto('m1', 2, d));
	forgetEvicted(m, d.jobs);
	expect(m.lyricsOffsetMs).toBe(-250);
});

test('Back to automatic drops the words and pick, and never shows an old fix', () => {
	const m = media();
	const d = deps(m);
	ok(requestLyricsEdit('m1', { rev: 0, lines: ['my words'] }, d));
	published(m); // the fix is now the newest, best-ranked document in the set
	const auto = ok(requestLyricsAuto('m1', 1, d));
	expect(auto.job).toBeUndefined();
	expect(auto.replaced).toMatchObject({ ref: editLyricsRef('m1', 1), text: 'my words' });
	expect(m.lyricsRef).toBe(AUTO);
	expect(assignParams('align', m).pinnedRef).toBeUndefined();
});

test('the body is checked: line count and length, control characters and blank input', () => {
	expect(parseEditLines([{ text: ' a\tb ' }, { text: '' }, { text: 'c' }])).toEqual(['a b', 'c']);
	expect(parseEditLines([{ text: '  ' }])).toBe('no-text');
	expect(parseEditLines('a\nb')).toBe('bad-lines');
	expect(parseEditLines([{ text: 'x'.repeat(301) }])).toBe('bad-lines');
	expect(parseEditLines(Array.from({ length: 401 }, () => ({ text: 'x' })))).toBe('bad-lines');
	expect(parseEditLines(['bare string'])).toBe('bad-lines');
	expect(parseEditLines(undefined)).toBe('bad-lines');
});

test('history keeps the newest states up to the cap', () => {
	let h = pushHistory(undefined, { rev: 0, at: 0 });
	for (let rev = 1; rev <= LYRICS_HISTORY_MAX + 5; rev++) h = pushHistory(h, { rev, at: rev });
	expect(h).toHaveLength(LYRICS_HISTORY_MAX);
	expect(h.at(-1)!.rev).toBe(LYRICS_HISTORY_MAX + 5);
});
