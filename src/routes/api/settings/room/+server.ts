// PUT /api/settings/room — update THIS room's own policy (house rule, pacing, quality ceiling). Split from the global endpoint so a room write can never accidentally change deployment-wide separator policy: global answers "what can this deployment do", room "how does this party run".
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { SESSION_COOKIE } from '$lib/server/singers/repository';
import { can } from '$lib/server/capabilities';
import { mediaFor } from '$lib/server/realtime/hub';
import { emitNowPlaying } from '$lib/server/realtime/player';
import type { RoomSettings } from '$lib/contract';

export const PUT: RequestHandler = async ({ request, cookies, url }) => {
	const app = getApp();
	const singer = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	// Routed through can() rather than an inline truthiness check so the room-settings gate moves with every other capability the day one of them narrows.
	if (!can({ singerId: singer?.id }, 'settings:write-room')) return json({ error: 'join first' }, { status: 401 });

	// `?roomId=` names the room explicitly; an omitted param falls back to the LIVE room (app.activeRoomId), never a literal default — a param-less client (the phone settings page fetches this bare) would otherwise write to a room no reader is looking at. Read from the query string, not the body, so the JSON payload stays a pure Partial<RoomSettings> for the normalizer.
	const roomId = url.searchParams.get('roomId') ?? app.activeRoomId;

	let body: Partial<RoomSettings>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'invalid json' }, { status: 400 });
	}

	app.settings.setRoom(body, roomId);
	const settings = app.settings.getEffective(roomId);
	app.publish({ type: 'settings:changed', settings });

	// `queueOrder` is the one room setting that isn't purely a render-time choice: `rotationSeq` is STORED on each entry and re-derived only on a mutation, so persisting a new algorithm would leave the TV and every phone on the old order until someone happened to add or remove a song. Re-derive and broadcast the queue too. `reorder()` returns null when the order is unchanged, so an unchanged pick publishes nothing rather than making every client re-adopt state for no reason. This never interrupts the song playing — ordering ranks `queued` entries, not the `playing` one; it changes who is NEXT.
	const reordered = app.state.reorder();
	if (reordered) {
		app.publish({
			type: 'queue:patch',
			// ops: [] with entries inline — the same shape the playback path publishes, which clients already adopt wholesale.
			patch: {
				rev: reordered.rev,
				ops: [],
				entries: reordered.entries,
				media: mediaFor(reordered.entries, { mediaById: app.mediaById })
			}
		});
		// The reorder changes who plays NEXT, but queue:patch alone leaves nowplaying:changed stale, so the TV would keep naming the pre-reorder next. Re-broadcast the true next; deps mirror the authoritative reconcileOnReady bag in app.ts so upNextAfter ranks by the order just chosen.
		emitNowPlaying({
			state: app.state,
			publish: (e) => app.publish(e),
			mediaById: app.mediaById,
			listSingers: () => app.singers.listPublic(roomId),
			getSettings: () => app.settings.getEffective(roomId),
			onNowPlaying: (e) => app.plays.onNowPlaying(e)
		});
	}
	return json(settings);
};
