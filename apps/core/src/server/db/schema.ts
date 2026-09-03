// Drizzle schema — the write-behind durability layer. The hot path reads from in-memory
// authoritative state; this is hydrated on boot and persisted asynchronously.
// Mirrors the domain types in @encore/shared. See docs/ARCHITECTURE.md.

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
	// The separated instrumental's MediaStore key. Kept SEPARATE from source_ref so source_ref stays
	// the song's immutable origin identity (what search dedupes on) — see Media.sourceRef.
	instrumentalRef: text('instrumental_ref'),
	// Worker artifact keys. A cooked song is only fully restored if its derived artifacts come
	// back with it: without these, a library song would replay with stems but silently lose its
	// word-timed lyrics overlay and its scoring reference track after a restart.
	lyricsRef: text('lyrics_ref'),
	// The lyrics candidate SET as JSON. The sidecar is authoritative; this is the index copy so
	// a hydrate that has not read meta/ yet still knows each artifact's provenance — without it the TV
	// would show auto-transcribed words unlabelled until the async sidecar pass caught up. Nothing
	// queries inside it, so one JSON column beats a candidates table.
	lyricsCandidates: text('lyrics_candidates'),
	pitchRef: text('pitch_ref'),
	// Canonical metadata for BROWSE. Derived by the track-title normalizer and mirrored here
	// from the authoritative sidecar, because grouping the library by `artist` is useless — that column
	// holds the YouTube uploader ("7clouds"), not the artist. Nullable: a low-confidence parse stores
	// NULL rather than a guess, so a heading is never a lie.
	artistCanonical: text('artist_canonical'),
	// The canonical TITLE. The canonical artist was mirrored earlier but not the title, so the only
	// title reachable at runtime stayed the raw one ("Britney Spears - Baby One More Time (Lyrics)").
	// Browse didn't care, but a lyrics lookup does: LRCLIB matches on track_name, so sending the raw
	// title misses even when the artist is right. Nullable on the same principle as artist_canonical —
	// a low-confidence parse stores NULL rather than a guess.
	titleCanonical: text('title_canonical'),
	album: text('album'),
	year: integer('year')
});

/**
 * Multi-valued library metadata: genre, free tags, mood. ONE table rather than a column per
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
	keyShift: integer('key_shift').notNull().default(0) // semitones
});

// Room-level separator settings. Single-row ('singleton') like playback_state: these govern
// cooks EVERYONE shares, so they are authoritative room state, not a per-phone preference. Read
// whole / written whole; the shared @encore/shared RoomSettings type is the source of truth for the
// field set, and normalizeRoomSettings() gates writes so a bad payload can never persist.
export const globalSettings = sqliteTable('global_settings', {
	id: text('id').primaryKey().default('singleton'),
	defaultEngine: text('default_engine').notNull().default('demucs'),
	defaultModel: text('default_model').notNull().default('htdemucs'),
	enqueueUpgrade: integer('enqueue_upgrade', { mode: 'boolean' }).notNull().default(false),
	upgradeEngine: text('upgrade_engine').notNull().default('roformer'),
	upgradeModel: text('upgrade_model').notNull().default('bs-roformer-1297'),
	// Which downloader acquires source audio. Global rather than per-room: a room cannot choose a
	// fetcher its workers cannot run. `local` is never stored here — that describes one media's bytes,
	// not a deployment default — and normalizeGlobalSettings refuses it on both read and write.
	defaultFetcher: text('default_fetcher').notNull().default('ytdlp')
});

// One party's own policy, keyed by room so multi-room is a row per room rather than a migration.
// `max_quality_rank` is a downward-only ceiling on cook quality; NULL defers to the global default.
// A setting belongs here only when two rooms on one core could genuinely want different values.
export const roomSettings = sqliteTable('room_settings', {
	roomId: text('room_id').primaryKey(),
	tvProgressStyle: text('tv_progress_style', { enum: ['card', 'corner', 'edge', 'off'] })
		.notNull()
		.default('card'),
	interstitialMs: integer('interstitial_ms').notNull().default(2500),
	maxQualityRank: integer('max_quality_rank')
});

export const jobs = sqliteTable(
	'jobs',
	{
		id: text('id').primaryKey(),
		mediaId: text('media_id').notNull(),
		jobType: text('job_type', { enum: ['fetch', 'stems', 'align', 'score', 'stems-upgrade'] }).notNull(),
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
