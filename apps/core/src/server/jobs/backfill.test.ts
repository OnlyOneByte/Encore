// The upgrade path's entry point. Measured on the live library before this existed: 13 cooked
// songs, 3 with lyrics — 10 that could never get them, because only a stems COMPLETION enqueues align
// and nobody re-cooks a working song.
import { test, expect } from 'bun:test';
import type { LyricsCandidate, Media } from '@encore/shared';
import { needsLyricsBackfill, BACKFILL_PRIORITY } from './backfill';

let n = 0;
const media = (over: Partial<Media> = {}): Media => ({
	id: `m${++n}`,
	source: 'youtube',
	sourceRef: `v${n}`,
	title: `song ${n}`,
	durationSec: 200,
	stemStatus: 'ready', lyricsStatus: 'ready',
	instrumentalRef: 'derived/stems/i-instrumental.flac',
	...over
});
const cand = (timing: LyricsCandidate['timing'], source: LyricsCandidate['textSource'] = 'asr'): LyricsCandidate => ({
	ref: `derived/lyrics/x-${source}-${timing}.json`,
	textSource: source,
	timing,
	textConfidence: source === 'asr' ? 'low' : 'high',
	createdAt: 1
});

test('a cooked song with NO lyrics needs a backfill', () => {
	const m = media();
	expect(needsLyricsBackfill([m])).toEqual([m.id]);
});

test('a song already at WORD timings is skipped — re-aligning could not rank higher', () => {
	expect(needsLyricsBackfill([media({ lyricsCandidates: [cand('word')] })])).toEqual([]);
});

test('a song stuck at LINE timings IS re-aligned (line is the floor, word is the goal)', () => {
	const m = media({ lyricsCandidates: [cand('line', 'lrclib')] });
	expect(needsLyricsBackfill([m])).toEqual([m.id]);
});

test('an UNCOOKED song is skipped — ASR needs the vocals stem, which does not exist yet', () => {
	expect(needsLyricsBackfill([media({ stemStatus: 'none' })])).toEqual([]);
	expect(needsLyricsBackfill([media({ stemStatus: 'queued' })])).toEqual([]);
});

test('a pre-candidate artifact (bare lyricsRef, schema-1) is left alone', () => {
	// it may well already be word-timed; re-aligning would spend an ML pass to learn that
	expect(needsLyricsBackfill([media({ lyricsRef: 'derived/lyrics/m1.json' })])).toEqual([]);
});

test('candidates with no usable timing do not count as having lyrics', () => {
	const m = media({ lyricsCandidates: [cand('none')] });
	expect(needsLyricsBackfill([m])).toEqual([m.id]);
});

test('the backfill never outranks a live cook', () => {
	// job priority mirrors rotationSeq (lower = sooner), so dead last is the largest value
	expect(BACKFILL_PRIORITY).toBe(Number.MAX_SAFE_INTEGER);
});

test('mixed catalog: only the ones that need it, and it is idempotent', () => {
	const needs = media();
	const done = media({ lyricsCandidates: [cand('word')] });
	const raw = media({ stemStatus: 'none' });
	const list = [needs, done, raw];
	expect(needsLyricsBackfill(list)).toEqual([needs.id]);
	expect(needsLyricsBackfill(list)).toEqual([needs.id]); // pure — same answer every boot
});
