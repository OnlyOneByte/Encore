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
} from '@encore/shared';

interface PendingOp {
	op: QueueOp;
	/**
	 * The FULL entries array as it stands immediately BEFORE this op is applied — with every EARLIER
	 * still-pending op baked in, ON THE CURRENT SERVER TRUTH. Kept in sync: the rebase loops in
	 * #onPatch/#onSync/#onReject re-derive it each time truth moves, so it is never stale (issue
	 * #101 regression — a snapshot frozen at op-issue time drops any server patch that lands before
	 * the reject). Rollback restores this snapshot
	 * rather than deriving an undo from the op (issue #101): a per-op inverse must agree with the
	 * forward reducer, and for `move` it did not — the forward step routes through
	 * `applyAndReseq`/`reorderWithinSinger` (permutes `addedAt`) while the inverse ran `applyOp`
	 * (rewrites `rotationSeq`), so the inverse undid a mutation that never happened and left the
	 * real one in place. A snapshot is total for every op kind and cannot drift as future ops gain
	 * their own reducer branches.
	 */
	snapshot: QueueEntry[];
	/** Monotonic issue order — reject rebuilds from this op's snapshot by re-applying only LATER ops. */
	seq: number;
	baseRev: number; // rev when issued — for resend
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
	#pendingSeq = 0; // monotonic issue counter for pending ops (rollback rebase order, issue #101)

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
		// restore them verbatim (issue #101).
		const snapshot = this.#entries.map((e) => ({ ...e }));
		const clientOpId = (this.#deps.mintId ?? ulid)();
		this.#pending.set(clientOpId, { op, snapshot, seq: this.#pendingSeq++, baseRev: this.#rev });
		// Run the SAME reducer the server runs (applyAndReseq) so the optimistic row lands at its
		// real round-robin position THIS FRAME — no jump-to-bottom-then-resort flicker (Finding #2).
		this.#entries = applyAndReseq(this.#entries, op, this.#ordering());
		this.#emit();
		this.#deps.sendCommand({ clientOpId, baseRev: this.#rev, op });
	}

	/**
	 * Resend every still-pending command (call on WS reconnect). Safe because the server dedupes
	 * by clientOpId: an already-applied op is re-acked, not double-applied.
	 */
	resendPending(): void {
		for (const [clientOpId, p] of this.#pending) {
			this.#deps.sendCommand({ clientOpId, baseRev: p.baseRev, op: p.op });
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

	#onPatch(e: Extract<ServerEvent, { type: 'queue:patch' }>): void {
		this.#rev = e.patch.rev;
		// originator: the echoed op is now server-confirmed, so drop it from pending
		if (e.patch.causedBy) this.#pending.delete(e.patch.causedBy);
		if (e.patch.entries) {
			// Authoritative snapshot present (normal mutation): adopt it as truth, then re-apply any
			// STILL-pending local ops on top so in-flight changes survive. This is what makes the
			// originator's optimistic row snap to the server's canonical rotationSeq with zero flicker
			// (Finding #2/#3) and drops terminal entries the server pruned.
			let base = e.patch.entries.map((x) => ({ ...x }));
			for (const p of this.#pending.values()) {
				// Refresh each op's rollback target to the rebased pre-op state (issue #101): server
				// truth just replaced #entries, so a snapshot frozen at op-issue time would roll a
				// later reject back to a stale world and silently drop this patch.
				p.snapshot = base.map((x) => ({ ...x }));
				base = applyAndReseq(base, p.op, this.#ordering());
			}
			this.#entries = base;
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
		let base = e.entries.map((x) => ({ ...x }));
		for (const p of this.#pending.values()) {
			// Refresh each op's rollback target to the rebased pre-op state (issue #101) — same reason
			// as #onPatch: a resync replaces truth, and a stale snapshot would lose it on a later reject.
			p.snapshot = base.map((x) => ({ ...x }));
			base = applyAndReseq(base, p.op, this.#ordering());
		}
		this.#entries = base;
		this.#emit();
	}

	#onReject(e: Extract<ServerEvent, { type: 'op:reject' }>): void {
		const pending = this.#pending.get(e.clientOpId);
		if (!pending) return;
		this.#pending.delete(e.clientOpId);
		// ROLLBACK by restoring the pre-op snapshot (issue #101): a per-op inverse cannot be trusted
		// to undo what the forward reducer actually did (it failed for `move`). The snapshot already
		// carries every EARLIER pending op, so re-apply only the ops issued AFTER the rejected one
		// (via the shared reducer, the same rebase the patch/sync paths use) — that keeps a concurrent
		// in-flight op alive without double-applying the earlier ones already baked into the snapshot.
		let base = pending.snapshot.map((x) => ({ ...x }));
		for (const p of this.#pending.values()) {
			if (p.seq <= pending.seq) continue; // earlier ops are already baked into the snapshot
			// Refresh the survivor's rollback target too, so a later reject of IT rolls back to the
			// correct rebased pre-op world (keeps the same snapshot invariant #onPatch/#onSync hold).
			p.snapshot = base.map((x) => ({ ...x }));
			base = applyAndReseq(base, p.op, this.#ordering());
		}
		this.#entries = base;
		this.#emit();
		this.#deps.onReject?.(e.reason); // surface to the UI (toast)
	}
}
