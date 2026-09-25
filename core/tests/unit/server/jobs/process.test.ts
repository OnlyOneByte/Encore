// Process request flips media to processing-file (rotation auto-holds the slot), enqueues a stems job at need-priority,
// dedups repeats, and refuses to disrupt the live song. markMediaReady flips to the playable instrumental. Plus the
// round-trip: process → held → ready → plays at its slot.
import { test, expect } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import {
	requestProcess,
	markMediaReady,
	setMediaLyrics,
	instrumentalKey,
	soonestSeqFor,
	isProcessed,
	processState,
	settleStemsGate,
	countInFlightProcesses,
	maxProcessesPerSinger,
	type ProcessDeps
} from '$lib/server/jobs/process';
import { pendingGates, EMPTY_SONG_PROFILE, DEFAULT_GLOBAL_SETTINGS, PROCESSES_UNCAPPED } from '$lib/contract';
import { JobRepository } from '$lib/server/jobs/repository';
import { AuthoritativeState } from '$lib/server/state/store';
import { nextPlayable, isEntryReady } from '$lib/server/rotation';
import { playbackRef, type Media, type QueueEntry } from '$lib/contract';

const T0 = 1_700_000_000_000;
const media = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'vid-' + id,
	title: id,
	durationSec: 200,
	stemStatus: 'none',
	...over
});
let _s = 0;
const entry = (id: string, mediaId: string, singerId = 's1'): QueueEntry => ({
	id,
	mediaId,
	singerId,
	status: 'queued',
	rotationSeq: -1,
	addedAt: ++_s
});

function deps(): ProcessDeps & { mediaById: Map<string, Media> } {
	const db = migratedDb();
	return { jobs: new JobRepository(db), mediaById: new Map(), state: new AuthoritativeState(), now: () => T0 };
}

test('request marks the media processing and enqueues ACQUISITION first', () => {
	// The chain starts at `fetch` and followUps chains stems after it: enqueueing stems directly dispatches a separation
	// before its input exists.
	const d = deps();
	d.mediaById.set('m1', media('m1'));
	const job = requestProcess('m1', d);
	expect(job).not.toBeNull();
	expect(job!.jobType).toBe('fetch');
	expect(job!.status).toBe('queued');
	const m = d.mediaById.get('m1')!;
	expect(m.stemStatus).toBe('queued');
	expect(isEntryReady(entry('q', 'm1'), d.mediaById)).toBe(false);
});

test('idempotent: a repeat request reuses the same live job (one compute)', () => {
	const d = deps();
	d.mediaById.set('m1', media('m1'));
	const a = requestProcess('m1', d);
	const b = requestProcess('m1', d);
	expect(b!.id).toBe(a!.id);
	expect(d.jobs.listByStatus('queued')).toHaveLength(1);
});

test('unknown media → null (no job)', () => {
	const d = deps();
	expect(requestProcess('ghost', d)).toBeNull();
});

test('refuses to process the currently-playing song (would yank the live video)', () => {
	const d = deps();
	d.mediaById.set('m1', media('m1'));
	d.state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	d.state.setPlayback({ currentEntryId: 'q1', isPlaying: true });
	expect(requestProcess('m1', d)).toBeNull();
	expect(d.mediaById.get('m1')!.stemStatus).toBe('none'); // unchanged
});

test('priority = soonest rotationSeq among queued entries needing the media', () => {
	const entries = [
		{ ...entry('q1', 'm1'), rotationSeq: 5, status: 'queued' as const },
		{ ...entry('q2', 'm1'), rotationSeq: 2, status: 'queued' as const },
		{ ...entry('q3', 'm2'), rotationSeq: 0, status: 'queued' as const }
	];
	expect(soonestSeqFor('m1', entries)).toBe(2); // soonest of the two m1 entries
	expect(soonestSeqFor('m2', entries)).toBe(0);
	expect(soonestSeqFor('absent', entries)).toBe(Number.MAX_SAFE_INTEGER);
});

