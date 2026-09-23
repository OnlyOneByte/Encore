// Drizzle schema — the write-behind durability layer. Hot path reads in-memory authoritative state, hydrated on boot and persisted async. Mirrors $lib/contract; see docs/SERVER.md#schema-and-migrations.

import { sqliteTable, text, integer, real, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const rooms = sqliteTable(
	'rooms',
	{
		id: text('id').primaryKey(),
		// The join code a phone types (or a QR encodes) to reach this room. UNIQUE — a lookup by code resolves to exactly one room; the writer retries on a collision rather than minting two indistinguishable rooms.
		code: text('code').notNull(),
		createdAt: integer('created_at').notNull()
	},
	(t) => ({ codeIdx: uniqueIndex('rooms_code_idx').on(t.code) })
);

export const singers = sqliteTable(
	'singers',
	{
		id: text('id').primaryKey(),
		displayName: text('display_name').notNull(),
		color: text('color').notNull(),
		sessionToken: text('session_token').notNull(),
		joinedAt: integer('joined_at').notNull(),
		// When this singer last STARTED a song — the signal `least-recently-sung` ordering runs on. NULL means "has not sung" (distinct from 0: sorts ahead of everyone who has). Stored here, not in `plays`, since that table deliberately carries no singer id.
		lastSungAt: integer('last_sung_at'),
		// The party this singer belongs to. `room_id` scopes the roster to a room: ordering, presence, and rotation all read/write only THIS room's singers. Minted from the room `doJoin` resolved for the join request (an explicit join code, else the active room) — never read from a cookie. NOT NULL: every singer belongs to exactly one room; existing rows are re-keyed onto the active room by migration.
		roomId: text('room_id').notNull()
	},
	(t) => ({
		// session_token is the auth lookup key (bySessionToken on every authed request); UNIQUE gives O(log n) lookup and prevents a token collision from mapping two singers to one session.
		sessionTokenIdx: uniqueIndex('singers_session_token_idx').on(t.sessionToken),
		// Room roster read: listing a room's singers is the ordering/presence hot path.
		roomIdx: index('singers_room_idx').on(t.roomId)
	})
);

export const media = sqliteTable('media', {
	id: text('id').primaryKey(),
	// 'spotify' is a SEARCH/metadata source only — its bytes are never fetched. Plain TEXT with no SQL CHECK, so widening this enum needs no migration.
	source: text('source', { enum: ['youtube', 'local', 'spotify'] }).notNull(),
	sourceRef: text('source_ref').notNull(),
	title: text('title').notNull(),
	artist: text('artist'),
	durationSec: integer('duration_sec').notNull(),
	thumbnail: text('thumbnail'),
	// Views the source reported when last seen in search. DISPLAY ONLY — never an input to ranking, dedupe, or any process gate. Persisted so a library song keeps it too; NULL means "never learned one" (renders as no chip, not "0 views").
	viewCount: integer('view_count'),
	// The lyrics half of the process gate (contract/queue/gates.ts). NULL on rows predating the gate, read as "done if a lyrics artifact already exists" so an existing library isn't stranded unsingable on upgrade.
	lyricsStatus: text('lyrics_status', { enum: ['none', 'queued', 'ready'] }),
	stemStatus: text('stem_status', { enum: ['none', 'queued', 'ready'] })
		.notNull()
		.default('none'),
	// The separated instrumental's MediaStore key, kept SEPARATE from source_ref so source_ref stays the song's immutable origin identity (what search dedupes on).
	instrumentalRef: text('instrumental_ref'),
	// The isolated vocals stem (the guiding track). Separation always writes it beside the instrumental; persisting the ref is what survives a restart. Nullable: absent means no guide (never separated, or came back silent).
	vocalsRef: text('vocals_ref'),
	// The GUIDE MIX: both stems in ONE 4-channel file (ch 0/1 instrumental, ch 2/3 vocals) so the TV plays through a single element and splits channels in WebAudio — two elements would be two clocks that cannot be sample-locked from script. Nullable with meaningful null: no mix (predates the feature, no vocals stem, or a failed encode) falls back to the legacy two-element path, so existing songs keep today's behaviour with no backfill required.
	guideMixRef: text('guide_mix_ref'),
	// The stems job's third artifact: key + sung range as one JSON blob (contract/process/song-profile.ts). One column, not a table: nothing queries inside it. NULL ⇔ job hasn't run (gate reads as still-processing); an all-nulls profile INSIDE the JSON ⇔ analysis ran and found nothing (a FINISHED song) — losing that distinction would strand a silent-vocal song forever.
	songProfile: text('song_profile'),
	// Worker artifact keys — a restored song must come back with these, or it replays with stems but silently loses its lyrics overlay and scoring reference.
	lyricsRef: text('lyrics_ref'),
	// Lyrics candidate SET as JSON — index copy of the authoritative sidecar, so a hydrate that hasn't read meta/ yet still knows each artifact's provenance (else the TV shows unlabelled auto-transcribed words). One JSON column: nothing queries inside it.
	lyricsCandidates: text('lyrics_candidates'),
	// A human's explicit lyrics pick, by candidate ref — index copy of the sidecar. NULL means no override and ranking decides, as before this feature.
	lyricsOverrideRef: text('lyrics_override_ref'),
	// The WORDS behind a pasted (`manual`) override — no file on disk holds this text until the worker writes it, so a restart between enqueue and dispatch needs this index copy to re-derive the align job's params. NULL means the pin names an already-stored candidate (or there is none).
	lyricsOverrideText: text('lyrics_override_text'),
	// Canonical BROWSE metadata, mirrored from the sidecar — grouping by raw `artist` is useless (that column holds the uploader, e.g. "7clouds"). NULL on a low-confidence parse; a heading is never a lie.
	artistCanonical: text('artist_canonical'),
	// Canonical TITLE. Browse can tolerate the raw title, but a lyrics lookup can't — LRCLIB matches on track_name, so the raw title misses even when the artist is right. Nullable on the same principle as artist_canonical.
	titleCanonical: text('title_canonical'),
	// FULL artist billing as uploaded ("Lady Gaga feat. Beyoncé"), vs artist_canonical's primary-only ("Lady Gaga"). Kept because it distinguishes RECORDINGS, not spellings — a lyrics provider holds a separate record per version, and the full billing is the ranking signal that picks the right one; a lookup by primary artist alone would miss records filed under a featured credit.
	artistCredit: text('artist_credit'),
	// MusicBrainz recording id + how the canonicals were trusted. Persisted so the never-regress rule can tell a restart that an artist was CITED, not just guessed, and a later `medium`-confidence annotation can't overwrite it freely.
	mbid: text('mbid'),
	annotationSource: text('annotation_source'),
	annotationConfidence: text('annotation_confidence'),
	album: text('album'),
	year: integer('year')
});

/** Multi-valued library metadata: genre, free tags, mood. ONE table rather than a column per taxonomy, so every browse query has the same shape (`WHERE kind = ? AND value = ?`) and adding "decade" later needs no migration. The authoritative copy lives in the sidecar; this is the index. */
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

export const queueEntries = sqliteTable(
	'queue_entries',
	{
		id: text('id').primaryKey(), // client-minted ULID
		mediaId: text('media_id').notNull(),
		singerId: text('singer_id').notNull(),
		status: text('status', {
			enum: ['queued', 'playing', 'done']
		})
			.notNull()
			.default('queued'),
		rotationSeq: integer('rotation_seq').notNull(),
		addedAt: integer('added_at').notNull(),
		// The party this queue entry belongs to. `room_id` scopes the queue and its rotation to a room: the write-behind sink and boot-hydrate both read/write only THIS room's rows, so two rooms hold independent queues. NOT NULL: every entry lives in exactly one room; existing rows are re-keyed onto the active room by migration.
		roomId: text('room_id').notNull()
	},
	(t) => ({
		// The per-room queue read: hydrate and the write-behind replace both scope by room.
		roomIdx: index('queue_entries_room_idx').on(t.roomId)
	})
);

// Authoritative playback, KEYED BY ROOM: room_id is the primary key, one row per room minted alongside rooms.id, so concurrent parties hold independent playback (previously a singleton row, deployment-wide). Mirrors room_settings' PK shape; no emitted FK, since FK enforcement is off for this bun:sqlite DB.
export const playbackState = sqliteTable('playback_state', {
	roomId: text('room_id').primaryKey(),
	currentEntryId: text('current_entry_id'),
	positionSec: integer('position_sec').notNull().default(0),
	isPlaying: integer('is_playing', { mode: 'boolean' }).notNull().default(false),
	keyShift: integer('key_shift').notNull().default(0), // semitones
	// Per-song TV background override; NULLABLE means "use the room default" — a real resting value, not a missing one.
	background: text('background', { enum: ['off', 'gradient', 'singer', 'solid', 'visualizer'] }),
	// Guiding-track level for the current song, 0..1. REAL (not integer, which would round every level to 0/1). NULL means "inherit the room default", distinct from 0 ("explicitly off").
	guideLevel: real('guide_level')
});

// Room-level separator settings. Single-row ('singleton') table: these govern processes EVERYONE shares, so they're authoritative room state, not a per-phone preference. Read/written whole; the shared $lib/contract RoomSettings type is the source of truth for the field set, and normalizeRoomSettings() gates writes so a bad payload can never persist.
export const globalSettings = sqliteTable('global_settings', {
	id: text('id').primaryKey().default('singleton'),
	defaultEngine: text('default_engine').notNull().default('demucs'),
	defaultModel: text('default_model').notNull().default('htdemucs'),
	enqueueUpgrade: integer('enqueue_upgrade', { mode: 'boolean' }).notNull().default(false),
	upgradeEngine: text('upgrade_engine').notNull().default('roformer'),
	upgradeModel: text('upgrade_model').notNull().default('bs-roformer-1297'),
	// Which downloader acquires source audio. Global, not per-room: a room cannot choose a fetcher its workers cannot run. `local` is never stored here (it describes one media's bytes, not a deployment default) — normalizeGlobalSettings refuses it on both read and write.
	defaultFetcher: text('default_fetcher').notNull().default('ytdlp'),
	// The lyrics half of a process: Whisper checkpoint + timestamp sync mode. Global for the same reason as the fetcher — properties of the worker fleet, not one party. Defaults match the worker's old hardcoded values so an existing deployment behaves identically.
	asrModel: text('asr_model').notNull().default('base'),
	syncMode: text('sync_mode').notNull().default('forced'),
	// Address the TV's join QR advertises. '' = not declared → fall back to ENCORE_PUBLIC_ORIGIN, then the request. Global (names the deployment's address); stored rather than env-only because the TV's own URL is often unreachable from a phone (e.g. a WSL2 host sees itself only as `localhost`).
	joinOrigin: text('join_origin').notNull().default(''),
	// How many processes ONE singer may have in flight; 0 = uncapped. Global — the right number is a function of the worker fleet, not of one party. Default matches the previous hardcoded cap, so an existing box behaves identically.
	maxProcessesPerSinger: integer('max_processes_per_singer').notNull().default(3)
});

// One party's own policy, keyed by room so multi-room is a row per room rather than a migration. `max_quality_rank` is a downward-only ceiling on process quality; NULL defers to the global default. A setting belongs here only when two rooms on one core could genuinely want different values.
export const roomSettings = sqliteTable('room_settings', {
	roomId: text('room_id').primaryKey(),
	// The house rule: which ordering algorithm decides who sings next. Enum-constrained at the column, so a hand-edited DB cannot name an algorithm that doesn't exist; default is today's fair rotation.
	queueOrder: text('queue_order', { enum: ['fair', 'fcfs', 'shuffle', 'least-recently-sung', 'manual'] })
		.notNull()
		.default('fair'),
	tvProgressStyle: text('tv_progress_style', { enum: ['card', 'corner', 'edge', 'off'] })
		.notNull()
		.default('card'),
	tvBackgroundStyle: text('tv_background_style', { enum: ['off', 'gradient', 'singer', 'solid', 'visualizer'] })
		.notNull()
		.default('off'),
	// The stage's COLOUR as canonical 6-digit lowercase hex (was an integer hue angle at a pinned lightness). Read when style is `solid` (verbatim) or `visualizer` (as the palette's hue, via `hueOfColor`). Migration 0005 backfilled existing rows by mapping their old quantised hue through the same stage tier; the default below is `stageHueToHex(240)`, what the old `DEFAULT 240` rendered as.
	tvBackgroundColor: text('tv_background_color').notNull().default('#001d31'),
	// How far the stage colour is dimmed toward black, 0..1. REAL for the same reason as guide_level_default. NOT NULL default 0 so an existing room upgrades to today's behaviour (no dim). A lightness control, not opacity — it darkens the colour `.stage-bg` already paints.
	tvBackgroundDim: real('tv_background_dim').notNull().default(0),
	// Which visualizer runs when the style is `visualizer`. Kept across a switch away from it, so a room that tries another background and comes back doesn't lose the choice.
	tvVisualizer: text('tv_visualizer', { enum: ['plasma', 'starfield', 'moire', 'lissajous'] })
		.notNull()
		.default('plasma'),
	songIntroEnabled: integer('song_intro_enabled', { mode: 'boolean' }).notNull().default(true),
	songIntroMs: integer('song_intro_ms').notNull().default(2500),
	maxQualityRank: integer('max_quality_rank'),
	// Lyrics presentation. Defaults reproduce the previously-hardcoded TV exactly. Enum-constrained like tv_progress_style, so a hand-edited DB cannot smuggle in a style the renderer has no branch for.
	lyricsBall: text('lyrics_ball', { enum: ['bounce', 'steady', 'underline', 'off'] })
		.notNull()
		.default('off'),
	lyricsHighlight: text('lyrics_highlight', { enum: ['word', 'line', 'off'] })
		.notNull()
		.default('word'),
	lyricsLeadMs: integer('lyrics_lead_ms').notNull().default(300),
	// `lyrics_scale_pct` is a PERCENT of the computed distance-based scale, not a size — see DEFAULT_LYRICS_SCALE_PCT for why an absolute size would be wrong. Integer so the table stays all-integer; enum-constrained where a registry exists.
	lyricsScalePct: integer('lyrics_scale_pct').notNull().default(100),
	lyricsFont: text('lyrics_font', { enum: ['system', 'grotesk', 'serif', 'mono'] })
		.notNull()
		.default('system'),
	lyricsCase: text('lyrics_case', { enum: ['natural', 'upper', 'lower'] })
		.notNull()
		.default('natural'),
	lyricsLinesBefore: integer('lyrics_lines_before').notNull().default(2),
	lyricsLinesAfter: integer('lyrics_lines_after').notNull().default(2),
	// The room's default guiding-track level, 0..1. REAL for the same reason as playback_state's. NOT NULL default 0 so an existing room upgrades to today's behaviour (pure karaoke).
	guideLevelDefault: real('guide_level_default').notNull().default(0),
	// Whether this room pulls loud outlier songs down at playback. NOT NULL default false so an existing room upgrades to today's behaviour (every song at unity) rather than silently changing levels.
	loudnessNormalization: integer('loudness_normalization', { mode: 'boolean' }).notNull().default(false),
	// How long someone stays in the room after their socket drops AND their last pending song leaves the queue. 0 = no grace once their songs are done.
	presenceGraceMinutes: integer('presence_grace_minutes').notNull().default(90)
});

export const jobs = sqliteTable(
	'jobs',
	{
		id: text('id').primaryKey(),
		mediaId: text('media_id').notNull(),
		// The process this job belongs to (see Job.processingId in $lib/contract for why media_id can't serve as the grouping key). Defaulted to '' rather than nullable so pre-column rows read as "no process recorded" instead of null-checking at every call site.
		processingId: text('processing_id').notNull().default(''),
		// The singer who requested this process — attribution for the per-singer concurrent-process cap. NULLABLE: internal callers (lyrics backfill, chained steps) impose no cap. Counts a singer's live process JOBS here, not queue ENTRIES — entry (WS) and process (HTTP) ride different transports, and an entry-derived cap would count zero while a socket reconnects.
		singerId: text('singer_id'),
		jobType: text('job_type', { enum: ['fetch', 'stems', 'align', 'stems-upgrade'] }).notNull(),
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
	// Dedup (§7): at most ONE live job per (mediaId, jobType). PARTIAL index excludes terminal jobs (failed/canceled) so a song can be re-processed after failure/cancel — enforced by the DB even if a dispatch race slips past the application-level check.
	(t) => ({
		liveJobIdx: uniqueIndex('jobs_live_media_type_idx')
			.on(t.mediaId, t.jobType)
			.where(sql`${t.status} NOT IN ('failed', 'canceled')`)
	})
);

/** ONE ROW PER ATTEMPT — the audit spine, contrasting `jobs` (mutated in place, describes only the present). WHY A SECOND TABLE: dedup requires exactly one live `jobs` row per (mediaId, jobType), and a retry REUSES that row, so there's nowhere to put a second attempt — splitting lets `jobs` stay the one-live-row dispatch slot while every attempt gets its own immutable record here. NOT deduped and NOT unique on anything but `id`: a second attempt is a second row, deliberately. */
export const jobAttempts = sqliteTable(
	'job_attempts',
	{
		id: text('id').primaryKey(),
		jobId: text('job_id').notNull(),
		mediaId: text('media_id').notNull(),
		processingId: text('processing_id').notNull(),
		jobType: text('job_type', { enum: ['fetch', 'stems', 'align', 'stems-upgrade'] }).notNull(),
		attempt: integer('attempt').notNull().default(1),
		workerId: text('worker_id'),
		// The four clocks. Nullable past `enqueued_at` because each records a moment that may never arrive — a job never picked up has no start, and writing 0 would invent work.
		enqueuedAt: integer('enqueued_at').notNull(),
		assignedAt: integer('assigned_at'),
		startedAt: integer('started_at'),
		finishedAt: integer('finished_at'),
		// NULL outcome = the attempt is still in flight. At most one such row per job_id.
		outcome: text('outcome', { enum: ['ready', 'failed', 'canceled', 'abandoned'] }),
		error: text('error'),
		// What actually ran. Recorded per attempt because these resolve from operator-editable global settings at dispatch time, so they can't be re-derived after the fact — see JobAttempt in shared.
		engine: text('engine'),
		model: text('model'),
		backend: text('backend'),
		device: text('device'),
		asrModel: text('asr_model'),
		syncMode: text('sync_mode'),
		// Snapshotted song length, so every cost can be reported as a rate rather than raw seconds.
		audioSec: integer('audio_sec'),
		// PER-STAGE wall clock as JSON: [{stage,ms}], the split the core's own clocks can't see (download vs separate). One JSON column, not a stage_timings table: nothing queries inside it.
		stages: text('stages'),
		// WHY the published lyric was chosen, as JSON: rejected labels + composite scores + decided_by + baseline vote count. Same reasoning as `stages`: read whole to explain one attempt, never queried inside. Null on every non-align attempt and on an align that made no pick. See SelectionRecord.
		selection: text('selection')
	},
	(t) => ({
		// the per-song audit page: every attempt for one song, newest last
		byMedia: index('job_attempts_media_idx').on(t.mediaId, t.enqueuedAt),
		// end-to-end per process, and finding the sibling steps of one run
		byProcess: index('job_attempts_processing_idx').on(t.processingId),
		// closing the in-flight attempt on a lifecycle event — the hot write path
		byJob: index('job_attempts_job_idx').on(t.jobId),
		// the metrics rollup: "average stems time over the last N days", grouped by step
		byTypeFinished: index('job_attempts_type_finished_idx').on(t.jobType, t.finishedAt)
	})
);

/** ONE ROW PER PLAY — the time axis for the stats page. The sidecar's `library.playCount`/`lastPlayedAt` remains the authoritative total and drives LRU retention; this table only answers WHEN, which a counter can't and `queue_entries` can't either (wiped on every flush/boot). Deliberately no `singer_id` — see docs/ARCHITECTURE.md §10. */
export const plays = sqliteTable(
	'plays',
	{
		id: text('id').primaryKey(),
		mediaId: text('media_id').notNull(),
		// The queue entry this play came from — prevents double-counting when a process-completion re-emits now-playing for a song already on screen.
		entryId: text('entry_id').notNull(),
		at: integer('at').notNull()
	},
	(t) => ({
		byAt: index('plays_at_idx').on(t.at),
		byMedia: index('plays_media_idx').on(t.mediaId, t.at),
		// One play per queue entry, enforced durably (the in-memory dedup in plays.ts is not trusted alone).
		uniqEntry: uniqueIndex('plays_entry_idx').on(t.entryId)
	})
);
