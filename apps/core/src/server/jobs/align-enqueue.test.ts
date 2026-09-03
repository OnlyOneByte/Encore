// Lyrics were unreachable for two reasons at once — nothing ever enqueued an `align` job,
// and `job:assign` could not carry what align needs. These pin both, plus the confidence rule that
// decides whether a lyrics lookup is even attempted.
import { test, expect } from 'bun:test';
import { assignParams, followUps } from './dispatch';
import type { Media } from '@encore/shared';

const media = (over: Partial<Media> = {}): Media => ({
	id: 'm1',
	source: 'youtube',
	sourceRef: 'vid',
	title: 'Britney Spears - Baby One More Time (Lyrics)', // the RAW title, as search stores it
	artist: '7clouds', // the UPLOADER, not the artist
	durationSec: 211,
	stemStatus: 'ready',
	instrumentalRef: 'derived/stems/i-instrumental.flac',
	...over
});

// ── the cook pipeline ─────────────────────────────────────────────────────────
test('a completed stems job enqueues align AND score (both were unreachable)', () => {
	// score was blocked by the identical bug: nothing ever enqueued it, so live scoring could not fire.
	expect(followUps('stems')).toEqual(['align', 'score']);
});

test('align does not chain further — no infinite pipeline', () => {
	expect(followUps('align')).toEqual([]);
	expect(followUps('score')).toEqual([]);
});

// ── params derivation ─────────────────────────────────────────────────────────
test('stems still gets its separation model', () => {
	expect(assignParams('stems', media()).model).toBe('htdemucs');
});

test('stems carries the room engine+model; upgrade carries the upgrade engine+model', () => {
	const settings = {
		defaultEngine: 'demucs' as const,
		defaultModel: 'htdemucs_ft',
		enqueueUpgrade: true,
		upgradeEngine: 'roformer' as const,
		upgradeModel: 'bs-roformer-1297'
	};
	const stems = assignParams('stems', media(), settings);
	expect(stems.engine).toBe('demucs');
	expect(stems.model).toBe('htdemucs_ft');
	const upgrade = assignParams('stems-upgrade', media(), settings);
	expect(upgrade.engine).toBe('roformer');
	expect(upgrade.model).toBe('bs-roformer-1297');
});

test('with no settings, stems falls back to the shared default pairing', () => {
	const p = assignParams('stems', media());
	expect(p.engine).toBe('demucs');
	expect(p.model).toBe('htdemucs');
});

test('THE BUG: align now carries canonical artist + track, not the uploader and raw title', () => {
	const p = assignParams('align', media({ artistCanonical: 'Britney Spears', titleCanonical: 'Baby One More Time' }));
	expect(p.artist).toBe('Britney Spears');
	expect(p.track).toBe('Baby One More Time');
	// NOT the values that made 4 of 5 library songs miss on metadata alone
	expect(p.artist).not.toBe('7clouds');
	expect(p.track).not.toContain('(Lyrics)');
});

test('durationSec rides along to narrow the match', () => {
	expect(assignParams('align', media({ artistCanonical: 'a', titleCanonical: 'b' })).durationSec).toBe(211);
});

test('a low-confidence parse OMITS the field rather than sending a guess', () => {
	// artistCanonical/titleCanonical are undefined when the normalizer was not confident. Omitting is
	// how the worker learns "no authoritative lookup is possible" and goes straight to transcription.
	const p = assignParams('align', media());
	expect(p.artist).toBeUndefined();
	expect(p.track).toBeUndefined();
	expect(p.durationSec).toBe(211); // duration is always safe to send
});

test('a confident artist with an unconfident title still omits only the title', () => {
	const p = assignParams('align', media({ artistCanonical: 'Britney Spears' }));
	expect(p.artist).toBe('Britney Spears');
	expect(p.track).toBeUndefined();
});

test('unknown media and a zero duration do not produce junk params', () => {
	expect(assignParams('align', undefined)).toEqual({});
	expect(assignParams('align', media({ durationSec: 0 })).durationSec).toBeUndefined();
});
