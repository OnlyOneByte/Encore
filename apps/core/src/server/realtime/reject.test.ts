// M1-C4 done-when: bad command -> op:reject{clientOpId,reason} to ORIGINATOR ONLY, no broadcast.
import { test, expect } from 'bun:test';
import { handleQueueCommand, validateCommand, type HubDeps } from './hub';
import { AuthoritativeState } from '../state/store';
import { ulid, type ServerEvent, type Media, type ClientCommand } from '@encore/shared';

const media = (id: string): Media => ({
	id, source: 'youtube', sourceRef: 'x', title: id, durationSec: 100, stemStatus: 'none', playMode: 'iframe'
});

function harness() {
	const published: ServerEvent[] = [];
	const toOrigin: ServerEvent[] = [];
	const state = new AuthoritativeState();
	const deps: HubDeps = {
		state,
		publish: (e) => published.push(e),
		mediaById: new Map([['m1', media('m1')]])
	};
	return { published, toOrigin, state, deps };
}

const cmd = (op: ClientCommand['op']): ClientCommand => ({ clientOpId: ulid(), baseRev: 0, op });

test('add with unknown media -> reject to origin, NO broadcast', () => {
	const { published, toOrigin, deps } = harness();
	const c = cmd({
		op: 'add',
		entry: { id: 'q1', mediaId: 'DOES_NOT_EXIST', singerId: 's1', status: 'queued', rotationSeq: -1, addedAt: 1 }
	});
	const result = handleQueueCommand(c, deps, (e) => toOrigin.push(e));

	expect(result).toBeNull();
	expect(published).toHaveLength(0); // nothing broadcast to the room
	expect(toOrigin).toHaveLength(1);
	const rej = toOrigin[0] as Extract<ServerEvent, { type: 'op:reject' }>;
	expect(rej.type).toBe('op:reject');
	expect(rej.clientOpId).toBe(c.clientOpId);
	expect(rej.reason).toContain('unknown media');
});

test('remove of unknown entry -> reject, no state change, no broadcast', () => {
	const { published, toOrigin, state, deps } = harness();
	const c = cmd({ op: 'remove', id: 'ghost' });
	handleQueueCommand(c, deps, (e) => toOrigin.push(e));
	expect(toOrigin[0]!.type).toBe('op:reject');
	expect(published).toHaveLength(0);
	expect(state.rev).toBe(0); // unchanged
});

test('rev does NOT advance on a rejected command', () => {
	const { state, deps, toOrigin } = harness();
	handleQueueCommand(cmd({ op: 'move', id: 'nope', toSeq: 0 }), deps, (e) => toOrigin.push(e));
	expect(state.rev).toBe(0);
});

test('validateCommand returns precise reasons', () => {
	const { deps } = harness();
	expect(validateCommand(cmd({ op: 'status', id: 'x', status: 'done' }), deps)).toContain('unknown entry');
	expect(
		validateCommand(
			cmd({ op: 'add', entry: { id: 'q', mediaId: 'm1', singerId: 's', status: 'queued', rotationSeq: -1, addedAt: 1 } }),
			deps
		)
	).toBeNull();
});

test('reject is targeted: with no sendToOrigin sink, nothing is broadcast either', () => {
	const { published, deps } = harness();
	const result = handleQueueCommand(cmd({ op: 'remove', id: 'ghost' }), deps); // no origin sink
	expect(result).toBeNull();
	expect(published).toHaveLength(0);
});
