// Realtime hub: command intake + broadcast, decoupled from Bun.serve via a `publish` sink so it
// unit-tests without a socket. Flow: queue:command -> validate -> apply to authoritative state ->
// broadcast queue:patch. An invalid op gets op:reject to the originator only, never a broadcast.
// See docs/ARCHITECTURE.md #authority-and-the-hub.

import type {
	ClientCommand,
	ServerEvent,
	QueueEntry,
	Media,
	PublicSinger,
	EffectiveSettings,
	Ordering,
	QueueOp
} from '../../contract';
import { singHistoryFrom } from '../../contract';
import type { AuthoritativeState } from '../state/store';
import { can } from '../capabilities';
import { queueEntries } from '../db/schema';

// queue_entries.status is the single source of truth for the entry-status VALUE LIST; its
// enumValues are read below ONLY to CLASSIFY a rejected status for the operator log, never to gate
// the add arm — that allowed set is the single literal 'queued' (see below), so the two cannot
// drift together. The column is NOT an enforcing enum at runtime — `text NOT NULL`, no CHECK constraint
// (drizzle's `enum:` is compile-time only). What write-behind persistence ACTUALLY rejects: NOT NULL alone — never an enum, never finiteness.
// A null/missing addedAt or status crashes the flush; an off-enum status string or a non-finite
// addedAt like Infinity persist SILENTLY instead. So for `status` the add-arm guard below (not the
// column) is what keeps the written value set honest; for `addedAt` the re-stamp seam does the same.
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
	/** Optional: stamp that a singer STARTED a song (feeds least-recently-sung ordering; must land
	 *  BEFORE the reseq/broadcast that follow). Separate from onNowPlaying, which is just telemetry. */
	onSang?: (singerId: string) => void;
	/** Optional: record a queue-add for popularity shortcuts. */
	recordAdd?: (mediaId: string) => void;
	/**
	 * Optional idempotency ledger, RECORD-ON-CHECK: returns whether clientOpId already applied, and
	 * records it as a side effect. Call exactly once, only on the path that actually applies the op —
	 * recording an op that never applied would falsely re-ack its resend (see hasOp).
	 */
	seenOp?: (clientOpId: string) => boolean;
	/**
	 * Optional NON-RECORDING peek at the same ledger — no side effect. Used on validation-FAILURE: a
	 * resent already-applied op must still be re-acked even though it no longer validates, but a
	 * genuinely-invalid op must NOT be written to the ledger, or its resend would falsely succeed.
	 */
	hasOp?: (clientOpId: string) => boolean;
	/**
	 * Optional: called AFTER `remove` is applied, with the removed mediaId and post-remove queue —
	 * cancels any in-flight job for that media (jobs/cancel.ts) so a worker doesn't keep processing it.
	 */
	onEntryRemoved?: (mediaId: string, remainingEntries: QueueEntry[]) => void;
	/**
	 * Optional: called AFTER `add` is applied, with the added mediaId and post-add queue — mirrors
	 * onEntryRemoved, re-prioritizing any process already in flight for that media to dispatch's front.
	 */
	onEntryAdded?: (mediaId: string, entries: QueueEntry[]) => void;
	/**
	 * The singer this socket authenticated as, resolved from the session cookie at WS upgrade —
	 * `undefined` for a socket that never joined. Queue mutations are attributable, so `add` must
	 * carry THIS id, never one the client picks, or any socket could queue songs as anybody.
	 */
	actorSingerId?: string;
}

