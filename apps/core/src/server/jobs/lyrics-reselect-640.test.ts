// #640 — requestLyricsReselect makes a finished align RE-RUNNABLE and pins the human pick.
//
// The load-bearing property: a completed `align` occupies the dedup slot (`ready` is not slot-freeing),
// so a bare enqueue would hand back the OLD job and nothing would run. requestLyricsReselect must
// CANCEL the live align first, then enqueue a genuinely new one, and reopen the lyrics gate. It also
// pins media.lyricsOverrideRef so dispatch sends the worker `pinnedRef`. These reds if the
// cancel-then-enqueue is reverted (the enqueue returns the old ready job), or the pin is dropped.
import { test, expect } from 'bun:test';
import { migratedDb } from '../db/test-db';
import { requestLyricsReselect, manualLyricsRef, type ProcessDeps } from './process';
import { assignParams } from './dispatch';
import { JobRepository } from './repository';
import { AuthoritativeState } from '../state/store';
import type { LyricsCandidate, Media } from '@encore/shared';

const T0 = 1_700_000_000_000;
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
		{ ref: 'derived/lyrics/m1-lrclib.json', textSource: 'lrclib', timing: 'word', textConfidence: 'high', createdAt: 2 }
	] as LyricsCandidate[],
	...over
});

function deps(): ProcessDeps & { mediaById: Map<string, Media>; jobs: JobRepository; tick: () => void } {
	const db = migratedDb();
	let t = T0;
	return {
		jobs: new JobRepository(db),
		mediaById: new Map(),
		state: new AuthoritativeState(),
		now: () => t,
		// advance the clock so a genuinely-new job gets a distinct ULID (ULIDs are time-derived; a
		// re-enqueue at the identical timestamp would collide even though it is a new DB row).
		tick: () => {
			t += 1000;
		}
	};
}

/** Drive a media to a COMPLETED align occupying the dedup slot, as a re-select would find it. */
function withCompletedAlign(d: ReturnType<typeof deps>): { alignId: string } {
	const j = d.jobs.enqueue('m1', 'align', 0, T0);
	d.jobs.assign(j.id, 'w', null, T0 + 1);
	d.jobs.accept(j.id, null, T0 + 2);
	d.jobs.complete(j.id, T0 + 3);
	expect(d.jobs.findLive('m1', 'align')!.status).toBe('ready'); // control: it still occupies the slot
	return { alignId: j.id };
}

test('picking a stored candidate cancels the finished align and enqueues a NEW one', () => {
	const d = deps();
	d.mediaById.set('m1', media());
	const { alignId } = withCompletedAlign(d);

	d.tick(); // clock moves on before the re-select, as it would in production
	const res = requestLyricsReselect('m1', { ref: 'derived/lyrics/m1-lrclib.json' }, d, 's1');
	expect(typeof res).not.toBe('string'); // not a refusal
	if (typeof res === 'string') throw new Error(res);

	expect(res.ref).toBe('derived/lyrics/m1-lrclib.json');
	expect(res.job.id).not.toBe(alignId); // a genuinely new job — reds if enqueue handed back the ready one
	expect(res.job.status).toBe('queued');
	expect(d.jobs.byId(alignId)).toBeNull(); // the finished align was superseded (row removed) to free the slot
	expect(d.jobs.findLive('m1', 'align')!.id).toBe(res.job.id); // the live align is now the new one
	expect(d.mediaById.get('m1')!.lyricsOverrideRef).toBe('derived/lyrics/m1-lrclib.json'); // pinned
	expect(d.mediaById.get('m1')!.lyricsStatus).toBe('queued'); // gate reopened
});

test('pasting lyrics pins a MANUAL ref and re-times, even with no live align yet', () => {
	const d = deps();
	d.mediaById.set('m1', media());
	// no prior align job at all — the enqueue starts the first one
	const res = requestLyricsReselect('m1', { text: 'hello darkness my old friend' }, d, 's1');
	if (typeof res === 'string') throw new Error(res);
	expect(res.ref).toBe(manualLyricsRef('m1'));
	expect(d.mediaById.get('m1')!.lyricsOverrideRef).toBe(manualLyricsRef('m1'));
	expect(res.job.status).toBe('queued');
});

