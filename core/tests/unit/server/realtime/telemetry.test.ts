// Ended telemetry advances rotation, picks next by seq; nowplaying carries upNext.
import { test, expect } from 'bun:test';
import { read } from '$test';
import { handlePlayerCommand, handleTelemetry, reconcileOnReady } from '$lib/server/realtime/player';
import { AuthoritativeState } from '$lib/server/state/store';
import { type HubDeps } from '$lib/server/realtime/hub';
import { type ServerEvent, type Media, type QueueEntry } from '$lib/contract';
import { EMPTY_SONG_PROFILE } from '$lib/contract';

const media = (id: string): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'x',
	title: id,
	durationSec: 100,
	stemStatus: 'ready',
	lyricsStatus: 'ready',
	instrumentalRef: 'derived/stems/i-instrumental.flac',
	songProfile: EMPTY_SONG_PROFILE
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

function harness() {
	const published: ServerEvent[] = [];
	const state = new AuthoritativeState();
	const deps: HubDeps = {
		state,
		publish: (e) => published.push(e),
		mediaById: new Map([
			['m1', media('m1')],
			['m2', media('m2')],
			['m3', media('m3')]
		])
	};
	return { published, state, deps };
}

test('ended telemetry marks current done and advances to next by seq', () => {
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	state.applyQueueOp({ op: 'add', entry: entry('q2', 'm2') });
	handlePlayerCommand({ cmd: 'play' }, deps); // q1 playing
	expect(state.playback.currentEntryId).toBe('q1');

	handleTelemetry({ entryId: 'q1', positionSec: 100, ended: true }, deps);
	expect(state.playback.currentEntryId).toBe('q2');
	// q1 is marked done -> pruned from the queue; terminal entries do not linger
	expect(state.entries.find((e) => e.id === 'q1')).toBeUndefined();
	expect(state.entries.find((e) => e.id === 'q2')!.status).toBe('playing');
});

test('ended on the last entry goes to no-current (attract)', () => {
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	handleTelemetry({ entryId: 'q1', positionSec: 100, ended: true }, deps);
	expect(state.playback.currentEntryId).toBeNull();
	expect(state.playback.isPlaying).toBe(false);
});

test('nowplaying:changed carries current + soonest-ready upNext', () => {
	const { state, deps, published } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	state.applyQueueOp({ op: 'add', entry: entry('q2', 'm2') });
	handlePlayerCommand({ cmd: 'play' }, deps); // emits nowplaying
	const np = published.filter((e) => e.type === 'nowplaying:changed').at(-1) as Extract<
		ServerEvent,
		{ type: 'nowplaying:changed' }
	>;
	expect(np.current?.id).toBe('q1');
	expect(np.upNext?.id).toBe('q2');
});

test('position-only telemetry updates position without advancing', () => {
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	handleTelemetry({ positionSec: 42.7 }, deps);
	expect(state.playback.currentEntryId).toBe('q1'); // unchanged
	expect(state.playback.positionSec).toBe(42.7); // tracked with sub-second precision
});

test('held-slot: ended skips a not-ready file entry, plays the ready one', () => {
	const { state, deps } = harness();
	// q1 ready iframe (playing), q2 is a processing file, q3 ready
	deps.mediaById.set('m2', { ...media('m2'), stemStatus: 'queued' });
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	state.applyQueueOp({ op: 'add', entry: entry('q2', 'm2') });
	state.applyQueueOp({ op: 'add', entry: entry('q3', 'm3') });
	handlePlayerCommand({ cmd: 'play' }, deps); // q1
	handleTelemetry({ entryId: 'q1', positionSec: 100, ended: true }, deps);
	// q2 not ready -> held -> advance picks q3
	expect(state.playback.currentEntryId).toBe('q3');
});

test('reconcileOnReady: room idled while processing → the freshly-ready song starts playing', () => {
	const { state, deps, published } = harness();
	// the only queued song is a processing file — nothing plays yet (room idle)
	deps.mediaById.set('m1', { ...media('m1'), stemStatus: 'queued' });
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	expect(state.playback.currentEntryId).toBeNull();

	// stems finish → media ready → reconcile starts it
	deps.mediaById.set('m1', {
		...media('m1'),
		stemStatus: 'ready',
		lyricsStatus: 'ready',
		instrumentalRef: 'derived/stems/i-instrumental.flac'
	});
	reconcileOnReady(deps);
	expect(state.playback.currentEntryId).toBe('q1');
	expect(state.playback.isPlaying).toBe(true);
	expect(published.some((e) => e.type === 'playback:state')).toBe(true);
	expect(published.at(-1)!.type).toBe('nowplaying:changed');
});

test('reconcileOnReady: something already playing → only re-emits nowplaying (no preemption)', () => {
	const { state, deps, published } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') }); // ready iframe
	deps.mediaById.set('m2', { ...media('m2'), stemStatus: 'queued' });
	state.applyQueueOp({ op: 'add', entry: entry('q2', 'm2') }); // processing
	handlePlayerCommand({ cmd: 'play' }, deps); // q1 playing
	const before = state.playback.currentEntryId;
	published.length = 0;

	deps.mediaById.set('m2', {
		...media('m2'),
		stemStatus: 'ready',
		lyricsStatus: 'ready',
		instrumentalRef: 'derived/stems/i-instrumental.flac'
	});
	reconcileOnReady(deps);
	expect(state.playback.currentEntryId).toBe(before); // q1 NOT preempted
	// no new playback:state (we didn't change playback), just a nowplaying refresh so TV preloads m2
	expect(published.every((e) => e.type !== 'playback:state')).toBe(true);
	expect(published.some((e) => e.type === 'nowplaying:changed')).toBe(true);
});

