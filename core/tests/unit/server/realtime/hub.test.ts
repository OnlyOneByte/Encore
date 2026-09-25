// Drive a command -> assert broadcast envelope + new rev.
import { test, expect } from 'bun:test';
import { handleQueueCommand, type HubDeps } from '$lib/server/realtime/hub';
import { AuthoritativeState } from '$lib/server/state/store';
import { ulid, type ServerEvent, type Media, type ClientCommand } from '$lib/contract';
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
	// The server re-stamps the add's addedAt server-side, so the canonical op is NOT byte-equal
	// to the client's — the ServerPatch contract declares ops as "server may rewrite". It IS the same
	// op otherwise: same id/mediaId/singerId/status, only addedAt is server-owned.
	const canon = patch!.patch.ops[0]!;
	expect(canon.op).toBe('add');
	const canonAdd = canon as Extract<typeof canon, { op: 'add' }>;
	expect(canonAdd.entry.id).toBe('q1');
	expect(canonAdd.entry.mediaId).toBe('m1');
	expect(canonAdd.entry.singerId).toBe('s1');
	expect(canonAdd.entry.status).toBe('queued');
	expect(Number.isFinite(canonAdd.entry.addedAt)).toBe(true);

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

// — onEntryAdded: the add-side mirror of onEntryRemoved (the starvation seam) —

const removeCmd = (entryId: string): ClientCommand => ({
	clientOpId: ulid(),
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

// — server-stamped addedAt — a client-minted addedAt is NOT an ordering weapon —
//
// These pin the BEHAVIOUR (who ranks first), not the stamp value: a test that re-derived the
// expected addedAt the way nextAddedAt() does would agree with any wrong stamp. Under the default
// fair ordering the rank is a singer's FIRST-pick addedAt, so the load-bearing check is that a
// forged below-everyone first pick does NOT put the forger ahead of an honestly-earlier singer.

// A multi-singer harness: two singers each add one song. s2 (who joins/adds SECOND) forges an
// addedAt far below s1's, trying to rank first. addCmdFor lets us pick the singerId + forged stamp.
function multiHarness() {
	const published: ServerEvent[] = [];
	const state = new AuthoritativeState();
	const mediaById = new Map<string, Media>([
		['m1', media('m1')],
		['m2', media('m2')]
	]);
	const mk = (singerId: string) => {
		const deps: HubDeps = { state, publish: (e) => published.push(e), mediaById, actorSingerId: singerId };
		return deps;
	};
	return { published, state, mk };
}

const addCmdWith = (entryId: string, mediaId: string, singerId: string, addedAt: number): ClientCommand => ({
	clientOpId: ulid(),
	op: { op: 'add', entry: { id: entryId, mediaId, singerId, status: 'queued', rotationSeq: -1, addedAt } }
});

test('a forged below-everyone addedAt does NOT put the forger at the head of the round', () => {
	const { state, mk } = multiHarness();
	// s1 adds honestly first.
	handleQueueCommand(addCmdWith('q1', 'm1', 's1', 1700000000000), mk('s1'));
	// s2 adds second but forges an addedAt of 0 — below every other singer's first pick.
	handleQueueCommand(addCmdWith('q2', 'm2', 's2', 0), mk('s2'));

	// Under fair rotation the order is by first-pick addedAt. If the client's forged 0 were trusted,
	// s2 (q2) would sit at seq 0. Server-stamping makes q2's real stamp LATER than q1's, so s1 leads.
	const order = state.entries
		.slice()
		.sort((a, b) => a.rotationSeq - b.rotationSeq)
		.map((e) => e.id);
	expect(order).toEqual(['q1', 'q2']);
});

test('a legitimate later add still lands AFTER an earlier one (fix is not clamp-everything)', () => {
	const { state, mk } = multiHarness();
	// Two honest adds by two singers, in join order s1 then s2, both with plausible client stamps.
	handleQueueCommand(addCmdWith('q1', 'm1', 's1', 1700000000000), mk('s1'));
	handleQueueCommand(addCmdWith('q2', 'm2', 's2', 1700000000005), mk('s2'));
	// The server stamp is monotonic in call order, so the earlier add ranks first — a fix that
	// pinned every add to a single constant, or rejected the second, would break this.
	const order = state.entries
		.slice()
		.sort((a, b) => a.rotationSeq - b.rotationSeq)
		.map((e) => e.id);
	expect(order).toEqual(['q1', 'q2']);
	expect(state.entries).toHaveLength(2);
});

test('server stamps are strictly increasing across two adds in the same singerId', () => {
	const { deps } = harness();
	const p1 = handleQueueCommand(addCmd('q1'), deps)!;
	const p2 = handleQueueCommand(addCmd('q2'), deps)!;
	const a1 = (p1.patch.ops[0] as Extract<ServerEvent, { type: 'queue:patch' }>['patch']['ops'][number] & { op: 'add' })
		.entry.addedAt;
	const a2 = (p2.patch.ops[0] as Extract<ServerEvent, { type: 'queue:patch' }>['patch']['ops'][number] & { op: 'add' })
		.entry.addedAt;
	// Distinct + increasing even if both landed in the same millisecond (Finding #4 monotonicity).
	expect(a2).toBeGreaterThan(a1);
	// And the client's minted addedAt (1) was NOT what got stored — the server owns it now.
	expect(a1).toBeGreaterThan(1);
});
