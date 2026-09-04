// Lyrics were unreachable for two reasons at once — nothing ever enqueued an `align` job,
// and `job:assign` could not carry what align needs. These pin both, plus the confidence rule that
// decides whether a lyrics lookup is even attempted.
import { test, expect } from 'bun:test';
import { assignParams, followUps } from './dispatch';
import { DEFAULT_GLOBAL_SETTINGS, type Media } from '@encore/shared';

const media = (over: Partial<Media> = {}): Media => ({
	id: 'm1',
	source: 'youtube',
	sourceRef: 'vid',
	title: 'Britney Spears - Baby One More Time (Lyrics)', // the RAW title, as search stores it
	artist: '7clouds', // the UPLOADER, not the artist
	durationSec: 211,
	stemStatus: 'ready', lyricsStatus: 'ready',
	instrumentalRef: 'derived/stems/i-instrumental.flac',
	...over
});

// ── the cook pipeline ─────────────────────────────────────────────────────────
test('the cook is fetch -> stems -> align, and ends there', () => {
	// align is the LAST step of the cook, not an optional garnish: a song is not finished until its
	// words are timed.
	expect(followUps('fetch')).toEqual(['stems']);
	expect(followUps('stems')).toEqual(['align']);
});

test('score has NO enqueue path — it is not part of the cook', () => {
	// Deliberate: `score` extracts a reference pitch track for live mic comparison, and it currently
	// re-runs the whole separation to get vocals it could read off disk. Chaining it doubled every cook.
	// Nothing enqueues it until that is fixed and a decision lands on scoring after the song.
	for (const t of ['fetch', 'stems', 'align', 'score', 'stems-upgrade'] as const) {
		expect(followUps(t)).not.toContain('score');
	}
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
		...DEFAULT_GLOBAL_SETTINGS,
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

// ── the lyrics engines reach the worker ───────────────────────────────────────
test("the operator's chosen reader and timing mode ride on every align job", () => {
	// This is the whole delivery mechanism for the setting. Both were hardcoded on the worker
	// (DEFAULT_MODEL = "base" in whisperx.py, and forced alignment as the only path), and dial_home.py
	// never passed a model at all — so nothing an operator did could change the words on the TV.
	const p = assignParams('align', media(), {
		...DEFAULT_GLOBAL_SETTINGS,
		asrModel: 'medium',
		syncMode: 'lines'
	});
	expect(p.asrModel).toBe('medium');
	expect(p.syncMode).toBe('lines');
});

test('with no settings, align falls back to what the worker used when these were hardcoded', () => {
	// So a unit test, or a core that predates the setting, produces an align job that behaves exactly
	// as align always did rather than silently changing the model.
	const p = assignParams('align', media());
	expect(p.asrModel).toBe('base');
	expect(p.syncMode).toBe('forced');
});

test('the lyrics engines are for align only — a stems job carries a separator instead', () => {
	// Keeps the two axes from bleeding into each other: a separation job has no opinion about words.
	const s = { ...DEFAULT_GLOBAL_SETTINGS, asrModel: 'small' as const, syncMode: 'lines' as const };
	expect(assignParams('stems', media(), s).asrModel).toBeUndefined();
	expect(assignParams('stems', media(), s).syncMode).toBeUndefined();
	expect(assignParams('fetch', media(), s).asrModel).toBeUndefined();
});

test('unknown media and a zero duration do not produce junk params', () => {
	// The fetcher is a DECLARATION the worker needs, not junk — it is what replaced inferring
	// acquisition from the URI's shape. The lyrics engines are declarations of the same kind: an align
	// job now says which model reads the words and how they get timestamps, exactly as a stems job says
	// which separator to run. Only the LOOKUP keys must stay absent when unconfident.
	expect(assignParams('align', undefined)).toEqual({ fetcher: 'ytdlp', asrModel: 'base', syncMode: 'forced' });
	expect(assignParams('align', media({ durationSec: 0 })).durationSec).toBeUndefined();
});
