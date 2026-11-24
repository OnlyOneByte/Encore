// A PASTED lyrics re-pick must reach the worker. With the words stored nowhere, `dispatch.assignParams` has
// nothing to put behind `pinnedText`, so the worker's pinned path gets a ref naming a file no one wrote and
// STOPs with "carry no readable text" — the guest watches the wrong words scroll after being told it worked.
//
// The store is `Media`, NOT the job: `jobs` has no params column, and every parameter the worker sees is
// DERIVED at dispatch time from the media. Anything narrower (a field on the in-memory Job, a Map in
// process.ts) is lost by a restart between enqueue and dispatch, since the reaper requeues and dispatch
// re-derives from the media — the same silent discard with a smaller window, which is why the durability
// arms are part of the fix.
//
// Four properties: a paste arrives as `pinnedText`; a `ref` pick sends `pinnedRef` and NO `pinnedText`, even
// after an earlier paste; a whitespace-only paste is refused and enqueues nothing; and the pin survives a
// restart, through the SQLite index and through the sidecar it is rebuildable from.
import { test, expect } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { requestLyricsReselect, editLyricsRef, type ProcessDeps } from '$lib/server/jobs/process';
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

	// A new ref per lyrics change; the worker test reads the same template from its side.
	expect(res.ref).toBe(editLyricsRef('m1', 1));
	expect(editLyricsRef('m1', 1)).toBe('derived/lyrics/m1-edit-r1.json');

	// Stored on the media, trimmed, so dispatch has something to send.
	expect(m.lyricsOverrideText).toBe(PASTED);

	// What the worker actually receives: without it, a ref with no content behind it.
	const params = assignParams('align', d.mediaById.get('m1'));
	expect(params.pinnedRef).toBe(editLyricsRef('m1', 1));
	expect(params.pinnedText).toBe(PASTED);
	// The document on screen, whose line timings seed the re-time; it moves only when the re-time lands.
	expect(params.pinnedFrom).toBe('derived/lyrics/m1-asr.json');
});

test('a paste with nothing on screen, and a ref pick, send no pinnedFrom', () => {
	const d = deps();
	const m = media({ lyricsRef: undefined });
	d.mediaById.set('m1', m);
	if (typeof requestLyricsReselect('m1', { text: PASTED }, d, 's1') === 'string') throw new Error('refused');
	expect(assignParams('align', m).pinnedFrom).toBeUndefined();
	if (typeof requestLyricsReselect('m1', { ref: STORED }, d, 's1') === 'string') throw new Error('refused');
	expect(assignParams('align', m).pinnedFrom).toBeUndefined();
});

test('a second paste gets a new ref, so a TV holding the first one fetches again', () => {
	const d = deps();
	const m = media();
	d.mediaById.set('m1', m);
	const first = requestLyricsReselect('m1', { text: PASTED }, d, 's1');
	const second = requestLyricsReselect('m1', { text: `${PASTED}\nand one more line` }, d, 's1');
	if (typeof first === 'string' || typeof second === 'string') throw new Error('refused');
	expect(second.ref).not.toBe(first.ref);
	expect(m.lyricsEditRev).toBe(2);
	expect(assignParams('align', m).pinnedRef).toBe(second.ref);
});

test('a ref pick sends pinnedRef and NO pinnedText, even after an earlier paste', () => {
	const d = deps();
	const m = media();
	d.mediaById.set('m1', m);

	expect(typeof requestLyricsReselect('m1', { text: PASTED }, d, 's1')).not.toBe('string');
	const res = requestLyricsReselect('m1', { ref: STORED }, d, 's1');
	if (typeof res === 'string') throw new Error(res);

	expect(res.ref).toBe(STORED);
	// The paste is CLEARED with the pin it belonged to: left behind, `pinnedText` outranks `pinnedRef` in
	// the worker's pinned path and re-times the abandoned paste under the newly picked candidate's key,
	// overwriting a good provider candidate.
	expect(m.lyricsOverrideText).toBeUndefined();

	const params = assignParams('align', d.mediaById.get('m1'));
	expect(params.pinnedRef).toBe(STORED);
	expect(params.pinnedText).toBeUndefined();

	// An ordinary process with no override sends neither.
	const plain = assignParams('align', media());
	expect(plain.pinnedRef).toBeUndefined();
	expect(plain.pinnedText).toBeUndefined();
});

