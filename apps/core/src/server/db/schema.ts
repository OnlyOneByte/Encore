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
	// The lyrics half of the cook gate (see packages/shared/src/gates.ts). NULL on rows written before
	// the gate existed, which the gate reads as "done if a lyrics artifact is already present" so an
	// existing library does not become unsingable on upgrade.
	lyricsStatus: text('lyrics_status', { enum: ['none', 'queued', 'ready'] }),
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
	// MusicBrainz recording id, and how the canonicals above came to be trusted. Persisted rather than
	// left in memory because the never-regress rule reads it: without a stored confidence a restart
	// forgets that an artist was CITED, and the next `medium` annotation would overwrite it freely.
	mbid: text('mbid'),
	annotationSource: text('annotation_source'),
	annotationConfidence: text('annotation_confidence'),
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
	defaultFetcher: text('default_fetcher').notNull().default('ytdlp'),
	// The lyrics half of a cook: which Whisper checkpoint reads the words, and how those words get
	// timestamps. Global for the same reason as the fetcher — both are properties of the worker fleet
	// (weights it must download and hold, an align model it must be able to load), not of one party.
	// Defaults match the values the worker hardcoded before these were settings, so an existing
	// deployment cooks identically until someone changes them.
	asrModel: text('asr_model').notNull().default('base'),
	syncMode: text('sync_mode').notNull().default('forced'),
	// Address the TV's join QR advertises. '' = not declared, fall back to ENCORE_PUBLIC_ORIGIN and
	// then to the request. Global because it names the deployment's own address; stored rather than
	// env-only because the TV's own URL is often unusable from a phone (a WSL2 host can reach itself
	// only as `localhost`) and whoever knows the real address may not be able to restart the process.
	joinOrigin: text('join_origin').notNull().default('')
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
	maxQualityRank: integer('max_quality_rank'),
	// Lyrics presentation. Defaults reproduce the previously-hardcoded TV exactly, so an existing room
	// renders identically after the migration. Enum-constrained at the column like tv_progress_style,
	// so a hand-edited DB cannot smuggle in a style the renderer has no branch for.
	lyricsBall: text('lyrics_ball', { enum: ['bounce', 'steady', 'underline', 'off'] })
		.notNull()
		.default('bounce'),
	lyricsHighlight: text('lyrics_highlight', { enum: ['word', 'line', 'off'] })
		.notNull()
		.default('word'),
	lyricsLeadMs: integer('lyrics_lead_ms').notNull().default(300)
});

export const jobs = sqliteTable(
	'jobs',
	{
		id: text('id').primaryKey(),
		mediaId: text('media_id').notNull(),
		// The cook this job belongs to — see Job.cookId in @encore/shared for why media_id cannot serve
		// as the grouping key. Defaulted to '' rather than left nullable so rows written before the
		// column existed read as "no cook recorded" instead of null-checking at every call site; those
		// rows predate the attempt ledger and have no timings to group anyway.
		cookId: text('cook_id').notNull().default(''),
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

/**
 * ONE ROW PER ATTEMPT at one job — the audit spine. Contrast `jobs` above, which is mutated in place
 * and therefore only ever describes the present: this table is the historical record.
 *
 * WHY A SECOND TABLE RATHER THAN MORE COLUMNS ON `jobs`. The dedup design requires exactly one live
 * `jobs` row per (mediaId, jobType), and a retry REUSES that row. So the shape that makes dedup
 * correct is the shape that makes history impossible — there is nowhere to put a second attempt.
 * Splitting them lets each be right: `jobs` stays the one-live-row dispatch slot, and every attempt
 * at it gets its own immutable record here.
 *
 * NOT deduped and NOT unique on anything but `id`: a second attempt is a second row, deliberately.
 */
export const jobAttempts = sqliteTable(
	'job_attempts',
	{
		id: text('id').primaryKey(),
		jobId: text('job_id').notNull(),
		mediaId: text('media_id').notNull(),
		cookId: text('cook_id').notNull(),
		jobType: text('job_type', { enum: ['fetch', 'stems', 'align', 'score', 'stems-upgrade'] }).notNull(),
		attempt: integer('attempt').notNull().default(1),
		workerId: text('worker_id'),
		// The four clocks. Nullable past `enqueued_at` because each records a moment that may never
		// arrive — a job that was never picked up has no start, and writing 0 would invent work.
		enqueuedAt: integer('enqueued_at').notNull(),
		assignedAt: integer('assigned_at'),
		startedAt: integer('started_at'),
		finishedAt: integer('finished_at'),
		// NULL outcome = the attempt is still in flight. At most one such row per job_id.
		outcome: text('outcome', { enum: ['ready', 'failed', 'canceled', 'abandoned'] }),
		error: text('error'),
		// What actually ran. Recorded per attempt because these resolve from operator-editable global
		// settings at dispatch, so they cannot be re-derived after the fact — see JobAttempt in shared.
		engine: text('engine'),
		model: text('model'),
		backend: text('backend'),
		device: text('device'),
		asrModel: text('asr_model'),
		syncMode: text('sync_mode'),
		// Snapshotted song length, so every cost can be reported as a rate rather than raw seconds.
		audioSec: integer('audio_sec')
	},
	(t) => ({
		// the per-song audit page: every attempt for one song, newest last
		byMedia: index('job_attempts_media_idx').on(t.mediaId, t.enqueuedAt),
		// end-to-end per cook, and finding the sibling steps of one run
		byCook: index('job_attempts_cook_idx').on(t.cookId),
		// closing the in-flight attempt on a lifecycle event — the hot write path
		byJob: index('job_attempts_job_idx').on(t.jobId),
		// the metrics rollup: "average stems time over the last N days", grouped by step
		byTypeFinished: index('job_attempts_type_finished_idx').on(t.jobType, t.finishedAt)
	})
);

/**
 * ONE ROW PER PLAY — the time axis for the public stats page.
 *
 * The sidecar already carries `library.playCount` and `lastPlayedAt`, which is enough to rank songs
 * by total and to drive LRU retention, and this table does NOT replace it: the counter stays the
 * authoritative total. What a counter cannot answer is WHEN, so "songs sung tonight" or any trend
 * over time is unanswerable from it. `queue_entries` cannot answer it either — it is deleted whole on
 * every flush and terminal rows are dropped again on boot, so a finished performance leaves no trace.
 *
 * Deliberately NO `singer_id`. A per-singer leaderboard is out of scope, and over a small library
 * "who sang what" is identifying; not collecting it is the honest default rather than collecting it
 * and choosing not to display it.
 */
export const plays = sqliteTable(
	'plays',
	{
		id: text('id').primaryKey(),
		mediaId: text('media_id').notNull(),
		// The queue entry this play came from. Carried so the same performance cannot be counted twice
		// when a cook-completion re-emits now-playing for a song that is already on screen.
		entryId: text('entry_id').notNull(),
		at: integer('at').notNull()
	},
	(t) => ({
		byAt: index('plays_at_idx').on(t.at),
		byMedia: index('plays_media_idx').on(t.mediaId, t.at),
		// One play per queue entry. The dedup that plays.ts does in memory, enforced durably: a
		// re-emit for the entry already playing is refused by the DB rather than trusted not to happen.
		uniqEntry: uniqueIndex('plays_entry_idx').on(t.entryId)
	})
);
