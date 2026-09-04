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
			return null;
		case 'remove':
		case 'move':
		case 'status':
			if (!deps.state.entries.some((e) => e.id === op.id)) return `unknown entry: ${op.id}`;
			return null;
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
	const { rev, canonicalOps, entries } = deps.state.applyQueueOp(cmd.op);
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
