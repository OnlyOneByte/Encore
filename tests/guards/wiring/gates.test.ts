// The gate table is the pipeline's definition of "finished", so these pin the parts that are easy to
// get wrong when a future step is added.
import { test, expect } from 'bun:test';
import { GATES, readyToSing, pendingGates, isProcessing } from '$lib/contract/queue/gates';
import { isPlayable, type Media } from '$lib/contract/core/types';
import { EMPTY_SONG_PROFILE } from '$lib/contract/process/song-profile';

const m = (over: Partial<Media> = {}): Media => ({
	id: 'm1',
	source: 'youtube',
	sourceRef: 'vid',
	title: 'Take On Me',
	durationSec: 200,
	stemStatus: 'none',
	...over
});

// The profile defaults to EMPTY — the all-nulls "analysis ran, found nothing" value — so the fixture
// matches what a real process produces. Pre-profile-era tests pass `songProfile: undefined` explicitly.
const processed = (over: Partial<Media> = {}): Media =>
	m({
		stemStatus: 'ready',
		instrumentalRef: 'derived/stems/m1-instrumental.flac',
		songProfile: { ...EMPTY_SONG_PROFILE },
		...over
	});

test('a song is ready to sing only when EVERY required gate is done', () => {
	expect(readyToSing(m())).toBe(false); // nothing done
	expect(readyToSing(processed())).toBe(false); // separated, lyrics never ran
	expect(readyToSing(processed({ lyricsStatus: 'ready' }))).toBe(true);
});

test('separation needs the artifact, not just the status', () => {
	// Status and ref are written by separate steps; a status alone hands the player an empty source.
	expect(readyToSing(m({ stemStatus: 'ready', lyricsStatus: 'ready' }))).toBe(false);
});

test('a song processed BEFORE song profiles existed is not retroactively unsingable', () => {
	// Caught: requiring the profile RECORD deadlocked every pre-profile row — readyToSing went false
	// while isPlayable/isProcessed stayed TRUE, so requestProcess answered "already processed" and
	// refused to re-process it. Safe to treat as done because worker-hub writes the profile beside
	// markMediaReady, so a 'ready' status with an instrumental is itself proof the analysis ran.
	const noProfile = processed({ songProfile: undefined, lyricsStatus: 'ready' });
	expect(noProfile.songProfile).toBeUndefined();
	expect(isPlayable(noProfile)).toBe(true); // the half that always worked — hence the deadlock
	expect(readyToSing(noProfile)).toBe(true);
	expect(pendingGates(noProfile)).toEqual([]);
});

test('a stems step still needs its status and ref, profile or not', () => {
	// Dropping the profile requirement must not make a half-processed song look finished.
	expect(readyToSing(processed({ stemStatus: 'queued', lyricsStatus: 'ready' }))).toBe(false);
	expect(readyToSing(processed({ instrumentalRef: undefined, lyricsStatus: 'ready' }))).toBe(false);
});

test('an ALL-NULLS profile still finishes the stems gate — the silent-vocal trap', () => {
	// A silent vocal stem yields an all-null profile. The gate keys on PRESENCE, not data: requiring
	// key/range data would leave the song unsingable forever AND never re-process it, because the
	// re-process check reads hasInstrumental rather than the gate.
	const emptyProfile = processed({ songProfile: { ...EMPTY_SONG_PROFILE }, lyricsStatus: 'ready' });
	expect(emptyProfile.songProfile).toEqual(EMPTY_SONG_PROFILE);
	expect(readyToSing(emptyProfile)).toBe(true);
});

test('alignment is done when it RAN — an instrumental with no words is still finished', () => {
	// Requiring a lyricsRef would make a genuine instrumental never singable: align correctly finds no
	// text, so there is nothing to time.
	const instrumental = processed({ lyricsStatus: 'ready' }); // no lyricsRef at all
	expect(instrumental.lyricsRef).toBeUndefined();
	expect(readyToSing(instrumental)).toBe(true);
});

