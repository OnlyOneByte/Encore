// The gate table is the pipeline's definition of "finished", so these pin the parts that are easy to
// get wrong when a future step is added.
import { test, expect } from 'bun:test';
import { GATES, readyToSing, pendingGates, currentGateLabel, isCooking } from './gates';
import { isPlayable, type Media } from './types';
import { EMPTY_SONG_PROFILE } from './song-profile';

const m = (over: Partial<Media> = {}): Media => ({
	id: 'm1',
	source: 'youtube',
	sourceRef: 'vid',
	title: 'Take On Me',
	durationSec: 200,
	stemStatus: 'none',
	...over
});

// A stems-complete song now needs THREE things: status, the instrumental ref, AND a song profile
// (all produced by the one stems job). The profile defaults to EMPTY here — the all-nulls "analysis
// ran, found nothing" value — because the stems gate keys on the profile's PRESENCE, not its data, so
// an empty profile is a fully cooked stems step. Tests that probe the missing-profile boundary pass
// `songProfile: undefined` explicitly.
const cooked = (over: Partial<Media> = {}): Media =>
	m({
		stemStatus: 'ready',
		instrumentalRef: 'derived/stems/m1-instrumental.flac',
		songProfile: { ...EMPTY_SONG_PROFILE },
		...over
	});

test('a song is ready to sing only when EVERY required gate is done', () => {
	expect(readyToSing(m())).toBe(false); // nothing done
	expect(readyToSing(cooked())).toBe(false); // separated, lyrics never ran
	expect(readyToSing(cooked({ lyricsStatus: 'ready' }))).toBe(true);
});

test('separation needs the artifact, not just the status', () => {
	// The status and the ref are written by separate steps; a status alone would hand the player an
	// empty source.
	expect(readyToSing(m({ stemStatus: 'ready', lyricsStatus: 'ready' }))).toBe(false);
});

test('separation also needs the song profile RECORD — the third stems artifact', () => {
	// The stems job produces the instrumental, the vocals, AND the key/range profile. A song with the
	// status and ref but no profile has a stems step that has not finished, so it is not ready to sing.
	const noProfile = cooked({ songProfile: undefined, lyricsStatus: 'ready' });
	expect(noProfile.songProfile).toBeUndefined();
	expect(readyToSing(noProfile)).toBe(false);
	expect(pendingGates(noProfile).map((g) => g.id)).toEqual(['stems']);
});

test('an ALL-NULLS profile still finishes the stems gate — the silent-vocal trap', () => {
	// A silent vocal stem yields a profile with every field null. The gate keys on the profile's
	// PRESENCE, not its data, so this song is FINISHED — the alternative (requiring key/range data)
	// would leave it unsingable forever AND never re-cook it, because the re-cook check reads
	// hasInstrumental, not the gate.
	const emptyProfile = cooked({ songProfile: { ...EMPTY_SONG_PROFILE }, lyricsStatus: 'ready' });
	expect(emptyProfile.songProfile).toEqual(EMPTY_SONG_PROFILE);
	expect(readyToSing(emptyProfile)).toBe(true);
});

test('alignment is done when it RAN — an instrumental with no words is still finished', () => {
	// The trap this prevents: if the lyrics gate required a lyricsRef, a genuine instrumental could
	// never become singable, because align correctly finds no text and there is nothing to time.
	const instrumental = cooked({ lyricsStatus: 'ready' }); // no lyricsRef at all
	expect(instrumental.lyricsRef).toBeUndefined();
	expect(readyToSing(instrumental)).toBe(true);
});

test('a song cooked BEFORE the lyrics gate existed is not retroactively unsingable', () => {
	// Upgrade safety: media predating lyricsStatus carry no such field. Treating absent as "not done"
	// would empty an existing library the moment this shipped.
	expect(readyToSing(cooked({ lyricsRef: 'derived/lyrics/m1-asr-word.json' }))).toBe(true);
});

test('readyToSing and isPlayable are DIFFERENT questions', () => {
	// Kept apart deliberately: `cookState` uses the file-level check to decide whether the work is
	// already done, so folding lyrics into it would re-cook every song that lacks them from scratch.
	const separatedNoLyrics = cooked();
	expect(isPlayable(separatedNoLyrics)).toBe(true); // the file exists and loads
	expect(readyToSing(separatedNoLyrics)).toBe(false); // but the song is not finished
});

test('pendingGates reports what is outstanding, in pipeline order', () => {
	expect(pendingGates(m()).map((g) => g.id)).toEqual(['stems', 'lyrics']);
	expect(pendingGates(cooked()).map((g) => g.id)).toEqual(['lyrics']);
	expect(pendingGates(cooked({ lyricsStatus: 'ready' }))).toEqual([]);
});

test('the phone names the FIRST outstanding step, never a later one', () => {
	// Reporting "Timing lyrics" while separation is still running would name a step that has not begun.
	expect(currentGateLabel(m())).toBe('Separating vocals');
	expect(currentGateLabel(cooked())).toBe('Timing lyrics');
	expect(currentGateLabel(cooked({ lyricsStatus: 'ready' }))).toBeNull();
});

test('pendingGates being empty is exactly readyToSing', () => {
	for (const song of [m(), cooked(), cooked({ lyricsStatus: 'ready' }), cooked({ lyricsRef: 'x' })]) {
		expect(pendingGates(song).length === 0).toBe(readyToSing(song));
	}
});

test('every gate has a distinct id and a pending label', () => {
	// A future step added without a label would render an empty status line on the phone.
	expect(new Set(GATES.map((g) => g.id)).size).toBe(GATES.length);
	for (const g of GATES) expect(g.pendingLabel.length).toBeGreaterThan(0);
});

test('isCooking is gate-driven — it catches a song sitting between two gates', () => {
	// Not started: nothing acquired, no step queued → not cooking (it is unacquired).
	expect(isCooking(m())).toBe(false);
	// Stems actively queued → cooking.
	expect(isCooking(m({ stemStatus: 'queued' }))).toBe(true);
	// THE BUG: stems done, lyrics queued — a later gate is pending, but an earlier gate is done, so
	// the gate-driven check keeps it cooking instead of a hardcoded stemStatus==='queued' missing it.
	expect(isCooking(cooked({ lyricsStatus: 'queued' }))).toBe(true);
	// Even with lyrics simply not started, a separated song is still mid-cook, not unacquired.
	expect(isCooking(cooked())).toBe(true);
	// Finished → not cooking.
	expect(isCooking(cooked({ lyricsStatus: 'ready' }))).toBe(false);
});
