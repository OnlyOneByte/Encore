// Make-karaoke request flips media to cooking-file (rotation auto-holds the slot), enqueues
// a stems job at need-priority, dedups repeats, and refuses to disrupt the live song. markMediaReady
// flips to the playable instrumental. Plus the round-trip: cook → held → ready → plays at its slot.
import { test, expect } from 'bun:test';
import { migratedDb } from '$server/db/test-db';
import {
	requestMakeKaraoke,
	markMediaReady,
	setMediaLyrics,
	setMediaGuideOffset,
	instrumentalKey,
	soonestSeqFor,
	isCooked,
	cookState,
	settleStemsGate,
	countInFlightCooks,
	MAX_CONCURRENT_COOKS_PER_SINGER,
	type MakeKaraokeDeps
} from '$server/jobs/make-karaoke';
import { pendingGates, EMPTY_SONG_PROFILE } from '$shared';
import { JobRepository } from '$server/jobs/repository';
import { AuthoritativeState } from '$server/state/store';
import { nextPlayable, isEntryReady } from '$server/rotation/index';
import { playbackRef, type Media, type QueueEntry } from '$shared';

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

function deps(): MakeKaraokeDeps & { mediaById: Map<string, Media> } {
	const db = migratedDb();
	return { jobs: new JobRepository(db), mediaById: new Map(), state: new AuthoritativeState(), now: () => T0 };
}

test('request marks the media cooking and enqueues ACQUISITION first', () => {
	// A YouTube song has no bytes here yet, so the chain starts at `fetch`; followUps chains stems
	// after it. Enqueueing stems directly would dispatch a separation before its input existed.
	const d = deps();
	d.mediaById.set('m1', media('m1'));
	const job = requestMakeKaraoke('m1', d);
	expect(job).not.toBeNull();
	expect(job!.jobType).toBe('fetch');
	expect(job!.status).toBe('queued');
	// media is now cooking → rotation will hold its slot
	const m = d.mediaById.get('m1')!;
	expect(m.stemStatus).toBe('queued');
	expect(isEntryReady(entry('q', 'm1'), d.mediaById)).toBe(false);
});

test('idempotent: a repeat request reuses the same live job (one compute)', () => {
	const d = deps();
	d.mediaById.set('m1', media('m1'));
	const a = requestMakeKaraoke('m1', d);
	const b = requestMakeKaraoke('m1', d);
	expect(b!.id).toBe(a!.id);
	expect(d.jobs.listByStatus('queued')).toHaveLength(1);
});

test('unknown media → null (no job)', () => {
	const d = deps();
	expect(requestMakeKaraoke('ghost', d)).toBeNull();
});

test('refuses to make-karaoke the currently-playing song (would yank the live video)', () => {
	const d = deps();
	d.mediaById.set('m1', media('m1'));
	d.state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	d.state.setPlayback({ currentEntryId: 'q1', isPlaying: true });
	expect(requestMakeKaraoke('m1', d)).toBeNull();
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
	// REGRESSION: overwriting sourceRef forked the song into two rows — the cooked one in the
	// library and a fresh uncooked one on the next search, because search dedupes on it.
	expect(m.sourceRef).toBe('vid-m1');
	expect(markMediaReady('ghost', d.mediaById)).toBe(false);
});

test('a cooked song stays recognisable by its ORIGIN identity (search dedupe key)', () => {
	const d = deps();
	d.mediaById.set('m1', media('m1', { sourceRef: 'djV11Xbc914' }));
	requestMakeKaraoke('m1', d);
	markMediaReady('m1', d.mediaById);
	const m = d.mediaById.get('m1')!;
	// the exact lookup /api/search does when deciding "have I seen this result before?"
	const matches = [...d.mediaById.values()].filter((x) => x.source === 'youtube' && x.sourceRef === 'djV11Xbc914');
	expect(matches).toHaveLength(1);
	expect(matches[0]!.id).toBe('m1');
	expect(matches[0]!.stemStatus).toBe('ready'); // and it is recognised as ALREADY COOKED
	expect(playbackRef(m)).toBe('derived/stems/m1-instrumental.flac'); // while still playing the instrumental
});

