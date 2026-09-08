// A queue `add` whose CLIENT-MINTED fields are the wrong shape must be rejected at the seam, not
// applied, broadcast, and then flushed into the database.
//
// HOW THIS CLASS IS FOUND: the same way as the singerId crash (hub.ts) and the telemetry positionSec
// crash (player.ts) — driving the real server. `applyOp`'s add arm inserts `op.entry` VERBATIM (only
// rotationSeq is server-owned), so a client-supplied `addedAt` and `status` reach the queue unchanged.
// What the columns ACTUALLY enforce at the write-behind flush is narrow (measured, #317): status is
// `text ... NOT NULL` with NO CHECK constraint (drizzle's `enum:` is compile-time only), and addedAt is
// `integer NOT NULL`. So the failure modes SPLIT: a missing/undefined addedAt or null status throws
// NOT NULL and takes the server process down asynchronously; but an off-enum status string and a
// non-finite-yet-representable addedAt (Infinity) throw NOTHING — they persist SILENTLY into room state
// and onto disk. Neither is caught by the column. And status is a LIFECYCLE field a phone has no
// business asserting at all: the only add producer in the repo (lib/stores/queue.ts) mints 'queued',
// every other value is server-owned (beginSinging→'playing', advance→'done'). So the add-arm guard is
// the ONLY thing keeping both a garbage addedAt and a forged non-'queued' status out of the queue:
//   1. an off-shape add passes no earlier guard (id / singerId / mediaId all valid),
//   2. would be applied to authoritative state and BROADCAST to the whole room, then
//   3. either crashes the flush (missing addedAt / null status) or slips past it silently
//      (Infinity addedAt / off-enum-or-forged status), re-opening #195's forged-'playing' hole
//      (a) through the `add` op.
// The fix rejects all of these at the add arm's seam so nothing bad is ever applied or persisted.
import { test, expect } from 'bun:test';
import { validateCommand, handleQueueCommand, type HubDeps } from './hub';
import { AuthoritativeState } from '../state/store';
import type { Media, QueueEntry, ClientCommand, ServerEvent } from '@encore/shared';
import { EMPTY_SONG_PROFILE } from '@encore/shared';
import { queueEntries } from '../db/schema';

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
	op: {
		op: 'add',
		entry: {
			id: 'e1',
			mediaId: 'm1',
			singerId: 's1',
			status: 'queued',
			rotationSeq: 0,
			addedAt: 1,
			...overrides
		} as QueueEntry
	}
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
	expect(validateCommand(add({ status: undefined as unknown as QueueEntry['status'] }), deps)).toContain(
		'invalid status'
	);
});

test("a client add may only mint status:'queued' — every other lifecycle status is rejected", () => {
	// The invariant, not an implementation: a phone has no business asserting a lifecycle status. The
	// only add producer in the repo (lib/stores/queue.ts) mints 'queued'; 'playing'/'done' are
	// server-owned. So 'queued' is the sole legal client-minted value and the guard is NOT over-broad.
	const { deps } = harness();
	expect(validateCommand(add({ status: 'queued' }), deps)).toBeNull();
	expect(validateCommand(add({ addedAt: 0 }), deps)).toBeNull();
	for (const s of ['playing', 'done'] as const) {
		expect(validateCommand(add({ status: s }), deps)).toContain('invalid status');
	}
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

test("a client add accepts only 'queued' out of the whole queue_entries.status enum, and rejects off-enum too", () => {
	// Sourced from the column enum so this cannot drift: 'queued' is the ONE legal client-minted value,
	// EVERY other enum value (playing/waiting/done/skipped — all server-owned) is rejected, and so is a
	// value not in the column at all. This pins the INVARIANT (a client may only mint 'queued'), not the
	// old over-broad implementation (whole-enum membership), which re-opened #195's forged-'playing' hole.
	const colEnum = [...(queueEntries.status.enumValues as readonly string[])];
	expect(colEnum).toContain('queued');
	expect(colEnum.length).toBeGreaterThan(1); // there ARE server-owned values that must be rejected
	const { deps } = harness();
	expect(validateCommand(add({ status: 'queued' }), deps)).toBeNull();
	for (const s of colEnum.filter((v) => v !== 'queued')) {
		expect(validateCommand(add({ status: s as QueueEntry['status'] }), deps)).toContain('invalid status');
	}
	expect(validateCommand(add({ status: 'not-a-real-status' as QueueEntry['status'] }), deps)).toContain(
		'invalid status'
	);
});

test('validateCommand rejects a client-minted pinnedSeq that is not an integer (#724)', () => {
	// pinnedSeq (#638) is the durable global-pin position, inserted verbatim by applyOp and bound to the
	// NULLABLE `pinned_seq integer` column. Before this guard it was the ONLY client-minted field with no
	// shape check on the add path (addedAt and status were guarded; pinnedSeq was not). Every non-integer
	// value the reviewer measured must now be refused at the seam:
	//   - object / array: a bun:sqlite bind of a non-primitive throws from the un-try'd write-behind flush
	//     timer and takes the core process DOWN asynchronously (same crash class as #702's move-global toSeq).
	//   - numeric string ('0'): dropped LIVE by placePins' `typeof === number` filter (rotation.ts) yet
	//     coerced into the integer column by SQLite affinity, so the room re-pins itself on the next restart
	//     into an order no client ever showed.
	//   - NaN / Infinity / a float: not integers, so not honest pin positions.
	const { deps } = harness();
	for (const bad of [{} as unknown, [1] as unknown, '0' as unknown, true as unknown, NaN, Infinity, 0.5]) {
		expect(validateCommand(add({ pinnedSeq: bad as QueueEntry['pinnedSeq'] }), deps)).toBe('invalid pinnedSeq');
	}
});

test('validateCommand accepts an honest pinnedSeq — omitted, null, or any integer including negative (#724)', () => {
	// `!= null` is load-bearing: the field is OPTIONAL and every honest add OMITS it (lib/stores/queue.ts
	// addSong builds the entry with six fields and no pinnedSeq), so a bare Number.isInteger check would
	// reject 100% of real adds. And negative/huge integers are NOT rejected: placePins clamps low and high
	// against the growing list (rotation.ts), so they are honest no-consequence inputs — refusing them would
	// be a behaviour change (same reasoning #702 records for toSeq).
	const { deps } = harness();
	// the field ABSENT (the shape a real client sends)
	const bare = add({});
	delete (bare.op as { entry: Partial<QueueEntry> }).entry.pinnedSeq;
	expect(validateCommand(bare, deps)).toBeNull();
	// explicit null, and a spread of integers the column happily stores and placePins clamps
	for (const ok of [null, 0, 3, -5, 1_000_000]) {
		expect(validateCommand(add({ pinnedSeq: ok as QueueEntry['pinnedSeq'] }), deps)).toBeNull();
	}
});

test('a bad-shape pinnedSeq add is NOT applied and NOT broadcast — the poison never reaches the flush (#724)', () => {
	// The end-to-end property the crash/reorder violated: on base validateCommand returns null for a
	// pinnedSeq {} (or a numeric-string), the entry is applied and BROADCAST, and the poison then reaches
	// the write-behind snapshot (a {} crashes the flush timer; a '0' is coerced in and re-pins on restart).
	// With the fix it is rejected at the seam, so the authoritative queue that gets flushed stays empty and
	// no queue:patch is broadcast.
	for (const bad of [
		add({ pinnedSeq: {} as unknown as QueueEntry['pinnedSeq'] }),
		add({ pinnedSeq: '0' as unknown as QueueEntry['pinnedSeq'] })
	]) {
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
