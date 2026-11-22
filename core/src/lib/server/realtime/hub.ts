// Command intake + broadcast, decoupled from Bun.serve via a `publish` sink so it unit-tests without a
// socket. An invalid op gets op:reject to the originator ONLY, never a broadcast. See docs/ARCHITECTURE.md §3.

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
import { can, type Capability } from '../capabilities';
import { queueEntries } from '../db/schema';
import { entryPrefsRefusal, onDeckOpRefusal, type OnDeckOp } from './on-deck-ops';
import { heldOnDeck, stealsHeld } from '../rotation';

/** The refusal a reorder that would steal On deck gets. The phone parses it to name the singer (room.ts `onReject`), so
 *  it carries the held entry's id: keep the two in step. */
export const ON_DECK_HELD = 'on deck is held';

// queue_entries.status is the single source of truth for the entry-status VALUE LIST; its enumValues are read below ONLY to CLASSIFY
// a rejected status for the operator log, never to gate the add arm — that allowed set is the single literal 'queued'. The column is
// NOT an enforcing enum at runtime (`text NOT NULL`, no CHECK constraint; drizzle's `enum:` is compile-time only), so what
// write-behind persistence ACTUALLY rejects is NOT NULL alone — never an enum, never finiteness: an off-enum status or a non-finite
// addedAt persist SILENTLY. The add-arm guard keeps `status` honest; the nextAddedAt() re-stamp seam does the same for `addedAt`.
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
	/** Stamp that a singer STARTED a song. MUST land BEFORE the reseq/broadcast that follow. Separate
	 *  from onNowPlaying, which is only telemetry. */
	onSang?: (singerId: string) => void;
	/** Optional: record a queue-add for popularity shortcuts. */
	recordAdd?: (mediaId: string) => void;
	/** RECORD-ON-CHECK: returns whether clientOpId already applied, AND records it. Call exactly once,
	 *  only on the path that actually applies the op — recording one that never applied falsely re-acks
	 *  its resend. */
	seenOp?: (clientOpId: string) => boolean;
	/** NON-RECORDING peek at the same ledger, for the validation-FAILURE path: a resent already-applied
	 *  op must still be re-acked, but a genuinely-invalid one must NOT enter the ledger. */
	hasOp?: (clientOpId: string) => boolean;
	/** Called AFTER `remove` applies, so it sees the post-remove queue; cancels any in-flight job for
	 *  that media (jobs/cancel.ts). */
	onEntryRemoved?: (mediaId: string, remainingEntries: QueueEntry[]) => void;
	/** Mirror of onEntryRemoved: re-prioritizes any in-flight process for that media. */
	onEntryAdded?: (mediaId: string, entries: QueueEntry[]) => void;
	/** Resolved from the session cookie at WS upgrade; `undefined` for a socket that never joined. `add`
	 *  MUST carry THIS id, never one the client picks, or any socket could queue songs as anybody. */
	actorSingerId?: string;
}

/**
 * Ops that name an EXISTING entry and may be issued by a client — derived from `QueueOp` rather than listed,
 * so a new `{ id }`-bearing op joins this type automatically. `status` is excluded because it is server-owned
 * and refused outright; the on-deck ops because they are owner-only, with no `-any` capability (on-deck-ops.ts).
 */
type EntryMutatingOp = Exclude<Extract<QueueOp, { id: string }>['op'], 'status' | OnDeckOp['op']>;

/**
 * The capability each entry op asks for, and what it says when refused.
 *
 * `satisfies Record<EntryMutatingOp, …>` is the load-bearing part: a new entry-mutating op cannot COMPILE
 * without a gate here. The previous shape — one hand-written `if (!can(…))` per switch arm — could only be
 * policed by a guard grepping the three arms it knew about, so a fourth arm added with a copy-pasted
 * capability was both legal and invisible.
 */
