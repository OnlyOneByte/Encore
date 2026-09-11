// Cook scars — a per-device memory that a song's cook FAILED, surviving a phone reload.
//
// Why this exists: a failed cook is a LIVE signal. The catalog Media records no failure (a dead cook
// settles back to un-cooked via settleStemsGate server-side), and the in-memory `mediaStatus` map that
// carries the live `failed` status is lost on reload — so a guest who reloads sees the song back as a
// plain un-cooked row with no trace that it broke, and no idea why it never came. The
// owner ruled a client-side scar over the two alternatives (a server `last_error` column, or leaving
// it as-is): per-device, data-free, no migration.
//
// A scar carries a MINIMAL media snapshot, not just an expiry. After a reload, GET /api/library returns
// only ready + currently-cooking media, so a failed song (settled to stemStatus 'none') is NOT in the
// catalog — a bare-id scar would have nothing to render. The snapshot (the fields SongRow needs) lets
// the failed row paint itself with no server round-trip, keeping the whole feature client-side.
//
// SSR-safety: this is the app's FIRST persisted client state, so it must never touch `localStorage`
// during a server render. Storage access is guarded by a `typeof localStorage` presence check (absent
// on the server) and wrapped so a quota failure
// (private-mode Safari) or a malformed value degrades to "no scar" rather than throwing. The pure
// helpers take a plain record + an explicit `now`, so the TTL logic is unit-testable with no DOM.
import type { Media } from '@encore/shared';

/** localStorage key. One key holds the whole `{ mediaId: Scar }` map. */
export const COOK_SCARS_KEY = 'encore:cook-scars';

/**
 * How long a failed-cook scar survives. The row is re-cookable, so this is a "recently broke" hint,
 * not a durable state — long enough that the guest who reloads to see why their song never came still
 * finds out, short enough that a stale failure does not haunt a row someone else could cook cleanly.
 */
export const COOK_SCAR_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * The Media fields a scarred row needs to render after a reload. A strict subset of Media — the
 * SongRow display fields plus the four required identity/shape fields, so `{ ...snapshot }` is a valid
 * un-cooked Media (stemStatus 'none' — the failed cook settled it back) for displayReadiness/rowMeta.
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

/** Rehydrate a scar snapshot into a full (un-cooked) Media for the catalog. */
export function scarToMedia(s: Scar): Media {
	return { ...s.media, stemStatus: 'none' };
}

// ── pure helpers (no DOM, no clock — `now` is passed in) ──────────────────────

/** Drop every scar whose deadline has passed. Returns a NEW map; never mutates the input. */
export function pruneScars(map: ScarMap, now: number): ScarMap {
	const out: ScarMap = {};
	for (const [id, scar] of Object.entries(map)) {
		if (scar && typeof scar.expiresAt === 'number' && scar.expiresAt > now && scar.media) out[id] = scar;
	}
	return out;
}

// ── browser I/O (SSR-safe, storage-failure-tolerant) ──────────────────────────

// Resolve the backing store. Injectable so the I/O layer is testable without a real `localStorage`
// (bun's test runtime has none). Returns null off the browser or when storage is unavailable, and
// callers treat null as "no scars", never as an error.
function storageOf(store?: Storage): Storage | null {
	if (store) return store;
	// SSR-safety: there is no `localStorage` global during a server render, so this returns null and
	// the module never persists anything on the server. Purposely a runtime presence check rather than
	// SvelteKit's `$app/environment` `browser` flag, so the pure I/O layer stays unit-testable off a
	// browser (an injected `store` in tests, real localStorage in the client).
	try {
		return typeof localStorage !== 'undefined' ? localStorage : null;
	} catch {
		// Accessing localStorage can itself throw (some private-mode / sandboxed contexts).
		return null;
	}
}

/** Read the raw scar map from storage. Returns `{}` on any read/parse failure — a scar is never load-bearing. */
export function readScars(store?: Storage): ScarMap {
	const s = storageOf(store);
	if (!s) return {};
	try {
		const raw = s.getItem(COOK_SCARS_KEY);
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
		if (Object.keys(map).length === 0) s.removeItem(COOK_SCARS_KEY);
		else s.setItem(COOK_SCARS_KEY, JSON.stringify(map));
	} catch {
		// Quota exceeded or storage disabled — dropping the scar is the correct degradation.
	}
}

/**
 * Record that a cook of `media` failed, expiring `COOK_SCAR_TTL_MS` from `now`, snapshotting the fields
 * the failed row needs. Prunes stale scars in the same write so the map cannot grow without bound.
 */
export function recordScar(media: Media, now: number = Date.now(), store?: Storage): void {
	const map = pruneScars(readScars(store), now);
	map[media.id] = { expiresAt: now + COOK_SCAR_TTL_MS, media: snapshotOf(media) };
	writeScars(map, store);
}

/**
 * Clear `mediaId`'s scar. Called when the same song cooks successfully (`media:status: ready`), so a
 * now-ready row never lingers as `failed`. A no-op when there was no scar. Prunes in passing.
 */
export function clearScar(mediaId: string, now: number = Date.now(), store?: Storage): void {
	const map = pruneScars(readScars(store), now);
	if (!(mediaId in map)) return;
	delete map[mediaId];
	writeScars(map, store);
}

/**
 * The unexpired scars at `now`, as rehydrated (un-cooked) Media. Prunes expired entries back to storage
 * as a side effect of reading, so the persisted map self-cleans. Used on mount to re-surface failures a
 * reload would otherwise have erased.
 */
export function activeScars(now: number = Date.now(), store?: Storage): Media[] {
	const pruned = pruneScars(readScars(store), now);
	writeScars(pruned, store);
	return Object.values(pruned).map(scarToMedia);
}
