// Wire-tests for the two optional HubDeps hooks that funnel core session state into the media
// trackers: `onNowPlaying` (play tracking) and `recordAdd` (popularity shortcuts). Both are wired
// in production at apps/core/server.ts (onNowPlaying: server.ts, recordAdd: server.ts), but until
// this file NO test supplied either through HubDeps — the tracker methods were exercised directly
// (plays.test.ts calls tracker.onNowPlaying(...), popularity.test.ts calls p.recordAdd(...)),
// leaving the one line that FEEDS each tracker unasserted. Each hook could be turned into a no-op
// and the whole core suite stayed byte-identical to baseline.
//
// The sibling hooks on these same paths already ARE wire-tested — `onSang` in
// queue-order-wiring.test.ts, `onEntryRemoved` by the jobs suite — so these two were the gap.
//
// Method: build HubDeps exactly as server.ts does, wiring a REAL PlayTracker / PopularityTracker
// (server.ts wires app.plays.onNowPlaying and app.popularity.recordAdd), drive the REAL command
// handlers, and assert the tracker observed the event. Mutation proof lives in the assertions:
// neutering player.ts's `deps.onNowPlaying?.(...)` reds only the play-tracking tests; removing
// hub.ts's `deps.recordAdd?.(...)` reds only the popularity tests (see the PR body for the RED runs).
import { test, expect } from 'bun:test';
import { AuthoritativeState } from '../state/store';
import { handlePlayerCommand } from './player';
import { handleQueueCommand, type HubDeps } from './hub';
import { PlayTracker } from '../media/plays';
import { createPopularityTracker } from '../media/popularity';
import type { Media, QueueEntry, ServerEvent, ClientCommand } from '@encore/shared';
import { EMPTY_SONG_PROFILE } from '@encore/shared';

const media = (id: string): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'x',
	title: id,
	durationSec: 100,
	stemStatus: 'ready',
	lyricsStatus: 'ready',
	instrumentalRef: `derived/stems/${id}-instrumental.flac`,
	songProfile: EMPTY_SONG_PROFILE
});

const entry = (id: string, singerId: string, addedAt: number, mediaId = 'm1'): QueueEntry => ({
	id,
	mediaId,
	singerId,
	status: 'queued',
	rotationSeq: -1,
	addedAt
});

/**
 * The same wiring apps/core/server.ts builds for a client socket, so these drive the ACTUAL seam
 * rather than a mock of it. `plays`/`popularity` are the REAL trackers; `onNowPlaying`/`recordAdd`
 * point at them exactly as server.ts wires app.plays.onNowPlaying / app.popularity.recordAdd.
 */
function harness() {
	const state = new AuthoritativeState();
	// Record the tracker's downstream sink — this is what proves the FEED reached it, not just that
	// the tracker exists. PlayTracker's PlaySink fires once per genuinely-new current entry.
	const playsLogged: Array<[string, string]> = [];
	const plays = new PlayTracker((mediaId, entryId) => playsLogged.push([mediaId, entryId]));
	const popularity = createPopularityTracker();
	const published: ServerEvent[] = [];
	const seen = new Set<string>();
	const deps: HubDeps = {
		state,
		publish: (e) => published.push(e),
		mediaById: new Map([
			['m1', media('m1')],
			['m2', media('m2')]
		]),
		listSingers: () => [],
		// orderingOf reads .room.queueOrder; 'fair' is the room default, matching an unwritten room.
		getSettings: () => ({ room: { queueOrder: 'fair' } }) as ReturnType<NonNullable<HubDeps['getSettings']>>,
		actorSingerId: 'ana',
		onNowPlaying: (e) => plays.onNowPlaying(e),
		recordAdd: (mediaId) => popularity.recordAdd(mediaId, ++clock),
		seenOp: (id) => {
			if (seen.has(id)) return true;
			seen.add(id);
			return false;
		},
		hasOp: (id) => seen.has(id) // non-recording peek — mirrors server.ts
	};
	let clock = 1000;
	return { state, deps, plays, playsLogged, popularity, published };
}

const add = (entryId: string, mediaId: string, clientOpId: string): ClientCommand => ({
	clientOpId,
	op: { op: 'add', entry: entry(entryId, 'ana', Number(clientOpId) || 1, mediaId) }
});

// ── Site A: play tracking (apps/core/server.ts onNowPlaying → app.plays.onNowPlaying, fed at
//    apps/core/src/server/realtime/player.ts emitNowPlaying) ──

test('play tracking: starting a song feeds the current entry through HubDeps.onNowPlaying', () => {
	const h = harness();
	h.state.applyQueueOp({ op: 'add', entry: entry('q1', 'ana', 1, 'm1') });
	// The real player command runs beginSinging + emitNowPlaying, which calls deps.onNowPlaying.
	handlePlayerCommand({ cmd: 'play' }, h.deps);
	// Mutating player.ts to `deps.onNowPlaying?.(null)` clears the tracker instead: playsLogged stays
	// empty and lastCountedEntryId stays null — this assertion is the guard.
	expect(h.playsLogged).toEqual([['m1', 'q1']]);
	expect(h.plays.lastCountedEntryId()).toBe('q1');
});

test('play tracking: advancing to the next song feeds the new entry, and only genuine changes count', () => {
	const h = harness();
	h.state.applyQueueOp({ op: 'add', entry: entry('q1', 'ana', 1, 'm1') });
	h.state.applyQueueOp({ op: 'add', entry: entry('q2', 'ana', 2, 'm2') });
	handlePlayerCommand({ cmd: 'play' }, h.deps); // starts q1
	handlePlayerCommand({ cmd: 'skip' }, h.deps); // advances to q2
	// Two distinct entries → two logged plays fed through the hook. A no-op'd hook logs nothing.
	expect(h.playsLogged).toEqual([
		['m1', 'q1'],
		['m2', 'q2']
	]);
	expect(h.plays.lastCountedEntryId()).toBe('q2');
});

// ── Site B: popularity shortcuts (apps/core/server.ts recordAdd → app.popularity.recordAdd, fed at
//    apps/core/src/server/realtime/hub.ts handleQueueCommand add path) ──

test('popularity: an accepted queue-add feeds the media id through HubDeps.recordAdd', () => {
	const h = harness();
	const patch = handleQueueCommand(add('q1', 'm1', '1'), h.deps);
	expect(patch).not.toBeNull(); // the add was accepted (baseline the hook fires from)
	// Removing hub.ts's `deps.recordAdd?.(cmd.op.entry.mediaId)` leaves popularity empty — these reds.
	expect(h.popularity.recent(6)).toEqual(['m1']);
	expect(h.popularity.popular(6)).toEqual(['m1']);
});

test('popularity: repeated adds of the same media count toward its popularity', () => {
	const h = harness();
	handleQueueCommand(add('q1', 'm1', '1'), h.deps);
	handleQueueCommand(add('q2', 'm2', '2'), h.deps);
	handleQueueCommand(add('q3', 'm1', '3'), h.deps);
	// m1 added twice, m2 once — the feed must reach the tracker for this ranking to exist at all.
	expect(h.popularity.popular(6)).toEqual(['m1', 'm2']);
});