test('setMediaLyrics attaches the align artifact uri, and no-ops without one', () => {
	const d = deps();
	d.mediaById.set('m1', media('m1'));
	expect(setMediaLyrics('m1', 'lyrics/m1-aligned.json', d.mediaById)).toBe(true);
	expect(d.mediaById.get('m1')!.lyricsRef).toBe('lyrics/m1-aligned.json');
	// undefined uri (stems-only complete) and unknown media both no-op
	expect(setMediaLyrics('m1', undefined, d.mediaById)).toBe(false);
	expect(setMediaLyrics('ghost', 'x.json', d.mediaById)).toBe(false);
});

test('ROUND TRIP: cook → held while another plays → ready → plays at its preserved slot', () => {
	const d = deps();
	// two singers: a wants make-karaoke on m1 (queued first → seq 0), b has an already-cooked m2
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

	requestMakeKaraoke('m1', d); // m1 now cooking-file → held
	// while cooking, the soonest PLAYABLE is q-b (q-a is held even though its seq is lower)
	expect(nextPlayable(d.state.entries, d.mediaById).next?.id).toBe('q-b');
	const held = nextPlayable(d.state.entries, d.mediaById).held.map((e) => e.id);
	expect(held).toContain('q-a');

	// stems finish — but the cook is fetch → stems → ALIGN, so the song is not finished yet and q-a
	// keeps yielding its turn. This is the gate doing its job: rotation waits for the whole cook.
	markMediaReady('m1', d.mediaById);
	// The same stems job also emits the song profile (the third artifact); model that so the stems gate
	// is genuinely satisfied and only the lyrics gate is left holding q-a's slot.
	d.mediaById.get('m1')!.songProfile = { ...EMPTY_SONG_PROFILE };
	expect(nextPlayable(d.state.entries, d.mediaById).next?.id).toBe('q-b');
	expect(nextPlayable(d.state.entries, d.mediaById).held.map((e) => e.id)).toContain('q-a');

	// lyrics land → every required gate satisfied → q-a is playable again AT its fair position
	// (seq 0, before q-b), which is the whole point of the held slot.
	d.mediaById.get('m1')!.lyricsStatus = 'ready';
	expect(nextPlayable(d.state.entries, d.mediaById).next?.id).toBe('q-a');
});

// ── dedupe to already-separated stems (the durable catalog's payoff) ────────────────────

test('isCooked is true only when a ready status has an instrumental to show for it', () => {
	expect(
		isCooked(
			media('m1', { stemStatus: 'ready', lyricsStatus: 'ready', instrumentalRef: 'derived/stems/i-instrumental.flac' })
		)
	).toBe(true);
	expect(isCooked(media('m1', { stemStatus: 'queued' }))).toBe(false);
	// status ran ahead of the artifact — playing this would hand the TV an empty source
	expect(isCooked(media('m1', { stemStatus: 'ready', lyricsStatus: 'ready' }))).toBe(false);
	expect(isCooked(media('m1'))).toBe(false);
});

test('cookState distinguishes unknown / playing / ready / cooking / cookable', () => {
	const d = deps();
	expect(cookState('ghost', d)).toBe('unknown');

	d.mediaById.set('plain', media('plain'));
	expect(cookState('plain', d)).toBe('cookable');

	d.mediaById.set(
		'done',
		media('done', { stemStatus: 'ready', lyricsStatus: 'ready', instrumentalRef: 'derived/stems/i-instrumental.flac' })
	);
	expect(cookState('done', d)).toBe('ready');

	d.mediaById.set('wip', media('wip', { stemStatus: 'queued' }));
	expect(cookState('wip', d)).toBe('cooking');

	// the live song outranks everything else — never yank the running video
	d.state.applyQueueOp({ op: 'add', entry: entry('q1', 'plain') });
	d.state.setPlayback({ currentEntryId: 'q1', isPlaying: true });
	expect(cookState('plain', d)).toBe('playing');
});

