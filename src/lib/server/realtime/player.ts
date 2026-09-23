// Player command handling — mutate authoritative playback state and broadcast playback:state.
// play/pause/seek/restart adjust the PlaybackState; skip/next advances the current entry.

import {
	clampKeyShift,
	isTvBackgroundStyle,
	clampGuideLevel,
	hasGuidingTrack,
	type PlayerCommand,
	type QueueEntry,
	type PlaybackState,
	type ServerEvent
} from '../../contract';
import { nextPlayable, upNextAfter, isEntryReady } from '../rotation';
import { entryResolves } from '../state/store';
import { mediaFor, orderingOf, type HubDeps } from './hub';

/**
 * Per-song ephemeral reset: fields a NEW song clears to its per-room default. PlaybackState is a
 * long-lived singleton and setPlayback takes a Partial, so a reset site forgetting ONE of these
 * silently leaks the previous singer's transpose/background/guide into the next turn — named ONCE
 * here and spread at all three reset sites (song advance, play-from-idle, reconcileOnReady) so
 * adding a field is one compiler-checked edit. The two nullable fields reset to null (INHERIT the
 * room default), not a concrete value, or a room loses its permanent guide at every song boundary.
 */
const EPHEMERAL_RESET = {
	positionSec: 0,
	keyShift: 0,
	background: null,
	guideLevel: null
} as const satisfies Partial<PlaybackState>;

/**
 * Broadcasts the queue after a mutation no client command produced (skip/advance/play flip status)
 * — without it, clients keep a skipped song in `queued` until an unrelated resync corrects it. Also
 * used by media/delete.ts so there's one publisher, one broadcast SHAPE, for server-side removals.
 */
export function publishQueue(deps: HubDeps): void {
	const entries = deps.state.entries as QueueEntry[];
	deps.publish({
		type: 'queue:patch',
		patch: { rev: deps.state.rev, ops: [], entries, media: mediaFor(entries, deps) }
	});
}

/**
 * BUILD the nowplaying:changed frame — the single source of truth for "what's playing, and what's
 * next". Both fields are PROJECTIONS of authoritative state; every caller (broadcast, per-socket
 * resync) must derive them here rather than re-deriving at its own seam, or a resync could serve a
 * stale projection to one client while broadcasts carry the new one. Mirrors syncEvent (hub.ts).
 */
export function nowPlayingEvent(deps: HubDeps): Extract<ServerEvent, { type: 'nowplaying:changed' }> {
	const cur = deps.state.entries.find((e) => e.id === deps.state.playback.currentEntryId) ?? null;
	const upNext = upNextAfter(cur?.id ?? null, deps.state.entries, deps.mediaById, orderingOf(deps));
	return { type: 'nowplaying:changed', current: cur, upNext };
}

/** Emit nowplaying:changed with the current entry + the soonest-ready upNext (drives TV preload). */
export function emitNowPlaying(deps: HubDeps): void {
	const evt = nowPlayingEvent(deps);
	// Play tracking hooks in HERE because every playback transition funnels through this one emit.
	// The tracker itself dedupes, since a process finishing also re-emits this without a change.
	deps.onNowPlaying?.(evt.current ? { id: evt.current.id, mediaId: evt.current.mediaId } : null);
	deps.publish(evt);
}

/**
 * A turn BEGINS: flip to `playing`, stamp the singer sang, then re-derive ordering — in that ORDER,
 * since least-recently-sung reads the stamp as an input (stamping after the reseq would leave the
 * starting singer at the front of their own queue). Callers must still publish; each of the three
 * call sites publishes a different queue/playback/nowplaying combination.
 */
function beginSinging(deps: HubDeps, entry: QueueEntry): void {
	deps.state.applyQueueOp({ op: 'status', id: entry.id, status: 'playing' });
	deps.onSang?.(entry.singerId);
	deps.state.reorder();
}

/**
 * React to a process song becoming ready, or the current entry retired out from under playback.
 * "currentEntryId does not resolve" covers null (never started) and DANGLING (a client
 * remove/status pruned the playing entry without touching playback). Idle + playable → start it.
 * Idle + dangling + nothing playable → clear the dangling id, or auto-start stays gated forever.
 * Already playing → just re-broadcast nowplaying so the TV preloads upNext.
 */
