// A resent command (same clientOpId) must NOT double-apply; re-ack only.
import { test, expect } from 'bun:test';
import { handleQueueCommand, type HubDeps } from '$lib/server/realtime/hub';
import { AuthoritativeState } from '$lib/server/state/store';
import { type ServerEvent, type Media, type ClientCommand } from '$lib/contract';
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

function harness() {
	const published: ServerEvent[] = [];
	const seen = new Set<string>();
	const state = new AuthoritativeState();
	const deps: HubDeps = {
		state,
		publish: (e) => published.push(e),
		mediaById: new Map([['m1', media('m1')]]),
		seenOp: (id) => {
			if (seen.has(id)) return true;
			seen.add(id);
			return false;
		},
		hasOp: (id) => seen.has(id), // non-recording peek — mirrors server.ts
		actorSingerId: 's1'
	};
	return { published, state, deps };
}

const addCmd = (clientOpId: string, entryId: string): ClientCommand => ({
	clientOpId,
	op: {
		op: 'add',
		entry: { id: entryId, mediaId: 'm1', singerId: 's1', status: 'queued', rotationSeq: -1, addedAt: 1 }
	}
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
	const reAck = published.slice(beforeCount).find((e) => e.type === 'queue:patch') as Extract<
		ServerEvent,
		{ type: 'queue:patch' }
	>;
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

// ── the idempotency ledger must sit AHEAD of validation, not behind it ───────────────────────────
// dedupe's three tests above all build their command with `addCmd`, i.e. the ONE op shape whose
// resend still validates against post-apply state (the entry is still `queued`, so applyOp's add arm
// re-lands it in place and validateCommand's collision guard passes). That is exactly why the contract
// read as covered while two whole op shapes regressed. These pin the two shapes whose resend NO LONGER
// validates once the server has applied them: a `remove` (its entry is pruned) and an `add` whose
// entry the server has since started (`status !== 'queued'`). On base both are answered with
// `op:reject` — a false error banner for an action that actually succeeded; the ledger's re-ack is
// never reached because validateCommand rejects first.

const removeCmd = (clientOpId: string, id: string): ClientCommand => ({ clientOpId, op: { op: 'remove', id } });

test('Finding 1: a resent already-applied REMOVE is re-acked, not rejected (its entry is now pruned)', () => {
	const { published, state, deps } = harness();
	// Seed two adds through the real seam, then apply + record a remove of q1.
	handleQueueCommand(addCmd('a1', 'q1'), deps);
	handleQueueCommand(addCmd('a2', 'q2'), deps);
	const rm = removeCmd('k-rm', 'q1');
	handleQueueCommand(rm, deps); // applies; ledger records 'k-rm'; q1 pruned
	expect(state.entries.map((e) => e.id)).toEqual(['q2']);

	// The phone's broadcast of that remove was lost, so it resends the SAME command on reconnect.
	const before = published.length;
	const sent: ServerEvent[] = [];
	const patch = handleQueueCommand(rm, deps, (e) => sent.push(e));

	// Re-acked, NOT rejected: no op:reject to the originator; a queue:patch re-ack with causedBy + [].
	expect(sent.some((e) => e.type === 'op:reject')).toBe(false);
	expect(patch).toBeNull(); // re-ack path returns null (no fresh apply)
	const reAck = published.slice(before).find((e) => e.type === 'queue:patch') as Extract<
		ServerEvent,
		{ type: 'queue:patch' }
	>;
	expect(reAck).toBeDefined();
	expect(reAck.patch.causedBy).toBe('k-rm');
	expect(reAck.patch.ops).toEqual([]);
	// State unchanged by the resend — still just q2.
	expect(state.entries.map((e) => e.id)).toEqual(['q2']);
});

test('Finding 2: a resent already-applied ADD is re-acked once its entry has STARTED playing', () => {
	const { published, state, deps } = harness();
	const add = addCmd('k1', 'q1');
	handleQueueCommand(add, deps); // applies; ledger records 'k1'
	// The server starts the song, exactly as player.beginSinging does (applyQueueOp status:'playing').
	state.applyQueueOp({ op: 'status', id: 'q1', status: 'playing' });
	expect(state.entries.find((e) => e.id === 'q1')!.status).toBe('playing');

	// Same lost-ack window: the phone resends the SAME add on reconnect. On base validateCommand's
	// collision guard reds it with `entry id already taken: q1` (because of the status!=='queued' clause).
	const before = published.length;
	const sent: ServerEvent[] = [];
	const patch = handleQueueCommand(add, deps, (e) => sent.push(e));

	expect(sent.some((e) => e.type === 'op:reject')).toBe(false);
	expect(patch).toBeNull();
	const reAck = published.slice(before).find((e) => e.type === 'queue:patch') as Extract<
		ServerEvent,
		{ type: 'queue:patch' }
	>;
	expect(reAck).toBeDefined();
	expect(reAck.patch.causedBy).toBe('k1');
	expect(reAck.patch.ops).toEqual([]);
	// The started song is untouched — not re-landed as 'queued', not double-applied.
	expect(state.entries.find((e) => e.id === 'q1')!.status).toBe('playing');
	expect(state.entries).toHaveLength(1);
});

test('CONTROL: a genuinely-new INVALID op (never applied, not in the ledger) is still rejected', () => {
	const { published, deps } = harness();
	// A remove of an entry that never existed: unseen clientOpId, so the ledger cannot re-ack it — it
	// must reject, proving the ledger only short-circuits ALREADY-APPLIED ops, not all failures.
	const sent: ServerEvent[] = [];
	const patch = handleQueueCommand(removeCmd('k-new', 'ghost'), deps, (e) => sent.push(e));
	expect(patch).toBeNull();
	expect(sent).toHaveLength(1);
	const rej = sent[0] as Extract<ServerEvent, { type: 'op:reject' }>;
	expect(rej.type).toBe('op:reject');
	expect(rej.clientOpId).toBe('k-new');
	expect(rej.reason).toBe('unknown entry: ghost');
	expect(published.some((e) => e.type === 'queue:patch')).toBe(false);
});

test('REGRESSION: a resent genuinely-INVALID op is rejected AGAIN, never falsely re-acked (the ledger must not record a never-applied op)', () => {
	// The blocking regression the first cut introduced: the validation-failure re-ack path used the
	// record-on-check `seenOp`, so REJECTING a never-applied op wrote its clientOpId into the ledger —
	// and its resend (the same lost-message window: reject lost, op stays pending,
	// resendPending fires it again) was then answered with a false re-ack instead of a reject, and the
	// client (queue.ts:203) deletes it from pending as "server-confirmed" with no snapshot to correct
	// the optimistic row. Fixed by consulting the NON-RECORDING `hasOp` on the failure path. This pins
	// it: the SAME invalid op sent twice must reject BOTH times (the property base guaranteed).
	const { published, deps } = harness();
	const bad = removeCmd('k-bad', 'ghost'); // entry never existed -> validation always fails

	const sent1: ServerEvent[] = [];
	const p1 = handleQueueCommand(bad, deps, (e) => sent1.push(e));
	expect(p1).toBeNull();
	expect(sent1).toHaveLength(1);
	expect((sent1[0] as Extract<ServerEvent, { type: 'op:reject' }>).type).toBe('op:reject');

	// Resend the identical command — must reject AGAIN, and must NOT produce a queue:patch re-ack.
	const beforePatches = published.filter((e) => e.type === 'queue:patch').length;
	const sent2: ServerEvent[] = [];
	const p2 = handleQueueCommand(bad, deps, (e) => sent2.push(e));
	expect(p2).toBeNull();
	expect(sent2).toHaveLength(1);
	expect((sent2[0] as Extract<ServerEvent, { type: 'op:reject' }>).type).toBe('op:reject');
	// No re-ack was invented for an op that never applied.
	expect(published.filter((e) => e.type === 'queue:patch').length).toBe(beforePatches);
});