test('a song processed BEFORE the lyrics gate existed is not retroactively unsingable', () => {
	// Upgrade safety: media predating lyricsStatus carry no such field, and treating absent as "not
	// done" would empty an existing library on deploy.
	expect(readyToSing(processed({ lyricsRef: 'derived/lyrics/m1-asr-word.json' }))).toBe(true);
});

test('readyToSing and isPlayable are DIFFERENT questions', () => {
	// `processState` uses the file-level check to decide whether the work is already done, so folding
	// lyrics into it would re-process every song that lacks them from scratch.
	const separatedNoLyrics = processed();
	expect(isPlayable(separatedNoLyrics)).toBe(true); // the file exists and loads
	expect(readyToSing(separatedNoLyrics)).toBe(false); // but the song is not finished
});

test('pendingGates reports what is outstanding, in pipeline order', () => {
	expect(pendingGates(m()).map((g) => g.id)).toEqual(['stems', 'lyrics']);
	expect(pendingGates(processed()).map((g) => g.id)).toEqual(['lyrics']);
	expect(pendingGates(processed({ lyricsStatus: 'ready' }))).toEqual([]);
});

test('pendingGates being empty is exactly readyToSing', () => {
	for (const song of [m(), processed(), processed({ lyricsStatus: 'ready' }), processed({ lyricsRef: 'x' })]) {
		expect(pendingGates(song).length === 0).toBe(readyToSing(song));
	}
});

test('every gate has a distinct id', () => {
	// The id names the job type that satisfies the gate; a shared id makes a job ambiguous about which
	// step it completes.
	expect(new Set(GATES.map((g) => g.id)).size).toBe(GATES.length);
});

test('isProcessing is gate-driven — it catches a song sitting between two gates', () => {
	expect(isProcessing(m())).toBe(false); // nothing acquired, nothing queued
	expect(isProcessing(m({ stemStatus: 'queued' }))).toBe(true);
	// Caught: stems done + lyrics queued. A hardcoded `stemStatus === 'queued'` check reports this song
	// as not processing; the gate-driven form keeps it processing because a later gate is pending.
	expect(isProcessing(processed({ lyricsStatus: 'queued' }))).toBe(true);
	expect(isProcessing(processed())).toBe(true); // separated is mid-process, not unacquired
	expect(isProcessing(processed({ lyricsStatus: 'ready' }))).toBe(false);
});

// gates.ts must not hold a SECOND guest-facing process vocabulary. Caught: a `pendingLabel` field on
// ProcessGate read only by `currentGateLabel`, which had zero non-test callers, duplicating the one real
// vocabulary in src/lib/phrasing/process-phrasing.ts. The trigger is the next author adding a step —
// gates.ts invites exactly that — filling in pendingLabel and shipping copy that renders nowhere.
import { readFileSync } from 'node:fs';
import { at } from '@encore/test-support';
import { stripComments } from '@encore/test-support/scan';

/** Blank comments in place, so this file's own mention of the removed symbols cannot skew a scan. */
const GATES_SRC = stripComments(readFileSync(at('src/lib/contract/queue/gates.ts'), 'utf8'));

test('gates.ts source was read (guard is not vacuous)', () => {
	// An empty or misread file would make every absence check below pass vacuously.
	expect(GATES_SRC).toMatch(/export const GATES/);
	expect(GATES_SRC).toMatch(/export function readyToSing/);
});

test('gates.ts no longer carries the dead second process vocabulary', () => {
	expect(GATES_SRC).not.toMatch(/pendingLabel/);
	expect(GATES_SRC).not.toMatch(/currentGateLabel/);
});

test('the live half of the gate table survives — this is a scoped deletion, not a gutting', () => {
	// Sentinel: `stage` is read by src/lib/server/jobs/media-status.ts and done/required drive the three
	// predicates, so the absence checks above cannot be satisfied by deleting the whole table.
	expect(GATES_SRC).toMatch(/readonly stage: MediaStage/);
	expect(GATES_SRC).toMatch(/readonly done:/);
	expect(GATES_SRC).toMatch(/readonly required: boolean/);
	expect(GATES_SRC).toMatch(/export function pendingGates/);
	expect(GATES_SRC).toMatch(/export function isProcessing/);
});
