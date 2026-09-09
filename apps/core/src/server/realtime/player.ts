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
} from '@encore/shared';
import { nextPlayable, upNextAfter, isEntryReady } from '../rotation/index';
import { mediaFor, orderingOf, type HubDeps } from './hub';

/**
 * The per-song ephemeral reset — the fields that a NEW song start clears back to their per-room
 * default. PlaybackState is a long-lived singleton (nothing rebuilds it per song), and setPlayback
 * takes a Partial, so a reset object that names three of these four is not a type error: it silently
 * leaks the previous singer's transpose/background/guide into the next turn. That exact defect
 * shipped once already (keyShift was missing from reconcileOnReady across 87bce9e..6273ee9). Naming
 * the set ONCE here, spread at every reset site, is what makes "add an ephemeral field" a single
 * edit that the compiler then propagates to all of them. Only currentEntryId and isPlaying differ
 * per site, so they stay inline. The two nullable fields reset to null = INHERIT the room default
 * (not a concrete value): pinning guideLevel to 0 would rob a room of a permanent faint guide at
 * every song boundary. `satisfies` keeps this checked against PlaybackState without widening the
 * literal's type.
 */
const EPHEMERAL_RESET = {
	positionSec: 0,
	keyShift: 0,
	background: null,
	guideLevel: null
} as const satisfies Partial<PlaybackState>;

/**
 * Broadcast the authoritative queue after a mutation that no client command produced.
 *
 * Skip/advance/play all flip entries to `done`/`playing` — a real queue mutation — but this module
 * used to publish only playback:state + nowplaying:changed. Clients therefore kept the skipped song
 * in their `queued` list until something unrelated forced a resync, which is why a skip took a
 * visible beat to disappear from the rotation. `ops: []` with the entries inline is the same shape
 * handleQueueCommand sends; the client adopts the snapshot and re-applies its pending ops on top.
 *
 * Exported (#762) for `media/delete.ts`, the other server-side path that removes entries nobody asked
 * to remove. It had the same defect for the same reason — `applyQueueOp` publishes nothing — and closing
 * it by open-coding a second `queue:patch` there would have made this repo's fourth hand-written copy
 * of one broadcast. One publisher; the SHAPE of a queue broadcast is decided here.
 */
export function publishQueue(deps: HubDeps): void {
	const entries = deps.state.entries as QueueEntry[];
	deps.publish({
		type: 'queue:patch',
		patch: { rev: deps.state.rev, ops: [], entries, media: mediaFor(entries, deps) }
	});
}

/**
 * BUILD the nowplaying:changed frame — the single source of truth for "what is playing, and what is
 * up next". Both the current entry and `upNext` are PROJECTIONS of authoritative state, so anything
 * that has to state them (a broadcast, a per-socket resync) must derive them here rather than
 * re-deriving them at its own seam.
 *
 * This exists because the `hello` resync in apps/core/server.ts used to hand-build a byte-identical
 * copy of this payload (issue #803). `deps.publish` is typed `(event: ServerEvent) => void`, but the
 * resync path writes through `ws.send(JSON.stringify(...))`, which accepts anything — so the compiler
 * named only ONE of the two sites when the variant changed, and a reconnecting TV/phone could be
 * served a stale projection while every live client got the new one. Returning the typed variant
 * makes both sites compiler-checked from one definition. Mirrors `syncEvent` (hub.ts), the queue:sync
 * builder the same `hello` arm already calls two lines above.
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
	// The tracker itself dedupes, since this is also re-emitted without a change (a cook finishing
	// re-broadcasts nowplaying so the TV preloads the newly-ready song).
	deps.onNowPlaying?.(evt.current ? { id: evt.current.id, mediaId: evt.current.mediaId } : null);
	deps.publish(evt);
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
 * React to a make-karaoke song becoming ready (held-slot completion) OR to the current entry being
 * retired out from under playback. Three cases, all keyed on "currentEntryId does not resolve to a
 * live entry" — the room is effectively idle whether the id is null (never started, or advanced to
 * null) or DANGLING (a client `remove`/`status` pruned the playing entry without touching playback,
 * issue #128):
 *  • Idle and a freshly-ready/queued entry is now the soonest playable → start it (it slots back at
 *    its preserved fair position). A dangling id is overwritten by the new current here.
 *  • Idle with a dangling id and nothing playable left → clear the dangling id so the room reads as
 *    genuinely idle (isPlaying false, current null). Without this the `!currentEntryId` auto-start
 *    gates elsewhere stay false forever and the rotation never advances.
 *  • Something is already playing (current resolves) → just re-broadcast nowplaying so the TV
 *    preloads the now-ready song as upNext. Either way playback:state/nowplaying are re-emitted so
 *    clients converge.
 */