test('an already-cooked song is NEVER re-cooked (no second job, no wasted separation)', () => {
	const d = deps();
	// exactly the shape hydrated from disk on boot: file + ready + the instrumental key + the profile
	d.mediaById.set(
		'm1',
		media('m1', {
			stemStatus: 'ready',
			lyricsStatus: 'ready',
			instrumentalRef: instrumentalKey('m1'),
			songProfile: { ...EMPTY_SONG_PROFILE }
		})
	);

	expect(requestMakeKaraoke('m1', d)).toBeNull();
	expect(d.jobs.listByStatus('queued')).toHaveLength(0);
	// and the media is left exactly as it was — still pointing at its existing instrumental
	const m = d.mediaById.get('m1')!;
	expect(m.stemStatus).toBe('ready');
	expect(m.instrumentalRef).toBe(instrumentalKey('m1'));
	// a ready file entry is immediately playable, so re-queueing it skips the worker entirely
	expect(isEntryReady(entry('q', 'm1'), d.mediaById)).toBe(true);
});

test('RESTART ROUND TRIP: cook, "restart" with the catalog rehydrated, re-request → zero jobs', () => {
	const d = deps();
	d.mediaById.set('m1', media('m1'));
	expect(requestMakeKaraoke('m1', d)).not.toBeNull(); // night one: cooked
	markMediaReady('m1', d.mediaById);

	// night two: fresh job repo + a catalog hydrated from the durable row (same media object shape)
	const d2 = deps();
	d2.mediaById.set('m1', { ...d.mediaById.get('m1')! });
	expect(requestMakeKaraoke('m1', d2)).toBeNull();
	expect(d2.jobs.listByStatus('queued')).toHaveLength(0);
});

test('a reused ALREADY-READY job reconciles the media instead of deadlocking rotation', () => {
	// Regression: the dedup index counts `ready` as live, so enqueue can return a finished job. If the
	// media were left cooking against it, no worker would ever run and the entry would be held out of
	// rotation forever — the song silently never plays. Found by the durable-catalog restart harness.
	const d = deps();
	d.mediaById.set('m1', media('m1'));
	const first = requestMakeKaraoke('m1', d)!;
	d.jobs.assign(first.id, 'w1', T0 + 1000, T0);
	d.jobs.accept(first.id, T0 + 2000, T0);
	d.jobs.complete(first.id, T0);
	expect(d.jobs.byId(first.id)!.status).toBe('ready');

	// the media's ready flags are lost (a stub overwrote the runtime entry) → request again
	d.mediaById.set('m1', media('m1'));
	const second = requestMakeKaraoke('m1', d)!;
	expect(second.id).toBe(first.id); // deduped to the finished job
	const m = d.mediaById.get('m1')!;
	expect(m.stemStatus).toBe('ready'); // NOT left 'queued'
	expect(m.instrumentalRef).toBe(instrumentalKey('m1'));
	// The instrumental came back on reconcile; in the durable flow the sidecar restores the song
	// profile alongside it (the third stems artifact), so the stems gate is genuinely complete. Model
	// that restore here so pendingGates reflects the real remaining work rather than a test-only gap.
	m.songProfile = { ...EMPTY_SONG_PROFILE };
	// The deadlock is gone: the separation gate is satisfied, so nothing is waiting on a job that will
	// never run. What remains is the ORDINARY wait for the rest of the cook — assert that precisely,
	// rather than asserting playability, which now also depends on the lyrics gate.
	expect(pendingGates(m).map((g) => g.id)).toEqual(['lyrics']);
	m.lyricsStatus = 'ready';
	expect(isEntryReady(entry('q', 'm1'), d.mediaById)).toBe(true); // playable, not held forever
});

