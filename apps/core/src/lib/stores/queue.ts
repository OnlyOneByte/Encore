// Optimistic queue store — the client half of the reconciliation contract.
// (docs/ARCHITECTURE.md). The whole optimistic engine is:
//   client-minted ULID  +  a `pending` map (op + pre-op snapshot)  +  server `rev`.
// No CRDT, no OT. Mutations render locally THIS FRAME, then reconcile on the server broadcast;
// rejects roll back to the recorded snapshot; resync rebases still-pending ops onto truth.
//
// Framework-agnostic (plain class + subscribe callback) so it unit-tests without a DOM; the
// Svelte component wraps this in a $state rune.

import {
	applyAndReseq,
	ulid,
	type Ordering,
	type QueueOp,
	type QueueEntry,
	type ServerEvent,
	type ClientCommand
} from '$shared';

interface PendingOp {
	op: QueueOp;
	/**
	 * The FULL entries array as it stands immediately BEFORE this op is applied — with every EARLIER
	 * still-pending op baked in, ON THE CURRENT SERVER TRUTH. Kept in sync by ONE writer,
	 * #rebasePending, which every truth-moving path (#onPatch/#onSync/#onReject) rebases through, so
	 * it is never stale (a stale-snapshot regression — a snapshot frozen at op-issue time drops any server
	 * patch that lands before the reject; the invariant used to be copied into three
	 * loops that could drift). Rollback restores this snapshot
	 * rather than deriving an undo from the op: a per-op inverse must agree with the
	 * forward reducer, and for `move` it did not — the forward step routes through
	 * `applyAndReseq`/`reorderWithinSinger` (permutes `addedAt`) while the inverse ran `applyOp`
	 * (rewrites `rotationSeq`), so the inverse undid a mutation that never happened and left the
	 * real one in place. A snapshot is total for every op kind and cannot drift as future ops gain
	 * their own reducer branches.
	 */
	snapshot: QueueEntry[];
	/** Monotonic issue order — reject rebuilds from this op's snapshot by re-applying only LATER ops. */
	seq: number;
}

export interface QueueStoreDeps {
	/** Send a command to the server (wired to WsClient.send in the app). */
	sendCommand: (cmd: ClientCommand) => void;
	/** Stable id for "me" (singer) — stamped onto optimistic adds. */
	singerId: string;
	mintId?: () => string; // injectable for deterministic tests
	/** Optional: surface a rejected op to the UI (e.g. a toast). */
	onReject?: (reason: string) => void;
	/**
	 * The room's ordering — which algorithm, plus the sing history it may read.
	 *
	 * A GETTER because both halves move at runtime: the room can change algorithm mid-party and the
	 * history changes every time a song starts. It exists at all because the optimistic prediction
	 * has to be made with the SAME ordering the server will commit — predicting with fair rotation in
	 * a first-come-first-served room puts every add in the wrong place for a frame and then snaps,
	 * which is the exact flicker `applyAndReseq` is shared to prevent.
	 *
	 * Absent = fair rotation, the pre-setting behaviour.
	 */
	ordering?: () => Ordering;
}

export class QueueStore {
	#entries: QueueEntry[] = [];
	#rev = 0;
	#pending = new Map<string, PendingOp>();
	#deps: QueueStoreDeps;
	#subs = new Set<(entries: QueueEntry[]) => void>();
	#lastAddedAt = 0; // monotonic clock for addedAt tiebreaker (Finding #4)
	#pendingSeq = 0; // monotonic issue counter for pending ops (rollback rebase order)

	constructor(deps: QueueStoreDeps) {
		this.#deps = deps;
	}

	get entries(): QueueEntry[] {
		return this.#entries.map((e) => ({ ...e }));
	}
	get rev(): number {
		return this.#rev;
	}
	get pendingCount(): number {
		return this.#pending.size;
	}

