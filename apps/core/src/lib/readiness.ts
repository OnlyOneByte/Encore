// Client-side mirror of the server's readiness axis (src/server/media/readiness.ts). Duplicated
// rather than imported because @encore/shared is the client/server contract and this is a derived
// view concern — but the classification MUST agree with the server's, so it is unit-tested here too.
import type { Media, MediaStatus } from '@encore/shared';

export type Readiness = 'ready' | 'cooking' | 'raw';

export function readinessOf(m: Media): Readiness {
	if (m.playMode === 'file' && m.stemStatus === 'ready') return 'ready';
	if (m.playMode === 'file' && m.stemStatus === 'queued') return 'cooking';
	return 'raw';
}

/**
 * Readiness for display, letting a LIVE media:status override the catalog. A `media:status` arrives
 * before the catalog copy is refreshed, so a song the singer just tapped "✨ Karaoke" on must read as
 * cooking immediately — otherwise the row visibly fails to respond to the tap.
 */
export function displayReadiness(m: Media, live?: { status: MediaStatus }): Readiness {
	if (live) {
		if (live.status === 'ready') return 'ready';
		if (live.status !== 'failed') return 'cooking';
	}
	return readinessOf(m);
}

/** Whether offering "make karaoke" makes sense: only for a song that is neither done nor in flight. */
export function canCook(r: Readiness): boolean {
	return r === 'raw';
}
