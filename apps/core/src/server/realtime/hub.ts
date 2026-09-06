// Realtime hub — the command intake + broadcast brain. Decoupled from Bun.serve (it takes a
// `publish` sink + an optional `sendToOrigin`) so it unit-tests without a real socket.
// Flow (docs/ARCHITECTURE.md): client queue:command -> validate -> apply to
// authoritative state -> broadcast queue:patch{rev,ops,causedBy,entries}. Invalid -> op:reject
// to the originator only (no broadcast).

import type {
	ClientCommand,
	ServerEvent,
	QueueEntry,
	Media,
	PublicSinger,
	EffectiveSettings,
	Ordering
} from '@encore/shared';
import { singHistoryFrom } from '@encore/shared';
import type { AuthoritativeState } from '../state/store';
import { can } from '../auth/capabilities';
import { queueEntries } from '../db/schema';

// The queue_entries.status column IS the single source of truth for the entry-status enum: it is
// the NOT NULL enum column an add's status is ultimately written into by the write-behind flush.
// Reading its enumValues here means the add-arm guard can never drift from the column it protects.
const VALID_ENTRY_STATUSES: readonly string[] = queueEntries.status.enumValues;

export type Publish = (event: ServerEvent) => void;
export type SendToOrigin = (event: ServerEvent) => void;

export interface HubDeps {
	state: AuthoritativeState;
	publish: Publish; // broadcast to the whole room
	/** Look up media to validate adds (e.g. reject unknown mediaId). */
	mediaById: Map<string, Media>;
	/** Optional: list known singers (sans token) for the sync directory. */
	listSingers?: () => PublicSinger[];
	/** Optional: presence snapshot (singer ids with a live socket) for the sync directory. */
	listOnline?: () => string[];
	/** Optional: singers in the room but unreachable — a locked phone, a pocket. Rendered greyed. */
	listAway?: () => string[];
	/** Optional: room-level separator settings snapshot for the sync directory. */
	getSettings?: () => EffectiveSettings;
	/** Optional: notified when the current entry CHANGES, for play tracking (retention's LRU signal). */
	onNowPlaying?: (entry: { id: string; mediaId: string } | null) => void;
	/**
	 * Optional: stamp that a singer has STARTED a song. Separate from `onNowPlaying` because it is not
	 * telemetry — it feeds the `least-recently-sung` ordering, so it must land BEFORE the reseq and
	 * broadcast that follow, whereas play tracking only has to happen eventually.
	 */
	onSang?: (singerId: string) => void;
	/** Optional: record a queue-add for popularity shortcuts. */
	recordAdd?: (mediaId: string) => void;
	/** Optional: idempotency ledger — returns true if this clientOpId was already applied. */
	seenOp?: (clientOpId: string) => boolean;
	/**
	 * Optional: called AFTER a `remove` op is applied, with the removed entry's mediaId and the
	 * post-remove queue. This is the seam that lets an explicit remove cancel a cook still in flight
	 * (jobs/cancel.ts): the queue op alone never touched the job ledger, so the phone's remove button
	 * on a cooking row removed the row while the worker kept cooking. server.ts wires this to
	 * cancelJobsForMedia; unset in the pure hub tests, which only assert queue mutation.
	 */
	onEntryRemoved?: (mediaId: string, remainingEntries: QueueEntry[]) => void;
	/**
	 * Optional: called AFTER an `add` op is applied, with the added entry's mediaId and the post-add
	 * queue. The add-side mirror of onEntryRemoved. It exists for the reconnect-starvation case
	 * (#135): a make-karaoke POST can be filed while the singer's queue add is still in flight over a
	 * reconnecting socket, so the cook lands at NO_QUEUE_PRIORITY and sorts behind the lyrics backfill
	 * forever even once the turn arrives. server.ts wires this to reprioritizeCookForMedia, which
	 * lowers the outstanding cook to the soonest waiting turn and kicks dispatch; unset in the pure
	 * hub tests, which only assert queue mutation.
	 */
	onEntryAdded?: (mediaId: string, entries: QueueEntry[]) => void;
	/**
	 * The singer this socket authenticated as, resolved from the session cookie at WS upgrade.
	 * `undefined` = a socket that never joined (a TV, a spectator, a probe). Queue mutations are
	 * attributable acts, so they require one — and an `add` must carry this id, not one the client
	 * picked, or any socket could queue songs as anybody.
	 */
	actorSingerId?: string;
}

