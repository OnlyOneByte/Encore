// Make-karaoke request orchestrator (M7-C6) — the entry point for "strip the vocals from this song."
// Flips the media into a COOKING file (playMode:file + stemStatus:queued) so the rotation engine
// automatically HOLDS its slot (rotation/isEntryReady returns false for a file whose stems aren't
// ready), then enqueues a stems job at the priority of the soonest queue entry that needs it.
// The phone "make karaoke" button (M7-C7) calls this; the worker pipeline (M7-C3/C4/C5) does the
// work; worker-hub flips the media to ready on completion. See MASTER-DESIGN §4, §6.

import type { Job, Media, QueueEntry } from '@encore/shared';
import type { JobRepository } from './repository';
import type { AuthoritativeState } from '../state/store';

export interface MakeKaraokeDeps {
	jobs: JobRepository;
	mediaById: Map<string, Media>;
	state: AuthoritativeState;
	now: () => number;
}

// A media never queued yet still gets cooked, just at the back of the priority order.
const NO_QUEUE_PRIORITY = Number.MAX_SAFE_INTEGER;

/**
 * The deterministic /media key (Media.sourceRef) for a media's instrumental stem. MUST match the
 * worker's output location (apps/worker/src/processor.py instrumental_path → <media_dir>/stems/
 * <mediaId>-instrumental.wav), since the TV's file player resolves `/media/${sourceRef}`.
 */
export function instrumentalKey(mediaId: string): string {
	return `stems/${mediaId}-instrumental.wav`;
}

/** The soonest (lowest) rotationSeq among queued entries that point at this media; ∞ if none. */
export function soonestSeqFor(mediaId: string, entries: QueueEntry[]): number {
	let min = NO_QUEUE_PRIORITY;
	for (const e of entries) {
		if (e.mediaId === mediaId && e.status === 'queued' && e.rotationSeq < min) min = e.rotationSeq;
	}
	return min;
}

/**
 * Request stem-separation for a media. Idempotent: a repeat request (or two singers queueing the
 * same song) dedupes to the SAME job (repository.enqueue reuses the live one). Returns the job, or
 * null if the media is unknown OR is the one currently playing (don't yank an active video out from
 * under the room — request make-karaoke for a song before it plays).
 */
export function requestMakeKaraoke(mediaId: string, deps: MakeKaraokeDeps): Job | null {
	const media = deps.mediaById.get(mediaId);
	if (!media) return null;

	const current = deps.state.entries.find((e) => e.id === deps.state.playback.currentEntryId);
	if (current && current.mediaId === mediaId) return null; // would disrupt the live song

	// Flip to cooking: a file whose stems aren't ready → rotation holds its slot until ready.
	media.playMode = 'file';
	media.stemStatus = 'queued';

	const priority = soonestSeqFor(mediaId, deps.state.entries);
	return deps.jobs.enqueue(mediaId, 'stems', priority, deps.now());
}

/**
 * Flip a media to READY after its stems job completes: point it at the instrumental file and mark
 * stems ready, so rotation's isEntryReady unblocks the held entry and the TV file player serves the
 * backing track. Returns true if the media existed and was flipped. (worker-hub calls this.)
 */
export function markMediaReady(mediaId: string, mediaById: Map<string, Media>): boolean {
	const media = mediaById.get(mediaId);
	if (!media) return false;
	media.playMode = 'file';
	media.sourceRef = instrumentalKey(mediaId);
	media.stemStatus = 'ready';
	return true;
}