const ENTRY_OP_GATE = {
	remove: { capability: 'queue:remove-any', refusal: 'not allowed to remove this entry' },
	move: { capability: 'queue:reorder-any', refusal: 'not allowed to reorder this entry' },
	'move-to-index': { capability: 'queue:reorder-any', refusal: 'not allowed to reorder this entry' },
	// Swapping someone's song takes their pick away exactly as a remove does, so it asks for the same thing.
	'replace-media': { capability: 'queue:remove-any', refusal: 'not allowed to change this entry' }
} as const satisfies Record<EntryMutatingOp, { capability: Capability; refusal: string }>;

/**
 * The one gate for every entry op. Order is the whole contract:
 *  1. unknown entry first, so a ghost id never reports as a permission problem;
 *  2. `toIdx` shape next — a non-integer is refused rather than silently clamped to 0 by `moveToIndex`;
 *  3. OWNERSHIP SHORT-CIRCUITS BEFORE `can()`. The `-any` capabilities mean "someone else's entry", so
 *     asking for one on your own song would refuse a singer their own turn the moment `can()` narrows to a
 *     host role. `can()` ignores its capability today, which is exactly why this cannot be caught by a test
 *     of behaviour: every capability resolves the same, so the ORDER is the only thing carrying the rule.
 *  4. ON DECK IS HELD, last, and keyed on the HELD entry's owner, not the moved one's: a reorder by anyone but Theo may
 *     not move Theo's On deck entry or land a row in front of it — Ana's own song included (proposal 14,
 *     `heldOnDeck`). Theo keeps every move he has. Removal is not a reorder and is not held.
 */
function entryOpRefusal(op: Extract<QueueOp, { op: EntryMutatingOp }>, deps: HubDeps): string | null {
	const target = deps.state.entries.find((e) => e.id === op.id);
	if (!target) return `unknown entry: ${op.id}`;
	if (op.op === 'move-to-index' && !Number.isInteger(op.toIdx)) return `invalid toIdx: ${String(op.toIdx)}`;
	if (op.op === 'replace-media') {
		if (!deps.mediaById.has(op.mediaId)) return `unknown media: ${op.mediaId}`;
		// `applyOp` would no-op anyway; refused so the phone's optimistic copy is rolled back rather than kept.
		if (target.status !== 'queued') return 'only a waiting turn can change song';
		// REQUIRED and range-checked like a preset: absent would read as "keep the dead song's key" on apply.
		if (op.keyShift === undefined) return 'missing keyShift';
		const prefs = entryPrefsRefusal({ keyShift: op.keyShift });
		if (prefs) return prefs;
	}
	if (target.singerId !== deps.actorSingerId) {
		const gate = ENTRY_OP_GATE[op.op];
		if (!can({ singerId: deps.actorSingerId }, gate.capability)) return gate.refusal;
	}
	// A replace moves no turn, as a remove does not, so the On deck hold (a guard on reorders) does not judge it:
	// Pick another keeps the singer's spot. The dead song it replaces was never On deck, since only a playable one is.
	if (op.op === 'remove' || op.op === 'replace-media') return null;
	const ordering = orderingOf(deps);
	const entries = deps.state.entries as QueueEntry[];
	const held = heldOnDeck(entries, deps.mediaById, ordering, deps.listAway?.() ?? []);
	if (held && held.singerId !== deps.actorSingerId && stealsHeld(entries, op, held, ordering))
		return `${ON_DECK_HELD}: ${held.id}`;
	return null;
}

