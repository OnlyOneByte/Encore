// In-memory only, rebuilt from worker reconnects, never persisted. A dropped worker's in-flight
// jobs are reclaimed by the reaper via lease expiry, not by anything in this file.

import type { SeparatorOffer, WorkerHost, WorkerProfile } from '../../contract';

export interface WorkerSession {
	workerId: string;
	capabilities: string[]; // capability tokens (superset of JobType, e.g. 'stems:roformer')
	concurrency: number; // max simultaneous jobs this worker accepts
	version: string;
	slotsFree: number; // concurrency minus jobs currently assigned/running to it
	lastSeen: number; // epoch ms of the last hello/heartbeat (liveness)
	/** Host info reported at handshake; optional since older workers send none. Lets a reader tell a slow GPU stems run from a shared-core one. */
	host?: WorkerHost;
	/** What the worker resolved at boot, already shape-checked (`workerProfile`). Stamped on each attempt it is assigned. */
	profile?: WorkerProfile;
	/**
	 * Selectable separation models, from the follow-up `worker:catalogue` frame. Absent until that arrives
	 * (a few seconds after joining) and on any worker that offers none — so every reader must treat an empty
	 * list as "not reported", never as "this worker can separate nothing".
	 */
	separators?: SeparatorOffer[];
	/** Set by this session's first heartbeat. A worker that never heartbeats could never lift a `hold`. */
	reportsSlots?: boolean;
}

export class WorkerRegistry {
	#workers = new Map<string, WorkerSession>();

	/** Re-registering an existing workerId REPLACES the session: slotsFree resets to concurrency and the dispatcher re-assigns from the ledger, so a reconnect never keeps a stale slot count. */
	hello(
		workerId: string,
		capabilities: string[],
		concurrency: number,
		version: string,
		now: number,
		host?: WorkerHost,
		profile?: WorkerProfile
	): WorkerSession {
		const session: WorkerSession = {
			workerId,
			capabilities: [...capabilities],
			concurrency,
			version,
			slotsFree: concurrency,
			lastSeen: now,
			...(host ? { host } : {}),
			...(profile ? { profile } : {})
		};
		this.#workers.set(workerId, session);
		return session;
	}

	/**
	 * Apply a `worker:catalogue` frame: REPLACES capabilities and the offer list wholesale.
	 *
	 * Replace rather than merge, because the worker sends its full set for exactly this reason — merging
	 * would keep a model that a worker has since stopped offering (an extra uninstalled, a version
	 * downgraded), and core would route a job to a box that now refuses it.
	 *
	 * `slotsFree` is deliberately untouched: this frame says nothing about load, and resetting it here would
	 * discard the dispatcher's view a few seconds after a reconnect already rebuilt it.
	 *
	 * No-op when the worker is not registered — a catalogue arriving after a close is stale, and inventing a
	 * session from it would resurrect a worker the reaper has already written off.
	 */
	catalogue(workerId: string, capabilities: string[], separators: SeparatorOffer[], now: number): boolean {
		const w = this.#workers.get(workerId);
		if (!w) return false;
		w.capabilities = [...capabilities];
		w.separators = [...separators];
		w.lastSeen = now;
		return true;
	}

	/** The worker is the source of truth for slotsFree; no-op if it isn't registered (stale heartbeat). */
	heartbeat(workerId: string, slotsFree: number, now: number): void {
		const w = this.#workers.get(workerId);
		if (!w) return;
		w.slotsFree = Math.max(0, Math.min(slotsFree, w.concurrency));
		w.reportsSlots = true;
		w.lastSeen = now;
	}

	get(workerId: string): WorkerSession | null {
		return this.#workers.get(workerId) ?? null;
	}

	/** Drop a worker (WS close). Its jobs are reclaimed by the reaper via lease expiry. */
	remove(workerId: string): void {
		this.#workers.delete(workerId);
	}

	claimSlot(workerId: string): void {
		const w = this.#workers.get(workerId);
		if (w) w.slotsFree = Math.max(0, w.slotsFree - 1);
	}

	releaseSlot(workerId: string): void {
		const w = this.#workers.get(workerId);
		if (w) w.slotsFree = Math.min(w.concurrency, w.slotsFree + 1);
	}

	/** Offer this worker nothing until its next heartbeat. For a reject, where the worker's own count has
	 *  just disagreed with ours: releasing the slot instead re-offers the job to a full worker at once. A
	 *  no-op for a worker that has not heartbeated this session, since nothing would ever lift its hold. */
	hold(workerId: string): void {
		const w = this.#workers.get(workerId);
		if (w?.reportsSlots) w.slotsFree = 0;
	}

	/** All live worker sessions (defensive copies — callers must not mutate registry state). */
	list(): WorkerSession[] {
		return [...this.#workers.values()].map((w) => ({
			...w,
			capabilities: [...w.capabilities],
			...(w.separators ? { separators: [...w.separators] } : {})
		}));
	}

	get size(): number {
		return this.#workers.size;
	}
}
