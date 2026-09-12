// The gate table is the pipeline's definition of "finished", so these pin the parts that are easy to
// get wrong when a future step is added.
import { test, expect } from 'bun:test';
import {
	GATES,
	readyToSing,
	pendingGates,
	isCooking,
	isPlayable,
	EMPTY_SONG_PROFILE,
	type Media
} from '@encore/shared';

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

test('pendingGates being empty is exactly readyToSing', () => {
	for (const song of [m(), cooked(), cooked({ lyricsStatus: 'ready' }), cooked({ lyricsRef: 'x' })]) {
		expect(pendingGates(song).length === 0).toBe(readyToSing(song));
	}
});

test('every gate has a distinct id', () => {
	// The id names the job type that satisfies the gate; two gates sharing one would make a job
	// ambiguous about which step it completes.
	expect(new Set(GATES.map((g) => g.id)).size).toBe(GATES.length);
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

// guard: gates.ts holds ONE cook vocabulary, and it is not this one — the dead guest-facing labels
// removed with `pendingLabel` do not come back.
//
// THE DEFECT. gates.ts carried a SECOND guest-facing cook vocabulary: a `pendingLabel` field
// on CookGate ('Separating vocals' / 'Timing lyrics') read only by `currentGateLabel`, which itself
// had zero non-test callers. The phone's real cook sub-line is apps/core/src/lib/cook-phrasing.ts
// (wired to SongRow, ProcessingCard, TvLobby and tv/+page.svelte) — its header asserts it is "the ONE
// place the cook is described to a guest … there is no third vocabulary to drift into", and names
// 'Separating vocals', the exact string that was stranded in gates.ts, as copy "written for the
// developer, not the guest at a party". So this was dead, drift-prone duplicate copy.
//
// THE TRIGGER is not runtime — it is the next developer adding a cook step, which gates.ts:1-14
// explicitly invites ("adding a step means adding one entry to GATES; nothing else moves"). That
// author would fill in pendingLabel per its docstring, see it asserted by the old value-blind test,
// and ship guest-facing copy that renders nowhere.
//
// WHY A SOURCE SCAN: deleting dead code has no runtime-observable regression — re-adding a field
// nothing reads leaves the suite green, so a per-hunk mutation proof reports UNVERIFIED and cannot
// pin it. The absence of the second vocabulary is a decidable property of the source, so this guard
// encodes it. Matches the repo's source-scan-guard precedent (session-cookie-attributes.test.ts /
// telemetry-frame-lean.test.ts, both + stripComments).
import { read } from '@encore/test-support';

// Blank comments before scanning so a mention in a comment (this file explains the removed symbols)
// cannot make a "must be gone" check pass or fail spuriously. Blank rather than delete so offsets line
// up. Matches the repo's stripComments convention.
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// SIBLING READ, now named explicitly. This guard used to live in packages/shared/src/queue/, so
// `at('packages/shared/src/queue/gates.ts')` meant "the gate table next to me" — note the comment that used to
// sit here claimed `at('packages/shared/src/queue') === packages/shared/src`, which was already stale by one level.
// Confirmed present at this path before re-anchoring.
const GATES_SRC = stripComments(read('packages/shared/src/queue/gates.ts'));

test('gates.ts source was read (guard is not vacuous)', () => {
	// A sentinel that must be present regardless of this fix, so an empty/misread file cannot make the
	// absence checks below pass vacuously.
	expect(GATES_SRC).toMatch(/export const GATES/);
	expect(GATES_SRC).toMatch(/export function readyToSing/);
});

test('gates.ts no longer carries the dead second cook vocabulary', () => {
	// The phone's cook copy lives ONLY in apps/core/src/lib/cook-phrasing.ts. gates.ts must not
	// re-declare a guest-facing label field or the caller-less function that read it.
	expect(GATES_SRC).not.toMatch(/pendingLabel/);
	expect(GATES_SRC).not.toMatch(/currentGateLabel/);
});

test('the live half of the gate table survives — this is a scoped deletion, not a gutting', () => {
	// CookGate.stage is read at apps/core/src/server/jobs/media-status.ts; done/required drive
	// readyToSing/pendingGates/isCooking. Those must stay, so the guard cannot be satisfied by
	// deleting the whole table.
	expect(GATES_SRC).toMatch(/readonly stage: MediaStage/);
	expect(GATES_SRC).toMatch(/readonly done:/);
	expect(GATES_SRC).toMatch(/readonly required: boolean/);
	expect(GATES_SRC).toMatch(/export function pendingGates/);
	expect(GATES_SRC).toMatch(/export function isCooking/);
});