test('markMediaReady records the instrumental key and LEAVES sourceRef alone', () => {
	const d = deps();
	d.mediaById.set('m1', media('m1', { stemStatus: 'queued' }));
	expect(markMediaReady('m1', d.mediaById)).toBe(true);
	const m = d.mediaById.get('m1')!;
	expect(m.stemStatus).toBe('ready');
	expect(m.instrumentalRef).toBe(instrumentalKey('m1'));
	expect(m.instrumentalRef).toBe('derived/stems/m1-instrumental.flac');
	// Overwriting sourceRef forks the song into two rows (the processed one in the library and a fresh unprocessed one on
	// the next search), because search dedupes on it.
	expect(m.sourceRef).toBe('vid-m1');
	expect(markMediaReady('ghost', d.mediaById)).toBe(false);
});

test('a processed song stays recognisable by its ORIGIN identity (search dedupe key)', () => {
	const d = deps();
	d.mediaById.set('m1', media('m1', { sourceRef: 'djV11Xbc914' }));
	requestProcess('m1', d);
	markMediaReady('m1', d.mediaById);
	const m = d.mediaById.get('m1')!;
	// The exact lookup /api/search does when deciding "have I seen this result before?".
	const matches = [...d.mediaById.values()].filter((x) => x.source === 'youtube' && x.sourceRef === 'djV11Xbc914');
	expect(matches).toHaveLength(1);
	expect(matches[0]!.id).toBe('m1');
	expect(matches[0]!.stemStatus).toBe('ready'); // and it is recognised as ALREADY PROCESSED
	expect(playbackRef(m)).toBe('derived/stems/m1-instrumental.flac'); // while still playing the instrumental
});

test('setMediaLyrics attaches the align artifact uri, and no-ops without one', () => {
	const d = deps();
	d.mediaById.set('m1', media('m1'));
	expect(setMediaLyrics('m1', 'lyrics/m1-aligned.json', d.mediaById)).toBe(true);
	expect(d.mediaById.get('m1')!.lyricsRef).toBe('lyrics/m1-aligned.json');
	expect(setMediaLyrics('m1', undefined, d.mediaById)).toBe(false);
	expect(setMediaLyrics('ghost', 'x.json', d.mediaById)).toBe(false);
});

test('ROUND TRIP: process → held while another plays → ready → plays at its preserved slot', () => {
	const d = deps();
	// a wants a process on m1 (queued first, seq 0); b already has a processed m2.
	d.mediaById.set('m1', media('m1'));
	d.mediaById.set(
		'm2',
		media('m2', {
			stemStatus: 'ready',
			lyricsStatus: 'ready',
			instrumentalRef: 'derived/stems/i-instrumental.flac',
			songProfile: { ...EMPTY_SONG_PROFILE }
		})
	);
	d.state.applyQueueOp({ op: 'add', entry: entry('q-a', 'm1', 'a') });
	d.state.applyQueueOp({ op: 'add', entry: entry('q-b', 'm2', 'b') });

	requestProcess('m1', d); // m1 now processing-file → held
	// While processing, the soonest PLAYABLE is q-b — q-a is held despite its lower seq.
	expect(nextPlayable(d.state.entries, d.mediaById).next?.id).toBe('q-b');
	const held = nextPlayable(d.state.entries, d.mediaById).held.map((e) => e.id);
	expect(held).toContain('q-a');

	// stems finish, but the process is fetch → stems → ALIGN, so q-a keeps yielding: rotation waits for the whole
	// process, not for the instrumental.
	markMediaReady('m1', d.mediaById);
	// The same stems job also emits the song profile, so model it or the stems gate is unsatisfied and this measures the
	// wrong gate.
	d.mediaById.get('m1')!.songProfile = { ...EMPTY_SONG_PROFILE };
	expect(nextPlayable(d.state.entries, d.mediaById).next?.id).toBe('q-b');
	expect(nextPlayable(d.state.entries, d.mediaById).held.map((e) => e.id)).toContain('q-a');

	// Every gate satisfied, so q-a is playable again AT its fair position (seq 0, before q-b) — the point of the hold.
	d.mediaById.get('m1')!.lyricsStatus = 'ready';
	expect(nextPlayable(d.state.entries, d.mediaById).next?.id).toBe('q-a');
});

