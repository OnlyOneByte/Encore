import { afterEach, expect, test } from 'bun:test';
import { RoomLink } from '$lib/stores/room';
import { handleQueueCommand } from '$lib/server/realtime/hub';
import { AuthoritativeState } from '$lib/server/state/store';
import { EMPTY_SONG_PROFILE, type Media, type PublicSinger, type QueueEntry, type ServerEvent } from '$lib/contract';

/*
 * Two phones raced and the server held someone else's On deck. The guest hears the queue tab's own
 * sentence as an INFO toast, never the raw "Couldn't do that: on deck is held: …". The real `connect()` path with
 * the browser globals stubbed, and the refusal minted by the real hub, so the parsed wording is the one it sends.
 */

const song = (id: string): Media => ({
	id,
	source: 'youtube',
	sourceRef: id,
	title: id,
	durationSec: 100,
	stemStatus: 'ready',
	lyricsStatus: 'ready',
	instrumentalRef: `derived/stems/${id}-instrumental.flac`,
	songProfile: EMPTY_SONG_PROFILE
});
const singer = (id: string, displayName: string): PublicSinger => ({ id, displayName, color: '#f80', joinedAt: 1 });
const entry = (id: string, singerId: string, rotationSeq: number, status: QueueEntry['status'] = 'queued') =>
	({ id, mediaId: 'm', singerId, status, rotationSeq, addedAt: rotationSeq + 1 }) as QueueEntry;

const ENTRIES = [
	entry('caroline', 'maya', 0, 'playing'),
	entry('believin', 'theo', 1),
	entry('prayer', 'ana', 2),
	entry('brightside', 'ana', 3)
];

const real = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
const g = globalThis as Record<string, unknown>;
let link: RoomLink | undefined;

afterEach(() => {
	link?.close();
	globalThis.fetch = real.fetch;
	globalThis.WebSocket = real.WebSocket;
	delete g.window;
	delete g.location;
});

async function connectedAs(meId: string, name: string) {
	const sockets: { onmessage: ((ev: { data: string }) => void) | null; sent: string[] }[] = [];
	g.window = {};
	g.location = { protocol: 'http:', host: 'box' };
	globalThis.WebSocket = class {
		onopen = null;
		onclose = null;
		onmessage = null;
		sent: string[] = [];
		send(data: string) {
			this.sent.push(data);
		}
		close() {}
		constructor() {
			sockets.push(this);
		}
	} as unknown as typeof WebSocket;
	globalThis.fetch = (async (url: string) =>
		new Response(JSON.stringify(url === '/api/me' ? { singer: singer(meId, name) } : { library: [] }), {
			status: 200
		})) as unknown as typeof fetch;
	link = new RoomLink();
	const notices: { message: string; kind: string }[] = [];
	link.onError((message, kind) => notices.push({ message, kind }));
	await link.connect();
	const deliver = (e: ServerEvent) => sockets[0]!.onmessage!({ data: JSON.stringify(e) });
	deliver({
		type: 'queue:sync',
		rev: 1,
		entries: ENTRIES,
		media: [song('m')],
		singers: [singer('maya', 'Maya'), singer('theo', 'Theo'), singer('ana', 'Ana')]
	});
	return { link, notices, socket: sockets[0]!, deliver };
}

async function raceAs(meId: string, name: string) {
	const { link, notices, socket, deliver } = await connectedAs(meId, name);
	link.queue!.moveToIndex('brightside', 0);
	const cmd = JSON.parse(socket.sent.filter((s) => s.includes('queue:command')).at(-1)!).command;
	const state = new AuthoritativeState();
	state.hydrate(ENTRIES, null);
	const sent: ServerEvent[] = [];
	const deps = { state, publish: () => {}, mediaById: new Map([['m', song('m')]]), actorSingerId: meId };
	handleQueueCommand(cmd, deps, (e) => sent.push(e));
	expect(sent[0]?.type).toBe('op:reject');
	deliver(sent[0]!);
	return { link, notices };
}

test('Maya`s raced drag is told who is on deck and whose song goes after, as info', async () => {
	const { link, notices } = await raceAs('maya', 'Maya');
	expect(notices).toEqual([{ message: 'Theo’s on deck. Ana goes right after.', kind: 'info' }]);
	// The optimistic move rolled back: Theo is still first.
	expect(link.entries.filter((e) => e.status === 'queued').map((e) => e.id)[0]).toBe('believin');
});

/** The link's playback as the server sends it: `currentEntryId` names whose song is on. */
const playing = (currentEntryId: string): ServerEvent => ({
	type: 'playback:state',
	rev: 2,
	state: { currentEntryId, isPlaying: true, positionSec: 5, keyShift: 0, guideLevel: null, background: null }
});

test('the phone holds the server`s entry: Theo`s On deck while Maya sings, nothing while Theo sings back to back', async () => {
	const { link, deliver } = await connectedAs('ana', 'Ana');
	deliver(playing('caroline'));
	expect(link.heldId).toBe('believin');
	deliver({
		type: 'queue:sync',
		rev: 3,
		entries: [entry('theo-1', 'theo', 0, 'playing'), entry('theo-2', 'theo', 1), entry('ana-1', 'ana', 2)],
		media: [song('m')]
	});
	deliver(playing('theo-1'));
	expect(link.heldId).toBeNull();
});

test('Ana dragging her own song hears "You"', async () => {
	const { notices } = await raceAs('ana', 'Ana');
	expect(notices).toEqual([{ message: 'Theo’s on deck. You go right after.', kind: 'info' }]);
});
