// The write-behind durability layer: the hot path reads in-memory authoritative state, hydrated on boot and persisted async. See docs/SERVER.md#schema-and-migrations.

import { sqliteTable, text, integer, real, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const rooms = sqliteTable(
	'rooms',
	{
		id: text('id').primaryKey(),
		// UNIQUE, so a lookup by code resolves to exactly one room; the writer retries on a collision rather than minting two indistinguishable rooms.
		code: text('code').notNull(),
		createdAt: integer('created_at').notNull(),
		// The screen holding the room's TV seat: a hash of its `encore_tv` cookie, so a restart hands the seat back.
		tvSeat: text('tv_seat')
	},
	(t) => ({ codeIdx: uniqueIndex('rooms_code_idx').on(t.code) })
);

export const singers = sqliteTable(
	'singers',
	{
		id: text('id').primaryKey(),
		displayName: text('display_name').notNull(),
		color: text('color').notNull(),
		// SHA-256 hex of the `encore_singer` cookie, never the cookie itself: a copied DB file must not be a set of logins.
		sessionToken: text('session_token').notNull(),
		joinedAt: integer('joined_at').notNull(),
		// NULL means "has not sung", distinct from 0, which sorts ahead of everyone who has. Here and not in `plays`, which deliberately carries no singer id.
		lastSungAt: integer('last_sung_at'),
		// Scopes the roster to a room: ordering, presence and rotation all read only THIS room's singers. Minted from the room `doJoin` resolved, NEVER read from a cookie.
		roomId: text('room_id').notNull(),
		// The kept person this night belongs to; NULL for a guest. Server-side only, never on the wire.
		personId: text('person_id')
	},
	(t) => ({
		// The auth lookup key on every authed request. UNIQUE prevents a token collision mapping two singers to one session.
		sessionTokenIdx: uniqueIndex('singers_session_token_idx').on(t.sessionToken),
		roomIdx: index('singers_room_idx').on(t.roomId),
		personIdx: index('singers_person_idx').on(t.personId)
	})
);

// Someone who tapped Keep me. See docs/SERVER.md#kept-people.
export const people = sqliteTable('people', {
	id: text('id').primaryKey(),
	displayName: text('display_name').notNull(),
	color: text('color').notNull(),
	createdAt: integer('created_at').notNull()
});

// A phone a person is kept on, keyed by the SHA-256 hex of its `encore_device` cookie.
export const personDevices = sqliteTable(
	'person_devices',
	{
		id: text('id').primaryKey(),
		personId: text('person_id').notNull(),
		tokenHash: text('token_hash').notNull(),
		createdAt: integer('created_at').notNull(),
		lastSeenAt: integer('last_seen_at').notNull(),
		// The token before the last rotation, still accepted until the new one is first used or this time passes,
		// so a lost response cannot un-keep the phone. See docs/SERVER.md#kept-people.
		prevTokenHash: text('prev_token_hash'),
		prevValidUntil: integer('prev_valid_until'),
		// The new token is sha256(salt:previous token), so a grace use can be answered with it without storing it.
		rotationSalt: text('rotation_salt')
	},
	(t) => ({
		tokenIdx: uniqueIndex('person_devices_token_idx').on(t.tokenHash),
		personIdx: index('person_devices_person_idx').on(t.personId)
	})
);

// A phone the host unlocked, keyed by the SHA-256 hex of its `encore_host` cookie. See docs/SERVER.md#the-host-key.
export const hostSessions = sqliteTable('host_sessions', {
	tokenHash: text('token_hash').primaryKey(),
	createdAt: integer('created_at').notNull(),
	expiresAt: integer('expires_at').notNull()
});

export const media = sqliteTable('media', {
	id: text('id').primaryKey(),
	// Plain TEXT with no SQL CHECK, so widening this enum needs no migration.
	source: text('source', { enum: ['youtube', 'local', 'spotify'] }).notNull(),
	sourceRef: text('source_ref').notNull(),
	title: text('title').notNull(),
	artist: text('artist'),
	durationSec: integer('duration_sec').notNull(),
	thumbnail: text('thumbnail'),
	// DISPLAY ONLY, never an input to ranking, dedupe or any gate. NULL means "never learned one", which renders as no chip rather than "0 views".
	viewCount: integer('view_count'),
	// NULL on rows predating the gate, read as "done if a lyrics artifact already exists", so an existing library is not stranded unsingable on upgrade.
	lyricsStatus: text('lyrics_status', { enum: ['none', 'queued', 'ready'] }),
	stemStatus: text('stem_status', { enum: ['none', 'queued', 'ready'] })
		.notNull()
		.default('none'),
	// The download a fetch job kept, so later stages read it rather than download the song again. NULL on a library file and on rows fetched before downloads were kept, which download as they always did.
	originalRef: text('original_ref'),
	// Its size at fetch: a kept file of any other size (empty, truncated) is not trusted, and the watch URL is used.
	originalBytes: integer('original_bytes'),
	// SEPARATE from source_ref, which must stay the song's immutable origin identity — what search dedupes on.
	instrumentalRef: text('instrumental_ref'),
	// Nullable: absent means no guide, either never separated or came back silent.
	vocalsRef: text('vocals_ref'),
	// Both stems in ONE 4-channel file, so the TV plays through a single element: two would be two clocks that cannot be sample-locked from script. Nullable with meaningful null — no mix falls back to the legacy two-element path, so no backfill is required.
	guideMixRef: text('guide_mix_ref'),
	// One column, not a table: nothing queries inside it. NULL means the job has not run and the gate reads still-processing; an all-nulls profile INSIDE the JSON means analysis ran and found nothing, a FINISHED song. Losing that distinction strands a silent-vocal song forever.
	songProfile: text('song_profile'),
	lyricsRef: text('lyrics_ref'),
	// An index copy of the authoritative sidecar, so a hydrate that has not read meta/ yet still knows each artifact's provenance.
	lyricsCandidates: text('lyrics_candidates'),
	// An index copy of the sidecar. NULL means no override, and ranking decides.
	lyricsOverrideRef: text('lyrics_override_ref'),
	// No file on disk holds this text until the worker writes it, so a restart between enqueue and dispatch needs this copy to re-derive the align job's params.
	lyricsOverrideText: text('lyrics_override_text'),
	// An index copy of the sidecar's lyrics-fix rev, so a restart keeps the stale-save check.
	lyricsEditRev: integer('lyrics_edit_rev'),
	// An index copy of the sidecar's whole-song lyrics nudge.
	lyricsOffsetMs: integer('lyrics_offset_ms'),
	// Grouping by raw `artist` is useless, since that column holds the UPLOADER. NULL on a low-confidence parse: a heading is never a lie.
	artistCanonical: text('artist_canonical'),
	// Browse tolerates the raw title but a lyrics lookup cannot: LRCLIB matches on track_name, so the raw title misses even when the artist is right.
	titleCanonical: text('title_canonical'),
	// Distinguishes RECORDINGS, not spellings: a provider holds a separate record per version, and the full billing is the ranking signal that picks the right one.
	artistCredit: text('artist_credit'),
	// Persisted so the never-regress rule can tell a restart an artist was CITED rather than guessed, and a later `medium` annotation cannot overwrite it.
	mbid: text('mbid'),
	annotationSource: text('annotation_source'),
	annotationConfidence: text('annotation_confidence'),
	album: text('album'),
	year: integer('year')
});

/** ONE table rather than a column per taxonomy, so every browse query has the same shape and adding "decade" later needs no migration. The sidecar holds the authoritative copy. */
export const mediaTags = sqliteTable(
	'media_tags',
	{
		mediaId: text('media_id').notNull(),
		kind: text('kind', { enum: ['genre', 'tag', 'mood'] }).notNull(),
		value: text('value').notNull()
	},
	(t) => ({
		byKindValue: index('media_tags_kind_value_idx').on(t.kind, t.value),
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
		// The on-deck preset (QueueEntry.keyShift/guideLevel/deferred). NOT NULL with the reset's own values as
		// defaults, so a hydrated row reads exactly like an entry nobody touched.
		keyShift: integer('key_shift').notNull().default(0),
		guideLevel: real('guide_level'),
		deferred: integer('deferred', { mode: 'boolean' }).notNull().default(false),
		// QueueEntry.playFailed: the TV could not play this turn, which holds its slot until the singer acts.
		playFailed: integer('play_failed', { mode: 'boolean' }).notNull().default(false),
		// QueueEntry.playFailures: two failures of one song and Try again is gone, across a restart too.
		playFailures: integer('play_failures').notNull().default(0),
		// Scopes the queue and its rotation to a room, so the write-behind sink and boot-hydrate both touch only THIS room's rows and two rooms hold independent queues.
		roomId: text('room_id').notNull()
	},
	(t) => ({
		roomIdx: index('queue_entries_room_idx').on(t.roomId)
	})
);

// KEYED BY ROOM, one row minted alongside rooms.id, so concurrent parties hold independent playback. No emitted FK, since FK enforcement is off for this bun:sqlite DB.
export const playbackState = sqliteTable('playback_state', {
	roomId: text('room_id').primaryKey(),
	currentEntryId: text('current_entry_id'),
	positionSec: integer('position_sec').notNull().default(0),
	isPlaying: integer('is_playing', { mode: 'boolean' }).notNull().default(false),
	keyShift: integer('key_shift').notNull().default(0), // semitones
	// Per-song TV background override; NULLABLE means "use the room default" — a real resting value, not a missing one.
	background: text('background', { enum: ['off', 'gradient', 'singer', 'solid', 'visualizer'] }),
	// REAL, not integer, which would round every level to 0 or 1. NULL means "inherit the room default", distinct from 0, "explicitly off".
	guideLevel: real('guide_level')
});

// A single-row table, because these govern processes EVERYONE shares: authoritative room state, not a per-phone preference. normalizeRoomSettings() gates writes so a bad payload cannot persist.
export const globalSettings = sqliteTable('global_settings', {
	id: text('id').primaryKey().default('singleton'),
	defaultEngine: text('default_engine').notNull().default('demucs'),
	defaultModel: text('default_model').notNull().default('htdemucs'),
	enqueueUpgrade: integer('enqueue_upgrade', { mode: 'boolean' }).notNull().default(false),
	upgradeEngine: text('upgrade_engine').notNull().default('roformer'),
	upgradeModel: text('upgrade_model').notNull().default('bs-roformer-1297'),
	// Global, not per-room: a room cannot choose a fetcher its workers cannot run. `local` is never stored here, and normalizeGlobalSettings refuses it on read and write.
	defaultFetcher: text('default_fetcher').notNull().default('ytdlp'),
	// Global for the same reason as the fetcher: properties of the worker FLEET, not of one party.
	asrModel: text('asr_model').notNull().default('base'),
	syncMode: text('sync_mode').notNull().default('forced'),
	// '' = not declared, falling back to ENCORE_PUBLIC_ORIGIN then the request. Stored rather than env-only, because the TV's own URL is often unreachable from a phone.
	joinOrigin: text('join_origin').notNull().default(''),
	// 0 = uncapped. Global, because the right number is a function of the worker fleet.
	maxProcessesPerSinger: integer('max_processes_per_singer').notNull().default(3)
});

// Keyed by room, so multi-room is a row rather than a migration. `max_quality_rank` is a downward-only ceiling; NULL defers to the global default.
export const roomSettings = sqliteTable('room_settings', {
	roomId: text('room_id').primaryKey(),
	// Enum-constrained at the column, so a hand-edited DB cannot name an algorithm that does not exist.
	queueOrder: text('queue_order', { enum: ['fair', 'fcfs', 'shuffle', 'least-recently-sung', 'manual'] })
		.notNull()
		.default('fair'),
	tvProgressStyle: text('tv_progress_style', { enum: ['card', 'corner', 'edge', 'off'] })
		.notNull()
		.default('edge'),
	tvBackgroundStyle: text('tv_background_style', { enum: ['off', 'gradient', 'singer', 'solid', 'visualizer'] })
		.notNull()
		.default('off'),
	// Canonical 6-digit lowercase hex, read verbatim when the style is `solid` and as the palette's hue when it is `visualizer`. The default below is `stageHueToHex(240)`, which a migration depends on.
	tvBackgroundColor: text('tv_background_color').notNull().default('#001d31'),
	// REAL for the same reason as guide_level_default. NOT NULL default 0, so an existing room upgrades to no dim. A LIGHTNESS control, not opacity.
	tvBackgroundDim: real('tv_background_dim').notNull().default(0),
	// Kept across a switch away, so a room that tries another background does not lose the choice.
	tvVisualizer: text('tv_visualizer', { enum: ['plasma', 'starfield', 'moire', 'lissajous'] })
		.notNull()
		.default('plasma'),
	songIntroEnabled: integer('song_intro_enabled', { mode: 'boolean' }).notNull().default(true),
	songIntroMs: integer('song_intro_ms').notNull().default(2500),
	maxQualityRank: integer('max_quality_rank'),
	// Enum-constrained like tv_progress_style, so a hand-edited DB cannot smuggle in a style the renderer has no branch for.
	lyricsBall: text('lyrics_ball', { enum: ['bounce', 'steady', 'underline', 'off'] })
		.notNull()
		.default('off'),
	lyricsHighlight: text('lyrics_highlight', { enum: ['word', 'line', 'off'] })
		.notNull()
		.default('word'),
	// 40, not 0: the DISPLAY lead BT.1359's asymmetric tolerance is fitted on (`DEFAULT_LYRICS_LEAD_MS`).
	lyricsLeadMs: integer('lyrics_lead_ms').notNull().default(40),
	// `lyrics_scale_pct` is a PERCENT of the computed distance-based scale, never a size — see DEFAULT_LYRICS_SCALE_PCT.
	lyricsScalePct: integer('lyrics_scale_pct').notNull().default(100),
	lyricsFont: text('lyrics_font', { enum: ['system', 'grotesk', 'serif', 'mono'] })
		.notNull()
		.default('system'),
	lyricsCase: text('lyrics_case', { enum: ['natural', 'upper', 'lower'] })
		.notNull()
		.default('natural'),
	lyricsLinesBefore: integer('lyrics_lines_before').notNull().default(2),
	lyricsLinesAfter: integer('lyrics_lines_after').notNull().default(2),
	// REAL for the same reason as playback_state's. NOT NULL default 0, so an existing room upgrades to pure karaoke.
	guideLevelDefault: real('guide_level_default').notNull().default(0),
	// NOT NULL default false, so an existing room upgrades to every song at unity rather than silently changing levels.
	loudnessNormalization: integer('loudness_normalization', { mode: 'boolean' }).notNull().default(false),
	// Applies after the socket drops AND the last pending song leaves the queue. 0 = no grace.
	presenceGraceMinutes: integer('presence_grace_minutes').notNull().default(90),
	// NOT NULL default true: reactions ship ON, so an existing room upgrades to having them.
	tvReactions: integer('tv_reactions', { mode: 'boolean' }).notNull().default(true)
});

export const jobs = sqliteTable(
	'jobs',
	{
		id: text('id').primaryKey(),
		mediaId: text('media_id').notNull(),
		// Defaulted to '' rather than nullable, so a pre-column row reads as "no process recorded" instead of forcing a null check at every call site.
		processingId: text('processing_id').notNull().default(''),
		// NULLABLE: an internal caller imposes no cap. See docs/SERVER.md#idempotency-and-the-process-cap.
		singerId: text('singer_id'),
		jobType: text('job_type', {
			enum: ['fetch', 'stems', 'align', 'stems-upgrade', 'stems-remake', 'align-remake']
		}).notNull(),
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
	// At most ONE live job per (mediaId, jobType). PARTIAL, excluding failed/canceled, so a song can be re-processed — enforced by the DB even if a dispatch race slips past the application check.
	(t) => ({
		liveJobIdx: uniqueIndex('jobs_live_media_type_idx')
			.on(t.mediaId, t.jobType)
			.where(sql`${t.status} NOT IN ('failed', 'canceled')`)
	})
);

/** A re-separation that finished while its song was singing, held until the turn ends: the worker's `job:complete`,
 *  kept so a restart during the hold still swaps it in. Its own table, as `jobs` mirrors the wire `Job`. See
 *  docs/SERVER.md#managing-the-library ("Never a swap mid-song"). */
export const heldCompletions = sqliteTable('held_completions', {
	jobId: text('job_id').primaryKey(),
	mediaId: text('media_id').notNull(),
	message: text('message').notNull(),
	heldAt: integer('held_at').notNull()
});

/** ONE ROW PER ATTEMPT, and deliberately NOT unique on anything but `id`: a second attempt is a second row. See docs/SERVER.md#the-attempt-ledger for why it is a second table. */
export const jobAttempts = sqliteTable(
	'job_attempts',
	{
		id: text('id').primaryKey(),
		jobId: text('job_id').notNull(),
		mediaId: text('media_id').notNull(),
		processingId: text('processing_id').notNull(),
		jobType: text('job_type', {
			enum: ['fetch', 'stems', 'align', 'stems-upgrade', 'stems-remake', 'align-remake']
		}).notNull(),
		attempt: integer('attempt').notNull().default(1),
		workerId: text('worker_id'),
		// Nullable past `enqueued_at`, because each records a moment that may never arrive: a job never picked up has no start, and writing 0 would invent work.
		enqueuedAt: integer('enqueued_at').notNull(),
		assignedAt: integer('assigned_at'),
		startedAt: integer('started_at'),
		finishedAt: integer('finished_at'),
		// NULL outcome = the attempt is still in flight. At most one such row per job_id.
		outcome: text('outcome', { enum: ['ready', 'failed', 'canceled', 'abandoned'] }),
		error: text('error'),
		// Per attempt, because these resolve from operator-editable settings at dispatch and cannot be re-derived afterwards.
		engine: text('engine'),
		model: text('model'),
		backend: text('backend'),
		device: text('device'),
		threads: integer('threads'),
		asrModel: text('asr_model'),
		syncMode: text('sync_mode'),
		// Snapshotted song length, so every cost can be reported as a rate rather than raw seconds.
		audioSec: integer('audio_sec'),
		// The split the core's own clocks cannot see. One JSON column, not a table: nothing queries inside it.
		stages: text('stages'),
		// Read whole to explain one attempt, never queried inside — the same reasoning as `stages`.
		selection: text('selection'),
		// The worker's own decision trail: which text was tried, which knob was varied, and why each attempt
		// was rejected. One JSON column for the same reason as `stages` — nothing queries inside it, and it is
		// the answer to "why did this job publish THESE lyrics" weeks later, which no counter can give.
		trail: text('trail'),
		// Why an align job published no lyrics, when the worker says (`LYRICS_NOTES`), for the song page.
		lyricsNote: text('lyrics_note'),
		// The rest of the worker's boot profile, and which of it was set by hand (`attemptHandSet`).
		concurrency: integer('concurrency'),
		demucsJobs: integer('demucs_jobs'),
		asrCompute: text('asr_compute'),
		handSet: text('hand_set')
	},
	(t) => ({
		byMedia: index('job_attempts_media_idx').on(t.mediaId, t.enqueuedAt),
		byProcess: index('job_attempts_processing_idx').on(t.processingId),
		byJob: index('job_attempts_job_idx').on(t.jobId),
		byTypeFinished: index('job_attempts_type_finished_idx').on(t.jobType, t.finishedAt)
	})
);

// A party: it starts at the first turn after 6 hours with none and ends at its last turn. See docs/SERVER.md#your-night.
export const nights = sqliteTable(
	'nights',
	{
		id: text('id').primaryKey(),
		roomId: text('room_id').notNull(),
		startedAt: integer('started_at').notNull(),
		endedAt: integer('ended_at').notNull()
	},
	(t) => ({ byRoom: index('nights_room_idx').on(t.roomId, t.endedAt) })
);

// One finished, skipped or failed turn, for that singer's own recap. Never who cheered. See docs/SERVER.md#your-night.
export const performances = sqliteTable(
	'performances',
	{
		id: text('id').primaryKey(),
		roomId: text('room_id').notNull(),
		nightId: text('night_id').notNull(),
		singerId: text('singer_id').notNull(),
		// Stamped when the singer is kept, so Delete me reaches it and the 90-day guest sweep skips it.
		personId: text('person_id'),
		mediaId: text('media_id').notNull(),
		entryId: text('entry_id').notNull(),
		startedAt: integer('started_at').notNull(),
		endedAt: integer('ended_at').notNull(),
		end: text('end', { enum: ['finished', 'skipped', 'failed'] }).notNull(),
		keyShift: integer('key_shift').notNull().default(0),
		keyChanges: integer('key_changes').notNull().default(0),
		guideLevel: real('guide_level'),
		cheers: integer('cheers').notNull().default(0)
	},
	(t) => ({
		uniqEntry: uniqueIndex('performances_entry_idx').on(t.entryId),
		bySinger: index('performances_singer_idx').on(t.singerId),
		byPerson: index('performances_person_idx').on(t.personId),
		byNight: index('performances_night_idx').on(t.nightId),
		byEnded: index('performances_ended_idx').on(t.endedAt)
	})
);

// "Don't keep my nights": a singer id, or a person id once kept. Its own table, so no roster projection can carry it.
export const nightOptOuts = sqliteTable('night_opt_outs', {
	subjectId: text('subject_id').primaryKey(),
	createdAt: integer('created_at').notNull()
});

// A song someone saved to sing later, keyed on its origin so it outlives a library delete. See docs/SERVER.md#your-songs.
export const savedSongs = sqliteTable(
	'saved_songs',
	{
		id: text('id').primaryKey(),
		// A guest's saves are their singer row's; Keep me moves them to the person.
		ownerKind: text('owner_kind', { enum: ['singer', 'person'] }).notNull(),
		ownerId: text('owner_id').notNull(),
		source: text('source', { enum: ['youtube', 'local', 'spotify'] }).notNull(),
		sourceRef: text('source_ref').notNull(),
		// A snapshot, so the row still reads after the song leaves the library.
		title: text('title').notNull(),
		artist: text('artist'),
		savedAt: integer('saved_at').notNull()
	},
	(t) => ({
		uniq: uniqueIndex('saved_songs_owner_song_idx').on(t.ownerKind, t.ownerId, t.source, t.sourceRef)
	})
);

/** The sidecar's `library.playCount` stays the authoritative total and drives LRU retention; this answers WHEN, which a counter cannot and `queue_entries` cannot either, being wiped every flush. Deliberately no `singer_id`. */
export const plays = sqliteTable(
	'plays',
	{
		id: text('id').primaryKey(),
		mediaId: text('media_id').notNull(),
		// Prevents double-counting when a process completion re-emits now-playing for a song on screen.
		entryId: text('entry_id').notNull(),
		at: integer('at').notNull()
	},
	(t) => ({
		byAt: index('plays_at_idx').on(t.at),
		byMedia: index('plays_media_idx').on(t.mediaId, t.at),
		// One play per queue entry, enforced DURABLY: the in-memory dedup is not trusted alone.
		uniqEntry: uniqueIndex('plays_entry_idx').on(t.entryId)
	})
);
