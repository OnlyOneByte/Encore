// Player commands: mutate authoritative playback state and broadcast playback:state.

import {
	clampKeyShift,
	isTvBackgroundStyle,
	clampGuideLevel,
	hasGuidingTrack,
	type PlayerCommand,
	type QueueEntry,
	type PlaybackState,
	type ServerEvent,
	SKIP_NOTICE_MS
} from '../../contract';
import { nextPlayable, upNextAfter, isEntryReady } from '../rotation';
import { entryResolves } from '../state/store';
import { mediaFor, orderingOf, type HubDeps } from './hub';

/**
 * Fields a NEW song clears. PlaybackState is a long-lived singleton and setPlayback takes a Partial, so
 * a reset site that forgets ONE of these leaks the previous singer's transpose/background/guide into the
 * next turn — hence named ONCE here and spread at every reset site (a start spreads it through `songStart`). The two nullable fields reset
 * to null (INHERIT the room default), not a concrete value, or a room loses its guide every song.
 */
const EPHEMERAL_RESET = {
	positionSec: 0,
	keyShift: 0,
	background: null,
	guideLevel: null
} as const satisfies Partial<PlaybackState>;

/** What a song START writes: the reset, with the singer's on-deck preset IN PLACE of its key and guide. Every
 *  start site spreads THIS, never the bare reset, or a preset applies on one path and silently not on another. */
function songStart(entry: QueueEntry): Partial<PlaybackState> {
	return { ...EPHEMERAL_RESET, keyShift: entry.keyShift ?? 0, guideLevel: entry.guideLevel ?? null };
}

/** For a mutation no client command produced (skip/advance/play): without it, clients keep a skipped
 *  song `queued` until an unrelated resync corrects it. One publisher, one broadcast SHAPE. */
export function publishQueue(deps: HubDeps): void {
	const entries = deps.state.entries as QueueEntry[];
	deps.publish({
		type: 'queue:patch',
		patch: { rev: deps.state.rev, ops: [], entries, media: mediaFor(entries, deps) }
	});
}

/** Both fields are PROJECTIONS of authoritative state, and every caller MUST derive them here rather
 *  than at its own seam, or a resync serves one client a stale projection. Mirrors syncEvent. */
export function nowPlayingEvent(deps: HubDeps): Extract<ServerEvent, { type: 'nowplaying:changed' }> {
	const cur = deps.state.entries.find((e) => e.id === deps.state.playback.currentEntryId) ?? null;
	const upNext = upNextAfter(cur?.id ?? null, deps.state.entries, deps.mediaById, orderingOf(deps));
	return { type: 'nowplaying:changed', current: cur, upNext };
}

/** Emit nowplaying:changed with the current entry + the soonest-ready upNext (drives TV preload). */
export function emitNowPlaying(deps: HubDeps): void {
	const evt = nowPlayingEvent(deps);
	// Play tracking hooks in HERE because every playback transition funnels through this one emit; the
	// tracker dedupes, since a finishing process also re-emits without a change.
	deps.onNowPlaying?.(evt.current ? { id: evt.current.id, mediaId: evt.current.mediaId } : null);
	deps.publish(evt);
}

/** Flip to `playing`, stamp the singer sang, THEN re-derive ordering: least-recently-sung reads the
 *  stamp as an input, so stamping after the reseq leaves the starting singer at their own front.
 *  Callers still publish — each of the three sites publishes a different combination. */
function beginSinging(deps: HubDeps, entry: QueueEntry): void {
	deps.state.applyQueueOp({ op: 'status', id: entry.id, status: 'playing' });
	deps.onSang?.(entry.singerId);
	deps.state.reorder();
}

/**
 * "currentEntryId does not resolve" covers null (never started) and DANGLING (a client remove/status
 * pruned the playing entry without touching playback). Idle + playable → start it. Idle + dangling +
 * nothing playable → CLEAR the dangling id, or auto-start stays gated forever.
 */
