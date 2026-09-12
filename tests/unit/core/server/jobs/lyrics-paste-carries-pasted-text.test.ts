// A PASTED lyrics re-pick must reach the worker. The endpoint answered 200, the media was pinned to a
// `manual` ref, an align job was enqueued — and the words the guest typed were never stored anywhere, so
// `dispatch.assignParams` had nothing to put behind `pinnedText`. The worker's pinned path reads
// `pinnedText` (see worker/tests/test_lyrics_pinned_reselect_640.py, arm 1) and, given a ref that names a
// file no one has written yet, STOPs with "carry no readable text" — the guest watches the wrong words
// scroll after being told it worked.
//
// WHY THE STORE IS `Media`, NOT THE JOB. `jobs` has no params column: a job row carries type/status/
// priority only, and every parameter the worker sees is DERIVED at dispatch time by `assignParams(jobType,
// media, settings)` from the MEDIA. So the text has to live on the media beside `lyricsOverrideRef`, which
// is exactly what the ref half already does. Anything narrower (a field on the in-memory Job, a Map in
// process.ts) is lost by a restart between enqueue and dispatch — the reaper requeues the job, dispatch
// re-derives params from the media, and the paste is gone again. That is the same silent-discard defect
// with a smaller window, so the persistence arms below are part of the fix and not a nicety.
//
// The four properties, one arm each (plus the two durability arms):
//   1. a paste reaches the worker params as `pinnedText`;
//   2. a `ref` pick sends `pinnedRef` and NO `pinnedText` — including after an earlier paste, which is
//      the arm that catches a stale paste being re-timed under a newly picked ref;
//   3. a whitespace-only paste is refused (`no-text`) and enqueues nothing;
//   4. the pin survives a restart — through the SQLite index, and through the sidecar that index is
//      rebuildable from.
import { test, expect } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { requestLyricsReselect, manualLyricsRef, type ProcessDeps } from '$lib/server/jobs/process';
import { assignParams } from '$lib/server/jobs/dispatch';
import { JobRepository } from '$lib/server/jobs/repository';
import { MediaRepository } from '$lib/server/media/repository';
import { sidecarFromMedia, mediaFromSidecar } from '$lib/server/media/sidecar';
import { AuthoritativeState } from '$lib/server/state/store';
import type { LyricsCandidate, Media } from '$lib/contract';

const T0 = 1_700_000_000_000;
const PASTED = 'hello darkness my old friend\nive come to talk with you again';
const STORED = 'derived/lyrics/m1-lrclib.json';

const media = (over: Partial<Media> = {}): Media => ({
	id: 'm1',
	source: 'youtube',
	sourceRef: 'vid',
	title: 'song',
	durationSec: 200,
	stemStatus: 'ready',
	instrumentalRef: 'derived/stems/m1-instrumental.flac',
	vocalsRef: 'derived/stems/m1-vocals.flac',
	lyricsStatus: 'ready',
	lyricsRef: 'derived/lyrics/m1-asr.json',
	lyricsCandidates: [
		{ ref: 'derived/lyrics/m1-asr.json', textSource: 'asr', timing: 'word', textConfidence: 'low', createdAt: 1 },
		{ ref: STORED, textSource: 'lrclib', timing: 'word', textConfidence: 'high', createdAt: 2 }
	] as LyricsCandidate[],
	...over
});

function deps(): ProcessDeps & { mediaById: Map<string, Media>; jobs: JobRepository } {
	return {
		jobs: new JobRepository(migratedDb()),
		mediaById: new Map(),
		state: new AuthoritativeState(),
		now: () => T0
	};
}

test('a paste carries the words through to the worker params as pinnedText', () => {
	const d = deps();
	const m = media();
	d.mediaById.set('m1', m);

	const res = requestLyricsReselect('m1', { text: `  ${PASTED}  ` }, d, 's1');
	if (typeof res === 'string') throw new Error(res);

	// The ref half, unchanged — and it must be the key the WORKER computes for the (manual, word) tier,
	// `candidate_key(mediaId, 'manual', 'word')`. The worker test pins the same literal from its side.
	expect(res.ref).toBe(manualLyricsRef('m1'));
	expect(manualLyricsRef('m1')).toBe('derived/lyrics/m1-manual-word.json');

	// The text half — stored on the media, trimmed, so dispatch has something to send.
	expect(m.lyricsOverrideText).toBe(PASTED);

	// What the worker actually receives. RED before the fix: `pinnedText` is undefined, so the worker
	// gets a ref with no content behind it.
	const params = assignParams('align', d.mediaById.get('m1'));
	expect(params.pinnedRef).toBe(manualLyricsRef('m1'));
	expect(params.pinnedText).toBe(PASTED);
});

test('a ref pick sends pinnedRef and NO pinnedText, even after an earlier paste', () => {
	const d = deps();
	const m = media();
	d.mediaById.set('m1', m);

	// A guest pastes words, then changes their mind and picks a stored candidate instead.
	expect(typeof requestLyricsReselect('m1', { text: PASTED }, d, 's1')).not.toBe('string');
	const res = requestLyricsReselect('m1', { ref: STORED }, d, 's1');
	if (typeof res === 'string') throw new Error(res);

	expect(res.ref).toBe(STORED);
	// The paste must be CLEARED with the pin it belonged to. Left behind, `pinnedText` would outrank
	// `pinnedRef` in the worker's pinned path and re-time the abandoned paste under the newly picked
	// candidate's key — overwriting a good provider candidate with words the guest walked away from.
	expect(m.lyricsOverrideText).toBeUndefined();

	const params = assignParams('align', d.mediaById.get('m1'));
	expect(params.pinnedRef).toBe(STORED);
	expect(params.pinnedText).toBeUndefined();

	// And an ordinary process (no override at all) still sends neither — the unchanged path.
	const plain = assignParams('align', media());
	expect(plain.pinnedRef).toBeUndefined();
	expect(plain.pinnedText).toBeUndefined();
});

