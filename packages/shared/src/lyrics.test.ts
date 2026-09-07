// The candidate model + presentation ranking. The whole point of storing MANY lyrics sets
// per song is that text quality and timing fidelity are independent, so these pin the ranking that
// resolves them — especially the two non-obvious calls the owner made:
//   • authoritative+line OUTRANKS asr+word (correct words beat a bouncing ball over invented ones)
//   • a low-confidence CAPTION is demoted to ASR standing despite arriving as "captions"
import { test, expect } from 'bun:test';
import {
	type LyricsCandidate,
	type LyricsTextSource,
	type LyricsTiming,
	type LyricsConfidence,
	isAuthoritativeText,
	hasUsableTiming,
	lyricsRank,
	pickBestLyrics,
	mergeLyricsCandidate,
	lyricsTokens,
	agreementScore,
	isLikelyWrongSong,
	SUSPECT_AGREEMENT
} from './lyrics';

let _t = 0;
const cand = (
	textSource: LyricsTextSource,
	timing: LyricsTiming,
	over: Partial<LyricsCandidate> = {}
): LyricsCandidate => ({
	ref: `${textSource}-${timing}-${++_t}`,
	textSource,
	timing,
	textConfidence: (over.textConfidence ?? 'high') as LyricsConfidence,
	createdAt: _t,
	...over
});

// ── isAuthoritativeText ─────────────────────────────────────────────────────
test('ASR is never authoritative, no matter its confidence', () => {
	expect(isAuthoritativeText(cand('asr', 'word', { textConfidence: 'high' }))).toBe(false);
});

test('a LOW-confidence caption is demoted to non-authoritative (ASR wearing a caption hat)', () => {
	expect(isAuthoritativeText(cand('captions', 'word', { textConfidence: 'low' }))).toBe(false);
	expect(isAuthoritativeText(cand('captions', 'word', { textConfidence: 'high' }))).toBe(true);
});

test('LRCLIB and manual text are authoritative', () => {
	expect(isAuthoritativeText(cand('lrclib', 'line'))).toBe(true);
	expect(isAuthoritativeText(cand('manual', 'none'))).toBe(true);
});

// ── rank ────────────────────────────────────────────────────────────────────
test('rank orders the tiers, and none-timing is 0 (unshowable)', () => {
	expect(lyricsRank(cand('lrclib', 'word'))).toBe(5);
	expect(lyricsRank(cand('lrclib', 'line'))).toBe(4);
	expect(lyricsRank(cand('asr', 'word'))).toBe(3);
	expect(lyricsRank(cand('asr', 'line'))).toBe(2);
	expect(lyricsRank(cand('lrclib', 'none'))).toBe(0);
});

test('THE OWNER CALL: authoritative+line outranks a baseline+word', () => {
	expect(lyricsRank(cand('lrclib', 'line'))).toBeGreaterThan(lyricsRank(cand('asr', 'word')));
});

test('a text identified as ANOTHER SONG ranks below every honest guess', () => {
	// Measured against transcripts of this actual audio and found to be a different song. Demoting
	// textConfidence alone left it TIED with the baseline that convicted it, and breaksTie then
	// preferred it — it has a numeric agreement, a baseline has none. So the room kept seeing words
	// already proven wrong while the words actually heard sat unshown beside them.
	const suspect = { ...cand('lrclib', 'word'), textConfidence: 'low' as const, agreement: 0.08 };
	const baseline = cand('asr', 'word'); // a baseline is the ruler, so it carries no score
	expect(lyricsRank(suspect)).toBe(1);
	expect(lyricsRank(suspect)).toBeLessThan(lyricsRank(baseline));
	expect(pickBestLyrics([suspect, baseline])).toBe(baseline);
});

test('a suspect text is still shown when it is the only thing there', () => {
	// Rank 1, not 0. Wrong words beat a blank screen when there is no alternative, and the TV labels it.
	const suspect = { ...cand('lrclib', 'word'), textConfidence: 'low' as const, agreement: 0.05 };
	expect(pickBestLyrics([suspect])).toBe(suspect);
});

test('a high agreement does not trip the suspect tier', () => {
	const good = { ...cand('lrclib', 'word'), agreement: 0.94 };
	expect(lyricsRank(good)).toBe(5);
});

test('an UNJUDGED candidate is not treated as suspect', () => {
	// No baseline could compare it (an instrumental, or text too short). "Cannot tell" must not demote.
	expect(lyricsRank(cand('lrclib', 'word'))).toBe(5);
	expect(lyricsRank({ ...cand('lrclib', 'word'), agreement: undefined })).toBe(5);
});

// ── pickBestLyrics ────────────────────────────────────────────────────────────
test('picks the ideal when present', () => {
	const set = [cand('asr', 'word'), cand('lrclib', 'word'), cand('lrclib', 'line')];
	expect(pickBestLyrics(set)!.textSource).toBe('lrclib');
	expect(pickBestLyrics(set)!.timing).toBe('word');
});