export function reconcileOnReady(deps: HubDeps): void {
	const { state } = deps;
	// `entryResolves` (state/store.ts) is the single source of truth for "does currentEntryId name a live
	// entry?". Every branch below falls through to emitNowPlaying at the tail.
	// Single-sourced there because this removed server.ts's duplicate copy of the same check, so callers
	// now call this function unconditionally rather than pre-deciding.
	const currentResolves = entryResolves(state.entries, state.playback.currentEntryId);
	if (!currentResolves) {
		const { next } = nextPlayable(state.entries, deps.mediaById, orderingOf(deps));
		if (next) {
			beginSinging(deps, next);
			// A partial reset leaks the previous singer's settings into a song that started while idle.
			state.setPlayback({ ...songStart(next), currentEntryId: next.id, isPlaying: true });
			publishQueue(deps); // the entry left `queued` — tell clients now, not on the next resync
			deps.publish({ type: 'playback:state', state: state.playback, rev: state.rev });
		} else if (state.playback.currentEntryId !== null) {
			// Dangling id, nothing playable: settle to genuinely idle so the auto-start gates unstick.
			state.setPlayback({ ...EPHEMERAL_RESET, currentEntryId: null, isPlaying: false });
			publishQueue(deps);
			deps.publish({ type: 'playback:state', state: state.playback, rev: state.rev });
		}
	}
	emitNowPlaying(deps);
}

/**
 * The song that starts after a FAILED one waits for the TV's Skipped notice to clear: the room is told whose song did
 * not play, then the next singer's card and song start together. A real pause, so every phone shows the truth and the
 * TV's watchdog does not count it, and keyed on the ROOM's state so two rooms never share one. Lifted by the TV's
 * `resume` telemetry, or by anyone's play/pause/skip, which outranks it.
 */
const heldForNotice = new WeakMap<object, { id: string; hold: number }>();
/** Numbers every hold, so a fallback timer only ever starts the hold that armed it. Keyed by entry it could not: Try
 *  again lets the SAME entry be held twice inside one fallback window, and the first timer would start the second early. */
let holdCount = 0;
/** Past the notice, how long the server waits for the TV's `resume` before starting the song itself: a TV that lost
 *  the frame (a reload, a socket drop) must not leave the room paused for good. A released hold leaves its timer to find
 *  nothing held. A TV that reconnects INSIDE the hold shows its "Now singing" card silent until this fires (at most
 *  ~2 s), because only the TV that raised the notice sends `resume`. */
export const HOLD_FALLBACK_MS = SKIP_NOTICE_MS + 2000;
/** The fallback came while NO TV was connected: the song stays paused (nobody could hear it, and no phone is told
 *  "You're up" for it) until a TV says hello, and then starts from 0 with that TV's card. */
const fallbackDue = new WeakSet<object>();

/** The held song starts: by the TV's `resume`, or by the fallback. Only the song that was held, only once. */
function startHeld(deps: HubDeps, id: string): void {
	const { state } = deps;
	if (heldForNotice.get(state)?.id !== id || state.playback.currentEntryId !== id) return;
	heldForNotice.delete(state);
	fallbackDue.delete(state);
	state.setPlayback({ isPlaying: true });
	deps.publish({ type: 'playback:state', state: state.playback, rev: state.rev });
}

/** The fallback's own rule: start the held song only where a TV can play it. Absent `tvConnected` reads as one. */
function fallBack(deps: HubDeps, hold: number): void {
	const held = heldForNotice.get(deps.state);
	if (held?.hold !== hold) return;
	if (deps.tvConnected?.() === false) fallbackDue.add(deps.state);
	else startHeld(deps, held.id);
}

/** A TV said hello. If the hold outlived its fallback with no TV to play it, this TV is the one: start it now. */
export function onTvHello(deps: HubDeps): void {
	const held = heldForNotice.get(deps.state);
	if (held && fallbackDue.has(deps.state)) startHeld(deps, held.id);
}

