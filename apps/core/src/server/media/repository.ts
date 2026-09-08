// Media repository — the durable catalog. Search results and cooked (make-karaoke) songs are upserted
// here so the catalog survives a restart, `requestMakeKaraoke` dedupes to already-separated stems
// instead of re-cooking, and the saved-karaoke library can list every song whose instrumental is on
// disk. The runtime `mediaById` Map stays the hot read path; this is the write-behind + boot-hydrate
// store.
import { eq, and, desc, asc, sql, isNotNull } from 'drizzle-orm';
import type { DB } from '../db/index';
import { media, mediaTags } from '../db/schema';
import type { Media, LyricsCandidate } from '@encore/shared';
import { readyToSing, normalizeSongProfile } from '@encore/shared';

type MediaRow = typeof media.$inferInsert;

// Drizzle round-trip both ways. The DB is nullable-column shaped, the domain type optional-property
// shaped, so null ⇄ undefined is translated here rather than leaking either convention across the seam.
const toRow = (m: Media): MediaRow => ({
	id: m.id,
	source: m.source,
	sourceRef: m.sourceRef,
	title: m.title,
	artist: m.artist ?? null,
	durationSec: Math.round(m.durationSec),
	thumbnail: m.thumbnail ?? null,
	viewCount: m.viewCount ?? null,
	stemStatus: m.stemStatus,
	lyricsStatus: m.lyricsStatus ?? null,
	mbid: m.mbid ?? null,
	annotationSource: m.annotation?.source ?? null,
	annotationConfidence: m.annotation?.confidence ?? null,
	instrumentalRef: m.instrumentalRef ?? null,
	vocalsRef: m.vocalsRef ?? null,
	// The whole SongProfile as one JSON string, or null when absent — the index copy of the sidecar's
	// authoritative profile. Serialized whole (not per-field columns) because nothing queries inside it.
	// Absent stays null rather than being written as EMPTY_SONG_PROFILE: null is "stems never ran", which
	// the gate must be able to tell apart from an all-nulls profile ("ran, found nothing" = finished).
	songProfile: m.songProfile ? JSON.stringify(m.songProfile) : null,
	lyricsRef: m.lyricsRef ?? null,
	// JSON blob, not a table: nothing queries inside the set.
	lyricsCandidates: m.lyricsCandidates?.length ? JSON.stringify(m.lyricsCandidates) : null,
	artistCanonical: m.artistCanonical ?? null,
	artistCredit: m.artistCredit ?? null,
	titleCanonical: m.titleCanonical ?? null
});

/** Parse the stored candidate JSON, tolerating null/garbage — a corrupt blob must not brick a hydrate. */
function parseCandidates(raw: string | null): LyricsCandidate[] | undefined {
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) && parsed.length ? (parsed as LyricsCandidate[]) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Tolerant JSON.parse for the song_profile column — returns `null` on unparseable garbage rather than
 * throwing. `null` then flows into normalizeSongProfile, which maps it to EMPTY_SONG_PROFILE, so a
 * truncated or hand-mangled blob degrades to "ran, found nothing" instead of crashing the boot hydrate.
 */