// Dedupe to already-separated stems — the durable catalog's payoff.

test('isProcessed is true only when a ready status has an instrumental to show for it', () => {
	expect(
		isProcessed(
			media('m1', { stemStatus: 'ready', lyricsStatus: 'ready', instrumentalRef: 'derived/stems/i-instrumental.flac' })
		)
	).toBe(true);
	expect(isProcessed(media('m1', { stemStatus: 'queued' }))).toBe(false);
	// Status ran ahead of the artifact: playing this hands the TV an empty source.
	expect(isProcessed(media('m1', { stemStatus: 'ready', lyricsStatus: 'ready' }))).toBe(false);
	expect(isProcessed(media('m1'))).toBe(false);
});

test('processState distinguishes unknown / playing / ready / processing / processable', () => {
	const d = deps();
	expect(processState('ghost', d)).toBe('unknown');

	d.mediaById.set('plain', media('plain'));
	expect(processState('plain', d)).toBe('processable');

	d.mediaById.set(
		'done',
		media('done', { stemStatus: 'ready', lyricsStatus: 'ready', instrumentalRef: 'derived/stems/i-instrumental.flac' })
	);
	expect(processState('done', d)).toBe('ready');

	d.mediaById.set('wip', media('wip', { stemStatus: 'queued' }));
	expect(processState('wip', d)).toBe('processing');

	// The live song outranks everything else: never yank the running video.
	d.state.applyQueueOp({ op: 'add', entry: entry('q1', 'plain') });
	d.state.setPlayback({ currentEntryId: 'q1', isPlaying: true });
	expect(processState('plain', d)).toBe('playing');
});

test('an already-processed song is NEVER re-processed (no second job, no wasted separation)', () => {
	const d = deps();
	// Exactly the shape hydrated from disk on boot: file, ready, the instrumental key and the profile.
	d.mediaById.set(
		'm1',
		media('m1', {
			stemStatus: 'ready',
			lyricsStatus: 'ready',
			instrumentalRef: instrumentalKey('m1'),
			songProfile: { ...EMPTY_SONG_PROFILE }
		})
	);

	expect(requestProcess('m1', d)).toBeNull();
	expect(d.jobs.listByStatus('queued')).toHaveLength(0);
	const m = d.mediaById.get('m1')!;
	expect(m.stemStatus).toBe('ready');
	expect(m.instrumentalRef).toBe(instrumentalKey('m1'));
	// A ready file entry is immediately playable, so re-queueing it skips the worker entirely.
	expect(isEntryReady(entry('q', 'm1'), d.mediaById)).toBe(true);
});

test('RESTART ROUND TRIP: proc, "restart" with the catalog rehydrated, re-request → zero jobs', () => {
	const d = deps();
	d.mediaById.set('m1', media('m1'));
	expect(requestProcess('m1', d)).not.toBeNull(); // night one: processed
	markMediaReady('m1', d.mediaById);

	// A fresh job repo plus a catalog hydrated from the durable row.
	const d2 = deps();
	d2.mediaById.set('m1', { ...d.mediaById.get('m1')! });
	expect(requestProcess('m1', d2)).toBeNull();
	expect(d2.jobs.listByStatus('queued')).toHaveLength(0);
});

