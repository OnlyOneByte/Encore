// Media repository — the durable catalog. Search results and cooked (make-karaoke) songs are upserted
// here so the catalog survives a restart, `requestMakeKaraoke` dedupes to already-separated stems
// instead of re-cooking, and the saved-karaoke library can list every song whose instrumental is on
// disk. The runtime `mediaById` Map stays the hot read path; this is the write-behind + boot-hydrate
// store.
import { eq, and, desc, asc, sql, isNotNull } from 'drizzle-orm';
import type { DB } from '../db/index';
import { media, mediaTags } from '../db/schema';
import type { Media, LyricsCandidate } from '@encore/shared';
import { readyToSing } from '@encore/shared';

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
	lyricsRef: m.lyricsRef ?? null,
	// JSON blob, not a table: nothing queries inside the set.
	lyricsCandidates: m.lyricsCandidates?.length ? JSON.stringify(m.lyricsCandidates) : null,
	artistCanonical: m.artistCanonical ?? null,
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
	lyricsRef: r.lyricsRef ?? undefined,
	lyricsCandidates: parseCandidates(r.lyricsCandidates),
	artistCanonical: r.artistCanonical ?? undefined,
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
	 *  `title` is optional so a caller that only knows the artist (the browse shape) still compiles; when
	 *  omitted the stored title_canonical is left ALONE rather than nulled, since a partial mirror must
	 *  not erase a good value. */
	setCanonical(mediaId: string, c: { artist: string | null; title?: string | null; album: string | null; year: number | null }): void {
		this.#db
			.update(media)
			.set({
				artistCanonical: c.artist,
				...(c.title === undefined ? {} : { titleCanonical: c.title }),
				album: c.album,
				year: c.year
			})
			.where(eq(media.id, mediaId))
			.run();
	}

	/** Replace all tags of one kind for a media (genre/tag/mood). Idempotent. */
	setTags(mediaId: string, kind: 'genre' | 'tag' | 'mood', values: string[]): void {
		this.#db.delete(mediaTags).where(and(eq(mediaTags.mediaId, mediaId), eq(mediaTags.kind, kind))).run();
		const clean = [...new Set(values.map((v) => v.trim().toLowerCase()).filter(Boolean))];
		if (clean.length === 0) return;
		this.#db
			.insert(mediaTags)
			.values(clean.map((value) => ({ mediaId, kind, value })))
			.onConflictDoNothing()
			.run();
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

	/** Browse facet: ready songs grouped by genre. */
	genreFacets(): Array<{ genre: string; count: number }> {
		return this.#db
			.select({ genre: mediaTags.value, count: sql<number>`count(*)`.as('count') })
			.from(mediaTags)
			.innerJoin(media, eq(media.id, mediaTags.mediaId))
			.where(and(eq(mediaTags.kind, 'genre'), eq(media.stemStatus, 'ready')))
			.groupBy(mediaTags.value)
			.orderBy(desc(sql`count(*)`), asc(mediaTags.value))
			.all();
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

	/** Ready songs carrying a genre. */
	byGenre(genre: string): Media[] {
		return this.#db
			.select()
			.from(media)
			.innerJoin(mediaTags, eq(mediaTags.mediaId, media.id))
			.where(and(eq(media.stemStatus, 'ready'), eq(mediaTags.kind, 'genre'), eq(mediaTags.value, genre.trim().toLowerCase())))
			.orderBy(desc(media.id))
			.all()
			.map((r) => fromRow(r.media));
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
