// Issue #702: `move-global`'s `toSeq` is the first wire-settable op whose payload value is written
// STRAIGHT to a durable column with no shape guard on the path. hub.ts's move-global/unpin arm
// validated entry existence and capability but never `op.toSeq`; applyOp stamps `pinnedSeq: op.toSeq`
// verbatim (ops.ts) and the write-behind flush binds it into `pinned_seq integer` (persistence.ts).
//
// Two reachable consequences of the missing guard, both driven from the WIRE frame that server.ts
// JSON.parses and hands to handleQueueCommand with no schema step:
//   - `toSeq: {}` (or any non-bindable value) crashes bun:sqlite's bind from inside the un-try'd
//     write-behind flush timer, killing the core process asynchronously.
//   - `toSeq: '0'` / `true` is dropped LIVE by placePins (typeof !== 'number') but coerced by SQLite
//     integer affinity into a real number that placePins HONOURS after a restart, silently reordering
//     the room into an order no client ever displayed.
//
// The fix is one line in the same arm, discriminating the combined case on `op.op`:
//   if (op.op === 'move-global' && !Number.isInteger(op.toSeq)) return `invalid toSeq: ...`;
// MECHANISM: reject a non-integer toSeq at the validateCommand seam so it never reaches applyOp's pin
// stamp nor the durable column. `unpin` carries no toSeq and stays exempt.
//
// The wire delivers unvalidated JSON, so junk toSeq values are not assignable to the op type; the
// casts below model exactly that — a hand-crafted frame, which is the issue's reachable trigger.
import { test, expect } from 'bun:test';
import { validateCommand, handleQueueCommand, type HubDeps } from './hub';
import { AuthoritativeState } from '../state/store';
import { sqlitePersistence } from '../state/persistence';
import { hydrate } from '../db/migrate';
import { migratedDb } from '../db/test-db';
import { EMPTY_SONG_PROFILE, type Media, type QueueEntry, type ClientCommand } from '@encore/shared';

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

const entry = (id: string, singerId: string): QueueEntry => ({
	id,
	mediaId: 'm1',
	singerId,
	status: 'queued',
	rotationSeq: 0,
	addedAt: 1
});

function harness(): HubDeps {
	const state = new AuthoritativeState();
	state.hydrate([entry('q1', 's-self'), entry('q2', 's-self'), entry('q3', 's-self')], null);
	return { state, publish: () => {}, mediaById: new Map([['m1', media('m1')]]), actorSingerId: 's-self' };
}

// A frame is exactly what the wire delivers: JSON.parse output, no schema step (server.ts:323-324).
// eslint config here does not flag `any` in this param position; junk toSeq values are not assignable
// to the op union, and modelling the wire's unvalidated JSON is the whole point.
const frame = (op: any): ClientCommand => ({ clientOpId: 'c1', op });

// (1) VERDICT — the seam rejects a non-integer toSeq, and only that.
test('move-global with an OBJECT toSeq is rejected (the process-crash shape)', () => {
	const v = validateCommand(frame({ op: 'move-global', id: 'q1', toSeq: {} }), harness());
	expect(v).toBe('invalid toSeq: [object Object]');
});

test('move-global with a STRING toSeq is rejected (the silent-reorder shape)', () => {
	const v = validateCommand(frame({ op: 'move-global', id: 'q1', toSeq: '0' }), harness());
	expect(v).toBe('invalid toSeq: 0');
});

test('move-global with a BOOLEAN toSeq is rejected (also SQLite-coerced)', () => {
	expect(validateCommand(frame({ op: 'move-global', id: 'q1', toSeq: true }), harness())).toBe('invalid toSeq: true');
});

// The guard must not be satisfiable by rejecting everything: real integer targets still pass.
test('move-global with an integer toSeq of 0 still passes', () => {
	expect(validateCommand(frame({ op: 'move-global', id: 'q1', toSeq: 0 }), harness())).toBeNull();
});

test('move-global with an integer toSeq of 2 still passes', () => {
	expect(validateCommand(frame({ op: 'move-global', id: 'q1', toSeq: 2 }), harness())).toBeNull();
});

// `unpin` carries no toSeq — it must be unaffected by the discriminated guard.
test('unpin (no toSeq) is unaffected by the toSeq guard', () => {
	expect(validateCommand(frame({ op: 'unpin', id: 'q1' }), harness())).toBeNull();
});

// (2) CONSEQUENCE — a poisoned toSeq that reaches the durable pin crashes the write-behind flush.
// The guard rejects at validateCommand, so handleQueueCommand never applies the op; on base (no guard)
// handleQueueCommand applies it, pinnedSeq becomes {}, and flushNow() throws from the sqlite bind.
test('a poisoned move-global never reaches the durable flush (no crash from the write-behind timer)', () => {
	const db = migratedDb();
	const TEST_ROOM = 'test-room';
	const state = new AuthoritativeState(sqlitePersistence(db, TEST_ROOM), 10_000);
	state.hydrate([entry('q1', 's-self'), entry('q2', 's-self'), entry('q3', 's-self')], null);
	const deps: HubDeps = {
		state,
		publish: () => {},
		mediaById: new Map([['m1', media('m1')]]),
		actorSingerId: 's-self'
	};

	// handleQueueCommand validates then applies. With the guard, the object frame is rejected and
	// nothing is applied; without it, pinnedSeq is stamped with {} and the flush below throws.
	handleQueueCommand(frame({ op: 'move-global', id: 'q1', toSeq: {} }), deps);

	// The write-behind flush must not throw — the poisoned value must never have reached the pin.
	expect(() => state.flushNow()).not.toThrow();

	// And the durable state must be clean: no entry carries a non-null pin.
	const { entries } = hydrate(db, TEST_ROOM);
	expect(entries.every((e) => e.pinnedSeq == null)).toBe(true);
});
