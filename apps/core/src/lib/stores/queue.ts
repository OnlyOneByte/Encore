// Optimistic queue store — the client half of the reconciliation contract.
// (docs/reconciliation-contract.md §3-7). The whole optimistic engine is:
//   client-minted ULID  +  a `pending` map (op + inverse)  +  server `rev`.
// No CRDT, no OT. Mutations render locally THIS FRAME, then reconcile on the server broadcast;
// rejects roll back via the recorded inverse; resync rebases still-pending ops onto truth.
//
// Framework-agnostic (plain class + subscribe callback) so it unit-tests without a DOM; the
// Svelte component (M3) wraps this in a $state rune.

import {
	applyOp,
	applyAndReseq,
	inverseOp,
	ulid,
	type QueueOp,
	type QueueEntry,
	type ServerEvent,
	type ClientCommand
} from '@encore/shared';

interface PendingOp {
	op: QueueOp;
	inverse: QueueOp | null;
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
}

export class QueueStore {
	#entries: QueueEntry[] = [];
	#rev = 0;
	#pending = new Map<string, PendingOp>();
	#deps: QueueStoreDeps;
	#subs = new Set<(entries: QueueEntry[]) => void>();
	#lastAddedAt = 0; // monotonic clock for addedAt tiebreaker (Finding #4)

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

	#optimistic(op: QueueOp): void {
		const inverse = inverseOp(this.#entries, op);
		const clientOpId = (this.#deps.mintId ?? ulid)();
		this.#pending.set(clientOpId, { op, inverse, baseRev: this.#rev });
		// Run the SAME reducer the server runs (applyAndReseq) so the optimistic row lands at its
		// real round-robin position THIS FRAME — no jump-to-bottom-then-resort flicker (Finding #2).
		this.#entries = applyAndReseq(this.#entries, op);
		this.#emit();
		this.#deps.sendCommand({ clientOpId, baseRev: this.#rev, op });
	}

	/**
	 * Resend every still-pending command (call on WS reconnect). Safe because the server dedupes
	 * by clientOpId (M6-C2): an already-applied op is re-acked, not double-applied.
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
			// playback/media/nowplaying handled by other stores
		}
	}

	#onPatch(e: Extract<ServerEvent, { type: 'queue:patch' }>): void {
		this.#rev = e.patch.rev;
		// originator: clear the matching pending op (it's now confirmed by the server)
		if (e.patch.causedBy) this.#pending.delete(e.patch.causedBy);
		if (e.patch.entries) {
			// Authoritative snapshot present (normal mutation): adopt it as truth, then re-apply any
			// STILL-pending local ops on top so in-flight changes survive. This is what makes the
			// originator's optimistic row snap to the server's canonical rotationSeq with zero flicker
			// (Finding #2/#3) and drops terminal entries the server pruned.
			let base = e.patch.entries.map((x) => ({ ...x }));
			for (const { op } of this.#pending.values()) base = applyAndReseq(base, op);
			this.#entries = base;
		} else {
			// Pure re-ack (dedup path) carries no entries and no ops — nothing to apply.
			for (const op of e.patch.ops) this.#entries = applyAndReseq(this.#entries, op);
		}
		this.#emit();
	}

	#onSync(e: Extract<ServerEvent, { type: 'queue:sync' }>): void {
		this.#rev = e.rev;
		// REBASE: authoritative truth, then re-apply still-pending local ops on top (via the shared
		// reducer so seqs match the server) so the user's in-flight changes don't vanish on resync.
		let base = e.entries.map((x) => ({ ...x }));
		for (const { op } of this.#pending.values()) base = applyAndReseq(base, op);
		this.#entries = base;
		this.#emit();
	}

	#onReject(e: Extract<ServerEvent, { type: 'op:reject' }>): void {
		const pending = this.#pending.get(e.clientOpId);
		if (!pending) return;
		this.#pending.delete(e.clientOpId);
		// ROLLBACK: apply the recorded inverse op to undo the optimistic change
		if (pending.inverse) {
			this.#entries = applyOp(this.#entries, pending.inverse);
			this.#emit();
		}
		this.#deps.onReject?.(e.reason); // surface to the UI (toast)
	}
}