// ── settleStemsGate: a dead separation must not leave the song reading as in-flight ──────────────
// The twin of settleLyricsGate, and it was missing. A terminal stems failure left stemStatus at its
// mid-flight value, so isCooking stayed true and cookState answered 'cooking' — the song read as
// "Making karaoke…" forever AND refused a retry. One worker OOM, permanently unsingable.

test('a permanently failed separation settles back to un-cooked, so it can be retried', () => {
	const d = deps();
	d.mediaById.set('m1', media('m1', { stemStatus: 'queued' }));

	// Before: stuck cooking, and requestMakeKaraoke dedupes to the phantom cook rather than retrying.
	expect(cookState('m1', d)).toBe('cooking');

	expect(settleStemsGate('m1', d.mediaById)).toBe(true);
	expect(d.mediaById.get('m1')!.stemStatus).toBe('none');
	expect(cookState('m1', d)).toBe('cookable');
	expect(requestMakeKaraoke('m1', d)).not.toBeNull(); // the retry is a real action
});

test('settling never walks a FINISHED cook backwards', () => {
	const d = deps();
	// A failed lyrics upgrade on an already-separated song must not throw away the instrumental.
	d.mediaById.set('m1', media('m1', { stemStatus: 'ready', instrumentalRef: 'derived/stems/m1-instrumental.flac' }));
	expect(settleStemsGate('m1', d.mediaById)).toBe(false);
	expect(d.mediaById.get('m1')!.stemStatus).toBe('ready');
	expect(isCooked(d.mediaById.get('m1')!)).toBe(true);
});

test('settling an unknown media is a no-op, not a crash', () => {
	const d = deps();
	expect(settleStemsGate('nope', d.mediaById)).toBe(false);
});

// ── FIX 2: a single guest cannot flood the worker fleet with unbounded concurrent cooks ───────────
// requestMakeKaraoke deduped on stems-existence alone, so one phone tapping Sing down a search page
// enqueued a 1–2 min GPU job per distinct song. The cap bounds only what is cooking AT ONCE, per
// singer — a lifetime quota would wrongly punish a guest whose earlier songs already finished.

function cook(d: ReturnType<typeof deps>, id: string, singerId: string) {
	d.mediaById.set(id, media(id));
	d.state.applyQueueOp({ op: 'add', entry: entry('q-' + id, id, singerId) });
	return requestMakeKaraoke(id, d, singerId);
}

test('countInFlightCooks counts a singer’s distinct cooking songs, not finished or others’', () => {
	const d = deps();
	cook(d, 'm1', 'alice');
	cook(d, 'm2', 'alice');
	expect(countInFlightCooks('alice', d)).toBe(2);
	// bob's cook does not count against alice
	cook(d, 'm3', 'bob');
	expect(countInFlightCooks('alice', d)).toBe(2);
	// a finished cook drops out of the in-flight count
	markMediaReady('m1', d.mediaById);
	d.mediaById.get('m1')!.songProfile = { ...EMPTY_SONG_PROFILE };
	expect(countInFlightCooks('alice', d)).toBe(1);
});

test('a singer at the cap is refused a NEW cook (over-limit), and the count is honest', () => {
	const d = deps();
	for (let i = 0; i < MAX_CONCURRENT_COOKS_PER_SINGER; i++) cook(d, 'm' + i, 'alice');
	expect(countInFlightCooks('alice', d)).toBe(MAX_CONCURRENT_COOKS_PER_SINGER);

	// One more distinct song → refused.
	d.mediaById.set('over', media('over'));
	d.state.applyQueueOp({ op: 'add', entry: entry('q-over', 'over', 'alice') });
	expect(cookState('over', d, 'alice')).toBe('over-limit');
	expect(requestMakeKaraoke('over', d, 'alice')).toBeNull();
	expect(d.mediaById.get('over')!.stemStatus).toBe('none'); // never flipped to cooking
});

