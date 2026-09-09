// #640 — the human-override resolver layered ABOVE pickBestLyrics. Pins that:
//   • an override present in the set OUTRANKS the ranker (the one thing that may show a lower rank);
//   • a stale override (ref no longer in the set) falls back to the ranking, never blanks the overlay;
//   • no override behaves exactly as pickBestLyrics did (never-regress untouched);
//   • hasNewerCandidateThanOverride is true only when the ranker prefers something OTHER than the pin.
// Each reds if the corresponding branch of resolveLyricsRef / hasNewerCandidateThanOverride is reverted.
import { test, expect } from 'bun:test';
import {
	type LyricsCandidate,
	type LyricsTextSource,
	type LyricsTiming,
	type LyricsConfidence,
	resolveLyricsRef,
	hasNewerCandidateThanOverride,
	pickBestLyrics
} from './index';

let _t = 0;
const cand = (
	textSource: LyricsTextSource,
	timing: LyricsTiming,
	over: Partial<LyricsCandidate> = {}
): LyricsCandidate => ({
	ref: over.ref ?? `${textSource}-${timing}-${++_t}`,
	textSource,
	timing,
	textConfidence: (over.textConfidence ?? 'high') as LyricsConfidence,
	createdAt: ++_t,
	...over
});

test('resolveLyricsRef: with no override it equals pickBestLyrics', () => {
	const set = [cand('asr', 'word'), cand('lrclib', 'line')];
	expect(resolveLyricsRef(set, undefined)).toBe(pickBestLyrics(set)!.ref);
});

test('resolveLyricsRef: an override present in the set OUTRANKS the ranker', () => {
	// asr+word ranks 3; lrclib+line ranks 4 and is what pickBestLyrics would choose.
	const ranked = cand('lrclib', 'line', { ref: 'ranked' });
	const pinned = cand('asr', 'word', { ref: 'pinned' });
	const set = [ranked, pinned];
	expect(pickBestLyrics(set)!.ref).toBe('ranked'); // control: the ranker prefers the other one
	expect(resolveLyricsRef(set, 'pinned')).toBe('pinned'); // the override wins — reds if the branch is dropped
});

test('resolveLyricsRef: a stale override falls back to the ranking, never null when something ranks', () => {
	const set = [cand('lrclib', 'word', { ref: 'still-here' })];
	expect(resolveLyricsRef(set, 'gone-ref')).toBe('still-here');
});

test('hasNewerCandidateThanOverride: true only when the ranker prefers something else', () => {
	const ranked = cand('lrclib', 'word', { ref: 'better' });
	const pinned = cand('asr', 'line', { ref: 'pinned' });
	const set = [ranked, pinned];
	expect(hasNewerCandidateThanOverride(set, 'pinned')).toBe(true); // ranker prefers 'better'
	expect(hasNewerCandidateThanOverride(set, 'better')).toBe(false); // ranker agrees with the pin
	expect(hasNewerCandidateThanOverride(set, undefined)).toBe(false); // no override → no hint
	expect(hasNewerCandidateThanOverride(set, 'gone')).toBe(false); // stale pin is gone, not "beaten"
});