test('a whitespace-only paste is refused with no-text and enqueues nothing', () => {
	const d = deps();
	const m = media();
	d.mediaById.set('m1', m);

	// The endpoint refuses this shape too, but the refusal has to hold HERE as well: this is where the
	// enqueue and the pin happen, and a paste of blanks must not become a `manual` pin over a song's
	// working lyrics. Before the fix this fell through to the ref branch and answered `unknown-candidate`,
	// which is a different (and misleading) reason for the same nothing.
	expect(requestLyricsReselect('m1', { text: '   \n\t  ' }, d, 's1')).toBe('no-text');

	expect(d.jobs.findLive('m1', 'align')).toBeNull(); // no job — nothing was enqueued
	expect(m.lyricsOverrideRef).toBeUndefined(); // no pin
	expect(m.lyricsOverrideText).toBeUndefined();
	expect(m.lyricsStatus).toBe('ready'); // the lyrics gate was not reopened behind a refusal
});

test('the pinned paste survives a restart through the SQLite index', () => {
	const db = migratedDb();
	const d = deps();
	const m = media();
	d.mediaById.set('m1', m);
	const res = requestLyricsReselect('m1', { text: PASTED }, d, 's1');
	if (typeof res === 'string') throw new Error(res);

	// What the endpoint does after a successful re-select: persist the media it just changed.
	new MediaRepository(db).upsert(m);

	// A restart: a brand-new repository over the same file, as boot's hydrate does.
	const restored = new MediaRepository(db).byId('m1')!;
	expect(restored.lyricsOverrideRef).toBe(manualLyricsRef('m1'));
	expect(restored.lyricsOverrideText).toBe(PASTED);
	// The dispatcher re-derives params from the RESTORED media, so the requeued align still carries the
	// paste. RED before the fix: nothing durable held the text, so a restart between enqueue and dispatch
	// silently dropped it.
	expect(assignParams('align', restored).pinnedText).toBe(PASTED);

	// A later ref pick, persisted, clears the column rather than leaving the stale paste in the row.
	const r2 = new MediaRepository(db);
	expect(typeof requestLyricsReselect('m1', { ref: STORED }, d, 's1')).not.toBe('string');
	r2.upsert(m);
	expect(r2.byId('m1')!.lyricsOverrideText).toBeUndefined();
});

test('the pinned paste survives a DB wipe through the sidecar', () => {
	const d = deps();
	const m = media();
	d.mediaById.set('m1', m);
	if (typeof requestLyricsReselect('m1', { text: PASTED }, d, 's1') === 'string') throw new Error('refused');

	const s = sidecarFromMedia(m, T0);
	expect(s.artifacts.lyricsOverrideText).toBe(PASTED);
	const back = mediaFromSidecar(s);
	expect(back.lyricsOverrideRef).toBe(manualLyricsRef('m1'));
	expect(back.lyricsOverrideText).toBe(PASTED);
	expect(assignParams('align', back).pinnedText).toBe(PASTED);
});

test('a sidecar rewrite after a ref pick does not resurrect the abandoned paste', () => {
	const d = deps();
	const m = media();
	d.mediaById.set('m1', m);
	if (typeof requestLyricsReselect('m1', { text: PASTED }, d, 's1') === 'string') throw new Error('refused');
	const pasteWrite = sidecarFromMedia(m, T0); // the sidecar written while the paste was pinned

	// The guest switches to a stored candidate; the next sidecar write carries the new pin.
	if (typeof requestLyricsReselect('m1', { ref: STORED }, d, 's1') === 'string') throw new Error('refused');
	const refWrite = sidecarFromMedia(m, T0 + 1000, pasteWrite);

	// The pasted words belong TO the ref they were pinned under, so the pair moves together: a prev-write
	// fallback that kept the text alone would restore a media whose `pinnedRef` names the lrclib candidate
	// and whose `pinnedText` is the abandoned paste — the worker would then re-time the paste over it.
	expect(refWrite.artifacts.lyricsOverrideRef).toBe(STORED);
	expect(refWrite.artifacts.lyricsOverrideText).toBeUndefined();
	expect(assignParams('align', mediaFromSidecar(refWrite)).pinnedText).toBeUndefined();

	// But an INDEX-ONLY media (a hydrate that carries no override at all) must still not erase a pin the
	// sidecar already recorded — the same preserve-prior rule the candidate set and the ref rely on.
	const indexOnly = media({ lyricsOverrideRef: undefined, lyricsOverrideText: undefined });
	const rewritten = sidecarFromMedia(indexOnly, T0 + 2000, pasteWrite);
	expect(rewritten.artifacts.lyricsOverrideRef).toBe(manualLyricsRef('m1'));
	expect(rewritten.artifacts.lyricsOverrideText).toBe(PASTED);
});
