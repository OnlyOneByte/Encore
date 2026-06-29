// Player command handling — mutate authoritative playback state and broadcast playback:state.
// MVP scope (M3-C6): play/pause/seek/restart adjust the PlaybackState; skip/next advances the
// current entry. The full gapless player state machine (advance-on-ended, upNext preload) is M5.

import type { PlayerCommand, ServerEvent } from '@encore/shared';
import type { AuthoritativeState } from '../state/store';
import { nextPlayable } from '../rotation/index';
import type { HubDeps } from './hub';

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
		case 'skip': {
			// mark current done, advance to next playable (held-slot aware)
			const cur = state.playback.currentEntryId;
			if (cur) state.applyQueueOp({ op: 'status', id: cur, status: 'done' });
			const { next } = nextPlayable(state.entries, deps.mediaById);
			state.setPlayback({ currentEntryId: next?.id ?? null, positionSec: 0, isPlaying: !!next });
			break;
		}
	}
	deps.publish({ type: 'playback:state', state: state.playback, rev: state.rev });
}
