// Write-behind on upsert, boot-hydrate on startup. See docs/SERVER.md#media-storage-and-paths.
import { eq, and, desc, isNotNull, inArray, type SQL } from 'drizzle-orm';
import type { DB } from '../db/index';
import { media, mediaTags } from '../db/schema';
import type { Media, LyricsCandidate } from '../../contract';
import { readyToSing, normalizeSongProfile } from '../../contract';

type MediaRow = typeof media.$inferInsert;

// Translates null (DB) ⇄ undefined (domain) at this seam only, so neither convention leaks across it.
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
	// Index copy; null falls back to the legacy two-element playback path.
	guideMixRef: m.guideMixRef ?? null,
	// Null means "stems never ran", distinct from an all-nulls "ran, found nothing". The gate needs both.
	songProfile: m.songProfile ? JSON.stringify(m.songProfile) : null,
	lyricsRef: m.lyricsRef ?? null,
	// JSON blob, not a table: nothing queries inside the set.
	lyricsCandidates: m.lyricsCandidates?.length ? JSON.stringify(m.lyricsCandidates) : null,
	lyricsOverrideRef: m.lyricsOverrideRef ?? null,
	// Written unconditionally (never `||`) so clearing on a ref pick writes NULL, not a stale re-surfaced `pinnedText` after restart.
	lyricsOverrideText: m.lyricsOverrideText ?? null,
	artistCanonical: m.artistCanonical ?? null,
	artistCredit: m.artistCredit ?? null,
	titleCanonical: m.titleCanonical ?? null
});

/** Most songs first, ties alphabetical. Ties break on a BYTE comparison, not `localeCompare`, to match SQLite's BINARY collation. */
function facetCounts(values: string[]): Array<{ value: string; count: number }> {
	const counts = new Map<string, number>();
	for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
	return [...counts]
		.map(([value, count]) => ({ value, count }))
		.sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

/** Tolerates null/garbage: a corrupt blob must not brick a hydrate. */
function parseCandidates(raw: string | null): LyricsCandidate[] | undefined {
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) && parsed.length ? (parsed as LyricsCandidate[]) : undefined;
	} catch {
		return undefined;
	}
}

/** `null` on garbage rather than throwing, which normalizeSongProfile maps to EMPTY_SONG_PROFILE — so a corrupt blob degrades instead of crashing boot. */
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
	// Restored only as a COMPLETE pair: a lone half lets the never-regress check compare against nothing.
	annotation:
		r.annotationSource && r.annotationConfidence
			? {
					source: r.annotationSource as NonNullable<Media['annotation']>['source'],
					confidence: r.annotationConfidence as NonNullable<Media['annotation']>['confidence']
				}
			: undefined,
	instrumentalRef: r.instrumentalRef ?? undefined,
	vocalsRef: r.vocalsRef ?? undefined,
	// A NULL column means no mix — leave it UNDEFINED, which guidePath() reads as the two-element path.
	guideMixRef: r.guideMixRef ?? undefined,
	// NULL → UNDEFINED, which the gate reads as still-processing. A present string is untrusted and re-normalized here, degrading a bad half rather than throwing.
	songProfile: r.songProfile ? normalizeSongProfile(safeParse(r.songProfile)) : undefined,
	lyricsRef: r.lyricsRef ?? undefined,
	lyricsCandidates: parseCandidates(r.lyricsCandidates),
	lyricsOverrideRef: r.lyricsOverrideRef ?? undefined,
	lyricsOverrideText: r.lyricsOverrideText ?? undefined,
	artistCanonical: r.artistCanonical ?? undefined,
	artistCredit: r.artistCredit ?? undefined,
	titleCanonical: r.titleCanonical ?? undefined
});

