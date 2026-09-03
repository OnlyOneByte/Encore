// Player command handling — mutate authoritative playback state and broadcast playback:state.
// MVP scope (M3-C6): play/pause/seek/restart adjust the PlaybackState; skip/next advances the
// current entry. The full gapless player state machine (advance-on-ended, upNext preload) is M5.

import { clampKeyShift, type PlayerCommand, type ServerEvent, type QueueEntry } from '@encore/shared';
import type { AuthoritativeState } from '../state/store';
import { nextPlayable, upNextAfter, isEntryReady } from '../rotation/index';
import { mediaFor, type HubDeps } from './hub';

/**
 * Broadcast the authoritative queue after a PLAYBACK transition changed entry statuses.
 *
 * Skip/advance/play all flip entries to `done`/`playing` — a real queue mutation — but this module
 * used to publish only playback:state + nowplaying:changed. Clients therefore kept the skipped song
 * in their `queued` list until something unrelated forced a resync, which is why a skip took a
 * visible beat to disappear from the rotation. `ops: []` with the entries inline is the same shape
 * handleQueueCommand sends; the client adopts the snapshot and re-applies its pending ops on top.
 */
function publishQueue(deps: HubDeps): void {
	const entries = deps.state.entries as QueueEntry[];
	deps.publish({
		type: 'queue:patch',
		patch: { rev: deps.state.rev, ops: [], entries, media: mediaFor(entries, deps) }
	});
}

/** Emit nowplaying:changed with the current entry + the soonest-ready upNext (drives TV preload). */
export function emitNowPlaying(deps: HubDeps): void {
	const cur = deps.state.entries.find((e) => e.id === deps.state.playback.currentEntryId) ?? null;
	const upNext = upNextAfter(cur?.id ?? null, deps.state.entries, deps.mediaById);
	// Play tracking hooks in HERE because every playback transition funnels through this one emit.
	// The tracker itself dedupes, since this is also re-emitted without a change (a cook finishing
	// re-broadcasts nowplaying so the TV preloads the newly-ready song).
	deps.onNowPlaying?.(cur ? { id: cur.id, mediaId: cur.mediaId } : null);
	deps.publish({ type: 'nowplaying:changed', current: cur, upNext });
}

/**
 * React to a make-karaoke song becoming ready (M7-C6 held-slot completion). Two cases:
 *  • The room IDLED while it cooked (nothing playing) and this freshly-ready entry is now the
 *    soonest playable → start it (it slots back at its preserved fair position).
 *  • Something is already playing → just re-broadcast nowplaying so the TV preloads the now-ready
 *    song as upNext. Either way playback:state/nowplaying are re-emitted so clients converge.
 * No-op if the ready media has no queued entry (cooked ahead of being queued).
 */
export function reconcileOnReady(deps: HubDeps): void {
	const { state } = deps;
	if (!state.playback.currentEntryId) {
		const { next } = nextPlayable(state.entries, deps.mediaById);
		if (next) {
			state.applyQueueOp({ op: 'status', id: next.id, status: 'playing' });
			state.setPlayback({ currentEntryId: next.id, positionSec: 0, isPlaying: true });
			publishQueue(deps); // the entry left `queued` — tell clients now, not on the next resync
			deps.publish({ type: 'playback:state', state: state.playback, rev: state.rev });
		}
	}
	emitNowPlaying(deps);
}

/** Advance to the next playable entry (held-slot aware). Returns the new current (or null). */
function advance(deps: HubDeps): QueueEntry | null {
	const { state } = deps;
	const cur = state.playback.currentEntryId;
	if (cur) state.applyQueueOp({ op: 'status', id: cur, status: 'done' });
	const { next } = nextPlayable(state.entries, deps.mediaById);
	if (next) state.applyQueueOp({ op: 'status', id: next.id, status: 'playing' });
	// keyShift resets to 0 on every song change — a new song starts in its original key.
	state.setPlayback({ currentEntryId: next?.id ?? null, positionSec: 0, isPlaying: !!next, keyShift: 0 });
	// The statuses above are a queue mutation; broadcast it here so BOTH callers (an explicit skip and
	// a TV `ended`) converge clients immediately rather than at the next resync.
	publishQueue(deps);
	return next ?? null;
}

export function handlePlayerCommand(cmd: PlayerCommand, deps: HubDeps): void {
	const { state } = deps;
	switch (cmd.cmd) {
		case 'play': {
			// if nothing is loaded yet, start the first playable entry
			if (!state.playback.currentEntryId) {
				const { next } = nextPlayable(state.entries, deps.mediaById);
				if (next) {
					state.applyQueueOp({ op: 'status', id: next.id, status: 'playing' });
					state.setPlayback({ currentEntryId: next.id, positionSec: 0, isPlaying: true, keyShift: 0 });
					publishQueue(deps); // it just left `queued`
					break;
				}
			}
			state.setPlayback({ isPlaying: true });
			break;
		}
		case 'pause':
			state.setPlayback({ isPlaying: false });
			break;
		case 'restart':
			state.setPlayback({ positionSec: 0, isPlaying: true });
			break;
		case 'seek':
			state.setPlayback({ positionSec: Math.max(0, cmd.positionSec) });
			break;
		case 'skip':
			advance(deps);
			break;
		case 'key': {
			// ± key only applies to a make-karaoke (file) song whose stems are ready — a YouTube
			// iframe can't be re-pitched. Clamp the absolute target to ±MAX_KEY_SHIFT. No-op otherwise.
			const cur = state.entries.find((e) => e.id === state.playback.currentEntryId);
			const media = cur && deps.mediaById.get(cur.mediaId);
			if (cur && media && media.playMode === 'file' && isEntryReady(cur, deps.mediaById)) {
				state.setPlayback({ keyShift: clampKeyShift(cmd.semitones) });
			}
			break;
		}
	}
	deps.publish({ type: 'playback:state', state: state.playback, rev: state.rev });
	emitNowPlaying(deps);
}

export interface TvTelemetry {
	positionSec: number;
	durationSec: number;
	status: string;
	bufferedNextPct: number;
	ended?: boolean;
}

/**
 * Handle TV telemetry. The authoritative position advances on what ACTUALLY happened on screen
 * (docs/tv-preload-state-machine.md §5): on `ended`, advance to the next entry and re-broadcast.
 * Otherwise just track position (so reconnecting clients see roughly where we are).
 */
export function handleTelemetry(t: TvTelemetry, deps: HubDeps): void {
	const { state } = deps;
	if (t.ended) {
		advance(deps);
		deps.publish({ type: 'playback:state', state: state.playback, rev: state.rev });
		emitNowPlaying(deps);
		return;
	}
	// position-only update: ephemeral telemetry — setPosition does NOT bump rev (Finding #1), so the
	// ~4Hz ontimeupdate stream can't desync clients' localRev and trigger a spurious resync storm.
	state.setPosition(t.positionSec);
}
