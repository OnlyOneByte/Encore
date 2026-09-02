// Media repository — the durable catalog (B-1). Search results and cooked (make-karaoke) songs are
// upserted here so the media catalog survives a restart, `requestMakeKaraoke` dedupes to already-
// separated stems instead of re-cooking, and the saved-karaoke library (M9-C2) can list every song
// whose instrumental is on disk. The runtime `mediaById` Map stays the hot read path; this is the
// write-behind + boot-hydrate store.
import { eq, and, desc } from 'drizzle-orm';
import type { DB } from '../db/index';
import { media } from '../db/schema';
import type { Media } from '@encore/shared';

type MediaRow = typeof media.$inferInsert;

// Drizzle round-trip both ways. The DB is nullable-column shaped; the domain type is
// optional-property shaped, so null ⇄ undefined is translated here rather than leaking either
// convention across the seam.
const toRow = (m: Media): MediaRow => ({
	id: m.id,
	source: m.source,
	sourceRef: m.sourceRef,
	title: m.title,
	artist: m.artist ?? null,
	durationSec: Math.round(m.durationSec),
	thumbnail: m.thumbnail ?? null,
	stemStatus: m.stemStatus,
	playMode: m.playMode,
	instrumentalRef: m.instrumentalRef ?? null,
	lyricsRef: m.lyricsRef ?? null,
	pitchRef: m.pitchRef ?? null
});

const fromRow = (r: typeof media.$inferSelect): Media => ({
	id: r.id,
	source: r.source,
	sourceRef: r.sourceRef,
	title: r.title,
	artist: r.artist ?? undefined,
	durationSec: r.durationSec,
	thumbnail: r.thumbnail ?? undefined,
	stemStatus: r.stemStatus,
	playMode: r.playMode,
	instrumentalRef: r.instrumentalRef ?? undefined,
	lyricsRef: r.lyricsRef ?? undefined,
	pitchRef: r.pitchRef ?? undefined
});

export class MediaRepository {
	#db: DB;
	constructor(db: DB) {
		this.#db = db;
	}

	/** Insert or update a media record (idempotent on id). Called on search-materialize and on every
	 *  artifact flip (stems ready / lyrics / pitch), so the catalog is durable. */
	upsert(m: Media): void {
		const row = toRow(m);
		this.#db.insert(media).values(row).onConflictDoUpdate({ target: media.id, set: row }).run();
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

	/** The saved-karaoke library: songs whose stems are separated and ready (playMode file, stems
	 *  ready) — re-queueing one skips the worker entirely (B-1 / M9-C2). Ordered newest-first by id
	 *  (ULIDs are monotonic, so this is catalog-discovery order, not cook order). */
	listReady(): Media[] {
		return this.#db
			.select()
			.from(media)
			.where(and(eq(media.stemStatus, 'ready'), eq(media.playMode, 'file')))
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
