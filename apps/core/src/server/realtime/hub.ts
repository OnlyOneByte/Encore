// Realtime hub — the command intake + broadcast brain. Decoupled from Bun.serve (it takes a
// `publish` sink + an optional `sendToOrigin`) so it unit-tests without a real socket.
// Flow (docs/reconciliation-contract.md §3-4): client queue:command -> validate -> apply to
// authoritative state -> broadcast queue:patch{rev,ops,causedBy,entries}. Invalid -> op:reject
// to the originator only (no broadcast).

import type {
	ClientCommand,
	ServerEvent,
	QueueEntry,
	Media,
	PublicSinger
} from '@encore/shared';
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
	/** Optional: record a queue-add for popularity shortcuts. */
	recordAdd?: (mediaId: string) => void;
	/** Optional: idempotency ledger — returns true if this clientOpId was already applied. */
	seenOp?: (clientOpId: string) => boolean;
}

/** Validate a command against current state. Returns an error string, or null if valid. */
export function validateCommand(cmd: ClientCommand, deps: HubDeps): string | null {
	const { op } = cmd;
	switch (op.op) {
		case 'add':
			if (!op.entry?.id) return 'missing entry id';
			if (!deps.mediaById.has(op.entry.mediaId)) return `unknown media: ${op.entry.mediaId}`;
			return null;
		case 'remove':
		case 'move':
		case 'status':
			if (!deps.state.entries.some((e) => e.id === op.id)) return `unknown entry: ${op.id}`;
			return null;
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
	// idempotency: a resent command (e.g. after reconnect) must not double-apply. Re-ack with the
	// current rev so the originator clears its pending op, but don't mutate state again.
	if (deps.seenOp?.(cmd.clientOpId)) {
		deps.publish({ type: 'queue:patch', patch: { rev: deps.state.rev, ops: [], causedBy: cmd.clientOpId } });
		return null;
	}

	const err = validateCommand(cmd, deps);
	if (err) {
		sendToOrigin?.({ type: 'op:reject', clientOpId: cmd.clientOpId, reason: err });
		return null;
	}

	if (cmd.op.op === 'add') deps.recordAdd?.(cmd.op.entry.mediaId); // popularity shortcut tracking
	const { rev, canonicalOps, entries } = deps.state.applyQueueOp(cmd.op);
	const patch: Extract<ServerEvent, { type: 'queue:patch' }> = {
		type: 'queue:patch',
		patch: { rev, ops: canonicalOps, causedBy: cmd.clientOpId }
	};
	// Broadcast the patch. We attach the authoritative entries snapshot via queue:sync semantics
	// so clients can adopt server-assigned rotationSeq without guessing (small payload at party scale).
	deps.publish(patch);
	deps.publish(syncEvent(deps.state, deps));
	return patch;
}

/** Full-state response for a (re)connecting client — the resync path. Includes singer + media
 *  directories (when the hub has them) so clients can render names/titles per entry. */
export function syncEvent(
	state: AuthoritativeState,
	deps?: Pick<HubDeps, 'mediaById' | 'listSingers'>
): Extract<ServerEvent, { type: 'queue:sync' }> {
	return {
		type: 'queue:sync',
		rev: state.rev,
		entries: state.entries as QueueEntry[],
		singers: deps?.listSingers?.(),
		media: deps ? [...deps.mediaById.values()] : undefined
	};
}
