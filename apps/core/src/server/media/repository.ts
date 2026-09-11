// Media repository — the durable catalog. Search results and processed (process) songs are upserted
// here so the catalog survives a restart, `requestProcess` dedupes to already-separated stems
// instead of re-processing, and the saved-karaoke library can list every song whose instrumental is on
// disk. The runtime `mediaById` Map stays the hot read path; this is the write-behind + boot-hydrate
// store.
import { eq, and, desc, isNotNull, inArray, type SQL } from 'drizzle-orm';
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
	// The measured guide/instrumental offset in signed ms, or null when never measured (#766). Null and a
	// stored 0 mean the same to the client (guideOffsetSec maps both to 0), but they are kept distinct so
	// the operator surface can tell "measured, aligned" from "never measured".
	guideOffsetMs: m.guideOffsetMs ?? null,
	// The whole SongProfile as one JSON string, or null when absent — the index copy of the sidecar's
	// authoritative profile. Serialized whole (not per-field columns) because nothing queries inside it.
	// Absent stays null rather than being written as EMPTY_SONG_PROFILE: null is "stems never ran", which
	// the gate must be able to tell apart from an all-nulls profile ("ran, found nothing" = finished).
	songProfile: m.songProfile ? JSON.stringify(m.songProfile) : null,
	lyricsRef: m.lyricsRef ?? null,
	// JSON blob, not a table: nothing queries inside the set.
	lyricsCandidates: m.lyricsCandidates?.length ? JSON.stringify(m.lyricsCandidates) : null,
	lyricsOverrideRef: m.lyricsOverrideRef ?? null,
	artistCanonical: m.artistCanonical ?? null,
	artistCredit: m.artistCredit ?? null,
	titleCanonical: m.titleCanonical ?? null
});

/**
 * Tally values into browse-rail order: most songs first, ties alphabetical.
 *
 * The rails used to order in SQL (`ORDER BY count(*) DESC, value ASC`). They cannot any more, because
 * the count must be taken over the gate-filtered set and SQL cannot consult the gate table (#763), so
 * the ordering moves here with it. Ties break on a plain byte comparison rather than `localeCompare`
 * to match SQLite's default BINARY collation — the rail's order is unchanged by the move.
 */
function facetCounts(values: string[]): Array<{ value: string; count: number }> {
	const counts = new Map<string, number>();
	for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
	return [...counts]
		.map(([value, count]) => ({ value, count }))
		.sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

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
	// A NULL column means the offset was never measured — leave it UNDEFINED, which guideOffsetSec maps to
	// 0 so the guide is held as today. A stored number (including 0, a measured "aligned") round-trips.
	guideOffsetMs: r.guideOffsetMs ?? undefined,
	// A NULL column means the stems job has not run — leave songProfile UNDEFINED (absent), which the
	// gate reads as still-processing. A present string is untrusted (an older build, a hand-edited sidecar
	// mirrored here) so it is re-normalized at this boundary: normalizeSongProfile degrades any bad half
	// to null rather than throwing, so a corrupt profile downgrades to EMPTY_SONG_PROFILE (still a
	// gate-satisfying "ran, found nothing") instead of bricking the hydrate.
	songProfile: r.songProfile ? normalizeSongProfile(safeParse(r.songProfile)) : undefined,
	lyricsRef: r.lyricsRef ?? undefined,
	lyricsCandidates: parseCandidates(r.lyricsCandidates),
	lyricsOverrideRef: r.lyricsOverrideRef ?? undefined,
	artistCanonical: r.artistCanonical ?? undefined,
	artistCredit: r.artistCredit ?? undefined,
	titleCanonical: r.titleCanonical ?? undefined
});

/**
 * THE readiness definition for the library list, both browse filters and both browse rails. Every one
 * of them resolves through this function (or through `readyTagged`, which walks this set), so there is
 * one answer to "is this song ready" and a sixth reader cannot invent a seventh.
 *
 * Two halves, and the split is load-bearing:
 *
 * - The SQL is a NARROWING, not the predicate. `stemStatus = 'ready' AND instrumentalRef NOT NULL` is
 *   the cheap prefix an index can serve.
 * - `readyToSing` — the gate table in `@encore/shared` — makes the final call, because it also knows
 *   about the LYRICS gate. A song mid-align is `stemStatus: 'ready'` with its instrumental on disk and
 *   is still not finished; `gates.ts` names that window in as many words.
 *
 * Mistaking the narrowing for the whole predicate is #763: `byArtist` and both facet counts asked only
 * the narrowing, so the artist filter listed a song the unfiltered library correctly hid, and a tag
 * chip reading `ballad 1` opened a measured EMPTY list. Keeping the whole predicate in SQL instead had
 * already split the server's library from the phone's own rules once before that — a song rendered in
 * the Ready and Processing groups at the same time. Hence: narrow in SQL, decide in the gate table, in
 * one place.
 *
 * `extra` narrows FURTHER in SQL — the artist filter's index push-down, and `readyTagged`'s id set. It
 * cannot relax the gate, which is applied after it. Newest-first by id, the catalog-discovery order the
 * library shows.
 */
function readySongs(db: DB, extra?: SQL): Media[] {
	const narrowing = and(eq(media.stemStatus, 'ready'), isNotNull(media.instrumentalRef));
	return db
		.select()
		.from(media)
		.where(extra ? and(narrowing, extra) : narrowing)
		.orderBy(desc(media.id))
		.all()
		.map(fromRow)
		.filter(readyToSing);
}

