// Drizzle schema — the write-behind durability layer. The hot path reads from in-memory
// authoritative state (M1-C1); this is hydrated on boot and persisted asynchronously.
// Mirrors the domain types in @encore/shared. See docs/MASTER-DESIGN.md §5.

import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
	playMode: text('play_mode', { enum: ['iframe', 'file'] }).notNull().default('iframe')
});

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
	isPlaying: integer('is_playing', { mode: 'boolean' }).notNull().default(false)
});

export const jobs = sqliteTable('jobs', {
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
	leaseExpiresAt: integer('lease_expires_at'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
});