export function reconcileOnReady(deps: HubDeps): void {
	const { state } = deps;
	// This predicate is the single source of truth for "does currentEntryId name a live entry?" —
	// entryResolves (state/store.ts) is now single
	// sourced: this removed server.ts's duplicate copy of the same check. Callers now call this
	// function unconditionally, and every branch below falls through to emitNowPlaying at the tail —
	// exactly what a "current resolves" caller needs.
	const currentResolves = entryResolves(state.entries, state.playback.currentEntryId);
	if (!currentResolves) {
		const { next } = nextPlayable(state.entries, deps.mediaById, orderingOf(deps));
		if (next) {
			beginSinging(deps, next);
			// SONG START: reset every ephemeral field via EPHEMERAL_RESET — a partial reset here
			// would leak the previous singer's settings into a song that started while idle.
			state.setPlayback({ ...EPHEMERAL_RESET, currentEntryId: next.id, isPlaying: true });
			publishQueue(deps); // the entry left `queued` — tell clients now, not on the next resync
			deps.publish({ type: 'playback:state', state: state.playback, rev: state.rev });
		} else if (state.playback.currentEntryId !== null) {
			// Dangling id, nothing playable to take over: settle to genuinely idle so the
			// auto-start gates unstick.
			state.setPlayback({ ...EPHEMERAL_RESET, currentEntryId: null, isPlaying: false });
			publishQueue(deps);
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
	// Every ephemeral field resets via EPHEMERAL_RESET — see its definition above for why the
	// nullable ones reset to null (inherit), not a concrete value.
	state.setPlayback({ ...EPHEMERAL_RESET, currentEntryId: next?.id ?? null, isPlaying: !!next });
	// Broadcast here so both callers (an explicit skip and a TV `ended`) converge immediately, but
	// only when something ACTUALLY changed — an unchanged snapshot just makes clients redo work.
	if (cur || next) publishQueue(deps);
	return next ?? null;
}

export function handlePlayerCommand(cmd: PlayerCommand, deps: HubDeps): void {
	// A malformed frame (no `cmd` object) must be dropped here, not dereferenced — same invariant
	// as the queue path.
	if (!cmd || typeof cmd !== 'object' || typeof cmd.cmd !== 'string') return;
	const { state } = deps;
	switch (cmd.cmd) {
		case 'play': {
			if (!state.playback.currentEntryId) {
				const { next } = nextPlayable(state.entries, deps.mediaById, orderingOf(deps));
				if (next) {
					beginSinging(deps, next);
					state.setPlayback({ ...EPHEMERAL_RESET, currentEntryId: next.id, isPlaying: true });
					publishQueue(deps); // it just left `queued`
					break;
				}
				// Idle + nothing playable: must NOT latch isPlaying:true onto null currentEntryId — a
				// reachable illegal state hydrate doesn't self-heal (it only clears the DANGLING case).
				state.setPlayback({ isPlaying: false });
				break;
			}
			// currentEntryId is set: resuming the loaded song.
			state.setPlayback({ isPlaying: true });
			break;
		}
		case 'pause':
			state.setPlayback({ isPlaying: false });
			break;
		case 'restart':
			// Mirrors `play`'s idle-room guard: settle stopped rather than latch (null, true), which
			// hydrate doesn't self-heal.
			state.setPlayback({ positionSec: 0, isPlaying: !!state.playback.currentEntryId });
			break;
		case 'seek':
			// cmd.positionSec is unvalidated; Math.max(0, NaN) is NaN, and NaN reaching the NOT NULL
			// position_sec column throws out of the debounced write-behind timer. Drop non-finite here too.
			if (Number.isFinite(cmd.positionSec)) state.setPlayback({ positionSec: Math.max(0, cmd.positionSec) });
			break;
		case 'skip':
			advance(deps);
			break;
		case 'key': {
			// ± key only applies to a song whose stems are ready — nothing to re-pitch before
			// separation. Clamp the absolute target to ±MAX_KEY_SHIFT; no-op otherwise.
			const cur = state.entries.find((e) => e.id === state.playback.currentEntryId);
			const media = cur && deps.mediaById.get(cur.mediaId);
			if (cur && media && isEntryReady(cur, deps.mediaById)) {
				state.setPlayback({ keyShift: clampKeyShift(cmd.semitones) });
			}
			break;
		}
		case 'background': {
			/*
			 * WHITELISTED, never trusted — reaches setPlayback, which write-behinds into SQLite.
			 * `null` is accepted explicitly (room default); anything else unrecognized is IGNORED,
			 * not rejected, so a malformed frame on this cosmetic control doesn't tear down the socket.
			 */
			if (cmd.style === null || isTvBackgroundStyle(cmd.style)) {
				state.setPlayback({ background: cmd.style });
			}
			break;
		}
		case 'guide': {
			// Gates on hasGuidingTrack, not just readiness — a song separated before the guide ref
			// existed has nothing to turn up. `null` inherits the room default; clamped rather than
			// trusted, same reason as background above (reaches setPlayback → SQLite).
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
	ended?: boolean;
	/**
	 * Which entry the TV was playing when produced. Optional for backward compat with an older TV
	 * that omits it (falls back to the legacy unconditional advance on `ended`). When present, an
	 * `ended` for an entry that's no longer currentEntryId is stale/duplicate and ignored, so one
	 * bad track can't consume the next singer's turn too.
	 */
	entryId?: string;
}

/**
 * Handle TV telemetry: the authoritative position advances on what ACTUALLY happened on screen. On
 * `ended`, advance and re-broadcast; otherwise just track position for reconnecting clients.
 */
export function handleTelemetry(t: TvTelemetry, deps: HubDeps): void {
	// Same envelope hazard as the command paths — a frame with no payload is dropped, not dereferenced.
	if (!t || typeof t !== 'object') return;
	const { state } = deps;
	// A frame naming an entry that's no longer currentEntryId is stale (duplicate send, a
	// second/reconnecting TV, or one last `ontimeupdate`) — act on NOTHING it says: `ended` must not
	// double-advance, position must not seek using the old song's playhead. No id keeps legacy behaviour.
	if (t.entryId !== undefined && t.entryId !== state.playback.currentEntryId) return;
	if (t.ended) {
		advance(deps);
		deps.publish({ type: 'playback:state', state: state.playback, rev: state.rev });
		emitNowPlaying(deps);
		return;
	}
	// Position-only: setPosition does NOT bump rev, so the ~4Hz ontimeupdate stream can't desync
	// clients' localRev into a resync storm.
	state.setPosition(t.positionSec);
}
