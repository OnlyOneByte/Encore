// Player command handling — mutate authoritative playback state and broadcast playback:state.
// play/pause/seek/restart adjust the PlaybackState; skip/next advances the current entry.

import {
	clampKeyShift,
	isTvBackgroundStyle,
	clampGuideLevel,
	hasGuidingTrack,
	type PlayerCommand,
	type ServerEvent,
	type QueueEntry
} from '@encore/shared';
import type { AuthoritativeState } from '../state/store';
import { nextPlayable, upNextAfter, isEntryReady } from '../rotation/index';
import { mediaFor, orderingOf, type HubDeps } from './hub';

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
	const upNext = upNextAfter(cur?.id ?? null, deps.state.entries, deps.mediaById, orderingOf(deps));
	// Play tracking hooks in HERE because every playback transition funnels through this one emit.
	// The tracker itself dedupes, since this is also re-emitted without a change (a cook finishing
	// re-broadcasts nowplaying so the TV preloads the newly-ready song).
	deps.onNowPlaying?.(cur ? { id: cur.id, mediaId: cur.mediaId } : null);
	deps.publish({ type: 'nowplaying:changed', current: cur, upNext });
}

/**
 * A singer's turn BEGINS: flip the entry to `playing`, stamp that this singer has now sung, and
 * re-derive the ordering.
 *
 * The three steps are one operation because their ORDER matters. Under `least-recently-sung` the
 * stamp is an input to the ordering, so stamping after the reseq would leave the singer who just
 * started at the front of the queue with their remaining picks — visibly the opposite of the rule —
 * until some unrelated mutation happened to re-derive it. `reorder()` is a true no-op (no rev bump,
 * no broadcast) under every ordering that ignores sing history, so this is safe on all four.
 *
 * Callers must still publish; this deliberately does not, because each of the three call sites
 * publishes a different combination of queue/playback/nowplaying.
 */
function beginSinging(deps: HubDeps, entry: QueueEntry): void {
	deps.state.applyQueueOp({ op: 'status', id: entry.id, status: 'playing' });
	deps.onSang?.(entry.singerId);
	deps.state.reorder();
}

/**
 * React to a make-karaoke song becoming ready (held-slot completion). Two cases:
 *  • The room IDLED while it cooked (nothing playing) and this freshly-ready entry is now the
 *    soonest playable → start it (it slots back at its preserved fair position).
 *  • Something is already playing → just re-broadcast nowplaying so the TV preloads the now-ready
 *    song as upNext. Either way playback:state/nowplaying are re-emitted so clients converge.
 * No-op if the ready media has no queued entry (cooked ahead of being queued).
 */