test('the cap is PER singer and only bounds concurrency — another singer and a freed slot both proceed', () => {
	const d = deps();
	for (let i = 0; i < MAX_CONCURRENT_COOKS_PER_SINGER; i++) cook(d, 'm' + i, 'alice');
	// A different singer is unaffected.
	expect(cookState('m0', d, 'bob')).not.toBe('over-limit'); // (m0 is already cooking, so 'cooking')
	d.mediaById.set('bobsong', media('bobsong'));
	d.state.applyQueueOp({ op: 'add', entry: entry('q-bob', 'bobsong', 'bob') });
	expect(requestMakeKaraoke('bobsong', d, 'bob')).not.toBeNull();

	// alice finishes one → she can cook again (not a lifetime quota).
	markMediaReady('m0', d.mediaById);
	d.mediaById.get('m0')!.songProfile = { ...EMPTY_SONG_PROFILE };
	d.mediaById.set('again', media('again'));
	d.state.applyQueueOp({ op: 'add', entry: entry('q-again', 'again', 'alice') });
	expect(requestMakeKaraoke('again', d, 'alice')).not.toBeNull();
});

test('an anonymous request (no singerId) imposes no cap — internal callers are never blocked', () => {
	const d = deps();
	for (let i = 0; i < MAX_CONCURRENT_COOKS_PER_SINGER + 2; i++) {
		d.mediaById.set('n' + i, media('n' + i));
		d.state.applyQueueOp({ op: 'add', entry: entry('qn' + i, 'n' + i, 'alice') });
		expect(requestMakeKaraoke('n' + i, d)).not.toBeNull(); // no singerId → no cap
	}
});

test('re-tapping a song already cooking is never counted against its own owner (dedup, not a block)', () => {
	const d = deps();
	// alice fills the cap, then re-taps one of her own cooking songs.
	for (let i = 0; i < MAX_CONCURRENT_COOKS_PER_SINGER; i++) cook(d, 'm' + i, 'alice');
	// m0 is already cooking; a repeat request dedupes to the same job rather than being refused.
	const again = requestMakeKaraoke('m0', d, 'alice');
	expect(again).not.toBeNull();
	expect(cookState('m0', d, 'alice')).toBe('cooking'); // not 'over-limit'
});

// ── the cap must hold when the singer's queue ADD was dropped over a reconnecting socket ─────
// The add (WebSocket) and the cook (HTTP) ride different transports and only the add is droppable.
// A phone that taps Sing while its socket is not OPEN buffers the add client-side but the cook POST
// still lands, so NO queue entry exists for these cooks. The old cap derived its count from
// `state.entries`, saw ZERO, and admitted every tap — a full cap bypass. The count is now derived
// from the job ledger (the thing being bounded), which does not depend on the second transport.
// NOTE: `cook()` is not used here on purpose — it adds an entry, which is exactly the transport that
// is absent in this window. We call requestMakeKaraoke WITHOUT ever touching state.entries.
test('the per-singer cap holds even when NO queue entry exists (dropped add over a reconnecting socket)', () => {
	const d = deps();
	// alice taps Sing on MAX distinct songs while her socket is reconnecting: the cook lands, the
	// add never does, so state.entries stays empty for all of them.
	for (let i = 0; i < MAX_CONCURRENT_COOKS_PER_SINGER; i++) {
		d.mediaById.set('m' + i, media('m' + i));
		expect(requestMakeKaraoke('m' + i, d, 'alice')).not.toBeNull();
	}
	expect(d.state.entries).toHaveLength(0); // the whole point: no entries were ever added
	// Ledger-derived count is honest despite the empty queue.
	expect(countInFlightCooks('alice', d)).toBe(MAX_CONCURRENT_COOKS_PER_SINGER);

	// One more distinct tap in the same window → MUST be refused. Under the entry-derived cap this
	// admitted the burst (count was 0); the ledger-derived cap refuses it.
	d.mediaById.set('over', media('over'));
	expect(cookState('over', d, 'alice')).toBe('over-limit');
	expect(requestMakeKaraoke('over', d, 'alice')).toBeNull();
	expect(d.mediaById.get('over')!.stemStatus).toBe('none'); // never flipped to cooking
});

