// Drizzle schema — the write-behind durability layer. The hot path reads from in-memory
// authoritative state (M1-C1); this is hydrated on boot and persisted asynchronously.
// Mirrors the domain types in @encore/shared. See docs/MASTER-DESIGN.md §5.

import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const rooms = sqliteTable('rooms', {
	id: text('id').primaryKey(),
	code: text('code').notNull(),
	createdAt: integer('created_at').notNull()
});

export const singers = sqliteTable(
	'singers',
	{
		id: text('id').primaryKey(),
		displayName: text('display_name').notNull(),
		color: text('color').notNull(),
		sessionToken: text('session_token').notNull(),
		joinedAt: integer('joined_at').notNull()
	},
	// Finding #3: session_token is the auth lookup key (bySessionToken on every authed request).
	// UNIQUE index = O(log n) lookup instead of a table scan AND prevents a (vanishingly unlikely
	// but catastrophic) token collision from mapping two singers to one session.
	(t) => ({ sessionTokenIdx: uniqueIndex('singers_session_token_idx').on(t.sessionToken) })
);

export const media = sqliteTable('media', {
	id: text('id').primaryKey(),
	source: text('source', { enum: ['youtube', 'local'] }).notNull(),
	sourceRef: text('source_ref').notNull(),
	title: text('title').notNull(),
	artist: text('artist'),
	durationSec: integer('duration_sec').notNull(),
	thumbnail: text('thumbnail'),
	stemStatus: text('stem_status', { enum: ['none', 'queued', 'ready'] })
		.notNull()
		.default('none'),
	playMode: text('play_mode', { enum: ['iframe', 'file'] }).notNull().default('iframe'),
	// The separated instrumental's MediaStore key. Kept SEPARATE from source_ref so source_ref stays
	// the song's immutable origin identity (what search dedupes on) — see Media.sourceRef.
	instrumentalRef: text('instrumental_ref'),
	// Worker artifact keys (B-1). A cooked song is only fully restored if its derived artifacts come
	// back with it: without these, a library song would replay with stems but silently lose its
	// word-timed lyrics overlay (M8-C2) and its scoring reference track (M8-C3) after a restart.
	lyricsRef: text('lyrics_ref'),
	pitchRef: text('pitch_ref'),
	// Canonical metadata for BROWSE (B-7-C4). Derived by the track-title normalizer and mirrored here
	// from the authoritative sidecar, because grouping the library by `artist` is useless — that column
	// holds the YouTube uploader ("7clouds"), not the artist. Nullable: a low-confidence parse stores
	// NULL rather than a guess, so a heading is never a lie.
	artistCanonical: text('artist_canonical'),
	// The canonical TITLE (B-3-C1). B-7-C4 mirrored the canonical artist but not the title, so the only
	// title reachable at runtime stayed the raw one ("Britney Spears - Baby One More Time (Lyrics)").
	// Browse didn't care, but a lyrics lookup does: LRCLIB matches on track_name, so sending the raw
	// title misses even when the artist is right. Nullable on the same principle as artist_canonical —
	// a low-confidence parse stores NULL rather than a guess.
	titleCanonical: text('title_canonical'),
	album: text('album'),
	year: integer('year')
});

/**
 * Multi-valued library metadata (B-7-C4): genre, free tags, mood. ONE table rather than a column per
 * taxonomy, so every browse query has the same shape (`WHERE kind = ? AND value = ?`) and adding
 * "decade" later needs no migration. The authoritative copy lives in the sidecar; this is the index.
 */
export const mediaTags = sqliteTable(
	'media_tags',
	{
		mediaId: text('media_id').notNull(),
		kind: text('kind', { enum: ['genre', 'tag', 'mood'] }).notNull(),
		value: text('value').notNull()
	},
	(t) => ({
		// browse: every song of a genre
		byKindValue: index('media_tags_kind_value_idx').on(t.kind, t.value),
		// render: every tag of one song
		byMedia: index('media_tags_media_idx').on(t.mediaId),
		// a song cannot carry the same tag twice
		uniq: uniqueIndex('media_tags_unique_idx').on(t.mediaId, t.kind, t.value)
	})
);

export const queueEntries = sqliteTable('queue_entries', {
	id: text('id').primaryKey(), // client-minted ULID
	mediaId: text('media_id').notNull(),
	singerId: text('singer_id').notNull(),
	status: text('status', {
		enum: ['queued', 'playing', 'waiting', 'done', 'skipped']
	})
		.notNull()
		.default('queued'),
	rotationSeq: integer('rotation_seq').notNull(),
	addedAt: integer('added_at').notNull()
});

// single-row table holding authoritative playback (id always 'singleton')
export const playbackState = sqliteTable('playback_state', {
	id: text('id').primaryKey().default('singleton'),
	currentEntryId: text('current_entry_id'),
	positionSec: integer('position_sec').notNull().default(0),
	isPlaying: integer('is_playing', { mode: 'boolean' }).notNull().default(false),
	keyShift: integer('key_shift').notNull().default(0) // semitones (M7-C9)
});

export const jobs = sqliteTable(
	'jobs',
	{
		id: text('id').primaryKey(),
		mediaId: text('media_id').notNull(),
		jobType: text('job_type', { enum: ['stems', 'align', 'score'] }).notNull(),
		status: text('status', {
			enum: ['queued', 'assigned', 'running', 'ready', 'failed', 'canceled']
		})
			.notNull()
			.default('queued'),
		priority: integer('priority').notNull().default(0),
		attempts: integer('attempts').notNull().default(0),
		maxAttempts: integer('max_attempts').notNull().default(3),
		workerId: text('worker_id'),
		stage: text('stage'),
		progressPct: integer('progress_pct').notNull().default(0),
		etaSec: integer('eta_sec'),
		error: text('error'), // last failure message; surfaced to the singer's phone on terminal failure (§10)
		leaseExpiresAt: integer('lease_expires_at'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	// Dedup (job-lifecycle §6/§10): at most ONE live job per (mediaId, jobType). The index is
	// PARTIAL — terminal jobs (failed/canceled) are excluded so a song can be re-processed after a
	// failure or cancel. Two people queueing the same song → one compute; the DB enforces it even
	// if a dispatch race slips past the application-level check.
	(t) => ({
		liveJobIdx: uniqueIndex('jobs_live_media_type_idx')
			.on(t.mediaId, t.jobType)
			.where(sql`${t.status} NOT IN ('failed', 'canceled')`)
	})
);
