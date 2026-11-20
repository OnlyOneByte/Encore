// Write-behind persistence: snapshots the authoritative queue + playback into SQLite. Replace-the-world per flush is fine — the queue is small (a party), and this never sits on the read/broadcast hot path. See ARCHITECTURE §9.

import { eq } from 'drizzle-orm';
import type { DB } from '../db/index';
import { queueEntries, playbackState } from '../db/schema';
import type { StatePersistence } from './store';
import type { QueueEntry, PlaybackState } from '../../contract';

// `roomId` binds this sink to ONE room: both tables are keyed by room_id, so the queue replace and the playback upsert scope to this room and never touch another room's rows.
export function sqlitePersistence(db: DB, roomId: string): StatePersistence {
	return {
		persist({ entries, playback }: { entries: QueueEntry[]; playback: PlaybackState }) {
			db.transaction((tx) => {
				// Replace-the-world, but only for THIS room — an unscoped delete would wipe every other room's queue on every flush.
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
								keyShift: e.keyShift ?? 0,
								guideLevel: e.guideLevel ?? null,
								deferred: e.deferred ?? false,
								roomId // stamped from the sink's bound room — in-memory entries carry no room field
							}))
						)
						.run();
				}
				// Named ONCE and reused as both the insert and the conflict update, so the two cannot drift —
				// a `Math.floor` written twice is a floor that can be dropped from one of them.
				const row = {
					currentEntryId: playback.currentEntryId,
					// `position_sec` is an INTEGER column; sub-second precision lives in-memory/on the wire and is floored HERE, at the persistence boundary, so a telemetry frame is never broadcast as an exact `0` that guide-sync.ts reads as a restart.
					positionSec: Math.floor(playback.positionSec),
					isPlaying: playback.isPlaying,
					keyShift: playback.keyShift,
					background: playback.background,
					guideLevel: playback.guideLevel
				};
				tx.insert(playbackState)
					.values({ roomId, ...row })
					.onConflictDoUpdate({ target: playbackState.roomId, set: row })
					.run();
			});
		}
	};
}