/** Advance to the next playable entry (held-slot aware). Returns the new current (or null). A FAILED song is not
 *  sung: its entry goes back to `queued` in the slot it already holds, and `nextPlayable` skips it from there. */
function advance(deps: HubDeps, outcome: 'done' | 'failed' = 'done'): QueueEntry | null {
	const { state } = deps;
	const cur = state.playback.currentEntryId;
	// shortcut: the failed singer keeps the `lastSungAt` stamp their start wrote, so under least-recently-sung their
	// NEXT add lands as if they had sung; un-stamp it if a room on that order reports it.
	if (cur)
		state.applyQueueOp(
			outcome === 'failed' ? { op: 'play-failed', id: cur } : { op: 'status', id: cur, status: 'done' }
		);
	const { next } = nextPlayable(state.entries, deps.mediaById, orderingOf(deps));
	if (next) beginSinging(deps, next);
	const hold = outcome === 'failed' && !!next;
	heldForNotice.delete(state);
	fallbackDue.delete(state);
	if (hold) {
		const n = ++holdCount;
		heldForNotice.set(state, { id: next.id, hold: n });
		setTimeout(() => fallBack(deps, n), HOLD_FALLBACK_MS);
	}
	state.setPlayback({
		...(next ? songStart(next) : EPHEMERAL_RESET),
		currentEntryId: next?.id ?? null,
		isPlaying: !!next && !hold
	});
	// Only when something ACTUALLY changed — an unchanged snapshot just makes clients redo work.
	if (cur || next) publishQueue(deps);
	return next ?? null;
}