/** Validate a command against current state. Returns an error string, or null if valid. */
export function validateCommand(cmd: ClientCommand, deps: HubDeps): string | null {
	// Envelope BEFORE destructuring: a frame with no `command`/`op`/`clientOpId` must fail here, not
	// crash on the next property read.
	if (!cmd || typeof cmd !== 'object') return 'malformed command';
	if (!cmd.clientOpId) return 'missing clientOpId';
	if (!cmd.op || typeof cmd.op !== 'object' || typeof cmd.op.op !== 'string') return 'malformed op';
	// Identity BEFORE shape: actorSingerId (from the session, never the client) gates every mutation.
	if (!deps.actorSingerId) return 'join the room first';
	const { op } = cmd;
	switch (op.op) {
		case 'add': {
			if (!op.entry?.id) return 'missing entry id';
			// singerId is NOT NULL in queue_entries: reject here rather than throw mid-flush.
			if (!op.entry.singerId) return 'missing singerId';
			// Rejected rather than silently rewritten, which would desync the sender's optimistic copy.
			if (op.entry.singerId !== deps.actorSingerId) return 'singerId does not match this session';
			// The phone parses this wording to say the song was deleted: keep in step with room.ts `onReject`/`#songGone`.
			if (!deps.mediaById.has(op.entry.mediaId)) return `unknown media: ${op.entry.mediaId}`;
			// applyOp overwrites in place on id match, so an id colliding with a DIFFERENT live entry would
			// let one phone hijack another's turn and orphan the displaced media's process. Re-adding the
			// SAME identity onto a still-'queued' row IS allowed (optimistic echo, idempotent redelivery).
			const existing = deps.state.entries.find((e) => e.id === op.entry.id);
			if (
				existing &&
				(existing.singerId !== op.entry.singerId ||
					existing.mediaId !== op.entry.mediaId ||
					existing.status !== 'queued')
			)
				return `entry id already taken: ${op.entry.id}`;
			// Only `status` reaches the queue verbatim from the client. `addedAt` is re-stamped from the
			// room's monotonic nextAddedAt() at the seam below; `rotationSeq` is server-owned via applyOp.
			if (!Number.isFinite(op.entry.addedAt)) return 'invalid addedAt';
			if (op.entry.status !== 'queued') {
				// Classify for the operator log only: 'playing'/'done' are real column values but
				// server-owned lifecycle states a client must never mint directly.
				const known = VALID_ENTRY_STATUSES.includes(op.entry.status);
				return `invalid status: ${String(op.entry.status)} (${known ? 'server-owned' : 'off-enum'}; a client may only add a queued entry)`;
			}
			return entryPrefsRefusal(op.entry);
		}
		case 'remove':
		case 'move':
		case 'move-to-index':
		case 'replace-media':
			return entryOpRefusal(op, deps);
		case 'set-entry-prefs':
		case 'not-yet':
			return onDeckOpRefusal(op, deps);
		case 'status':
			// SERVER-OWNED: only player.ts calls applyQueueOp directly for a status change. From a client it
			// could forge a second 'playing' entry, or retire a song whose process keeps running.
			return 'status is server-owned';
		default:
			// Reject rather than fall out of the switch as undefined, which the caller reads as "valid".
			return `unknown op: ${String((op as { op?: unknown }).op)}`;
	}
}

