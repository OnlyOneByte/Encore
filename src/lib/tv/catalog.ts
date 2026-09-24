// The TV's media-catalog boundary: an unrelated song finishing its processing must not churn the object graph the
// render tree reads, or the playing song jumps. THREE deliberately redundant defences, described in
// docs/FRONTEND.md#the-tv-socket.

import type { Media } from '$lib/contract';
import type { ServerEvent } from '$lib/contract';

/**
 * The ONLY writer, and it takes a FULL server list, so it cannot express a partial local edit. PRESERVES object
 * identity for any song whose fields are unchanged; JSON comparison suffices because Media is flat wire-JSON.
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
	// Nothing moved: hand back the SAME Map. A fresh Map with identical contents is still a fresh `$state` value, so a
	// sync that changed nothing must not be a re-render reason either.
	return changed ? next : prev;
}

declare const SNAPSHOT_BRAND: unique symbol;

/** The brand is load-bearing: `media={mediaCatalog.get(id)}` does not compile, so `snapshot()` is the only way in. */
export type PlaybackSnapshot = Readonly<Media> & { readonly [SNAPSHOT_BRAND]: true };

/**
 * Call ONLY from an explicit playback transition, never from a catalog observation — that coupling is what this exists
 * to break. Frozen SHALLOW copy, which is safe because catalog writers replace records rather than mutating them.
 */
export function snapshot(m: Media | null | undefined): PlaybackSnapshot | null {
	return m ? (Object.freeze({ ...m }) as PlaybackSnapshot) : null;
}

/**
 * The ONE thing a process event may still decide for the room: a `failed` job, or one no connected worker advertises the
 * capability for, never becomes playable and `enterWaiting()` sets no timer, so the party stares at "Making the
 * karaoke" forever. The ready case is deliberately ABSENT — the TV leaves `waiting` on a playback event only.
 */
export function processIsTerminal(e: Extract<ServerEvent, { type: 'media:status' }>): boolean {
	return e.status === 'failed' || e.unservable === true;
}
