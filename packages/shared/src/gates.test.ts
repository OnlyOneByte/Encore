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

// A stems-complete song needs the status and the instrumental ref (both produced by the one stems job).
// The profile defaults to EMPTY here — the all-nulls "analysis ran, found nothing" value — so the
// fixture matches what a real cook on this code produces. Tests that probe the pre-profile-era
// boundary pass `songProfile: undefined` explicitly.
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

test('a song cooked BEFORE song profiles existed is not retroactively unsingable', () => {
	// This is the stems twin of the lyrics test below, and it was the bug: the gate used to require the
	// profile RECORD, which no pre-profile row has. Such a song went readyToSing=false (out of the
	// rotation, out of listReady) while isPlayable/isCooked stayed TRUE, so requestMakeKaraoke answered
	// "already cooked" and refused to re-cook it. Unsingable forever, with no way out, for every song
	// cooked on a previous night.
	//
	// It is safe to treat these as done because worker-hub writes the profile unconditionally beside
	// markMediaReady, so a 'ready' status with an instrumental is itself proof the analysis ran for
	// anything this code cooked.
	const noProfile = cooked({ songProfile: undefined, lyricsStatus: 'ready' });
	expect(noProfile.songProfile).toBeUndefined();
	expect(isPlayable(noProfile)).toBe(true); // the half that always worked — hence the deadlock
	expect(readyToSing(noProfile)).toBe(true);
	expect(pendingGates(noProfile)).toEqual([]);
});

test('a stems step still needs its status and ref, profile or not', () => {
	// Dropping the profile requirement must not make a half-cooked song look finished: the status and
	// the instrumental ref are still both mandatory.
	expect(readyToSing(cooked({ stemStatus: 'queued', lyricsStatus: 'ready' }))).toBe(false);
	expect(readyToSing(cooked({ instrumentalRef: undefined, lyricsStatus: 'ready' }))).toBe(false);
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