/** On success, apply + broadcast queue:patch and return it; on failure, op:reject the originator. */
export function handleQueueCommand(
	cmd: ClientCommand,
	deps: HubDeps,
	sendToOrigin?: SendToOrigin
): Extract<ServerEvent, { type: 'queue:patch' }> | null {
	// Validate BEFORE touching any property of `cmd`: the idempotency check below reads
	// `cmd.clientOpId`, itself a crash when the frame carried no command at all.
	const err = validateCommand(cmd, deps);
	if (err) {
		// Check the ledger BEFORE rejecting: a resend whose earlier delivery already applied now fails
		// validation (its entry was pruned, its id taken), and rejecting it would deny a success.
		// MUST be the NON-RECORDING `hasOp`, never `seenOp` — recording a genuinely-invalid, never-applied
		// op here would make its own resend falsely re-ack.
		if (cmd?.clientOpId && deps.hasOp?.(cmd.clientOpId)) {
			deps.publish({ type: 'queue:patch', patch: { rev: deps.state.rev, ops: [], causedBy: cmd.clientOpId } });
			return null;
		}
		// Nothing to correlate a rejection to — drop silently.
		if (cmd?.clientOpId) sendToOrigin?.({ type: 'op:reject', clientOpId: cmd.clientOpId, reason: err });
		return null;
	}

	// A resend that still validates: re-ack at the current rev so the originator clears its pending op,
	// without mutating state again.
	if (deps.seenOp?.(cmd.clientOpId)) {
		deps.publish({ type: 'queue:patch', patch: { rev: deps.state.rev, ops: [], causedBy: cmd.clientOpId } });
		return null;
	}

	if (cmd.op.op === 'add') deps.recordAdd?.(cmd.op.entry.mediaId); // popularity shortcut tracking

	// Captured BEFORE applying: afterwards it is gone from state, and cancellation needs to know which
	// media just lost a claim.
	// A replace takes the OLD song's claim away just as a remove does.
	const removedMediaId =
		cmd.op.op === 'remove' || cmd.op.op === 'replace-media'
			? (deps.state.entries.find((e) => e.id === (cmd.op as { id: string }).id)?.mediaId ?? null)
			: null;

	// Re-stamp addedAt from the room's monotonic clock: every queue-order policy ranks singers by it, so
	// a client-supplied stamp could jump the queue. `deferred` ("Not yet" spent) is server-owned the same way: a
	// client-minted one is dropped rather than trusted, and a re-add of a live id (the optimistic echo) keeps the
	// server's own value, so re-sending an add cannot buy a spent "Not yet" back.
	let op: QueueOp = cmd.op;
	if (op.op === 'add') {
		const { entry } = op;
		const deferred = deps.state.entries.find((e) => e.id === entry.id)?.deferred;
		op = { op: 'add', entry: { ...entry, deferred, addedAt: deps.state.nextAddedAt() } };
	}

	// An add lands behind a held On deck entry under every queue order (proposal 14, `insertEntry`).
	const held =
		op.op === 'add'
			? heldOnDeck(deps.state.entries as QueueEntry[], deps.mediaById, orderingOf(deps), deps.listAway?.() ?? [])
			: null;
	const { rev, canonicalOps, entries } = deps.state.applyQueueOp(op, { heldId: held?.id ?? null });

	// AFTER applying, so the hook sees the post-remove queue and can decide whether to cancel.
	if (removedMediaId) deps.onEntryRemoved?.(removedMediaId, entries);

	// AFTER applying, so `entries` carries the new row; only on `add` and `replace-media` (a new song in a turn), so
	// move/remove/status never re-prioritize a process.
	if (cmd.op.op === 'add') deps.onEntryAdded?.(cmd.op.entry.mediaId, entries);
	if (cmd.op.op === 'replace-media') deps.onEntryAdded?.(cmd.op.mediaId, entries);

	// ONE broadcast: pruned, reseq'd entries plus referenced media inline, so clients adopt server
	// rotationSeq without a second full queue:sync per mutation.
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
	return [...ids].map((id) => deps.mediaById.get(id)).filter((m): m is Media => m !== undefined);
}

/** The measured LUFS of every song the box holds. The TV's loudness median is a property of the WHOLE library, so it
 *  rides the sync as numbers instead of as every media row. Same derivation the TV used to run over its catalog. */
export function loudnessLevelsOf(media: Iterable<Media>): number[] {
	return [...media].map((m) => m.songProfile?.loudnessLufs ?? null).filter((v): v is number => typeof v === 'number');
}

/** Derived here rather than passed in, so exactly one place decides "current" ordering — via the SHARED
 *  singHistoryFrom, so it matches what the phone computes from the same records. */
export function orderingOf(deps: Pick<HubDeps, 'getSettings' | 'listSingers'>): Ordering {
	const singers = deps.listSingers?.();
	return {
		order: deps.getSettings?.().room.queueOrder,
		lastSungAt: singers ? singHistoryFrom(singers) : undefined
	};
}

/** The resync path. Carries the singers and the QUEUED songs' media so clients can render per-entry names; the rest of
 *  the library is `/api/library`'s job, and only its loudness levels ride along. */
export function syncEvent(
	state: AuthoritativeState,
	deps?: Pick<HubDeps, 'mediaById' | 'listSingers' | 'listOnline' | 'listAway' | 'getSettings'>
): Extract<ServerEvent, { type: 'queue:sync' }> {
	return {
		type: 'queue:sync',
		rev: state.rev,
		entries: state.entries as QueueEntry[],
		singers: deps?.listSingers?.(),
		media: deps ? mediaFor(state.entries, deps) : undefined,
		loudness: deps ? loudnessLevelsOf(deps.mediaById.values()) : undefined,
		online: deps?.listOnline?.(),
		away: deps?.listAway?.(),
		settings: deps?.getSettings?.()
	};
}
