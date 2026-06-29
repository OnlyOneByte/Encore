// M1-C3 done-when: drive a command -> assert broadcast envelope + new rev.
import { test, expect } from 'bun:test';
import { handleQueueCommand, type HubDeps } from './hub';
import { AuthoritativeState } from '../state/store';
import { ulid, type ServerEvent, type Media, type ClientCommand } from '@encore/shared';

const media = (id: string): Media => ({
	id, source: 'youtube', sourceRef: 'x', title: id, durationSec: 100, stemStatus: 'none', playMode: 'iframe'
});

function harness() {
	const published: ServerEvent[] = [];
	const state = new AuthoritativeState();
	const deps: HubDeps = {
		state,
		publish: (e) => published.push(e),
		mediaById: new Map([['m1', media('m1')]])
	};
	return { published, state, deps };
}

const addCmd = (entryId: string, mediaId = 'm1'): ClientCommand => ({
	clientOpId: ulid(),
	baseRev: 0,
	op: {
		op: 'add',
		entry: { id: entryId, mediaId, singerId: 's1', status: 'queued', rotationSeq: -1, addedAt: 1 }
	}
});

test('valid add broadcasts queue:patch with new rev + causedBy', () => {
	const { published, deps } = harness();
	const cmd = addCmd('q1');
	const patch = handleQueueCommand(cmd, deps);

	expect(patch).not.toBeNull();
	expect(patch!.patch.rev).toBe(1);
	expect(patch!.patch.causedBy).toBe(cmd.clientOpId);
	expect(patch!.patch.ops).toEqual([cmd.op]);

	// hub emits queue:patch then queue:sync (so clients adopt server seqs)
	expect(published[0]!.type).toBe('queue:patch');
	expect(published[1]!.type).toBe('queue:sync');
	const sync = published[1] as Extract<ServerEvent, { type: 'queue:sync' }>;
	expect(sync.rev).toBe(1);
	expect(sync.entries.map((e) => e.id)).toEqual(['q1']);
});

test('rev advances across successive commands', () => {
	const { deps } = harness();
	expect(handleQueueCommand(addCmd('q1'), deps)!.patch.rev).toBe(1);
	expect(handleQueueCommand(addCmd('q2'), deps)!.patch.rev).toBe(2);
});

test('state reflects the applied op after handling', () => {
	const { state, deps } = harness();
	handleQueueCommand(addCmd('q1'), deps);
	expect(state.entries.map((e) => e.id)).toEqual(['q1']);
	expect(state.rev).toBe(1);
});