/** Validate a command against current state. Returns an error string, or null if valid. */
export function validateCommand(cmd: ClientCommand, deps: HubDeps): string | null {
	// The ENVELOPE first. `validateCommand` used to assume a well-formed command and destructure
	// straight into `cmd.op`, while the caller read `cmd.clientOpId` even earlier — so a frame like
	// `{"type":"queue:command"}` with no `command` field at all made `cmd` undefined and took the WHOLE
	// SERVER PROCESS DOWN on the first property read. Same class as the missing-singerId crash below,
	// one layer further out: the op was validated, the thing containing it was not.
	if (!cmd || typeof cmd !== 'object') return 'malformed command';
	if (!cmd.clientOpId) return 'missing clientOpId';
	if (!cmd.op || typeof cmd.op !== 'object' || typeof cmd.op.op !== 'string') return 'malformed op';
	// Identity BEFORE shape: the socket's singerId is resolved at upgrade and was previously used only
	// to drive presence — never to authorize anything. So any socket, including one that never joined,
	// could mutate the queue, and an `add` was credited to whatever singerId the client typed.
	if (!deps.actorSingerId) return 'join the room first';
	const { op } = cmd;
	switch (op.op) {
		case 'add':
			if (!op.entry?.id) return 'missing entry id';
			// singerId is NOT NULL in queue_entries, and the persistence write happens inside the
			// state mutation — so an add without one used to throw a SQLiteError out of store.apply()
			// and take the WHOLE SERVER PROCESS DOWN, mid-party, on one malformed client message.
			// Found by driving the real server. Reject it like any other bad op.
			if (!op.entry.singerId) return 'missing singerId';
			// Rejected rather than silently overwritten: the client always sends its own id, so a
			// mismatch is a bug or an impersonation attempt. Both are worth surfacing, and rewriting
			// the op would leave the sender's optimistic copy disagreeing with the server forever.
			if (op.entry.singerId !== deps.actorSingerId) return 'singerId does not match this session';
			if (!deps.mediaById.has(op.entry.mediaId)) return `unknown media: ${op.entry.mediaId}`;
			// Shape of the CLIENT-MINTED fields that reach the queue verbatim (applyOp inserts op.entry
			// unchanged; only rotationSeq is server-owned). Both are NOT NULL enum/integer columns in
			// queue_entries, so a non-finite addedAt or an off-enum status sailed through validation, was
			// broadcast to the whole room, and then violated the column inside the debounced write-behind
			// FLUSH TIMER — taking the WHOLE SERVER PROCESS DOWN asynchronously, detached from the frame
			// that caused it. Same class as the singerId crash above and the telemetry positionSec one:
			// validated at the frame, killed at the flush. Reject at the seam so nothing bad is persisted.
			if (!Number.isFinite(op.entry.addedAt)) return 'invalid addedAt';
			if (!VALID_ENTRY_STATUSES.includes(op.entry.status)) return `invalid status: ${String(op.entry.status)}`;
			return null;
		case 'remove':
			if (!deps.state.entries.some((e) => e.id === op.id)) return `unknown entry: ${op.id}`;
			// The asker `queue:remove-any` was named for. Routed through can() rather than left to the
			// membership check above so removing someone else's turn gates with the module's ONE
			// decision — narrowing can() there now actually denies it, as capabilities.ts:9-11 promises.
			if (!can({ singerId: deps.actorSingerId }, 'queue:remove-any')) return 'not allowed to remove this entry';
			return null;
		case 'move':
			if (!deps.state.entries.some((e) => e.id === op.id)) return `unknown entry: ${op.id}`;
			// The asker `queue:reorder-any` was named for — same reasoning as remove above.
			if (!can({ singerId: deps.actorSingerId }, 'queue:reorder-any')) return 'not allowed to reorder this entry';
			return null;
		case 'status':
			// SERVER-OWNED, never accepted from the wire. The only two producers of a `status` op in the
			// whole repo are the server itself — player.ts beginSinging ('playing') and advance ('done') —
			// and BOTH call state.applyQueueOp directly, never through handleQueueCommand. So the wire arm
			// has no honest caller to serve, and admitting it let one joined phone (a) forge a second
			// 'playing' entry that is never playable, never terminal, not removable on leave and durable
			// across restarts, (b) write an off-enum string that reaches the NOT NULL enum column, and
			// (c) retire a song with a terminal status while its cook keeps running (only `remove` fires
			// onEntryRemoved). Rejecting it closes all three at the seam and is behaviour-preserving for
			// every real client. Same class as the add-arm shape guards above: validate at the frame.
			return 'status is server-owned';
		default:
			// An unknown op is a client from the future, or a probe. Reject rather than fall out of the
			// switch returning undefined, which reads as "valid" to the caller.
			return `unknown op: ${String((op as { op?: unknown }).op)}`;
	}
}

/**
 * Handle one client queue command. On success: apply + broadcast queue:patch and return it.
 * On failure: send op:reject to the originator (if a sink is given) and return null.
 */
