// An align job reports EVERY artifact it produced; the core stores the set and re-picks the
// chosen one. The property that matters is that storage can never regress — a coarser source arriving
// later must not displace existing word timings, which a "last write wins" ref would have done.
import { test, expect } from 'bun:test';
import type { LyricsCandidate, Media } from '$lib/contract';
import { chosenCandidate } from '$lib/contract';
import { setMediaLyrics } from '$lib/server/jobs/process';

// toRelativeKey strips the REAL MEDIA_DIR, so the absolute paths a worker reports only relativize
// against the configured root (see paths.ts). Pin it, as the other media tests do.
process.env.MEDIA_DIR = '/srv/encore/media';
import { sidecarFromMedia, mediaFromSidecar, chosenLyricsRef, SIDECAR_SCHEMA } from '$lib/server/media/sidecar';

const media = (over: Partial<Media> = {}): Media => ({
	id: 'm1',
	source: 'youtube',
	sourceRef: 'vid',
	title: 'Toto - Africa (Lyrics)',
	artist: 'Vibe Music',
	durationSec: 295,
	stemStatus: 'ready',
	lyricsStatus: 'ready',
	instrumentalRef: 'derived/stems/i-instrumental.flac',
	...over
});

const cand = (source: string, timing: string, over: Partial<LyricsCandidate> = {}): LyricsCandidate => ({
	ref: `derived/lyrics/m1-${source}.json`,
	textSource: source as LyricsCandidate['textSource'],
	timing: timing as LyricsCandidate['timing'],
	textConfidence: source === 'asr' ? 'low' : 'high',
	createdAt: 1,
	...over
});

function withMedia(m: Media) {
	return new Map<string, Media>([[m.id, m]]);
}

test('candidates are stored and lyricsRef points at the best one', () => {
	const m = media();
	const by = withMedia(m);
	expect(setMediaLyrics('m1', undefined, by, [cand('asr', 'word'), cand('lrclib', 'word')])).toBe(true);
	expect(m.lyricsCandidates).toHaveLength(2);
	expect(m.lyricsRef).toBe('derived/lyrics/m1-lrclib.json'); // authoritative wins
});

test('THE REGRESSION GUARD: a later line-level source does not displace existing word timings', () => {
	const m = media();
	const by = withMedia(m);
	setMediaLyrics('m1', undefined, by, [cand('lrclib', 'word')]);
	const wordRef = m.lyricsRef;
	// a second align run later yields only a coarse caption tier
	setMediaLyrics('m1', undefined, by, [cand('captions', 'line', { createdAt: 999 })]);
	expect(m.lyricsRef).toBe(wordRef); // unchanged
	expect(m.lyricsCandidates).toHaveLength(2); // but the new one is retained for later
});

test('worker-reported ABSOLUTE paths are normalized to media-relative refs', () => {
	const m = media();
	const by = withMedia(m);
	setMediaLyrics('m1', undefined, by, [cand('asr', 'word', { ref: '/srv/encore/media/derived/lyrics/m1-asr.json' })]);
	expect(m.lyricsRef).toBe('derived/lyrics/m1-asr.json'); // safeMediaPath rejects a leading slash
});

test('a set with nothing showable does not clear a working lyricsRef', () => {
	const m = media({ lyricsRef: 'derived/lyrics/m1-good.json' });
	const by = withMedia(m);
	setMediaLyrics('m1', undefined, by, [cand('lrclib', 'none')]);
	expect(m.lyricsRef).toBe('derived/lyrics/m1-good.json');
});

test('an older worker sending only `uri` still works (legacy uri-only path)', () => {
	const m = media();
	const by = withMedia(m);
	expect(setMediaLyrics('m1', '/srv/encore/media/derived/lyrics/m1.json', by)).toBe(true);
	expect(m.lyricsRef).toBe('derived/lyrics/m1.json');
	expect(m.lyricsCandidates).toBeUndefined();
});

// ── sidecar round-trip ────────────────────────────────────────────────────────
test('candidates survive a sidecar round-trip and the chosen ref is RE-PICKED', () => {
	const m = media();
	setMediaLyrics('m1', undefined, withMedia(m), [cand('asr', 'word'), cand('lrclib', 'word')]);
	const s = sidecarFromMedia(m, 1000);
	expect(s.schema).toBe(SIDECAR_SCHEMA);
	expect(s.artifacts.lyricsCandidates).toHaveLength(2);

	const back = mediaFromSidecar(s);
	expect(back.lyricsCandidates).toHaveLength(2);
	expect(back.lyricsRef).toBe('derived/lyrics/m1-lrclib.json');
	expect(chosenCandidate(back)?.textSource).toBe('lrclib'); // provenance is derivable for the TV
});

