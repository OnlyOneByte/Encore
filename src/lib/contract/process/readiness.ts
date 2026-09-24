// Where a catalog song sits on the "can I sing this right now" axis. PURE. In the shared contract because
// server and client MUST agree, and a function whose copies must agree is ONE function.

import type { Media } from '../core/types';
import { isProcessing, readyToSing } from '../queue/gates';

/**
 * `failed` is deliberately NOT a member: nothing in a catalog `Media` records a failure, because a dead
 * process settles the status back to un-processed, so the honest answer is `unacquired`. Failure is a LIVE
 * event, which is why the client widens this union for display.
 */
export type CatalogReadiness =
	| 'ready' // stems separated and on disk — queue it and sing with no vocals, no wait
	| 'processing' // a stems job is in flight; rotation HOLDS its slot, so it is still queueable
	| 'unacquired'; // no instrumental yet, so nothing to play — a candidate to process, not a song to sing

/** GATE-DRIVEN, so a song mid-align reads as processing rather than falling through to unacquired. */
export function readinessOf(m: Media): CatalogReadiness {
	if (readyToSing(m)) return 'ready';
	if (isProcessing(m)) return 'processing';
	return 'unacquired';
}
