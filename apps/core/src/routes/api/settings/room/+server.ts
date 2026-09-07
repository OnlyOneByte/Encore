// PUT /api/settings/room — update THIS room's own policy (house rule, pacing, quality ceiling).
//
// Split from the global endpoint so a room write can never accidentally change deployment-wide
// separator policy: global answers "what can this deployment do", room "how does this party run".
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$server/app';
import { SESSION_COOKIE } from '$server/singers/repository';
import { can } from '$server/auth/capabilities';
import { mediaFor } from '$server/realtime/hub';
import { DEFAULT_ROOM_ID } from '$server/state/settings-repository';
import type { RoomSettings } from '@encore/shared';

export const PUT: RequestHandler = async ({ request, cookies, url }) => {
	const app = getApp();
	const singer = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	// Routed through can() rather than an inline truthiness check so the room-settings gate moves with
	// every other capability the day one of them narrows.
	if (!can({ singerId: singer?.id }, 'settings:write-room')) return json({ error: 'join first' }, { status: 401 });

	// Which room this write addresses. The repository has always been keyed by room id; only this
	// endpoint dropped it, so every write landed on the default room. `?roomId=` threads it back
	// through, defaulting to DEFAULT_ROOM_ID so existing callers (no param) are unchanged. Read from
	// the query string rather than the body so the JSON payload stays a pure Partial<RoomSettings>
	// that flows straight into the normalizer.
	const roomId = url.searchParams.get('roomId') ?? DEFAULT_ROOM_ID;

	let body: Partial<RoomSettings>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'invalid json' }, { status: 400 });
	}

	app.settings.setRoom(body, roomId);
	const settings = app.settings.getEffective(roomId);
	app.publish({ type: 'settings:changed', settings });

	// `queueOrder` is the one room setting that is not purely a render-time choice: `rotationSeq` is
	// STORED on each entry and re-derived only on a mutation, so persisting a new algorithm would
	// leave the TV and every phone on the old order until someone happened to add or remove a song.
	// Re-derive and broadcast the queue too.
	//
	// `reorder()` returns null when the order is unchanged, which covers both "they changed something
	// else" and "they re-picked the algorithm already in force" — publishing an unchanged snapshot
	// would make every client re-adopt state and re-apply its pending ops for nothing.
	//
	// This never interrupts the song playing: ordering ranks `queued` entries, and the current one is
	// `playing`. It changes who is NEXT.
	const reordered = app.state.reorder();
	if (reordered) {
		app.publish({
			type: 'queue:patch',
			// ops: [] with entries inline — the same shape the playback path publishes, which clients
			// already adopt wholesale and re-apply their pending ops onto.
			patch: {
				rev: reordered.rev,
				ops: [],
				entries: reordered.entries,
				media: mediaFor(reordered.entries, { mediaById: app.mediaById })
			}
		});
	}
	return json(settings);
};