/**
 * THE readiness definition for the library, both browse filters and both browse rails, so "ready" cannot be
 * answered two ways. TWO HALVES: the SQL `WHERE` is a cheap NARROWING and never the predicate — `readyToSing`
 * makes the final call, because only it knows the lyrics gate, so a song mid-align passes the narrowing and
 * is still not finished. Callers must narrow in SQL and DECIDE in the gate table. `extra` narrows FURTHER in
 * SQL — the artist filter's index push-down, and `readyTagged`'s id set — but cannot relax the gate, which
 * always runs after it.
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
 * `byTag` and `tagFacets` both read this, so a chip's count is the length of the list it opens BY
 * CONSTRUCTION. Membership of `readySongs()` IS the gate; readiness is not re-asked.
 *
 * BOTH sides narrow in SQL: the tag rows name the only ids that can produce a pair, passed back as
 * `readySongs`'s `extra`, so the media read is `WHERE id IN (…)` rather than the whole ready library plus a
 * gate pass the join throws away (900 rows read at 4.42 ms/call to return 1, versus 1 row at 0.39 ms).
 *
 * The empty case needs NO branch: `inArray(media.id, [])` compiles to `false`. SKIPPING the `extra` when
 * `byMedia` is empty would restore the whole-library read for the one query that needs no rows at all.
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

	/** The DB is the INDEX and `meta/<id>.json` is authoritative, so every write refreshes the sidecar —
	 *  fire-and-forget, since it must never delay the in-memory flip the room is waiting on. */
	upsert(m: Media): void {
		const row = toRow(m);
		this.#db.insert(media).values(row).onConflictDoUpdate({ target: media.id, set: row }).run();
		this.#onPersist?.(m);
	}

	/** Row AND tags in ONE transaction, so either both land or neither. The caller MUST unlink the
	 *  authoritative sidecar BEFORE calling this, or a rescan rebuilds the row. */
	remove(mediaId: string): void {
		this.#db.transaction((tx) => {
			tx.delete(mediaTags).where(eq(mediaTags.mediaId, mediaId)).run();
			tx.delete(media).where(eq(media.id, mediaId)).run();
		});
	}

	byId(id: string): Media | undefined {
		const row = this.#db.select().from(media).where(eq(media.id, id)).all()[0];
		return row ? fromRow(row) : undefined;
	}

	/** EVERY row ever materialised by a search, most of them unprocessed — what boot hydrates the runtime
	 *  catalog from, and far more than the library shows. Use {@link listReady} for anything a guest sees. */
	all(): Media[] {
		return this.#db.select().from(media).all().map(fromRow);
	}

	/** Songs that are FINISHED, so re-queueing one skips the worker. Deliberately a one-liner over
	 *  `readySongs`, so "finished" keeps exactly one definition. */
	listReady(): Media[] {
		return readySongs(this.#db);
	}

	/** `undefined` means "do not touch" and is SKIPPED; an explicit `null` still clears. Without the
	 *  distinction, a caller passing null for "no opinion" re-nulls real values every restart. */
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

	/** Delete + re-insert in ONE transaction, or a crash mid-way leaves every tag of this kind deleted and
	 *  none written back. */
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

	/** NULL artists (a low-confidence parse) are excluded. Counts the READY set, never SQL `count(*)` —
	 *  the gate table is not visible to SQL. */
	artistFacets(): Array<{ artist: string; count: number }> {
		const artists = readySongs(this.#db, isNotNull(media.artistCanonical))
			.map((m) => m.artistCanonical)
			.filter((a): a is string => !!a);
		return facetCounts(artists).map(({ value, count }) => ({ artist: value, count }));
	}

	/** Exact match on the canonical value the facet returned. */
	byArtist(artist: string): Media[] {
		return readySongs(this.#db, eq(media.artistCanonical, artist));
	}

	/** Reads the same pairs `byTag` reads, so the count and the filter cannot disagree. */
	tagFacets(): Array<{ tag: string; count: number }> {
		return facetCounts(readyTagged(this.#db).map((p) => p.tag)).map(({ value, count }) => ({ tag: value, count }));
	}

	/** Shares readiness with the unfiltered library, so a mid-align row is excluded everywhere alike. */
	byTag(tag: string): Media[] {
		return readyTagged(this.#db, tag).map((p) => p.song);
	}
}

/** Runs BEFORE the first client syncs, or a queue entry can reference an unresolvable media. Existing
 *  runtime entries WIN: a durable row must never clobber a live object already referenced. */
export function hydrateMediaCatalog(rows: Media[], mediaById: Map<string, Media>): number {
	let added = 0;
	for (const m of rows) {
		if (mediaById.has(m.id)) continue;
		mediaById.set(m.id, m);
		added++;
	}
	return added;
}