test('a reused ALREADY-READY job reconciles the media instead of deadlocking rotation', () => {
	// The dedup index counts `ready` as live, so enqueue can hand back a FINISHED job. Leaving the media processing
	// against it means no worker ever runs and the entry is held out of rotation forever.
	const d = deps();
	d.mediaById.set('m1', media('m1'));
	const first = requestProcess('m1', d)!;
	d.jobs.assign(first.id, 'w1', T0 + 1000, T0);
	d.jobs.accept(first.id, T0 + 2000, T0);
	d.jobs.complete(first.id, T0);
	expect(d.jobs.byId(first.id)!.status).toBe('ready');

	// The media's ready flags are lost (a stub overwrote the runtime entry), so request again.
	d.mediaById.set('m1', media('m1'));
	const second = requestProcess('m1', d)!;
	expect(second.id).toBe(first.id); // deduped to the finished job
	const m = d.mediaById.get('m1')!;
	expect(m.stemStatus).toBe('ready'); // NOT left 'queued'
	expect(m.instrumentalRef).toBe(instrumentalKey('m1'));
	// Reconcile restores the instrumental, and the sidecar restores the song profile with it, so the stems gate is
	// genuinely complete. Model both, or pendingGates reports a test-only gap.
	m.songProfile = { ...EMPTY_SONG_PROFILE };
	// The separation gate is satisfied, so nothing waits on a job that will never run. What remains is the ORDINARY wait
	// for the rest of the process — asserted precisely, because playability also depends on the lyrics gate.
	expect(pendingGates(m).map((g) => g.id)).toEqual(['lyrics']);
	m.lyricsStatus = 'ready';
	expect(isEntryReady(entry('q', 'm1'), d.mediaById)).toBe(true); // playable, not held forever
});

// settleStemsGate — the twin of settleLyricsGate. A terminal stems failure that leaves stemStatus mid-flight keeps
// isProcessing true and processState at 'processing', so the song reads "Making karaoke…" forever AND refuses a retry:
// one worker OOM, permanently unsingable.

test('a permanently failed separation settles back to un-processed, so it can be retried', () => {
	const d = deps();
	d.mediaById.set('m1', media('m1', { stemStatus: 'queued' }));

	// Unsettled, requestProcess dedupes to the phantom process instead of retrying.
	expect(processState('m1', d)).toBe('processing');

	expect(settleStemsGate('m1', d.mediaById)).toBe(true);
	expect(d.mediaById.get('m1')!.stemStatus).toBe('none');
	expect(processState('m1', d)).toBe('processable');
	expect(requestProcess('m1', d)).not.toBeNull(); // the retry is a real action
});

test('settling never walks a FINISHED process backwards', () => {
	const d = deps();
	// A failed lyrics upgrade must not throw away an already-separated instrumental.
	d.mediaById.set('m1', media('m1', { stemStatus: 'ready', instrumentalRef: 'derived/stems/m1-instrumental.flac' }));
	expect(settleStemsGate('m1', d.mediaById)).toBe(false);
	expect(d.mediaById.get('m1')!.stemStatus).toBe('ready');
	expect(isProcessed(d.mediaById.get('m1')!)).toBe(true);
});

test('settling an unknown media is a no-op, not a crash', () => {
	const d = deps();
	expect(settleStemsGate('nope', d.mediaById)).toBe(false);
});

// One guest must not flood the fleet: deduping on stems-existence alone lets one phone tapping Sing down a search page
// enqueue a 1–2 minute GPU job per distinct song. The cap bounds what is processing AT ONCE, per singer — a lifetime
// quota would punish a guest whose earlier songs already finished.

function runProcess(d: ReturnType<typeof deps>, id: string, singerId: string) {
	d.mediaById.set(id, media(id));
	d.state.applyQueueOp({ op: 'add', entry: entry('q-' + id, id, singerId) });
	return requestProcess(id, d, singerId);
}

