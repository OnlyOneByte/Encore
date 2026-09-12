// Applying a MusicBrainz annotation to a media — and refusing to make it worse.
//
// Two invariants live here. First, only SEPARATION publishes an instrumental: `markMediaReady` derives
// the artifact key when the worker reports none, so calling it for a `fetch` completion marked the media
// `ready` with a key for a file that did not exist yet, and the TV would load a 404. That was invisible
// end to end because `stems` follows a `fetch` within seconds and overwrote the bogus state before
// anyone tried to sing.
//
// Second, a citation must never be downgraded. `high` carries an MBID corroborated by duration; `medium`
// is a plausible guess. A re-fetch or a backfill that let a `medium` overwrite a `high` would quietly
// turn a known-good artist back into a guess — and that field is what the LRCLIB query matches on.
import { test, expect } from 'bun:test';
import { applyAnnotation } from '$lib/server/jobs/process';
import { publishesInstrumental } from '$lib/server/jobs/dispatch';
import type { Media } from '$lib/contract';

const media = (over: Partial<Media> = {}): Media => ({
	id: 'm1',
	source: 'youtube',
	sourceRef: 'vid',
	title: 'a-ha - Take On Me (Official Video)',
	artist: 'ahaVEVO', // the UPLOADER — exactly what annotation exists to improve on
	durationSec: 225,
	stemStatus: 'none',
	...over
});
const catalog = (m: Media) => new Map([[m.id, m]]);

const HIGH = { source: 'musicbrainz', mbid: 'mb-1', artist: 'a-ha', title: 'Take On Me', confidence: 'high' };
const MEDIUM = { ...HIGH, mbid: 'mb-2', confidence: 'medium' };

test('only separation publishes an instrumental — a fetch must not', () => {
	expect(publishesInstrumental('stems')).toBe(true);
	expect(publishesInstrumental('stems-upgrade')).toBe(true);
	// REGRESSION: a fetch completion used to run markMediaReady, which derives the instrumental key
	// when none is reported — marking the media ready for a file that does not exist.
	expect(publishesInstrumental('fetch')).toBe(false);
	expect(publishesInstrumental('align')).toBe(false);
});

test('a high annotation replaces the uploader string with a cited artist and title', () => {
	const m = media();
	expect(applyAnnotation('m1', catalog(m), HIGH)).toBe(true);
	expect(m.artistCanonical).toBe('a-ha');
	expect(m.titleCanonical).toBe('Take On Me');
	expect(m.mbid).toBe('mb-1');
	expect(m.annotation).toEqual({ source: 'musicbrainz', confidence: 'high' });
	// the raw provenance is untouched — `artist` stays what the source reported
	expect(m.artist).toBe('ahaVEVO');
});

test('a medium annotation applies over a normalizer guess', () => {
	const m = media({ artistCanonical: 'guessed', annotation: { source: 'normalizer', confidence: 'medium' } });
	expect(applyAnnotation('m1', catalog(m), MEDIUM)).toBe(true);
	expect(m.artistCanonical).toBe('a-ha');
	expect(m.annotation?.source).toBe('musicbrainz');
});

test('THE INVARIANT: a medium annotation cannot downgrade an existing high citation', () => {
	const m = media();
	applyAnnotation('m1', catalog(m), HIGH);
	expect(applyAnnotation('m1', catalog(m), MEDIUM)).toBe(false);
	expect(m.mbid).toBe('mb-1'); // unchanged
	expect(m.annotation?.confidence).toBe('high');
});

test('a high annotation may replace another high one (a re-identification is allowed)', () => {
	const m = media();
	applyAnnotation('m1', catalog(m), HIGH);
	expect(applyAnnotation('m1', catalog(m), { ...HIGH, mbid: 'mb-better' })).toBe(true);
	expect(m.mbid).toBe('mb-better');
});

test('a declined annotation changes nothing — the normalizer keeps its values', () => {
	const m = media({ artistCanonical: 'guessed', titleCanonical: 'Guessed Title' });
	expect(applyAnnotation('m1', catalog(m), undefined)).toBe(false);
	expect(applyAnnotation('m1', catalog(m), {})).toBe(false);
	// a partial payload is not half-applied: an mbid with no names is not an identification
	expect(applyAnnotation('m1', catalog(m), { mbid: 'x', confidence: 'high' })).toBe(false);
	expect(m.artistCanonical).toBe('guessed');
	expect(m.mbid).toBeUndefined();
});

test('an unknown media is a no-op rather than a throw', () => {
	expect(applyAnnotation('nope', catalog(media()), HIGH)).toBe(false);
});

test('an unrecognised confidence is treated as medium, never as high', () => {
	// Defence in depth: the worker sends this string, and a typo must not be able to mint a citation
	// that outranks a real one.
	const m = media();
	applyAnnotation('m1', catalog(m), { ...HIGH, confidence: 'VERY high' });
	expect(m.annotation?.confidence).toBe('medium');
});

// YouTube's OWN declared credit is a citation, applied through the same path. It carries NO
// MBID (YouTube mints none), and the never-regress rule protects it exactly like a MusicBrainz one.
const YT = { source: 'youtube', artist: 'a-ha', title: 'Take On Me', confidence: 'high' };

test('a YouTube citation applies WITHOUT an mbid and records source "youtube"', () => {
	const m = media();
	expect(applyAnnotation('m1', catalog(m), YT)).toBe(true);
	expect(m.artistCanonical).toBe('a-ha');
	expect(m.titleCanonical).toBe('Take On Me');
	expect(m.annotation).toEqual({ source: 'youtube', confidence: 'high' });
	expect(m.mbid).toBeUndefined(); // YouTube does not mint one
	expect(m.artist).toBe('ahaVEVO'); // raw provenance untouched
});

test('a MusicBrainz match UPGRADES a YouTube citation (it adds an MBID)', () => {
	const m = media();
	applyAnnotation('m1', catalog(m), YT);
	expect(applyAnnotation('m1', catalog(m), HIGH)).toBe(true); // high beats high — re-identification
	expect(m.annotation?.source).toBe('musicbrainz');
	expect(m.mbid).toBe('mb-1');
});

test('THE INVARIANT holds across sources: a medium cannot downgrade a high YouTube citation', () => {
	const m = media();
	applyAnnotation('m1', catalog(m), YT); // high youtube
	expect(applyAnnotation('m1', catalog(m), MEDIUM)).toBe(false); // medium musicbrainz refused
	expect(m.annotation).toEqual({ source: 'youtube', confidence: 'high' });
});

test('a YouTube payload missing a field is not half-applied', () => {
	const m = media({ artistCanonical: 'guessed' });
	expect(applyAnnotation('m1', catalog(m), { source: 'youtube', artist: 'a-ha', confidence: 'high' })).toBe(false);
	expect(m.artistCanonical).toBe('guessed');
});

test('an unknown annotation source writes nothing', () => {
	const m = media({ artistCanonical: 'guessed' });
	expect(
		applyAnnotation('m1', catalog(m), { source: 'normalizer', artist: 'a-ha', title: 'Take On Me' })
	).toBe(false);
	expect(m.artistCanonical).toBe('guessed');
});