export function reconcileOnReady(deps: HubDeps): void {
	const { state } = deps;
	// The invariant "currentEntryId resolves to a live entry" used to rest on every playback path
	// pairing a terminal status op with a setPlayback; the client-driven queue path (hub.ts) has no
	// such pairing, so a remove/status of the PLAYING entry leaves currentEntryId dangling. Enforce it
	// here, at the recovery entry point, by treating a dangling id exactly like a null one.
	//
	// #803: this is the SOLE production statement of the #128 recovery predicate. server.ts's
	// queue:command arm used to re-derive it to decide whether to call this function at all, so
	// widening the predicate at one copy and not the other was silent (the suite could not see the
	// two disagree) while the correct two-site edit red two guards. Callers now call unconditionally
	// and this decides — every branch below falls through to the emitNowPlaying at the tail, which is
	// exactly what a "current resolves, nothing to recover" caller needs.
	const currentResolves = state.entries.some((e) => e.id === state.playback.currentEntryId);
	if (!currentResolves) {
		const { next } = nextPlayable(state.entries, deps.mediaById, orderingOf(deps));
		if (next) {
			beginSinging(deps, next);
			// A SONG START: reset every ephemeral field (EPHEMERAL_RESET). keyShift was historically the
			// one THIS site forgot — a song that began this way (the room idled while it cooked, then the
			// cook finished) silently inherited the previous singer's transpose; the shared const closes it.
			state.setPlayback({ ...EPHEMERAL_RESET, currentEntryId: next.id, isPlaying: true });
			publishQueue(deps); // the entry left `queued` — tell clients now, not on the next resync
			deps.publish({ type: 'playback:state', state: state.playback, rev: state.rev });
		} else if (state.playback.currentEntryId !== null) {
			// Dangling id with nothing playable to take over: the playing song was pruned and no other
			// entry is ready. Settle playback to genuinely idle so the auto-start gates unstick.
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
	/*
	 * Every ephemeral field resets here — a new song starts in its original key, on the room's own
	 * background rather than whatever the last singer set, and at the room's own guiding-track level.
	 *
	 * Note the two nullable ones reset to null, which is INHERIT (the room default), not to a concrete
	 * value: pinning guideLevel to 0 here would mean a room that wants a permanent faint guide loses it
	 * at every song boundary.
	 *
	 * The reset set lives in ONE place now: EPHEMERAL_RESET, spread at each site. Adding an ephemeral
	 * field means editing that const once; the compiler propagates it to every reset site.
	 */
	state.setPlayback({ ...EPHEMERAL_RESET, currentEntryId: next?.id ?? null, isPlaying: !!next });
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
					state.setPlayback({ ...EPHEMERAL_RESET, currentEntryId: next.id, isPlaying: true });
					publishQueue(deps); // it just left `queued`
					break;
				}
				// Idle room, nothing playable: `play` must NOT latch isPlaying:true onto a null
				// currentEntryId — that is a reachable illegal state (the phone shows a pause icon in an
				// idle room until one tap clears it) that store hydrate does not self-heal (it only clears
				// the DANGLING non-null case). There is nothing to play, so stay stopped.
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
			// Mirror `play`'s idle-room guard onto its sibling branch: there is nothing to restart when
			// no song is loaded, so a `restart` on a null currentEntryId must settle stopped rather than
			// latch the (currentEntryId, isPlaying) === (null, true) illegal state that store hydrate does
			// not self-heal (it only clears the DANGLING non-null case). A loaded song still restarts to
			// (positionSec: 0, isPlaying: true) unchanged.
			state.setPlayback({ positionSec: 0, isPlaying: !!state.playback.currentEntryId });
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
	// A frame that names an entry which is no longer `currentEntryId` is stale — a duplicate send,
	// a second/reconnecting TV replaying its last frame, or (the position case, #125) the outgoing
	// song's `<audio>` firing one more `ontimeupdate` across the round-trip + slot swap of an advance.
	// Whatever it reports, act on NOTHING it says: the `ended` branch must not advance a second time
	// and skip the next singer's turn (#70), and the position branch must not write the previous
	// song's playhead as the new entry's position — which is fed back to the TV as a seek target and
	// starts the incoming singer mid-song (#125). A frame with no id keeps the legacy behaviour so an
	// older TV that stamps no entry id is unaffected on both paths.
	if (t.entryId !== undefined && t.entryId !== state.playback.currentEntryId) return;
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
