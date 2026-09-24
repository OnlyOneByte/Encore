// Optimistic queue store — the client half of the reconciliation contract (docs/ARCHITECTURE.md): a client-minted
// ULID, a `pending` map (op + pre-op snapshot) and the server `rev`. Mutations render locally THIS FRAME, reconcile on
// the server broadcast, roll back to the recorded snapshot on reject, and rebase pending ops onto truth on resync. No
// CRDT, no OT. Framework-agnostic (plain class + subscribe) so it unit-tests without a DOM.

import {
	applyAndReseq,
	ulid,
	type Ordering,
	type QueueOp,
	type QueueEntry,
	type ServerEvent,
	type ClientCommand
} from '$lib/contract';

interface PendingOp {
	op: QueueOp;
	/**
	 * The FULL entries array immediately BEFORE this op is applied, with every earlier still-pending op baked in, ON
	 * CURRENT SERVER TRUTH — maintained by ONE writer, `#rebasePending`, because a snapshot frozen at op-issue time
	 * drops any server patch that lands before the reject. Rollback RESTORES it rather than deriving an undo from the
	 * op: a per-op inverse has to agree with the forward reducer, and for a move the two rewrote different fields.
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
	/** The room's ordering — which algorithm, plus the sing history it may read. A GETTER because both halves move at
	 * runtime, and the optimistic prediction MUST be made with the same ordering the server will commit, or every add
	 * lands in the wrong place for a frame and then snaps. Absent means fair rotation. */
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
	 * What each visible row is still waiting on — the truth behind every unconfirmed marker on the phone. NOT derivable
	 * from the entry itself: `#optimistic` reseqs every entry to a contiguous index before it emits. `move` and
	 * `move-to-index` are ONE kind here, because they are one thing to a guest; `remove` is deliberately absent, since
	 * the optimistic remove takes the row out of the list and the undo toast is its disclosure.
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
	/** Cross-singer reorder: a GLOBAL queued index, which can jump other singers — unlike `moveEntry`, whose `toSeq`
	 * indexes the caller's OWN picks. The same optimistic reducer, so the server commits the identical order. */
	moveToIndex(id: string, toIdx: number): void {
		this.#optimistic({ op: 'move-to-index', id, toIdx });
	}

	/** `addedAt` is the round-robin tiebreaker, so two adds in the same millisecond MUST get distinct, increasing
	 * values. The server trusts this value verbatim, which is why monotonicity has to be established here. */
	#nextAddedAt(): number {
		this.#lastAddedAt = Math.max(Date.now(), this.#lastAddedAt + 1);
		return this.#lastAddedAt;
	}

	/** The room's ordering, or fair rotation when the app has not supplied one. */
	#ordering(): Ordering {
		return this.#deps.ordering?.() ?? {};
	}

	#optimistic(op: QueueOp): void {
		// Snapshot the pre-op entries (with all earlier pending ops baked in) so a reject can restore them verbatim.
		const snapshot = this.#entries.map((e) => ({ ...e }));
		const clientOpId = (this.#deps.mintId ?? ulid)();
		this.#pending.set(clientOpId, { op, snapshot, seq: this.#pendingSeq++ });
		// The SAME reducer the server runs (applyAndReseq), so the optimistic row lands at its real round-robin position
		// THIS FRAME — no jump-to-bottom-then-resort flicker.
		this.#entries = applyAndReseq(this.#entries, op, this.#ordering());
		this.#emit();
		this.#deps.sendCommand({ clientOpId, op });
	}

	/** Resend every still-pending command on reconnect. Safe because the server dedupes by `clientOpId` and consults
	 * its idempotency ledger BEFORE a validation failure becomes a reject, so a resent op whose shape no longer
	 * validates against current state is re-acked rather than surfacing a false error. */
	resendPending(): void {
		for (const [clientOpId, p] of this.#pending) {
			this.#deps.sendCommand({ clientOpId, op: p.op });
		}
	}

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

	/** Follow the shared server rev when a non-queue event bumps it. This store tracks rev only because the socket's
	 * gap detector reads it to decide whether the next patch skipped one. ADVANCE-ONLY, never a rewind: events can
	 * arrive out of order behind a patch that already carried a higher rev, and rewinding manufactures the very gap
	 * this closes. Emits nothing — only rev moved. */
	#noteRev(rev: number): void {
		if (rev > this.#rev) this.#rev = rev;
	}

	/**
	 * THE one place that maintains the pending-snapshot invariant: every pending op's `snapshot` must be its pre-op
	 * state ON CURRENT SERVER TRUTH, so a later reject rolls back to the world as it is now. ALL THREE writers that
	 * move truth rebase through here, so the invariant is stated once rather than copied into three loops that can
	 * drift. A reject passes only the ops issued AFTER the rejected one, the earlier ones being baked into its snapshot.
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
		// Through `#noteRev` rather than assigning, so there is ONE enforcement point for advance-only: a lower rev here
		// would rewind the counter that refuses to rewind, reintroducing the resync storm through the other writer.
		this.#noteRev(e.patch.rev);
		// The echoed op is now server-confirmed, so it leaves pending.
		if (e.patch.causedBy) this.#pending.delete(e.patch.causedBy);
		if (e.patch.entries) {
			// The authoritative snapshot becomes truth and still-pending local ops re-apply on top, which is what makes the
			// originator's optimistic row snap to the canonical order with no flicker.
			const base = e.patch.entries.map((x) => ({ ...x }));
			this.#entries = this.#rebasePending(base, this.#pending.values());
		} else {
			// A pure re-ack carries no entries, so there is nothing authoritative to rebase onto.
			for (const op of e.patch.ops) this.#entries = applyAndReseq(this.#entries, op, this.#ordering());
		}
		this.#emit();
	}

	#onSync(e: Extract<ServerEvent, { type: 'queue:sync' }>): void {
		this.#rev = e.rev;
		// Rebase through the shared writer: a resync replaces truth, and a stale snapshot would lose the guest's
		// in-flight changes on a later reject.
		const base = e.entries.map((x) => ({ ...x }));
		this.#entries = this.#rebasePending(base, this.#pending.values());
		this.#emit();
	}

	#onReject(e: Extract<ServerEvent, { type: 'op:reject' }>): void {
		const pending = this.#pending.get(e.clientOpId);
		if (!pending) return;
		this.#pending.delete(e.clientOpId);
		// Rollback RESTORES the pre-op snapshot, which already carries every EARLIER pending op — so only the ops issued
		// after the rejected one are re-applied, keeping a concurrent in-flight op alive without double-applying.
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
