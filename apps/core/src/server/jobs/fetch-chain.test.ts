// The acquisition CHAIN: a process starts by getting the bytes, then separates them.
//
// Kept separate from the separator-routing tests because the failure it guards against is different:
// enqueueing `stems` directly would dispatch a separation before its input existed, and a `fetch`
// that chained to nothing would leave every song stuck with audio on disk and no instrumental.
import { test, expect } from 'bun:test';
import { followUps, requiredCapability, assignParams } from './dispatch';
import { DEFAULT_GLOBAL_SETTINGS, type GlobalSettings, type Media } from '@encore/shared';

const settings = (o: Partial<GlobalSettings> = {}): GlobalSettings => ({ ...DEFAULT_GLOBAL_SETTINGS, ...o });
const media = (over: Partial<Media> = {}): Media => ({
	id: 'm1',
	source: 'youtube',
	sourceRef: 'vid',
	title: 'Take On Me',
	durationSec: 225,
	stemStatus: 'none',
	...over
});

test('fetch chains to stems — acquisition is never a dead end', () => {
	expect(followUps('fetch', settings())).toEqual(['stems']);
});

test('fetch does NOT chain align/score directly — those need the vocals stem', () => {
	// align reads the isolated vocals, which only exists after separation. Chaining it off
	// fetch would race the separation that produces its input.
	const next = followUps('fetch', settings());
	expect(next).not.toContain('align');
});

test('fetch routes on the DOWNLOADER capability, not on stems', () => {
	// This is what lets a box that can pull audio and a box that can separate it be different
	// machines: neither capability implies the other.
	expect(requiredCapability('fetch', settings())).toBe('fetch:ytdlp');
	expect(requiredCapability('stems', settings())).toBe('stems');
	expect(requiredCapability('fetch', settings())).not.toBe(requiredCapability('stems', settings()));
});

test('fetch capability falls back sanely with no settings at all (older callers, unit tests)', () => {
	expect(requiredCapability('fetch')).toBe('fetch:ytdlp');
});

test('every job that touches source audio declares HOW to obtain it', () => {
	// The worker parses this at its boundary instead of testing the URI for an http prefix.
	for (const jobType of ['fetch', 'stems', 'stems-upgrade', 'align'] as const) {
		expect(assignParams(jobType, media(), settings()).fetcher).toBe('ytdlp');
	}
});

test('a LOCAL media declares `local`, so the worker reads a path instead of downloading', () => {
	const local = media({ source: 'local', sourceRef: 'library/x.mp4' });
	expect(assignParams('stems', local, settings()).fetcher).toBe('local');
	// and it is `local` even though the deployment's downloader is yt-dlp — the bytes are already here
	expect(assignParams('fetch', local, settings({ defaultFetcher: 'ytdlp' })).fetcher).toBe('local');
});

test('a fetch job carries no separator params — it produces nothing singable', () => {
	const p = assignParams('fetch', media(), settings());
	expect(p.engine).toBeUndefined();
	expect(p.model).toBeUndefined();
});

test('a fetch carries the LOOKUP KEYS too — annotation runs as its final step', () => {
	// The worker cannot search MusicBrainz without them, and an absent key is the signal to decline
	// rather than search on a guess. Same confidence gate as an align job's LRCLIB lookup.
	const p = assignParams('fetch', media({ artistCanonical: 'a-ha', titleCanonical: 'Take On Me' }), settings());
	expect(p.artist).toBe('a-ha');
	expect(p.track).toBe('Take On Me');
	expect(p.durationSec).toBe(225);
});

test('an unconfident parse sends NO lookup keys to ALIGN, so the worker declines instead of guessing', () => {
	const p = assignParams('align', media(), settings()); // no canonicals set
	expect(p.artist).toBeUndefined();
	expect(p.track).toBeUndefined();
	expect(p.fetcher).toBe('ytdlp'); // the fetcher is still declared — that is not a lookup key
});

test('a fetch DOES send the unconfident guess — MusicBrainz is the gate, not the parser', () => {
	// The regression this fixes, verbatim from the live library. `cleanTitleNoise` strips the trailing
	// "| Worlds 2017 - League of Legends" tag, which leaves a title with no separator in it, so the
	// parser falls back to the uploader and marks itself `low` — and `resultToMedia` then stores no
	// canonicals. Under the old shared gate that meant no keys, no MusicBrainz call, and a TV rendering
	// the entire upload string. The uploader IS the credited artist here, and MusicBrainz confirms the
	// pair exactly.
	const yt = media({
		title: 'Legends Never Die (ft. Against The Current) [OFFICIAL AUDIO] | Worlds 2017 - League of Legends',
		artist: 'League of Legends',
		durationSec: 179
	});
	const p = assignParams('fetch', yt, settings());
	expect(p.artist).toBe('League of Legends');
	// The guest credit is lifted OUT of the song name: MusicBrainz calls the recording "Legends Never
	// Die" and returns zero results for the title with "(ft. …)" still in it.
	expect(p.track).toBe('Legends Never Die');
	expect(p.durationSec).toBe(179);
	// No `artistCredit`: only the align step reads it (to rank lyrics records), and the annotate step
	// takes artist/track/durationSec alone. MusicBrainz returns the full billing itself.
	expect(p.artistCredit).toBeUndefined();
	// ...and align still refuses to guess for the same media: LRCLIB would answer with its nearest
	// record rather than declining, and that is another song's words.
	expect(assignParams('align', yt, settings()).artist).toBeUndefined();
});

test('a fetch does NOT guess from an aggregator uploader — "7clouds" is not an artist', () => {
	// The parser returns `unparsed` for a lyrics channel with no separator to split on, so there is
	// nothing to send. Asking MusicBrainz about a channel name is a wasted paced request.
	const p = assignParams('fetch', media({ title: 'Wake Me Up', artist: '7clouds' }), settings());
	expect(p.artist).toBeUndefined();
	expect(p.track).toBeUndefined();
});

test('a fetch sends no track without an artist — the worker needs both or it declines', () => {
	const p = assignParams('fetch', media(), settings()); // 'Take On Me', no uploader → unparsed
	expect(p.artist).toBeUndefined();
	expect(p.track).toBeUndefined();
});

test('a CONFIDENT canonical is never overwritten by the guess', () => {
	const p = assignParams(
		'fetch',
		media({
			title: 'a-ha - Take On Me (Official Video)',
			artist: 'SomeChannel',
			artistCanonical: 'a-ha',
			titleCanonical: 'Take On Me'
		}),
		settings()
	);
	expect(p.artist).toBe('a-ha');
	expect(p.track).toBe('Take On Me');
});
