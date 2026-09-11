// One malformed WebSocket frame must never end a party.
//
// HOW THIS WAS FOUND: driving the real server. A frame of `{"type":"queue:command", op:"add", ...}` —
// the fields at the top level instead of nested under `command` — meant `evt.command` was undefined,
// `handleQueueCommand` read `cmd.clientOpId` off it, and the process exited with
// "TypeError: undefined is not an object". The room dies, mid-song, for every singer.
//
// HANDOFF §6 already declares this class of bug unacceptable, and validateCommand already guarded the
// singerId case. The gap was one layer further out: the OP was validated, the thing CONTAINING it was
// not — and the caller read a property before validation ran at all.
import { test, expect } from 'bun:test';
import { validateCommand, handleQueueCommand, type HubDeps } from '$server/realtime/hub';
import { handlePlayerCommand, handleTelemetry } from '$server/realtime/player';
import { AuthoritativeState } from '$server/state/store';
import type { Media } from '@encore/shared';
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

function deps(): HubDeps {
	const state = new AuthoritativeState();
	return {
		state,
		mediaById: new Map([['m1', media('m1')]]),
		publish: () => {},
		now: () => 0,
		// A joined socket, so these cases still exercise malformed ENVELOPES rather than tripping the
		// identity gate first and reporting 'join the room first' for every one of them.
		actorSingerId: 's1'
	} as unknown as HubDeps;
}

const JUNK = [
	undefined,
	null,
	0,
	'',
	'add',
	[],
	{},
	{ clientOpId: 'c1' },
	{ op: { op: 'add' } },
	{ clientOpId: 'c1', op: 'add' }
];

test('no malformed queue frame can throw out of handleQueueCommand', () => {
	for (const junk of JUNK) {
		expect(() => handleQueueCommand(junk as never, deps())).not.toThrow();
		expect(handleQueueCommand(junk as never, deps())).toBeNull();
	}
});

test('validateCommand REJECTS a malformed envelope instead of assuming one', () => {
	const d = deps();
	expect(validateCommand(undefined as never, d)).toBe('malformed command');
	expect(validateCommand({} as never, d)).toBe('missing clientOpId');
	expect(validateCommand({ clientOpId: 'c1' } as never, d)).toBe('malformed op');
	// THE ACTUAL FRAME THAT KILLED THE SERVER: op present but a string, not an object.
	expect(validateCommand({ clientOpId: 'c1', op: 'add' } as never, d)).toBe('malformed op');
});

test('an unknown op is rejected rather than falling through as valid', () => {
	// The switch used to return undefined for an unrecognised op, which the caller reads as "no error".
	expect(validateCommand({ clientOpId: 'c1', op: { op: 'obliterate' } } as never, deps())).toContain('unknown op');
});

test('a rejection still reaches the sender when there IS a clientOpId to correlate', () => {
	const sent: unknown[] = [];
	handleQueueCommand({ clientOpId: 'c1', op: { op: 'add', entry: { id: 'e1' } } } as never, deps(), (e) =>
		sent.push(e)
	);
	expect(sent).toHaveLength(1);
	expect((sent[0] as { type: string }).type).toBe('op:reject');
});

test('a frame with no clientOpId is dropped silently — there is nothing to correlate a reject to', () => {
	const sent: unknown[] = [];
	handleQueueCommand({ op: { op: 'add', entry: { id: 'e1' } } } as never, deps(), (e) => sent.push(e));
	expect(sent).toHaveLength(0);
});

test('no malformed player or telemetry frame can throw either', () => {
	for (const junk of JUNK) {
		expect(() => handlePlayerCommand(junk as never, deps())).not.toThrow();
		expect(() => handleTelemetry(junk as never, deps())).not.toThrow();
	}
});

test('a telemetry frame with no position cannot poison playback state', () => {
	// THE SECOND CRASH, found the same way. `Math.floor(undefined)` is NaN and SQLite stores NaN as
	// NULL, so one frame violated `NOT NULL playback_state.position_sec` and threw out of the
	// write-behind FLUSH TIMER — killing the process asynchronously, detached from the request that
	// caused it. Guarded in the store so the whole class is closed, not one caller.
	const d = deps();
	d.state.setPosition(42);
	handleTelemetry({ positionSec: undefined } as never, d);
	expect(d.state.playback.positionSec).toBe(42); // unchanged, not NaN
	d.state.setPosition(NaN);
	d.state.setPosition(Infinity);
	expect(Number.isFinite(d.state.playback.positionSec)).toBe(true);
});

test('a playback patch with undefined values leaves those fields alone', () => {
	const d = deps();
	d.state.setPlayback({ positionSec: 7, isPlaying: true });
	d.state.setPlayback({ currentEntryId: 'e1', positionSec: undefined, isPlaying: undefined });
	expect(d.state.playback.positionSec).toBe(7);
	expect(d.state.playback.isPlaying).toBe(true);
	expect(d.state.playback.currentEntryId).toBe('e1');
});

test('every playback field stays persistable after any sequence of junk', () => {
	// The invariant the crash violated: whatever a client sends, the snapshot must be writable against
	// NOT NULL columns.
	const d = deps();
	for (const junk of JUNK) handleTelemetry(junk as never, d);
	handleTelemetry({ positionSec: 'abc' } as never, d);
	const p = d.state.playback;
	expect(Number.isFinite(p.positionSec)).toBe(true);
	expect(typeof p.isPlaying).toBe('boolean');
	expect(Number.isFinite(p.keyShift)).toBe(true);
});