test('a whitespace-only paste is refused with no-text and enqueues nothing', () => {
	const d = deps();
	const m = media();
	d.mediaById.set('m1', m);

	// The endpoint refuses this shape too, but the refusal must hold HERE as well, because this is where the
	// enqueue and the pin happen: a paste of blanks must not become a `manual` pin over a song's working
	// lyrics, and falling through to the ref branch answers `unknown-candidate`, a misleading reason.
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

	// What the endpoint does after a successful re-select.
	new MediaRepository(db).upsert(m);

	// A restart: a new repository over the same file, as boot's hydrate does.
	const restored = new MediaRepository(db).byId('m1')!;
	expect(restored.lyricsOverrideRef).toBe(editLyricsRef('m1', 1));
	expect(restored.lyricsEditRev).toBe(1);
	expect(restored.lyricsOverrideText).toBe(PASTED);
	// The dispatcher re-derives params from the RESTORED media, so the requeued align still carries the
	// paste. With nothing durable holding the text, a restart between enqueue and dispatch drops it.
	expect(assignParams('align', restored).pinnedText).toBe(PASTED);

	// A later ref pick clears the column rather than leaving the stale paste in the row.
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
	expect(back.lyricsOverrideRef).toBe(editLyricsRef('m1', 1));
	expect(back.lyricsOverrideText).toBe(PASTED);
	expect(assignParams('align', back).pinnedText).toBe(PASTED);
});

test('a sidecar rewrite after a ref pick does not resurrect the abandoned paste', () => {
	const d = deps();
	const m = media();
	d.mediaById.set('m1', m);
	if (typeof requestLyricsReselect('m1', { text: PASTED }, d, 's1') === 'string') throw new Error('refused');
	const pasteWrite = sidecarFromMedia(m, T0); // the sidecar written while the paste was pinned

	if (typeof requestLyricsReselect('m1', { ref: STORED }, d, 's1') === 'string') throw new Error('refused');
	const refWrite = sidecarFromMedia(m, T0 + 1000, pasteWrite);

	// The pasted words belong TO the ref they were pinned under, so the pair moves together: a prev-write
	// fallback keeping the text alone restores a media whose `pinnedRef` names one candidate and whose
	// `pinnedText` is an abandoned paste, and the worker re-times the paste over it.
	expect(refWrite.artifacts.lyricsOverrideRef).toBe(STORED);
	expect(refWrite.artifacts.lyricsOverrideText).toBeUndefined();
	expect(assignParams('align', mediaFromSidecar(refWrite)).pinnedText).toBeUndefined();

	// An INDEX-ONLY media must not erase a pin the sidecar already recorded — the same preserve-prior rule
	// the candidate set and the ref rely on.
	const indexOnly = media({ lyricsOverrideRef: undefined, lyricsOverrideText: undefined });
	const rewritten = sidecarFromMedia(indexOnly, T0 + 2000, pasteWrite);
	expect(rewritten.artifacts.lyricsOverrideRef).toBe(editLyricsRef('m1', 1));
	expect(rewritten.artifacts.lyricsOverrideText).toBe(PASTED);
});

test('once the host has changed the lyrics, a rewrite keeps a cleared pin cleared', () => {
	const m = media({ lyricsEditRev: 3 });
	const pinned = sidecarFromMedia({ ...m, lyricsOverrideRef: STORED }, T0);
	// Back to automatic: the runtime clears the pin, and the sidecar must not restore it from `prev`.
	const cleared = sidecarFromMedia(m, T0 + 1000, pinned);
	expect(cleared.artifacts.lyricsOverrideRef).toBeUndefined();
	expect(cleared.artifacts.lyricsEditRev).toBe(3);
});
