// The TV's clock, relayed to the room's copies (`tv:clock`) and the ping a copy times its offset with (`tv:pong`).
// See docs/SERVER.md#the-tv-clock-relay.

import type { PlaybackState, ServerEvent } from '../../contract';

/** Core's clock for both frames: monotonic, in wall-clock ms. */
export const serverNow = (): number => performance.timeOrigin + performance.now();

/** The relay frame for one SEATED position report, or null when there is nothing a copy should follow. */
export function clockFrame(
	t: { status: string; positionSec: number; entryId?: string },
	playback: Pick<PlaybackState, 'currentEntryId' | 'isPlaying'>,
	serverAt: number
): Extract<ServerEvent, { type: 'tv:clock' }> | null {
	if (t.status !== 'playing' || !playback.isPlaying) return null;
	if (typeof t.positionSec !== 'number' || !Number.isFinite(t.positionSec) || t.positionSec < 0) return null;
	if (!t.entryId || t.entryId !== playback.currentEntryId) return null;
	return { type: 'tv:clock', entryId: t.entryId, positionSec: t.positionSec, serverAt };
}

/** The answer to a `tv:ping`, or null for a malformed one. */
export function pongFrame(t0: unknown, serverAt: number): Extract<ServerEvent, { type: 'tv:pong' }> | null {
	if (typeof t0 !== 'number' || !Number.isFinite(t0)) return null;
	return { type: 'tv:pong', t0, serverAt };
}