test('two ended frames do not double-advance: the stale ended for a no-longer-current entry is ignored', () => {
	// A SECOND `ended` (a duplicate send, a second TV, or a reconnecting TV replaying its last frame) must not
	// consume Bob's turn too.
	const { state, deps } = harness();
	deps.mediaById.set('m3', media('m3'));
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') }); // Alice
	state.applyQueueOp({ op: 'add', entry: entry('q2', 'm2') }); // Bob
	state.applyQueueOp({ op: 'add', entry: entry('q3', 'm3') }); // Cara
	handlePlayerCommand({ cmd: 'play' }, deps);
	expect(state.playback.currentEntryId).toBe('q1');

	// First ended carries Alice's id (the entry that actually ended on screen). Advances to Bob.
	handleTelemetry({ entryId: 'q1', positionSec: 100, ended: true }, deps);
	expect(state.playback.currentEntryId).toBe('q2');

	// Second (stale/duplicate) ended still names Alice (q1) — no longer current. It must be IGNORED.
	handleTelemetry({ entryId: 'q1', positionSec: 100, ended: true }, deps);
	expect(state.playback.currentEntryId).toBe('q2'); // still Bob, NOT Cara
	expect(state.entries.find((e) => e.id === 'q2')!.status).toBe('playing'); // Bob's turn survives
	expect(state.entries.find((e) => e.id === 'q3')).toBeDefined(); // Cara still queued, not skipped
});

test('a genuine ended whose id matches the current entry advances as before', () => {
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	state.applyQueueOp({ op: 'add', entry: entry('q2', 'm2') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	handleTelemetry({ entryId: 'q1', positionSec: 100, ended: true }, deps);
	expect(state.playback.currentEntryId).toBe('q2');
});

test('an ended with no entry id is ignored: it cannot skip the singer without naming them', () => {
	// An id-less `ended` was a free skip for any frame that reached handleTelemetry (BE-07). The TV stamps every
	// frame (src/lib/tv/telemetry.ts), so only a frame that names nobody loses its effect.
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	state.applyQueueOp({ op: 'add', entry: entry('q2', 'm2') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	handleTelemetry({ positionSec: 100, ended: true }, deps);
	expect(state.playback.currentEntryId).toBe('q1');
	expect(state.entries.find((e) => e.id === 'q1')!.status).toBe('playing');
});

test('a stale position frame naming the outgoing entry after an advance does NOT move the playhead', () => {
	// The outgoing <audio> for q1 fires one more ontimeupdate across the round-trip and slot swap: a POSITION
	// frame naming an entry that is no longer current. Written unconditionally it lands on q2 (positionSec=87)
	// and is fed back to the TV as a seek target, starting the next singer 87s in.
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	state.applyQueueOp({ op: 'add', entry: entry('q2', 'm2') });
	handlePlayerCommand({ cmd: 'play' }, deps); // q1 playing
	handleTelemetry({ entryId: 'q1', positionSec: 87.4 }, deps);
	expect(state.playback.positionSec).toBe(87.4); // a live frame for the current entry still tracks (sub-second kept)

	// Advance to q2 (its own play resets positionSec to 0).
	handleTelemetry({ entryId: 'q1', positionSec: 100, ended: true }, deps);
	expect(state.playback.currentEntryId).toBe('q2');
	expect(state.playback.positionSec).toBe(0);

	// The stale trailing position frame from q1's outgoing <audio> — no longer current. Must be dropped.
	handleTelemetry({ entryId: 'q1', positionSec: 87.4 }, deps);
	expect(state.playback.positionSec).toBe(0); // NOT 87 — q2 does not inherit q1's playhead
	expect(state.playback.currentEntryId).toBe('q2');
});

test('a position frame for the current entry still updates position (guard hoist does not break the live path)', () => {
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	handleTelemetry({ entryId: 'q1', positionSec: 42.7 }, deps);
	expect(state.playback.positionSec).toBe(42.7); // broadcast position keeps sub-second precision
});

test('an id-less position frame keeps legacy behaviour (older TV unaffected)', () => {
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	handleTelemetry({ positionSec: 33.3 }, deps);
	expect(state.playback.positionSec).toBe(33.3); // no id -> still applied (sub-second kept)
});

test('the TV wires sendTelemetry through the pure telemetryFrame(status, current, …) so the stamp is reachable', () => {
	// The server-side stale-frame drops can only fire on a frame that CARRIES an entryId, so the TV stamping one
	// only on `ended` makes every position frame id-less and both drops inert. The stamp itself lives in the pure
	// telemetryFrame() and is asserted behaviourally there; this only pins the WIRING — sendTelemetry must
	// delegate to telemetryFrame passing the live `current`, never a hardcoded id or the ended-only form.
	const src = read('src/routes/tv/+page.svelte');
	const body = src.split('function sendTelemetry(')[1]?.split('\n\t}')[0] ?? '';
	expect(body).toContain('telemetryFrame(status, current'); // delegates, passing the live current
	expect(body).not.toContain("status === 'ended' ?"); // the ended-only form is the stale-frame bug
});