export function reconcileOnReady(deps: HubDeps): void {
	const { state } = deps;
	if (!state.playback.currentEntryId) {
		const { next } = nextPlayable(state.entries, deps.mediaById, orderingOf(deps));
		if (next) {
			beginSinging(deps, next);
			// A SONG START, so every ephemeral field resets here too — see advance(). keyShift was the one
			// this site forgot: a song that began this way (the room idled while it cooked, then the cook
			// finished) silently inherited the previous singer's transpose.
			state.setPlayback({
				currentEntryId: next.id,
				positionSec: 0,
				isPlaying: true,
				keyShift: 0,
				background: null,
				guideLevel: null
			});
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
	const { next } = nextPlayable(state.entries, deps.mediaById, orderingOf(deps));
	if (next) beginSinging(deps, next);
	/*
	 * Every ephemeral field resets here — a new song starts in its original key, on the room's own
	 * background rather than whatever the last singer set, and at the room's own guiding-track level.
	 *
	 * Note the two nullable ones reset to null, which is INHERIT (the room default), not to a concrete
	 * value: pinning guideLevel to 0 here would mean a room that wants a permanent faint guide loses it
	 * at every song boundary.
	 *
	 * This object is a long-lived SINGLETON: nothing rebuilds it per song, so every ephemeral field has
	 * to be named at each of the three reset sites (here, play-from-idle, and reconcileOnReady) or it
	 * silently leaks into the next singer's turn. Adding an ephemeral field means editing all three.
	 */
	state.setPlayback({
		currentEntryId: next?.id ?? null,
		positionSec: 0,
		isPlaying: !!next,
		keyShift: 0,
		background: null,
		guideLevel: null
	});
	// The statuses above are a queue mutation; broadcast it here so BOTH callers (an explicit skip and
	// a TV `ended`) converge clients immediately rather than at the next resync. Only when something
	// ACTUALLY changed: a skip in an empty room mutates nothing, and publishing an unchanged snapshot
	// just makes every client re-adopt state and re-apply its pending ops for no reason.
	if (cur || next) publishQueue(deps);
	return next ?? null;
}

export function handlePlayerCommand(cmd: PlayerCommand, deps: HubDeps): void {
	// A frame like `{"type":"player:command"}` carries no `command`, so this used to crash on the first
	// property read and exit the process. One malformed message must never end a party — same invariant
	// as the queue path, which had the same hole.
	if (!cmd || typeof cmd !== 'object' || typeof cmd.cmd !== 'string') return;
	const { state } = deps;
	switch (cmd.cmd) {
		case 'play': {
			if (!state.playback.currentEntryId) {
				const { next } = nextPlayable(state.entries, deps.mediaById, orderingOf(deps));
				if (next) {
					beginSinging(deps, next);
					state.setPlayback({
						currentEntryId: next.id,
						positionSec: 0,
						isPlaying: true,
						keyShift: 0,
						background: null,
						guideLevel: null
					});
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
			// cmd.positionSec is an unvalidated number off the wire. Math.max(0, NaN) is NaN, and NaN
			// reaching the NOT NULL position_sec column throws out of the debounced write-behind timer,
			// killing the process long after the frame. Drop a non-finite seek here (same tri-state
			// invariant setPosition already enforces for telemetry), AND make setPlayback itself refuse
			// non-finite numerics so no future caller can reintroduce the crash. A bad seek costs one
			// ignored frame; crashing costs the party.
			if (Number.isFinite(cmd.positionSec)) state.setPlayback({ positionSec: Math.max(0, cmd.positionSec) });
			break;
		case 'skip':
			advance(deps);
			break;
		case 'key': {
			// ± key only applies to a song whose stems are ready — there is nothing to re-pitch
			// before separation. Clamp the absolute target to ±MAX_KEY_SHIFT. No-op otherwise.
			const cur = state.entries.find((e) => e.id === state.playback.currentEntryId);
			const media = cur && deps.mediaById.get(cur.mediaId);
			if (cur && media && isEntryReady(cur, deps.mediaById)) {
				state.setPlayback({ keyShift: clampKeyShift(cmd.semitones) });
			}
			break;
		}
		case 'background': {
			/*
			 * WHITELISTED, never trusted. This value reaches setPlayback, which write-behinds straight
			 * into SQLite, and the two process-kills this codebase has had both came from an unvalidated
			 * value reaching that flush. `null` is a legitimate value (hand the song back to the room
			 * default), so it is accepted explicitly rather than falling through as "absent".
			 *
			 * Anything else — an unknown id, a number, an object — is IGNORED rather than rejected: this
			 * is a cosmetic party control, so a malformed frame should leave the stage exactly as it was,
			 * not tear down the socket.
			 */
			if (cmd.style === null || isTvBackgroundStyle(cmd.style)) {
				state.setPlayback({ background: cmd.style });
			}
			break;
		}
		case 'guide': {
			// The guiding track needs an actual vocals stem to mix, so this gates on hasGuidingTrack
			// rather than just readiness: a song separated before the ref was persisted, or one whose
			// vocals came back silent, has nothing to turn up. No-op there — silently accepting would
			// pin a level the TV cannot honour and leave the phone showing a lie.
			//
			// `null` is a legitimate value here too (hand the song back to the room default), and it is
			// clamped rather than trusted for the same reason the background style is whitelisted: this
			// reaches setPlayback, which write-behinds straight into SQLite.
			const cur = state.entries.find((e) => e.id === state.playback.currentEntryId);
			const media = cur && deps.mediaById.get(cur.mediaId);
			if (cur && media && hasGuidingTrack(media)) {
				state.setPlayback({ guideLevel: clampGuideLevel(cmd.level) });
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
	/**
	 * Which entry the TV was playing when this frame was produced. Optional for backward
	 * compatibility with an older TV that omits it — when absent, `ended` keeps the legacy
	 * unconditional advance. When present, an `ended` for an entry that is no longer
	 * `state.playback.currentEntryId` is a stale/duplicate frame (a double send, a second TV,
	 * or a reconnecting TV replaying its last frame) and is ignored, so one bad track can no
	 * longer consume the next singer's turn as well (#70).
	 */
	entryId?: string;
}

/**
 * Handle TV telemetry. The authoritative position advances on what ACTUALLY happened on screen
 * (docs/ARCHITECTURE.md): on `ended`, advance to the next entry and re-broadcast.
 * Otherwise just track position (so reconnecting clients see roughly where we are).
 */
export function handleTelemetry(t: TvTelemetry, deps: HubDeps): void {
	// Same envelope hazard as the command paths: a `tv:telemetry` frame with no payload must be dropped,
	// not dereferenced.
	if (!t || typeof t !== 'object') return;
	const { state } = deps;
	if (t.ended) {
		// Advance ONLY when this `ended` is for the entry we are currently playing. A frame that
		// names a stale entry (or a duplicate for the one that already ended) would otherwise
		// advance a SECOND time and skip the next singer's turn without playing it (#70). A frame
		// with no id keeps the legacy behaviour so an older TV still advances.
		if (t.entryId !== undefined && t.entryId !== state.playback.currentEntryId) return;
		advance(deps);
		deps.publish({ type: 'playback:state', state: state.playback, rev: state.rev });
		emitNowPlaying(deps);
		return;
	}
	// position-only update: ephemeral telemetry — setPosition does NOT bump rev (Finding #1), so the
	// ~4Hz ontimeupdate stream can't desync clients' localRev and trigger a spurious resync storm.
	state.setPosition(t.positionSec);
}