test('a dropped-add cook is attributed to its requester in the ledger, and only to them', () => {
	const d = deps();
	// No entries added — pure HTTP cook, socket down.
	d.mediaById.set('a1', media('a1'));
	requestMakeKaraoke('a1', d, 'alice');
	d.mediaById.set('b1', media('b1'));
	requestMakeKaraoke('b1', d, 'bob');
	expect(countInFlightCooks('alice', d)).toBe(1); // alice's cook counts for alice
	expect(countInFlightCooks('bob', d)).toBe(1); // and bob's for bob
	// The cook job carries the attribution even with an empty queue.
	const aliceJob = d.jobs.listByStatus('queued').find((j) => j.mediaId === 'a1');
	expect(aliceJob!.singerId).toBe('alice');
});

test('a spotify-sourced media is refused a cook (search-only; audio comes from YouTube)', () => {
	// Cooking a spotify media would enqueue a fetch that forms youtube.com/watch?v=<spotify-track-id>
	// and die at ffmpeg — the shape-inference bug the fetcher registry exists to kill. Spotify
	// is a metadata source only; the singer queues the YouTube result instead.
	const d = deps();
	const m = media('sp1', { source: 'spotify', sourceRef: '4uLU6hMCjMI75M1A2tKUQC' });
	d.mediaById.set('sp1', m);
	expect(requestMakeKaraoke('sp1', d)).toBeNull();
	expect(m.stemStatus).toBe('none'); // never flipped to queued
});

// setMediaGuideOffset stores a measured guide/instrumental offset, value-or-nothing. It must
// write a finite number (0 included), and must NOT wipe an existing measurement when the wire carries
// no number — the stems-upgrade case where a declined re-measure arrives as undefined.
test('setMediaGuideOffset stores a finite offset (0 included) and coerces to a whole ms', () => {
	const mediaById = new Map<string, Media>();
	const m = media('go1', { stemStatus: 'ready', instrumentalRef: 'stems/go1-instrumental.flac', vocalsRef: 'stems/go1-vocals.flac' });
	mediaById.set('go1', m);
	expect(setMediaGuideOffset('go1', 30.4, mediaById)).toBe(true);
	expect(m.guideOffsetMs).toBe(30); // rounded to whole ms
	expect(setMediaGuideOffset('go1', 0, mediaById)).toBe(true);
	expect(m.guideOffsetMs).toBe(0); // a measured 0 is stored, not treated as "no value"
	expect(setMediaGuideOffset('go1', -25, mediaById)).toBe(true);
	expect(m.guideOffsetMs).toBe(-25);
});

test('setMediaGuideOffset leaves an existing offset untouched on a non-number (declined re-measure)', () => {
	const mediaById = new Map<string, Media>();
	const m = media('go2', { guideOffsetMs: 42 });
	mediaById.set('go2', m);
	// undefined (the wire carries no field), null, NaN, and a non-number all leave the stored value as-is
	// rather than wiping it — the refused-upgrade / older-worker case.
	expect(setMediaGuideOffset('go2', undefined, mediaById)).toBe(false);
	expect(setMediaGuideOffset('go2', null, mediaById)).toBe(false);
	expect(setMediaGuideOffset('go2', NaN, mediaById)).toBe(false);
	expect(setMediaGuideOffset('go2', 'nope', mediaById)).toBe(false);
	expect(m.guideOffsetMs).toBe(42);
});

test('setMediaGuideOffset is a no-op for an unknown media id', () => {
	const mediaById = new Map<string, Media>();
	expect(setMediaGuideOffset('missing', 30, mediaById)).toBe(false);
});