export function handleQueueCommand(
	cmd: ClientCommand,
	deps: HubDeps,
	sendToOrigin?: SendToOrigin
): Extract<ServerEvent, { type: 'queue:patch' }> | null {
	// Validate BEFORE touching any property of `cmd`: the idempotency check below reads
	// `cmd.clientOpId`, which is itself a crash when the frame carried no command at all.
	const err = validateCommand(cmd, deps);
	if (err) {
		// Only answerable if we know which op to reject. A frame with no clientOpId is dropped silently —
		// there is nothing to correlate a rejection to, and the sender is not a client we can help.
		if (cmd?.clientOpId) sendToOrigin?.({ type: 'op:reject', clientOpId: cmd.clientOpId, reason: err });
		return null;
	}

	// idempotency: a resent command (e.g. after reconnect) must not double-apply. Re-ack with the
	// current rev so the originator clears its pending op, but don't mutate state again.
	if (deps.seenOp?.(cmd.clientOpId)) {
		deps.publish({ type: 'queue:patch', patch: { rev: deps.state.rev, ops: [], causedBy: cmd.clientOpId } });
		return null;
	}

	if (cmd.op.op === 'add') deps.recordAdd?.(cmd.op.entry.mediaId); // popularity shortcut tracking

	// Capture the removed entry's media BEFORE applying — after applyAndReseq it is gone from the
	// authoritative array, and cancellation needs to know which media just lost a claim. Looked up on
	// the pre-apply state so a remove of an already-absent id (validate rejects those) is a non-issue.
	const removedMediaId =
		cmd.op.op === 'remove'
			? (deps.state.entries.find((e) => e.id === (cmd.op as { id: string }).id)?.mediaId ?? null)
			: null;

	const { rev, canonicalOps, entries } = deps.state.applyQueueOp(cmd.op);

	// An explicit remove of a cooking song must stop the cook, not just hide the row. The hook decides
	// whether to actually cancel (it does not when another entry still needs the media — a shared
	// cook). Fired AFTER the op is applied so it sees the post-remove queue.
	if (removedMediaId) deps.onEntryRemoved?.(removedMediaId, entries);

	// The add-side mirror. A song can have a cook already in flight (filed at NO_QUEUE_PRIORITY when
	// this add was still crossing a reconnecting socket) that this newly-landed turn should pull to
	// the front of the queue. Fired AFTER the op is applied so `entries` carries the added entry, and
	// gated to `add` so a remove/move/status never re-prioritises. See jobs/reprioritize-cook.ts.
	if (cmd.op.op === 'add') deps.onEntryAdded?.(cmd.op.entry.mediaId, entries);

	// ONE broadcast (Finding #3): the patch carries the authoritative (pruned, reseq'd) entries +
	// any referenced media inline, so clients adopt server rotationSeq without a second full
	// queue:sync per mutation. The op is still included for clients that apply diffs.
	const patch: Extract<ServerEvent, { type: 'queue:patch' }> = {
		type: 'queue:patch',
		patch: { rev, ops: canonicalOps, causedBy: cmd.clientOpId, entries, media: mediaFor(entries, deps) }
	};
	deps.publish(patch);
	return patch;
}

/** Media records referenced by the given entries (so observers can render titles for others' adds). */
export function mediaFor(entries: QueueEntry[], deps: Pick<HubDeps, 'mediaById'>): Media[] {
	const ids = new Set(entries.map((e) => e.mediaId));
	return [...deps.mediaById.values()].filter((m) => ids.has(m.id));
}

/**
 * The room's ordering, assembled from deps that already exist: the `queueOrder` setting says WHICH
 * algorithm, and the singer roster carries the sing history the `least-recently-sung` one reads.
 *
 * Derived here rather than passed in as its own dep so there is exactly one place that decides what
 * the server considers the current ordering — a second source is how the server would come to pick a
 * different "next" than the queue every client is looking at. Built via the SHARED
 * `singHistoryFrom` so the map is identical to the one the phone builds from the same records.
 */
export function orderingOf(deps: Pick<HubDeps, 'getSettings' | 'listSingers'>): Ordering {
	const singers = deps.listSingers?.();
	return {
		order: deps.getSettings?.().room.queueOrder,
		lastSungAt: singers ? singHistoryFrom(singers) : undefined
	};
}

/** Full-state response for a (re)connecting client — the resync path. Includes singer + media
 *  directories (when the hub has them) so clients can render names/titles per entry. */
export function syncEvent(
	state: AuthoritativeState,
	deps?: Pick<HubDeps, 'mediaById' | 'listSingers' | 'listOnline' | 'listAway' | 'getSettings'>
): Extract<ServerEvent, { type: 'queue:sync' }> {
	return {
		type: 'queue:sync',
		rev: state.rev,
		entries: state.entries as QueueEntry[],
		singers: deps?.listSingers?.(),
		media: deps ? [...deps.mediaById.values()] : undefined,
		online: deps?.listOnline?.(),
		away: deps?.listAway?.(),
		settings: deps?.getSettings?.()
	};
}
