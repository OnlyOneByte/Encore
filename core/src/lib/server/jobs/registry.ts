// In-memory only, rebuilt from worker reconnects, never persisted. A dropped worker's in-flight
// jobs are reclaimed by the reaper via lease expiry, not by anything in this file.

import type { JobType, SeparatorOffer, WorkerHost, WorkerNote, WorkerProfile } from '../../contract';

/** A worker's slots split by what the work needs (#1176): a download is network and ffmpeg, so it gets its
 *  own slot instead of waiting behind a separation. Every non-fetch job is compute. */
export type Lane = 'fetch' | 'compute';
export type Lanes = Record<Lane, number>;

export function laneOf(jobType: JobType): Lane {
	return jobType === 'fetch' ? 'fetch' : 'compute';
}

/** Sane per-lane bound: no box runs more at once, and a bigger figure is a malformed frame. */
const MAX_LANE = 64;

/** A well-shaped `{fetch, compute}` of whole counts in [min, MAX_LANE], else undefined. Hello lanes need at
 *  least one slot each (`min` 1), or a lane would hold work the worker could never be offered. */
export function workerLanes(raw: unknown, min = 0): Lanes | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
	const { fetch, compute } = raw as Record<string, unknown>;
	const ok = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= min && (n as number) <= MAX_LANE;
	return ok(fetch) && ok(compute) ? { fetch, compute } : undefined;
}

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
	/** What the worker knows is broken or off, latest wins (`worker:hello`, then `worker:warnings`). */
	warnings?: WorkerNote[];
	/** When this worker's lyrics check last answered (`worker:warnings`); absent until its first one has. */
	lyricsAt?: number;
	/** Set by this session's first heartbeat. A worker that never heartbeats could never lift a `hold`. */
	reportsSlots?: boolean;
	/** Slots per lane from hello; absent on a worker that sends none, which keeps the single count. */
	lanes?: Lanes;
	/** Free slots per lane, kept beside `slotsFree` (their sum) whenever `lanes` is set. */
	lanesFree?: Lanes;
}

/** Free slots for a `lane` job: the lane's own count on a laned worker, the single count otherwise. */
export function freeFor(w: Pick<WorkerSession, 'slotsFree' | 'lanesFree'>, lane: Lane): number {
	return w.lanesFree ? w.lanesFree[lane] : w.slotsFree;
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
		profile?: WorkerProfile,
		warnings: WorkerNote[] = [],
		lanes?: Lanes
	): WorkerSession {
		const session: WorkerSession = {
			workerId,
			capabilities: [...capabilities],
			concurrency,
			version,
			slotsFree: lanes ? lanes.fetch + lanes.compute : concurrency,
			lastSeen: now,
			...(host ? { host } : {}),
			...(profile ? { profile } : {}),
			warnings,
			...(lanes ? { lanes: { ...lanes }, lanesFree: { ...lanes } } : {})
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

	/** A `worker:warnings` frame: REPLACES the notes. No-op for a worker that is not registered. */
	warnings(workerId: string, notes: WorkerNote[], now: number): boolean {
		const w = this.#workers.get(workerId);
		if (!w) return false;
		w.warnings = notes;
		w.lyricsAt = now;
		w.lastSeen = now;
		return true;
	}

	/** The worker is the source of truth for slotsFree; no-op if it isn't registered (stale heartbeat).
	 *  A laned worker's `lanesFree` sets each lane, clamped to its size; one that omits it keeps core's lane view. */
	heartbeat(workerId: string, slotsFree: number, now: number, lanesFree?: Lanes): void {
		const w = this.#workers.get(workerId);
		if (!w) return;
		if (w.lanes && w.lanesFree) {
			if (lanesFree) {
				w.lanesFree.fetch = Math.min(lanesFree.fetch, w.lanes.fetch);
				w.lanesFree.compute = Math.min(lanesFree.compute, w.lanes.compute);
			}
			w.slotsFree = w.lanesFree.fetch + w.lanesFree.compute;
		} else {
			w.slotsFree = Math.max(0, Math.min(slotsFree, w.concurrency));
		}
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

	/** `lane` is the job's (`laneOf`); a worker with no lanes ignores it and moves its single count. */
	claimSlot(workerId: string, lane: Lane = 'compute'): void {
		const w = this.#workers.get(workerId);
		if (!w) return;
		if (w.lanesFree) w.lanesFree[lane] = Math.max(0, w.lanesFree[lane] - 1);
		w.slotsFree = w.lanesFree ? w.lanesFree.fetch + w.lanesFree.compute : Math.max(0, w.slotsFree - 1);
	}

	releaseSlot(workerId: string, lane: Lane = 'compute'): void {
		const w = this.#workers.get(workerId);
		if (!w) return;
		if (w.lanes && w.lanesFree) w.lanesFree[lane] = Math.min(w.lanes[lane], w.lanesFree[lane] + 1);
		w.slotsFree = w.lanesFree ? w.lanesFree.fetch + w.lanesFree.compute : Math.min(w.concurrency, w.slotsFree + 1);
	}

	/** Offer this worker nothing until its next heartbeat. For a reject, where the worker's own count has
	 *  just disagreed with ours: releasing the slot instead re-offers the job to a full worker at once. A
	 *  no-op for a worker that has not heartbeated this session, since nothing would ever lift its hold. */
	hold(workerId: string): void {
		const w = this.#workers.get(workerId);
		if (!w?.reportsSlots) return;
		w.slotsFree = 0;
		if (w.lanesFree) w.lanesFree = { fetch: 0, compute: 0 };
	}

	/** All live worker sessions (defensive copies — callers must not mutate registry state). */
	list(): WorkerSession[] {
		return [...this.#workers.values()].map((w) => ({
			...w,
			capabilities: [...w.capabilities],
			...(w.warnings ? { warnings: [...w.warnings] } : {}),
			...(w.lanes ? { lanes: { ...w.lanes } } : {}),
			...(w.lanesFree ? { lanesFree: { ...w.lanesFree } } : {}),
			...(w.separators ? { separators: [...w.separators] } : {})
		}));
	}

	get size(): number {
		return this.#workers.size;
	}
}
