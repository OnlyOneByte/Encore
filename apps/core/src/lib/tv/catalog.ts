// The TV's media-catalog boundary — ONE writer for server truth, and a snapshot seam the process
// pipeline structurally cannot reach.
//
// WHY THIS MODULE EXISTS (#396). "The playing song jumped back to an earlier part when another song
// finished processing" was fixed four times and returned four times, because every fix hardened one
// CONSUMER against one churn PATH. The invariant was written down once, in prose, in the old
// `mergeCatalog` docstring on the TV route — "an unrelated process must not churn the object graph the
// whole render tree reads" — applied at one of the two catalog writers, and never made structural.
//
// This module makes it structural, in three parts that each hold on their own:
//
//   1. ONE WRITER. `mergeCatalog` is the only way a Media record enters the catalog, and the catalog
//      carries SERVER TRUTH only (`queue:sync`). The process lifecycle has no entry point here at all —
//      see `processIsTerminal` below, which is the whole of what a process event is allowed to decide.
//   2. A SNAPSHOT SEAM. What the player is handed is a `PlaybackSnapshot`, not a `Media`. The brand
//      makes that a COMPILER boundary: a live catalog record is not assignable to a snapshot, so a
//      future writer cannot hand the playing slot something the catalog can still change under it.
//   3. IDENTITY PRESERVATION. A structurally-unchanged record keeps its previous object identity, so
//      even a consumer that (wrongly) tracks identity is not woken by an unrelated process.
//
// Parts 2 and 3 are deliberately redundant. That redundancy is the point: two independent reasons
// the class stays closed, so the next consumer added to the render tree does not re-open it.

import type { Media } from '@encore/shared';
import type { ServerEvent } from '@encore/shared';

/**
 * Fold a fresh `queue:sync` media list into the existing catalog, PRESERVING the existing object
 * identity for any song whose fields are unchanged.
 *
 * Comparing by JSON is adequate here: Media is a flat, JSON-shaped record already sent over the wire
 * as JSON, so a structural match means genuinely-equal fields, and reusing the prior object on a
 * match keeps identity stable for every downstream consumer.
 *
 * This is the ONLY writer. It takes a full server list, so it cannot express a partial local edit —
 * which is exactly why the process path can no longer make one.
 */
export function mergeCatalog(prev: Map<string, Media>, incoming: Media[]): Map<string, Media> {
	const next = new Map<string, Media>();
	let changed = incoming.length !== prev.size;
	for (const m of incoming) {
		const existing = prev.get(m.id);
		const keep = existing && JSON.stringify(existing) === JSON.stringify(m);
		if (!keep) changed = true;
		next.set(m.id, keep ? existing : m);
	}
	// Nothing moved: hand back the SAME Map. A fresh Map with identical contents is still a fresh
	// `$state` value, and a sync that changed nothing must not be a re-render reason either.
	return changed ? next : prev;
}

declare const SNAPSHOT_BRAND: unique symbol;

/**
 * An immutable copy of the Media a slot is playing or holding, taken when that slot was assigned.
 *
 * The brand is load-bearing, not decoration: it is what makes the boundary a TYPE ERROR rather than a
 * convention. `media={mediaCatalog.get(id)}` does not compile, so the only way to give the player a
 * song is through `snapshot()` at an explicit lifecycle transition.
 */
export type PlaybackSnapshot = Readonly<Media> & { readonly [SNAPSHOT_BRAND]: true };

/**
 * Take a slot's snapshot. Call this ONLY from an explicit playback transition (a real song change) —
 * never from a catalog observation, which is the coupling this exists to break.
 *
 * A fresh top-level object, frozen: the fields playback reads (`id`, `stemStatus`, `instrumentalRef`)
 * cannot be rewritten under a playing song, and a later catalog reassignment is unobservable through
 * it. Nested values are shared rather than deep-cloned, which is safe because catalog writers never
 * mutate in place — they replace records — and a deep clone would be a false promise about objects
 * this module does not own.
 */
export function snapshot(m: Media | null | undefined): PlaybackSnapshot | null {
	return m ? (Object.freeze({ ...m }) as PlaybackSnapshot) : null;
}

/**
 * Is this process event a terminal failure — the one thing a process event may still decide for the room?
 *
 * A process that FAILED, or a job no connected worker advertises the capability for (`unservable`), will
 * never become playable, and `enterWaiting()` sets no timer — so without this the party stares at
 * "Making the karaoke" forever. That is a LIFECYCLE exit, not a catalog edit, which is why it is the
 * only thing left on the process path and why it is a pure predicate rather than a store write.
 *
 * The ready case is deliberately absent: `ready` is delivered by the server as `queue:sync` +
 * `nowplaying:changed` (`onMediaReady` publishes both), so the TV leaves `waiting` on an explicit
 * playback event and never by observing the catalog.
 */
export function processIsTerminal(e: Extract<ServerEvent, { type: 'media:status' }>): boolean {
	return e.status === 'failed' || e.unservable === true;
}