/** Validate a command against current state. Returns an error string, or null if valid. */
export function validateCommand(cmd: ClientCommand, deps: HubDeps): string | null {
	// Validate the envelope BEFORE destructuring: a frame like {"type":"queue:command"} with no
	// `command`/`op`/`clientOpId` must fail these checks, not crash on the next property read.
	if (!cmd || typeof cmd !== 'object') return 'malformed command';
	if (!cmd.clientOpId) return 'missing clientOpId';
	if (!cmd.op || typeof cmd.op !== 'object' || typeof cmd.op.op !== 'string') return 'malformed op';
	// Identity BEFORE shape: actorSingerId (from the session, never the client) gates every
	// mutation — without this check any socket, joined or not, could mutate the queue.
	if (!deps.actorSingerId) return 'join the room first';
	const { op } = cmd;
	switch (op.op) {
		case 'add': {
			if (!op.entry?.id) return 'missing entry id';
			// singerId is NOT NULL in queue_entries; reject a missing one here rather than let the
			// persistence write throw mid-flush.
			if (!op.entry.singerId) return 'missing singerId';
			// A singerId that doesn't match this session is a bug or an impersonation attempt —
			// reject rather than silently rewrite it, which would desync the sender's optimistic copy.
			if (op.entry.singerId !== deps.actorSingerId) return 'singerId does not match this session';
			if (!deps.mediaById.has(op.entry.mediaId)) return `unknown media: ${op.entry.mediaId}`;
			// An add id colliding with a DIFFERENT live entry is rejected: applyOp overwrites in place
			// on id match, so allowing it would let one phone hijack another's turn and orphan the
			// displaced media's process (onEntryRemoved only fires on an explicit remove). Re-adding
			// the SAME identity onto a still-'queued' row is allowed on purpose (optimistic echo,
			// idempotent redelivery); onto a non-'queued' row (e.g. 'playing') it is not.
			const existing = deps.state.entries.find((e) => e.id === op.entry.id);
			if (
				existing &&
				(existing.singerId !== op.entry.singerId ||
					existing.mediaId !== op.entry.mediaId ||
					existing.status !== 'queued')
			)
				return `entry id already taken: ${op.entry.id}`;
			// Only `status` reaches the queue verbatim from the client. `addedAt` is re-stamped from
			// the room's monotonic nextAddedAt() at the seam below; `rotationSeq` is server-owned via
			// applyOp (rotation.ts). Neither is trusted from the wire.
			if (!Number.isFinite(op.entry.addedAt)) return 'invalid addedAt';
			if (op.entry.status !== 'queued') {
				// Classify for the operator log only — the add-arm's allowed set is the literal
				// 'queued' regardless of enum membership: 'playing'/'done' are real column values but
				// server-owned lifecycle states a client must never mint directly.
				const known = VALID_ENTRY_STATUSES.includes(op.entry.status);
				return `invalid status: ${String(op.entry.status)} (${known ? 'server-owned' : 'off-enum'}; a client may only add a queued entry)`;
			}
			return null;
		}
		case 'remove': {
			const removeTarget = deps.state.entries.find((e) => e.id === op.id);
			if (!removeTarget) return `unknown entry: ${op.id}`;
			// Removing your OWN entry needs no capability. `queue:remove-any` gates removing SOMEONE
			// ELSE'S entry only — can() currently grants it unconditionally, but gating every remove
			// through it would wrongly block a singer's own song once can() starts enforcing a host role.
			if (removeTarget.singerId !== deps.actorSingerId) {
				if (!can({ singerId: deps.actorSingerId }, 'queue:remove-any')) return 'not allowed to remove this entry';
			}
			return null;
		}
		case 'move': {
			const moveTarget = deps.state.entries.find((e) => e.id === op.id);
			if (!moveTarget) return `unknown entry: ${op.id}`;
			// Same ownership scope as remove above: reordering your OWN entry needs no capability;
			// `queue:reorder-any` is only the asker for SOMEONE ELSE'S entry.
			if (moveTarget.singerId !== deps.actorSingerId) {
				if (!can({ singerId: deps.actorSingerId }, 'queue:reorder-any')) return 'not allowed to reorder this entry';
			}
			return null;
		}
		case 'move-to-index': {
			const target = deps.state.entries.find((e) => e.id === op.id);
			if (!target) return `unknown entry: ${op.id}`;
			// toIdx targets a position in the WHOLE queued list, so moving ANOTHER singer's entry there
			// jumps them — gated by queue:reorder-any, same scope as `move`. Reject a non-integer toIdx
			// rather than let moveToIndex silently clamp a NaN/object to 0.
			if (!Number.isInteger(op.toIdx)) return `invalid toIdx: ${String(op.toIdx)}`;
			if (target.singerId !== deps.actorSingerId) {
				if (!can({ singerId: deps.actorSingerId }, 'queue:reorder-any')) return 'not allowed to reorder this entry';
			}
			return null;
		}
		case 'status':
			// SERVER-OWNED, never accepted from the wire — only player.ts (beginSinging/advance) calls
			// applyQueueOp directly for a status change. Admitting it from a client could forge a
			// second 'playing' entry, write an off-enum string, or retire a song whose process keeps running.
			return 'status is server-owned';
		default:
			// Unknown op: reject rather than fall out of the switch returning undefined, which the
			// caller would read as "valid".
			return `unknown op: ${String((op as { op?: unknown }).op)}`;
	}
}

