// A queue `add` whose CLIENT-MINTED fields are the wrong shape must be rejected at the seam, not
// applied, broadcast, and then flushed into a NOT NULL column where it kills the process.
//
// HOW THIS CLASS IS FOUND: the same way as the singerId crash (hub.ts) and the telemetry positionSec
// crash (player.ts) — driving the real server. `applyOp`'s add arm inserts `op.entry` VERBATIM (only
// rotationSeq is server-owned), so a client-supplied `addedAt` and `status` reach the queue unchanged.
// `queue_entries.addedAt` is NOT NULL integer and `queue_entries.status` is a NOT NULL enum column
// (db/schema.ts), so a non-finite addedAt or an off-enum status:
//   1. passed validateCommand (which only checked id / singerId / mediaId),
//   2. was applied to authoritative state and BROADCAST to the whole room, then
//   3. violated the column inside the debounced write-behind FLUSH TIMER — taking the process down
//      asynchronously, detached from the frame that caused it.
// The fix rejects both at the add arm's seam so nothing bad is ever applied or persisted.
import { test, expect } from 'bun:test';
import { validateCommand, handleQueueCommand, type HubDeps } from './hub';
import { AuthoritativeState } from '../state/store';
import type { Media, QueueEntry, ClientCommand, ServerEvent } from '@encore/shared';
import { EMPTY_SONG_PROFILE } from '@encore/shared';
import { queueEntries } from '../db/schema';

const media = (id: string): Media => ({
	id, source: 'youtube', sourceRef: 'x', title: id, durationSec: 100,
	stemStatus: 'ready', lyricsStatus: 'ready', instrumentalRef: `derived/stems/${id}-instrumental.flac`, songProfile: EMPTY_SONG_PROFILE
});

function harness() {
	const published: ServerEvent[] = [];
	const state = new AuthoritativeState();
	const deps = {
		state,
		mediaById: new Map([['m1', media('m1')]]),
		publish: (e: ServerEvent) => published.push(e),
		now: () => 0,
		actorSingerId: 's1'
	} as unknown as HubDeps;
	return { published, state, deps };
}

// A well-formed add EXCEPT for the one field under test — so the case exercises the new guard and not
// an earlier one (id / singerId / mediaId all valid).
const add = (overrides: Partial<QueueEntry>): ClientCommand => ({
	clientOpId: 'c1',
	baseRev: 0,
	op: { op: 'add', entry: { id: 'e1', mediaId: 'm1', singerId: 's1', status: 'queued', rotationSeq: 0, addedAt: 1, ...overrides } as QueueEntry }
});

test('validateCommand rejects a non-finite addedAt (would crash the write-behind flush)', () => {
	const { deps } = harness();
	expect(validateCommand(add({ addedAt: NaN }), deps)).toBe('invalid addedAt');
	expect(validateCommand(add({ addedAt: Infinity }), deps)).toBe('invalid addedAt');
	expect(validateCommand(add({ addedAt: undefined as unknown as number }), deps)).toBe('invalid addedAt');
});

test('validateCommand rejects an off-enum status (NOT NULL enum column)', () => {
	const { deps } = harness();
	expect(validateCommand(add({ status: 'obliterated' as QueueEntry['status'] }), deps)).toContain('invalid status');
	expect(validateCommand(add({ status: undefined as unknown as QueueEntry['status'] }), deps)).toContain('invalid status');
});

test('a well-formed add still validates (guard is not over-broad)', () => {
	const { deps } = harness();
	for (const s of ['queued', 'playing', 'waiting', 'done', 'skipped'] as const) {
		expect(validateCommand(add({ status: s }), deps)).toBeNull();
	}
	expect(validateCommand(add({ addedAt: 0 }), deps)).toBeNull();
});

test('a bad-shape add is NOT applied to the queue and NOT broadcast — the poison never reaches the flush', () => {
	// This is the end-to-end assertion the crash violated: on base, validateCommand returns null, the
	// entry is applied and broadcast, and the non-finite addedAt / off-enum status then reaches the
	// write-behind snapshot. With the fix it is rejected, so the authoritative queue that gets flushed
	// stays empty and no queue:patch is broadcast.
	for (const bad of [add({ addedAt: NaN }), add({ status: 'nope' as QueueEntry['status'] })]) {
		const { published, state, deps } = harness();
		const sent: unknown[] = [];
		const patch = handleQueueCommand(bad, deps, (e) => sent.push(e));
		expect(patch).toBeNull();
		expect(state.entries).toHaveLength(0);
		expect(published.some((e) => e.type === 'queue:patch')).toBe(false);
		expect(sent).toHaveLength(1);
		expect((sent[0] as { type: string }).type).toBe('op:reject');
	}
});

test('the add-arm status guard reads the exact queue_entries.status column enum', () => {
	// The guard admits precisely the values the NOT NULL enum column accepts by reading enumValues off
	// the column itself, so the check can never drift from the column it protects. Every listed value
	// must validate and any value NOT in the column must be rejected.
	const colEnum = [...(queueEntries.status.enumValues as readonly string[])];
	expect(colEnum).toContain('queued');
	expect(colEnum.length).toBeGreaterThan(0);
	const { deps } = harness();
	for (const s of colEnum) expect(validateCommand(add({ status: s as QueueEntry['status'] }), deps)).toBeNull();
	expect(validateCommand(add({ status: 'not-a-real-status' as QueueEntry['status'] }), deps)).toContain('invalid status');
});