test('dispatch sends the pinned ref to the worker as pinnedRef for an align job', () => {
	const m = media({ lyricsOverrideRef: 'derived/lyrics/m1-lrclib.json' });
	const params = assignParams('align', m);
	expect(params.pinnedRef).toBe('derived/lyrics/m1-lrclib.json');
	// A media with no override sends none — the ordinary process is unchanged.
	expect(assignParams('align', media()).pinnedRef).toBeUndefined();
});

test('supersedeForRerun frees a READY slot but refuses a LIVE job', () => {
	const d = deps();
	// a ready align: supersede deletes it and frees the slot
	const done = d.jobs.enqueue('m1', 'align', 0, T0);
	d.jobs.assign(done.id, 'w', null, T0 + 1);
	d.jobs.accept(done.id, null, T0 + 2);
	d.jobs.complete(done.id, T0 + 3);
	expect(d.jobs.supersedeForRerun('m1', 'align')).toBe(true);
	expect(d.jobs.byId(done.id)).toBeNull();
	expect(d.jobs.findLive('m1', 'align')).toBeNull(); // slot freed

	// a LIVE (queued) align is NOT superseded — it would yank work from under a worker
	const liveJob = d.jobs.enqueue('m2', 'align', 0, T0 + 5);
	expect(d.jobs.supersedeForRerun('m2', 'align')).toBe(false);
	expect(d.jobs.byId(liveJob.id)!.status).toBe('queued');
});

test('supersedeForRerun frees the SLOT OCCUPANT, not an arbitrary terminal sibling (two-row state)', () => {
	// The reachable state pr-bot found: a FAILED attempt (slot-freeing, but its row lingers) plus a
	// later READY attempt (the actual slot occupant). enqueue inserts a new row whenever nothing is
	// live, so two rows on one key is ordinary — e.g. align exhausts 3 attempts → failed row remains →
	// the next boot's backfill enqueues a second align → it succeeds → ready.
	const d = deps();
	const failed = d.jobs.enqueue('m1', 'align', 0, T0);
	d.jobs.assign(failed.id, 'w', null, T0 + 1);
	d.jobs.accept(failed.id, null, T0 + 2);
	d.jobs.fail(failed.id, 'demucs OOM', T0 + 3); // slot freed, but the row stays
	const ready = d.jobs.enqueue('m1', 'align', 0, T0 + 4); // a NEW row now holds the slot
	d.jobs.assign(ready.id, 'w', null, T0 + 5);
	d.jobs.accept(ready.id, null, T0 + 6);
	d.jobs.complete(ready.id, T0 + 7);
	expect(d.jobs.findLive('m1', 'align')!.id).toBe(ready.id); // control: ready holds the slot

	expect(d.jobs.supersedeForRerun('m1', 'align')).toBe(true);
	// The READY occupant is gone (slot freed); the failed sibling is irrelevant to the slot and
	// reverting the fix to the unfiltered .all()[0] deletes the FAILED row instead, leaving ready live.
	expect(d.jobs.byId(ready.id)).toBeNull();
	expect(d.jobs.findLive('m1', 'align')).toBeNull(); // slot genuinely freed
	// A fresh enqueue now creates a NEW job rather than handing back the old ready one.
	const fresh = d.jobs.enqueue('m1', 'align', 0, T0 + 8);
	expect(fresh.id).not.toBe(ready.id);
	expect(fresh.status).toBe('queued');
});

test('refusals: unknown media, unprocessed song, and a ref not in the set', () => {
	const d = deps();
	expect(requestLyricsReselect('nope', { ref: 'x' }, d, 's1')).toBe('unknown-media');

	d.mediaById.set('raw', media({ id: 'raw', vocalsRef: undefined }));
	expect(requestLyricsReselect('raw', { ref: 'derived/lyrics/m1-asr.json' }, d, 's1')).toBe('not-processed');

	d.mediaById.set('m1', media());
	expect(requestLyricsReselect('m1', { ref: 'derived/lyrics/m1-nope.json' }, d, 's1')).toBe('unknown-candidate');
});
