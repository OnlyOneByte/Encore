// Regression for the "queued song never plays" bug: a plain add to an IDLE room must auto-start
// playback (the TV would otherwise sit on the attract screen forever, with no play control on the
// phone since nothing is "current"). This exercises the exact server.ts composition:
// handleQueueCommand -> (if idle) reconcileOnReady.
import { test, expect } from 'bun:test';
import { handleQueueCommand, type HubDeps } from './hub';
import { reconcileOnReady } from './player';
import { AuthoritativeState } from '../state/store';
import { type ServerEvent, type Media, type QueueEntry, type ClientCommand } from '@encore/shared';

const media = (id: string): Media => ({ id, source: 'youtube', sourceRef: 'x', title: id, durationSec: 100, stemStatus: 'none', playMode: 'iframe' });
let _s = 0;
const addCmd = (id: string, mediaId: string): ClientCommand => ({
	clientOpId: 'op-' + id,
	baseRev: 0,
	op: { op: 'add', entry: { id, mediaId, singerId: 's1', status: 'queued', rotationSeq: -1, addedAt: ++_s } as QueueEntry }
});

function harness() {
	const published: ServerEvent[] = [];
	const state = new AuthoritativeState();
	const deps: HubDeps = { state, publish: (e) => published.push(e), mediaById: new Map([['m1', media('m1')], ['m2', media('m2')]]) };
	return { published, state, deps };
}

// mirrors the server.ts queue:command handler
function queueThenAutostart(cmd: ClientCommand, deps: HubDeps) {
	handleQueueCommand(cmd, deps);
	if (!deps.state.playback.currentEntryId) reconcileOnReady(deps);
}

test('first song queued into an idle room auto-starts playback', () => {
	const { state, deps, published } = harness();
	expect(state.playback.currentEntryId).toBeNull(); // idle

	queueThenAutostart(addCmd('q1', 'm1'), deps);

	expect(state.playback.currentEntryId).toBe('q1'); // ← auto-started
	expect(state.playback.isPlaying).toBe(true);
	expect(state.entries.find((e) => e.id === 'q1')!.status).toBe('playing');
	// the TV learns to leave attract via nowplaying:changed carrying the current entry
	const np = published.filter((e) => e.type === 'nowplaying:changed').at(-1) as Extract<ServerEvent, { type: 'nowplaying:changed' }>;
	expect(np.current?.id).toBe('q1');
});

test('adding a second song while one plays does NOT preempt the current', () => {
	const { state, deps } = harness();
	queueThenAutostart(addCmd('q1', 'm1'), deps); // q1 plays
	expect(state.playback.currentEntryId).toBe('q1');

	queueThenAutostart(addCmd('q2', 'm2'), deps); // q2 just queues
	expect(state.playback.currentEntryId).toBe('q1'); // unchanged — no preemption
	expect(state.entries.find((e) => e.id === 'q2')!.status).toBe('queued');
});
