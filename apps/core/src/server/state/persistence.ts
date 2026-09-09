// Write-behind persistence: snapshots the authoritative queue + playback into SQLite.
// Replace-the-world per flush is fine — the queue is small (a party), and this never sits on
// the read/broadcast hot path. See ARCHITECTURE §9.

import { eq } from 'drizzle-orm';
import type { DB } from '../db/index';
import { queueEntries, playbackState } from '../db/schema';
import type { StatePersistence } from './store';
import type { QueueEntry, PlaybackState } from '@encore/shared';

// `roomId` binds this sink to ONE room (#655 playback, #656 queue). Playback state and the queue
// used to be deployment-wide — a single 'singleton' playback row and a queue table with no room —
// so two rooms could never each be playing or hold their own queue. Both are keyed by room_id now,
// so the writer names the room it snapshots: the queue replace and the playback upsert both scope to
// this room, never touching another room's rows. The single authoritative store persists to the
// active room today; threading a room per party through the realtime layer above this seam is #657.
export function sqlitePersistence(db: DB, roomId: string): StatePersistence {
	return {
		persist({ entries, playback }: { entries: QueueEntry[]; playback: PlaybackState }) {
			db.transaction((tx) => {
				// Replace-the-world, but only for THIS room (#656): a global `delete` here would wipe
				// every other room's queue on every flush. Scope the clear to room_id so a room's
				// write-behind snapshot is self-contained.
				tx.delete(queueEntries).where(eq(queueEntries.roomId, roomId)).run();
				if (entries.length) {
					tx.insert(queueEntries)
						.values(
							entries.map((e) => ({
								id: e.id,
								mediaId: e.mediaId,
								singerId: e.singerId,
								status: e.status,
								rotationSeq: e.rotationSeq,
								addedAt: e.addedAt,
								// The room this snapshot belongs to (#656). The in-memory entries carry no room —
								// the store holds one room's queue — so it is stamped from the sink's bound room here.
								roomId
							}))
						)
						.run();
				}
				tx.insert(playbackState)
					.values({
						roomId,
						currentEntryId: playback.currentEntryId,
						// The `position_sec` column is an INTEGER (db/schema.ts). Sub-second precision is kept
						// in-memory / on the wire (#718) and floored HERE, at the persistence boundary, so an
						// ordinary telemetry frame is never broadcast as an exact `0` that reads as a restart.
						positionSec: Math.floor(playback.positionSec),
						isPlaying: playback.isPlaying,
						keyShift: playback.keyShift,
						background: playback.background,
						guideLevel: playback.guideLevel
					})
					.onConflictDoUpdate({
						target: playbackState.roomId,
						set: {
							currentEntryId: playback.currentEntryId,
							positionSec: Math.floor(playback.positionSec),
							isPlaying: playback.isPlaying,
							keyShift: playback.keyShift,
							background: playback.background,
							guideLevel: playback.guideLevel
						}
					})
					.run();
			});
		}
	};
}
