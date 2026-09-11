// The `guide` player command sets the GUIDING TRACK level — how loud the isolated original vocals
// sit under the instrumental. Clamped to [0,1]; `null` clears the per-song override so the room
// default applies again. No-op unless the song actually has a vocals stem to mix.
//
// The reset semantics are the point of these tests: guideLevel resets to NULL (inherit) on a song
// change, not to 0, and it must reset at EVERY song-start site — the state object is long-lived and
// reset field-by-field, so a site that forgets a field leaks it into the next song.
import { test, expect } from 'bun:test';
import { handlePlayerCommand, reconcileOnReady } from './player';
import { AuthoritativeState } from '../state/store';
import { type HubDeps } from './hub';
import { type Media, type QueueEntry, type ServerEvent } from '@encore/shared';
import { EMPTY_SONG_PROFILE } from '@encore/shared';

let _s = 0;
const entry = (id: string, mediaId: string): QueueEntry => ({
	id,
	mediaId,
	singerId: 's1',
	status: 'queued',
	rotationSeq: -1,
	addedAt: ++_s
});
const media = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'x',
	title: id,
	durationSec: 100,
	stemStatus: 'none',
	...over
});

const PROCESSED = {
	stemStatus: 'ready' as const,
	lyricsStatus: 'ready' as const,
	instrumentalRef: 'derived/stems/m-instrumental.flac',
	songProfile: EMPTY_SONG_PROFILE
};

function harness() {
	const published: ServerEvent[] = [];
	const state = new AuthoritativeState();
	const deps: HubDeps = {
		state,
		publish: (e) => published.push(e),
		mediaById: new Map<string, Media>([
			// a full process: instrumental AND vocals → can offer a guiding track
			['m-guide', media('m-guide', { ...PROCESSED, vocalsRef: 'derived/stems/m-guide-vocals.m4a' })],
			// processed but no vocals ref (separated before the ref was persisted, or the stem was silent)
			['m-novocals', media('m-novocals', PROCESSED)],
			// not processed at all
			['m-raw', media('m-raw')]
		])
	};
	return { published, state, deps };
}

test('guide sets the level on a song that has a vocals stem, and broadcasts', () => {
	const { state, deps, published } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm-guide') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	published.length = 0;

	handlePlayerCommand({ cmd: 'guide', level: 0.15 }, deps);
	expect(state.playback.guideLevel).toBe(0.15);
	expect(published.some((e) => e.type === 'playback:state')).toBe(true);

	// absolute target, not a delta
	handlePlayerCommand({ cmd: 'guide', level: 0.6 }, deps);
	expect(state.playback.guideLevel).toBe(0.6);
});

test('guide clamps to [0,1] and rounds to whole percent', () => {
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm-guide') });
	handlePlayerCommand({ cmd: 'play' }, deps);

	handlePlayerCommand({ cmd: 'guide', level: 99 }, deps);
	expect(state.playback.guideLevel).toBe(1);
	handlePlayerCommand({ cmd: 'guide', level: -5 }, deps);
	expect(state.playback.guideLevel).toBe(0);
	handlePlayerCommand({ cmd: 'guide', level: 0.12345 }, deps);
	expect(state.playback.guideLevel).toBe(0.12);
});

test('level 0 is an explicit OFF, distinct from null (inherit the room default)', () => {
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm-guide') });
	handlePlayerCommand({ cmd: 'play' }, deps);

	handlePlayerCommand({ cmd: 'guide', level: 0 }, deps);
	expect(state.playback.guideLevel).toBe(0); // pinned off for this song

	handlePlayerCommand({ cmd: 'guide', level: null }, deps);
	expect(state.playback.guideLevel).toBeNull(); // back to inheriting
});

test('guide is a no-op on a processed song with no vocals stem', () => {
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm-novocals') });
	handlePlayerCommand({ cmd: 'play' }, deps);

	handlePlayerCommand({ cmd: 'guide', level: 0.5 }, deps);
	// stays null rather than pinning a level the TV has no audio to honour
	expect(state.playback.guideLevel).toBeNull();
});

test('guide is a no-op on a song that is not playable at all', () => {
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm-raw') });
	state.setPlayback({ currentEntryId: 'q1' }); // force current (held-slot edge)

	handlePlayerCommand({ cmd: 'guide', level: 0.5 }, deps);
	expect(state.playback.guideLevel).toBeNull();
});

test('guide is a no-op when nothing is playing', () => {
	const { state, deps } = harness();
	handlePlayerCommand({ cmd: 'guide', level: 0.4 }, deps);
	expect(state.playback.guideLevel).toBeNull();
});

test('guideLevel resets to NULL (not 0) when the song changes via skip', () => {
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm-guide') });
	state.applyQueueOp({ op: 'add', entry: entry('q2', 'm-guide') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	handlePlayerCommand({ cmd: 'guide', level: 0.8 }, deps);
	expect(state.playback.guideLevel).toBe(0.8);

	handlePlayerCommand({ cmd: 'skip' }, deps);
	// null, so the room default applies to the new song. Pinning 0 here would silently strip the
	// guide from a room that set a default.
	expect(state.playback.guideLevel).toBeNull();
});

test('guideLevel resets on the play-from-idle song start', () => {
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm-guide') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	handlePlayerCommand({ cmd: 'guide', level: 0.7 }, deps);
	handlePlayerCommand({ cmd: 'skip' }, deps); // empties the room
	state.setPlayback({ guideLevel: 0.7 }); // pretend a stale value survived

	state.applyQueueOp({ op: 'add', entry: entry('q2', 'm-guide') });
	handlePlayerCommand({ cmd: 'play' }, deps); // cold start on a fresh song
	expect(state.playback.guideLevel).toBeNull();
});

test('guideLevel and keyShift both reset at the ready-reconcile song start', () => {
	// This site previously reset NEITHER field, so a song that started because its process finished
	// while the room idled inherited the previous singer's transpose.
	const { state, deps } = harness();
	state.setPlayback({ keyShift: 4, guideLevel: 0.9 });
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm-guide') });

	reconcileOnReady(deps); // room was idle; this freshly-ready song becomes current

	expect(state.playback.currentEntryId).toBe('q1');
	expect(state.playback.keyShift).toBe(0);
	expect(state.playback.guideLevel).toBeNull();
});
