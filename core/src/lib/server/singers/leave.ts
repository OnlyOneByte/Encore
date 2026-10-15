// Leaving the room, on purpose: un-queues the leaver's songs (the same carve-out as tapping remove, not the grace timer's decision), forgets them immediately so their name returns to the pool, and the caller clears the session cookie so the phone lands back on /join rather than rehydrating as the same singer. Deliberately does NOT stop the music: a playing entry is left alone (yanking it out from under a watching room is worse than letting it finish; anyone can skip), and an in-flight process runs to completion, since its output is a durable, reusable library asset.

import type { EncoreApp } from '../app';
import type { QueueEntry, ServerEvent } from '../../contract';
import { isTerminal } from '../../contract';
import { emitNowPlaying } from '../realtime/player';

export interface LeaveResult {
	/** Entry ids removed from the queue. */
	removed: string[];
	/** The still-playing entry of theirs, if any — left alone on purpose. */
	keptPlaying: string | null;
}

/** Everything of theirs a leave would remove. Exposed so the phone can name the cost before asking. */
export function removableOnLeave(app: EncoreApp, singerId: string): QueueEntry[] {
	return app.state.entries.filter((e) => e.singerId === singerId && e.status !== 'playing' && !isTerminal(e));
}

export function doLeave(app: EncoreApp, singerId: string): LeaveResult {
	const doomed = removableOnLeave(app, singerId);
	const playing = app.state.entries.find((e) => e.singerId === singerId && e.status === 'playing');

	// One op per entry through the authoritative path, so every client converges the same way it would on a hand-tapped remove, rather than needing a bespoke bulk-event branch.
	for (const entry of doomed) {
		const { rev, canonicalOps, entries } = app.state.applyQueueOp({ op: 'remove', id: entry.id });
		app.publish({ type: 'queue:patch', patch: { rev, ops: canonicalOps, entries } } satisfies ServerEvent);
	}

	// Forget them, then tell server.ts to re-derive. BOTH are needed, and `forget` alone is what this comment used to claim was enough: it deletes the presence record, but the roster in the per-socket replies server.ts builds — the hello reply's queue:sync, via its per-frame `listOnline`/`listAway` — comes from server.ts's CACHED membership snapshot, and that cache is refreshed only on socket edges, on a queue:command and on the 20s sweep. (Not every queue:sync reads it: app.ts's onMediaReady broadcast builds its own from `app.presence.online()`, the live map, with `away` omitted — so that one is never the stale path.) The leaver's own socket closing cannot refresh it either, since `presence.disconnect` is a no-op for a record that is already gone. So without this call the next hello reply — a TV reload, or its 15s heartbeat — re-advertises someone who went home, and the television names them as in the room until the sweep corrects it. The refresh also publishes the `singer:presence` edge both clients already handle, so no new event is needed.
	// The call is optional because server.ts assigns it and the unit harnesses do not; see EncoreApp.refreshMembership.
	app.presence.forget(singerId);
	app.refreshMembership?.();
	// One side effect worth naming, since it is the only way this is observable beyond the roster: refreshing re-runs `presence.evaluate`, which starts the grace clock for ANY singer sitting socket-less with nothing queued — up to 20s earlier than the sweep would have. That is the documented intent (the clock starts on an empty queue, not on the socket drop) and is what the queue:command arm already does. It is NOT affected by where this sits relative to the removals above: those remove only the leaver's own entries, and the leaver is forgotten by the time `evaluate` runs, so no remaining singer's pending set can differ either side of them.

	// Leaving un-queues songs that can change who plays next (the departed singer's queued pick may have been the advertised upNext). Each remove above published only queue:patch, so nowplaying:changed was never re-derived — re-broadcast the true next once, after the removals, only when something was actually removed. Deps mirror the authoritative reconcileOnReady bag in app.ts so upNextAfter ranks by the room's real ordering.
	if (doomed.length > 0) {
		emitNowPlaying({
			state: app.state,
			publish: (e) => app.publish(e),
			mediaById: app.mediaById,
			listSingers: () => app.singers.listPublic(app.activeRoomId),
			getSettings: () => app.settings.getEffective(app.activeRoomId),
			onNowPlaying: (e) => app.plays.onNowPlaying(e)
		});
	}

	return { removed: doomed.map((e) => e.id), keptPlaying: playing?.id ?? null };
}
