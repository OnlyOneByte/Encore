// Guards: tapping Sing on a Spotify search hit booked a turn that could never play.
//
// The ratified rule (docs/DECISIONS.md) is that Spotify is a SEARCH / metadata source only: its bytes
// are never pulled, so no cook can ever run for one of its hits. That rule was ENFORCED at exactly one
// point — a `media.source === 'spotify'` line inside `requestMakeKaraoke` — and ASSERTED at five
// others. Enforcement there is too late to help: `cookState` still answered `'cookable'`, so the phone
// offered Sing, `cookAndQueue` took the singer's turn (queue first, cook second, by design), and only
// THEN was the cook refused. The turn was left in the rotation with nothing that could ever make it
// ready — held and skipped on every pass for the rest of the night, with no failure event, because no
// job was ever enqueued to fail.
//
// These guards pin the fix at the layer that answers the question: `cookState` is the designated
// answer (`requestMakeKaraoke`'s own docstring says so), so the refusal has to be visible THERE.
//
// SCOPE: reachable only on a deployment with SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET set — with them
// unset the resolver returns [] and no spotify media is ever materialized. These tests construct the
// materialized media directly, which is what the configured-Spotify box produces on every query
// (routes/api/search/+server.ts persists every hit as a durable, queueable Media).
import { test, expect } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { requestMakeKaraoke, cookState, type MakeKaraokeDeps } from '$lib/server/jobs/make-karaoke';
import { JobRepository } from '$lib/server/jobs/repository';
import { AuthoritativeState } from '$lib/server/state/store';
import { nextPlayable } from '$lib/server/rotation/index';
import { cookAndQueue } from '$lib/cook-and-queue';
import { canCook, readinessOf } from '$lib/readiness';
import { isCookableSource, fetcherFor, DEFAULT_FETCHER, METADATA_ONLY_SOURCES } from '$shared';
import type { Media, QueueEntry } from '$shared';

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

function deps(): MakeKaraokeDeps & { mediaById: Map<string, Media> } {
	const db = migratedDb();
	return { jobs: new JobRepository(db), mediaById: new Map(), state: new AuthoritativeState(), now: () => T0 };
}

test('cookState answers not-cookable for a Spotify media (it answered cookable)', () => {
	// THE base-red assertion the issue names. `requestMakeKaraoke`'s docstring tells callers to ask
	// cookState to tell its refusals apart; for this refusal that promise was false, which is what let
	// every caller act as though a cook were about to start.
	const d = deps();
	d.mediaById.set('sp1', spotifyMedia());
	expect(cookState('sp1', d)).toBe('not-cookable');
});

test('CONTROL: an identical YouTube media still answers cookable (not vacuous)', () => {
	// Without this, a fix that made cookState answer 'not-cookable' for EVERYTHING would pass the
	// assertion above. The two media differ only in `source`.
	const d = deps();
	d.mediaById.set('yt1', media('yt1', { title: 'Take On Me' }));
	expect(cookState('yt1', d)).toBe('cookable');
});

test('the verdict is a property of the SONG, not of room state', () => {
	// Answered ahead of playing/ready/over-limit deliberately: those are states a song passes THROUGH,
	// and this one it can never leave. A Spotify media that somehow held the current slot must still
	// report not-cookable rather than 'playing', or a caller reading the state would treat it as a
	// transient refusal and retry forever.
	const d = deps();
	d.mediaById.set('sp1', spotifyMedia());
	d.state.applyQueueOp({ op: 'add', entry: entry('q1', 'sp1') });
	d.state.playback.currentEntryId = 'q1';
	expect(cookState('sp1', d)).toBe('not-cookable');
});

test('requestMakeKaraoke still refuses, and now refuses OFF THE STATE', () => {
	// Behaviour-preserving half: the standalone `media.source === 'spotify'` check moved up into
	// cookState, so the refusal must be unchanged from the caller's point of view — null, and the media
	// never flipped to `queued` (a flip with no job is its own deadlock: rotation holds the slot for a
	// cook that will never run).
	const d = deps();
	const m = spotifyMedia();
	d.mediaById.set('sp1', m);
	expect(requestMakeKaraoke('sp1', d)).toBeNull();
	expect(m.stemStatus).toBe('none');
	// …and nothing was enqueued, so there is no job that could later fail and settle the gate.
	expect(d.jobs.listByStatus('queued')).toHaveLength(0);
});