test('countInFlightProcesses counts a singer’s distinct processing songs, not finished or others’', () => {
	const d = deps();
	runProcess(d, 'm1', 'alice');
	runProcess(d, 'm2', 'alice');
	expect(countInFlightProcesses('alice', d)).toBe(2);
	runProcess(d, 'm3', 'bob');
	expect(countInFlightProcesses('alice', d)).toBe(2);
	markMediaReady('m1', d.mediaById);
	d.mediaById.get('m1')!.songProfile = { ...EMPTY_SONG_PROFILE };
	expect(countInFlightProcesses('alice', d)).toBe(1);
});

// The cap is a SETTING (`GlobalSettings.maxProcessesPerSinger`). These tests pass no `getSettings` — the anonymous
// caller path — so they exercise the shipped DEFAULT, read from the same function the app calls rather than restated, so
// changing the default cannot leave them asserting a number the app no longer uses.
const CAP = maxProcessesPerSinger({});

test('a singer at the cap is refused a NEW process (over-limit), and the count is honest', () => {
	const d = deps();
	for (let i = 0; i < CAP; i++) runProcess(d, 'm' + i, 'alice');
	expect(countInFlightProcesses('alice', d)).toBe(CAP);

	d.mediaById.set('over', media('over'));
	d.state.applyQueueOp({ op: 'add', entry: entry('q-over', 'over', 'alice') });
	expect(processState('over', d, 'alice')).toBe('over-limit');
	expect(requestProcess('over', d, 'alice')).toBeNull();
	expect(d.mediaById.get('over')!.stemStatus).toBe('none'); // never flipped to processing
});

test('the cap is PER singer and only bounds concurrency — another singer and a freed slot both proceed', () => {
	const d = deps();
	for (let i = 0; i < CAP; i++) runProcess(d, 'm' + i, 'alice');
	expect(processState('m0', d, 'bob')).not.toBe('over-limit'); // (m0 is already processing, so 'processing')
	d.mediaById.set('bobsong', media('bobsong'));
	d.state.applyQueueOp({ op: 'add', entry: entry('q-bob', 'bobsong', 'bob') });
	expect(requestProcess('bobsong', d, 'bob')).not.toBeNull();

	// alice finishes one, so she can process again: not a lifetime quota.
	markMediaReady('m0', d.mediaById);
	d.mediaById.get('m0')!.songProfile = { ...EMPTY_SONG_PROFILE };
	d.mediaById.set('again', media('again'));
	d.state.applyQueueOp({ op: 'add', entry: entry('q-again', 'again', 'alice') });
	expect(requestProcess('again', d, 'alice')).not.toBeNull();
});

test('the cap comes from the SETTING, so a deployment can raise it', () => {
	// A box with more workers can raise the cap, and the gate must read THAT number, not the default.
	const d = { ...deps(), getSettings: () => ({ ...DEFAULT_GLOBAL_SETTINGS, maxProcessesPerSinger: 5 }) };
	for (let i = 0; i < 5; i++) runProcess(d, 'm' + i, 'alice');
	expect(countInFlightProcesses('alice', d)).toBe(5);
	// The raised cap still BINDS at its own number, or "settable" would mean "unbounded".
	d.mediaById.set('sixth', media('sixth'));
	d.state.applyQueueOp({ op: 'add', entry: entry('q-sixth', 'sixth', 'alice') });
	expect(processState('sixth', d, 'alice')).toBe('over-limit');
});

test('a cap of 0 means UNCAPPED, not "refuse everything"', () => {
	// THE INVERSION: `count >= cap` is true for every singer when the cap is 0, so reading the sentinel naively turns the
	// bound all the way UP instead of off and a deployment meaning "no limit" refuses every first process. The gate
	// checks the sentinel BEFORE the count.
	const d = {
		...deps(),
		getSettings: () => ({ ...DEFAULT_GLOBAL_SETTINGS, maxProcessesPerSinger: PROCESSES_UNCAPPED })
	};
	for (let i = 0; i < 8; i++) runProcess(d, 'm' + i, 'alice');
	d.mediaById.set('ninth', media('ninth'));
	d.state.applyQueueOp({ op: 'add', entry: entry('q-ninth', 'ninth', 'alice') });
	expect(processState('ninth', d, 'alice')).toBe('processable');
	expect(requestProcess('ninth', d, 'alice')).not.toBeNull();
});

