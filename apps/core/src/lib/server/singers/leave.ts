// Leaving the room, on purpose.
//
// Encore had no way out. There was no route, no cookie clear, and no singer delete — the only exit was
// to stop being reachable and let the grace window expire, which is a statement about your phone rather
// than about you. So a guest who went home stayed on the roster holding their name until a timer that
// exists to cover the OPPOSITE case (a locked phone that is coming back) ran out.
//
// An explicit leave is unambiguous, so it does not wait for that clock:
//   • their queued songs are UN-QUEUED — the one place songs leave the queue by a timer's decision is
//     nowhere, but this is a person acting on their own songs, the same carve-out as tapping remove
//   • they are forgotten immediately, so their name returns to the pool
//   • the caller clears the session cookie, so the phone lands back on /join rather than silently
//     rehydrating as the same singer
//
// What it deliberately does NOT do is stop the music. A playing entry is not a queued one, and yanking
// the video out from under a room that is watching it is worse than letting it finish — anyone can skip.
// An in-flight cook also runs to completion: the output is a durable library asset reusable by anyone,
// so cancelling mid-Demucs would mean partial artifacts and lease cleanup for no gain.

import type { EncoreApp } from '../app';
import type { QueueEntry, ServerEvent } from '$shared';
import { isTerminal } from '$shared';
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

	// One op per entry through the authoritative path, so every client converges the same way it would
	// on a hand-tapped remove — rather than a bespoke bulk event each client would need its own branch for.
	for (const entry of doomed) {
		const { rev, canonicalOps, entries } = app.state.applyQueueOp({ op: 'remove', id: entry.id });
		app.publish({ type: 'queue:patch', patch: { rev, ops: canonicalOps, entries } } satisfies ServerEvent);
	}

	// Forget them BEFORE announcing, so the membership snapshot the broadcast carries already excludes
	// them and no client has to reconcile a roster that still lists someone who just left.
	app.presence.forget(singerId);

	// an explicit leave un-queues their songs, which can change who plays next — a leaving
	// singer's queued pick may be the advertised upNext, or removing it promotes another singer. Each
	// remove above published only queue:patch, so nowplaying:changed was never re-derived and the TV
	// kept naming the departed song. Re-broadcast the true next once, after the removals, only when
	// something was actually removed (an empty leave changes no ordering). The playing entry is left
	// alone on purpose (see the header), so this never interrupts the current song. Deps mirror the
	// authoritative reconcileOnReady bag in app.ts so upNextAfter ranks by the room's real ordering.
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
