// The socket's singerId is resolved from the session cookie at WS upgrade. It used to drive ONLY
// presence — nothing authorized against it — so any socket could mutate the queue, and an `add` was
// credited to whatever singerId the client put in the frame. These lock the gate shut.
import { test, expect } from 'bun:test';
import { validateCommand, handleQueueCommand, type HubDeps } from './hub';
import { AuthoritativeState } from '../state/store';
import { ulid, type ServerEvent, type Media, type ClientCommand } from '@encore/shared';
import { EMPTY_SONG_PROFILE } from '@encore/shared';

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

function harness(actorSingerId?: string) {
	const published: ServerEvent[] = [];
	const toOrigin: ServerEvent[] = [];
	const state = new AuthoritativeState();
	const deps: HubDeps = {
		state,
		publish: (e) => published.push(e),
		mediaById: new Map([['m1', media('m1')]]),
		actorSingerId
	};
	return { published, toOrigin, state, deps };
}

const addAs = (singerId: string): ClientCommand => ({
	clientOpId: ulid(),
	op: { op: 'add', entry: { id: 'q1', mediaId: 'm1', singerId, status: 'queued', rotationSeq: -1, addedAt: 1 } }
});

test('a socket that never joined cannot mutate the queue', () => {
	const { deps, state, published } = harness(undefined);
	expect(validateCommand(addAs('s1'), deps)).toBe('join the room first');
	expect(handleQueueCommand(addAs('s1'), deps)).toBeNull();
	expect(state.rev).toBe(0);
	expect(published).toHaveLength(0);
});

test('the identity gate covers every op, not just add', () => {
	const { deps } = harness(undefined);
	const anon = (op: ClientCommand['op']): ClientCommand => ({ clientOpId: ulid(), op });
	expect(validateCommand(anon({ op: 'remove', id: 'x' }), deps)).toBe('join the room first');
	expect(validateCommand(anon({ op: 'move', id: 'x', toSeq: 0 }), deps)).toBe('join the room first');
	expect(validateCommand(anon({ op: 'status', id: 'x', status: 'done' }), deps)).toBe('join the room first');
});

test('an add cannot be credited to a different singer than the session', () => {
	const { deps, state, toOrigin } = harness('s1');
	const cmd = addAs('s2'); // queueing as somebody else
	expect(validateCommand(cmd, deps)).toBe('singerId does not match this session');

	handleQueueCommand(cmd, deps, (e) => toOrigin.push(e));
	expect(state.rev).toBe(0); // nothing applied
	const rej = toOrigin[0] as Extract<ServerEvent, { type: 'op:reject' }>;
	expect(rej.type).toBe('op:reject');
	expect(rej.clientOpId).toBe(cmd.clientOpId);
});

test('an add carrying the session own singerId is accepted', () => {
	const { deps, state } = harness('s1');
	expect(validateCommand(addAs('s1'), deps)).toBeNull();
	expect(handleQueueCommand(addAs('s1'), deps)).not.toBeNull();
	expect(state.entries).toHaveLength(1);
	expect(state.entries[0]!.singerId).toBe('s1');
});

test('the envelope is still validated before identity, so a joined socket gets precise reasons', () => {
	// Ordering matters for debuggability: a malformed frame from a joined phone should say what is
	// malformed, not blame the session.
	const { deps } = harness('s1');
	expect(validateCommand(undefined as never, deps)).toBe('malformed command');
	expect(validateCommand({} as never, deps)).toBe('missing clientOpId');
	expect(validateCommand({ clientOpId: 'c1' } as never, deps)).toBe('malformed op');
});
