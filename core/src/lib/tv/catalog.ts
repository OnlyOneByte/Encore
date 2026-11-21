// The TV's media-catalog boundary: an unrelated song finishing its processing must not churn the object graph the
// render tree reads, or the playing song jumps. THREE deliberately redundant defences, described in
// docs/FRONTEND.md#the-tv-socket.

import type { Media } from '$lib/contract';
import { mediaStagePosition, type MediaStatus, type ServerEvent } from '$lib/contract';

/**
 * The ONLY writer, and it takes a FULL server list, so it cannot express a partial local edit. PRESERVES object
 * identity for any song whose fields are unchanged; JSON comparison suffices because Media is flat wire-JSON.
 *
 * That list is a sync's `media`: the QUEUED songs only, not the library. The TV ignores `queue:patch`, so a song
 * queued after its last sync reaches it through the NEXT sync, which today is the WsClient gap resync (the TV's
 * `getLastRev` is 0, so any patch past rev 1 sends a hello; one add sends two patches) or the 15 s heartbeat.
 * Change either and a newly queued song can be missing from this map until a heartbeat.
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

/** The levels the TV's loudness median is taken over. They ride every sync because the sync's media is only the
 *  queued songs; an omitted list means "no info", and must not reset the median to nothing. */
export function syncLoudnessLevels(prev: number[], e: Extract<ServerEvent, { type: 'queue:sync' }>): number[] {
	return e.loudness ?? prev;
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

type LiveStatus = Extract<ServerEvent, { type: 'media:status' }>;

/**
 * The lobby's live statuses for a TV that has just loaded, from `/api/library`'s `processing` rows. The sweep says
 * "no worker can run this" ONCE, on first sight, so a TV opened after that moment learns it here or never — and
 * without it a dead turn reads "Making karaoke… this takes a minute" until the 120s TTL. A status already heard
 * live is fresher, so an in-flight one is never overwritten. `noMakerFailed` names queued turns whose last job the TTL
 * killed for want of a worker NOW, so a TV opened (or reconnected) after the TTL says "no maker" with the phones.
 *
 * On a RE-connect (`reconnect`), everything held is from before the drop, as on the phone (RoomLink.seedMediaStatus):
 * a processing row replaces it, and a held in-flight status the server no longer lists goes. A status in `heard`
 * arrived after the socket came back, so it is newer than the snapshot and stays.
 */
export function seedLiveStatus(
	prev: Map<string, LiveStatus>,
	processing: { media: { id: string }; status: MediaStatus; pct: number; unservable?: boolean }[],
	noMakerFailed: string[] = [],
	{ reconnect = false, heard = new Set<string>() }: { reconnect?: boolean; heard?: ReadonlySet<string> } = {}
): Map<string, LiveStatus> {
	const next = new Map(prev);
	const stale = (id: string) => reconnect && !heard.has(id);
	const rows = new Set(processing.map((p) => p.media.id));
	for (const [id, s] of next)
		if (!rows.has(id) && stale(id) && mediaStagePosition(s.status) >= 0 && s.status !== 'ready') next.delete(id);
	// A held `failed` takes the server's CURRENT cause either way, as the phone's seed does (RoomLink.seedNoMakerFailures):
	// the fleet may have come or gone while the socket was down.
	const listed = new Set(noMakerFailed);
	for (const id of listed)
		if (!next.has(id) || next.get(id)!.status === 'failed')
			next.set(id, { type: 'media:status', mediaId: id, status: 'failed', pct: 0, unservable: true });
	for (const [id, s] of next)
		if (s.status === 'failed' && s.unservable && !listed.has(id)) next.set(id, { ...s, unservable: undefined });
	for (const p of processing)
		if (!next.has(p.media.id) || stale(p.media.id))
			next.set(p.media.id, {
				type: 'media:status',
				mediaId: p.media.id,
				status: p.status,
				pct: p.pct,
				unservable: p.unservable
			});
	return next;
}

/** The lobby's live statuses for the songs the room still holds: a queue sync drops the rest, so the map is "what the
 *  room was told about its own turns", not every song ever heard of. Unchanged (same object) when nothing goes. */
export function pruneLiveStatus(
	live: Map<string, LiveStatus>,
	entries: readonly { mediaId: string }[]
): Map<string, LiveStatus> {
	const held = new Set(entries.map((e) => e.mediaId));
	if ([...live.keys()].every((id) => held.has(id))) return live;
	return new Map([...live].filter(([id]) => held.has(id)));
}
