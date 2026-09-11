// Regression for issue #636 on the ROOM-SETTINGS (queueOrder) seam.
//
// Changing queueOrder re-derives rotationSeq, which changes who plays NEXT (the handler's own comment
// says exactly this). The handler re-broadcast the reordered queue:patch but NOT nowplaying:changed, so
// the TV's Up next kept naming the pre-reorder next until some later mutation. The fix adds
// emitNowPlaying(...) inside the `if (reordered)` block.
//
// This drives the REAL PUT handler against a REAL AuthoritativeState + SettingsRepository. The state's
// ordering getter reads the same settings repo the handler writes, so a fcfs→fair PUT genuinely
// reorders the queue — the production path, not a stub. Base-RED: on base the handler emits no
// nowplaying:changed on the reorder branch, so the assertion finds none.
//
// Expected next is HARD-CODED, never re-derived with the projection the code runs (the COMMON.md trap).
import { test, expect, afterEach } from 'bun:test';
import { PUT } from './+server';
import { SettingsRepository } from '$server/state/settings-repository';
import { AuthoritativeState } from '$server/state/store';
import { PlayTracker } from '$server/media/plays';
import { migratedDb } from '$server/db/test-db';
import { orderingOf } from '$server/realtime/hub';
import { EMPTY_SONG_PROFILE, type Media, type QueueEntry, type ServerEvent } from '@encore/shared';

const APP_KEY = Symbol.for('encore.app');
const ROOM = 'active-room';

const readyMedia = (id: string): Media => ({
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

function installApp() {
	const settings = new SettingsRepository(migratedDb());
	const mediaById = new Map<string, Media>();
	const published: ServerEvent[] = [];
	const singers = { listPublic: () => [], bySessionToken: () => ({ id: 'singer-1' }) };
	// The state's ordering getter reads the SAME settings repo the handler writes — exactly the
	// production wiring — so a fcfs→fair PUT reorders through app.state.reorder(). NOTE the 3rd
	// positional arg: AuthoritativeState(persistence, flushDelayMs, orderingOf).
	const state = new AuthoritativeState(undefined, 250, () =>
		orderingOf({ getSettings: () => settings.getEffective(ROOM), listSingers: () => singers.listPublic() })
	);
	const app = {
		singers,
		settings,
		activeRoomId: ROOM,
		state,
		mediaById,
		plays: new PlayTracker(() => {}),
		publish: (e: ServerEvent) => published.push(e)
	};
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = app;
	return { app, settings, state, mediaById, published };
}

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
});

function seed(state: AuthoritativeState, mediaById: Map<string, Media>, id: string, singerId: string, addedAt: number) {
	const mediaId = 'm-' + id;
	mediaById.set(mediaId, readyMedia(mediaId));
	state.applyQueueOp({
		op: 'add',
		entry: { id, mediaId, singerId, status: 'queued', rotationSeq: -1, addedAt } as QueueEntry
	});
}

function putQueueOrder(order: string) {
	const url = new URL(`http://x/api/settings/room?roomId=${ROOM}`);
	const request = new Request(url, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ queueOrder: order })
	});
	return PUT({ request, cookies: { get: () => 'ignored' }, url } as never);
}

test('a queueOrder change leaves the queue and the advertised next alone (#856)', async () => {
	const { settings, state, mediaById, published } = installApp();
	settings.setRoom({ queueOrder: 'fcfs' }, ROOM);

	// singer A queues a1, a2; singer B queues b1. Under the STORED-LIST model the queue is the
	// source of truth, so flipping the algorithm cannot rearrange songs already standing — it would
	// throw away every reorder anyone had made. #636 asked for the advertised next to stay honest
	// across a flip; it now stays honest because nothing moves.
	seed(state, mediaById, 'a1', 'A', 1);
	seed(state, mediaById, 'a2', 'A', 2);
	seed(state, mediaById, 'b1', 'B', 3);
	expect(state.entries.map((e) => e.id)).toEqual(['a1', 'a2', 'b1']);

	const before = published.length;
	const res = await putQueueOrder('fair');
	expect(res.status).toBe(200);

	// the standing queue is untouched by the flip (it used to become ['a1','b1','a2'])
	expect(state.entries.map((e) => e.id)).toEqual(['a1', 'a2', 'b1']);

	// and with nothing rearranged there is no next to re-advertise, so no nowplaying churn goes out
	const nps = published.slice(before).filter((e) => e.type === 'nowplaying:changed');
	expect(nps.length).toBe(0);
});

test('a settings PUT that does not reorder emits no nowplaying', async () => {
	// The emit is inside `if (reordered)`. Re-selecting the SAME order reorders nothing, so no
	// nowplaying:changed should go out — guards the fix against degrading into an unconditional emit.
	const { settings, state, mediaById, published } = installApp();
	settings.setRoom({ queueOrder: 'fcfs' }, ROOM);
	seed(state, mediaById, 'a1', 'A', 1);
	seed(state, mediaById, 'a2', 'A', 2);

	const before = published.length;
	const res = await putQueueOrder('fcfs'); // same order → reorder() returns null
	expect(res.status).toBe(200);
	const nps = published.slice(before).filter((e) => e.type === 'nowplaying:changed');
	expect(nps.length).toBe(0);
});