test('LRCLIB unreachable → falls to ASR word timings (the done-when floor for this box)', () => {
	const asr = cand('asr', 'word');
	expect(pickBestLyrics([asr])).toBe(asr);
});

test('authoritative line beats ASR word even though the ball would look nicer', () => {
	const line = cand('lrclib', 'line');
	const asrWord = cand('asr', 'word');
	expect(pickBestLyrics([asrWord, line])).toBe(line);
});

test('nothing showable → null (honest "no lyrics", not a blank overlay)', () => {
	expect(pickBestLyrics([cand('lrclib', 'none'), cand('asr', 'none')])).toBeNull();
	expect(pickBestLyrics([])).toBeNull();
});

test('at equal rank, higher timing confidence wins; else newer', () => {
	const lo = cand('lrclib', 'word', { timingConfidence: 'low', createdAt: 100 });
	const hi = cand('lrclib', 'word', { timingConfidence: 'high', createdAt: 1 });
	expect(pickBestLyrics([lo, hi])).toBe(hi); // confidence beats recency
	const oldC = cand('lrclib', 'word', { timingConfidence: 'medium', createdAt: 1 });
	const newC = cand('lrclib', 'word', { timingConfidence: 'medium', createdAt: 999 });
	expect(pickBestLyrics([oldC, newC])).toBe(newC); // recency breaks a true tie
});

// ── mergeLyricsCandidate: the never-regress guarantee ─────────────────────────
test('merging a NEW candidate never worsens the pick (upgrade path)', () => {
	let set: LyricsCandidate[] = [cand('asr', 'word')];
	const bestBefore = lyricsRank(pickBestLyrics(set)!);
	set = mergeLyricsCandidate(set, cand('lrclib', 'word')); // LRCLIB arrives later
	expect(lyricsRank(pickBestLyrics(set)!)).toBeGreaterThanOrEqual(bestBefore);
	expect(pickBestLyrics(set)!.textSource).toBe('lrclib');
});

test('a later LINE-level source cannot displace existing WORD timings', () => {
	let set: LyricsCandidate[] = [cand('lrclib', 'word', { ref: 'keep' })];
	set = mergeLyricsCandidate(set, cand('lrclib', 'line')); // coarser, arrives after
	expect(pickBestLyrics(set)!.ref).toBe('keep');
	expect(set).toHaveLength(2); // both retained — nothing thrown away
});

test('re-running a job overwrites its OWN artifact rather than stacking duplicates', () => {
	let set: LyricsCandidate[] = [cand('asr', 'word', { ref: 'asr.json', createdAt: 1 })];
	set = mergeLyricsCandidate(set, cand('asr', 'word', { ref: 'asr.json', createdAt: 2 }));
	expect(set).toHaveLength(1);
	expect(set[0]!.createdAt).toBe(2);
});

// ── agreement: catching a confidently wrong lookup ────────────────────────────
test('tokenizer strips LRC stamps, markers, and punctuation', () => {
	expect(lyricsTokens('[00:12.50]Hello, world! [Chorus]')).toEqual(['hello', 'world']);
});

test('the same lyrics score ~1; a different song scores low', () => {
	// each side has >= MIN_TOKENS_TO_COMPARE (12) UNIQUE tokens after dedup
	const a = 'we could be heroes just for one day standing by the wall guns above our heads and we kissed';
	const b = 'we could be heroes just for one day standing near the wall guns above their heads and we kissed';
	expect(agreementScore(a, b)!).toBeGreaterThanOrEqual(0.75); // near-identical, a couple of word swaps
	const other = 'never gonna give you up let down run around desert cry say goodbye tell lie hurt';
	const score = agreementScore(a, other);
	expect(score).not.toBeNull();
	expect(score!).toBeLessThan(SUSPECT_AGREEMENT);
});

test('agreement is order-insensitive (a repeated or reordered chorus is not disagreement)', () => {
	const verse = 'hello darkness my old friend i have come to talk with you again because a vision';
	const shuffled = verse.split(' ').reverse().join(' ');
	expect(agreementScore(verse, shuffled)!).toBe(1); // same token SET
});

test('too-short text returns null, NOT 0 — an instrumental must not fail a correct lookup', () => {
	expect(agreementScore('la la la', 'the full authoritative lyrics of some long song here now')).toBeNull();
	expect(isLikelyWrongSong(null)).toBe(false); // unknown is never a detected mismatch
	expect(isLikelyWrongSong(undefined)).toBe(false);
});

test('isLikelyWrongSong fires only below the suspect threshold', () => {
	expect(isLikelyWrongSong(0.1)).toBe(true);
	expect(isLikelyWrongSong(0.9)).toBe(false);
});

// ── hasUsableTiming ───────────────────────────────────────────────────────────
test('hasUsableTiming is true for word/line, false for none', () => {
	expect(hasUsableTiming(cand('lrclib', 'word'))).toBe(true);
	expect(hasUsableTiming(cand('lrclib', 'line'))).toBe(true);
	expect(hasUsableTiming(cand('lrclib', 'none'))).toBe(false);
});
