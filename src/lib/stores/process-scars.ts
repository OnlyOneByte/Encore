// Process scars — a per-device memory that a song's process FAILED, surviving a phone reload.
//
// A failed process is a LIVE signal: the catalog records no failure (a dead process settles back to
// un-processed server-side) and the in-memory status map is lost on reload, so without this a guest who
// reloads sees the song back as a plain un-processed row with no trace that it broke. A client-side scar was
// chosen over a server column: per-device, data-free, no migration.
//
// A scar carries a MINIMAL MEDIA SNAPSHOT, not just an expiry, because the library endpoint returns only ready
// and processing media — a failed song is not in the catalog, so a bare-id scar would have nothing to render.
//
// SSR-SAFE and storage-failure-tolerant: storage access is behind a runtime presence check and wrapped, so a
// server render, a quota failure or a malformed value all degrade to "no scar" rather than throwing. The pure
// helpers take a plain record and an explicit `now`, so the TTL logic is unit-testable with no DOM.
import type { Media } from '$lib/contract';

/** localStorage key. One key holds the whole `{ mediaId: Scar }` map. */
export const PROCESS_SCARS_KEY = 'encore:process-scars';

/**
 * How long a scar survives. The row is re-processable, so this is a "recently broke" HINT rather than a durable
 * state: long enough that a guest who reloads to see why their song never came finds out, short enough that a
 * stale failure does not haunt a row someone else could process cleanly.
 */
export const PROCESS_SCAR_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * The Media fields a scarred row needs after a reload: a strict subset, so spreading a snapshot yields a valid
 * UN-PROCESSED Media, which is what the failed process settled it back to.
 */
export type ScarMedia = Pick<Media, 'id' | 'source' | 'sourceRef' | 'title' | 'durationSec'> &
	Partial<Pick<Media, 'artist' | 'artistCanonical' | 'thumbnail' | 'viewCount'>>;

/** One scarred song: when the scar expires, plus enough of its media to render the failed row. */
export interface Scar {
	expiresAt: number;
	media: ScarMedia;
}

/** `{ [mediaId]: Scar }`. */
export type ScarMap = Record<string, Scar>;

/** Reduce a full Media to the snapshot a scarred row needs. */
export function snapshotOf(m: Media): ScarMedia {
	return {
		id: m.id,
		source: m.source,
		sourceRef: m.sourceRef,
		title: m.title,
		durationSec: m.durationSec,
		artist: m.artist,
		artistCanonical: m.artistCanonical,
		thumbnail: m.thumbnail,
		viewCount: m.viewCount
	};
}

/** Rehydrate a scar snapshot into a full (un-processed) Media for the catalog. */
export function scarToMedia(s: Scar): Media {
	return { ...s.media, stemStatus: 'none' };
}

/** Drop every scar whose deadline has passed. Returns a NEW map and never mutates the input. */
export function pruneScars(map: ScarMap, now: number): ScarMap {
	const out: ScarMap = {};
	for (const [id, scar] of Object.entries(map)) {
		if (scar && typeof scar.expiresAt === 'number' && scar.expiresAt > now && scar.media) out[id] = scar;
	}
	return out;
}

// The backing store, INJECTABLE so the I/O layer is testable without a real `localStorage`. Null means "no
// scars" to every caller, never an error.
function storageOf(store?: Storage): Storage | null {
	if (store) return store;
	// A runtime presence check rather than the framework's browser flag, so this layer stays unit-testable off
	// a browser. Accessing the global can itself throw in a sandboxed or private-mode context.
	try {
		return typeof localStorage !== 'undefined' ? localStorage : null;
	} catch {
		return null;
	}
}

/** Read the raw scar map from storage. Returns `{}` on any read/parse failure — a scar is never load-bearing. */
export function readScars(store?: Storage): ScarMap {
	const s = storageOf(store);
	if (!s) return {};
	try {
		const raw = s.getItem(PROCESS_SCARS_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
		return parsed as ScarMap;
	} catch {
		return {};
	}
}

function writeScars(map: ScarMap, store?: Storage): void {
	const s = storageOf(store);
	if (!s) return;
	try {
		if (Object.keys(map).length === 0) s.removeItem(PROCESS_SCARS_KEY);
		else s.setItem(PROCESS_SCARS_KEY, JSON.stringify(map));
	} catch {
		// Quota exceeded or storage disabled — dropping the scar is the correct degradation.
	}
}

/** Record that a process failed. Prunes in the same write, so the map cannot grow without bound. */
export function recordScar(media: Media, now: number = Date.now(), store?: Storage): void {
	const map = pruneScars(readScars(store), now);
	map[media.id] = { expiresAt: now + PROCESS_SCAR_TTL_MS, media: snapshotOf(media) };
	writeScars(map, store);
}

/** Clear a scar when the same song processes successfully, so a now-ready row never lingers as failed. */
export function clearScar(mediaId: string, now: number = Date.now(), store?: Storage): void {
	const map = pruneScars(readScars(store), now);
	if (!(mediaId in map)) return;
	delete map[mediaId];
	writeScars(map, store);
}

/**
 * The unexpired scars, as rehydrated un-processed Media. Reading PRUNES back to storage, which is what makes
 * the persisted map self-clean.
 */
export function activeScars(now: number = Date.now(), store?: Storage): Media[] {
	const pruned = pruneScars(readScars(store), now);
	writeScars(pruned, store);
	return Object.values(pruned).map(scarToMedia);
}