export function handlePlayerCommand(cmd: PlayerCommand, deps: HubDeps, sendToOrigin?: (e: ServerEvent) => void): void {
	// A malformed frame must be dropped here, not dereferenced — same invariant as the queue path.
	if (!cmd || typeof cmd !== 'object' || typeof cmd.cmd !== 'string') return;
	const { state } = deps;
	// The same rule as telemetry's stale `ended` below, but REQUIRED rather than optional: a command for one song
	// naming a song that is no longer current (or naming none) does NOTHING, or the second of two skips takes the
	// next singer's turn, a late restart restarts their song, and a late key tap overwrites their On deck preset.
	// Only the sender hears about it.
	if (
		cmd.cmd !== 'play' &&
		cmd.cmd !== 'pause' &&
		cmd.cmd !== 'background' &&
		(typeof cmd.entryId !== 'string' || cmd.entryId !== state.playback.currentEntryId)
	) {
		sendToOrigin?.({ type: 'player:stale', cmd: cmd.cmd });
		return;
	}
	// The playing song's key and guide are its singer's (ARCHITECTURE.md §10): anyone else's change does nothing, and
	// only the sender hears why. An entry that does not resolve falls through to the no-ops below.
	if (cmd.cmd === 'key' || cmd.cmd === 'guide') {
		const cur = state.entries.find((e) => e.id === state.playback.currentEntryId);
		if (cur && cur.singerId !== deps.actorSingerId) {
			sendToOrigin?.({ type: 'player:stale', cmd: cmd.cmd, singerOnly: true });
			return;
		}
	}
	// A person took the transport, so the notice's hold is no longer the server's to lift. Key, guide and background
	// leave it: they change the song, not whether it plays.
	if (cmd.cmd === 'play' || cmd.cmd === 'pause' || cmd.cmd === 'skip' || cmd.cmd === 'restart')
		heldForNotice.delete(state);
	switch (cmd.cmd) {
		case 'play': {
			if (!state.playback.currentEntryId) {
				const { next } = nextPlayable(state.entries, deps.mediaById, orderingOf(deps));
				if (next) {
					beginSinging(deps, next);
					state.setPlayback({ ...songStart(next), currentEntryId: next.id, isPlaying: true });
					publishQueue(deps); // it just left `queued`
					break;
				}
				// Must NOT latch isPlaying:true onto a null currentEntryId: hydrate does not self-heal that
				// illegal state, only the DANGLING case.
				state.setPlayback({ isPlaying: false });
				break;
			}
			state.setPlayback({ isPlaying: true });
			break;
		}
		case 'pause':
			state.setPlayback({ isPlaying: false });
			break;
		case 'restart':
			// Mirrors `play`'s idle-room guard: settle stopped rather than latch (null, true).
			state.setPlayback({ positionSec: 0, isPlaying: !!state.playback.currentEntryId });
			break;
		case 'seek':
			// Math.max(0, NaN) is NaN, and a NaN reaching the NOT NULL position_sec column throws out of the
			// debounced write-behind timer.
			if (Number.isFinite(cmd.positionSec)) state.setPlayback({ positionSec: Math.max(0, cmd.positionSec) });
			break;
		case 'skip':
			advance(deps);
			break;
		case 'key': {
			// Only for a song whose stems are ready — nothing to re-pitch before separation. `isEntryReady`
			// resolves the media itself and is false when there is none, so no separate lookup is needed.
			const cur = state.entries.find((e) => e.id === state.playback.currentEntryId);
			if (cur && isEntryReady(cur, deps.mediaById)) {
				state.setPlayback({ keyShift: clampKeyShift(cmd.semitones) });
			}
			break;
		}
		case 'background': {
			// ALLOWLISTED, never trusted: this reaches setPlayback, which write-behinds into SQLite. An
			// unrecognized value is IGNORED rather than rejected, so a malformed cosmetic frame does not
			// tear down the socket.
			if (cmd.style === null || isTvBackgroundStyle(cmd.style)) {
				state.setPlayback({ background: cmd.style });
			}
			break;
		}
		case 'guide': {
			// Gates on hasGuidingTrack, not just readiness: a song separated before the guide ref existed
			// has nothing to turn up. Clamped, not trusted, for the same reason as background above.
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
	/** The TV could not play the song. Moves the room on like `ended`, under the same entryId rule, but keeps the turn. */
	failed?: boolean;
	/** The TV's Skipped notice has cleared: start the song a failure held. Names that song, or does nothing. */
	resume?: boolean;
	/** Optional for a position frame. REQUIRED for `ended`, which is ignored without it. When present, a frame
	 *  naming an entry that is no longer currentEntryId is stale and ignored, so one bad track cannot consume
	 *  the next singer's turn. */
	entryId?: string;
}

// Once per process: a stale TV would otherwise send one of these per song.
let warnedIdlessEnded = false;

/** The authoritative position advances on what ACTUALLY happened on screen. */
export function handleTelemetry(t: TvTelemetry, deps: HubDeps): void {
	// Same envelope hazard as the command paths.
	if (!t || typeof t !== 'object') return;
	const { state } = deps;
	// A frame naming an entry that is no longer currentEntryId is stale: act on NOTHING it says, or
	// `ended` double-advances and position seeks using the old song's playhead.
	if (t.entryId !== undefined && t.entryId !== state.playback.currentEntryId) return;
	if (t.resume) {
		if (t.entryId !== undefined) startHeld(deps, t.entryId);
		return;
	}
	if (t.ended || t.failed) {
		// Both must name the entry they are about: an id-less one would skip whoever is current.
		if (t.entryId === undefined) {
			if (!warnedIdlessEnded) {
				warnedIdlessEnded = true;
				console.warn('[telemetry] ignored an ended or failed with no entryId; is a TV running a stale page?');
			}
			return;
		}
		advance(deps, t.failed ? 'failed' : 'done');
		deps.publish({ type: 'playback:state', state: state.playback, rev: state.rev });
		emitNowPlaying(deps);
		return;
	}
	// setPosition does NOT bump rev, so the ~4Hz ontimeupdate stream cannot desync localRev into a resync storm.
	state.setPosition(t.positionSec);
}
