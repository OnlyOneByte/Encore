// Drive a command -> assert broadcast envelope + new rev.
import { test, expect } from 'bun:test';
import { handleQueueCommand, type HubDeps } from './hub';
import { AuthoritativeState } from '../state/store';
import { ulid, type ServerEvent, type Media, type ClientCommand } from '@encore/shared';
import { EMPTY_SONG_PROFILE } from '@encore/shared';

const media = (id: string): Media => ({
	id, source: 'youtube', sourceRef: 'x', title: id, durationSec: 100, stemStatus: 'ready', lyricsStatus: 'ready', instrumentalRef: 'derived/stems/i-instrumental.flac', songProfile: EMPTY_SONG_PROFILE
});

function harness() {
	const published: ServerEvent[] = [];
	const state = new AuthoritativeState();
	const deps: HubDeps = {
		state,
		publish: (e) => published.push(e),
		mediaById: new Map([['m1', media('m1')]]),
		actorSingerId: 's1'
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

	// hub emits exactly ONE message: a queue:patch carrying the authoritative entries inline
	// (Finding #3 — no redundant second queue:sync per mutation)
	expect(published).toHaveLength(1);
	expect(published[0]!.type).toBe('queue:patch');
	const p = published[0] as Extract<ServerEvent, { type: 'queue:patch' }>;
	expect(p.patch.rev).toBe(1);
	expect(p.patch.entries!.map((e) => e.id)).toEqual(['q1']);
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

// — onEntryAdded: the add-side mirror of onEntryRemoved (#135 starvation seam) —

const removeCmd = (entryId: string): ClientCommand => ({
	clientOpId: ulid(),
	baseRev: 0,
	op: { op: 'remove', id: entryId }
});

test('onEntryAdded fires on a valid add with the added mediaId and the POST-add queue', () => {
	const { deps } = harness();
	const fired: { mediaId: string; ids: string[] }[] = [];
	deps.onEntryAdded = (mediaId, entries) => fired.push({ mediaId, ids: entries.map((e) => e.id) });

	handleQueueCommand(addCmd('q1', 'm1'), deps);

	expect(fired).toHaveLength(1);
	expect(fired[0]!.mediaId).toBe('m1');
	expect(fired[0]!.ids).toEqual(['q1']); // the just-added entry is present in the passed queue
});

test('onEntryAdded does NOT fire on a remove (that side owns onEntryRemoved)', () => {
	const { deps } = harness();
	handleQueueCommand(addCmd('q1', 'm1'), deps); // land an entry first
	let added = 0;
	deps.onEntryAdded = () => added++;
	handleQueueCommand(removeCmd('q1'), deps);
	expect(added).toBe(0);
});