	/**
	 * What each visible row is still waiting on — the truth behind every unconfirmed marker on the
	 * phone (XR-PH-10).
	 *
	 * `'add'` is the original case: a row is unconfirmed between addSong() and the server
	 * ack/reject of that add. The earlier call site tested the placeholder
	 * `rotationSeq === MAX_SAFE_INTEGER`, but #optimistic runs applyAndReseq (which reseqs every entry
	 * to a contiguous 0-based index) BEFORE it emits, so no subscriber ever observed the placeholder
	 * and the state was structurally dead.
	 *
	 * `'move'` is what this getter adds, and it replaces a stated gap: the old `unconfirmedAddIds`
	 * documented "a pending move/remove does not make an entry newly unconfirmed", so a reorder
	 * committed on a flaky socket looked IDENTICAL to one that landed — the row slid into its new slot
	 * and nothing said the slide was still a guess. `move` (own picks) and `move-to-index` (a
	 * cross-singer reorder) are one kind here because they are one thing to a guest: this row has been
	 * moved and the room has not agreed yet.
	 *
	 * `remove` is deliberately absent: the optimistic remove takes the row OUT of the list, so there is
	 * no row left to mark, and its disclosure is the undo toast.
	 *
	 * A MAP rather than two sets because the marker's COPY differs — a pending reorder must not claim
	 * it is "adding" — and two parallel sets would be two sources of truth for one row's state.
	 */
	get pendingKindById(): Map<string, 'add' | 'move'> {
		const kinds = new Map<string, 'add' | 'move'>();
		for (const p of this.#pending.values()) {
			// Ops are issued in order, so a later op's kind is the one the row is currently waiting on.
			if (p.op.op === 'add') kinds.set(p.op.entry.id, 'add');
			else if (p.op.op === 'move' || p.op.op === 'move-to-index') kinds.set(p.op.id, 'move');
		}
		return kinds;
	}

