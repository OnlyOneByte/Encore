import { afterEach, expect, test } from 'bun:test';
import { RoomLink } from '$lib/stores/room';
import { handleQueueCommand, type HubDeps } from '$lib/server/realtime/hub';
import { AuthoritativeState } from '$lib/server/state/store';
import {
	DEFAULT_EFFECTIVE_SETTINGS,
	EMPTY_SONG_PROFILE,
	singHistoryFrom,
	type ClientCommand,
	type Media,
	type QueueEntry,
	type ServerEvent
} from '$lib/contract';

/*
 * Proposal 14, the PHONE's half of the hold: which entry it holds (`room.heldId`), and that its optimistic add lands
 * exactly where the server commits it. The room is longest-ago order, Maya singing, Ana's song still being made AHEAD
 * of Theo's ready one — so the held entry is the next PLAYABLE one, not the first queued — and Zoe, who has never sung,
 * adds a song the policy alone would put first. The real `connect()` path with browser globals stubbed, and the commit
 * made by the real hub, as in room-held-toast.test.ts.
 */

const media = (id: string, ready = true): Media => ({
	id,
	source: 'youtube',
	sourceRef: id,
	title: id,
	durationSec: 100,
	stemStatus: ready ? 'ready' : 'queued',
	lyricsStatus: 'ready',
	instrumentalRef: ready ? `derived/stems/${id}-instrumental.flac` : undefined,
	songProfile: EMPTY_SONG_PROFILE
});
const MEDIA = [media('ready'), media('cooking', false)];
const entry = (id: string, singerId: string, rotationSeq: number, over: Partial<QueueEntry> = {}): QueueEntry => ({
	id,
	mediaId: 'ready',
	singerId,
	status: 'queued',
	rotationSeq,
	addedAt: rotationSeq + 1,
	...over
});
const SUNG: Record<string, number> = { maya: 3, theo: 1, ana: 2 };
const singers = ['maya', 'theo', 'ana', 'zoe'].map((id) => ({
	id,
	displayName: id,
	color: '#000',
	joinedAt: 1,
	lastSungAt: SUNG[id] ?? null
}));
const ORDER = 'least-recently-sung';
const ROOM = [
	entry('caroline', 'maya', 0, { status: 'playing' }),
	entry('ana-cook', 'ana', 1, { mediaId: 'cooking' }),
	entry('believin', 'theo', 2),
	entry('prayer', 'ana', 3)
];
const queuedIds = (list: readonly QueueEntry[]) =>
	list
		.filter((e) => e.status === 'queued')
		.sort((a, b) => a.rotationSeq - b.rotationSeq)
		.map((e) => e.id);

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

/** Zoe's phone, connected, synced to `entries` under longest-ago order. */
async function zoesPhone(entries: QueueEntry[]) {
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
		new Response(JSON.stringify(url === '/api/me' ? { singer: singers[3] } : { library: [] }), {
			status: 200
		})) as unknown as typeof fetch;
	link = new RoomLink();
	await link.connect();
	const deliver = (e: ServerEvent) => sockets[0]!.onmessage!({ data: JSON.stringify(e) });
	const settings = { ...DEFAULT_EFFECTIVE_SETTINGS, room: { ...DEFAULT_EFFECTIVE_SETTINGS.room, queueOrder: ORDER } };
	deliver({ type: 'queue:sync', rev: 1, entries, media: MEDIA, singers, settings } as unknown as ServerEvent);
	deliver({
		type: 'playback:state',
		rev: 2,
		state: {
			currentEntryId: 'caroline',
			isPlaying: true,
			positionSec: 5,
			keyShift: 0,
			guideLevel: null,
			background: null
		}
	});
	const lastCommand = () =>
		JSON.parse(sockets[0]!.sent.filter((s) => s.includes('queue:command')).at(-1)!).command as ClientCommand;
	return { link, deliver, lastCommand };
}

/** What the server commits for `cmd` on `entries`: the real hub, the same order and sing history. */
function commit(entries: QueueEntry[], cmd: ClientCommand): string[] {
	const state = new AuthoritativeState(undefined, 250, () => ({
		order: ORDER,
		lastSungAt: singHistoryFrom(singers)
	}));
	state.hydrate(
		entries.map((e) => ({ ...e })),
		null
	);
	const deps = {
		state,
		publish: () => {},
		mediaById: new Map(MEDIA.map((m) => [m.id, m])),
		actorSingerId: 'zoe',
		getSettings: () => ({ room: { queueOrder: ORDER } }),
		listSingers: () => singers
	} as unknown as HubDeps;
	return queuedIds(handleQueueCommand(cmd, deps)!.patch.entries!);
}

test('the phone holds the next PLAYABLE entry: Theo`s, not the cooking song ahead of it', async () => {
	const { link } = await zoesPhone(ROOM);
	expect(link.heldId).toBe('believin');
});

test('the phone`s optimistic add lands where the server commits it: behind On deck, not first', async () => {
	const { link, lastCommand } = await zoesPhone(ROOM);
	link.queue!.addSong('ready');
	const cmd = lastCommand();
	const zoe = cmd.op.op === 'add' ? cmd.op.entry.id : '';
	const predicted = queuedIds(link.entries);
	expect(predicted).toEqual(commit(ROOM, cmd));
	// The cooking song keeps its place in front; Zoe lands right behind Theo, never ahead of him.
	expect(predicted).toEqual(['ana-cook', 'believin', zoe, 'prayer']);
});

test('a pending add is re-placed against the NEW list`s hold when a patch moves it (Theo`s Not yet)', async () => {
	const { link, deliver, lastCommand } = await zoesPhone(ROOM);
	link.queue!.addSong('ready');
	const cmd = lastCommand();
	// Before Zoe's echo, Theo taps Not yet: his song steps behind Ana's, so On deck is now `prayer`.
	const after = [
		entry('caroline', 'maya', 0, { status: 'playing' }),
		entry('ana-cook', 'ana', 1, { mediaId: 'cooking' }),
		entry('prayer', 'ana', 2),
		entry('believin', 'theo', 3, { deferred: true })
	];
	deliver({ type: 'queue:patch', patch: { rev: 3, ops: [], entries: after } });
	const zoe = cmd.op.op === 'add' ? cmd.op.entry.id : '';
	expect(queuedIds(link.entries)).toEqual(commit(after, cmd));
	expect(queuedIds(link.entries)).toEqual(['ana-cook', 'prayer', zoe, 'believin']);
});

test('the current singer is read off the LIST, as the server does: a song-change patch can beat its playback:state', async () => {
	const { link, deliver, lastCommand } = await zoesPhone(ROOM);
	link.queue!.addSong('ready');
	const cmd = lastCommand();
	// Maya's song ended and Theo's started, and the patch says so before `playback:state` does: playback still names
	// `caroline`, which this list no longer holds. Ana's `prayer` is On deck now, behind her cooking song.
	const after = [
		entry('believin', 'theo', 0, { status: 'playing' }),
		entry('ana-cook', 'ana', 1, { mediaId: 'cooking' }),
		entry('prayer', 'ana', 2)
	];
	deliver({ type: 'queue:patch', patch: { rev: 3, ops: [], entries: after } });
	expect(link.playback.currentEntryId).toBe('caroline');
	expect(link.heldId).toBe('prayer');
	const zoe = cmd.op.op === 'add' ? cmd.op.entry.id : '';
	expect(queuedIds(link.entries)).toEqual(commit(after, cmd));
	expect(queuedIds(link.entries)).toEqual(['ana-cook', 'prayer', zoe]);
});
