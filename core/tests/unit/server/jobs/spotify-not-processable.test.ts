// Spotify is a SEARCH / metadata source only: its bytes are never pulled, so no process can run for one of its hits.
// Enforcing that inside `requestProcess` alone was TOO LATE while Sing was queue-first — `processState` answered
// 'processable', the phone offered Sing, and the turn was taken before the refusal landed. Sing is process-first now
// and books no turn on a refusal, but the affordance gate is still the first line. Such a turn sat in the rotation
// with nothing that could make it ready and no failure event, because no job was ever enqueued to fail. So the
// refusal must be visible at `processState`, the designated answer. Reachable only with SPOTIFY_CLIENT_ID/SECRET set; these tests construct the materialized media such a box persists on every query.
import { test, expect } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { requestProcess, processState, type ProcessDeps } from '$lib/server/jobs/process';
import { JobRepository } from '$lib/server/jobs/repository';
import { AuthoritativeState } from '$lib/server/state/store';
import { nextPlayable } from '$lib/server/rotation';
import { processAndQueue } from '$lib/process-and-queue';
import { canProcess, readinessOf } from '$lib/readiness';
import { isProcessableSource, fetcherFor, DEFAULT_FETCHER, METADATA_ONLY_SOURCES } from '$lib/contract';
import type { Media, QueueEntry } from '$lib/contract';

const T0 = 1_700_000_000_000;
/** A real Spotify track id, as the resolver materializes it (parseSpotifySearchJson → resultToMedia). */
const SPOTIFY_TRACK_ID = '4uLU6hMCjMI75M1A2tKUQC';

const media = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'vid-' + id,
	title: id,
	durationSec: 200,
	stemStatus: 'none',
	...over
});
const spotifyMedia = (id = 'sp1'): Media =>
	media(id, { source: 'spotify', sourceRef: SPOTIFY_TRACK_ID, title: 'Take On Me' });

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

test('processState answers not-processable for a Spotify media (it answered processable)', () => {
	// `requestProcess` tells callers to ask processState to tell its refusals apart, so a refusal missing
	// from processState lets every caller act as though a process were about to start.
	const d = deps();
	d.mediaById.set('sp1', spotifyMedia());
	expect(processState('sp1', d)).toBe('not-processable');
});

test('CONTROL: an identical YouTube media still answers processable (not vacuous)', () => {
	// Non-vacuity: without this, answering 'not-processable' for EVERYTHING passes the arm above. The two
	// media differ only in `source`.
	const d = deps();
	d.mediaById.set('yt1', media('yt1', { title: 'Take On Me' }));
	expect(processState('yt1', d)).toBe('processable');
});

test('the verdict is a property of the SONG, not of room state', () => {
	// Answered AHEAD of playing/ready/over-limit, because those are states a song passes through and this
	// one it can never leave: reported as 'playing', a caller reads a transient refusal and retries forever.
	const d = deps();
	d.mediaById.set('sp1', spotifyMedia());
	d.state.applyQueueOp({ op: 'add', entry: entry('q1', 'sp1') });
	d.state.playback.currentEntryId = 'q1';
	expect(processState('sp1', d)).toBe('not-processable');
});

test('requestProcess still refuses, and now refuses OFF THE STATE', () => {
	// The refusal must be unchanged from the caller's point of view: null, and the media never flipped to `queued` — a
	// flip with no job is its own deadlock, with rotation holding a slot for a process that will never run.
	const d = deps();
	const m = spotifyMedia();
	d.mediaById.set('sp1', m);
	expect(requestProcess('sp1', d)).toBeNull();
	expect(m.stemStatus).toBe('none');
	// Nothing enqueued, so there is no job that could later fail and settle the gate.
	expect(d.jobs.listByStatus('queued')).toHaveLength(0);
});

/** The page's shape: `process` resolves whether the process started, and the add runs only on true. */
function sing(d: ReturnType<typeof deps>, entryId: string, mediaId: string): Promise<void> {
	return processAndQueue({
		mediaId,
		inFlight: new Set(),
		process: async () => requestProcess(mediaId, d) !== null,
		queue: () => void d.state.applyQueueOp({ op: 'add', entry: entry(entryId, mediaId) })
	});
}