	subscribe(fn: (entries: QueueEntry[]) => void): () => void {
		this.#subs.add(fn);
		fn(this.entries);
		return () => this.#subs.delete(fn);
	}
	#emit(): void {
		const snap = this.entries;
		this.#subs.forEach((fn) => fn(snap));
	}

	// ── local optimistic mutations (called from UI handlers) ──────────────────
	/** Add a song to MY turn. Mints the id locally so the server echo reconciles with zero flicker. */
	addSong(mediaId: string): string {
		const id = (this.#deps.mintId ?? ulid)();
		const entry: QueueEntry = {
			id,
			mediaId,
			singerId: this.#deps.singerId,
			status: 'queued',
			rotationSeq: Number.MAX_SAFE_INTEGER, // placeholder; applyAndReseq assigns the real seq
			addedAt: this.#nextAddedAt() // monotonic — never collides under fast taps (Finding #4)
		};
		this.#optimistic({ op: 'add', entry });
		return id;
	}
	removeEntry(id: string): void {
		this.#optimistic({ op: 'remove', id });
	}
	moveEntry(id: string, toSeq: number): void {
		this.#optimistic({ op: 'move', id, toSeq });
	}
	/**
	 * Cross-singer reorder (step 4): move an entry to a GLOBAL queued index, which can jump other
	 * singers — unlike moveEntry, whose toSeq is an index into the caller's OWN picks. Runs through the
	 * same optimistic applyAndReseq path (→ moveToIndex, rotation.ts), so the row lands at its real slot
	 * this frame and the server commits the identical order. `queue:reorder-any` gates it server-side for
	 * an entry the actor does not own.
	 */
	moveToIndex(id: string, toIdx: number): void {
		this.#optimistic({ op: 'move-to-index', id, toIdx });
	}

	/**
	 * Monotonic add timestamp. addedAt is the round-robin tiebreaker (rotate sorts each singer's
	 * picks by it), so two adds in the same millisecond MUST get distinct, increasing values or the
	 * order is nondeterministic and reorder-by-addedAt-permute breaks. The server trusts the
	 * client's addedAt verbatim, so making it monotonic here keeps client/server prediction aligned.
	 */
	#nextAddedAt(): number {
		this.#lastAddedAt = Math.max(Date.now(), this.#lastAddedAt + 1);
		return this.#lastAddedAt;
	}

	/** The room's ordering, or fair rotation when the app has not supplied one. */
	#ordering(): Ordering {
		return this.#deps.ordering?.() ?? {};
	}

	#optimistic(op: QueueOp): void {
		// Snapshot the pre-op entries (with all earlier pending ops baked in) so a reject can
		// restore them verbatim.
		const snapshot = this.#entries.map((e) => ({ ...e }));
		const clientOpId = (this.#deps.mintId ?? ulid)();
		this.#pending.set(clientOpId, { op, snapshot, seq: this.#pendingSeq++ });
		// Run the SAME reducer the server runs (applyAndReseq) so the optimistic row lands at its
		// real round-robin position THIS FRAME — no jump-to-bottom-then-resort flicker (Finding #2).
		this.#entries = applyAndReseq(this.#entries, op, this.#ordering());
		this.#emit();
		this.#deps.sendCommand({ clientOpId, op });
	}

	/**
	 * Resend every still-pending command (call on WS reconnect). Safe because the server dedupes by
	 * clientOpId: an already-applied op is re-acked, not double-applied — and,, that re-ack
	 * fires even for an op the server has already applied whose shape no longer validates against
	 * current state (a resent `remove` whose entry is now pruned, or an `add` whose entry has started),
	 * because the idempotency ledger is consulted before a validation failure becomes an `op:reject`.
	 * So resending a genuinely-succeeded op never surfaces a false error banner to the singer.
	 */
	resendPending(): void {
		for (const [clientOpId, p] of this.#pending) {
			this.#deps.sendCommand({ clientOpId, op: p.op });
		}
	}

	// ── server events (from WsClient.onEvent) ─────────────────────────────────
	onServerEvent(e: ServerEvent): void {
		switch (e.type) {
			case 'queue:patch':
				this.#onPatch(e);
				break;
			case 'queue:sync':
				this.#onSync(e);
				break;
			case 'op:reject':
				this.#onReject(e);
				break;
			case 'playback:state':
				this.#noteRev(e.rev);
				break;
			// media/nowplaying handled by other stores
		}
	}

	/**
	 * Follow the shared server `#rev` when it is bumped by a non-queue event — today only
	 * `playback:state` (pause/seek/key/guide/skip all advance the ONE server counter). The state
	 * itself belongs to another store; this store tracks rev ONLY because the WS gap detector reads
	 * it (getLastRev) to decide whether the NEXT `queue:patch` skipped a rev. Without this, every
	 * playback change left our rev behind the server's, so the next queue op looked gapped and forced
	 * a full snapshot to every phone — the resync storm (worst-case: one per playback change × N phones).
	 *
	 * Advance-only (never rewind): a `playback:state` can arrive out of order behind a `queue:patch`
	 * that already carried a higher rev, and rewinding would manufacture the very gap this closes.
	 * Touches no entries and emits nothing — rev is the only thing that moved.
	 */
	#noteRev(rev: number): void {
		if (rev > this.#rev) this.#rev = rev;
	}

	/**
	 * THE one place that maintains the pending-snapshot invariant.
	 *
	 * Starting from `base` (the new authoritative truth), walk the given pending ops in issue order
	 * and, for each, (1) refresh its `snapshot` rollback target to the current rebased pre-op state,
	 * then (2) re-apply the op through the shared reducer so the next op — and the returned view —
	 * sits on top of it. The refresh is the invariant: every pending op's `snapshot` must be the
	 * pre-op state ON CURRENT SERVER TRUTH, so a later `op:reject` rolls back to the world as it is
	 * now, not to a stale one frozen at op-issue time (the regression PR an earlier change fixed).
	 *
	 * All three writers that move truth — `#onPatch`, `#onSync`, `#onReject` — rebase through here so
	 * the invariant is stated ONCE rather than copied into three loops that can drift (the two hotter
	 * reconnect-path copies were unpinned). `#onReject` passes only the ops issued AFTER
	 * the rejected one, because the earlier ops are already baked into the rejected op's snapshot;
	 * the loop body is otherwise identical, which is exactly why it is shared.
	 *
	 * Returns the rebased entries; the caller assigns `#entries`.
	 */
	#rebasePending(base: QueueEntry[], pendingOps: Iterable<PendingOp>): QueueEntry[] {
		let acc = base;
		for (const p of pendingOps) {
			p.snapshot = acc.map((x) => ({ ...x }));
			acc = applyAndReseq(acc, p.op, this.#ordering());
		}
		return acc;
	}

	#onPatch(e: Extract<ServerEvent, { type: 'queue:patch' }>): void {
		// Advance-only, through the SAME rule #noteRev enforces: the server never intentionally emits
		// a lower rev (hub/player/leave all publish state.rev at publish time), and a lower rev here
		// would rewind the counter #noteRev deliberately refuses to rewind — reintroducing the resync
		// storm through the other writer. One enforcement point, not one enforced + one
		// honour-system copy. The re-ack/entries branches below still run on every patch.
		this.#noteRev(e.patch.rev);
		// originator: the echoed op is now server-confirmed, so drop it from pending
		if (e.patch.causedBy) this.#pending.delete(e.patch.causedBy);
		if (e.patch.entries) {
			// Authoritative snapshot present (normal mutation): adopt it as truth, then re-apply any
			// STILL-pending local ops on top so in-flight changes survive. This is what makes the
			// originator's optimistic row snap to the server's canonical rotationSeq with zero flicker
			// (Finding #2/#3) and drops terminal entries the server pruned. #rebasePending refreshes
			// each pending op's rollback target to the rebased pre-op state (the invariant).
			const base = e.patch.entries.map((x) => ({ ...x }));
			this.#entries = this.#rebasePending(base, this.#pending.values());
		} else {
			// Pure re-ack (dedup path) carries no entries and no ops — nothing to apply.
			for (const op of e.patch.ops) this.#entries = applyAndReseq(this.#entries, op, this.#ordering());
		}
		this.#emit();
	}

	#onSync(e: Extract<ServerEvent, { type: 'queue:sync' }>): void {
		this.#rev = e.rev;
		// REBASE: authoritative truth, then re-apply still-pending local ops on top (via the shared
		// reducer so seqs match the server) so the user's in-flight changes don't vanish on resync.
		// #rebasePending refreshes each op's rollback target to the rebased pre-op state — the same stale-snapshot
		// invariant as #onPatch: a resync replaces truth, and a stale snapshot would lose it on a
		// later reject.
		const base = e.entries.map((x) => ({ ...x }));
		this.#entries = this.#rebasePending(base, this.#pending.values());
		this.#emit();
	}

	#onReject(e: Extract<ServerEvent, { type: 'op:reject' }>): void {
		const pending = this.#pending.get(e.clientOpId);
		if (!pending) return;
		this.#pending.delete(e.clientOpId);
		// ROLLBACK by restoring the pre-op snapshot: a per-op inverse cannot be trusted
		// to undo what the forward reducer actually did (it failed for `move`). The snapshot already
		// carries every EARLIER pending op, so re-apply only the ops issued AFTER the rejected one —
		// that keeps a concurrent in-flight op alive without double-applying the earlier ones already
		// baked into the snapshot. Rebasing through #rebasePending refreshes each survivor's rollback
		// target too, so a later reject of IT rolls back to the correct rebased pre-op world (the same
		// invariant #onPatch/#onSync hold).
		const survivors: PendingOp[] = [];
		for (const p of this.#pending.values()) {
			if (p.seq <= pending.seq) continue; // earlier ops are already baked into the snapshot
			survivors.push(p);
		}
		const base = pending.snapshot.map((x) => ({ ...x }));
		this.#entries = this.#rebasePending(base, survivors);
		this.#emit();
		this.#deps.onReject?.(e.reason); // surface to the UI (toast)
	}
}