test('re-picking corrects a stored pointer that disagrees with the ranking', () => {
	const s = sidecarFromMedia(media(), 1);
	s.artifacts.lyrics = 'derived/lyrics/m1-asr.json'; // as if an older worker chose badly
	s.artifacts.lyricsCandidates = [cand('asr', 'word'), cand('lrclib', 'word')];
	expect(chosenLyricsRef(s)).toBe('derived/lyrics/m1-lrclib.json');
});

test('a SCHEMA-1 record (no candidates) still resolves, with provenance unknown', () => {
	const s = sidecarFromMedia(media(), 1);
	s.artifacts.lyrics = 'derived/lyrics/m1.json';
	s.artifacts.lyricsCandidates = undefined;
	expect(chosenLyricsRef(s)).toBe('derived/lyrics/m1.json');
	const back = mediaFromSidecar(s);
	expect(chosenCandidate(back)).toBeNull(); // honest: we do not know where that text came from
});

test('a sidecar rewrite from an index-only Media does not lose the candidate set', () => {
	// hydrate-from-DB gives a Media whose candidates were not read; the rewrite must keep the prior set
	const prior = sidecarFromMedia(media(), 1);
	prior.artifacts.lyricsCandidates = [cand('lrclib', 'word')];
	const indexOnly = media({ lyricsCandidates: undefined, lyricsRef: 'derived/lyrics/m1-lrclib.json' });
	const rewritten = sidecarFromMedia(indexOnly, 2000, prior);
	expect(rewritten.artifacts.lyricsCandidates).toHaveLength(1);
});

// ──: a human override outranks the ranker, everywhere the chosen candidate is resolved ──

test('setMediaLyrics HONORS a human override over pickBestLyrics on a later align completion', () => {
	// The song already has a pinned override on the ASR candidate; a re-time completes reporting both.
	// Without the pin, pickBestLyrics would move lyricsRef to lrclib (rank 5). The pin must hold.
	const m = media({ lyricsOverrideRef: 'derived/lyrics/m1-asr.json' });
	const by = withMedia(m);
	expect(setMediaLyrics('m1', undefined, by, [cand('asr', 'word'), cand('lrclib', 'word')])).toBe(true);
	expect(m.lyricsRef).toBe('derived/lyrics/m1-asr.json'); // the pin wins — reds if setMediaLyrics reverts to pickBestLyrics
});

test('chosenLyricsRef HONORS a human override on a sidecar restore', () => {
	const s = sidecarFromMedia(media(), SIDECAR_SCHEMA);
	s.artifacts.lyricsCandidates = [cand('asr', 'word'), cand('lrclib', 'word')];
	s.artifacts.lyricsOverrideRef = 'derived/lyrics/m1-asr.json';
	// Ranking alone would pick lrclib; the override wins on restore.
	expect(chosenLyricsRef(s)).toBe('derived/lyrics/m1-asr.json');
});

test('a STALE override (ref no longer stored) falls back to the ranking, never blanks the overlay', () => {
	const s = sidecarFromMedia(media(), SIDECAR_SCHEMA);
	s.artifacts.lyricsCandidates = [cand('lrclib', 'word')];
	s.artifacts.lyricsOverrideRef = 'derived/lyrics/m1-gone.json';
	expect(chosenLyricsRef(s)).toBe('derived/lyrics/m1-lrclib.json');
});

test('the override round-trips through the sidecar and back onto runtime Media', () => {
	const m = media({ lyricsOverrideRef: 'derived/lyrics/m1-asr.json' });
	m.lyricsCandidates = [cand('asr', 'word'), cand('lrclib', 'word')];
	const s = sidecarFromMedia(m, SIDECAR_SCHEMA);
	expect(s.artifacts.lyricsOverrideRef).toBe('derived/lyrics/m1-asr.json');
	const back = mediaFromSidecar(s);
	expect(back.lyricsOverrideRef).toBe('derived/lyrics/m1-asr.json');
	expect(back.lyricsRef).toBe('derived/lyrics/m1-asr.json'); // resolved via the honored override
});

test('the sidecar schema is bumped to 5 for the additive override field', () => {
	expect(SIDECAR_SCHEMA).toBeGreaterThanOrEqual(5);
});