test('the singer keeps their turn: a Sing tap on a Spotify row books NOTHING', async () => {
	// End-to-end through the REAL pieces the phone uses: the affordance gate `canProcess`, the process-first
	// `processAndQueue`, the authoritative state and rotation. Asserted as a DIFFERENCE between the two rows
	// deliberately: a `canProcess` that cannot see the media withholds BOTH affordances, so `expect(spOffered).toBe(false)`
	// alone would pass for the wrong reason. The claim is that a metadata-only hit is told apart from a YouTube upload.
	const d = deps();
	const sp = spotifyMedia();
	const yt = media('yt1');
	d.mediaById.set('sp1', sp);
	d.mediaById.set('yt1', yt);

	// Same readiness on both, so `source` is the only thing that can separate them.
	expect(readinessOf(sp)).toBe(readinessOf(yt));
	const spOffered = canProcess(sp, readinessOf(sp));
	const ytOffered = canProcess(yt, readinessOf(yt));
	expect(spOffered).not.toBe(ytOffered); // ← base cannot tell them apart at all
	expect(spOffered).toBe(false);

	// The `if` IS the production shape: `onmake` is only wired when canProcess says so, so a false verdict
	// means the tap is unreachable.
	if (spOffered) await sing(d, 'q1', 'sp1');

	// No turn taken, so nothing for rotation to hold. With the affordance offered this reads
	// { next: null, held: ['q1'] }: a turn skipped on every pass that no event can ever make ready,
	// because no job exists to fail, complete or be cancelled.
	const { next, held } = nextPlayable(d.state.entries, d.mediaById);
	expect(d.state.entries).toHaveLength(0);
	expect(held).toHaveLength(0);
	expect(next).toBeNull();
});

test('a Sing that reaches a refused process anyway (a stale phone) still books no turn', async () => {
	// Behind the affordance gate: a phone that drew Sing before the gate existed. Queue-first left a turn here that
	// rotation held forever; process-first asks first and adds nothing on the refusal.
	const d = deps();
	d.mediaById.set('sp1', spotifyMedia());
	await sing(d, 'q1', 'sp1');
	expect(d.state.entries).toHaveLength(0);
	expect(nextPlayable(d.state.entries, d.mediaById).held).toHaveLength(0);
});

test('CONTROL: the same tap on a YouTube row DOES take the turn and start the process', async () => {
	// The ordinary path must stay open: same harness, one field different, which is what proves the arm
	// above discriminates on `source` rather than on the harness refusing to do anything.
	const d = deps();
	const yt = media('yt1');
	d.mediaById.set('yt1', yt);

	const offered = canProcess(yt, readinessOf(yt));
	expect(offered).toBe(true);
	if (offered) await sing(d, 'q1', 'yt1');

	expect(d.state.entries).toHaveLength(1);
	expect(yt.stemStatus).toBe('queued');
	expect(d.jobs.listByStatus('queued')).toHaveLength(1);
	// Held, but behind a process that is actually RUNNING — the slot is kept so the singer keeps their fair
	// position. The difference from a Spotify row: something exists that will release the hold.
	expect(nextPlayable(d.state.entries, d.mediaById).held.map((e) => e.id)).toEqual(['q1']);
});

test('isProcessableSource is the one authority, and the fetcher floor is deliberately unchanged', () => {
	// The rule lives in ONE place, or it drifts back into several assertions and one enforcement.
	// `fetcherFor('spotify')` returning the default downloader is CORRECT — a floor that keeps the return
	// type total — so asserting it differs from DEFAULT_FETCHER would pin the opposite of the design.
	expect(isProcessableSource('spotify')).toBe(false);
	expect(isProcessableSource('youtube')).toBe(true);
	expect(isProcessableSource('local')).toBe(true);
	expect(fetcherFor('spotify')).toBe(DEFAULT_FETCHER);
	// The predicate refuses every metadata-only source, so adding one to the set is enough.
	for (const s of METADATA_ONLY_SOURCES) expect(isProcessableSource(s)).toBe(false);
	expect(METADATA_ONLY_SOURCES).toContain('spotify');
});
