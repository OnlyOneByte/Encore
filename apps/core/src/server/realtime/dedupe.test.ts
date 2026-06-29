// M6-C2: a resent command (same clientOpId) must NOT double-apply; re-ack only.
import { test, expect } from 'bun:test';
import { handleQueueCommand, type HubDeps } from './hub';
import { AuthoritativeState } from '../state/store';
import { ulid, type ServerEvent, type Media, type ClientCommand } from '@encore/shared';

const media = (id: string): Media => ({ id, source: 'youtube', sourceRef: 'x', title: id, durationSec: 100, stemStatus: 'none', playMode: 'iframe' });

function harness() {
	const published: ServerEvent[] = [];
	const seen = new Set<string>();
	const state = new AuthoritativeState();
	const deps: HubDeps = {
		state,
		publish: (e) => published.push(e),
		mediaById: new Map([['m1', media('m1')]]),
		seenOp: (id) => { if (seen.has(id)) return true; seen.add(id); return false; }
	};
	return { published, state, deps };
}

const addCmd = (clientOpId: string, entryId: string): ClientCommand => ({
	clientOpId, baseRev: 0,
	op: { op: 'add', entry: { id: entryId, mediaId: 'm1', singerId: 's1', status: 'queued', rotationSeq: -1, addedAt: 1 } }
});

test('resent command (same clientOpId) does not double-apply', () => {
	const { state, deps } = harness();
	const cmd = addCmd('op-1', 'q1');
	handleQueueCommand(cmd, deps);
	expect(state.entries).toHaveLength(1);
	expect(state.rev).toBe(1);

	// resend the SAME command (e.g. after a reconnect)
	handleQueueCommand(cmd, deps);
	expect(state.entries).toHaveLength(1); // NOT 2 — idempotent
	expect(state.rev).toBe(1); // rev unchanged
});

test('resend re-acks with causedBy so the originator clears pending', () => {
	const { published, deps } = harness();
	const cmd = addCmd('op-1', 'q1');
	handleQueueCommand(cmd, deps);
	const beforeCount = published.length;
	handleQueueCommand(cmd, deps);
	const reAck = published.slice(beforeCount).find((e) => e.type === 'queue:patch') as Extract<ServerEvent, { type: 'queue:patch' }>;
	expect(reAck).toBeDefined();
	expect(reAck.patch.causedBy).toBe('op-1');
	expect(reAck.patch.ops).toEqual([]); // empty — no state change, just an ack
});

test('distinct clientOpIds both apply', () => {
	const { state, deps } = harness();
	handleQueueCommand(addCmd('op-1', 'q1'), deps);
	handleQueueCommand(addCmd('op-2', 'q2'), deps);
	expect(state.entries).toHaveLength(2);
});
