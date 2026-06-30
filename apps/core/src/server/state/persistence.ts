// Write-behind persistence: snapshots the authoritative queue + playback into SQLite.
// Replace-the-world per flush is fine — the queue is small (a party), and this never sits on
// the read/broadcast hot path. See MASTER-DESIGN §7.

import type { DB } from '../db/index';
import { queueEntries, playbackState } from '../db/schema';
import type { StatePersistence } from './store';
import type { QueueEntry, PlaybackState } from '@encore/shared';

export function sqlitePersistence(db: DB): StatePersistence {
	return {
		persist({ entries, playback }: { entries: QueueEntry[]; playback: PlaybackState }) {
			db.transaction((tx) => {
				tx.delete(queueEntries).run();
				if (entries.length) {
					tx.insert(queueEntries)
						.values(
							entries.map((e) => ({
								id: e.id,
								mediaId: e.mediaId,
								singerId: e.singerId,
								status: e.status,
								rotationSeq: e.rotationSeq,
								addedAt: e.addedAt
							}))
						)
						.run();
				}
				tx.insert(playbackState)
					.values({
						id: 'singleton',
						currentEntryId: playback.currentEntryId,
						positionSec: playback.positionSec,
						isPlaying: playback.isPlaying,
						keyShift: playback.keyShift
					})
					.onConflictDoUpdate({
						target: playbackState.id,
						set: {
							currentEntryId: playback.currentEntryId,
							positionSec: playback.positionSec,
							isPlaying: playback.isPlaying,
							keyShift: playback.keyShift
						}
					})
					.run();
			});
		}
	};
}
