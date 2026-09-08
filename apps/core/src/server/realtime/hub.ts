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
	Ordering,
	QueueOp
} from '@encore/shared';
import { singHistoryFrom } from '@encore/shared';
import type { AuthoritativeState } from '../state/store';
import { can } from '../auth/capabilities';
import { queueEntries } from '../db/schema';

// The queue_entries.status column is the single source of truth for the entry-status VALUE LIST:
// its enumValues are read below ONLY to CLASSIFY a rejected status for the operator log (a value the
// column knows vs one it does not). Since #324 they do NOT define what the add arm allows — that
// allowed set is the single literal 'queued' (see the guard below), so the two cannot drift together.
// It is NOT an enforcing enum at runtime — the column is `text ... NOT NULL` with no
// CHECK constraint (drizzle's `enum:` is compile-time only), so SQLite will happily persist an
// off-enum string. Only an explicit null violates anything at the flush. That is precisely why the
// add-arm guard below (not the column) is what keeps the written value set honest.
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
	/**
	 * Optional: idempotency ledger, RECORD-ON-CHECK — returns true if this clientOpId was already
	 * applied, and otherwise RECORDS it as a side effect. Call it exactly once, and only on the path
	 * that actually applies the op — recording an op that never applied poisons the ledger, so a
	 * later resend of it would be falsely re-acked (see hasOp).
	 */
	seenOp?: (clientOpId: string) => boolean;
	/**
	 * Optional: NON-RECORDING peek at the same idempotency ledger — returns true if this clientOpId
	 * was already applied, with NO side effect. Used on the validation-FAILURE path (#490): a resent
	 * already-applied op whose shape no longer validates must be re-acked, but a genuinely-invalid
	 * never-applied op that fails validation must NOT be written to the ledger (its resend must still
	 * reject, every time). Reading with a recording seenOp there would insert the failing op's id and
	 * turn its resend into a false success. server.ts backs this with `seenOps.has(id)`.
	 */
	hasOp?: (clientOpId: string) => boolean;
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
		case 'add': {
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
			// An add whose id is already held by a DIFFERENT entry overwrites it: applyOp's add arm
			// updates-in-place on id match (its in-place branch is for the originator's own optimistic
			// row, so it is not itself the bug), and this arm never asked whether the id was free. So a
			// joined phone could send an add carrying another live entry's id and (a) destroy that
			// singer's turn — the record is rewritten whole, singerId/mediaId/addedAt and all — and
			// (b) orphan the displaced media's cook: the hub fires onEntryRemoved only on a literal
			// `remove`, so cancelJobsForMedia never runs and a worker keeps cooking a song nobody is
			// queued on. Reject at the seam, same class as the shape guards below. Compare the WHOLE
			// identity, not singerId alone: a same-singer re-point to a different mediaId still orphans
			// the old cook. The identical-identity re-add over a still-QUEUED row is left to pass on
			// purpose — applyOp's in-place arm and an evicted-clientOpId re-delivery (seenOps is a
			// bounded FIFO) both need it. But applyOp's add branch rewrites the matched row WHOLE
			// (entries.map((e) => e.id === op.entry.id ? op.entry : e)), so an identical-identity re-add
			// onto an entry the server has since moved OFF 'queued' — 'playing' above all — re-lands the
			// client-minted status:'queued' on it, downgrading the LIVE song: it drops out of
			// removableOnLeave's status!=='playing' filter (leave.ts:33) so the singer's own Leave then
			// removes it, and it reseqs behind the entry that should be next. So the id is only free to
			// re-land on while its entry is still 'queued'; a re-add onto a non-queued row is rejected,
			// same as a different-identity collision (#370, residual of #285's identical-identity carve-out).
			const existing = deps.state.entries.find((e) => e.id === op.entry.id);
			if (
				existing &&
				(existing.singerId !== op.entry.singerId ||
					existing.mediaId !== op.entry.mediaId ||
					existing.status !== 'queued')
			)
				return `entry id already taken: ${op.entry.id}`;
			// Shape of the CLIENT-MINTED add entry as it reaches this guard. Since #345 (5acf86d) the server
			// owns addedAt — it is re-stamped from the room's monotonic nextAddedAt() at the applyQueueOp seam
			// ~168 lines below (see hub.ts:handleQueueCommand). rotationSeq is ALSO server-owned, but not by
			// applyOp: applyOp inserts op.entry verbatim and sorts by the existing value (ops.ts) — assignSeqs
			// re-derives it (rotation.ts). So TWO client-minted fields reach the queue verbatim: status, and
			// pinnedSeq (#638) — the durable global-pin position, bound to the NULLABLE pinned_seq integer
			// column with no CHECK (persistence.ts). Both are guarded here (pinnedSeq at :add-arm below): an
			// object/array pinnedSeq crashes the un-try'd write-behind flush timer exactly like a non-integer
			// toSeq does through move-global (#702), and a numeric string is coerced in silently by SQLite
			// integer affinity so the room re-pins itself on restart into an order no client ever showed.
			// Both status and addedAt feed NOT NULL columns in queue_entries
			// (added_at integer, status text). What the column ACTUALLY rejects at the write-behind flush is
			// narrow and is NOT NULL alone — never an enum, never finiteness. Measured against a real
			// migrated DB: a missing or null addedAt, or a null status, throws `NOT NULL constraint failed`
			// and takes the WHOLE SERVER PROCESS DOWN asynchronously, detached from the frame that caused it
			// (a MISSING status is NOT in that class — the column carries DEFAULT 'queued', so it silently
			// defaults instead of throwing; added_at has no default, so a missing addedAt does throw). But an
			// off-enum non-null status ("obliterated") and a representable-but-garbage addedAt (Infinity)
			// throw NOTHING — status has no CHECK constraint (drizzle's `enum:` is compile-time only) so the
			// bad string is stored verbatim, and Infinity is coerced past the NOT NULL check into the row —
			// so those persist SILENTLY into the room's state and onto disk. So this guard is not
			// defence-in-depth behind a strict column: for STATUS it is the ONLY thing keeping an off-enum
			// value out of the queue (status is NOT re-stamped anywhere). For addedAt the story is different
			// since #345: the seam ~168 lines below unconditionally REPLACES every client addedAt with the
			// server's monotonic stamp, so a missing or Infinity addedAt can no longer crash the flush or
			// persist to disk — the re-stamp closes both of those classes on its own. The finiteness reject
			// here is therefore a SHAPE reject on addedAt (fail the frame early rather than silently rewrite a
			// garbage value), not the last line of defence it once was. The guard is still
			// deliberately BROADER than the crash (it also rejects the silently-persisting status case), which
			// is right. Same seam as the singerId crash above and the telemetry positionSec one. Reject here so
			// nothing bad — whether it would crash the flush or slip past it — is ever applied or persisted.
			//
			// #324: enum-MEMBERSHIP is too broad for a CLIENT-MINTED status. 'playing' and 'done' are both
			// in VALID_ENTRY_STATUSES (the enum is ['queued','playing','done']) but are SERVER-OWNED
			// lifecycle values, so admitting the whole enum admits them — beginSinging
			// mints 'playing', advance mints 'done', both via applyQueueOp DIRECTLY, never this wire seam. The
			// ONLY add producer in the repo (lib/stores/queue.ts addSong) hardcodes status:'queued'. So a
			// client's legal set is exactly {'queued'}, and admitting the whole enum re-opened #195's
			// consequence (a) through the `add` op: a forged 'playing' entry that is never playable (playback
			// still points at the real entry), never terminal, not removable by its own owner leaving
			// (removableOnLeave filters status !== 'playing'), and durable across restarts. Narrow to the one
			// value a real client mints — behaviour-preserving for every real client, the same argument #195's
			// fix used for the server-owned `status` op. (This also subsumes the off-enum reject above: any
			// non-'queued' string, in the enum or not, is refused.)
			if (!Number.isFinite(op.entry.addedAt)) return 'invalid addedAt';
			// pinnedSeq (#638) is the LAST client-minted field with no shape guard on the add path: it is
			// inserted verbatim (ops.ts), re-stamps nothing (only addedAt is re-stamped ~168 lines below), and
			// is bound to the NULLABLE `pinned_seq integer` column (persistence.ts). Same class as move-global's
			// toSeq (#702) and the addedAt reject above: nothing else on the path guards its shape, so this is
			// the ONLY line keeping a non-integer out of the pin. A non-number binding (object/array/NaN/
			// Infinity/float) is refused by bun:sqlite at the un-try'd write-behind flush and takes the core
			// process down asynchronously; a numeric STRING ('0') is dropped live by placePins' `typeof ===
			// number` filter (rotation.ts) yet coerced into the integer column by SQLite affinity, so the room
			// silently re-orders itself on the next restart into an order no client ever showed. `!= null` is
			// load-bearing: the field is OPTIONAL and every honest add omits it (lib/stores/queue.ts addSong),
			// so a bare Number.isInteger check would reject 100% of real adds. Negative/huge integers are NOT
			// rejected — placePins clamps low and high against the growing list (rotation.ts), so they are
			// honest no-consequence inputs and refusing them would be a behaviour change (same reasoning #702).
			if (op.entry.pinnedSeq != null && !Number.isInteger(op.entry.pinnedSeq)) return 'invalid pinnedSeq';
			if (op.entry.status !== 'queued') {
				// Distinguish the two rejects for the operator log: a string not even in the column vs a
				// real-but-server-owned lifecycle value. VALID_ENTRY_STATUSES is the column's own list, so
				// this classification can never drift from the column it reads.
				const known = VALID_ENTRY_STATUSES.includes(op.entry.status);
				return `invalid status: ${String(op.entry.status)} (${known ? 'server-owned' : 'off-enum'}; a client may only add a queued entry)`;
			}
			return null;
		}
		case 'remove': {
			const removeTarget = deps.state.entries.find((e) => e.id === op.id);
			if (!removeTarget) return `unknown entry: ${op.id}`;
			// Your OWN song is always yours to pull, with no capability required — that is not "remove-any",
			// it is removing your own turn. `queue:remove-any` (capabilities.ts:9-11, "remove SOMEONE ELSE'S
			// entry") is only the asker for a DIFFERENT singer's entry. Gating every remove through it — the
			// scope this arm previously used — is inert while can() ignores the capability, but the day can()
			// is narrowed to a host role (the migration :9-11 exists to enable) it would refuse a singer their
			// own song. So consult can() ONLY for someone else's entry (issue #241).
			if (removeTarget.singerId !== deps.actorSingerId) {
				if (!can({ singerId: deps.actorSingerId }, 'queue:remove-any')) return 'not allowed to remove this entry';
			}
			return null;
		}
		case 'move': {
			const moveTarget = deps.state.entries.find((e) => e.id === op.id);
			if (!moveTarget) return `unknown entry: ${op.id}`;
			// Same ownership scope as remove above: reordering your OWN entry needs no capability;
			// `queue:reorder-any` is only the asker for SOMEONE ELSE'S entry (issue #241).
			if (moveTarget.singerId !== deps.actorSingerId) {
				if (!can({ singerId: deps.actorSingerId }, 'queue:reorder-any')) return 'not allowed to reorder this entry';
			}
			return null;
		}
		case 'move-global':
		case 'unpin': {
			// A HOST reorder (issue #638). Unlike `move` above, the ownership of the target is irrelevant:
			// pinning ANY entry — even your own — to a GLOBAL slot rearranges the whole room's order and can
			// jump other singers, which is precisely the power `queue:reorder-any` gates. So this always
			// consults can(), never the owner short-circuit. Every joined singer is a host today
			// (capabilities.ts, same seam as player:control); narrowing to a real host role is an edit THERE.
			const target = deps.state.entries.find((e) => e.id === op.id);
			if (!target) return `unknown entry: ${op.id}`;
			if (!can({ singerId: deps.actorSingerId }, 'queue:reorder-any')) return 'not allowed to reorder the queue';
			// #702: `move-global`'s `toSeq` is the FIRST wire-settable op whose payload value is written
			// STRAIGHT to a durable column (applyOp stamps `pinnedSeq: op.toSeq` verbatim, the flush binds it
			// into `pinned_seq integer`). Same class as the addedAt reject above: nothing else on the path
			// guards its shape, so this is the ONLY line keeping a non-integer out of the pin. An object/array
			// crashes the un-try'd write-behind flush timer (bun:sqlite refuses the bind, killing the core
			// process asynchronously); a string/boolean is coerced by SQLite integer affinity into a real
			// number that only `placePins` HONOURS after a restart, silently reordering the room. Reject at the
			// seam. `unpin` carries no `toSeq`, so it is exempt — discriminate on `op.op`. Placed AFTER the
			// can() consult so the #638 source-scan still reads the capability check in this arm.
			if (op.op === 'move-global' && !Number.isInteger(op.toSeq)) return `invalid toSeq: ${String(op.toSeq)}`;
			return null;
		}
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
		// #490: the idempotency ledger must be consulted BEFORE a validation failure becomes a reject.
		// A resent command (a reconnect whose lost broadcast left the op pending, then resendPending on
		// `hello`) is one the server has ALREADY applied — so current state now contradicts the op and
		// validateCommand fails it: a `remove`'s entry has been pruned (`unknown entry`), and an `add`
		// whose entry the server has since started fails the id-collision guard (`entry id already
		// taken`, since #370). Rejecting there turned the re-ack the ledger exists to produce into a
		// false `op:reject` the phone shows the singer as an error for something that succeeded. So on a
		// validation failure, ask the ledger first: on a hit, emit the same idempotent re-ack the
		// already-applied branch below builds (`queue:patch` with `ops: []` and this `causedBy`) and do
		// NOT reject.
		//
		// This MUST use the NON-RECORDING `hasOp`, never the record-on-check `seenOp`. `seenOp` inserts
		// the id as a side effect of checking, so consulting it here would write a genuinely-INVALID,
		// never-applied op's id into the ledger the moment it is rejected — and its resend (the same
		// lost-message path #490 is about) would then be answered with a false re-ack instead of the
		// reject it deserves, silently vanishing an op that never applied. Only an op that ACTUALLY
		// applies is recorded, and that happens on the already-applied branch below. This stays BEHIND
		// the envelope guards — `validateCommand`'s first checks — so `cmd.clientOpId` is only read when
		// it exists (an envelope failure like `missing clientOpId` has no id to correlate and falls
		// straight through to the silent drop).
		if (cmd?.clientOpId && deps.hasOp?.(cmd.clientOpId)) {
			deps.publish({ type: 'queue:patch', patch: { rev: deps.state.rev, ops: [], causedBy: cmd.clientOpId } });
			return null;
		}
		// Only answerable if we know which op to reject. A frame with no clientOpId is dropped silently —
		// there is nothing to correlate a rejection to, and the sender is not a client we can help.
		if (cmd?.clientOpId) sendToOrigin?.({ type: 'op:reject', clientOpId: cmd.clientOpId, reason: err });
		return null;
	}

	// idempotency: a resent command (e.g. after reconnect) must not double-apply. Re-ack with the
	// current rev so the originator clears its pending op, but don't mutate state again. A resend whose
	// op still validates against current state (e.g. an `add` whose entry is still `queued`) lands here;
	// one that no longer validates is re-acked in the validation-failure branch above (#490).
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

	// Server-stamp the add's `addedAt` (issue #345). `addedAt` is the ordering input every
	// addedAt-reading policy ranks singers by (queue-order.ts orderFair/orderFcfs/orderLeastRecentlySung),
	// but validateCommand's add arm only checks it for finiteness — so one frame carrying a stamp below
	// every other singer's first pick puts that singer at the head of every round, the jump
	// reorderWithinSinger exists to make impossible on `move` (rotation.ts). The wire contract already
	// declares this channel: ServerPatch.ops is "canonical ops (server may rewrite, e.g. assign
	// rotationSeq)" (ops.ts). Re-stamp from the room's monotonic counter here, at the seam, so the value
	// that reaches the shared reducer, the broadcast, and disk is server-owned. The client's own
	// optimistic addedAt (stores/queue.ts) is left untouched — it needs one to predict with, and adopts
	// the authoritative `entries` carried inline on this patch, the same one-op mispredict applyAndReseq
	// already tolerates for a stale snapshot.
	const op: QueueOp =
		cmd.op.op === 'add' ? { op: 'add', entry: { ...cmd.op.entry, addedAt: deps.state.nextAddedAt() } } : cmd.op;

	const { rev, canonicalOps, entries } = deps.state.applyQueueOp(op);

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