/**
 * Handle one client queue command: on success, apply + broadcast queue:patch and return it; on
 * failure, send op:reject to the originator (if given) and return null.
 */
export function handleQueueCommand(
	cmd: ClientCommand,
	deps: HubDeps,
	sendToOrigin?: SendToOrigin
): Extract<ServerEvent, { type: 'queue:patch' }> | null {
	// Validate BEFORE touching any property of `cmd` — the idempotency check below reads
	// `cmd.clientOpId`, itself a crash when the frame carried no command at all.
	const err = validateCommand(cmd, deps);
	if (err) {
		// On a validation FAILURE, check the idempotency ledger BEFORE rejecting: a resent command
		// whose earlier delivery already applied now fails validation (its entry was pruned, or its
		// id already taken) — re-ack it like the already-applied branch below, rather than reject
		// something that actually succeeded.
		//
		// MUST use the NON-RECORDING `hasOp`, never `seenOp` (which records as a side effect) — using
		// seenOp here would write a genuinely-invalid, never-applied op into the ledger, and its
		// resend would then be falsely re-acked instead of rejected.
		if (cmd?.clientOpId && deps.hasOp?.(cmd.clientOpId)) {
			deps.publish({ type: 'queue:patch', patch: { rev: deps.state.rev, ops: [], causedBy: cmd.clientOpId } });
			return null;
		}
		// No clientOpId to correlate a rejection to — drop silently.
		if (cmd?.clientOpId) sendToOrigin?.({ type: 'op:reject', clientOpId: cmd.clientOpId, reason: err });
		return null;
	}

	// A resend that still validates against current state lands here — re-ack with the current rev
	// so the originator clears its pending op, without mutating state again.
	if (deps.seenOp?.(cmd.clientOpId)) {
		deps.publish({ type: 'queue:patch', patch: { rev: deps.state.rev, ops: [], causedBy: cmd.clientOpId } });
		return null;
	}

	if (cmd.op.op === 'add') deps.recordAdd?.(cmd.op.entry.mediaId); // popularity shortcut tracking

	// Capture the removed entry's media BEFORE applying — after applyAndReseq it's gone from state,
	// and cancellation needs to know which media just lost a claim.
	const removedMediaId =
		cmd.op.op === 'remove'
			? (deps.state.entries.find((e) => e.id === (cmd.op as { id: string }).id)?.mediaId ?? null)
			: null;

	// Re-stamp addedAt from the room's monotonic clock here — every queue-order policy ranks
	// singers by it, so a client-supplied stamp could jump the queue. The client's own optimistic
	// addedAt is left untouched; it's superseded by the authoritative `entries` on this patch.
	const op: QueueOp =
		cmd.op.op === 'add' ? { op: 'add', entry: { ...cmd.op.entry, addedAt: deps.state.nextAddedAt() } } : cmd.op;

	const { rev, canonicalOps, entries } = deps.state.applyQueueOp(op);

	// An explicit remove of a processing song must stop the process, not just hide the row — fired
	// AFTER applying so the hook sees the post-remove queue (it decides whether to actually cancel).
	if (removedMediaId) deps.onEntryRemoved?.(removedMediaId, entries);

	// Add-side mirror: fired AFTER applying (so `entries` carries the new row) and only on `add`, so
	// move/remove/status never re-prioritize a process. See jobs/reprioritize-process.ts.
	if (cmd.op.op === 'add') deps.onEntryAdded?.(cmd.op.entry.mediaId, entries);

	// ONE broadcast: the patch carries authoritative (pruned, reseq'd) entries + referenced media
	// inline, so clients adopt server rotationSeq without a second full queue:sync per mutation.
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
 * The room's ordering: `queueOrder` picks the algorithm, the singer roster supplies the sing
 * history `least-recently-sung` reads. Derived here (not a passed-in dep) so there is exactly one
 * place deciding "current" ordering — built via the SHARED singHistoryFrom so it matches what the
 * phone computes from the same records.
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
