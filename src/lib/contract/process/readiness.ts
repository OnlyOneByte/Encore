// Readiness — where a catalog song sits on the "can I sing this right now" axis.
//
// WHY THIS IS CONTRACT AND NOT A VIEW CONCERN. It used to be maintained by hand in two places:
// `src/lib/readiness.ts` and `src/lib/server/media/readiness.ts`. Both were pure, both imported only
// from the contract, and both carried a comment telling the reader that the other one existed and had
// to agree. A parity test asserted them equal across six media shapes, which is the clearest possible
// statement that there was one function with two copies.
//
// The justification given for the split was that the contract is "the client/server contract" and this
// is "a derived view concern". The contract tree already holds three derived view concerns
// (`presentation/song-display.ts`, `presentation/colors.ts`, `lyrics/guide-level.ts`), so that line did
// not distinguish this function from what was already here. A function whose two copies MUST agree is
// isomorphic by definition, and isomorphic is what this tree is for.
//
// Pure: no DB, no network, no clock, no DOM.

import type { Media } from '../core/types';
import { isProcessing, readyToSing } from '../queue/gates';

/**
 * Where a song sits on the readiness axis, as the CATALOG can describe it.
 *
 * Three members, and 'failed' is deliberately not one of them: nothing in a catalog Media records a
 * failure, and it should not — a dead process settles the status back to un-processed (settleStemsGate),
 * so the catalog's honest answer for a failed song is 'unacquired'. Failure is a LIVE event, which is
 * why the client widens this union for display rather than this function returning a value it can never
 * produce.
 */
export type CatalogReadiness =
	| 'ready' // stems separated and on disk — queue it and sing with no vocals, no wait
	| 'processing' // a stems job is in flight; rotation HOLDS its slot, so it is still queueable
	| 'unacquired'; // no instrumental yet, so nothing to play — a candidate to process, not a song to sing

/**
 * Classify a catalog media.
 *
 * Gate-driven: `isProcessing` reads the process gates rather than a single `stemStatus === 'queued'`
 * check, so a song mid-align (stems ready, lyrics queued) reads as processing instead of falling
 * through to unacquired.
 */
export function readinessOf(m: Media): CatalogReadiness {
	if (readyToSing(m)) return 'ready';
	if (isProcessing(m)) return 'processing';
	return 'unacquired';
}
