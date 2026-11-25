// "Pick another, keep your spot": `replace-media` swaps a turn's song and keeps its PLACE, so the singer whose song
// could not be made keeps the spot the held-slot rule kept for them — but not the dead song's PREFS, which belong to
// that song. One reducer (`applyAndReseq` → `applyOp`) serves the phone's optimistic copy and the server, so
// asserting the server's result asserts the prediction too.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '$test';
import { handleQueueCommand, validateCommand, type HubDeps } from '$lib/server/realtime/hub';
import { AuthoritativeState } from '$lib/server/state/store';
import { applyOp, type ClientCommand, type Media, type QueueEntry } from '$lib/contract';

const media = (id: string): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'vid-' + id,
	title: id,
	durationSec: 100,
	stemStatus: 'none'
});
const entry = (id: string, singerId: string, mediaId: string, addedAt: number, over: Partial<QueueEntry> = {}) =>
	({ id, mediaId, singerId, status: 'queued', rotationSeq: 0, addedAt, ...over }) as QueueEntry;

function harness() {
	const state = new AuthoritativeState();
	// Maya's dead song is first in line, preset to -2 with a quiet guide and its Not yet spent; Theo's is second.
	state.hydrate(
		[
			entry('maya1', 'maya', 'dead', 1, { keyShift: -2, guideLevel: 0.2, deferred: true }),
			entry('theo1', 'theo', 'other', 2)
		],
		null
	);
	const removed: string[] = [];
	const added: string[] = [];
	const deps: HubDeps = {
		state,
		publish: () => {},
		mediaById: new Map(['dead', 'other', 'fresh'].map((id) => [id, media(id)])),
		actorSingerId: 'maya',
		onEntryRemoved: (id) => removed.push(id),
		onEntryAdded: (id) => added.push(id)
	};
	return { state, deps, removed, added };
}

const cmd = (op: ClientCommand['op']): ClientCommand => ({ clientOpId: 'c1', op });
const replace = (keyShift = 0) =>
	cmd({ op: 'replace-media', id: 'maya1', mediaId: 'fresh', keyShift }) as ClientCommand;

test('the turn keeps its id, its place, its stamp and its spent Not yet; the song changes', () => {
	const { state, deps } = harness();
	const before = state.entries.find((e) => e.id === 'maya1')!;
	handleQueueCommand(replace(), deps);
	expect(state.entries.map((e) => [e.id, e.mediaId])).toEqual([
		['maya1', 'fresh'],
		['theo1', 'other']
	]);
	const after = state.entries.find((e) => e.id === 'maya1')!;
	expect(after).toMatchObject({
		id: before.id,
		singerId: before.singerId,
		addedAt: before.addedAt,
		rotationSeq: before.rotationSeq,
		deferred: true
	});
});

test("replace drops the dead song's key and guide: the new song's remembered key, the room's guide", () => {
	const { state, deps } = harness();
	handleQueueCommand(replace(3), deps);
	expect(state.entries.find((e) => e.id === 'maya1')).toMatchObject({ keyShift: 3, guideLevel: null });
	// No remembered key for the new song is the original key, never the -2 chosen for the dead one.
	const fresh = harness();
	handleQueueCommand(replace(0), fresh.deps);
	expect(fresh.state.entries.find((e) => e.id === 'maya1')).toMatchObject({ keyShift: 0, guideLevel: null });
});

test('the old song loses its claim and the new one gains it, as a remove and an add would', () => {
	const { deps, removed, added } = harness();
	handleQueueCommand(replace(), deps);
	expect(removed).toEqual(['dead']);
	expect(added).toEqual(['fresh']);
});

test('an unknown song, a bad key or a turn that is not waiting is refused, so the phone rolls back', () => {
	const { state, deps } = harness();
	expect(validateCommand(cmd({ op: 'replace-media', id: 'maya1', mediaId: 'nope', keyShift: 0 }), deps)).toBe(
		'unknown media: nope'
	);
	expect(validateCommand(cmd({ op: 'replace-media', id: 'ghost', mediaId: 'fresh', keyShift: 0 }), deps)).toBe(
		'unknown entry: ghost'
	);
	expect(validateCommand(replace(99), deps)).toBe('invalid keyShift: 99');
	// Absent would read as "keep the dead song's key" on apply, so it is refused rather than defaulted.
	expect(
		validateCommand(cmd({ op: 'replace-media', id: 'maya1', mediaId: 'fresh' } as ClientCommand['op']), deps)
	).toBe('missing keyShift');
	state.applyQueueOp({ op: 'status', id: 'maya1', status: 'playing' });
	expect(validateCommand(replace(), deps)).toBe('only a waiting turn can change song');
});

test("the new song's guide rides on the swap (Your songs); a bad one, or one on someone else's turn, is refused", () => {
	const { state, deps } = harness();
	const withGuide = (guideLevel: unknown) =>
		cmd({ op: 'replace-media', id: 'maya1', mediaId: 'fresh', keyShift: -1, guideLevel } as ClientCommand['op']);
	expect(validateCommand(withGuide(2), deps)).toBe('invalid guideLevel: 2');
	expect(validateCommand(withGuide('0.3'), deps)).toBe('invalid guideLevel: 0.3');
	expect(validateCommand(withGuide(0.3), { ...deps, actorSingerId: 'theo' })).toBe(
		'only the singer can change this entry'
	);
	handleQueueCommand(withGuide(0.3), deps);
	expect(state.entries.find((e) => e.id === 'maya1')).toMatchObject({
		mediaId: 'fresh',
		keyShift: -1,
		guideLevel: 0.3
	});
});

test("swapping someone else's song asks for what removing it asks for", () => {
	// A source pin: `can` grants every joined singer everything today and a caller with no session is refused
	// earlier, so no command can tell the capabilities apart yet. The day `can` narrows, this is the line that matters.
	const hub = readFileSync(at('src/lib/server/realtime/hub.ts'), 'utf8');
	expect(hub).toContain(
		"'replace-media': { capability: 'queue:remove-any', refusal: 'not allowed to change this entry' }"
	);
});

test('the shared reducer itself never swaps the song under a PLAYING turn', () => {
	// The guard both sides run, not only the server's refusal: the TV is decoding the playing song's media.
	const playing = entry('maya1', 'maya', 'dead', 1, { status: 'playing', keyShift: -2 });
	const [after] = applyOp([playing], { op: 'replace-media', id: 'maya1', mediaId: 'fresh', keyShift: 0 });
	expect(after).toEqual(playing);
});