function safeParse(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

const fromRow = (r: typeof media.$inferSelect): Media => ({
	id: r.id,
	source: r.source,
	sourceRef: r.sourceRef,
	title: r.title,
	artist: r.artist ?? undefined,
	durationSec: r.durationSec,
	thumbnail: r.thumbnail ?? undefined,
	viewCount: r.viewCount ?? undefined,
	stemStatus: r.stemStatus,
	lyricsStatus: r.lyricsStatus ?? undefined,
	mbid: r.mbid ?? undefined,
	// Only a COMPLETE pair is restored: a source without a confidence (or vice versa) is not provenance,
	// and half-reading it would let the never-regress check compare against nothing.
	annotation:
		r.annotationSource && r.annotationConfidence
			? {
					source: r.annotationSource as NonNullable<Media['annotation']>['source'],
					confidence: r.annotationConfidence as NonNullable<Media['annotation']>['confidence']
				}
			: undefined,
	instrumentalRef: r.instrumentalRef ?? undefined,
	vocalsRef: r.vocalsRef ?? undefined,
	// A NULL column means the stems job has not run — leave songProfile UNDEFINED (absent), which the
	// gate reads as still-cooking. A present string is untrusted (an older build, a hand-edited sidecar
	// mirrored here) so it is re-normalized at this boundary: normalizeSongProfile degrades any bad half
	// to null rather than throwing, so a corrupt profile downgrades to EMPTY_SONG_PROFILE (still a
	// gate-satisfying "ran, found nothing") instead of bricking the hydrate.
	songProfile: r.songProfile ? normalizeSongProfile(safeParse(r.songProfile)) : undefined,
	lyricsRef: r.lyricsRef ?? undefined,
	lyricsCandidates: parseCandidates(r.lyricsCandidates),
	artistCanonical: r.artistCanonical ?? undefined,
	artistCredit: r.artistCredit ?? undefined,
	titleCanonical: r.titleCanonical ?? undefined
});

export class MediaRepository {
	#db: DB;
	/** Optional sidecar sink. Injected so the repository stays unit-testable without I/O. */
	#onPersist?: (m: Media) => void;

	constructor(db: DB, onPersist?: (m: Media) => void) {
		this.#db = db;
		this.#onPersist = onPersist;
	}

	/** Insert or update a media record (idempotent on id). Called on search-materialize and on every
	 *  artifact flip (stems ready / lyrics / pitch), so the catalog is durable.
	 *
	 *  The DB is the INDEX; `meta/<id>.json` is authoritative, so every write also refreshes the
	 *  sidecar. Fire-and-forget: a sidecar write must never delay or fail the in-memory flip the room
	 *  is waiting on. */
	upsert(m: Media): void {
		const row = toRow(m);
		this.#db.insert(media).values(row).onConflictDoUpdate({ target: media.id, set: row }).run();
		this.#onPersist?.(m);
	}

	/**
	 * Hard-delete one media from the index — the row AND its tags — for the entry-delete of #639.
	 * Row and tags go in ONE transaction: a crash between them would strand orphan tag rows pointing at
	 * a media that no longer exists (bun:sqlite makes the transaction synchronous, so either both land
	 * or neither). The AUTHORITATIVE sidecar is unlinked by the caller BEFORE this (deleteMediaEntirely),
	 * so a rescan cannot rebuild the row this drops. Idempotent: deleting an absent id is a no-op.
	 */
	remove(mediaId: string): void {
		this.#db.transaction((tx) => {
			tx.delete(mediaTags).where(eq(mediaTags.mediaId, mediaId)).run();
			tx.delete(media).where(eq(media.id, mediaId)).run();
		});
	}

	/** One media by id, or undefined. */
	byId(id: string): Media | undefined {
		const row = this.#db.select().from(media).where(eq(media.id, id)).all()[0];
		return row ? fromRow(row) : undefined;
	}

	/** All persisted media — used to hydrate the runtime `mediaById` catalog on boot. */
	all(): Media[] {
		return this.#db.select().from(media).all().map(fromRow);
	}

	/**
	 * The saved-karaoke library: songs that are FINISHED — every required cook gate satisfied — so
	 * re-queueing one skips the worker entirely. Ordered newest-first by id (ULIDs are monotonic, so
	 * this is catalog-discovery order, not cook order).
	 *
	 * The SQL narrows to separated songs, then `readyToSing` makes the final call in one place. Keeping
	 * the whole predicate in SQL is what let the library and the phone drift apart once already: the
	 * server listed a song the client's own rules said was still cooking, and it rendered in both
	 * groups at the same time. The gate table is now the only definition of finished, and this query
	 * defers to it rather than restating it.
	 */
	listReady(): Media[] {
		return this.#db
			.select()
			.from(media)
			.where(and(eq(media.stemStatus, 'ready'), isNotNull(media.instrumentalRef)))
			.orderBy(desc(media.id))
			.all()
			.map(fromRow)
			.filter(readyToSing);
	}

	// ── browse ───────────────────────────────────────────────────────────────
	//
	// Only READY songs are browsable. The catalog holds every search result ever materialised (271 rows
	// on the live box for 7 cooked songs), so browsing the whole table would drown the library in
	// things you cannot actually sing yet.

	/** Mirror the canonical metadata for one media into the index (from its authoritative sidecar).
	 *  `title`, `album` and `year` are all OPTIONAL and skipped when `undefined`, so a caller that only
	 *  knows the artist (the browse-sync shape) still compiles AND does not erase columns it has no
	 *  opinion on. This matters because the boot browse-sync passes album/year as null for most songs:
	 *  writing null unconditionally re-nulled any previously-populated album/year on EVERY restart (a
	 *  silent data regression). `undefined` means "do not touch"; an explicit `null` still clears. */
	setCanonical(
		mediaId: string,
		c: { artist: string | null; title?: string | null; album?: string | null; year?: number | null }
	): void {
		this.#db
			.update(media)
			.set({
				artistCanonical: c.artist,
				...(c.title === undefined ? {} : { titleCanonical: c.title }),
				...(c.album === undefined ? {} : { album: c.album }),
				...(c.year === undefined ? {} : { year: c.year })
			})
			.where(eq(media.id, mediaId))
			.run();
	}

	/** Replace all tags of one kind for a media (genre/tag/mood). Idempotent.
	 *  The delete and the re-insert run in ONE transaction: a throw or crash between them would
	 *  otherwise leave the media with every tag of this kind deleted and none re-inserted — silent,
	 *  unbounded tag loss for no reason. bun:sqlite makes the transaction synchronous, so either both
	 *  statements land or neither does. */
	setTags(mediaId: string, kind: 'genre' | 'tag' | 'mood', values: string[]): void {
		const clean = [...new Set(values.map((v) => v.trim().toLowerCase()).filter(Boolean))];
		this.#db.transaction((tx) => {
			tx.delete(mediaTags)
				.where(and(eq(mediaTags.mediaId, mediaId), eq(mediaTags.kind, kind)))
				.run();
			if (clean.length === 0) return;
			tx.insert(mediaTags)
				.values(clean.map((value) => ({ mediaId, kind, value })))
				.onConflictDoNothing()
				.run();
		});
	}

	/** Every tag of one kind for a media. */
	tagsOf(mediaId: string, kind: 'genre' | 'tag' | 'mood' = 'genre'): string[] {
		return this.#db
			.select({ value: mediaTags.value })
			.from(mediaTags)
			.where(and(eq(mediaTags.mediaId, mediaId), eq(mediaTags.kind, kind)))
			.all()
			.map((r) => r.value);
	}

	/** Browse facet: ready songs grouped by canonical artist, most songs first. NULL artists (a
	 *  low-confidence parse) are excluded — an "Unknown" bucket of 40 songs is not a useful heading. */
	artistFacets(): Array<{ artist: string; count: number }> {
		return this.#db
			.select({ artist: media.artistCanonical, count: sql<number>`count(*)`.as('count') })
			.from(media)
			.where(and(eq(media.stemStatus, 'ready'), isNotNull(media.artistCanonical)))
			.groupBy(media.artistCanonical)
			.orderBy(desc(sql`count(*)`), asc(media.artistCanonical))
			.all()
			.filter((r): r is { artist: string; count: number } => !!r.artist);
	}

	/** Ready songs by canonical artist (exact match on the canonical value the facet returned). */
	byArtist(artist: string): Media[] {
		return this.#db
			.select()
			.from(media)
			.where(and(eq(media.stemStatus, 'ready'), eq(media.artistCanonical, artist)))
			.orderBy(desc(media.id))
			.all()
			.map(fromRow);
	}
}

/**
 * Seed the runtime catalog from the durable store. Boot path: the in-memory `mediaById` Map is the
 * hot read path for rotation/hub/worker dispatch, so it must contain every persisted song before
 * the first client syncs — otherwise a hydrated queue entry references a media nobody can resolve
 * and the hub rejects re-adds of a song the party sang last night. Existing runtime entries win
 * (nothing durable should clobber a live object other code already holds a reference to).
 */
export function hydrateMediaCatalog(rows: Media[], mediaById: Map<string, Media>): number {
	let added = 0;
	for (const m of rows) {
		if (mediaById.has(m.id)) continue;
		mediaById.set(m.id, m);
		added++;
	}
	return added;
}