test('an anonymous request (no singerId) imposes no cap — internal callers are never blocked', () => {
	const d = deps();
	for (let i = 0; i < CAP + 2; i++) {
		d.mediaById.set('n' + i, media('n' + i));
		d.state.applyQueueOp({ op: 'add', entry: entry('qn' + i, 'n' + i, 'alice') });
		expect(requestProcess('n' + i, d)).not.toBeNull(); // no singerId → no cap
	}
});

test('re-tapping a song already processing is never counted against its own owner (dedup, not a block)', () => {
	const d = deps();
	for (let i = 0; i < CAP; i++) runProcess(d, 'm' + i, 'alice');
	// A repeat request on an already-processing song dedupes to the same job rather than being refused.
	const again = requestProcess('m0', d, 'alice');
	expect(again).not.toBeNull();
	expect(processState('m0', d, 'alice')).toBe('processing'); // not 'over-limit'
});

// The cap must hold when the singer's queue ADD was dropped over a reconnecting socket. The add (WebSocket) and the
// process (HTTP) ride different transports and only the add is droppable, so a phone tapping Sing with its socket down
// lands the process and buffers the add — NO queue entry exists, and a cap counted off `state.entries` sees zero and
// admits every tap. Counting off the job LEDGER does not depend on the second transport. `process()` is avoided here
// deliberately: it adds an entry, which is exactly the transport that is absent in this window.
test('the per-singer cap holds even when NO queue entry exists (dropped add over a reconnecting socket)', () => {
	const d = deps();
	// The process lands, the add never does, so state.entries stays empty for all of them.
	for (let i = 0; i < CAP; i++) {
		d.mediaById.set('m' + i, media('m' + i));
		expect(requestProcess('m' + i, d, 'alice')).not.toBeNull();
	}
	expect(d.state.entries).toHaveLength(0); // the whole point: no entries were ever added
	expect(countInFlightProcesses('alice', d)).toBe(CAP);

	// One more distinct tap in the same window MUST be refused; an entry-derived cap admitted the burst.
	d.mediaById.set('over', media('over'));
	expect(processState('over', d, 'alice')).toBe('over-limit');
	expect(requestProcess('over', d, 'alice')).toBeNull();
	expect(d.mediaById.get('over')!.stemStatus).toBe('none'); // never flipped to processing
});

test('a dropped-add process is attributed to its requester in the ledger, and only to them', () => {
	const d = deps();
	d.mediaById.set('a1', media('a1'));
	requestProcess('a1', d, 'alice');
	d.mediaById.set('b1', media('b1'));
	requestProcess('b1', d, 'bob');
	expect(countInFlightProcesses('alice', d)).toBe(1); // alice's process counts for alice
	expect(countInFlightProcesses('bob', d)).toBe(1); // and bob's for bob
	const aliceJob = d.jobs.listByStatus('queued').find((j) => j.mediaId === 'a1');
	expect(aliceJob!.singerId).toBe('alice');
});

test('a spotify-sourced media is refused a process (search-only; audio comes from YouTube)', () => {
	// Processing a spotify media would enqueue a fetch forming youtube.com/watch?v=<spotify-track-id> and die at ffmpeg.
	// Spotify is a metadata source only; the singer queues the YouTube result instead.
	const d = deps();
	const m = media('sp1', { source: 'spotify', sourceRef: '4uLU6hMCjMI75M1A2tKUQC' });
	d.mediaById.set('sp1', m);
	expect(requestProcess('sp1', d)).toBeNull();
	expect(m.stemStatus).toBe('none'); // never flipped to queued
});