/**
 * Every (ready song, one of its `tag`-kind values) pair, newest-first. `byTag` and `tagFacets` are
 * both expressed against this, which is what makes a chip's count the length of the list it opens BY
 * CONSTRUCTION rather than by two queries happening to agree.
 *
 * Readiness is not re-asked here: membership of `readySongs()` IS the gate, so a tag on a song that is
 * not finished simply has no pair, and walking that set also hands the pairs its newest-first order.
 * `tag` still narrows in SQL on the `media_tags` `byKindValue` index (`WHERE kind = ? AND value = ?`) —
 * the shape that index exists for — so the filter does not become a scan of every tag row.
 *
 * BOTH sides narrow in SQL. The tag rows name the only media ids that can produce a pair, so they are
 * passed straight back down as `readySongs`'s `extra` and the media read is `WHERE id IN (…)` instead
 * of the whole ready library plus a full gate pass thrown away by the join (#798: 900 rows read at
 * 4.42 ms/call to return 1, versus 1 row at 0.39 ms). That is a push-down, not a second definition:
 * `extra` narrows and cannot relax the gate, which still runs after it inside `readySongs`.
 *
 * The empty case needs no branch and must not get one. `inArray(media.id, [])` compiles to `false`
 * (measured on drizzle-orm 0.45.2: zero bound params, zero rows), so nothing-tagged already answers
 * `[]`. SKIPPING the `extra` when `byMedia` is empty is not a guard but a re-entry of the defect — it
 * restores the whole-library read for exactly the query that needs no rows at all.
 */
function readyTagged(db: DB, tag?: string): Array<{ song: Media; tag: string }> {
	const rows = db
		.select({ mediaId: mediaTags.mediaId, value: mediaTags.value })
		.from(mediaTags)
		.where(tag === undefined ? eq(mediaTags.kind, 'tag') : and(eq(mediaTags.kind, 'tag'), eq(mediaTags.value, tag)))
		.all();
	const byMedia = new Map<string, string[]>();
	for (const r of rows) {
		const list = byMedia.get(r.mediaId);
		if (list) list.push(r.value);
		else byMedia.set(r.mediaId, [r.value]);
	}
	return readySongs(db, inArray(media.id, [...byMedia.keys()])).flatMap((song) =>
		(byMedia.get(song.id) ?? []).map((value) => ({ song, tag: value }))
	);
}

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
	 * The saved-karaoke library: songs that are FINISHED — every required process gate satisfied — so
	 * re-queueing one skips the worker entirely. Ordered newest-first by id (ULIDs are monotonic, so
	 * this is catalog-discovery order, not process order).
	 *
	 * Deliberately a one-liner over `readySongs`: "finished" is defined in exactly one place for every
	 * reader that lists or counts browsable songs, so the library, the browse filters and the browse
	 * rails cannot disagree about the same song (#763).
	 */
	listReady(): Media[] {
		return readySongs(this.#db);
	}

	// ── browse ───────────────────────────────────────────────────────────────
	//
	// Only READY songs are browsable. The catalog holds every search result ever materialised (271 rows
	// on the live box for 7 processed songs), so browsing the whole table would drown the library in
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
	 *  low-confidence parse) are excluded — an "Unknown" bucket of 40 songs is not a useful heading.
	 *  Counts the READY set rather than `count(*)` in SQL: a SQL count cannot consult the gate table,
	 *  and one that counted the narrowing instead printed `The Band 2` above a list holding one song
	 *  (#763). The chip's number is now the length of the list it opens. */
	artistFacets(): Array<{ artist: string; count: number }> {
		const artists = readySongs(this.#db, isNotNull(media.artistCanonical))
			.map((m) => m.artistCanonical)
			.filter((a): a is string => !!a);
		return facetCounts(artists).map(({ value, count }) => ({ artist: value, count }));
	}

	/** Ready songs by canonical artist (exact match on the canonical value the facet returned). */
	byArtist(artist: string): Media[] {
		return readySongs(this.#db, eq(media.artistCanonical, artist));
	}

	/** Browse facet: ready songs grouped by descriptive `tag`, most songs first. Mirrors
	 *  `artistFacets` and reads the same pairs #690's `byTag` filter reads, so the count and the
	 *  filter cannot disagree. Tags are the sidecar-written 'tag'-kind values (`setTags(id, 'tag', …)`),
	 *  already trimmed + lower-cased at the write boundary, so the distinct values need no further
	 *  normalisation. Only READY songs are counted — a tag on a song you cannot sing yet would offer a
	 *  browse heading that lands on an empty list, which is precisely what a `count(*)` over the SQL
	 *  narrowing used to do (#763: a chip reading `ballad 1` opened nothing). */
	tagFacets(): Array<{ tag: string; count: number }> {
		return facetCounts(readyTagged(this.#db).map((p) => p.tag)).map(({ value, count }) => ({ tag: value, count }));
	}

	/** Ready songs carrying a given descriptive tag (exact match on the value the facet returned).
	 *  Narrows on the `media_tags` `byKindValue` index (`WHERE kind = ? AND value = ?`) — the exact
	 *  query shape that index exists for — rather than a client-side filter over the whole library
	 *  payload, which works at 9 songs and stops working at 900. Readiness comes from the shared set,
	 *  so a row that is `stemStatus:'ready'` but not actually singable (mid-align, or missing its
	 *  instrumental) is excluded here exactly as it is from the unfiltered library and from the count
	 *  on the chip that opened this list. */
	byTag(tag: string): Media[] {
		return readyTagged(this.#db, tag).map((p) => p.song);
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
