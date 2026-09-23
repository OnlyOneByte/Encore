// The TV's media-catalog boundary. An unrelated song finishing its processing must not churn the object
// graph the render tree reads, or the playing song jumps. Three independent defences: `mergeCatalog` is the
// ONLY writer and carries server truth only; the player is handed a branded `PlaybackSnapshot`, so a live
// record is a compile error; and a structurally-unchanged record keeps its object identity, so a consumer
// that tracks identity is still not woken. The last two are deliberately redundant.

import type { Media } from '$lib/contract';
import type { ServerEvent } from '$lib/contract';

/**
 * Fold a fresh `queue:sync` media list into the catalog, PRESERVING object identity for any song whose
 * fields are unchanged. JSON comparison is adequate because Media is flat and already wire-JSON.
 *
 * The ONLY writer, and it takes a FULL server list — so it cannot express a partial local edit, which is
 * what keeps the process path out.
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
	// Nothing moved: hand back the SAME Map. A fresh Map with identical contents is still a fresh `$state`
	// value, so a sync that changed nothing must not be a re-render reason either.
	return changed ? next : prev;
}

declare const SNAPSHOT_BRAND: unique symbol;

/**
 * An immutable copy of the Media a slot is playing or holding. The brand is load-bearing:
 * `media={mediaCatalog.get(id)}` does not compile, so `snapshot()` is the only way in.
 */
export type PlaybackSnapshot = Readonly<Media> & { readonly [SNAPSHOT_BRAND]: true };

/**
 * Take a slot's snapshot. Call ONLY from an explicit playback transition, never from a catalog observation —
 * that coupling is what this exists to break. Frozen SHALLOW copy: nested values are shared rather than
 * deep-cloned, which is safe because catalog writers replace records instead of mutating them in place.
 */
export function snapshot(m: Media | null | undefined): PlaybackSnapshot | null {
	return m ? (Object.freeze({ ...m }) as PlaybackSnapshot) : null;
}

/**
 * Is this process event a terminal failure — the one thing a process event may still decide for the room? A
 * `failed` job, or one no connected worker advertises the capability for, never becomes playable and
 * `enterWaiting()` sets no timer, so the party would stare at "Making the karaoke" forever. A LIFECYCLE
 * exit, not a catalog edit, hence a pure predicate.
 *
 * The ready case is deliberately absent: the server delivers `ready` as `queue:sync` +
 * `nowplaying:changed`, so the TV leaves `waiting` on a playback event, never by observing the catalog.
 */
export function processIsTerminal(e: Extract<ServerEvent, { type: 'media:status' }>): boolean {
	return e.status === 'failed' || e.unservable === true;
}
