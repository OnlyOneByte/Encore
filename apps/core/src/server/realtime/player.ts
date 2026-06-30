// Player command handling — mutate authoritative playback state and broadcast playback:state.
// MVP scope (M3-C6): play/pause/seek/restart adjust the PlaybackState; skip/next advances the
// current entry. The full gapless player state machine (advance-on-ended, upNext preload) is M5.

import type { PlayerCommand, ServerEvent, QueueEntry } from '@encore/shared';
import type { AuthoritativeState } from '../state/store';
import { nextPlayable, upNextAfter } from '../rotation/index';
import type { HubDeps } from './hub';

/** Emit nowplaying:changed with the current entry + the soonest-ready upNext (drives TV preload). */
export function emitNowPlaying(deps: HubDeps): void {
	const cur = deps.state.entries.find((e) => e.id === deps.state.playback.currentEntryId) ?? null;
	const upNext = upNextAfter(cur?.id ?? null, deps.state.entries, deps.mediaById);
	deps.publish({ type: 'nowplaying:changed', current: cur, upNext });
}

/** Advance to the next playable entry (held-slot aware). Returns the new current (or null). */
function advance(deps: HubDeps): QueueEntry | null {
	const { state } = deps;
	const cur = state.playback.currentEntryId;
	if (cur) state.applyQueueOp({ op: 'status', id: cur, status: 'done' });
	const { next } = nextPlayable(state.entries, deps.mediaById);
	if (next) state.applyQueueOp({ op: 'status', id: next.id, status: 'playing' });
	state.setPlayback({ currentEntryId: next?.id ?? null, positionSec: 0, isPlaying: !!next });
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
					state.setPlayback({ currentEntryId: next.id, positionSec: 0, isPlaying: true });
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
