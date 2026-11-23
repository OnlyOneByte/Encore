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
	onReject?: (reason: string, op: QueueOp) => void;
	/** The room's ordering — which algorithm, plus the sing history it may read. A GETTER because both halves move at
	 * runtime, and the optimistic prediction MUST be made with the same ordering the server will commit, or every add
	 * lands in the wrong place for a frame and then snaps. Absent means fair rotation. Handed the list the op is about to
	 * be applied onto, so what is read off the queue itself (the held On deck entry) comes from that list. */
	ordering?: (list: readonly QueueEntry[]) => Ordering;
}

export class QueueStore {
	#entries: QueueEntry[] = [];
	#rev = 0;
	#pending = new Map<string, PendingOp>();
	#deps: QueueStoreDeps;
	#subs = new Set<(entries: QueueEntry[]) => void>();
	#lastAddedAt = 0; // monotonic clock for addedAt tiebreaker (Finding #4)
	#pendingSeq = 0; // monotonic issue counter for pending ops (rollback rebase order)
	/** Has the server ever handed us a FULL list? Set by `#onSync` only, so it cannot be confused with "the store
	 * exists": the store is constructed before the socket opens, and an empty `#entries` in that window is
	 * indistinguishable from an empty queue. A caller that diffs successive lists needs to know which it is looking
	 * at — /queue's polite region announced the whole join snapshot as N additions because it seeded its baseline
	 * from the pre-socket empty list. `queue:sync` is part of every hello, so sync-only is sufficient. */
	#synced = false;

	constructor(deps: QueueStoreDeps) {
		this.#deps = deps;
	}

	get entries(): QueueEntry[] {
		return this.#entries.map((e) => ({ ...e }));
	}
	get rev(): number {
		return this.#rev;
	}
	/** See `#synced`. Never goes back to false: a resync replaces truth, it does not un-know it. */
	get synced(): boolean {
		return this.#synced;
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
			// A new song in the turn is an add to the guest: the row is waiting on the server to take it.
			else if (p.op.op === 'replace-media') kinds.set(p.op.id, 'add');
			else if (p.op.op === 'move' || p.op.op === 'move-to-index') kinds.set(p.op.id, 'move');
		}
		return kinds;
	}
	/** Is a reorder of THIS phone's still unconfirmed? Then a change of who is On deck is this phone's own doing. */
	get reorderPending(): boolean {
		return [...this.#pending.values()].some((p) => ['move', 'move-to-index', 'not-yet'].includes(p.op.op));
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

	/** Add a song to MY turn. Mints the id locally so the server echo reconciles with zero flicker. `keyShift` is the
	 * key this phone last sang the song in, so a repeat song arrives already set. */
	addSong(mediaId: string, keyShift?: number): string {
		const id = (this.#deps.mintId ?? ulid)();
		const entry: QueueEntry = {
			id,
			mediaId,
			singerId: this.#deps.singerId,
			status: 'queued',
			rotationSeq: Number.MAX_SAFE_INTEGER, // placeholder; applyAndReseq assigns the real seq
			addedAt: this.#nextAddedAt(), // monotonic — never collides under fast taps (Finding #4)
			...(keyShift ? { keyShift } : {})
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
	/** "Pick another, keep your spot": the same turn, another song, in `keyShift` — the NEW song's remembered key. */
	replaceMedia(id: string, mediaId: string, keyShift: number): void {
		this.#optimistic({ op: 'replace-media', id, mediaId, keyShift });
	}
	/** "Try again": lift MY held turn, so the song the TV could not play is next again, in the same spot. */
	retryPlay(id: string): void {
		this.#optimistic({ op: 'retry-play', id });
	}

	/** The on-deck card's key and guide for one of MY entries. Absolute, like the `key` command. */
	setEntryPrefs(id: string, keyShift: number, guideLevel: number | null): void {
		this.#optimistic({ op: 'set-entry-prefs', id, keyShift, guideLevel });
	}
	/** "Not yet": move MY entry back to `toIdx` (a whole-queued-list index), spending its one deferral. */
	notYet(id: string, toIdx: number): void {
		this.#optimistic({ op: 'not-yet', id, toIdx });
	}

	/** `addedAt` is the round-robin tiebreaker, so two adds in the same millisecond MUST get distinct, increasing
	 * values. The server trusts this value verbatim, which is why monotonicity has to be established here. */
	#nextAddedAt(): number {
		this.#lastAddedAt = Math.max(Date.now(), this.#lastAddedAt + 1);
		return this.#lastAddedAt;
	}

	/** The room's ordering for an op about to be applied onto `list`, or fair rotation when the app has not supplied one.
	 *  The LIST is passed because part of the ordering is read off it (the On deck hold an add lands behind): a pending
	 *  add rebased onto a new server list must be placed against THAT list's hold, not the last one emitted. */
	#ordering(list: readonly QueueEntry[]): Ordering {
		return this.#deps.ordering?.(list) ?? {};
	}

	#optimistic(op: QueueOp): void {
		// Snapshot the pre-op entries (with all earlier pending ops baked in) so a reject can restore them verbatim.
		const snapshot = this.#entries.map((e) => ({ ...e }));
		const clientOpId = (this.#deps.mintId ?? ulid)();
		this.#pending.set(clientOpId, { op, snapshot, seq: this.#pendingSeq++ });
		// The SAME reducer the server runs (applyAndReseq), so the optimistic row lands at its real round-robin position
		// THIS FRAME — no jump-to-bottom-then-resort flicker.
		this.#entries = applyAndReseq(this.#entries, op, this.#ordering(this.#entries));
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
			acc = applyAndReseq(acc, p.op, this.#ordering(acc));
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
			for (const op of e.patch.ops) this.#entries = applyAndReseq(this.#entries, op, this.#ordering(this.#entries));
		}
		this.#emit();
	}

	#onSync(e: Extract<ServerEvent, { type: 'queue:sync' }>): void {
		this.#rev = e.rev;
		// Before `#emit()`, so the first subscriber call-back already sees the flag that says its list is real.
		this.#synced = true;
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
		this.#deps.onReject?.(e.reason, pending.op); // surface to the UI (toast)
	}
}