test('the singer keeps their turn: a Sing tap on a Spotify row books NOTHING', () => {
	// The END-TO-END trigger from the issue, driven through the REAL pieces the phone uses: the
	// affordance gate (`canCook`, from the four SongRow `onmake` sites), the real `cookAndQueue`
	// queue-first ordering, and the real authoritative state + rotation.
	//
	// HOW THIS REDS ON BASE, and why it is asserted as a DIFFERENCE. Base's `canCook` takes only a
	// Readiness — it has no parameter for the media — so a 2-argument call is not something base can
	// answer: the extra argument is dropped and `r === 'unacquired'` is compared against a Media object,
	// which is falsy for BOTH rows. So `expect(spOffered).toBe(false)` would pass on base for entirely
	// the wrong reason (the classic trap: a test that cannot detect the thing it is for). The honest
	// assertion is that the two rows are told APART — on base they are not, in either direction, which
	// is the whole defect: readiness cannot see `source`, so a metadata-only hit reads exactly like a
	// fresh YouTube upload.
	const d = deps();
	const sp = spotifyMedia();
	const yt = media('yt1');
	d.mediaById.set('sp1', sp);
	d.mediaById.set('yt1', yt);

	// Same readiness on both — 'unacquired' — so `source` is the only thing that can separate them.
	expect(readinessOf(sp)).toBe(readinessOf(yt));
	const spOffered = canCook(sp, readinessOf(sp));
	const ytOffered = canCook(yt, readinessOf(yt));
	expect(spOffered).not.toBe(ytOffered); // ← base cannot tell them apart at all
	expect(spOffered).toBe(false);

	// The `if` is not test scaffolding — it IS the production shape: `onmake` is only wired when
	// canCook says so, so a false verdict means the tap is unreachable.
	if (spOffered) {
		// Same shape the page uses: both steps are void, so the cook's return is discarded exactly as
		// `cook: () => void makeKaraoke(mediaId)` discards it there.
		cookAndQueue<void>({
			queue: () => void d.state.applyQueueOp({ op: 'add', entry: entry('q1', 'sp1') }),
			cook: () => void requestMakeKaraoke('sp1', d)
		});
	}

	// No turn taken → nothing for rotation to hold. With the affordance offered (base) this read
	// { next: null, held: ['q1'] }: a turn in the queue, skipped on every pass, that no event could
	// ever make ready — because no job exists to fail, complete, or be cancelled.
	const { next, held } = nextPlayable(d.state.entries, d.mediaById);
	expect(d.state.entries).toHaveLength(0);
	expect(held).toHaveLength(0);
	expect(next).toBeNull();
});

test('CONTROL: the same tap on a YouTube row DOES take the turn and start the cook', () => {
	// The fix must not close the ordinary path. Same harness, one field different — this is what proves
	// the guard above discriminates on `source` rather than on the harness refusing to do anything.
	// Also base-red on its own: base's one-parameter `canCook` cannot answer a call that names the
	// media, so the ordinary Sing affordance reads as withheld.
	const d = deps();
	const yt = media('yt1');
	d.mediaById.set('yt1', yt);

	const offered = canCook(yt, readinessOf(yt));
	expect(offered).toBe(true);
	if (offered) {
		// Same shape the page uses: both steps are void, so the cook's return is discarded exactly as
		// `cook: () => void makeKaraoke(mediaId)` discards it there.
		cookAndQueue<void>({
			queue: () => void d.state.applyQueueOp({ op: 'add', entry: entry('q1', 'yt1') }),
			cook: () => void requestMakeKaraoke('yt1', d)
		});
	}

	expect(d.state.entries).toHaveLength(1);
	expect(yt.stemStatus).toBe('queued');
	expect(d.jobs.listByStatus('queued')).toHaveLength(1);
	// It IS held — but held behind a cook that is actually running, which is the designed behaviour
	// (the slot is kept so the singer keeps their fair position). That is the difference between this
	// row and a Spotify one: here something exists that will release the hold.
	expect(nextPlayable(d.state.entries, d.mediaById).held.map((e) => e.id)).toEqual(['q1']);
});

test('isCookableSource is the one authority, and the fetcher floor is deliberately unchanged', () => {
	// The rule has to live in ONE place or it drifts back into five assertions and one enforcement.
	// `fetcherFor('spotify')` still returning the default downloader is CORRECT and must not become the
	// guard: it is a floor that keeps the return type total, and the issue says so explicitly. Asserting
	// `fetcherFor('spotify') !== DEFAULT_FETCHER` would pin the opposite of the ratified design.
	expect(isCookableSource('spotify')).toBe(false);
	expect(isCookableSource('youtube')).toBe(true);
	expect(isCookableSource('local')).toBe(true);
	expect(fetcherFor('spotify')).toBe(DEFAULT_FETCHER);
	// Every metadata-only source is refused by the predicate — so adding one to the set is enough.
	for (const s of METADATA_ONLY_SOURCES) expect(isCookableSource(s)).toBe(false);
	expect(METADATA_ONLY_SOURCES).toContain('spotify');
});
